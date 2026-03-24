/**
 * T059: Unit tests for enrichment provider interface, response parsing,
 * no-LLM-key path, and dry-run mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseEnrichmentResponse, ENRICHMENT_SYSTEM_PROMPT } from '../../src/enrichment/provider.js';
import { getProvider } from '../../src/enrichment/runner.js';

describe('parseEnrichmentResponse', () => {
  it('parses a well-formed JSON response', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Use PostgreSQL for user data storage',
      affects: ['database', 'backend'],
    });

    const result = parseEnrichmentResponse(raw, 150);

    expect(result.type).toBe('decision');
    expect(result.summary).toBe('Use PostgreSQL for user data storage');
    expect(result.affects).toEqual(['database', 'backend']);
    expect(result.tokensUsed).toBe(150);
  });

  it('parses JSON wrapped in markdown code fences', () => {
    const raw = '```json\n{"type":"constraint","summary":"Max 10 connections","affects":["database"]}\n```';

    const result = parseEnrichmentResponse(raw, 200);

    expect(result.type).toBe('constraint');
    expect(result.summary).toBe('Max 10 connections');
    expect(result.affects).toEqual(['database']);
  });

  it('parses JSON wrapped in plain code fences', () => {
    const raw = '```\n{"type":"lesson","summary":"Always test edge cases","affects":["testing"]}\n```';

    const result = parseEnrichmentResponse(raw, 100);

    expect(result.type).toBe('lesson');
    expect(result.summary).toBe('Always test edge cases');
    expect(result.affects).toEqual(['testing']);
  });

  it('falls back to "decision" for invalid type', () => {
    const raw = JSON.stringify({
      type: 'invalid_type',
      summary: 'Something',
      affects: ['area'],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.type).toBe('decision');
  });

  it('falls back to "decision" when type is missing', () => {
    const raw = JSON.stringify({
      summary: 'No type field',
      affects: ['area'],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.type).toBe('decision');
  });

  it('truncates summary to 200 characters', () => {
    const longSummary = 'A'.repeat(300);
    const raw = JSON.stringify({
      type: 'decision',
      summary: longSummary,
      affects: [],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.summary.length).toBeLessThanOrEqual(200);
  });

  it('provides default summary when missing', () => {
    const raw = JSON.stringify({
      type: 'pattern',
      affects: ['auth'],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.summary).toBe('No summary provided');
  });

  it('limits affects to 10 items', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Test',
      affects: Array.from({ length: 15 }, (_, i) => `area-${i}`),
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.affects).toHaveLength(10);
  });

  it('lowercases and trims affects areas', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Test',
      affects: ['  Database  ', 'API-Design', 'AUTH'],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.affects).toEqual(['database', 'api-design', 'auth']);
  });

  it('filters out non-string and empty affects entries', () => {
    const raw = JSON.stringify({
      type: 'decision',
      summary: 'Test',
      affects: ['valid', '', null, 42, 'also-valid'],
    });

    const result = parseEnrichmentResponse(raw, 100);
    expect(result.affects).toEqual(['valid', 'also-valid']);
  });

  it('returns sensible fallback for completely invalid JSON', () => {
    const raw = 'This is not JSON at all, just random text.';

    const result = parseEnrichmentResponse(raw, 50);

    expect(result.type).toBe('decision');
    expect(result.summary).toBe(raw);
    expect(result.affects).toEqual([]);
    expect(result.tokensUsed).toBe(50);
  });

  it('handles empty string input', () => {
    const result = parseEnrichmentResponse('', 0);

    expect(result.type).toBe('decision');
    expect(result.affects).toEqual([]);
    expect(result.tokensUsed).toBe(0);
  });
});

describe('ENRICHMENT_SYSTEM_PROMPT', () => {
  it('mentions all valid decision types', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"decision"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"constraint"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"pattern"');
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('"lesson"');
  });

  it('specifies JSON response format', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('valid JSON');
  });

  it('specifies max summary length', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toContain('200 characters');
  });
});

describe('getProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns null when no API keys are configured (T059: no-key path)', () => {
    const provider = getProvider();
    expect(provider).toBeNull();
  });

  it('returns null for explicit anthropic with no key', () => {
    const provider = getProvider('anthropic');
    expect(provider).toBeNull();
  });

  it('returns null for explicit openai with no key', () => {
    const provider = getProvider('openai');
    expect(provider).toBeNull();
  });

  it('returns AnthropicProvider when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';

    const provider = getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('anthropic');
  });

  it('returns OpenAIProvider when only OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test123';

    const provider = getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('openai');
  });

  it('prefers Anthropic when both keys are available', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
    process.env.OPENAI_API_KEY = 'sk-test123';

    const provider = getProvider();
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('anthropic');
  });

  it('uses explicit provider override over auto-detect', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
    process.env.OPENAI_API_KEY = 'sk-test123';

    const provider = getProvider('openai');
    expect(provider).not.toBeNull();
    expect(provider!.name).toBe('openai');
  });

  it('providers expose estimatedCostPerToken', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test123';
    const anthropic = getProvider('anthropic');
    expect(anthropic!.estimatedCostPerToken).toBeGreaterThan(0);

    process.env.OPENAI_API_KEY = 'sk-test123';
    const openai = getProvider('openai');
    expect(openai!.estimatedCostPerToken).toBeGreaterThan(0);
  });
});

describe('runEnrichment (mock integration)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns no_provider report when no LLM key configured (T059)', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    // Import dynamically to ensure clean env
    const { runEnrichment } = await import('../../src/enrichment/runner.js');

    const mockSupabase = {} as any;
    const report = await runEnrichment(mockSupabase, null, {
      orgId: 'org-123',
      memberId: 'member-123',
    });

    expect(report.mode).toBe('no_provider');
    expect(report.enriched).toBe(0);
    expect(report.message).toContain('No LLM provider configured');
    expect(report.message).toContain('Pending decisions unchanged');
  });
});
