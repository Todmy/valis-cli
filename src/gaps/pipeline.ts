/**
 * 045 Find Gaps — pipeline orchestration.
 *
 * CLASSIFY → (structural register) → RECONCILE COVERAGE → EXCLUDE-EXISTING →
 * ABSENCE-GATE → ARTICULATE+RANK → JUDGE-GATE → DEDUP → TOP-N.
 *
 * Invariants the engine guarantees (asserted by pipeline.test.ts):
 *   - components in `existingComponents` are removed BEFORE articulation, so a
 *     re-asked gap consumes zero model attention (FR-019);
 *   - platform-provided / present components never reach the candidate set —
 *     the coverage stage already bucketed them away (FR-014);
 *   - forks bypass the absence gate (they are unresolved branch decisions, not
 *     fact lookups) but are still surfaced AS questions, never resolved (FR-016);
 *   - the model is called at most `config.maxModelCalls` times — a defensive
 *     counter throws `model_budget_exceeded` past it (FR-028);
 *   - an empty `questions` array is a legitimate "no gaps found" — never
 *     fabricate (FR-007);
 *   - every emitted question is grounded in real decisions (non-empty, validated
 *     `groundingDecisionIds`) — FR-006.
 */
import {
  GapEngineError,
  type GapLlmClient,
  type Archetype,
  type AbsentComponent,
  type DecisionLite,
  type Register,
} from './llm.js';
import type { GapsConfig } from './config.js';
import { resolveArchetype } from './archetype.js';
import { classifyComponents } from './coverage.js';

export interface GapPipelineDeps {
  llm: GapLlmClient;
  /** FR-017 gate — true ⇒ the component is already answered in the store, drop it. */
  searchAbsence(component: string): Promise<boolean>;
  /** FR-019 dedup — components already persisted as gap_questions for this project. */
  existingComponents: Set<string>;
  config: GapsConfig;
  /** Curated archetype registry (loadCuratedArchetypes()). */
  curated: Map<string, Archetype>;
  /** Set by the executor when the knowledge state exceeded MAX_DECISIONS_ANALYZED. */
  truncated?: boolean;
}

/** Full FR-006 payload — maps 1:1 onto gap_questions columns. */
export interface NewGapQuestion {
  archetypeComponent: string;
  question: string;
  whyAsking: string;
  groundingDecisionIds: string[];
  groundingSnapshot: Array<{ decisionId: string; updatedAt: string; status: string }>;
  importance: number;
  nonObviousness: number;
  register: Register;
}

export interface PipelineResult {
  register: Register;
  domain: string;
  modelCalls: number;
  truncated: boolean;
  reliabilityTelemetry: number | null;
  questions: NewGapQuestion[];
}

export async function runGapPipeline(
  decisions: DecisionLite[],
  deps: GapPipelineDeps,
): Promise<PipelineResult> {
  const { llm, config, curated, existingComponents } = deps;

  let modelCalls = 0;
  const charge = (label: string) => {
    modelCalls++;
    if (modelCalls > config.maxModelCalls) {
      throw new GapEngineError(
        'model_budget_exceeded',
        `would exceed ${config.maxModelCalls} model calls at "${label}"`,
      );
    }
  };

  // ── Stage 1: classify + derive ──────────────────────────────────────────
  charge('classify');
  const classify = await llm.classifyAndDerive({ decisions });

  // Structural register decision — no model call (FR-012).
  const resolved = resolveArchetype(classify, curated);

  // ── Stage 2: reconcile coverage ─────────────────────────────────────────
  charge('coverage');
  const coverage = await llm.reconcileCoverage({ decisions, archetype: resolved.archetype });

  // Deterministic safety net (FR-014/016): covered components can never reach
  // the candidate set; conditional components become forks, not plain gaps.
  const classified = classifyComponents(coverage, resolved.archetype);

  const isExisting = (component: string) => existingComponents.has(component);

  // Absent candidates: exclude already-asked (FR-019) BEFORE the model/gate.
  const absentCandidates = classified.absent.filter((a) => !isExisting(a.component));

  // Forks: surfaced as questions, exclude already-asked, but bypass the absence
  // gate (a fork is an unresolved branch, not a fact the store could "answer").
  const forkCandidates: AbsentComponent[] = classified.forks
    .filter((f) => !isExisting(f.component))
    .map((f) => ({
      component: f.component,
      importance: f.importance,
      rationale: `Unresolved conditional branch: ${f.conditionalOn}`,
    }));

  // ── Absence gate (FR-017): drop absent components already answered ────────
  const gatedAbsent: AbsentComponent[] = [];
  for (const candidate of absentCandidates) {
    const answered = await deps.searchAbsence(candidate.component);
    if (!answered) gatedAbsent.push(candidate);
  }

  const candidates = [...gatedAbsent, ...forkCandidates];

  let questions: NewGapQuestion[] = [];
  if (candidates.length > 0) {
    // ── Stage 3: articulate + rank ────────────────────────────────────────
    charge('articulate');
    const articulated = await llm.articulateAndRank({ candidates, decisions });

    const byId = new Map(decisions.map((d) => [d.id, d]));
    const mapped: NewGapQuestion[] = [];
    for (const q of articulated) {
      // Defensive dedup — never re-emit an already-asked component.
      if (isExisting(q.component)) continue;
      // FR-006: grounding must reference REAL decisions; drop unknown ids.
      const validIds = q.groundingDecisionIds.filter((id) => byId.has(id));
      if (validIds.length === 0) continue;
      // Judge gate — drop generic, low-value candidates (config floors).
      if (q.importance < config.judgeMinImportance) continue;
      if (q.nonObviousness < config.judgeMinNonObviousness) continue;
      mapped.push({
        archetypeComponent: q.component,
        question: q.question,
        whyAsking: q.whyAsking,
        groundingDecisionIds: validIds,
        groundingSnapshot: validIds.map((id) => {
          const d = byId.get(id)!;
          return { decisionId: id, updatedAt: d.updated_at, status: d.status };
        }),
        importance: q.importance,
        nonObviousness: q.nonObviousness,
        register: resolved.register,
      });
    }

    // Dedup by component (keep highest importance × non-obviousness), rank, cap.
    const best = new Map<string, NewGapQuestion>();
    const score = (q: NewGapQuestion) => q.importance * q.nonObviousness;
    for (const q of mapped) {
      const prev = best.get(q.archetypeComponent);
      if (!prev || score(q) > score(prev)) best.set(q.archetypeComponent, q);
    }
    questions = [...best.values()]
      .sort((a, b) => score(b) - score(a))
      .slice(0, config.topNQuestions);
  }

  return {
    register: resolved.register,
    domain: classify.domain,
    modelCalls,
    truncated: deps.truncated ?? false,
    reliabilityTelemetry: resolved.reliabilityTelemetry,
    questions,
  };
}
