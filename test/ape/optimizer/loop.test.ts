/**
 * 285/T019: optimizer loop + patch emitter.
 *
 * Contract (plan.md Task 19): `optimize({ start, corpus, optimizer, deps, spend,
 * maxIters })` runs a baseline eval on held-out (K repeats → variance band),
 * then loops {propose → eval candidates on train → pick best > band on held-out
 * → if improved, set as new current} until no improvement OR
 * `spend.assertWithinCap()` throws OR `maxIters` is reached. On finish it emits
 * the winner as a `patch` (unified-diff string anchored on
 * `adapter.deployTarget(surface)`); the function NEVER writes to the target file
 * (const XII — human applies).
 *
 * Named cases: runs baseline then proposes / accepts candidate beating band /
 * rejects within-band candidate / halts on budget exceeded and returns
 * best-so-far / emits patch, does NOT modify server.ts/inject-block.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { optimize } from '../../../src/ape/optimizer/loop.js';
import { BudgetExceededError } from '../../../src/ape/optimizer/spend.js';
import { ClaudeCodeAdapter } from '../../../src/ape/agents/claude-code.js';
import type {
  ApeCorpusItem,
  EvalSummary,
  PromptVariant,
} from '../../../src/ape/types.js';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

function item(id: string): ApeCorpusItem {
  return {
    id,
    prompt: `prompt-${id}`,
    should_consult: true,
    should_inject: false,
    stratum: 'normal',
    label_source: 'llm_proposed',
    needs_human_confirm: true,
  };
}

function summary(consultRecall: number): EvalSummary {
  return {
    consultPrecision: 1,
    consultRecall,
    injectActionRate: 0,
    nearBoundaryFpRate: 0,
    failingExamples: [],
  };
}

const startVariant: PromptVariant = {
  id: 'v0',
  surface: 'pull_tool_description',
  text: 'Search the team decision history.',
};

const corpus = [item('a'), item('b')];

/** A spend tracker stub that never throws (cap effectively infinite). */
function makeSpend(): {
  add: ReturnType<typeof vi.fn>;
  total: () => number;
  remaining: () => number;
  assertWithinCap: ReturnType<typeof vi.fn>;
} {
  let spent = 0;
  return {
    add: vi.fn((usd: number) => {
      spent += usd;
    }),
    total: () => spent,
    remaining: () => Infinity,
    assertWithinCap: vi.fn(() => {}),
  };
}

describe('optimize', () => {
  it('runs baseline then proposes', async () => {
    const evalVariant = vi
      .fn<(v: PromptVariant, set: 'train' | 'heldOut') => Promise<EvalSummary>>()
      .mockResolvedValue(summary(0.5));
    const propose = vi.fn(async () => [] as PromptVariant[]);
    const spend = makeSpend();

    await optimize({
      start: startVariant,
      corpus,
      optimizer: { propose },
      deps: { evalVariant, adapter: new ClaudeCodeAdapter(), repeats: 3 },
      spend,
      maxIters: 1,
    });

    // Baseline: K=3 held-out repeats of the start variant.
    expect(
      evalVariant.mock.calls.filter(
        ([v, set]) => v.id === 'v0' && set === 'heldOut',
      ).length,
    ).toBe(3);
    // Then the optimizer was asked to propose at least once.
    expect(propose).toHaveBeenCalled();
  });

  it('accepts candidate beating band', async () => {
    const candidate: PromptVariant = {
      id: 'v1',
      surface: 'pull_tool_description',
      text: 'BETTER: always consult the team decision history first.',
    };
    const evalVariant = vi
      .fn<(v: PromptVariant, set: 'train' | 'heldOut') => Promise<EvalSummary>>()
      .mockImplementation(async (v) =>
        // start scores ~0.5 (with no variance → band 0); candidate scores 0.9.
        v.id === 'v1' ? summary(0.9) : summary(0.5),
      );
    const propose = vi.fn(async () => [candidate]);
    const spend = makeSpend();

    const out = await optimize({
      start: startVariant,
      corpus,
      optimizer: { propose },
      deps: { evalVariant, adapter: new ClaudeCodeAdapter(), repeats: 3 },
      spend,
      maxIters: 1,
    });

    expect(out.accepted).toBe(true);
    expect(out.winner.id).toBe('v1');
  });

  it('rejects within-band candidate', async () => {
    const candidate: PromptVariant = {
      id: 'v1',
      surface: 'pull_tool_description',
      text: 'marginal tweak',
    };
    // Baseline repeats spread → a non-zero band; candidate barely above mean.
    let baselineCall = 0;
    const evalVariant = vi
      .fn<(v: PromptVariant, set: 'train' | 'heldOut') => Promise<EvalSummary>>()
      .mockImplementation(async (v, set) => {
        if (v.id === 'v0' && set === 'heldOut') {
          // [0.4, 0.5, 0.6] → mean 0.5, band 2σ ≈ 0.163.
          const scores = [0.4, 0.5, 0.6];
          return summary(scores[baselineCall++ % scores.length]);
        }
        // candidate 0.55 — only +0.05 over the 0.5 mean, inside the band.
        return summary(0.55);
      });
    const propose = vi.fn(async () => [candidate]);
    const spend = makeSpend();

    const out = await optimize({
      start: startVariant,
      corpus,
      optimizer: { propose },
      deps: { evalVariant, adapter: new ClaudeCodeAdapter(), repeats: 3 },
      spend,
      maxIters: 1,
    });

    expect(out.accepted).toBe(false);
    expect(out.winner.id).toBe('v0'); // unchanged
  });

  it('halts on budget exceeded and returns best-so-far', async () => {
    const candidate: PromptVariant = {
      id: 'v1',
      surface: 'pull_tool_description',
      text: 'candidate',
    };
    const evalVariant = vi
      .fn<(v: PromptVariant, set: 'train' | 'heldOut') => Promise<EvalSummary>>()
      .mockResolvedValue(summary(0.5));
    const propose = vi.fn(async () => [candidate]);

    // Throw on the FIRST cap check (after baseline) so no candidate is accepted.
    const spend = makeSpend();
    spend.assertWithinCap.mockImplementation(() => {
      throw new BudgetExceededError(99, 0, 40, 0); // calls 99 > maxCalls 40
    });

    const out = await optimize({
      start: startVariant,
      corpus,
      optimizer: { propose },
      deps: { evalVariant, adapter: new ClaudeCodeAdapter(), repeats: 3 },
      spend,
      maxIters: 5,
    });

    // Halted gracefully — best-so-far is the start variant, not accepted.
    expect(out.winner.id).toBe('v0');
    expect(out.accepted).toBe(false);
    expect(out.patch).toBeTruthy();
  });

  it('emits patch, does NOT modify server.ts/inject-block.ts', async () => {
    const serverPath = join(REPO_ROOT, 'packages/cli/src/mcp/server.ts');
    const injectPath = join(REPO_ROOT, 'packages/cli/src/hooks/inject-block.ts');
    const serverBefore = readFileSync(serverPath, 'utf-8');
    const injectBefore = readFileSync(injectPath, 'utf-8');

    const evalVariant = vi
      .fn<(v: PromptVariant, set: 'train' | 'heldOut') => Promise<EvalSummary>>()
      .mockResolvedValue(summary(0.5));
    const propose = vi.fn(async () => [] as PromptVariant[]);
    const spend = makeSpend();

    const out = await optimize({
      start: startVariant,
      corpus,
      optimizer: { propose },
      deps: { evalVariant, adapter: new ClaudeCodeAdapter(), repeats: 3 },
      spend,
      maxIters: 1,
    });

    // The patch references the real deploy target (a diff, not an applied edit).
    expect(out.patch).toContain('packages/cli/src/mcp/server.ts');
    expect(out.patch).toMatch(/^---|^\+\+\+|diff/m);

    // Target files are byte-identical — the loop NEVER writes them (const XII).
    expect(readFileSync(serverPath, 'utf-8')).toBe(serverBefore);
    expect(readFileSync(injectPath, 'utf-8')).toBe(injectBefore);
  });
});
