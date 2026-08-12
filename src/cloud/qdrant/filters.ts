/**
 * Qdrant payload-filter builders — project scope + structured-filter merge.
 *
 * Split out of `search.ts` (gh#322) so the web package can import the exact
 * same builders instead of keeping its own copy: the duplicated pair in
 * `packages/web/src/app/api/search/route.ts` had already drifted from this one
 * (no `legacyFallback`, no payload merge). This module deliberately pulls in
 * nothing — no client, no embeddings — so importing it stays cheap.
 *
 * @module cloud/qdrant/filters
 */

/**
 * Build a Qdrant filter clause for project-scoped queries.
 *
 * During migration, some points may not have `project_id` in their payload.
 * This builder produces a `should` clause that matches either:
 *   1. Points with the correct `project_id`, OR
 *   2. Points where `project_id` is missing (legacy points).
 *
 * Once migration is complete, callers can switch to strict mode by passing
 * `{ legacyFallback: false }`.
 */
export function buildProjectFilter(
  orgId: string,
  projectId?: string,
  options?: { type?: string; legacyFallback?: boolean },
): Record<string, unknown> {
  const mustClauses: Record<string, unknown>[] = [
    { key: 'org_id', match: { value: orgId } },
  ];

  if (options?.type) {
    mustClauses.push({ key: 'type', match: { value: options.type } });
  }

  // When no projectId is provided, return org-scoped filter (cross-project / legacy)
  if (!projectId) {
    return { must: mustClauses };
  }

  const useFallback = options?.legacyFallback ?? true;

  if (useFallback) {
    // Match project_id OR missing project_id (legacy points without the field).
    // Qdrant's IsNull condition matches points where the field does not exist
    // or is explicitly null.
    mustClauses.push({
      should: [
        { key: 'project_id', match: { value: projectId } },
        { is_null: { key: 'project_id' } },
      ],
    });
  } else {
    mustClauses.push({ key: 'project_id', match: { value: projectId } });
  }

  return { must: mustClauses };
}

/**
 * Build a Qdrant filter for cross-project (--all-projects) search.
 *
 * Accepts an array of project IDs the member has access to and builds a
 * `should` clause so results from any accessible project are returned.
 * Also includes legacy points (missing project_id) via fallback.
 */
export function buildAllProjectsFilter(
  orgId: string,
  projectIds: string[],
  options?: { type?: string },
): Record<string, unknown> {
  const mustClauses: Record<string, unknown>[] = [
    { key: 'org_id', match: { value: orgId } },
  ];

  if (options?.type) {
    mustClauses.push({ key: 'type', match: { value: options.type } });
  }

  if (projectIds.length > 0) {
    // Use match.any for multi-value matching + is_null for legacy points
    mustClauses.push({
      should: [
        { key: 'project_id', match: { any: projectIds } },
        { is_null: { key: 'project_id' } },
      ],
    });
  }

  return { must: mustClauses };
}

/**
 * 032/Track 6 + gh#325 — compose a project-scope predicate with the caller's
 * structured filter. Both carry a `must[]`, so a concat is the whole rule.
 *
 * Extracted from `hybridSearch` when gh#325 revealed the multi-project path
 * had no equivalent: a `created_after` or `status` filter silently did nothing
 * once the search spanned more than one project. One helper, both call sites.
 */
export function composePayloadFilter(
  baseFilter: Record<string, unknown>,
  payloadFilter: { must: unknown[] } | undefined,
): Record<string, unknown> {
  if (!payloadFilter || !Array.isArray(payloadFilter.must) || payloadFilter.must.length === 0) {
    return baseFilter;
  }
  const baseMust = Array.isArray(baseFilter.must) ? (baseFilter.must as unknown[]) : [];
  return { ...baseFilter, must: [...baseMust, ...payloadFilter.must] };
}

