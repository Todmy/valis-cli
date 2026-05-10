/**
 * Orchestration tests for runSynthesis.
 *
 * Exercises end-to-end behaviour through the SynthesisStore port using an
 * in-memory adapter — covers decisions the runner makes (idempotency,
 * dry-run gating, stale-pattern deprecation, audit emission, per-candidate
 * error isolation) that pure-helper unit tests previously couldn't reach.
 */

import { describe, it, expect } from 'vitest';
import { runSynthesis } from '../../src/synthesis/runner.js';
import {
  createInMemorySynthesisStore,
  type InMemorySynthesisStore,
} from '../../src/synthesis/store.js';
import type { ClusterDecision } from '../../src/synthesis/patterns.js';

const ORG = 'org-1';

function makeDecision(id: string, affects: string[], daysAgo = 0): ClusterDecision {
  const created = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    id,
    affects,
    summary: `Decision ${id}`,
    type: 'decision',
    created_at: created,
  };
}

function makeCluster(prefix: string, n: number, affects: string[]): ClusterDecision[] {
  return Array.from({ length: n }, (_, i) => makeDecision(`${prefix}-${i + 1}`, affects));
}

describe('runSynthesis — orchestration', () => {
  it('detects a single auth cluster and creates one pattern', async () => {
    const store = createInMemorySynthesisStore({
      decisions: makeCluster('auth', 5, ['auth']),
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.candidates_detected).toBe(1);
    expect(report.patterns_created).toBe(1);
    expect(store.created.length).toBe(1);
    expect(store.created[0].affects).toEqual(['auth']);
    expect(store.created[0].dependsOn).toHaveLength(5);
  });

  it('dry-run records candidates but never writes', async () => {
    const store = createInMemorySynthesisStore({
      decisions: makeCluster('auth', 5, ['auth']),
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: true,
    });

    expect(report.mode).toBe('dry_run');
    expect(report.candidates_detected).toBe(1);
    expect(report.patterns_created).toBe(0);
    expect(store.created).toHaveLength(0);
    expect(store.statusChanges).toHaveLength(0);
    expect(store.auditEntries).toHaveLength(0);
  });

  it('skips candidates whose pattern already exists (Jaccard >0.8)', async () => {
    const decisions = makeCluster('auth', 5, ['auth']);
    const store = createInMemorySynthesisStore({
      decisions,
      // Existing pattern covers 5/5 of the decision ids — Jaccard = 1.0
      existingPatterns: [
        {
          id: 'existing-pat-1',
          depends_on: decisions.map((d) => d.id),
          affects: ['auth'],
        },
      ],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.candidates_detected).toBe(1);
    expect(report.patterns_created).toBe(0);
    expect(report.patterns_skipped_idempotent).toBe(1);
    expect(report.candidates[0].already_exists).toBe(true);
    expect(store.created).toHaveLength(0);
  });

  it('does not skip when existing pattern has only minor overlap (Jaccard ≤0.8)', async () => {
    const decisions = makeCluster('auth', 5, ['auth']);
    const store = createInMemorySynthesisStore({
      decisions,
      // Existing pattern overlaps 3/7 — Jaccard ≈0.43, well below threshold
      existingPatterns: [
        {
          id: 'existing-pat-1',
          depends_on: ['auth-1', 'auth-2', 'auth-3', 'unrelated-x', 'unrelated-y', 'unrelated-z', 'unrelated-w'],
          affects: ['auth'],
        },
      ],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.patterns_skipped_idempotent).toBe(0);
    expect(report.patterns_created).toBe(1);
  });

  it('emits a pattern_synthesized audit entry per created pattern', async () => {
    const store = createInMemorySynthesisStore({
      decisions: makeCluster('billing', 4, ['billing']),
    });

    await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
      memberId: 'member-7',
    });

    expect(store.auditEntries).toHaveLength(1);
    const audit = store.auditEntries[0];
    expect(audit.action).toBe('pattern_synthesized');
    expect(audit.target_type).toBe('decision');
    expect(audit.member_id).toBe('member-7');
    expect(audit.org_id).toBe(ORG);
    const newState = audit.new_state as { areas: string[]; source_count: number };
    expect(newState.areas).toEqual(['billing']);
    expect(newState.source_count).toBe(4);
  });

  it('audit entry uses "system" memberId when none provided', async () => {
    const store = createInMemorySynthesisStore({
      decisions: makeCluster('auth', 4, ['auth']),
    });

    await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(store.auditEntries[0].member_id).toBe('system');
  });

  it('deprecates patterns whose source decisions are all deprecated', async () => {
    // The runner short-circuits when fetchActiveDecisions returns empty
    // (BACKLOG: stale-deprecation is gated behind ≥1 decision in window).
    // Seed one unrelated decision so step 4 actually runs.
    const store = createInMemorySynthesisStore({
      decisions: [makeDecision('keep-runner-alive', ['nothing-clusterable'])],
      existingPatterns: [
        {
          id: 'pat-stale',
          depends_on: ['old-1', 'old-2', 'old-3'],
          affects: ['legacy'],
        },
      ],
      decisionStatuses: [
        { id: 'old-1', status: 'deprecated' },
        { id: 'old-2', status: 'deprecated' },
        { id: 'old-3', status: 'superseded' },
      ],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.stale_patterns_deprecated).toBe(1);
    expect(store.statusChanges).toEqual([
      { patternId: 'pat-stale', newStatus: 'deprecated', reason: 'All source decisions deprecated' },
    ]);
  });

  it('does NOT deprecate patterns when at least one source is still active', async () => {
    const store = createInMemorySynthesisStore({
      decisions: [makeDecision('keep-runner-alive', ['nothing-clusterable'])],
      existingPatterns: [
        {
          id: 'pat-mixed',
          depends_on: ['old-1', 'old-2', 'still-fresh'],
          affects: ['legacy'],
        },
      ],
      decisionStatuses: [
        { id: 'old-1', status: 'deprecated' },
        { id: 'old-2', status: 'deprecated' },
        { id: 'still-fresh', status: 'active' },
      ],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.stale_patterns_deprecated).toBe(0);
    expect(store.statusChanges).toHaveLength(0);
  });

  it('dry-run skips stale-pattern deprecation', async () => {
    const store = createInMemorySynthesisStore({
      decisions: [makeDecision('keep-runner-alive', ['nothing-clusterable'])],
      existingPatterns: [
        { id: 'pat-stale', depends_on: ['old-1'], affects: ['legacy'] },
      ],
      decisionStatuses: [{ id: 'old-1', status: 'deprecated' }],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: true,
    });

    expect(report.stale_patterns_deprecated).toBe(0);
    expect(store.statusChanges).toHaveLength(0);
  });

  it('returns empty report when no decisions in window', async () => {
    const store = createInMemorySynthesisStore({ decisions: [] });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.candidates_detected).toBe(0);
    expect(report.patterns_created).toBe(0);
    expect(report.stale_patterns_deprecated).toBe(0);
    expect(store.created).toHaveLength(0);
  });

  it('regression: empty decisions in window short-circuits stale-pattern deprecation (BACKLOG)', async () => {
    // Documents the existing early-return behaviour in runner.ts: when no
    // decisions exist in the time window, the stale-pattern deprecation
    // pass at step 4 never runs. This means a quiet team week prevents
    // cleanup of patterns whose sources were deprecated long ago. Behaviour
    // captured here so a future fix removing the early-return is a visible,
    // intentional change.
    const store = createInMemorySynthesisStore({
      decisions: [],
      existingPatterns: [
        { id: 'pat-stale', depends_on: ['old-1'], affects: ['legacy'] },
      ],
      decisionStatuses: [{ id: 'old-1', status: 'deprecated' }],
    });

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.stale_patterns_deprecated).toBe(0); // would-be stale, unhealed
    expect(store.statusChanges).toHaveLength(0);
  });

  it('per-candidate failure does not abort the whole run', async () => {
    const decisionsA = makeCluster('a', 3, ['areaA']);
    const decisionsB = makeCluster('b', 3, ['areaB']);
    const store = createInMemorySynthesisStore({
      decisions: [...decisionsA, ...decisionsB],
    }) as InMemorySynthesisStore;

    // Wrap createPattern to fail on areaA candidates only
    const originalCreate = store.createPattern;
    let callIdx = 0;
    store.createPattern = async (...args) => {
      callIdx++;
      if (callIdx === 1) throw new Error('simulated DB outage');
      return originalCreate.call(store, ...args);
    };

    const report = await runSynthesis(store, {
      orgId: ORG,
      windowDays: 30,
      minCluster: 3,
      dryRun: false,
    });

    expect(report.errors).toHaveLength(1);
    expect(report.patterns_created).toBe(1); // the second cluster still created
  });
});
