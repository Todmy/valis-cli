/**
 * T053: Anthropic Haiku provider implementing EnrichmentProvider.
 *
 * Uses raw fetch() to call the Anthropic Messages API with
 * claude-3-5-haiku-latest. No SDK dependency required.
 */

import type { EnrichmentProvider, ProviderEnrichmentResult } from './provider.js';
import { ENRICHMENT_SYSTEM_PROMPT, parseEnrichmentResponse } from './provider.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-5-haiku-latest';
const MAX_TOKENS = 300;

export class AnthropicProvider implements EnrichmentProvider {
  name = 'anthropic';
  /** ~$0.001 per decision (est. 500 input + 200 output tokens). */
  estimatedCostPerToken = 0.000001;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async enrich(text: string): Promise<ProviderEnrichmentResult> {
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: ENRICHMENT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    };

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const responseText = data.content
      ?.filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('') ?? '';

    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const tokensUsed = inputTokens + outputTokens;

    return parseEnrichmentResponse(responseText, tokensUsed);
  }
}
