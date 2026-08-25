/**
 * Production guard for the E2E suite (gh#318).
 *
 * The hosted E2E suite registers real orgs through the public `/api/register`
 * path. Pointed at the production Supabase project it writes production rows
 * and production vectors, which is exactly what happened on 2026-04-12: one run
 * leaked 30 `e2e-test-*` orgs (30 members, 30 projects, 58 decisions, 58 live
 * points in `decisions_v2`) and nothing noticed for four months.
 *
 * This module makes that structurally impossible. It is imported for its side
 * effect by `helpers.ts`, so the throw happens at module-evaluation time —
 * before any test body, before any `beforeAll`, before a single HTTP call.
 *
 * There is deliberately NO override env var. If the configured backend is
 * production, the suite does not run. Point it at a non-production Supabase
 * project instead.
 */

/**
 * Hosts that must never be written to by the test suite.
 *
 * Kept as literals rather than importing `HOSTED_SUPABASE_URL` from
 * `src/types.ts`: that constant is `process.env.VALIS_SUPABASE_URL ?? '<prod>'`,
 * so a stray `VALIS_SUPABASE_URL` in the environment would silently move the
 * guard off production — the guard would then bless the very URL it exists to
 * block. The literal cannot be moved from the environment.
 */
export const PRODUCTION_SUPABASE_HOSTS: readonly string[] = [
  'rmawxpdaudinbansjfpd.supabase.co',
];

/** Hosts of the production API (the `/api/register` front door). */
export const PRODUCTION_API_HOSTS: readonly string[] = [
  'valis.krukit.co',
  'valis-web.vercel.app',
];

/** Lowercased hostname of a URL, or `null` when it does not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** True when `url` points at the production Supabase project. */
export function isProductionSupabase(url: string): boolean {
  const host = hostOf(url);
  return host !== null && PRODUCTION_SUPABASE_HOSTS.includes(host);
}

/** True when `url` points at the production API deployment. */
export function isProductionApi(url: string): boolean {
  const host = hostOf(url);
  return host !== null && PRODUCTION_API_HOSTS.includes(host);
}

const FAILURE_MESSAGE = [
  'VALIS E2E REFUSES TO RUN AGAINST PRODUCTION.',
  '',
  'The E2E suite creates real orgs via /api/register and they are never rolled',
  'back by the backend. Running it against production pollutes live data and the',
  'live decisions_v2 search index (gh#318: 30 leaked orgs, undetected for 4 months).',
  '',
  'Point VALIS_E2E_API_URL / VALIS_E2E_SUPABASE_URL at a NON-production',
  'Supabase project + deployment, or leave them unset to skip the suite.',
  '',
  'There is no override flag. This is intentional.',
].join('\n');

/**
 * Throw when the configured E2E backend is production.
 *
 * No-op when the E2E env vars are unset — that is the ordinary "suite skipped"
 * state for the 166 non-E2E test files.
 */
export function assertNotProduction(
  supabaseUrl: string,
  apiUrl: string,
): void {
  const offenders: string[] = [];
  if (supabaseUrl && isProductionSupabase(supabaseUrl)) {
    offenders.push(`  VALIS_E2E_SUPABASE_URL = ${supabaseUrl}`);
  }
  if (apiUrl && isProductionApi(apiUrl)) {
    offenders.push(`  VALIS_E2E_API_URL      = ${apiUrl}`);
  }

  if (offenders.length === 0) return;

  throw new Error(
    `${FAILURE_MESSAGE}\n\nOffending configuration:\n${offenders.join('\n')}\n`,
  );
}
