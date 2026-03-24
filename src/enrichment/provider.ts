/**
 * T052: EnrichmentProvider interface, response parsing, and system prompt.
 *
 * Defines the contract for LLM providers that classify pending decisions.
 * Completely isolated from core operations (store, search, context, lifecycle).
 */

import type { DecisionType } from '../types.js';

// ---------------------------------------------------------------------------
// EnrichmentResult (per-call result, distinct from the types.ts aggregate)
// ---------------------------------------------------------------------------

/** Result from a single LLM enrichment call. */
export interface ProviderEnrichmentResult {
  /** Classified decision type. */
  type: DecisionType;
  /** Generated summary (max 200 characters). */
  summary: string;
  /** Extracted affected areas (1-10). */
  affects: string[];
  /** Total tokens consumed (input + output) for cost tracking. */
  tokensUsed: number;
}

// ---------------------------------------------------------------------------
// EnrichmentProvider interface
// ---------------------------------------------------------------------------

/** Provider abstraction for LLM enrichment. */
export interface EnrichmentProvider {
  /** Human-readable provider name (e.g. 'anthropic', 'openai'). */
  name: string;
  /** Enrich raw decision text into structured metadata. */
  enrich(text: string): Promise<ProviderEnrichmentResult>;
  /** Estimated cost per token in USD (for ceiling enforcement). */
  estimatedCostPerToken: number;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const ENRICHMENT_SYSTEM_PROMPT = `You are a decision classifier for a software team's knowledge base.
Given raw text from a development session, classify it and extract
structured metadata.

Respond with valid JSON only:
{
  "type": "decision" | "constraint" | "pattern" | "lesson",
  "summary": "One-line summary (max 200 characters)",
  "affects": ["area1", "area2"]
}

Rules:
- "decision": An explicit architectural or technical choice.
- "constraint": A limitation or requirement that restricts options.
- "pattern": A recurring approach or convention.
- "lesson": Something learned from experience (good or bad).
- Areas should be lowercase, hyphenated (e.g., "auth", "database", "api-design", "testing").
- Return between 1 and 10 areas.
- The summary must be a single line, no longer than 200 characters.`;

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set<string>(['decision', 'constraint', 'pattern', 'lesson']);

/**
 * Parse raw LLM response text into a structured ProviderEnrichmentResult.
 *
 * Handles JSON embedded in markdown fences or plain text. Validates fields
 * and applies sensible defaults for malformed responses.
 */
export function parseEnrichmentResponse(
  rawText: string,
  tokensUsed: number,
): ProviderEnrichmentResult {
  // Strip markdown code fences if present
  let cleaned = rawText.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: treat entire text as an unclassifiable blob
    return {
      type: 'decision',
      summary: rawText.substring(0, 200).trim(),
      affects: [],
      tokensUsed,
    };
  }

  // Validate type
  const rawType = String(parsed.type ?? 'decision').toLowerCase();
  const type: DecisionType = VALID_TYPES.has(rawType)
    ? (rawType as DecisionType)
    : 'decision';

  // Validate summary
  const summary = String(parsed.summary ?? '').substring(0, 200).trim() || 'No summary provided';

  // Validate affects
  let affects: string[] = [];
  if (Array.isArray(parsed.affects)) {
    affects = parsed.affects
      .filter((a): a is string => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase().trim())
      .slice(0, 10);
  }

  return { type, summary, affects, tokensUsed };
}
