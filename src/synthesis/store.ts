/**
 * Synthesis store port — separates the runner's orchestration logic from
 * its DB I/O. Two adapters justify the seam:
 *
 *   - {@link createSupabaseSynthesisStore} wraps Supabase (production).
 *   - {@link createInMemorySynthesisStore} is a Map-backed fake (tests).
 *
 * The runner calls this port instead of touching Supabase directly, so the
 * orchestration (idempotency, dry-run, deprecation cascade, audit) becomes
 * testable end-to-end without a live database.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClusterDecision } from './patterns.js';
import type { AuditEntry, AuditAction } from '../types.js';
import { storeDecision, changeDecisionStatus } from '../cloud/supabase.js';
import { buildAuditPayload, createAuditEntry } from '../auth/audit.js';

/** Audit payload shape used throughout the synthesis port (without server-assigned id/created_at). */
export type AuditPayload = Omit<AuditEntry, 'id' | 'created_at'>;

/** Active synthesis pattern row used by idempotency + stale-deprecation checks. */
export interface SynthesisPatternRow {
  id: string;
  depends_on: string[];
  affects: string[];
}

/** Status row for source decisions referenced by a pattern's depends_on. */
export interface DecisionStatusRow {
  id: string;
  status: string;
}

/** Result of creating a pattern decision. Only the id is needed for audit. */
export interface CreatedPattern {
  id: string;
}

export interface SynthesisStore {
  /** Active decisions in the time window (used as input to detectPatterns). */
  fetchActiveDecisions(orgId: string, windowDays: number): Promise<ClusterDecision[]>;

  /**
   * Existing active synthesis patterns whose `affects` overlaps the candidate's
   * areas. Used by both the per-candidate idempotency check and the global
   * stale-deprecation pass (with `affects: undefined` meaning "all").
   */
  findActiveSynthesisPatterns(orgId: string, affects?: string[]): Promise<SynthesisPatternRow[]>;

  /** Status of decisions by id. Used to detect when all sources are deprecated. */
  getDecisionStatuses(decisionIds: string[]): Promise<DecisionStatusRow[]>;

  /** Create a new pattern decision via the normal store pipeline. */
  createPattern(
    orgId: string,
    summary: string,
    affects: string[],
    confidence: number,
    dependsOn: string[],
  ): Promise<CreatedPattern>;

  /** Change a pattern's status (used to deprecate stale patterns). */
  changePatternStatus(
    orgId: string,
    patternId: string,
    newStatus: 'deprecated',
    reason: string,
  ): Promise<void>;

  /** Record an audit entry. Best-effort — failures should not abort synthesis. */
  recordAuditEntry(payload: AuditPayload): Promise<void>;
}

// ---------------------------------------------------------------------------
// Supabase adapter
// ---------------------------------------------------------------------------

export function createSupabaseSynthesisStore(supabase: SupabaseClient): SynthesisStore {
  return {
    async fetchActiveDecisions(orgId, windowDays) {
      const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
      const { data, error } = await supabase
        .from('decisions')
        .select('id, affects, summary, type, created_at')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .gte('created_at', since);
      if (error) throw new Error(`Failed to fetch decisions: ${error.message}`);
      return (data ?? []) as ClusterDecision[];
    },

    async findActiveSynthesisPatterns(orgId, affects) {
      let query = supabase
        .from('decisions')
        .select('id, depends_on, affects')
        .eq('org_id', orgId)
        .eq('type', 'pattern')
        .eq('source', 'synthesis')
        .eq('status', 'active');
      if (affects && affects.length > 0) {
        query = query.overlaps('affects', affects);
      }
      const { data, error } = await query;
      if (error || !data) return [];
      return data.map((row: { id: string; depends_on: string[] | null; affects: string[] | null }) => ({
        id: row.id,
        depends_on: row.depends_on ?? [],
        affects: row.affects ?? [],
      }));
    },

    async getDecisionStatuses(decisionIds) {
      if (decisionIds.length === 0) return [];
      const { data } = await supabase
        .from('decisions')
        .select('id, status')
        .in('id', decisionIds);
      return (data ?? []) as DecisionStatusRow[];
    },

    async createPattern(orgId, summary, affects, confidence, dependsOn) {
      const decision = await storeDecision(
        supabase,
        orgId,
        { text: summary, type: 'pattern', summary, affects, confidence },
        'system',
        'synthesis',
        { depends_on: dependsOn },
      );
      return { id: decision.id };
    },

    async changePatternStatus(orgId, patternId, newStatus, reason) {
      await changeDecisionStatus(supabase, orgId, patternId, newStatus, 'system', reason);
    },

    async recordAuditEntry(payload) {
      try {
        await createAuditEntry(supabase, payload);
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory adapter (test fixture)
// ---------------------------------------------------------------------------

export interface InMemoryStoreSeed {
  /** Active decisions to return from fetchActiveDecisions. */
  decisions?: ClusterDecision[];
  /** Existing active synthesis patterns. */
  existingPatterns?: SynthesisPatternRow[];
  /** Status map for getDecisionStatuses lookups. */
  decisionStatuses?: DecisionStatusRow[];
}

export interface InMemorySynthesisStore extends SynthesisStore {
  /** Patterns created by createPattern during this run. */
  readonly created: Array<{ orgId: string; summary: string; affects: string[]; confidence: number; dependsOn: string[]; id: string }>;
  /** Status changes applied via changePatternStatus. */
  readonly statusChanges: Array<{ patternId: string; newStatus: string; reason: string }>;
  /** Audit entries recorded. */
  readonly auditEntries: AuditPayload[];
}

let createdIdCounter = 0;

/**
 * In-memory test store. Records every write so orchestration tests can
 * assert on behaviour ("created N patterns", "deprecated M stale ones",
 * "wrote K audit entries with action='pattern_synthesized'").
 */
export function createInMemorySynthesisStore(seed: InMemoryStoreSeed = {}): InMemorySynthesisStore {
  const decisions = seed.decisions ?? [];
  const existingPatterns = [...(seed.existingPatterns ?? [])];
  const decisionStatuses = new Map(
    (seed.decisionStatuses ?? []).map((row) => [row.id, row.status]),
  );

  const created: InMemorySynthesisStore['created'] = [];
  const statusChanges: InMemorySynthesisStore['statusChanges'] = [];
  const auditEntries: InMemorySynthesisStore['auditEntries'] = [];

  return {
    created,
    statusChanges,
    auditEntries,

    async fetchActiveDecisions() {
      return decisions;
    },

    async findActiveSynthesisPatterns(_orgId, affects) {
      if (!affects || affects.length === 0) return [...existingPatterns];
      const set = new Set(affects);
      return existingPatterns.filter((p) => p.affects.some((a) => set.has(a)));
    },

    async getDecisionStatuses(decisionIds) {
      const out: DecisionStatusRow[] = [];
      for (const id of decisionIds) {
        const status = decisionStatuses.get(id);
        if (status) out.push({ id, status });
      }
      return out;
    },

    async createPattern(orgId, summary, affects, confidence, dependsOn) {
      const id = `mem-pattern-${++createdIdCounter}`;
      created.push({ orgId, summary, affects, confidence, dependsOn, id });
      // Newly-created patterns show up in subsequent existingPatterns lookups
      // so a single run that detects two overlapping clusters dedups itself.
      existingPatterns.push({ id, depends_on: dependsOn, affects });
      return { id };
    },

    async changePatternStatus(_orgId, patternId, newStatus, reason) {
      statusChanges.push({ patternId, newStatus, reason });
    },

    async recordAuditEntry(payload) {
      auditEntries.push(payload);
    },
  };
}

// Re-export AuditAction so test files don't need a separate auth import.
export type { AuditAction };

/** Internal helper exposed for tests that want to mint AuditPayloads. */
export { buildAuditPayload };
