/**
 * One-off: promote ALL `decisions` rows in project `personal` from
 * status='proposed' to status='active'. Also syncs the `status` field
 * in Qdrant payload (Postgres is source of truth, but the search-time
 * filter relies on the payload copy).
 *
 *   project_id = '798df511-64c1-4c25-9bd5-9ff5fb61a4ae'
 *
 * Mirrors the side effects of POST /api/change-status, except:
 *   - skips audit_entries (this is a bulk maintenance op on personal data)
 *   - skips channel push notifications (best-effort in the original anyway)
 *   - validates `proposed → active` is a permitted transition (it is —
 *     see packages/web/src/lib/decision-transitions.ts)
 *
 * Run:
 *   pnpm dlx tsx scripts/promote-personal-proposed.ts          # dry-run
 *   pnpm dlx tsx scripts/promote-personal-proposed.ts --apply  # mutate
 */
import { createClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';

const TARGET = '798df511-64c1-4c25-9bd5-9ff5fb61a4ae';
const APPLY = process.argv.includes('--apply');
const REASON = 'bulk reactivation: proposed → active (personal project)';
const ACTOR = 'bulk-promote-personal-script';
const QDRANT_BATCH = 200;

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const QDRANT_URL = process.env.QDRANT_URL!;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY!;
const COLLECTION = process.env.QDRANT_COLLECTION || 'decisions';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !QDRANT_URL || !QDRANT_API_KEY) {
  throw new Error('Missing env: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/QDRANT_URL/QDRANT_API_KEY');
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const qd = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

async function statusCounts(): Promise<Record<string, number>> {
  const { data, error } = await sb
    .from('decisions')
    .select('status')
    .eq('project_id', TARGET);
  if (error) throw new Error(error.message);
  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

async function proposedIds(): Promise<string[]> {
  const { data, error } = await sb
    .from('decisions')
    .select('id')
    .eq('project_id', TARGET)
    .eq('status', 'proposed');
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id);
}

async function syncQdrantPayload(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += QDRANT_BATCH) {
    const slice = ids.slice(i, i + QDRANT_BATCH);
    await qd.setPayload(COLLECTION, {
      payload: { status: 'active' },
      filter: { must: [{ key: 'decision_id', match: { any: slice } }] },
      wait: true,
    });
    console.log(`  qdrant batch ${i / QDRANT_BATCH + 1}: ${slice.length} decision_ids`);
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (destructive)' : 'DRY-RUN'}`);
  console.log(`Target project: ${TARGET} (personal)`);
  console.log(`Qdrant collection: ${COLLECTION}`);
  console.log('---');

  const before = await statusCounts();
  console.log('decisions BEFORE:');
  console.table(before);

  const ids = await proposedIds();
  console.log(`\nProposed rows to flip: ${ids.length}`);

  if (ids.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (!APPLY) {
    console.log('\nWould:');
    console.log(`  1. UPDATE decisions SET status='active', status_changed_by='${ACTOR}',`);
    console.log(`     status_changed_at=now(), status_reason='${REASON}'`);
    console.log(`     WHERE project_id='${TARGET}' AND status='proposed'`);
    console.log(`  2. Qdrant setPayload({status:'active'}) for ${ids.length} decision_ids`);
    console.log(`     (in batches of ${QDRANT_BATCH})`);
    console.log('  3. Skip audit_entries (bulk maintenance op)');
    console.log('\nRe-run with --apply to mutate.');
    return;
  }

  console.log('\nUpdating Postgres...');
  const nowIso = new Date().toISOString();
  const { error, count } = await sb
    .from('decisions')
    .update(
      {
        status: 'active',
        status_changed_by: ACTOR,
        status_changed_at: nowIso,
        status_reason: REASON,
      },
      { count: 'exact' },
    )
    .eq('project_id', TARGET)
    .eq('status', 'proposed');
  if (error) throw new Error(`UPDATE decisions: ${error.message}`);
  console.log(`  rows updated: ${count}`);

  console.log('\nSyncing Qdrant payloads...');
  await syncQdrantPayload(ids);

  console.log('\ndecisions AFTER:');
  console.table(await statusCounts());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
