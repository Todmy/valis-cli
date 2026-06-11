/**
 * 045 Find Gaps — coverage classification (false-positive discipline, FR-014..016).
 *
 * `reconcileCoverage` (the LLM stage) does the judgment call that needs the
 * decisions — e.g. recognising that a named platform (Shopify) covers
 * cart/checkout. `classifyComponents` is the pure, deterministic safety net on
 * top of that output. It guarantees, without needing the decisions:
 *   - a component reconciled as present OR platform-provided NEVER appears as a
 *     candidate gap (FR-014 — one confident false flag poisons the whole list);
 *   - a component the archetype marks `conditional_on` is surfaced as a FORK
 *     question, never as a silently-resolved plain gap (FR-016).
 */
import type { Archetype, AbsentComponent, CoverageResult, ForkComponent } from './llm.js';

export interface ClassifiedComponents {
  absent: AbsentComponent[];
  present: string[];
  platformProvided: string[];
  forks: ForkComponent[];
}

export function classifyComponents(
  coverage: CoverageResult,
  archetype: Archetype,
): ClassifiedComponents {
  const conditionalOf = new Map<string, string>();
  for (const c of archetype.components) {
    if (c.conditional_on) conditionalOf.set(c.component, c.conditional_on);
  }

  const present = [...new Set(coverage.present)];
  const platformProvided = [...new Set(coverage.platformProvided)];
  const covered = new Set<string>([...present, ...platformProvided]);

  // Forks keyed by component so archetype-derived and LLM-derived forks merge.
  const forks = new Map<string, ForkComponent>();
  for (const f of coverage.forks) {
    if (!covered.has(f.component)) forks.set(f.component, f);
  }

  const absent: AbsentComponent[] = [];
  for (const a of coverage.absent) {
    if (covered.has(a.component)) continue; // FR-014: never flag a covered component
    const conditional = conditionalOf.get(a.component);
    if (conditional) {
      // FR-016: a conditional component is a branch decision → ask it as a fork.
      if (!forks.has(a.component)) {
        forks.set(a.component, {
          component: a.component,
          importance: a.importance,
          conditionalOn: conditional,
        });
      }
      continue;
    }
    absent.push(a);
  }

  return { absent, present, platformProvided, forks: [...forks.values()] };
}
