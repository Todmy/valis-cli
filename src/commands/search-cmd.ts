import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { resolveConfig } from '../config/project.js';
import {
  getQdrantClient,
  hybridSearch,
  hybridSearchAllProjects,
  mmrRerank,
} from '../cloud/qdrant.js';
import {
  getSupabaseForConfig,
  listMemberProjects,
  type ProjectInfo,
} from '../cloud/supabase.js';
import { proxySearch } from '../cloud/search-proxy.js';
import { isHostedMode } from '../cloud/api-url.js';
import { rerank } from '../search/reranker.js';
import { suppressResults } from '../search/suppression.js';
import type { RerankedResult } from '../types.js';

export async function searchCommand(
  query: string,
  options: {
    type?: string;
    limit?: string;
    all?: boolean;
    allProjects?: boolean;
    /** gh#322 — comma-separated project NAMES to read from. */
    projects?: string;
  },
): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }

  // T025: Resolve project from per-directory config
  const resolved = await resolveConfig();
  const projectId = resolved.project?.project_id;
  const linkedProjectIds = resolved.project?.linked_projects ?? [];

  // Q8: Route through server-side proxy in hosted mode (no direct Qdrant access)
  if (config.auth_mode === 'jwt' && isHostedMode(config)) {
    try {
      // 040/#226 (finding #2) — proxySearch now returns `{ results, proposed_pending }`;
      // the CLI text view only needs the result rows.
      const { results: proxyResults } = await proxySearch(config, query, {
        type: options.type,
        limit: 50,
        project_id: projectId ?? undefined,
        all_projects: options.allProjects,
        member_id: config.member_id ?? undefined,
      });

      if (proxyResults.length === 0) {
        console.log(pc.yellow('No results found.'));
        return;
      }

      const reranked = rerank(proxyResults);
      const { visible, suppressed_count } = suppressResults(
        reranked,
        1.5,
        options.all ?? false,
      );

      const limit = options.limit ? parseInt(options.limit, 10) : 10;
      // 037 (PR #228 review): MMR diversity is the FINAL transform — after
      // rerank + suppression, at the display limit, over composite_score.
      const finalResults = mmrRerank(visible, {
        k: limit,
        relevanceOf: (r) => r.composite_score ?? r.score ?? 0,
      });

      console.log(pc.bold(`\nFound ${proxyResults.length} result(s), showing ${finalResults.length}:`));
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

        let projectLabel = '';
        if (options.allProjects && r.project_id) {
          const pName = r.project_name || r.project_id.slice(0, 8);
          projectLabel = pc.magenta(`[${pName}] `);
        }

        const scoreStr = pc.dim(` (score: ${rr.composite_score.toFixed(3)})`);
        const suppressedLabel = rr.suppressed ? pc.dim(pc.yellow(' [suppressed]')) : '';
        console.log(`  ${projectLabel}${typeColor(`[${r.type}]`)}${scoreStr}${suppressedLabel} ${r.summary || r.detail.substring(0, 80)}`);
        console.log(`    ${pc.dim(`by ${r.author} • ${r.created_at}`)}`);
        if (r.affects.length > 0) {
          console.log(`    ${pc.dim(`affects: ${r.affects.join(', ')}`)}`);
        }

        const s = rr.signals;
        console.log(`    ${pc.dim(`signals: sem=${s.semantic_score.toFixed(2)} bm25=${s.bm25_score.toFixed(2)} rec=${s.recency_decay.toFixed(2)} imp=${s.importance.toFixed(2)} graph=${s.graph_connectivity.toFixed(2)}`)}`);
        console.log();
      }

      return;
    } catch (err) {
      console.error(`Search error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // gh#322 — resolve the read scope. `--projects` names win; otherwise the
  // repo's `linked_projects` apply, matching what the MCP tools do. Names are
  // resolved here so the flag never asks a human to type a UUID.
  let scopeIds: string[] = projectId ? [projectId, ...linkedProjectIds] : [...linkedProjectIds];
  if (options.projects) {
    const wanted = options.projects.split(',').map((n) => n.trim()).filter(Boolean);
    let known: ProjectInfo[] = [];
    try {
      if (config.member_id) {
        const supabase = getSupabaseForConfig(config);
        known = await listMemberProjects(supabase, config.member_id);
      }
    } catch {
      // Leave `known` empty — every name then reports as unresolvable below,
      // which is the honest outcome; it must not silently widen the scope.
    }
    const resolvedIds: string[] = [];
    const unresolved: string[] = [];
    for (const name of wanted) {
      const match = known.find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (match) resolvedIds.push(match.id);
      else unresolved.push(name);
    }
    if (unresolved.length > 0) {
      // A warning, not an abort: the resolvable half of the request is still
      // worth answering, as long as the gap is stated rather than hidden.
      console.error(
        pc.yellow(`Not accessible, skipped: ${unresolved.join(', ')}`),
      );
    }
    if (resolvedIds.length === 0) {
      console.error(pc.red('No accessible project matched --projects. Nothing to search.'));
      process.exit(1);
    }
    scopeIds = resolvedIds;
  }

  try {
    const qdrant = getQdrantClient(config.qdrant_url, config.qdrant_api_key);

    // T025: Build project name lookup for --all-projects labeling
    let projectNameMap: Map<string, string> | undefined;
    let rawResults;

    if (options.allProjects) {
      // T025: Cross-project search — get accessible project IDs
      let projectIds: string[] = [];
      projectNameMap = new Map<string, string>();

      try {
        if (config.member_id) {
          const supabase = getSupabaseForConfig(config);
          const projects: ProjectInfo[] = await listMemberProjects(supabase, config.member_id);
          projectIds = projects.map((p) => p.id);
          for (const p of projects) {
            projectNameMap.set(p.id, p.name);
          }
        }
      } catch {
        // Fall back to org-wide search
      }

      if (projectIds.length > 0) {
        rawResults = await hybridSearchAllProjects(qdrant, config.org_id, query, projectIds, {
          type: options.type,
          limit: 50,
        });
      } else {
        rawResults = await hybridSearch(qdrant, config.org_id, query, {
          type: options.type,
          limit: 50,
        });
      }
    } else if (scopeIds.length > 1) {
      // gh#322 — one query over the union so the ranking stays global.
      rawResults = await hybridSearchAllProjects(qdrant, config.org_id, query, scopeIds, {
        type: options.type,
        limit: 50,
      });
    } else {
      // Default: project-scoped search
      rawResults = await hybridSearch(qdrant, config.org_id, query, {
        type: options.type,
        limit: 50,
        projectId: scopeIds[0] ?? projectId,
      });
    }

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
    // 037 (PR #228 review): MMR diversity is the FINAL transform — after
    // rerank + suppression, at the display limit, over composite_score.
    const finalResults = mmrRerank(visible, {
      k: limit,
      relevanceOf: (r) => r.composite_score ?? r.score ?? 0,
    });

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

      // T025: Show [project-name] prefix for cross-project results
      let projectLabel = '';
      if (options.allProjects && r.project_id) {
        const pName = projectNameMap?.get(r.project_id) || r.project_name || r.project_id.slice(0, 8);
        projectLabel = pc.magenta(`[${pName}] `);
      }

      // Show composite_score instead of raw Qdrant score
      const scoreStr = pc.dim(` (score: ${rr.composite_score.toFixed(3)})`);
      const suppressedLabel = rr.suppressed ? pc.dim(pc.yellow(' [suppressed]')) : '';
      console.log(`  ${projectLabel}${typeColor(`[${r.type}]`)}${scoreStr}${suppressedLabel} ${r.summary || r.detail.substring(0, 80)}`);
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
