/**
 * SessionStart hook handler — Phase A.
 *
 * Branches per contracts/hook-protocol.md:
 *   A — Valis-configured project, fresh fetch succeeded → labeled block.
 *   B — Valis-configured project, served from local cache → labeled block + cache_age_seconds.
 *   C — Valis-configured project, no cache + backend unreachable → <valis_offline> stub.
 *   D — Valis-configured project, zero active decisions → labeled block with <empty_state>.
 *   E — Not in a Valis-configured directory → empty stdout, exit 0.
 *
 * Constitution III: any failure → empty stdout, exit 0; record `hook_failure`.
 */

import { loadHookMarker, loadHookGlobalConfig } from './context.js';
import {
  read as readCache,
  write as writeCache,
  isFresh,
  ageSeconds,
  type ProjectContextSnapshot,
} from './cache.js';
import { fetchContextSnapshot } from './context-fetch.js';
import {
  composeTeamDecisionsBlock,
  composeOfflineBlock,
} from './inject-block.js';
import { record } from './telemetry.js';

function emitContext(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

export async function hookSessionStartCommand(): Promise<void> {
  const startedAt = Date.now();
  const sessionId = process.env.CLAUDE_SESSION_ID ?? '<session_id>';

  // Branch E — not a Valis-configured directory.
  const marker = await loadHookMarker();
  if (!marker) {
    return; // empty stdout
  }

  // Self-heal pass — best-effort, runs before context fetch. Detects
  // drift in Valis-managed surfaces and re-applies canonical templates.
  // Honors `auto_heal: false` opt-out in ~/.valis/config.json.
  // Constitution III: any failure here must NOT block the session.
  try {
    const { runSelfHeal } = await import('./self-heal.js');
    await runSelfHeal({
      projectDir: marker.projectDir,
      projectId: marker.projectId,
    });
  } catch {
    /* heal failures are silent by design */
  }

  const cfg = await loadHookGlobalConfig();
  if (!cfg) {
    // Without org_id we can't read the cache. Treat as "no context, configured".
    return;
  }
  const { orgId, apiKey, apiBaseUrl } = cfg;
  const projectId = marker.projectId;

  // 1) Fresh cache — Branch A or D depending on decision_count.
  const cached = await readCache(orgId, projectId);
  if (cached && isFresh(cached, cached.ttl_seconds ?? 300)) {
    const block = composeTeamDecisionsBlock(cached, { sessionId });
    emitContext(block);
    void record('cache_hit', {
      org_id: orgId,
      project_id: projectId,
      latency_ms: Date.now() - startedAt,
    });
    void record('session_start_inject', {
      org_id: orgId,
      project_id: projectId,
      latency_ms: Date.now() - startedAt,
    });
    return;
  }

  // 2) Cache stale or missing → fetch backend (Branch A on success).
  let snapshot: ProjectContextSnapshot | null = null;
  if (apiKey) {
    snapshot = await fetchContextSnapshot({
      apiBaseUrl,
      apiKey,
      projectId,
    });
  }
  if (snapshot) {
    // Persist to cache for the next session.
    try {
      await writeCache(orgId, projectId, snapshot);
    } catch {
      /* cache write failure must not break injection */
    }
    const block = composeTeamDecisionsBlock(snapshot, { sessionId });
    emitContext(block);
    void record(cached ? 'cache_miss' : 'cache_miss', {
      org_id: orgId,
      project_id: projectId,
    });
    void record('session_start_inject', {
      org_id: orgId,
      project_id: projectId,
      latency_ms: Date.now() - startedAt,
    });
    return;
  }

  // 3) Backend unreachable.
  if (cached) {
    // Branch B — serve stale cache with cache_age_seconds annotation.
    const stale: ProjectContextSnapshot = {
      ...cached,
      served_from_cache: true,
      cache_age_seconds: ageSeconds(cached),
    };
    const block = composeTeamDecisionsBlock(stale, { sessionId });
    emitContext(block);
    void record('cache_hit_stale', {
      org_id: orgId,
      project_id: projectId,
      cache_age_seconds: stale.cache_age_seconds,
      latency_ms: Date.now() - startedAt,
    });
    return;
  }

  // Branch C — no cache, no backend.
  const block = composeOfflineBlock(marker.projectName, sessionId);
  emitContext(block);
  void record('session_start_offline_stub', {
    org_id: orgId,
    project_id: projectId,
    latency_ms: Date.now() - startedAt,
  });
}
