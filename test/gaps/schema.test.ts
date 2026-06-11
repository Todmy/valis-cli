/**
 * 045/T006: curated archetype contract (FR-030).
 *
 * Asserts external behavior on the real shipped JSON assets — all 6 load and
 * validate — and that the zod schema rejects files missing required fields.
 * (Per lesson 761661a4: these assert on the actual files and the actual schema,
 * not on a mock.)
 */
import { describe, it, expect } from 'vitest';
import { ArchetypeSchema, loadCuratedArchetypes } from '../../src/gaps/schema.js';

const EXPECTED_DOMAINS = [
  'e-commerce',
  'b2b-saas-crud',
  'marketplace',
  'auth-identity',
  'billing-subscriptions',
  'compliance-data-privacy',
];

describe('loadCuratedArchetypes', () => {
  it('loads and validates all 6 shipped archetype files', () => {
    const map = loadCuratedArchetypes();
    expect(map.size).toBe(6);
    for (const domain of EXPECTED_DOMAINS) {
      expect(map.has(domain)).toBe(true);
    }
  });

  it('every component carries importance 1–5 and a commonly_forgotten flag', () => {
    const map = loadCuratedArchetypes();
    for (const archetype of map.values()) {
      expect(archetype.components.length).toBeGreaterThan(0);
      for (const c of archetype.components) {
        expect(c.importance).toBeGreaterThanOrEqual(1);
        expect(c.importance).toBeLessThanOrEqual(5);
        expect(typeof c.commonly_forgotten).toBe('boolean');
      }
    }
  });

  it('includes the boring-critical components the spec calls out', () => {
    const map = loadCuratedArchetypes();
    const ecommerce = map.get('e-commerce')!;
    const keys = ecommerce.components.map((c) => c.component);
    expect(keys).toContain('returns-refunds');
    expect(keys).toContain('tax-calculation');

    // Platform-awareness seed present (FR-014): cart/checkout names a platform.
    const cart = ecommerce.components.find((c) => c.component === 'cart-checkout');
    expect(cart?.platform_provided_by).toBeDefined();
    expect(cart?.platform_provided_by).toContain('Shopify');

    // A fork (conditional_on) is present somewhere (FR-016).
    const hasFork = ecommerce.components.some((c) => typeof c.conditional_on === 'string');
    expect(hasFork).toBe(true);
  });
});

describe('ArchetypeSchema rejection (FR-030)', () => {
  const validComponent = {
    component: 'cart-checkout',
    importance: 5,
    commonly_forgotten: false,
  };
  const validArchetype = {
    domain: 'x',
    version: '1.0.0',
    components: [validComponent],
  };

  it('rejects a file missing version', () => {
    const { version, ...noVersion } = validArchetype;
    void version;
    expect(ArchetypeSchema.safeParse(noVersion).success).toBe(false);
  });

  it('rejects a component missing importance', () => {
    const { importance, ...noImportance } = validComponent;
    void importance;
    expect(
      ArchetypeSchema.safeParse({ ...validArchetype, components: [noImportance] }).success,
    ).toBe(false);
  });

  it('rejects a component missing commonly_forgotten', () => {
    const { commonly_forgotten, ...noFlag } = validComponent;
    void commonly_forgotten;
    expect(
      ArchetypeSchema.safeParse({ ...validArchetype, components: [noFlag] }).success,
    ).toBe(false);
  });

  it('rejects importance out of the 1–5 range', () => {
    expect(
      ArchetypeSchema.safeParse({
        ...validArchetype,
        components: [{ ...validComponent, importance: 6 }],
      }).success,
    ).toBe(false);
  });

  it('rejects an empty components array', () => {
    expect(ArchetypeSchema.safeParse({ ...validArchetype, components: [] }).success).toBe(false);
  });
});
