/**
 * Unit tests for pre-compact.ts — capture-window block composer.
 *
 * The block content is a contract between (a) the PreCompact hook and
 * (b) the compactor model that produces summaries Claude Code re-injects
 * after compaction. The post-compact agent later parses the structured
 * candidates block, so format invariants are regression-locked here.
 */

import { describe, expect, it } from 'vitest';
import { composeCaptureWindowBlock } from '../../src/hooks/pre-compact.js';

describe('composeCaptureWindowBlock', () => {
  it('opens with the capture checkpoint header', () => {
    const block = composeCaptureWindowBlock({ trigger: 'manual' });
    expect(block.startsWith('SESSION CAPTURE CHECKPOINT')).toBe(true);
  });

  it('embeds the structured candidates schema (regression-locked)', () => {
    const block = composeCaptureWindowBlock({ trigger: 'auto' });
    expect(block).toContain('<valis_capture_candidates>');
    expect(block).toContain('</valis_capture_candidates>');
    // Schema line must enumerate keys in the order the post-compact agent expects.
    expect(block).toContain(
      'type=<decision|constraint|pattern|lesson> | summary=<≤100 chars> | affects=<comma-separated module tags> | detail=<one-sentence evidence>',
    );
  });

  it('documents the NONE sentinel for empty-decision sessions', () => {
    const block = composeCaptureWindowBlock({ trigger: 'manual' });
    expect(block).toContain('<valis_capture_candidates>NONE</valis_capture_candidates>');
  });

  it('labels the trigger differently for manual vs auto', () => {
    const manual = composeCaptureWindowBlock({ trigger: 'manual' });
    const auto = composeCaptureWindowBlock({ trigger: 'auto' });
    expect(manual).toContain('manual /compact invocation');
    expect(auto).toContain('auto-compaction at context threshold');
  });

  it('falls back to a generic label for unknown trigger', () => {
    const block = composeCaptureWindowBlock({ trigger: 'unknown' });
    expect(block).toContain('Compaction (compaction) is about to truncate');
  });

  it('acknowledges user-supplied custom instructions without overriding them', () => {
    const block = composeCaptureWindowBlock({
      trigger: 'manual',
      customInstructions: 'focus on the API changes',
    });
    expect(block).toContain('user-supplied compaction instructions remain in effect');
    expect(block).toContain('runs in addition, not instead');
  });

  it('omits the custom-instructions footer when none provided', () => {
    const block = composeCaptureWindowBlock({ trigger: 'auto' });
    expect(block).not.toContain('user-supplied compaction instructions');
  });

  it('treats whitespace-only custom instructions as absent', () => {
    const block = composeCaptureWindowBlock({
      trigger: 'manual',
      customInstructions: '   \n  ',
    });
    expect(block).not.toContain('user-supplied compaction instructions');
  });
});
