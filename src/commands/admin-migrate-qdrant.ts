import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, getDecisionById } from '../cloud/supabase.js';
import {
  getQdrantClient,
  ensureProjectIdIndex,
  countLegacyPoints,
  migrateQdrantProjectIds,
} from '../cloud/qdrant.js';

/**
 * `valis admin migrate-qdrant`
 *
 * One-time migration command that backfills `project_id` into Qdrant points
 * that are missing it. Reads the canonical project_id from each Postgres
 * decision and sets it on the corresponding Qdrant point.
 *
 * Safe to run multiple times (idempotent) — already-migrated points are
 * skipped via the `is_null(project_id)` filter.
 */
export async function adminMigrateQdrantCommand(options: {
  dryRun?: boolean;
}): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log(pc.red('No configuration found. Run `valis init` first.'));
    return;
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  console.log(pc.bold('\nQdrant project_id Migration\n'));

  // Ensure the project_id index exists before scanning
  await ensureProjectIdIndex(qdrant);

  // Count legacy points
  const legacyCount = await countLegacyPoints(qdrant, config.org_id);

  if (legacyCount === 0) {
    console.log(pc.green('No legacy points found. All Qdrant points already have project_id.'));
    return;
  }

  console.log(`Found ${pc.yellow(String(legacyCount))} Qdrant points missing project_id.`);

  if (options.dryRun) {
    console.log(pc.dim('\nDry run — no changes will be made.'));
    return;
  }

  console.log(pc.cyan('Starting migration...\n'));

  // Create a lookup function that resolves decision_id -> project_id via Postgres
  const lookupProjectId = async (decisionId: string): Promise<string | null> => {
    const decision = await getDecisionById(supabase, config.org_id, decisionId);
    return decision?.project_id ?? null;
  };

  const report = await migrateQdrantProjectIds(qdrant, lookupProjectId);

  console.log(pc.bold('\nMigration complete:\n'));
  console.log(`  Total scanned:  ${report.total}`);
  console.log(`  Updated:        ${pc.green(String(report.updated))}`);
  console.log(`  Skipped:        ${report.skipped}`);
  console.log(`  Unresolved:     ${report.unresolved > 0 ? pc.yellow(String(report.unresolved)) : '0'}`);

  if (report.unresolved > 0) {
    console.log(pc.dim('\n  Unresolved points have no matching Postgres decision.'));
    console.log(pc.dim('  These may be orphaned points from deleted decisions.'));
  }

  console.log('');
}
