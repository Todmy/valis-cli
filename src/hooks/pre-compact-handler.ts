/**
 * PreCompact hook handler — capture-window injection.
 *
 * Wiring:
 *   1. Read Claude Code's stdin envelope (transcript_path, trigger,
 *      custom_instructions, session_id). Same 50ms-bounded pattern used
 *      by user-prompt-submit-handler.
 *   2. Compose the imperative capture block via `composeCaptureWindowBlock`.
 *   3. Emit JSON: `{hookSpecificOutput: {hookEventName: 'PreCompact',
 *      additionalContext: <block>}}`. Claude Code feeds this into the
 *      compaction prompt so the compactor model sees our instruction.
 *   4. Record telemetry `capture_window_opened` with trigger + transcript
 *      size + token estimate, so we can correlate compaction events with
 *      downstream `valis_store` activity.
 *
 * Constitution III: any throw → empty stdout, exit 0. Wrapped at bin level.
 *
 * Why not extract candidates here: the hook process has no LLM, the
 * transcript is multi-megabyte JSONL, and the post-compact agent already
 * sees the summary. The compactor is the only actor with the right
 * affordance — see pre-compact.ts header for the architectural rationale.
 */

import { findProjectMarker } from '../config/project.js';
import { loadHookGlobalConfig } from './context.js';
import { record } from './telemetry.js';
import { readTranscriptTokens } from './transcript.js';
import { composeCaptureWindowBlock } from './pre-compact.js';

interface HookEnvelope {
  transcript_path?: string;
  trigger?: string;
  custom_instructions?: string;
}

/**
 * Read Claude Code's hook JSON envelope from stdin. Mirrors the pattern in
 * user-prompt-submit-handler: 50ms hard cap, null on TTY / empty / parse fail.
 */
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

function emitContext(additionalContext: string): void {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext,
    },
  };
  process.stdout.write(JSON.stringify(payload));
}

export async function hookPreCompactCommand(): Promise<void> {
  // Project marker + global config are best-effort: even without them we
  // still emit the capture block (the compactor doesn't care about org/
  // project IDs). They only gate telemetry.
  const marker = await findProjectMarker();
  const cfg = await loadHookGlobalConfig();

  const envelope = await readHookEnvelope();
  const trigger = normalizeTrigger(envelope?.trigger);
  const customInstructions = envelope?.custom_instructions;

  const block = composeCaptureWindowBlock({ trigger, customInstructions });
  emitContext(block);

  // Telemetry: best-effort, fire-and-forget. We log regardless of whether
  // marker/cfg are available; missing fields just stay undefined.
  if (cfg && marker) {
    const transcriptInfo = envelope?.transcript_path
      ? await readTranscriptTokens(envelope.transcript_path)
      : null;
    void record('capture_window_opened', {
      org_id: cfg.orgId,
      project_id: marker.projectId,
      metadata: {
        trigger,
        transcript_bytes: transcriptInfo?.totalBytes ?? null,
        transcript_tokens: transcriptInfo?.totalTokens ?? null,
        has_custom_instructions: Boolean(customInstructions && customInstructions.trim()),
        session_id: process.env.CLAUDE_SESSION_ID ?? null,
      },
    });
  }
}
