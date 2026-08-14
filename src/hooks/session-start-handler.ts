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

import { findProjectMarker } from '../config/project.js';
import { record } from './telemetry.js';
import { maybeNotifyOfUpdate } from './update-notifier.js';
import { VERSION } from '../index.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { policyDriftNoticePath } from './paths.js';

const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Exported for tests: the notice is the whole point of gh#340 A, so it is
 * verified directly rather than through the hook's deliberately silent shell. */
export async function maybeNoticePolicyDrift(projectDir?: string): Promise<void> {
  const statePath = policyDriftNoticePath();
  try {
    const last = Number(await readFile(statePath, 'utf-8'));
    if (Number.isFinite(last) && Date.now() - last < NOTICE_INTERVAL_MS) return;
  } catch {
    // No prior notice — fall through and check.
  }

  const { detectPolicyDrift, needsAttention } = await import('./policy-drift.js');
  const problems = needsAttention(await detectPolicyDrift(projectDir));
  if (problems.length === 0) return;

  const worst = problems.reduce((a, b) => (b.generationsBehind > a.generationsBehind ? b : a));
  const what =
    worst.state === 'malformed'
      ? 'has broken Valis markers'
      : worst.state === 'newer'
        ? 'carries a policy version this CLI does not know (update Valis)'
        : `is ${worst.generationsBehind} policy generation${worst.generationsBehind === 1 ? '' : 's'} behind`;
  process.stderr.write(
    `valis: ${worst.path} ${what} and is not receiving updates — run \`valis doctor\` to review\n`,
  );

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, String(Date.now()));
}

export async function hookSessionStartCommand(): Promise<void> {
  const startedAt = Date.now();

  // Update-notifier — runs on every session-start regardless of Valis
  // configuration state. Reads cache off the hot path (~1ms), emits a
  // one-line notice to stderr when a newer CLI is published. Background
  // npm-registry refresh fires-and-forgets so the hook doesn't block.
  // Disabled by VALIS_NO_UPDATE_NOTIFIER=1 for CI / containerized envs
  // where the registry call is undesirable.
  if ((process.env.VALIS_NO_UPDATE_NOTIFIER ?? '') !== '1') {
    await maybeNotifyOfUpdate(VERSION);
  }

  const marker = await findProjectMarker();

  // gh#340 (A) — the GLOBAL block is checked even outside a Valis project.
  // Gating this behind a project marker would mean a user whose global block is
  // frozen never hears about it as long as they work in uninitialized repos —
  // the same silence, moved one level out (review round 1).
  try {
    await maybeNoticePolicyDrift(marker?.projectDir);
  } catch {
    // Notices never block a session.
  }

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
