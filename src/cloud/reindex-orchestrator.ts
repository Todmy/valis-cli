/**
 * 026/Track 3a — Reindex toolkit: ReindexOrchestrator.
 *
 * Drives the 5-phase embedding-model cutover playbook:
 *   1. `enable_dual_write`    — set `EMBEDDING_DUAL_WRITE=1` on Vercel
 *   2. `wait_buffer`          — 24h default so in-flight writers flush
 *   3. `reindex`              — re-embed every source-version point into target
 *   4. `spot_check`           — sample R@5 and compare to baseline
 *   5. `flip_active_version`  — set `EMBEDDING_ACTIVE_VERSION` to target
 *
 * Optional phase 6 `drop_source` is invoked by a separate CLI run with
 * `--drop-source` (not orchestrated here in the same call — long-running
 * babysitting is not what the toolkit promises).
 *
 * Deep module with injectable ports — Vercel client, Qdrant reindexer,
 * spot-checker, checkpoint store, audit emitter — so unit tests run
 * deterministically without touching production. Production wiring is the
 * sibling HITL issue (#30) and supplies real implementations of each port.
 *
 * Non-blocking guarantee (Constitution III): audit-log writes and metric
 * emits fail open. The orchestrator's overall outcome (`flipped` true/false)
 * is deliberately blocking — the spot-check is the gate that prevents bad
 * cutovers, and that gate must hold.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type EmbeddingVersion = 'v1' | 'v2';

export type PhaseName =
  | 'enable_dual_write'
  | 'wait_buffer'
  | 'reindex'
  | 'spot_check'
  | 'flip_active_version'
  | 'drop_source';

export type PhaseStatusValue =
  | 'ok'
  | 'failed'
  | 'skipped'
  | 'simulated'
  | 'resumed_skip'
  | 'noop'
  | 'inconclusive';

export interface PhaseStatus {
  name: PhaseName;
  status: PhaseStatusValue;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  summary: Record<string, unknown>;
  reason?: string;
}

export interface SpotCheckResult {
  baseline_r_at_5: number;
  target_r_at_5: number;
  ratio: number;
  threshold: number;
  sample_size: number;
  passed: boolean;
  inconclusive: boolean;
  sample_decision_ids: string[];
}

export interface CheckpointState {
  schema_version: 1;
  runId: string;
  source: EmbeddingVersion;
  target: EmbeddingVersion;
  baseline: { r_at_5: number; sample_size: number } | null;
  phases: PhaseStatus[];
  lock: { pid: number; host: string; started_at: string };
  flip_timestamp: string | null;
}

export interface ReindexReport {
  runId: string;
  source: EmbeddingVersion;
  target: EmbeddingVersion;
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  flipped: boolean;
  safety_overridden: boolean;
  already_complete: boolean;
  failure_reason: string | null;
  phases: PhaseStatus[];
  baseline: { r_at_5: number; sample_size: number } | null;
}

// ---------------------------------------------------------------------------
// Ports — inject in tests, override in production
// ---------------------------------------------------------------------------

export interface VercelEnvClient {
  setEnvVar(name: string, value: string): Promise<{ deployment_id: string }>;
}

export interface ReindexExecutor {
  /**
   * Re-embed `source` → `target`. Resumable: `fromBatchCursor` is the
   * offset to resume at. Implementations MUST advance the cursor inside
   * `onBatchComplete` so the orchestrator can persist progress.
   */
  run(opts: {
    source: EmbeddingVersion;
    target: EmbeddingVersion;
    fromBatchCursor: number;
    onBatchComplete: (cursor: number) => Promise<void>;
  }): Promise<{ total_points: number; final_cursor: number }>;
}

export interface SpotChecker {
  measure(opts: {
    source: EmbeddingVersion;
    target: EmbeddingVersion;
    sampleSize: number;
  }): Promise<SpotCheckResult>;
}

export interface CheckpointStore {
  load(path: string): Promise<CheckpointState | null>;
  save(path: string, state: CheckpointState): Promise<void>;
}

export interface AuditEmitter {
  emit(event: { phase: PhaseName; status: PhaseStatusValue; runId: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options + entry point
// ---------------------------------------------------------------------------

export interface RunReindexCutoverOptions {
  source: EmbeddingVersion;
  target: EmbeddingVersion;
  dryRun?: boolean;
  skipSpotCheck?: boolean;
  checkpointPath?: string;
  bufferMs?: number;
  spotCheckSampleSize?: number;
  spotCheckRatio?: number;
  ports: {
    vercel: VercelEnvClient;
    reindex: ReindexExecutor;
    spotCheck: SpotChecker;
    checkpoint: CheckpointStore;
    audit: AuditEmitter;
  };
}

const DEFAULT_BUFFER_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_SPOT_CHECK_SAMPLE_SIZE = 50;
const DEFAULT_SPOT_CHECK_RATIO = 0.95;

/**
 * Drive a full cutover from `source` to `target`. Returns a structured
 * `ReindexReport` on every code path — including refused cutovers, dry
 * runs, and resumed runs that hit an already-complete checkpoint.
 *
 * Idempotent on the read side: re-invoking with the same checkpoint after
 * a completed flip emits a report with `already_complete: true` and never
 * touches Vercel or Qdrant.
 */
export async function runReindexCutover(
  opts: RunReindexCutoverOptions,
): Promise<ReindexReport> {
  if (opts.source === opts.target) {
    throw new Error(
      `runReindexCutover: source and target are identical (${opts.source}). Refusing.`,
    );
  }

  const dryRun = opts.dryRun === true;
  const bufferMs = opts.bufferMs ?? (dryRun ? 0 : DEFAULT_BUFFER_MS);
  const sampleSize = opts.spotCheckSampleSize ?? DEFAULT_SPOT_CHECK_SAMPLE_SIZE;
  const threshold = opts.spotCheckRatio ?? DEFAULT_SPOT_CHECK_RATIO;
  const started = new Date().toISOString();

  // Load checkpoint when supplied. Dry-run mode does NOT consume the
  // checkpoint — a dry-run is a fresh rehearsal every time.
  let state: CheckpointState | null = null;
  if (opts.checkpointPath && !dryRun) {
    state = await opts.ports.checkpoint.load(opts.checkpointPath);
    if (state && (state.source !== opts.source || state.target !== opts.target)) {
      throw new Error(
        `checkpoint mismatch: refusing to overwrite (checkpoint source=${state.source}/target=${state.target}, invocation source=${opts.source}/target=${opts.target})`,
      );
    }
  }

  // Early-exit: a completed checkpoint means we're done.
  if (state && phaseStatus(state.phases, 'flip_active_version') === 'ok') {
    return {
      runId: state.runId,
      source: state.source,
      target: state.target,
      started_at: started,
      finished_at: new Date().toISOString(),
      dry_run: false,
      flipped: true,
      safety_overridden: false,
      already_complete: true,
      failure_reason: null,
      phases: state.phases,
      baseline: state.baseline,
    };
  }

  const runId = state?.runId ?? randomUUID();
  const phases: PhaseStatus[] = state?.phases ? [...state.phases] : [];

  // Helper: emit audit event best-effort (Constitution III).
  const safeAudit = async (phase: PhaseName, status: PhaseStatusValue): Promise<void> => {
    try {
      await opts.ports.audit.emit({ phase, status, runId });
    } catch {
      /* observability gap */
    }
  };

  // Helper: persist checkpoint after each phase boundary (atomic write
  // is the store's responsibility).
  const persistCheckpoint = async (): Promise<void> => {
    if (!opts.checkpointPath || dryRun) return;
    const next: CheckpointState = {
      schema_version: 1,
      runId,
      source: opts.source,
      target: opts.target,
      baseline: state?.baseline ?? null,
      phases,
      lock: { pid: process.pid, host: 'localhost', started_at: started },
      flip_timestamp: phaseStatus(phases, 'flip_active_version') === 'ok'
        ? phases.find((p) => p.name === 'flip_active_version')?.finished_at ?? null
        : null,
    };
    await opts.ports.checkpoint.save(opts.checkpointPath, next);
  };

  // Helper: run a phase if not already 'ok' in checkpoint.
  const runPhase = async (
    name: PhaseName,
    run: () => Promise<PhaseStatus>,
  ): Promise<PhaseStatus> => {
    const prior = phases.find((p) => p.name === name);
    if (prior && prior.status === 'ok') {
      const resumed: PhaseStatus = { ...prior, status: 'resumed_skip' };
      // Replace in the array.
      const idx = phases.indexOf(prior);
      phases.splice(idx, 1, resumed);
      await safeAudit(name, 'resumed_skip');
      return resumed;
    }
    const phaseStart = Date.now();
    const phaseStartIso = new Date().toISOString();
    let result: PhaseStatus;
    try {
      result = await run();
    } catch (err) {
      result = {
        name,
        status: 'failed',
        started_at: phaseStartIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - phaseStart,
        summary: {},
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // Replace or append in the phases array.
    const idx = phases.findIndex((p) => p.name === name);
    if (idx >= 0) phases.splice(idx, 1, result);
    else phases.push(result);
    await safeAudit(name, result.status);
    await persistCheckpoint();
    return result;
  };

  // ── Phase 1: enable dual-write ───────────────────────────────────────
  const p1 = await runPhase('enable_dual_write', async () => {
    const startIso = new Date().toISOString();
    const startMs = Date.now();
    if (dryRun) {
      return {
        name: 'enable_dual_write',
        status: 'simulated',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { would_set: { EMBEDDING_DUAL_WRITE: '1' }, vercel_token_present: Boolean(process.env.VERCEL_API_TOKEN) },
      };
    }
    const deployment = await opts.ports.vercel.setEnvVar('EMBEDDING_DUAL_WRITE', '1');
    return {
      name: 'enable_dual_write',
      status: 'ok',
      started_at: startIso,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      summary: { deployment_id: deployment.deployment_id },
    };
  });

  if (terminalStatus(p1)) return buildReport({ phases, runId, opts, started, baseline: state?.baseline ?? null, terminatedBy: p1 });

  // ── Phase 2: wait buffer ─────────────────────────────────────────────
  const p2 = await runPhase('wait_buffer', async () => {
    const startIso = new Date().toISOString();
    const startMs = Date.now();
    if (dryRun || bufferMs === 0) {
      return {
        name: 'wait_buffer',
        status: dryRun ? 'simulated' : 'ok',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { waited_ms: 0, configured_ms: bufferMs },
      };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, bufferMs));
    return {
      name: 'wait_buffer',
      status: 'ok',
      started_at: startIso,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      summary: { waited_ms: bufferMs, configured_ms: bufferMs },
    };
  });

  if (terminalStatus(p2)) return buildReport({ phases, runId, opts, started, baseline: state?.baseline ?? null, terminatedBy: p2 });

  // ── Phase 3: reindex ─────────────────────────────────────────────────
  const p3 = await runPhase('reindex', async () => {
    const startIso = new Date().toISOString();
    const startMs = Date.now();
    const priorCursor = (phases.find((p) => p.name === 'reindex')?.summary?.cursor as number | undefined) ?? 0;
    if (dryRun) {
      return {
        name: 'reindex',
        status: 'simulated',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { from_cursor: priorCursor, would_reindex: 'all source-version points' },
      };
    }
    const result = await opts.ports.reindex.run({
      source: opts.source,
      target: opts.target,
      fromBatchCursor: priorCursor,
      onBatchComplete: async (cursor) => {
        // Mid-phase persist so a crash recovers at the latest batch.
        const partial: PhaseStatus = {
          name: 'reindex',
          status: 'failed', // placeholder until phase completes
          started_at: startIso,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startMs,
          summary: { cursor },
          reason: 'in_progress',
        };
        const idx = phases.findIndex((p) => p.name === 'reindex');
        if (idx >= 0) phases.splice(idx, 1, partial);
        else phases.push(partial);
        await persistCheckpoint();
      },
    });
    return {
      name: 'reindex',
      status: 'ok',
      started_at: startIso,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      summary: {
        cursor: result.final_cursor,
        total_points: result.total_points,
        resumed_from: priorCursor,
      },
    };
  });

  if (terminalStatus(p3)) return buildReport({ phases, runId, opts, started, baseline: state?.baseline ?? null, terminatedBy: p3 });

  // ── Phase 4: spot-check ──────────────────────────────────────────────
  const p4 = await runPhase('spot_check', async () => {
    const startIso = new Date().toISOString();
    const startMs = Date.now();
    if (dryRun) {
      return {
        name: 'spot_check',
        status: 'simulated',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { sampleSize, threshold },
      };
    }
    const spot = await opts.ports.spotCheck.measure({
      source: opts.source,
      target: opts.target,
      sampleSize,
    });
    if (!state?.baseline) {
      // First time through — record baseline for future restarts.
      state = {
        ...(state ?? ({} as CheckpointState)),
        baseline: { r_at_5: spot.baseline_r_at_5, sample_size: spot.sample_size },
        runId,
        source: opts.source,
        target: opts.target,
        phases,
        schema_version: 1,
        lock: { pid: process.pid, host: 'localhost', started_at: started },
        flip_timestamp: null,
      };
    }
    if (spot.inconclusive) {
      return {
        name: 'spot_check',
        status: 'inconclusive',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { ...spot },
        reason: 'too_few_ground_truth_neighbours',
      };
    }
    if (!spot.passed) {
      return {
        name: 'spot_check',
        status: 'failed',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { ...spot },
        reason: 'spot_check_recall_regression',
      };
    }
    return {
      name: 'spot_check',
      status: 'ok',
      started_at: startIso,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      summary: { ...spot },
    };
  });

  // FR-008 — --skip-spot-check still RUNS phase 4 (for the record) but
  // lets phase 5 proceed regardless of the metric. Set safety_overridden.
  const allowFlip =
    p4.status === 'ok' ||
    p4.status === 'simulated' ||
    p4.status === 'resumed_skip' ||
    Boolean(opts.skipSpotCheck);

  // ── Phase 5: flip active version ─────────────────────────────────────
  let p5: PhaseStatus;
  if (!allowFlip) {
    p5 = {
      name: 'flip_active_version',
      status: 'skipped',
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 0,
      summary: {},
      reason: 'phase_4_failed',
    };
    const idx = phases.findIndex((p) => p.name === 'flip_active_version');
    if (idx >= 0) phases.splice(idx, 1, p5);
    else phases.push(p5);
    await safeAudit('flip_active_version', 'skipped');
    await persistCheckpoint();
  } else {
    p5 = await runPhase('flip_active_version', async () => {
      const startIso = new Date().toISOString();
      const startMs = Date.now();
      if (dryRun) {
        return {
          name: 'flip_active_version',
          status: 'simulated',
          started_at: startIso,
          finished_at: new Date().toISOString(),
          duration_ms: Date.now() - startMs,
          summary: { would_set: { EMBEDDING_ACTIVE_VERSION: opts.target } },
        };
      }
      const deployment = await opts.ports.vercel.setEnvVar(
        'EMBEDDING_ACTIVE_VERSION',
        opts.target,
      );
      return {
        name: 'flip_active_version',
        status: 'ok',
        started_at: startIso,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
        summary: { deployment_id: deployment.deployment_id, target: opts.target },
      };
    });
  }

  return buildReport({
    phases,
    runId,
    opts,
    started,
    baseline: state?.baseline ?? null,
    terminatedBy: terminalStatus(p5) ? p5 : null,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function phaseStatus(phases: PhaseStatus[], name: PhaseName): PhaseStatusValue | null {
  return phases.find((p) => p.name === name)?.status ?? null;
}

function terminalStatus(p: PhaseStatus): boolean {
  return p.status === 'failed' || p.status === 'inconclusive';
}

interface BuildReportArgs {
  phases: PhaseStatus[];
  runId: string;
  opts: RunReindexCutoverOptions;
  started: string;
  baseline: { r_at_5: number; sample_size: number } | null;
  terminatedBy: PhaseStatus | null;
}

function buildReport(args: BuildReportArgs): ReindexReport {
  const flipped = phaseStatus(args.phases, 'flip_active_version') === 'ok';
  const simulated = phaseStatus(args.phases, 'flip_active_version') === 'simulated';
  const skippedPhase4 = phaseStatus(args.phases, 'spot_check') === 'skipped';
  const failedPhase = args.phases.find((p) => p.status === 'failed');
  return {
    runId: args.runId,
    source: args.opts.source,
    target: args.opts.target,
    started_at: args.started,
    finished_at: new Date().toISOString(),
    dry_run: Boolean(args.opts.dryRun),
    flipped: flipped || (args.opts.dryRun === true && simulated),
    safety_overridden: Boolean(args.opts.skipSpotCheck && skippedPhase4 === false),
    already_complete: false,
    failure_reason:
      failedPhase?.reason ?? (args.terminatedBy?.reason ?? null),
    phases: args.phases,
    baseline: args.baseline,
  };
}
