/**
 * Tests for `runReindexCutover` (026/Track 3a — Reindex toolkit).
 *
 * Pure-function tests with injected mock ports. Coverage targets the spec's
 * P1 stories + acceptance criteria:
 *   - US1: dry-run end-to-end produces a 5-phase ReindexReport with all
 *          phases marked `simulated`, no port mutations, no real waits
 *   - US2: mid-phase crash + resume — phases 1+2 emit `resumed_skip`,
 *          phase 3 resumes from checkpoint cursor
 *   - US3: spot-check failure blocks flip — Vercel set call counter is 0
 *   - Edge: source === target rejected at entry
 *   - Edge: checkpoint mismatch rejected
 *   - Edge: completed checkpoint short-circuits with `already_complete`
 *   - FR-013: audit failures are non-blocking
 */

import { describe, it, expect } from 'vitest';
import {
  runReindexCutover,
  type CheckpointState,
  type PhaseStatus,
  type SpotCheckResult,
  type VercelEnvClient,
  type ReindexExecutor,
  type SpotChecker,
  type CheckpointStore,
  type AuditEmitter,
} from '../../src/cloud/reindex-orchestrator.js';

interface MockPorts {
  vercel: VercelEnvClient & { calls: Array<{ name: string; value: string }> };
  reindex: ReindexExecutor & {
    callCount: () => number;
    fromCursor: () => number;
  };
  spotCheck: SpotChecker;
  checkpoint: CheckpointStore & {
    saved: () => CheckpointState | null;
    setLoad: (state: CheckpointState | null) => void;
  };
  audit: AuditEmitter & { calls: Array<{ phase: string; status: string }> };
}

interface SpotCheckOverride {
  passed?: boolean;
  inconclusive?: boolean;
  baseline?: number;
  target?: number;
}

function makePorts(overrides: {
  spotCheckResult?: SpotCheckOverride;
  reindexThrows?: Error;
  vercelThrows?: Error;
  auditThrows?: Error;
  reindexBatches?: number; // how many onBatchComplete callbacks to fire
} = {}): MockPorts {
  const vercelCalls: Array<{ name: string; value: string }> = [];
  let reindexCallCount = 0;
  let reindexFromCursor = 0;
  let savedState: CheckpointState | null = null;
  let loadState: CheckpointState | null = null;
  const auditCalls: Array<{ phase: string; status: string }> = [];

  const spot = overrides.spotCheckResult ?? {};
  const spotCheckResult: SpotCheckResult = {
    baseline_r_at_5: spot.baseline ?? 0.8,
    target_r_at_5: spot.target ?? 0.82,
    ratio: (spot.target ?? 0.82) / (spot.baseline ?? 0.8),
    threshold: 0.95,
    sample_size: 50,
    passed: spot.passed ?? !((spot.target ?? 0.82) / (spot.baseline ?? 0.8) < 0.95),
    inconclusive: spot.inconclusive ?? false,
    sample_decision_ids: ['d1', 'd2'],
  };

  return {
    vercel: {
      calls: vercelCalls,
      setEnvVar: async (name, value) => {
        if (overrides.vercelThrows) throw overrides.vercelThrows;
        vercelCalls.push({ name, value });
        return { deployment_id: `dep-${vercelCalls.length}` };
      },
    },
    reindex: {
      callCount: () => reindexCallCount,
      fromCursor: () => reindexFromCursor,
      run: async ({ fromBatchCursor, onBatchComplete }) => {
        reindexCallCount += 1;
        reindexFromCursor = fromBatchCursor;
        if (overrides.reindexThrows) throw overrides.reindexThrows;
        const batches = overrides.reindexBatches ?? 0;
        for (let i = 1; i <= batches; i++) {
          await onBatchComplete(fromBatchCursor + i * 100);
        }
        return { total_points: 500, final_cursor: 500 };
      },
    },
    spotCheck: {
      measure: async () => spotCheckResult,
    },
    checkpoint: {
      saved: () => savedState,
      setLoad: (state) => {
        loadState = state;
      },
      load: async () => loadState,
      save: async (_, state) => {
        savedState = state;
      },
    },
    audit: {
      calls: auditCalls,
      emit: async (event) => {
        if (overrides.auditThrows) throw overrides.auditThrows;
        auditCalls.push({ phase: event.phase, status: event.status });
      },
    },
  };
}

describe('runReindexCutover — entry validation', () => {
  it('refuses source === target', async () => {
    const ports = makePorts();
    await expect(
      runReindexCutover({ source: 'v1', target: 'v1', ports }),
    ).rejects.toThrow(/identical/);
  });
});

describe('runReindexCutover — dry-run (US1)', () => {
  it('produces a 5-phase report all marked simulated, no real port calls', async () => {
    const ports = makePorts();
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      dryRun: true,
      ports,
    });

    expect(report.dry_run).toBe(true);
    expect(report.phases).toHaveLength(5);
    expect(report.phases.every((p) => p.status === 'simulated')).toBe(true);
    expect(ports.vercel.calls).toEqual([]); // no real Vercel calls
    expect(ports.reindex.callCount()).toBe(0); // no real reindex
    // FR-004: dry-run wait is 0 ms
    const wait = report.phases.find((p) => p.name === 'wait_buffer')!;
    expect((wait.summary as { waited_ms: number }).waited_ms).toBe(0);
  });

  it('does NOT persist checkpoint in dry-run mode', async () => {
    const ports = makePorts();
    await runReindexCutover({
      source: 'v1',
      target: 'v2',
      dryRun: true,
      checkpointPath: '/tmp/never-written.json',
      ports,
    });
    expect(ports.checkpoint.saved()).toBeNull();
  });
});

describe('runReindexCutover — happy path (US3 inverse)', () => {
  it('runs all 5 phases and flips when spot-check passes', async () => {
    const ports = makePorts({
      spotCheckResult: { passed: true, baseline: 0.8, target: 0.82 },
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      ports,
    });

    expect(report.flipped).toBe(true);
    expect(report.phases.map((p) => p.name)).toEqual([
      'enable_dual_write',
      'wait_buffer',
      'reindex',
      'spot_check',
      'flip_active_version',
    ]);
    expect(report.phases.every((p) => p.status === 'ok')).toBe(true);
    // Vercel got two env mutations: dual_write + active_version
    expect(ports.vercel.calls.map((c) => c.name)).toEqual([
      'EMBEDDING_DUAL_WRITE',
      'EMBEDDING_ACTIVE_VERSION',
    ]);
    expect(ports.vercel.calls[1].value).toBe('v2');
  });
});

describe('runReindexCutover — spot-check failure blocks flip (US3)', () => {
  it('skips flip phase when spot-check ratio < threshold', async () => {
    // 12.5% regression → ratio = 0.875 < 0.95 → fail.
    const ports = makePorts({
      spotCheckResult: { baseline: 0.8, target: 0.7 },
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      ports,
    });

    expect(report.flipped).toBe(false);
    expect(report.failure_reason).toBe('spot_check_recall_regression');
    const phase5 = report.phases.find((p) => p.name === 'flip_active_version');
    expect(phase5?.status).toBe('skipped');
    expect(phase5?.reason).toBe('phase_4_failed');
    // SC-003 — Vercel `set EMBEDDING_ACTIVE_VERSION` counter is 0.
    const activeVersionCalls = ports.vercel.calls.filter(
      (c) => c.name === 'EMBEDDING_ACTIVE_VERSION',
    );
    expect(activeVersionCalls).toEqual([]);
  });

  it('allows flip with --skip-spot-check + records safety_overridden', async () => {
    const ports = makePorts({
      spotCheckResult: { baseline: 0.8, target: 0.5 }, // massive regression
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      skipSpotCheck: true,
      ports,
    });

    expect(report.flipped).toBe(true);
    expect(report.safety_overridden).toBe(true);
    // Vercel still got the second call
    expect(
      ports.vercel.calls.filter((c) => c.name === 'EMBEDDING_ACTIVE_VERSION'),
    ).toHaveLength(1);
  });

  it('marks inconclusive when sample is too sparse', async () => {
    const ports = makePorts({
      spotCheckResult: { inconclusive: true, baseline: 0.8, target: 0.8 },
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      ports,
    });

    expect(report.flipped).toBe(false);
    const phase4 = report.phases.find((p) => p.name === 'spot_check')!;
    expect(phase4.status).toBe('inconclusive');
    // Inconclusive without --skip-spot-check ALSO blocks flip
    const phase5 = report.phases.find((p) => p.name === 'flip_active_version');
    expect(phase5?.status).toBe('skipped');
  });
});

describe('runReindexCutover — checkpoint resume (US2)', () => {
  it('replays completed phases as resumed_skip', async () => {
    const ports = makePorts({
      spotCheckResult: { passed: true, baseline: 0.8, target: 0.82 },
    });
    const completedPhase1: PhaseStatus = {
      name: 'enable_dual_write',
      status: 'ok',
      started_at: '2026-05-15T00:00:00Z',
      finished_at: '2026-05-15T00:00:01Z',
      duration_ms: 1000,
      summary: { deployment_id: 'dep-prior' },
    };
    const completedPhase2: PhaseStatus = {
      name: 'wait_buffer',
      status: 'ok',
      started_at: '2026-05-15T00:00:01Z',
      finished_at: '2026-05-15T00:00:02Z',
      duration_ms: 1000,
      summary: { waited_ms: 0 },
    };
    ports.checkpoint.setLoad({
      schema_version: 1,
      runId: 'r-prior',
      source: 'v1',
      target: 'v2',
      baseline: null,
      phases: [completedPhase1, completedPhase2],
      lock: { pid: 1, host: 'h', started_at: '2026-05-15T00:00:00Z' },
      flip_timestamp: null,
    });

    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      checkpointPath: '/tmp/cp.json',
      ports,
    });

    const phase1 = report.phases.find((p) => p.name === 'enable_dual_write')!;
    const phase2 = report.phases.find((p) => p.name === 'wait_buffer')!;
    expect(phase1.status).toBe('resumed_skip');
    expect(phase2.status).toBe('resumed_skip');
    // Vercel only called for the flip — phase 1 (dual_write) was skipped.
    expect(ports.vercel.calls.map((c) => c.name)).toEqual([
      'EMBEDDING_ACTIVE_VERSION',
    ]);
  });

  it('refuses to proceed when checkpoint source/target mismatches invocation', async () => {
    const ports = makePorts();
    ports.checkpoint.setLoad({
      schema_version: 1,
      runId: 'r-1',
      source: 'v1',
      target: 'v2',
      baseline: null,
      phases: [],
      lock: { pid: 1, host: 'h', started_at: '2026-05-15T00:00:00Z' },
      flip_timestamp: null,
    });

    await expect(
      runReindexCutover({
        source: 'v2',
        target: 'v1', // inverted
        bufferMs: 0,
        checkpointPath: '/tmp/cp.json',
        ports,
      }),
    ).rejects.toThrow(/mismatch/i);
  });

  it('short-circuits with already_complete when flip already happened', async () => {
    const ports = makePorts();
    ports.checkpoint.setLoad({
      schema_version: 1,
      runId: 'r-done',
      source: 'v1',
      target: 'v2',
      baseline: { r_at_5: 0.8, sample_size: 50 },
      phases: [
        {
          name: 'flip_active_version',
          status: 'ok',
          started_at: '2026-05-15T00:00:00Z',
          finished_at: '2026-05-15T00:00:01Z',
          duration_ms: 1000,
          summary: { target: 'v2' },
        },
      ],
      lock: { pid: 1, host: 'h', started_at: '2026-05-15T00:00:00Z' },
      flip_timestamp: '2026-05-15T00:00:01Z',
    });

    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      checkpointPath: '/tmp/cp.json',
      ports,
    });

    expect(report.already_complete).toBe(true);
    expect(report.flipped).toBe(true);
    // No new Vercel or reindex calls — fully resumed.
    expect(ports.vercel.calls).toEqual([]);
    expect(ports.reindex.callCount()).toBe(0);
  });
});

describe('runReindexCutover — non-blocking audit (FR-013)', () => {
  it('completes the cutover even when every audit emit throws', async () => {
    const ports = makePorts({
      spotCheckResult: { passed: true },
      auditThrows: new Error('audit table locked'),
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      ports,
    });
    expect(report.flipped).toBe(true);
  });
});

describe('runReindexCutover — Vercel failure surfaces as phase failure', () => {
  it('marks phase 1 as failed when Vercel API throws and halts the run', async () => {
    const ports = makePorts({
      vercelThrows: new Error('Vercel 503'),
    });
    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      ports,
    });

    expect(report.flipped).toBe(false);
    const phase1 = report.phases.find((p) => p.name === 'enable_dual_write')!;
    expect(phase1.status).toBe('failed');
    expect(phase1.reason).toMatch(/Vercel 503/);
    // Downstream phases were never executed
    expect(ports.reindex.callCount()).toBe(0);
  });
});

describe('runReindexCutover — checkpoint write on phase boundary (FR-010)', () => {
  it('persists checkpoint after each phase that completes', async () => {
    const ports = makePorts({
      spotCheckResult: { passed: true },
    });
    await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      checkpointPath: '/tmp/cp.json',
      ports,
    });

    const saved = ports.checkpoint.saved();
    expect(saved).not.toBeNull();
    expect(saved!.phases.map((p) => p.name)).toContain('flip_active_version');
    expect(saved!.flip_timestamp).not.toBeNull();
  });
});

describe('runReindexCutover — reindex batch cursor (US2 / FR-005)', () => {
  it('resumes reindex from the cursor recorded in the checkpoint', async () => {
    const ports = makePorts({
      spotCheckResult: { passed: true },
      reindexBatches: 3, // 100, 200, 300 cursors
    });
    // Prior checkpoint records phases 1+2 done and phase 3 partially at cursor 200.
    ports.checkpoint.setLoad({
      schema_version: 1,
      runId: 'r-resume',
      source: 'v1',
      target: 'v2',
      baseline: null,
      phases: [
        {
          name: 'enable_dual_write',
          status: 'ok',
          started_at: '2026-05-15T00:00:00Z',
          finished_at: '2026-05-15T00:00:01Z',
          duration_ms: 1000,
          summary: { deployment_id: 'dep-prior' },
        },
        {
          name: 'wait_buffer',
          status: 'ok',
          started_at: '2026-05-15T00:00:01Z',
          finished_at: '2026-05-15T00:00:02Z',
          duration_ms: 1000,
          summary: { waited_ms: 0 },
        },
        {
          name: 'reindex',
          status: 'failed', // partial mid-phase
          started_at: '2026-05-15T00:00:02Z',
          finished_at: '2026-05-15T00:00:03Z',
          duration_ms: 1000,
          summary: { cursor: 200 },
          reason: 'in_progress',
        },
      ],
      lock: { pid: 1, host: 'h', started_at: '2026-05-15T00:00:00Z' },
      flip_timestamp: null,
    });

    const report = await runReindexCutover({
      source: 'v1',
      target: 'v2',
      bufferMs: 0,
      checkpointPath: '/tmp/cp.json',
      ports,
    });

    expect(report.flipped).toBe(true);
    expect(ports.reindex.fromCursor()).toBe(200); // resumed from 200, not 0
    const phase3 = report.phases.find((p) => p.name === 'reindex')!;
    expect((phase3.summary as { resumed_from: number }).resumed_from).toBe(200);
  });
});
