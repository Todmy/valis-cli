/**
 * 034 / FR-011 + FR-020: `valis personal-drafts` CLI surface.
 *
 *   valis personal-drafts triage          interactive triage of active drafts
 *   valis personal-drafts restore <id>    flip archived draft back to active
 *
 * Both commands operate exclusively against the caller's personal-drafts
 * project, looked up by (org_id, member_id). RLS (migration 029) ensures
 * the caller cannot see another member's drafts even by mistake.
 *
 * Contract docs:
 *   specs/034-unified-capture-policy/contracts/cli-personal-drafts-triage.md
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import select from '@inquirer/select';
import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseJwtClient, getSupabaseClient } from '../cloud/supabase/client.js';
import { listMemberProjects, type ProjectInfo } from '../cloud/supabase/members.js';
import {
  fetchPersonalDrafts,
  listActiveDrafts,
  archiveDraft,
  deleteDraft,
  restoreDraft,
  promoteDraftToProject,
  type DraftSummary,
} from '../cloud/supabase/personal-drafts.js';
import { record as recordTelemetry } from '../hooks/telemetry.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function buildSupabaseClient(config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>): SupabaseClient {
  if (config.auth_mode === 'jwt') {
    return getSupabaseJwtClient(
      config.supabase_url,
      config.member_api_key || config.api_key,
    );
  }
  return getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function renderEntry(entry: DraftSummary, index: number, total: number): void {
  const summary = entry.summary || entry.text.slice(0, 100);
  const date = new Date(entry.created_at).toISOString().slice(0, 10);
  console.log('');
  console.log(pc.bold(`[${index + 1}/${total}]`) + pc.dim(` ${date}  type=${entry.type}`));
  console.log(`  ${summary}`);
  const detailPreview = entry.text.split('\n').slice(0, 5).join('\n  ');
  const truncated = entry.text.split('\n').length > 5 ? '\n  …' : '';
  console.log(pc.dim(`  ${detailPreview}${truncated}`));
}

/**
 * `valis personal-drafts triage` — interactive walk through active drafts.
 * Per FR-011: each entry offers Bind / Archive / Delete / Skip / Quit.
 */
export async function triageCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error(pc.red('Not logged in. Run `valis login` first.'));
    process.exit(1);
  }
  if (!config.member_id) {
    console.error(pc.red('No member context in local config. Re-run `valis login`.'));
    process.exit(1);
  }

  const supabase = buildSupabaseClient(config);

  const drafts = await fetchPersonalDrafts(supabase, config.org_id, config.member_id);
  if (!drafts) {
    console.log(pc.dim('No personal-drafts project exists yet. Nothing to triage.'));
    console.log(pc.dim('Run `valis login` again or store something from a scope-less directory to create it.'));
    return;
  }

  const entries = await listActiveDrafts(supabase, drafts.id);
  if (entries.length === 0) {
    console.log(pc.green('✓ Nothing to triage.'));
    return;
  }

  // Project picker source (loaded once; we filter out personal-drafts itself
  // each time the user opens the Bind sub-prompt).
  const projects = (await listMemberProjects(supabase, config.member_id)).filter(
    (p) => p.id !== drafts.id,
  );

  const counts = { bound: 0, archived: 0, deleted: 0, skipped: 0 };

  let i = 0;
  while (i < entries.length) {
    const entry = entries[i]!;
    renderEntry(entry, i, entries.length);

    const action = await prompt('  [B]ind / [A]rchive / [D]elete / [S]kip / [Q]uit: ');
    const choice = action.toLowerCase().slice(0, 1);

    if (choice === 'q') {
      console.log(pc.dim('Triage stopped early.'));
      break;
    }
    if (choice === 's' || choice === '') {
      counts.skipped += 1;
      i += 1;
      continue;
    }
    if (choice === 'a') {
      await archiveDraft(supabase, entry.id);
      console.log(pc.green('  ✓ Archived (use `valis personal-drafts restore` to undo).'));
      counts.archived += 1;
      i += 1;
      continue;
    }
    if (choice === 'd') {
      const confirm = await prompt('  Permanently delete this entry? [y/N]: ');
      if (confirm.toLowerCase().slice(0, 1) !== 'y') {
        console.log(pc.dim('  Delete cancelled.'));
        continue; // re-prompt action without advancing
      }
      await deleteDraft(supabase, entry.id);
      console.log(pc.green('  ✓ Deleted.'));
      counts.deleted += 1;
      i += 1;
      continue;
    }
    if (choice === 'b') {
      if (projects.length === 0) {
        console.log(pc.yellow('  No team projects available to bind into. Choose another action.'));
        continue;
      }
      const targetId = await select<string>({
        message: '  Bind to which project?',
        choices: projects.map((p: ProjectInfo) => ({
          name: `${p.name} (${p.decision_count} decisions)`,
          value: p.id,
        })),
      });
      const target = projects.find((p) => p.id === targetId);
      if (!target) {
        console.log(pc.red('  Target project not found in picker — bind cancelled.'));
        continue;
      }
      await promoteDraftToProject(supabase, {
        decisionId: entry.id,
        sourcePersonalDraftsProjectId: drafts.id,
        targetProjectId: target.id,
        targetProjectName: target.name,
        actingMemberId: config.member_id,
        orgId: config.org_id,
      });
      console.log(pc.green(`  ✓ Promoted to ${target.name}.`));
      counts.bound += 1;
      i += 1;
      continue;
    }

    console.log(pc.dim('  Unrecognised input — type B / A / D / S / Q.'));
    // re-loop without advancing
  }

  console.log('');
  console.log(
    pc.bold(`Triage complete: `) +
      `bound ${counts.bound} | archived ${counts.archived} | deleted ${counts.deleted} | skipped ${counts.skipped}`,
  );

  void recordTelemetry('personal_drafts_triaged', {
    org_id: config.org_id,
    project_id: drafts.id,
    metadata: counts,
  });
}

/**
 * `valis personal-drafts restore <id>` — flip an archived draft back to
 * active state. Owner-only per FR-017 (RLS hides foreign entries).
 */
export async function restoreCommand(id: string): Promise<void> {
  if (!id) {
    console.error(pc.red('Usage: valis personal-drafts restore <id>'));
    process.exit(1);
  }

  const config = await loadConfig();
  if (!config) {
    console.error(pc.red('Not logged in. Run `valis login` first.'));
    process.exit(1);
  }

  const supabase = buildSupabaseClient(config);
  const restored = await restoreDraft(supabase, id);

  if (!restored) {
    // No row matched: either not archived, or not owned (RLS-hidden).
    // FR-006 spec pattern: indistinguishable to caller.
    console.error(pc.red(`No archived draft with id ${id} (or not owned by you).`));
    process.exit(2);
  }

  console.log(pc.green(`✓ Restored draft ${restored.id} to active.`));

  void recordTelemetry('personal_drafts_restored', {
    org_id: config.org_id,
    metadata: { decision_id: restored.id },
  });
}
