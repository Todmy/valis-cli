/**
 * Tests for the store side-effect bus. Covers the contract independent of
 * the real adapters: parallel dispatch, isolation of failures, conditional
 * shouldRun gating, and structured output extraction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// 036/US1: spy on upsertDecision so we can assert the qdrant-write adapter
// threads the caller-supplied status into the Qdrant payload extras.
const upsertDecisionSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/cloud/qdrant.js', () => ({
  upsertDecision: (...args: unknown[]) => upsertDecisionSpy(...args),
}));

import {
  runStoreSideEffects,
  sideEffectOutput,
  STORE_SIDE_EFFECTS,
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

  // Fix 1 (#71 race): an effect with `dependsOn` must not start until its
  // dependency has fully settled. This is what guarantees contradiction
  // detection reads an already-upserted Qdrant vector.
  it('holds a dependent effect until its dependency settles', async () => {
    const order: string[] = [];
    const effects: StoreSideEffect[] = [
      {
        name: 'qdrant-write',
        async run() {
          await new Promise((r) => setTimeout(r, 40));
          order.push('qdrant-write:done');
        },
      },
      {
        name: 'contradiction-detect',
        dependsOn: ['qdrant-write'],
        async run() {
          order.push('contradiction-detect:start');
        },
      },
    ];
    await runStoreSideEffects(effects, fakeCtx);
    // The dependent must START only after the dependency is DONE.
    expect(order).toEqual(['qdrant-write:done', 'contradiction-detect:start']);
  });

  // Dependency ordering must hold even when the dependency is declared LATER
  // in the array than the dependent (order-independent registration).
  it('resolves a dependency declared after the dependent', async () => {
    const order: string[] = [];
    const effects: StoreSideEffect[] = [
      {
        name: 'dependent',
        dependsOn: ['producer'],
        async run() {
          order.push('dependent:start');
        },
      },
      {
        name: 'producer',
        async run() {
          await new Promise((r) => setTimeout(r, 30));
          order.push('producer:done');
        },
      },
    ];
    await runStoreSideEffects(effects, fakeCtx);
    expect(order).toEqual(['producer:done', 'dependent:start']);
  });

  // A dependent still runs even if its dependency FAILS (settle = ok/failed),
  // so a Qdrant-write failure does not silently skip contradiction detection.
  it('runs a dependent after a failed dependency settles', async () => {
    const order: string[] = [];
    const effects: StoreSideEffect[] = [
      {
        name: 'producer',
        async run() {
          await new Promise((r) => setTimeout(r, 20));
          order.push('producer:failed');
          throw new Error('boom');
        },
      },
      {
        name: 'dependent',
        dependsOn: ['producer'],
        async run() {
          order.push('dependent:ran');
        },
      },
    ];
    const results = await runStoreSideEffects(effects, fakeCtx);
    expect(order).toEqual(['producer:failed', 'dependent:ran']);
    expect(results.get('producer')!.status).toBe('failed');
    expect(results.get('dependent')!.status).toBe('ok');
  });

  // Production wiring: the real registry must declare the qdrant-write →
  // contradiction-detect edge so detection never reads an unindexed vector.
  it('wires contradiction-detect to depend on qdrant-write in the default registry', () => {
    const detect = STORE_SIDE_EFFECTS.find((e) => e.name === 'contradiction-detect');
    expect(detect).toBeDefined();
    expect(detect!.dependsOn).toContain('qdrant-write');
  });

  // An unknown dependency name must not deadlock the bus.
  it('does not deadlock on an unknown dependency name', async () => {
    const effects: StoreSideEffect[] = [
      {
        name: 'lonely',
        dependsOn: ['does-not-exist'],
        async run() {
          return 'ok';
        },
      },
    ];
    const results = await runStoreSideEffects(effects, fakeCtx);
    expect(results.get('lonely')!.status).toBe('ok');
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

// ---------------------------------------------------------------------------
// 036/US1 — qdrant-write adapter threads caller-supplied status into the
// Qdrant payload (issue #90). Tests assert the WRITTEN extras, not the read
// result, so the read-path `'active'` fallback cannot mask a regression.
// ---------------------------------------------------------------------------

describe('qdrant-write adapter — status threading (#90)', () => {
  const qdrantWriteEffect = STORE_SIDE_EFFECTS.find((e) => e.name === 'qdrant-write')!;

  beforeEach(() => {
    upsertDecisionSpy.mockClear();
  });

  function ctxWith(status: string | undefined): StoreSideEffectContext {
    return {
      decision: { id: 'dec-1' },
      raw: { text: 'use postgres', project_id: 'proj-1' },
      args: { text: 'use postgres' },
      extras: status === undefined ? {} : { status },
      config: { org_id: 'org-1', author_name: 'olena' },
      qdrant: () => ({}) as never,
    } as unknown as StoreSideEffectContext;
  }

  it('passes status: proposed into upsertDecision extras when ctx.extras.status is proposed', async () => {
    await qdrantWriteEffect.run(ctxWith('proposed'));
    expect(upsertDecisionSpy).toHaveBeenCalledTimes(1);
    const extras = upsertDecisionSpy.mock.calls[0][5];
    expect(extras).toMatchObject({ status: 'proposed' });
  });

  it('passes status: active into upsertDecision extras when ctx.extras.status is active', async () => {
    // `buildExtras` always sets a concrete status ('proposed' | 'active') — the
    // previous "unset" case tested a state production never produces. The real
    // reachable second case is an explicit 'active' decision; assert it threads
    // through to the Qdrant payload verbatim so the read-path 'active' fallback
    // cannot mask a regression where 'active' was dropped.
    await qdrantWriteEffect.run(ctxWith('active'));
    expect(upsertDecisionSpy).toHaveBeenCalledTimes(1);
    const extras = upsertDecisionSpy.mock.calls[0][5];
    expect(extras).toMatchObject({ status: 'active' });
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
