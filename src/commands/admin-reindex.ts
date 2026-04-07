import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import {
  getQdrantClient,
  reindexAllPoints,
} from '../cloud/qdrant.js';

/**
 * `valis admin reindex`
 *
 * Re-embed every decision in the active org by reading the stored
 * `contextual_text` payload field and writing a fresh vector via the active
 * embedding strategy (server inference or local fastembed). Used to backfill
 * real semantic vectors on points that were originally written with the
 * zero-vector placeholder (013-semantic-embeddings, US2).
 *
 * Vector-only update path — concurrent payload changes (pinned, status,
 * cluster labels) are preserved. See FR-015 / clarification Q3.
 *
 * Org-scoped per FR-020: the filter pins the reindex to the local config's
 * `org_id` so operators cannot accidentally re-embed points belonging to
 * another tenant.
 */
export async function adminReindexCommand(options: {
  dryRun?: boolean;
}): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.log(pc.red('No configuration found. Run `valis init` first.'));
    return;
  }

  const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

  const filter: Record<string, unknown> = {
    must: [{ key: 'org_id', match: { value: config.org_id } }],
  };

  console.log(pc.bold('\nQdrant Reindex (re-embed all points)\n'));
  if (options.dryRun) {
    console.log(pc.dim('Dry run — no writes will occur.\n'));
  }

  const onProgress = (processed: number, total: number): void => {
    // In-place progress line. Total is the running count of scanned points.
    const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
    process.stdout.write(`\r  [${processed}/${total}] reindexing... ${pct}%`);
  };

  const report = await reindexAllPoints(qdrant, {
    dryRun: options.dryRun,
    filter,
    onProgress,
  });

  // Newline after the in-place progress line.
  process.stdout.write('\n');

  console.log(pc.bold('\nReindex complete:\n'));
  console.log(`  Total scanned:    ${report.total}`);
  console.log(`  Re-embedded:      ${pc.green(String(report.reindexed))}`);
  console.log(
    `  Failed:           ${report.failed > 0 ? pc.yellow(String(report.failed)) : '0'}`,
  );
  console.log(`  Skipped (dry):    ${report.skipped}`);
  console.log(`  Duration:         ${(report.durationMs / 1000).toFixed(1)}s`);

  if (report.quotaError) {
    const q = report.quotaError;
    console.log('');
    console.log(pc.red(pc.bold('  Embedding quota exhausted — reindex aborted.')));
    console.log(pc.red(`    Code:           ${q.code}`));
    console.log(
      pc.red(
        `    Tokens used:    ${q.tokensUsed ?? 'unknown'} / ${q.tokensLimit ?? 'unknown'}`,
      ),
    );
    console.log(pc.red(`    Reset at:       ${q.resetAt ?? 'unknown'}`));
    console.log(pc.red(`    Strategy mode:  ${q.strategyMode}`));
    console.log(pc.red(`    Remediation:    ${q.remediationHint}`));
    console.log('');
    process.exit(1);
  }

  console.log('');
}
