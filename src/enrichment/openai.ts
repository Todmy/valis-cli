/**
 * T054: OpenAI GPT-4o-mini provider implementing EnrichmentProvider.
 *
 * Uses raw fetch() to call the OpenAI Chat Completions API.
 * No SDK dependency required.
 */

import type { EnrichmentProvider, ProviderEnrichmentResult } from './provider.js';
import { ENRICHMENT_SYSTEM_PROMPT, parseEnrichmentResponse } from './provider.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o-mini';
const MAX_TOKENS = 300;

export class OpenAIProvider implements EnrichmentProvider {
  name = 'openai';
  /** ~$0.001 per decision (similar token economics to Haiku). */
  estimatedCostPerToken = 0.0000006;

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async enrich(text: string): Promise<ProviderEnrichmentResult> {
    const body = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: ENRICHMENT_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    };

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const responseText = data.choices?.[0]?.message?.content ?? '';
    const tokensUsed = data.usage?.total_tokens ?? 0;

    return parseEnrichmentResponse(responseText, tokensUsed);
  }
}
