/**
 * Read-scope resolution for multi-project reads (gh#322).
 *
 * This is the one place that decides which projects a read covers. Every call
 * site — stdio MCP, hosted MCP, `valis search`, the web search route — calls it
 * rather than deriving the rule again, because the last time that logic was
 * duplicated a cross-project leak was reproduced (decision `a7cc9e9f`,
 * 2026-05-21) and had to be fixed in several places at once.
 *
 * Deliberately pure: no Supabase, no Qdrant, no filesystem. The caller supplies
 * `accessibleProjectIds`. That is what makes the security-critical branch
 * exhaustively testable instead of reachable only through mocks.
 *
 * The invariant the whole module exists to hold: **no input produces a scope
 * broader than the caller's access.** An empty result is an error, never a
 * licence to widen — see gh#324 for what the alternative cost.
 */

export interface ReadScopeInput {
  /** The `.valis.json` project. Also the write target. */
  activeProjectId: string | null;
  /** `linked_projects` from `.valis.json`. Widens reads, never writes. */
  linkedProjectIds: string[];
  /** Explicit `project_ids` MCP argument. Outranks both of the above. */
  requestedProjectIds?: string[];
  /** `all_projects` opt-in — every project the caller can reach. */
  allProjects: boolean;
  /** Everything the caller may read, resolved by the caller. */
  accessibleProjectIds: string[];
}

export interface ReadScope {
  /** Always the active project. Never widened by any read argument. */
  writeTarget: string | null;
  /** Projects the query will actually cover. */
  searched: string[];
  /**
   * Ids the caller named but may not read. Reported rather than dropped
   * silently: a caller told "nothing was found in A and B" when B was never
   * queried draws a false conclusion from a true statement.
   */
  denied: string[];
  error?: 'project_scope_required';
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function resolveReadScope(input: ReadScopeInput): ReadScope {
  const {
    activeProjectId,
    linkedProjectIds,
    requestedProjectIds,
    allProjects,
    accessibleProjectIds,
  } = input;

  // Precedence, highest first. An explicit argument beats a config file; a
  // config file beats nothing; nothing is an error, never a widening.
  let candidates: string[];
  if (requestedProjectIds && requestedProjectIds.length > 0) {
    candidates = requestedProjectIds;
  } else if (allProjects) {
    candidates = accessibleProjectIds;
  } else {
    candidates = activeProjectId ? [activeProjectId, ...linkedProjectIds] : [...linkedProjectIds];
  }

  const unique = dedupe(candidates);
  const accessible = new Set(accessibleProjectIds);

  const searched = unique.filter((id) => accessible.has(id));
  const denied = unique.filter((id) => !accessible.has(id));

  // The active project leads the list so callers reporting "searched in X, Y"
  // name the repo's own project first.
  if (activeProjectId && searched.includes(activeProjectId)) {
    searched.splice(searched.indexOf(activeProjectId), 1);
    searched.unshift(activeProjectId);
  }

  const scope: ReadScope = {
    writeTarget: activeProjectId,
    searched,
    denied,
  };

  if (searched.length === 0) {
    scope.error = 'project_scope_required';
  }

  return scope;
}
