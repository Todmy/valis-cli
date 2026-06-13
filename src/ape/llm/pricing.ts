/**
 * 285/T002: per-model USD/M-token price table + cost computation.
 *
 * The three model slugs are PINNED by docs/krukit/285-ape-harness/plan.md
 * ("Pinned decisions"): worker=haiku-4.5, judge=opus-4-8, rewriter=opus-4-8.
 * The table is exhaustive over `ModelSlug` via `Record<ModelSlug, …>` so adding
 * a slug to the type without a price entry is a tsc error.
 *
 * Prices are per-MILLION-token USD, sourced from the live Gateway catalogue
 * (curl https://ai-gateway.vercel.sh/v1/models | jq '.data[]|.id,.pricing')
 * captured 2026-06-13. Catalogue values are per-token, so ×1e6.
 *
 * GOTCHA (dated 2026-06-13): the catalogue exposes the Opus slug as
 * `anthropic/claude-opus-4.8` (dot), NOT `anthropic/claude-opus-4-8` (hyphen)
 * as pinned in the plan. The hyphen form is the canonical type key here (other
 * tasks reference it); `gatewaySlug()` maps it to the dot form the API accepts.
 *
 * Catalogue snapshot (2026-06-13, per-token → ×1e6 = per-M):
 *   anthropic/claude-haiku-4.5: input 1.0, output 5.0, cache_read 0.1
 *   anthropic/claude-opus-4.8:  input 5.0, output 25.0, cache_read 0.5
 */

export type ModelSlug =
  | 'anthropic/claude-haiku-4.5'
  | 'anthropic/claude-opus-4-8';

export interface ModelPrice {
  /** USD per 1M fresh input tokens. */
  inUsdPerM: number;
  /** USD per 1M output tokens. */
  outUsdPerM: number;
  /** USD per 1M cached-read input tokens. */
  cachedInUsdPerM: number;
}

export const PRICE: Record<ModelSlug, ModelPrice> = {
  'anthropic/claude-haiku-4.5': { inUsdPerM: 1.0, outUsdPerM: 5.0, cachedInUsdPerM: 0.1 },
  'anthropic/claude-opus-4-8': { inUsdPerM: 5.0, outUsdPerM: 25.0, cachedInUsdPerM: 0.5 },
};

/**
 * Maps a pinned `ModelSlug` to the id the Gateway catalogue actually accepts.
 * See the dated GOTCHA in the module header — Opus is `4.8` (dot) on the wire.
 */
export function gatewaySlug(slug: ModelSlug): string {
  return slug === 'anthropic/claude-opus-4-8' ? 'anthropic/claude-opus-4.8' : slug;
}

/**
 * Compute call cost in USD. Cached input is billed at the cached-read rate;
 * `inputTokens` is the FRESH (non-cached) input count. Fail-loud on an unknown
 * slug — never silently price a model at $0 (would defeat the budget cap).
 */
export function costUsd(
  slug: ModelSlug,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const p = PRICE[slug];
  if (!p) {
    throw new Error(`pricing: unknown model slug "${slug}"`);
  }
  return (
    (inputTokens * p.inUsdPerM +
      outputTokens * p.outUsdPerM +
      cachedInputTokens * p.cachedInUsdPerM) /
    1_000_000
  );
}
