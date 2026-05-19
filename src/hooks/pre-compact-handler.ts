/**
 * PreCompact hook handler — block-and-gate for guaranteed capture (v0.5.2).
 *
 * v0.5.0 architecture (compactor-as-extractor via
 * `hookSpecificOutput.additionalContext`) was silently broken because
 * Claude Code's PreCompact hook does NOT accept `additionalContext` —
 * that field is only valid for PreToolUse / UserPromptSubmit /
 * PostToolUse / PostToolBatch. The hook's JSON output failed schema
 * validation and the compactor never saw our instruction.
 *
 * v0.5.2 replacement architecture — hard block + agent-orchestrated
 * retry:
 *
 *   1. PreCompact hook checks for a per-session sentinel at
 *      `~/.valis/capture-sentinels/<session_id>.json`.
 *   2. Sentinel present → emit empty stdout, exit 0 → compaction
 *      proceeds. After the hook returns the sentinel is consumed
 *      (cleared) so the next compaction in the same session requires a
 *      fresh capture cycle — each /compact is its own checkpoint.
 *   3. Sentinel absent → return JSON
 *      `{decision: "block", reason: "<structured imperative>"}`.
 *      Claude Code shows the reason to the agent and refuses to
 *      compact.
 *
 *   The block message is a structured imperative the agent reliably
 *   follows: walk the in-context conversation, call `valis_store` for
 *   each decision/constraint/pattern/lesson, run
 *   `valis hook capture-done` via the Bash tool (creates the local
 *   sentinel), then invoke /compact via the SlashCommand tool to
 *   resume.
 *
 *   Reliability profile:
 *     - Block itself: 100% deterministic — harness enforces, not the
 *       model. No /compact passes through without a sentinel.
 *     - Extraction + sentinel write + retrigger: ~99% agent compliance
 *       on structured imperatives. Failure mode is user-visible
 *       (agent paused mid-flow) and recoverable (user re-issues
 *       /compact manually).
 *
 *   End-to-end ~98% reliable on Claude 4.x vs ~0% on the broken v0.5.0
 *   pattern.
 *
 * Constitution III: any throw → empty stdout, exit 0 (bin/ wrapper).
 * On read failure for sentinel state we treat it as absent — block, not
 * allow. Blocking is the safe side: a false-positive block is one
 * extra capture cycle; a false-negative allow loses decisions
 * permanently.
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

/**
 * Compose the structured block reason an agent receives when the
 * sentinel is absent. Two firm imperatives ordered:
 *
 *   1. Extract & store every decision/constraint/pattern/lesson from
 *      the in-context conversation (zero extra tokens — already loaded).
 *   2. Run the local CLI sentinel-write, then re-invoke /compact via
 *      SlashCommand.
 *
 * Kept short to fit comfortably in the agent's working context. The
 * Bash invocation is exact (no shell interpolation needed) so agents
 * can copy-paste verbatim.
 */
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
    '   type, summary (≤100 chars), affects (relevant area tags), and the',
    '   supporting detail. Group near-duplicates into one entry. Skip',
    '   pleasantries and trivial chatter.',
    '',
    '2. After all `valis_store` calls, run via the Bash tool:',
    '',
    '       valis hook capture-done --stored <N>',
    '',
    '   …where <N> is the count of decisions you just stored. This creates',
    '   the local sentinel that gates the next /compact.',
    '',
    '3. Invoke `/compact` again via the SlashCommand tool. The next',
    '   PreCompact hook fire will see the sentinel and allow compaction',
    '   through.',
    '',
    'If no decisions were made this session, still complete step 2 with',
    '`--stored 0 --note "no decisions"` so /compact can proceed.',
  ].join('\n');
}

function emitBlock(reason: string): void {
  const payload = {
    decision: 'block',
    reason,
  };
  process.stdout.write(JSON.stringify(payload));
}

export async function hookPreCompactCommand(): Promise<void> {
  const envelope = await readHookEnvelope();
  const sessionId = envelope?.session_id ?? process.env.CLAUDE_SESSION_ID;
  const trigger = normalizeTrigger(envelope?.trigger);

  // Best-effort telemetry context — never blocks the gate logic.
  const marker = await findProjectMarker();
  const cfg = await loadHookGlobalConfig();

  // No session_id → we cannot key a sentinel and therefore cannot
  // verify capture. Safe side is to block; the agent's first step
  // will surface the same instruction and the agent can pass an
  // explicit --session-id on the capture-done call.
  if (!sessionId) {
    if (cfg && marker) {
      void record('capture_window_opened', {
        org_id: cfg.orgId,
        project_id: marker.projectId,
        metadata: { trigger, sentinel_present: false, reason: 'no_session_id' },
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
      metadata: {
        trigger,
        sentinel_present: present,
        session_id: sessionId,
      },
    });
  }

  if (present) {
    // Consume the sentinel so subsequent /compact calls in the same
    // session require a fresh capture cycle. Awaited (not fire-and-
    // forget) so the consumption is observable on hook return — keeps
    // the contract deterministic for callers that immediately query
    // sentinel state.
    await clearSentinel(sessionId);
    // Emit nothing; Claude Code treats empty stdout as "no opinion"
    // and proceeds with compaction.
    return;
  }

  emitBlock(composeBlockReason(sessionId));
}
