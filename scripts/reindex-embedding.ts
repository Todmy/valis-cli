#!/usr/bin/env tsx
/**
 * 026/Track 3a — CLI entry for the reindex toolkit (`runReindexCutover`).
 *
 * Usage:
 *   pnpm tsx packages/cli/scripts/reindex-embedding.ts \
 *     --source v1 --target v2 [--dry-run] [--skip-spot-check] [--checkpoint <path>]
 *
 * Exit codes (per FR-012):
 *   0 — `flipped: true` or successful dry-run
 *   1 — any phase failure (incl. spot-check rejection)
 *   2 — argument or precondition error
 *
 * This entry is the OPERATOR surface. Production wiring of Vercel and
 * Qdrant ports is handled by `--source` + env vars; for dry-runs and
 * staging the script accepts stub creds and short-circuits external calls.
 *
 * The actual production cutover playbook is the sibling HITL issue (#30).
 * This script just provides the toolkit; the founder physically runs it.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { Command } from 'commander';
import {
  runReindexCutover,
  type EmbeddingVersion,
  type ReindexExecutor,
  type SpotChecker,
  type VercelEnvClient,
  type AuditEmitter,
} from '../src/cloud/reindex-orchestrator.js';
import { createFsCheckpointStore } from '../src/cloud/reindex-checkpoint-store.js';
import { createVercelEnvClient } from '../src/cloud/vercel-env-client.js';
import { createReindexExecutor } from '../src/cloud/reindex-executor.js';
import { createSpotChecker } from '../src/cloud/spot-checker.js';

const program = new Command();

program
  .name('reindex-embedding')
  .description('Cutover toolkit for embedding-model migrations (026/Track 3a).')
  .requiredOption('-s, --source <version>', 'source embedding version (v1 | v2)')
  .requiredOption('-t, --target <version>', 'target embedding version (v1 | v2)')
  .option('--dry-run', 'simulate every phase, mutate nothing externally')
  .option('--skip-spot-check', 'override spot-check gate (records safety_overridden=true)')
  .option('--checkpoint <path>', 'path to checkpoint JSON for resumable state')
  .option('--buffer-ms <ms>', 'override the 24h dual-write buffer (test/dry-run only)', '86400000')
  .option('--sample-size <n>', 'spot-check sample size (default 50)', '50')
  .option('--ratio <n>', 'spot-check pass ratio target/baseline (default 0.95)', '0.95')
  .parse(process.argv);

const opts = program.opts<{
  source: string;
  target: string;
  dryRun?: boolean;
  skipSpotCheck?: boolean;
  checkpoint?: string;
  bufferMs: string;
  sampleSize: string;
  ratio: string;
}>();

function validateVersion(v: string): EmbeddingVersion {
  if (v !== 'v1' && v !== 'v2') {
    console.error(`reindex-embedding: --source/--target must be 'v1' or 'v2' (got '${v}')`);
    process.exit(2);
  }
  return v;
}

const source = validateVersion(opts.source);
const target = validateVersion(opts.target);

if (source === target) {
  console.error('reindex-embedding: --source and --target are identical, refusing');
  process.exit(2);
}

// ─── Production port wiring ─────────────────────────────────────────────
// Dry-run mode short-circuits each port internally — none of the env vars
// are required for `--dry-run`. Non-dry-run cutover requires:
//   - VERCEL_API_TOKEN, VERCEL_PROJECT_ID (+ optional VERCEL_TEAM_ID)
//   - QDRANT_URL, QDRANT_API_KEY (for reindex executor + spot-checker)
// Audit emission goes to audit_entries via Supabase service-role; missing
// creds make audit a no-op so the dry-run remains friction-free.

let vercel: VercelEnvClient;
let reindex: ReindexExecutor;
let spotCheck: SpotChecker;

if (opts.dryRun) {
  // Dry-run never reaches any port — every phase short-circuits to
  // `status: 'simulated'`. Stub ports throw if accidentally reached.
  vercel = {
    async setEnvVar() {
      throw new Error('UNREACHABLE — dry-run should not call Vercel port');
    },
  };
  reindex = {
    async run() {
      throw new Error('UNREACHABLE — dry-run should not call reindex port');
    },
  };
  spotCheck = {
    async measure() {
      throw new Error('UNREACHABLE — dry-run should not call spot-check port');
    },
  };
} else {
  const vercelToken = process.env.VERCEL_API_TOKEN;
  const vercelProject = process.env.VERCEL_PROJECT_ID;
  const qdrantUrl = process.env.QDRANT_URL;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  if (!vercelToken || !vercelProject) {
    console.error('reindex-embedding: VERCEL_API_TOKEN and VERCEL_PROJECT_ID required for non-dry-run');
    process.exit(2);
  }
  if (!qdrantUrl || !qdrantApiKey) {
    console.error('reindex-embedding: QDRANT_URL and QDRANT_API_KEY required for non-dry-run');
    process.exit(2);
  }

  const qdrant = new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
  vercel = createVercelEnvClient({
    token: vercelToken,
    projectId: vercelProject,
    teamId: process.env.VERCEL_TEAM_ID,
  });
  reindex = createReindexExecutor({ qdrant });
  spotCheck = createSpotChecker({ qdrant });
}

// Audit emission — best-effort. When the audit_entries write path is wired
// in #30, replace this stub with the real inserter. The orchestrator
// treats every emit() failure as non-blocking (Constitution III), so a
// missing implementation only loses observability.
const audit: AuditEmitter = {
  async emit() {
    /* TODO #30 cutover task — wire to audit_entries via Supabase */
  },
};

const checkpoint = createFsCheckpointStore();

(async () => {
  try {
    const report = await runReindexCutover({
      source,
      target,
      dryRun: opts.dryRun,
      skipSpotCheck: opts.skipSpotCheck,
      checkpointPath: opts.checkpoint,
      bufferMs: Number(opts.bufferMs),
      spotCheckSampleSize: Number(opts.sampleSize),
      spotCheckRatio: Number(opts.ratio),
      ports: { vercel, reindex, spotCheck, checkpoint, audit },
    });

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    if (report.flipped || report.dry_run) {
      process.exit(0);
    }
    // Any non-flip outcome — spot-check failure, phase failure — exits 1.
    process.exit(1);
  } catch (err) {
    console.error(`reindex-embedding: fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
