import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getQdrantClient, hybridSearch } from '../cloud/qdrant.js';

export async function searchCommand(
  query: string,
  options: { type?: string; limit?: string },
): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const results = await hybridSearch(qdrant, config.org_id, query, {
      type: options.type,
      limit: options.limit ? parseInt(options.limit, 10) : 10,
    });

    if (results.length === 0) {
      console.log(pc.yellow('No results found.'));
      return;
    }

    console.log(pc.bold(`\nFound ${results.length} result(s):\n`));

    for (const r of results) {
      const typeColor =
        r.type === 'decision'
          ? pc.blue
          : r.type === 'constraint'
            ? pc.red
            : r.type === 'pattern'
              ? pc.green
              : pc.yellow;

      const score = r.score > 0 ? pc.dim(` (${r.score.toFixed(2)})`) : '';
      console.log(`  ${typeColor(`[${r.type}]`)}${score} ${r.summary || r.detail.substring(0, 80)}`);
      console.log(`    ${pc.dim(`by ${r.author} • ${r.created_at}`)}`);
      if (r.affects.length > 0) {
        console.log(`    ${pc.dim(`affects: ${r.affects.join(', ')}`)}`);
      }
      console.log();
    }
  } catch (err) {
    console.error(`Search error: ${(err as Error).message}`);
    process.exit(1);
  }
}
