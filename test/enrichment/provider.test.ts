/**
 * T059: Unit tests for enrichment provider interface, response parsing,
 * no-LLM-key path, dry-run mode, and runner orchestration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseEnrichmentResponse, ENRICHMENT_SYSTEM_PROMPT } from '../../src/enrichment/provider.js';
import type { EnrichmentProvider, ProviderEnrichmentResult } from '../../src/enrichment/provider.js';
import { getProvider } from '../../src/enrichment/runner.js';

// ---------------------------------------------------------------------------
// parseEnrichmentResponse
// ---------------------------------------------------------------------------

describe('parseEnrichmentResponse', () => {
  it('parses valid JSON response correctly', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Use PostgreSQL for persistence',
      affects: ['database', 'api-design'],
    });
    const result = parseEnrichmentResponse(raw, 500);

    expect(result.type).toBe('decision');
    expect(result.summary).toBe('Use PostgreSQL for persistence');
    expect(result.affects).toEqual(['database', 'api-design']);
    expect(result.tokensUsed).toBe(500);
  });

  it('handles JSON wrapped in markdown fences', () => {
    const raw = '```json\n{"type":"constraint","summary":"Max 100 connections","affects":["database"]}\n```';
    const result = parseEnrichmentResponse(raw, 300);

    expect(result.type).toBe('constraint');
    expect(result.summary).toBe('Max 100 connections');
    expect(result.affects).toEqual(['database']);
  });

  it('falls back to decision type for invalid type', () => {
    const raw = JSON.stringify({
      type: 'invalid_type',
      summary: 'Something',
      affects: ['auth'],
    });
    const result = parseEnrichmentResponse(raw, 100);

    expect(result.type).toBe('decision');
  });

  it('truncates summary to 200 characters', () => {
    const longSummary = 'A'.repeat(300);
    const raw = JSON.stringify({
      type: 'lesson',
      summary: longSummary,
      affects: ['testing'],
    });
    const result = parseEnrichmentResponse(raw, 200);

    expect(result.summary.length).toBeLessThanOrEqual(200);
  });

  it('clamps affects to 10 entries', () => {
    const areas = Array.from({ length: 15 }, (_, i) => `area-${i}`);
    const raw = JSON.stringify({
      type: 'pattern',
      summary: 'Many areas',
      affects: areas,
    });
    const result = parseEnrichmentResponse(raw, 400);

    expect(result.affects.length).toBe(10);
  });

  it('lowercases and trims affects', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Test',
      affects: ['  Auth ', 'DATABASE', 'Api-Design'],
    });
    const result = parseEnrichmentResponse(raw, 100);

    expect(result.affects).toEqual(['auth', 'database', 'api-design']);
  });

  it('returns fallback on completely invalid JSON', () => {
    const raw = 'This is not JSON at all, just some random text from the LLM';
    const result = parseEnrichmentResponse(raw, 150);

    expect(result.type).toBe('decision');
    expect(result.summary.length).toBeLessThanOrEqual(200);
    expect(result.affects).toEqual([]);
    expect(result.tokensUsed).toBe(150);
  });

  it('handles missing fields with defaults', () => {
    const raw = JSON.stringify({});
    const result = parseEnrichmentResponse(raw, 50);

    expect(result.type).toBe('decision');
    expect(result.summary).toBe('No summary provided');
    expect(result.affects).toEqual([]);
  });

  it('filters out non-string affects entries', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Test',
      affects: ['auth', 123, null, 'database', true],
    });
    const result = parseEnrichmentResponse(raw, 100);

    expect(result.affects).toEqual(['auth', 'database']);
  });

  it('handles all four valid types', () => {
    for (const validType of ['decision', 'constraint', 'pattern', 'lesson']) {
      const raw = JSON.stringify({ type: validType, summary: 'Test', affects: [] });
      const result = parseEnrichmentResponse(raw, 100);
      expect(result.type).toBe(validType);
    }
  });
});

// ---------------------------------------------------------------------------
// ENRICHMENT_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('ENRICHMENT_SYSTEM_PROMPT', () => {
  it('is a non-empty string', () => {
    expect(typeof ENRICHMENT_SYSTEM_PROMPT).toBe('string');
    expect(ENRICHMENT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
  });

  it('mentions all four decision types', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"decision"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"constraint"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"pattern"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"lesson"');
  });

  it('asks for JSON response', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT.toLowerCase()).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// EnrichmentProvider interface compliance (mock)
// ---------------------------------------------------------------------------

describe('EnrichmentProvider interface', () => {
  it('mock provider satisfies the interface', async () => {
    const mockProvider: EnrichmentProvider = {
      name: 'mock',
      estimatedCostPerToken: 0.000001,
      enrich: vi.fn().mockResolvedValue({
        type: 'decision',
        summary: 'Mock summary',
        affects: ['auth'],
        tokensUsed: 100,
      } satisfies ProviderEnrichmentResult),
    };

    const result = await mockProvider.enrich('some text');
    expect(result.type).toBe('decision');
    expect(result.summary).toBe('Mock summary');
    expect(result.affects).toEqual(['auth']);
    expect(result.tokensUsed).toBe(100);
    expect(mockProvider.enrich).toHaveBeenCalledWith('some text');
  });
});

// ---------------------------------------------------------------------------
// getProvider — no-LLM-key path
// ---------------------------------------------------------------------------

describe('getProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null when no keys are set', () => {
    const provider = getProvider();
    expect(provider).toBeNull();
  });

  it('returns null when requesting anthropic without key', () => {
    const provider = getProvider('anthropic');
    expect(provider).toBeNull();
  });

  it('returns null when requesting openai without key', () => {
    const provider = getProvider('openai');
    expect(provider).toBeNull();
  });

  it('returns AnthropicProvider when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const provider = getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('anthropic');
  });

  it('returns OpenAIProvider when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const provider = getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('openai');
  });

  it('prefers Anthropic when both keys are set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const provider = getProvider();
    expect(provider!.name).toBe('anthropic');
  });

  it('respects explicit provider preference over auto-detect', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const provider = getProvider('openai');
    expect(provider!.name).toBe('openai');
  });

  it('providers have positive estimatedCostPerToken', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const anthropic = getProvider('anthropic');
    expect(anthropic!.estimatedCostPerToken).toBeGreaterThan(0);

    process.env.OPENAI_API_KEY = 'sk-test-key';
    const openai = getProvider('openai');
    expect(openai!.estimatedCostPerToken).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// runEnrichment — dry-run and no-provider paths
// ---------------------------------------------------------------------------

describe('runEnrichment', () => {
  // We test the no-provider and dry-run paths which don't need real clients
  const { runEnrichment } = await import('../../src/enrichment/runner.js');

  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns no_provider when no keys set', async () => {
    const mockSupabase = {} as any;
    const mockQdrant = {} as any;

    const report = await runEnrichment(mockSupabase, mockQdrant, {
      orgId: 'org-1',
      memberId: 'member-1',
      dryRun: false,
    });

    expect(report.mode).toBe('no_provider');
    expect(report.enriched).toBe(0);
    expect(report.message).toContain('No LLM provider configured');
  });

  it('returns dry_run report with candidate count', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const mockPendingDecisions = [
      { id: 'dec-1', detail: 'Some text', type: 'pending', org_id: 'org-1' },
      { id: 'dec-2', detail: 'Other text', type: 'pending', org_id: 'org-1' },
    ];

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: mockPendingDecisions,
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;

    const mockQdrant = {} as any;

    const report = await runEnrichment(mockSupabase, mockQdrant, {
      orgId: 'org-1',
      memberId: 'member-1',
      dryRun: true,
    });

    expect(report.mode).toBe('dry_run');
    expect(report.candidates).toBe(2);
    expect(report.enriched).toBe(0);
    expect(report.details).toHaveLength(0);
  });

  it('returns empty report when no pending decisions', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';

    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [],
                error: null,
              }),
            }),
          }),
        }),
      }),
    } as any;

    const mockQdrant = {} as any;

    const report = await runEnrichment(mockSupabase, mockQdrant, {
      orgId: 'org-1',
      memberId: 'member-1',
      dryRun: false,
    });

    expect(report.enriched).toBe(0);
    expect(report.candidates).toBe(0);
    expect(report.message).toContain('No pending decisions');
  });
});
