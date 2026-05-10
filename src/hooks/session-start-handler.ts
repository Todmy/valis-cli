/**
 * SessionStart hook handler — Phase B (post-#172).
 *
 * Backend preload was deleted to obsolete BUG #119 (plugin hooks can't
 * authenticate) and BUG #120 (CLAUDE_PROJECT_DIR unreliable). The hook
 * now does ONLY local work: self-heal of Valis-managed surfaces. The
 * agent loads team context on demand via `valis_context` (MCP tool),
 * which authenticates correctly through Claude Code's OAuth-aware MCP
 * transport.
 *
 * UX outcome is functionally identical: project-level CLAUDE.md (auto-
 * injected by self-heal — feature 023 Phase A) instructs the agent to
 * call `valis_context` as the first tool. The shift is from "preload at
 * SessionStart" to "first MCP call" — slightly higher latency on the
 * first response, no fragility around hook auth.
 *
 * Constitution III: any failure here MUST NOT block the session. The
 * handler always emits empty stdout and returns 0; self-heal failures
 * are silent.
 */

import { loadHookMarker } from './context.js';
import { record } from './telemetry.js';

export async function hookSessionStartCommand(): Promise<void> {
  const startedAt = Date.now();

  const marker = await loadHookMarker();
  if (!marker) {
    return; // Not a Valis-configured directory — nothing to heal.
  }

  // Self-heal pass — best-effort. Detects drift in Valis-managed surfaces
  // (CLAUDE.md instruction blocks, .gitignore, MCP wiring) and re-applies
  // canonical templates. Honors `auto_heal: false` opt-out in
  // ~/.valis/config.json.
  try {
    const { runSelfHeal } = await import('./self-heal.js');
    await runSelfHeal({
      projectDir: marker.projectDir,
      projectId: marker.projectId,
    });
  } catch {
    // Heal failures are silent by design — never block session start.
  }

  void record('session_start_self_heal', {
    project_id: marker.projectId,
    latency_ms: Date.now() - startedAt,
  });

  // Empty stdout — no additionalContext. The agent will fetch team
  // context on demand via valis_context (MCP) when CLAUDE.md prompts it.
}
