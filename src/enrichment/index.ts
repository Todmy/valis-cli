// Enrichment module — LLM provider abstraction, cost tracking, runner
// Phase 3: Search Intelligence, Data Quality & Growth

export type { EnrichmentProvider, ProviderEnrichmentResult } from './provider.js';
export { ENRICHMENT_SYSTEM_PROMPT, parseEnrichmentResponse } from './provider.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export { checkCeiling, trackUsage, getDailyCost, DEFAULT_CEILING_CENTS } from './cost-tracker.js';
export type { CeilingCheck } from './cost-tracker.js';
export { runEnrichment, getProvider } from './runner.js';
export type { EnrichOptions, EnrichmentReport } from './runner.js';
