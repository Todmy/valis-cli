/**
 * 045/T024: register gating + ranking gates (US3, SC-004).
 *
 * The register is STRICTLY structural (decision 9b97f009): a curated-mapped
 * domain → standard; anything else → synthesized — regardless of how confident
 * the canned `reliability` value is. Reliability passes through to telemetry
 * only, never gates. Asserted on the real curated map + both fixtures.
 */
import { describe, it, expect } from 'vitest';
import { resolveArchetype } from '../../src/gaps/archetype.js';
import { runGapPipeline } from '../../src/gaps/pipeline.js';
import { loadCuratedArchetypes } from '../../src/gaps/schema.js';
import { DEFAULT_GAPS_CONFIG } from '../../src/gaps/config.js';
import type { ClassifyResult } from '../../src/gaps/llm.js';
import { makeCannedClient } from './canned-client.js';
import { candleStoreDecisions, candleStoreScript } from './fixtures/candle-store.js';
import { cncRentalDecisions, cncRentalScript } from './fixtures/cnc-rental.js';

const curated = loadCuratedArchetypes();

function classify(overrides: Partial<ClassifyResult>): ClassifyResult {
  return {
    domain: 'e-commerce',
    reliability: 0.9,
    derivedArchetype: {
      domain: 'x',
      version: '0.0.0-derived',
      components: [{ component: 'foo', importance: 3, commonly_forgotten: true }],
    },
    ...overrides,
  };
}

describe('resolveArchetype — structural register (FR-012, decision 9b97f009)', () => {
  it('curated domain → standard even with LOW reliability', () => {
    const r = resolveArchetype(classify({ domain: 'e-commerce', reliability: 0.1 }), curated);
    expect(r.register).toBe('standard');
    expect(r.reliabilityTelemetry).toBe(0.1); // passes through, did not gate
  });

  it('unmapped domain → synthesized even with HIGH reliability', () => {
    const r = resolveArchetype(classify({ domain: 'tarot-reading-saas', reliability: 0.99 }), curated);
    expect(r.register).toBe('synthesized');
    expect(r.reliabilityTelemetry).toBe(0.99);
    // Synthesized uses the on-demand derived archetype, never a curated file.
    expect(r.archetype.version).toBe('0.0.0-derived');
  });

  it('maps case-insensitively onto the curated domain', () => {
    expect(resolveArchetype(classify({ domain: 'E-Commerce' }), curated).register).toBe('standard');
  });
});

describe('pipeline register on both fixtures (SC-004)', () => {
  it('candle store (curated e-commerce) → standard', async () => {
    const result = await runGapPipeline(candleStoreDecisions, {
      llm: makeCannedClient(candleStoreScript),
      searchAbsence: async () => false,
      existingComponents: new Set(),
      config: DEFAULT_GAPS_CONFIG,
      curated,
    });
    expect(result.register).toBe('standard');
  });

  it('niche CNC rental (unmapped) → synthesized, still produces grounded questions', async () => {
    const result = await runGapPipeline(cncRentalDecisions, {
      llm: makeCannedClient(cncRentalScript),
      searchAbsence: async () => false,
      existingComponents: new Set(),
      config: DEFAULT_GAPS_CONFIG,
      curated,
    });
    expect(result.register).toBe('synthesized');
    // Telemetry passthrough only — never gated the register.
    expect(result.reliabilityTelemetry).toBe(0.82);
    // Honest degradation: a synthesized run still surfaces real questions, each
    // carrying the synthesized register so the UI can frame it as a pressure-test.
    expect(result.questions.length).toBeGreaterThan(0);
    for (const q of result.questions) {
      expect(q.register).toBe('synthesized');
      expect(q.question).toContain('?');
      expect(q.groundingDecisionIds.length).toBeGreaterThan(0);
    }
  });
});
