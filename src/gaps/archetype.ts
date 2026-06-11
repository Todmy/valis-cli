/**
 * 045 Find Gaps — register resolution (FR-009..013, research R6).
 *
 * `resolveArchetype` is the structural gate: the register is `standard` IFF the
 * classified domain maps to one of the curated archetype files, otherwise
 * `synthesized`. The model's self-rated reliability is passed through to
 * telemetry ONLY — it never flips the register (decision 9b97f009: verbalized
 * confidence is overconfident/unfaithful, so it cannot be the gate).
 *
 * Unmapped domains use the on-demand `derivedArchetype` produced by Stage 1
 * (R7) — never cached as authoritative, surfaced honestly as a synthesized
 * pressure-test rather than a fake standard (US3).
 */
import type { Archetype, ClassifyResult, Register } from './llm.js';

export interface ResolvedArchetype {
  archetype: Archetype;
  /** `standard` iff a curated file matched; never decided by reliability (FR-012). */
  register: Register;
  /** Self-rated value — telemetry/analysis only, never gates (FR-012). */
  reliabilityTelemetry: number | null;
}

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase();
}

export function resolveArchetype(
  classify: ClassifyResult,
  curated: Map<string, Archetype>,
): ResolvedArchetype {
  const normalized = normalizeDomain(classify.domain);

  let mapped = curated.get(normalized);
  if (!mapped) {
    for (const [domain, arch] of curated) {
      if (normalizeDomain(domain) === normalized) {
        mapped = arch;
        break;
      }
    }
  }

  if (mapped) {
    return {
      archetype: mapped,
      register: 'standard',
      reliabilityTelemetry: classify.reliability,
    };
  }

  // No curated match → synthesized, honest degradation on the derived draft.
  return {
    archetype: classify.derivedArchetype,
    register: 'synthesized',
    reliabilityTelemetry: classify.reliability,
  };
}
