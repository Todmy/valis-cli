/**
 * 045/T009: niche CNC-rental fixture.
 *
 * Equipment rental is NOT one of the 6 curated domains, so `resolveArchetype`
 * must fall back to the on-demand `derivedArchetype` and the structural register
 * MUST be `synthesized` (US3 / SC-004) — regardless of how confident the canned
 * `reliability` value looks.
 */
import type { DecisionLite } from '../../../src/gaps/llm.js';
import type { CannedScript } from '../canned-client.js';

export const cncRentalDecisions: DecisionLite[] = [
  {
    id: 'cnc-1',
    summary: 'Day-rate rental of CNC routers to makerspaces',
    detail: 'We rent industrial CNC routers by the day to local makerspaces and small shops.',
    affects: ['rental', 'pricing'],
    status: 'active',
    updated_at: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cnc-2',
    summary: 'Card deposit, damage assessed on return',
    detail: 'A refundable deposit is held on the renter card; damage is assessed at return.',
    affects: ['deposit', 'risk'],
    status: 'active',
    updated_at: '2026-05-11T00:00:00.000Z',
  },
  {
    id: 'cnc-3',
    summary: 'Operator certification required before rental',
    detail: 'Renters must show operator certification for the machine class before pickup.',
    affects: ['safety', 'eligibility'],
    status: 'active',
    updated_at: '2026-05-12T00:00:00.000Z',
  },
  {
    id: 'cnc-4',
    summary: 'Tiered pricing by machine class and duration',
    detail: 'Rates are tiered by machine class and rental duration, with weekly discounts.',
    affects: ['pricing'],
    status: 'active',
    updated_at: '2026-05-13T00:00:00.000Z',
  },
  {
    id: 'cnc-5',
    summary: 'Pickup/delivery within 50km flat fee',
    detail: 'We offer pickup and delivery within 50km for a flat logistics fee.',
    affects: ['logistics'],
    status: 'active',
    updated_at: '2026-05-14T00:00:00.000Z',
  },
];

export const cncRentalScript: CannedScript = {
  classify: {
    // Not a curated domain → resolveArchetype must synthesize.
    domain: 'equipment-rental',
    reliability: 0.82,
    derivedArchetype: {
      domain: 'equipment-rental',
      version: '0.0.0-derived',
      components: [
        { component: 'damage-liability-terms', importance: 5, commonly_forgotten: true },
        { component: 'insurance-coverage', importance: 4, commonly_forgotten: true },
        { component: 'late-return-penalties', importance: 3, commonly_forgotten: true },
        { component: 'maintenance-between-rentals', importance: 3, commonly_forgotten: true },
      ],
    },
  },
  coverage: {
    present: ['deposit-handling'],
    platformProvided: [],
    absent: [
      { component: 'insurance-coverage', importance: 4, rationale: 'No insurance/liability coverage recorded.' },
      { component: 'late-return-penalties', importance: 3, rationale: 'No late-return penalty policy recorded.' },
    ],
    forks: [],
  },
  articulate: (candidates) =>
    candidates.map((c) => ({
      component: c.component,
      question: `What is the team policy on ${c.component.replace(/-/g, ' ')}?`,
      whyAsking: c.rationale ?? `${c.component} is a common gap for an equipment-rental operation.`,
      groundingDecisionIds: ['cnc-2'],
      importance: c.importance,
      nonObviousness: Math.min(5, c.importance),
    })),
};
