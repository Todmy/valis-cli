import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getQdrantClient, hybridSearch } from '../cloud/qdrant.js';
import { rerank } from '../search/reranker.js';
import { suppressResults } from '../search/suppression.js';
import type { RerankedResult } from '../types.js';

export async function searchCommand(
  query: string,
  options: { type?: string; limit?: string; all?: boolean },
): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

    // Fetch up to 50 results for reranking
    const rawResults = await hybridSearch(qdrant, config.org_id, query, {
      type: options.type,
      limit: 50,
    });

    if (rawResults.length === 0) {
      console.log(pc.yellow('No results found.'));
      return;
    }

    // Apply multi-signal reranking
    const reranked = rerank(rawResults);

    // Apply within-area suppression
    const { visible, suppressed_count } = suppressResults(
      reranked,
      1.5,
      options.all ?? false,
    );

    const limit = options.limit ? parseInt(options.limit, 10) : 10;
    const finalResults = visible.slice(0, limit);

    console.log(pc.bold(`\nFound ${rawResults.length} result(s), showing ${finalResults.length}:`));
    if (suppressed_count > 0 && !options.all) {
      console.log(pc.dim(`  (${suppressed_count} similar result(s) suppressed — use --all to show)`));
    }
    console.log();

    for (const r of finalResults) {
      const rr = r as RerankedResult;
      const typeColor =
        r.type === 'decision'
          ? pc.blue
          : r.type === 'constraint'
            ? pc.red
            : r.type === 'pattern'
              ? pc.green
              : pc.yellow;

      // Show composite_score instead of raw Qdrant score
      const scoreStr = pc.dim(` (score: ${rr.composite_score.toFixed(3)})`);
      const suppressedLabel = rr.suppressed ? pc.dim(pc.yellow(' [suppressed]')) : '';
      console.log(`  ${typeColor(`[${r.type}]`)}${scoreStr}${suppressedLabel} ${r.summary || r.detail.substring(0, 80)}`);
      console.log(`    ${pc.dim(`by ${r.author} • ${r.created_at}`)}`);
      if (r.affects.length > 0) {
        console.log(`    ${pc.dim(`affects: ${r.affects.join(', ')}`)}`);
      }

      // Signal breakdown
      const s = rr.signals;
      console.log(`    ${pc.dim(`signals: sem=${s.semantic_score.toFixed(2)} bm25=${s.bm25_score.toFixed(2)} rec=${s.recency_decay.toFixed(2)} imp=${s.importance.toFixed(2)} graph=${s.graph_connectivity.toFixed(2)}`)}`);
      console.log();
    }
  } catch (err) {
    console.error(`Search error: ${(err as Error).message}`);
    process.exit(1);
  }
}
