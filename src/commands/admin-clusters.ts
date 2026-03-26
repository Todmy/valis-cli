/**
 * `valis admin clusters` command.
 *
 * Shows cluster overview: list clusters with member count, cohesion, affects.
 * Supports --detail (show member decisions) and --merge A B (merge two clusters).
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getQdrantClient } from '../cloud/qdrant.js';
import { ClusterRegistry } from '../synthesis/cluster-registry.js';

export interface AdminClustersOptions {
  detail?: boolean;
  merge?: string[];
}

export async function adminClustersCommand(options: AdminClustersOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Not configured. Run `valis init` first.');
    process.exit(1);
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);
    const registry = new ClusterRegistry(qdrant, config.org_id);

    // --merge A B: merge two clusters
    if (options.merge && options.merge.length === 2) {
      const [aId, bId] = options.merge;
      console.log(`Merging cluster ${pc.bold(bId)} into ${pc.bold(aId)}...`);

      const merged = await registry.mergeClusters(aId, bId);
      console.log(pc.green(`Merged. Result: ${merged.member_count} members, affects: ${merged.affects.join(', ')}`));
      return;
    }

    // List clusters
    const clusters = await registry.listClusters();

    if (clusters.length === 0) {
      console.log(pc.dim('No clusters found. Clusters form automatically as decisions are stored.'));
      return;
    }

    console.log(pc.bold(`\nDecision Clusters (${clusters.length} total)`));
    console.log(pc.dim('\u2500'.repeat(60)));

    for (const cluster of clusters) {
      console.log(
        `  ${pc.bold(cluster.id)}  ` +
        `${pc.cyan(String(cluster.member_count))} members  ` +
        `affects: ${cluster.affects.slice(0, 5).join(', ')}` +
        (cluster.affects.length > 5 ? ` (+${cluster.affects.length - 5} more)` : ''),
      );

      // --detail: show member decisions
      if (options.detail) {
        const members = await registry.getMembers(cluster.id);
        for (const m of members) {
          const summary = m.summary || m.detail.substring(0, 60);
          console.log(
            `    ${pc.dim('-')} ${pc.dim(m.id.slice(0, 8))}  ` +
            `${m.type}  ${summary}`,
          );
        }
        console.log();
      }
    }

    console.log();
  } catch (err) {
    console.error(`Cluster error: ${(err as Error).message}`);
    process.exit(1);
  }
}
