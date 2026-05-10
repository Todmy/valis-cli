/**
 * Tests for the store side-effect bus. Covers the contract independent of
 * the real adapters: parallel dispatch, isolation of failures, conditional
 * shouldRun gating, and structured output extraction.
 */

import { describe, it, expect } from 'vitest';
import {
  runStoreSideEffects,
  sideEffectOutput,
  type StoreSideEffect,
  type StoreSideEffectContext,
} from '../../../src/mcp/tools/store-side-effects.js';

// Minimal context shim — bus contract doesn't read most fields, only passes
// them through. Adapters in real production read the fields they need.
const fakeCtx = {} as StoreSideEffectContext;

describe('runStoreSideEffects', () => {
  it('records ok with structured output for successful effects', async () => {
    const effect: StoreSideEffect<{ kind: string }> = {
      name: 'demo',
      async run() {
        return { kind: 'ok' };
      },
    };
    const results = await runStoreSideEffects([effect], fakeCtx);
    expect(results.get('demo')).toMatchObject({
      name: 'demo',
      status: 'ok',
      output: { kind: 'ok' },
    });
    expect(sideEffectOutput<{ kind: string }>(results, 'demo')).toEqual({ kind: 'ok' });
  });

  it('records failed with captured error and does not throw', async () => {
    const effect: StoreSideEffect = {
      name: 'flaky',
      async run() {
        throw new Error('boom');
      },
    };
    const results = await runStoreSideEffects([effect], fakeCtx);
    const r = results.get('flaky')!;
    expect(r.status).toBe('failed');
    expect(r.error?.message).toBe('boom');
    expect(sideEffectOutput(results, 'flaky')).toBeUndefined();
  });

  it('isolates failures — one adapter throwing does not block others', async () => {
    const effects: StoreSideEffect[] = [
      {
        name: 'first',
        async run() {
          throw new Error('first failed');
        },
      },
      {
        name: 'second',
        async run() {
          return 'second-output';
        },
      },
      {
        name: 'third',
        async run() {
          throw new Error('third failed');
        },
      },
    ];
    const results = await runStoreSideEffects(effects, fakeCtx);
    expect(results.get('first')!.status).toBe('failed');
    expect(results.get('second')!.status).toBe('ok');
    expect(results.get('second')!.output).toBe('second-output');
    expect(results.get('third')!.status).toBe('failed');
  });

  it('skips effects whose shouldRun returns false', async () => {
    const effect: StoreSideEffect = {
      name: 'conditional',
      shouldRun: () => false,
      async run() {
        throw new Error('must not run');
      },
    };
    const results = await runStoreSideEffects([effect], fakeCtx);
    expect(results.get('conditional')).toMatchObject({
      name: 'conditional',
      status: 'skipped',
    });
  });

  it('runs effects in parallel — total duration ≈ max single duration', async () => {
    const slow = (ms: number, name: string): StoreSideEffect => ({
      name,
      async run() {
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    const start = Date.now();
    await runStoreSideEffects([slow(50, 'a'), slow(50, 'b'), slow(50, 'c')], fakeCtx);
    const elapsed = Date.now() - start;
    // If serial we'd see ~150ms; parallel should land around 50ms plus a
    // healthy safety margin to keep CI stable on slow runners.
    expect(elapsed).toBeLessThan(120);
  });

  it('captures non-Error throws as Error instances', async () => {
    const effect: StoreSideEffect = {
      name: 'odd',
      async run() {
        // Mimic a poorly-behaved upstream that throws a plain string.

        throw 'not an error';
      },
    };
    const results = await runStoreSideEffects([effect], fakeCtx);
    expect(results.get('odd')!.error).toBeInstanceOf(Error);
    expect(results.get('odd')!.error?.message).toBe('not an error');
  });
});

describe('sideEffectOutput', () => {
  it('returns undefined for missing effect', async () => {
    const results = new Map();
    expect(sideEffectOutput(results, 'absent')).toBeUndefined();
  });

  it('returns undefined for failed effect', async () => {
    const results = await runStoreSideEffects(
      [{ name: 'x', async run() { throw new Error('nope'); } }],
      fakeCtx,
    );
    expect(sideEffectOutput(results, 'x')).toBeUndefined();
  });

  it('returns undefined for skipped effect', async () => {
    const results = await runStoreSideEffects(
      [{ name: 'x', shouldRun: () => false, async run() { return 'unreachable'; } }],
      fakeCtx,
    );
    expect(sideEffectOutput(results, 'x')).toBeUndefined();
  });
});
