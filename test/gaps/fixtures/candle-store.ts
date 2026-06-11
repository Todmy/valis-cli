/**
 * 045/T009: candle-store fixture — mirrors spec §3.4 demo.
 *
 * A small e-commerce store that sells candles on Shopify + Etsy, ships fragile
 * goods with bubble wrap, and has recorded pricing/payments/catalog decisions —
 * but NOTHING about returns, tax, or fraud. The canned coverage marks cart and
 * payments as platform-provided (Shopify/Stripe named) so SC-003 can assert
 * they are never flagged, and surfaces an international-shipping fork.
 */
import type { DecisionLite } from '../../../src/gaps/llm.js';
import type { CannedScript } from '../canned-client.js';

export const candleStoreDecisions: DecisionLite[] = [
  {
    id: 'cs-1',
    summary: 'Sell candles via Shopify + Etsy',
    detail: 'We run the storefront on Shopify and cross-list our bestsellers on Etsy.',
    affects: ['sales-channel', 'platform'],
    status: 'active',
    updated_at: '2026-05-01T00:00:00.000Z',
  },
  {
    id: 'cs-2',
    summary: 'Fragile shipping with bubble wrap',
    detail: 'Candles are fragile; every order ships double-boxed with bubble wrap and a FRAGILE label.',
    affects: ['shipping', 'packaging'],
    status: 'active',
    updated_at: '2026-05-02T00:00:00.000Z',
  },
  {
    id: 'cs-3',
    summary: 'Cost-plus pricing, free shipping over $50',
    detail: 'Pricing is cost-plus 40% margin. Orders over $50 ship free domestically.',
    affects: ['pricing'],
    status: 'active',
    updated_at: '2026-05-03T00:00:00.000Z',
  },
  {
    id: 'cs-4',
    summary: 'Payments via Shopify Payments (Stripe)',
    detail: 'Checkout uses Shopify Payments, which is Stripe under the hood. No custom payment code.',
    affects: ['payments'],
    status: 'active',
    updated_at: '2026-05-04T00:00:00.000Z',
  },
  {
    id: 'cs-5',
    summary: 'Catalog organized by scent and season',
    detail: 'The product catalog is grouped by scent family and seasonal collection.',
    affects: ['catalog'],
    status: 'active',
    updated_at: '2026-05-05T00:00:00.000Z',
  },
];

/**
 * Canned stage outputs for the candle store. Domain maps to the curated
 * `e-commerce` archetype → structural register MUST be `standard`.
 */
export const candleStoreScript: CannedScript = {
  classify: {
    domain: 'e-commerce',
    // Self-rated reliability is deliberately mid-high — the test asserts it is
    // telemetry only and never flips the register.
    reliability: 0.88,
    derivedArchetype: {
      domain: 'e-commerce',
      version: '0.0.0-derived',
      components: [{ component: 'cart-checkout', importance: 5, commonly_forgotten: false }],
    },
  },
  coverage: {
    present: ['product-catalog', 'pricing-discounts', 'shipping-fulfillment'],
    platformProvided: ['cart-checkout', 'payment-processing'],
    absent: [
      { component: 'returns-refunds', importance: 4, rationale: 'No return or refund policy recorded.' },
      { component: 'tax-calculation', importance: 4, rationale: 'No sales-tax handling recorded.' },
      { component: 'fraud-prevention', importance: 3, rationale: 'No fraud/chargeback stance recorded.' },
    ],
    forks: [
      {
        component: 'international-multicurrency',
        importance: 3,
        conditionalOn: 'selling to customers outside the home country',
      },
    ],
  },
  articulate: (candidates) =>
    candidates.map((c) => ({
      component: c.component,
      question: `How does the team handle ${c.component.replace(/-/g, ' ')}?`,
      whyAsking: c.rationale ?? `${c.component} is a commonly-missed part of an e-commerce store.`,
      // Ground every question in the recorded decisions so FR-006 holds.
      groundingDecisionIds: ['cs-3', 'cs-2'],
      importance: c.importance,
      // Non-obviousness mirrors importance here; the boring-critical gaps score high.
      nonObviousness: Math.min(5, c.importance),
    })),
};
