/**
 * PreCompact hook handler — v0.5.3 default-silent, gate opt-in.
 *
 * History:
 *
 *   v0.5.0 — emitted `hookSpecificOutput.additionalContext` to try to
 *            instruct the compactor. Silently broken: Claude Code's
 *            PreCompact protocol rejects that field. Output failed
 *            schema validation and the compactor never saw our
 *            instruction.
 *
 *   v0.5.2 — switched to `{decision: "block", reason: "<imperative>"}`
 *            with a per-session sentinel. This worked but Claude Code
 *            renders `decision: "block"` as a user-facing ERROR. The
 *            agent never auto-acted on the reason — Claude Code does
 *            not create a new agent turn from a hook block. Result:
 *            users saw a red error message every `/compact` and had to
 *            manually prompt the agent to follow the steps.
 *
 *   v0.5.3 (this file) — silent no-op by default. PreCompact emits
 *            empty stdout, exit 0; `/compact` runs normally with no
 *            error toast. Capture happens continuously through the
 *            UserPromptSubmit token-density reminder (active since
 *            v0.4.0) rather than at the compaction moment.
 *
 *            The sentinel-gate machinery (sentinels.ts, the
 *            `valis hook capture-done` CLI subcommand) is preserved
 *            and can be re-activated by setting
 *            `VALIS_PRECOMPACT_GATE=1`. Useful for operators who
 *            explicitly want the harder-but-friction-heavier
 *            checkpoint behavior, e.g. for compliance contexts or
 *            once a server-side extraction path lands.
 *
 * Why silent no-op is the right default:
 *
 *   - UserPromptSubmit capture-reminder already nudges the agent
 *     throughout the session, when the conversation context is fresh
 *     and the agent has full latitude to act on the imperative.
 *     PreCompact is structurally a poor capture moment: by the time it
 *     fires, the user has already chosen to truncate context.
 *
 *   - `decision: "block"` is a harness-level signal that shows as an
 *     error to the user, not as an actionable instruction to the
 *     agent. There is no Claude Code hook output shape that lets a
 *     PreCompact hook synchronously trigger an agent extraction turn
 *     and then resume compaction. The only path to fully-automatic
 *     pre-compaction capture is server-side LLM extraction, which is
 *     a separate architectural decision (cost + dependency trade-offs).
 *
 *   - Keeping the sentinel + capture-done CLI surface alive costs
 *     nothing: they're inert without the gate, and `valis hook
 *     capture-done` is still callable as a manual snapshot trigger.
 *
 * Constitution III: any throw → empty stdout, exit 0 (bin/ wrapper).
 */

import { findProjectMarker } from '../config/project.js';
import { loadHookGlobalConfig } from './context.js';
import { record } from './telemetry.js';
import { clearSentinel, hasSentinel } from './sentinels.js';

interface HookEnvelope {
  transcript_path?: string;
  trigger?: string;
  custom_instructions?: string;
  session_id?: string;
}

async function readHookEnvelope(): Promise<HookEnvelope | null> {
  if (process.stdin.isTTY) return null;

  return new Promise<HookEnvelope | null>((resolve) => {
    let buf = '';
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      resolve(null);
    }, 50);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (!buf.trim()) return resolve(null);
      try {
        const parsed = JSON.parse(buf) as HookEnvelope;
        resolve(parsed);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on('error', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function normalizeTrigger(raw: string | undefined): 'auto' | 'manual' | 'unknown' {
  if (raw === 'auto' || raw === 'manual') return raw;
  return 'unknown';
}

function composeBlockReason(sessionId: string | undefined): string {
  const sessionHint = sessionId
    ? `(session_id=${sessionId})`
    : '(CLAUDE_SESSION_ID env var carries the session_id automatically)';
  return [
    'Pre-compaction capture required — /compact will not proceed until',
    `decisions from this conversation are stored in Valis ${sessionHint}.`,
    '',
    'Do exactly this, in order:',
    '',
    '1. Walk the conversation already in your context. For EACH technical',
    '   decision, constraint, pattern, or lesson, call `valis_store` with',
    '   type, summary, affects, and the supporting detail.',
    '',
    '2. Run via the Bash tool: `valis hook capture-done --stored <N>`',
    '',
    '3. Invoke `/compact` again via the SlashCommand tool.',
  ].join('\n');
}

function emitBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

/** Read truthy `VALIS_PRECOMPACT_GATE` env var. Accepts `1`, `true`, `yes`. */
function gateEnabled(): boolean {
  const raw = (process.env.VALIS_PRECOMPACT_GATE ?? '').toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export async function hookPreCompactCommand(): Promise<void> {
  // Default path: silent no-op. /compact proceeds, no error toast.
  if (!gateEnabled()) {
    // Telemetry context — log every PreCompact fire so we can audit how
    // often /compact runs, even when the gate is off.
    const marker = await findProjectMarker();
    const cfg = await loadHookGlobalConfig();
    if (cfg && marker) {
      void record('capture_window_opened', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        metadata: { gate: 'disabled' },
      });
    }
    return;
  }

  // Opt-in gate path: same v0.5.2 sentinel-check behavior.
  const envelope = await readHookEnvelope();
  const sessionId = envelope?.session_id ?? process.env.CLAUDE_SESSION_ID;
  const trigger = normalizeTrigger(envelope?.trigger);

  const marker = await findProjectMarker();
  const cfg = await loadHookGlobalConfig();

  if (!sessionId) {
    if (cfg && marker) {
      void record('capture_window_opened', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        metadata: { gate: 'enabled', trigger, sentinel_present: false, reason: 'no_session_id' },
      });
    }
    emitBlock(composeBlockReason(undefined));
    return;
  }

  const present = await hasSentinel(sessionId);

  if (cfg && marker) {
    void record('capture_window_opened', {
      org_id: cfg.orgId,
      project_id: marker.projectId,
      metadata: { gate: 'enabled', trigger, sentinel_present: present, session_id: sessionId },
    });
  }

  if (present) {
    await clearSentinel(sessionId);
    return;
  }

  emitBlock(composeBlockReason(sessionId));
}
