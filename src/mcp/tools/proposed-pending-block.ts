/**
 * 040/#226 (finding #8) — shared assembly for the in-process `proposed_pending`
 * draft-backlog block.
 *
 * `buildProposedPendingBlock` (search.ts) and `attachProposedPending`
 * (context.ts) were near-identical copy-paste: the same Supabase client-choice
 * ladder, the same dashboard-origin rule, and the same three FR-006 omission
 * guards. This module is the single source of truth for all three so the two
 * tools cannot drift.
 *
 * Direct-mode only: the hosted-proxy path reuses the block the server already
 * computed (`/api/search` response, finding #2) and never calls this helper.
 *
 * Best-effort by contract (Constitution III): returns `undefined` to OMIT the
 * block on any of the three omission conditions or on any COUNT failure
 * (`countProposedPending` returns null) — never throws, never zero-fills.
 */

import { getSupabaseClient, getSupabaseJwtClient } from '../../cloud/supabase.js';
import { countProposedPending } from '../../cloud/supabase/proposed-pending.js';
import { isHostedMode } from '../../cloud/api-url.js';
import { HOSTED_API_URL, type ProposedPending, type ServerConfig, type ValisConfig } from '../../types.js';

export interface ProposedPendingInputs {
  config: ValisConfig;
  configOverride: ServerConfig | undefined;
  /** True when the call resolved to a cross-project (`all_projects`) search. */
  allProjects: boolean | undefined;
  /** The resolved single-project scope, or undefined when none resolved. */
  projectId: string | undefined;
  /** True when the call resolved to a cross-org public-KB read. */
  isCrossOrgRead: boolean;
  /** Optional similarity lookup reused for `top_3.similarity` (no new embedding). */
  similarityById?: Map<string, number>;
}

/**
 * Compute the draft-backlog block for the active project, or `undefined` to
 * OMIT it. Shared by `valis_search` and `valis_context` (finding #8).
 */
export async function resolveProposedPendingBlock(
  p: ProposedPendingInputs,
): Promise<ProposedPending | undefined> {
  // FR-006 omission rules — identical across both tools.
  if (!p.projectId) return undefined;
  if (p.allProjects) return undefined;
  if (p.isCrossOrgRead) return undefined;

  try {
    const { config } = p;
    // Prefer the service-role client (CLI direct + server/plugin mode); fall
    // back to the JWT client when no service-role key is present. The COUNT is
    // explicitly org_id+project_id scoped inside `countProposedPending`, so even
    // the RLS-bypassing service client cannot leak across projects (FR-009).
    const client = config.supabase_service_role_key
      ? getSupabaseClient(config.supabase_url, config.supabase_service_role_key)
      : getSupabaseJwtClient(config.supabase_url, config.member_api_key || config.api_key);

    // Dashboard origin: hosted/plugin users triage at HOSTED_API_URL. Pure
    // CLI-stdio community mode (no server override, non-hosted) has no
    // resolvable dashboard origin → null (FR-005).
    const origin = isHostedMode(config) || p.configOverride ? HOSTED_API_URL : null;

    const block = await countProposedPending(
      client,
      { orgId: config.org_id, projectId: p.projectId },
      { ranking: 'created_asc', origin, similarityById: p.similarityById },
    );
    return block ?? undefined;
  } catch (err) {
    console.error(
      `[proposed-pending] block build failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
