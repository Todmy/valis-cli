/**
 * 045/T009: deterministic canned `GapLlmClient` for engine tests.
 *
 * Zero live calls. Each stage returns a scripted, fixed output so the pipeline
 * tests can assert the engine's OWN transformations (existing-component dedup,
 * absence-gate drop, top-N cap, structural register, grounding-snapshot
 * construction) against known inputs — not assert that a mock echoed a mock
 * (lesson 761661a4).
 *
 * `calls` is exposed so a test can assert the FR-028 budget bound and verify
 * that an all-covered fixture never reaches the (expensive) articulate stage.
 */
import type {
  GapLlmClient,
  ClassifyResult,
  CoverageResult,
  ArticulatedQuestion,
  AbsentComponent,
} from '../../src/gaps/llm.js';

export interface CannedScript {
  classify: ClassifyResult;
  coverage: CoverageResult;
  /** Emit one articulated question per candidate the pipeline forwards. */
  articulate: (candidates: AbsentComponent[]) => ArticulatedQuestion[];
}

export interface CannedClient extends GapLlmClient {
  readonly calls: { classify: number; coverage: number; articulate: number };
}

export function makeCannedClient(script: CannedScript): CannedClient {
  const calls = { classify: 0, coverage: 0, articulate: 0 };
  return {
    calls,
    async classifyAndDerive() {
      calls.classify++;
      return script.classify;
    },
    async reconcileCoverage() {
      calls.coverage++;
      return script.coverage;
    },
    async articulateAndRank({ candidates }) {
      calls.articulate++;
      return script.articulate(candidates);
    },
  };
}
