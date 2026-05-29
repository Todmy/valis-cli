/**
 * 034 / FR-008 + FR-009 + FR-011 + FR-020: per-user personal-drafts project
 * cloud helpers. Owns the lifecycle of `projects` rows where
 * `is_personal_drafts = TRUE` plus the promotion / archive / restore /
 * triage queries against decisions inside them.
 *
 * Per Q8 reconciliation (specs/034-unified-capture-policy/spec.md):
 * personal-drafts rows store `name = 'Personal Drafts'`. The CLI-arg
 * sentinel `personal-drafts` is a routing token — never written to the
 * `name` column. Resolution happens via
 * `(org_id, owner_member_id) WHERE is_personal_drafts = TRUE`.
 *
 * RLS contract (migration 029): every read/write below is naturally
 * filtered by the RESTRICTIVE policies. Callers using the SERVICE-ROLE
 * Supabase client bypass RLS — they are responsible for passing the
 * correct member context (e.g. via FR-008 server-side resolution that
 * already authenticated the request).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { storeAuditEntry } from './audit.js';

export const PERSONAL_DRAFTS_NAME = 'Personal Drafts' as const;
export const PERSONAL_DRAFTS_SENTINEL = 'personal-drafts' as const;

export interface PersonalDraftsProject {
  id: string;
  org_id: string;
  owner_member_id: string;
  name: string;
  is_personal_drafts: true;
  created_at?: string;
}

/**
 * Idempotently create-or-fetch the caller's personal-drafts project for
 * the given org. Used at `valis login` to guarantee the row exists, and
 * by the FR-008 scope-less fallback to resolve the target project_id.
 *
 * Race-safety: SELECT-then-INSERT-if-missing. The unique partial index
 * `projects_personal_drafts_owner_unique` (migration 029) makes the
 * concurrent-INSERT case fail with a 23505 unique-violation; we catch
 * that and retry the SELECT. A genuine concurrent caller will get the
 * row that lost the race wrote.
 */
export async function ensurePersonalDrafts(
  supabase: SupabaseClient,
  orgId: string,
  memberId: string,
): Promise<{ projectId: string; created: boolean }> {
  const existing = await fetchPersonalDrafts(supabase, orgId, memberId);
  if (existing) return { projectId: existing.id, created: false };

  const { data, error } = await supabase
    .from('projects')
    .insert({
      org_id: orgId,
      name: PERSONAL_DRAFTS_NAME,
      is_personal_drafts: true,
      owner_member_id: memberId,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation. Means a concurrent caller won the race
    // and inserted the same row. Re-fetch and return that one.
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      const fetched = await fetchPersonalDrafts(supabase, orgId, memberId);
      if (fetched) return { projectId: fetched.id, created: false };
    }
    throw new Error(`Failed to ensure personal-drafts project: ${error.message}`);
  }

  return { projectId: data.id as string, created: true };
}

/**
 * Look up the caller's personal-drafts project row by (org, member).
 * Returns null when none exists. Does not create.
 */
export async function fetchPersonalDrafts(
  supabase: SupabaseClient,
  orgId: string,
  memberId: string,
): Promise<PersonalDraftsProject | null> {
  const { data, error } = await supabase
    .from('projects')
    .select('id, org_id, owner_member_id, name, is_personal_drafts, created_at')
    .eq('org_id', orgId)
    .eq('owner_member_id', memberId)
    .eq('is_personal_drafts', true)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch personal-drafts project: ${error.message}`);
  }
  return (data as PersonalDraftsProject | null) ?? null;
}

/**
 * 034 / FR-011 bind action: move a personal-drafts entry into a target
 * team project. Per Q1 + D6 (spec.md / research.md):
 *   1. UPDATE decisions SET project_id = target WHERE id = entry
 *   2. INSERT audit_entries (event_type = 'personal_drafts_promoted',
 *      project_id = personal-drafts source, payload = target details)
 *   3. Caller is responsible for Qdrant payload re-index (the
 *      side-effect bus handles that on subsequent writes; for promotion
 *      we re-upsert via the existing qdrant.upsertDecision flow at the
 *      command layer).
 *
 * Single-source-of-truth semantics: same decision ID retained; no
 * duplicate row in target. Audit row stays in personal-drafts (Q6 RLS).
 */
export async function promoteDraftToProject(
  supabase: SupabaseClient,
  args: {
    decisionId: string;
    sourcePersonalDraftsProjectId: string;
    targetProjectId: string;
    targetProjectName: string;
    actingMemberId: string;
    orgId: string;
  },
): Promise<void> {
  const { error: updateErr } = await supabase
    .from('decisions')
    .update({ project_id: args.targetProjectId })
    .eq('id', args.decisionId)
    .eq('project_id', args.sourcePersonalDraftsProjectId);

  if (updateErr) {
    throw new Error(`Failed to promote draft (move): ${updateErr.message}`);
  }

  // Audit row stays in personal-drafts so the owning member can later
  // see "I promoted X to Y at Z" without admin tooling (Q6 / FR-017).
  await storeAuditEntry(supabase, {
    id: crypto.randomUUID(),
    org_id: args.orgId,
    member_id: args.actingMemberId,
    action: 'personal_drafts_promoted',
    target_type: 'decision',
    target_id: args.decisionId,
    project_id: args.sourcePersonalDraftsProjectId,
    previous_state: { project_id: args.sourcePersonalDraftsProjectId },
    new_state: {
      target_project_id: args.targetProjectId,
      target_project_name: args.targetProjectName,
      promoted_at: new Date().toISOString(),
    },
    reason: 'personal-drafts triage bind',
  });
}

/**
 * FR-011 archive branch: mark a draft as archived. Status field is the
 * existing decision_status enum value 'archived'.
 */
export async function archiveDraft(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<{ status: 'archived' }> {
  const { error } = await supabase
    .from('decisions')
    .update({ status: 'archived' })
    .eq('id', decisionId);

  if (error) throw new Error(`Failed to archive draft: ${error.message}`);
  return { status: 'archived' };
}

/**
 * FR-011 delete branch: permanent removal. No recovery. RLS ensures
 * the caller can only delete their own personal-drafts entries.
 */
export async function deleteDraft(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<void> {
  const { error } = await supabase.from('decisions').delete().eq('id', decisionId);
  if (error) throw new Error(`Failed to delete draft: ${error.message}`);
}

/**
 * FR-020 restore: flip an archived draft back to active. Returns null
 * when the row is not archived (or not owned — RLS hides foreign rows
 * indistinguishably). Caller maps null → exit-code 2 / "no such archived
 * entry" message.
 */
export async function restoreDraft(
  supabase: SupabaseClient,
  decisionId: string,
): Promise<{ id: string; status: 'active' } | null> {
  const { data, error } = await supabase
    .from('decisions')
    .update({ status: 'active' })
    .eq('id', decisionId)
    .eq('status', 'archived')
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`Failed to restore draft: ${error.message}`);
  if (!data) return null;
  return { id: data.id as string, status: 'active' };
}

/**
 * List active drafts in a personal-drafts project, oldest first. Used
 * by `valis personal-drafts triage` to walk entries in chronological
 * order.
 */
export interface DraftSummary {
  id: string;
  type: string;
  summary: string | null;
  text: string;
  created_at: string;
}

export async function listActiveDrafts(
  supabase: SupabaseClient,
  personalDraftsProjectId: string,
): Promise<DraftSummary[]> {
  const { data, error } = await supabase
    .from('decisions')
    .select('id, type, summary, text, created_at')
    .eq('project_id', personalDraftsProjectId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to list active drafts: ${error.message}`);
  return (data as DraftSummary[]) ?? [];
}
