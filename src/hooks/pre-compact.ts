/**
 * PreCompact hook — capture-window composer.
 *
 * Architecture (2026-05-19, Phase B FR-042 partial activation):
 *
 *   When Claude Code is about to compact a conversation (either auto at
 *   the context threshold or manually via `/compact`), this hook fires
 *   BEFORE summarization happens. We emit a `<valis_capture_window>`
 *   block via `hookSpecificOutput.additionalContext`, which Claude Code
 *   feeds INTO the compaction prompt. The compactor — same model doing
 *   summarization — sees our instruction and emits a structured
 *   `<valis_capture_candidates>` block at the top of the summary so the
 *   post-compact agent can call `valis_store` on each candidate.
 *
 *   Why this is the right shape: the compactor is the only actor with
 *   simultaneous visibility into (a) the full pre-compaction transcript
 *   and (b) the freedom to emit arbitrary structured output. The hook
 *   itself cannot extract decisions (no LLM in the hook process), and
 *   the post-compact agent only sees the summary (raw turns are gone).
 *   By piggybacking on compaction we get one extraction pass at the
 *   exact moment when nothing else can.
 *
 * The block content is pure-text (no IO), kept in this module so it is
 * trivially unit-testable. The handler in `pre-compact-handler.ts` wires
 * stdin envelope reading + stdout emission + telemetry.
 */

export interface CaptureWindowInput {
  /** 'auto' = context-threshold compaction; 'manual' = user-invoked /compact. */
  trigger: 'auto' | 'manual' | 'unknown';
  /** User-supplied `/compact <instructions>` payload, if any. */
  customInstructions?: string;
}

/**
 * Compose the imperative capture-window block. Output is plain text that
 * Claude Code wraps into `additionalContext` and feeds to the compactor.
 *
 * Format invariants the post-compact agent relies on (do not break):
 *   - The capture candidates block opens with `<valis_capture_candidates>`
 *     and closes with `</valis_capture_candidates>`.
 *   - Each candidate is one line starting with `- ` and uses pipe-delimited
 *     key=value pairs in the order: type | summary | affects | detail.
 *   - If no candidates exist, the body is the single token `NONE`.
 */
export function composeCaptureWindowBlock(input: CaptureWindowInput): string {
  const triggerLabel =
    input.trigger === 'manual'
      ? 'manual /compact invocation'
      : input.trigger === 'auto'
        ? 'auto-compaction at context threshold'
        : 'compaction';

  const lines: string[] = [];
  lines.push('SESSION CAPTURE CHECKPOINT — compaction window');
  lines.push(
    `Compaction (${triggerLabel}) is about to truncate this conversation's context.`,
  );
  lines.push(
    'Before producing the standard compaction summary, you MUST extract every',
  );
  lines.push(
    'technical decision, constraint, pattern, or lesson established in this',
  );
  lines.push(
    'session. Emit a `<valis_capture_candidates>` block at the TOP of your',
  );
  lines.push('compaction summary, BEFORE any other content:');
  lines.push('');
  lines.push('<valis_capture_candidates>');
  lines.push(
    '- type=<decision|constraint|pattern|lesson> | summary=<≤100 chars> | affects=<comma-separated module tags> | detail=<one-sentence evidence>',
  );
  lines.push('- ...');
  lines.push('</valis_capture_candidates>');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Be exhaustive on technical content; skip pleasantries.');
  lines.push('- Group near-duplicates into one entry.');
  lines.push(
    '- For each candidate, the post-compact agent will call `valis_store` with the listed fields.',
  );
  lines.push(
    '- If no technical decisions were made, emit `<valis_capture_candidates>NONE</valis_capture_candidates>` so the absence is auditable.',
  );
  lines.push('');
  lines.push('Recall fidelity after compaction depends entirely on this block.');

  if (input.customInstructions && input.customInstructions.trim()) {
    // Don't override user intent — append our capture instruction.
    lines.push('');
    lines.push(
      '(The user-supplied compaction instructions remain in effect; the',
    );
    lines.push(
      'capture block above runs in addition, not instead.)',
    );
  }

  return lines.join('\n');
}
