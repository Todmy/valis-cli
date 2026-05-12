/**
 * One-off: hard-delete all records for project 'personal'
 *   Supabase project_id = '798df511-64c1-4c25-9bd5-9ff5fb61a4ae'
 *
 * Keeps the project row + project_members. Removes:
 *   - Qdrant points (filter: payload.project_id == TARGET)
 *   - decision_proposals (project_id)
 *   - decisions  (cascades contradictions; clears self-ref 'replaces' first)
 *   - audit_entries (project_id)
 *
 * Run: pnpm dlx tsx scripts/delete-personal-project-data.ts [--apply]
 */
import { createClient } from '@supabase/supabase-js';
import { QdrantClient } from '@qdrant/js-client-rest';

const TARGET = '798df511-64c1-4c25-9bd5-9ff5fb61a4ae';
const APPLY = process.argv.includes('--apply');

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

const filter = { must: [{ key: 'project_id', match: { value: TARGET } }] };

async function countQdrant(): Promise<number> {
  const res = await qd.count(COLLECTION, { filter, exact: true });
  return res.count;
}

async function countTable(table: string): Promise<number> {
  const { count, error } = await sb
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('project_id', TARGET);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function countContradictions(): Promise<number> {
  // contradictions has no project_id; count rows whose decision_a is in target
  const { data: ids } = await sb.from('decisions').select('id').eq('project_id', TARGET).limit(1);
  if (!ids?.length) return 0;
  const { count, error } = await sb
    .from('contradictions')
    .select('id', { count: 'exact', head: true })
    .in('decision_a_id', ids.map((r) => r.id));
  if (error) throw new Error(`contradictions: ${error.message}`);
  return count ?? 0;
}

async function clearReplacesSelfRef(): Promise<void> {
  // decisions.replaces -> decisions(id), no cascade. Set NULL for any row
  // (in any project) whose `replaces` points at a decision we are about to nuke.
  const { data: targetIds, error: e1 } = await sb
    .from('decisions')
    .select('id')
    .eq('project_id', TARGET);
  if (e1) throw new Error(`select target ids: ${e1.message}`);
  const ids = (targetIds ?? []).map((r) => r.id);
  if (!ids.length) return;
  // Batch in 500s to avoid URL-length limits.
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { error } = await sb.from('decisions').update({ replaces: null }).in('replaces', slice);
    if (error) throw new Error(`null replaces: ${error.message}`);
  }
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (destructive)' : 'DRY-RUN'}`);
  console.log(`Target project: ${TARGET}`);
  console.log(`Qdrant collection: ${COLLECTION}`);
  console.log('---');

  const [qPoints, dDecisions, dProposals, dAudit, dContra] = await Promise.all([
    countQdrant().catch((e) => {
      console.error('Qdrant count failed:', e.message);
      return -1;
    }),
    countTable('decisions'),
    countTable('decision_proposals'),
    countTable('audit_entries'),
    countContradictions(),
  ]);

  console.log('Counts to delete:');
  console.log(`  qdrant points:       ${qPoints}`);
  console.log(`  decisions:           ${dDecisions}`);
  console.log(`  contradictions:      ${dContra} (cascades)`);
  console.log(`  decision_proposals:  ${dProposals}`);
  console.log(`  audit_entries:       ${dAudit}`);

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to delete.');
    return;
  }

  console.log('\nDeleting Qdrant points...');
  const qDel = await qd.delete(COLLECTION, { filter, wait: true });
  console.log('  qdrant:', qDel.status);

  console.log('Nulling cross-project decisions.replaces refs...');
  await clearReplacesSelfRef();

  console.log('Deleting decision_proposals...');
  {
    const { error } = await sb.from('decision_proposals').delete().eq('project_id', TARGET);
    if (error) throw new Error(error.message);
  }

  console.log('Deleting decisions (cascades contradictions)...');
  {
    const { error } = await sb.from('decisions').delete().eq('project_id', TARGET);
    if (error) throw new Error(error.message);
  }

  console.log('Deleting audit_entries...');
  {
    const { error } = await sb.from('audit_entries').delete().eq('project_id', TARGET);
    if (error) throw new Error(error.message);
  }

  console.log('\nVerification (should all be 0):');
  const [q2, d2, p2, a2, c2] = await Promise.all([
    countQdrant(),
    countTable('decisions'),
    countTable('decision_proposals'),
    countTable('audit_entries'),
    countContradictions(),
  ]);
  console.log(`  qdrant=${q2}  decisions=${d2}  proposals=${p2}  audit=${a2}  contradictions=${c2}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
