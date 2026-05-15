/**
 * 032/Track 6: SearchFilterBuilder — translates an extended `valis_search`
 * schema into a Qdrant `Filter` shape.
 *
 * Pure function. No I/O, no Qdrant client, no embedding service. Given a set
 * of optional filter args, returns:
 *
 *   - `filter`: the Qdrant Filter object the caller composes into the full
 *     query alongside the project-scope predicate (which is built elsewhere,
 *     so the builder stays state-free).
 *   - `dropped_args`: filters the agent supplied that we silently ignored
 *     (unparseable date, unknown enum, inverted range — caller-recoverable).
 *   - `clamped_args`: filters whose values we coerced into the legal range
 *     (out-of-bounds float clamp — value-preserving recovery).
 *
 * Agent input is untrusted: an LLM that hallucinates a date string or
 * inverts a range must not be able to crash the search tool. Every invalid
 * input path collapses to a structured diagnostic instead of throwing.
 */

// ---------------------------------------------------------------------------
// Qdrant condition shapes — narrowly typed to the subset the builder emits.
// (The full @qdrant/js-client-rest types include too many alternatives to be
// useful here; we stay closed-world over the conditions we actually produce.)
// ---------------------------------------------------------------------------

export interface KeywordMatchCondition {
  key: string;
  match: { value: string | boolean };
}

export interface AnyMatchCondition {
  key: string;
  match: { any: string[] };
}

export interface RangeCondition {
  key: string;
  range: { gte?: number; lte?: number };
}

export type FilterCondition =
  | KeywordMatchCondition
  | AnyMatchCondition
  | RangeCondition;

export interface SearchFilter {
  must: FilterCondition[];
}

// ---------------------------------------------------------------------------
// Args + diagnostics
// ---------------------------------------------------------------------------

export interface SearchFilterArgs {
  type?: 'decision' | 'constraint' | 'pattern' | 'lesson';
  status?: 'active' | 'proposed' | 'deprecated' | 'superseded';
  min_confidence?: number;
  max_confidence?: number;
  created_after?: string;
  created_before?: string;
  author?: string;
  affects?: string[];
  pinned?: boolean;
  source?: 'mcp_store' | 'file_watcher' | 'stop_hook' | 'seed';
  outcome?: 'success' | 'failed' | 'partial' | 'unknown';
}

export interface DroppedArg {
  field: string;
  reason: string;
}

export interface ClampedArg {
  field: string;
  original: unknown;
  clamped: unknown;
}

export interface FilterBuildResult {
  filter: SearchFilter;
  dropped_args: DroppedArg[];
  clamped_args: ClampedArg[];
}

// ---------------------------------------------------------------------------
// Enum allow-lists (closed-world) — mirror SearchFilterArgs unions
// ---------------------------------------------------------------------------

const TYPE_VALUES: ReadonlySet<string> = new Set([
  'decision',
  'constraint',
  'pattern',
  'lesson',
]);
const STATUS_VALUES: ReadonlySet<string> = new Set([
  'active',
  'proposed',
  'deprecated',
  'superseded',
]);
const SOURCE_VALUES: ReadonlySet<string> = new Set([
  'mcp_store',
  'file_watcher',
  'stop_hook',
  'seed',
]);
const OUTCOME_VALUES: ReadonlySet<string> = new Set([
  'success',
  'failed',
  'partial',
  'unknown',
]);

function clampUnit(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Parse an ISO-8601 date string. Returns the timestamp in ms or null if the
 * string is malformed. We use `Date.parse` + a finite check rather than a
 * stricter regex so reasonable variants ("2026-05-01", full ISO with offset,
 * `Z`-suffixed UTC) all work but `"yesterday"`, `"now"`, garbage strings
 * cleanly reject.
 */
function parseIsoDate(input: string): number | null {
  if (typeof input !== 'string' || input.trim().length === 0) return null;
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the Qdrant filter for the structured args. Pure: identical inputs
 * yield identical outputs (including the order of `dropped_args` and
 * `clamped_args` diagnostics, which follow the FR field order so callers
 * get a stable trace).
 *
 * The caller composes this builder's output WITH the project-scope predicate
 * (built by the existing search transport) so we stay state-free here.
 */
export function buildSearchFilter(args: SearchFilterArgs): FilterBuildResult {
  const must: FilterCondition[] = [];
  const dropped: DroppedArg[] = [];
  const clamped: ClampedArg[] = [];

  // ── type — already supported pre-feature; mirrored here so the builder is
  //    the single source of truth when callers move to it from the legacy path.
  if (args.type !== undefined) {
    if (TYPE_VALUES.has(args.type)) {
      must.push({ key: 'type', match: { value: args.type } });
    } else {
      dropped.push({ field: 'type', reason: 'unknown_enum_value' });
    }
  }

  // ── status — keyword equality, closed-world enum.
  if (args.status !== undefined) {
    if (STATUS_VALUES.has(args.status)) {
      must.push({ key: 'status', match: { value: args.status } });
    } else {
      dropped.push({ field: 'status', reason: 'unknown_enum_value' });
    }
  }

  // ── confidence range — clamp out-of-bounds floats, drop inverted bounds.
  let minConf = args.min_confidence;
  let maxConf = args.max_confidence;

  if (minConf !== undefined) {
    if (!Number.isFinite(minConf)) {
      dropped.push({ field: 'min_confidence', reason: 'not_a_number' });
      minConf = undefined;
    } else if (minConf < 0 || minConf > 1) {
      const c = clampUnit(minConf);
      clamped.push({ field: 'min_confidence', original: minConf, clamped: c });
      minConf = c;
    }
  }
  if (maxConf !== undefined) {
    if (!Number.isFinite(maxConf)) {
      dropped.push({ field: 'max_confidence', reason: 'not_a_number' });
      maxConf = undefined;
    } else if (maxConf < 0 || maxConf > 1) {
      const c = clampUnit(maxConf);
      clamped.push({ field: 'max_confidence', original: maxConf, clamped: c });
      maxConf = c;
    }
  }
  if (minConf !== undefined && maxConf !== undefined && minConf > maxConf) {
    // Drop the inverted bound — keep the surviving lower bound as the floor.
    dropped.push({ field: 'max_confidence', reason: 'inverted_range' });
    maxConf = undefined;
  }
  if (minConf !== undefined || maxConf !== undefined) {
    const range: { gte?: number; lte?: number } = {};
    if (minConf !== undefined) range.gte = minConf;
    if (maxConf !== undefined) range.lte = maxConf;
    must.push({ key: 'confidence', range });
  }

  // ── created_at range — ISO-8601 parse, drop on invalid format, drop inverted.
  let afterMs = args.created_after !== undefined ? parseIsoDate(args.created_after) : null;
  let beforeMs = args.created_before !== undefined ? parseIsoDate(args.created_before) : null;
  if (args.created_after !== undefined && afterMs === null) {
    dropped.push({ field: 'created_after', reason: 'invalid_date_format' });
  }
  if (args.created_before !== undefined && beforeMs === null) {
    dropped.push({ field: 'created_before', reason: 'invalid_date_format' });
  }
  if (afterMs !== null && beforeMs !== null && afterMs > beforeMs) {
    dropped.push({ field: 'created_before', reason: 'inverted_range' });
    beforeMs = null;
  }
  if (afterMs !== null || beforeMs !== null) {
    // Qdrant accepts numeric epoch-ms in the range predicate for datetime
    // fields. Using ms (not seconds) matches the payload `created_at` which
    // stores `new Date().toISOString()` and is indexed as datetime.
    const range: { gte?: number; lte?: number } = {};
    if (afterMs !== null) range.gte = afterMs;
    if (beforeMs !== null) range.lte = beforeMs;
    must.push({ key: 'created_at', range });
  }

  // ── author — free-text keyword equality.
  if (args.author !== undefined) {
    if (typeof args.author === 'string' && args.author.trim().length > 0) {
      must.push({ key: 'author', match: { value: args.author } });
    } else {
      dropped.push({ field: 'author', reason: 'empty_or_invalid' });
    }
  }

  // ── affects — match.any over array payload. Empty array = no constraint.
  if (args.affects !== undefined) {
    if (Array.isArray(args.affects)) {
      const cleaned = args.affects.filter(
        (a) => typeof a === 'string' && a.trim().length > 0,
      );
      if (cleaned.length > 0) {
        must.push({ key: 'affects', match: { any: cleaned } });
      }
      // empty array → no constraint added; that is FR-005 behaviour, not an error.
    } else {
      dropped.push({ field: 'affects', reason: 'not_an_array' });
    }
  }

  // ── pinned — bool equality.
  if (args.pinned !== undefined) {
    if (typeof args.pinned === 'boolean') {
      must.push({ key: 'pinned', match: { value: args.pinned } });
    } else {
      dropped.push({ field: 'pinned', reason: 'not_a_boolean' });
    }
  }

  // ── source — closed-world enum.
  if (args.source !== undefined) {
    if (SOURCE_VALUES.has(args.source)) {
      must.push({ key: 'source', match: { value: args.source } });
    } else {
      dropped.push({ field: 'source', reason: 'unknown_enum_value' });
    }
  }

  // ── outcome — closed-world enum (column ships with 028/Track 5a).
  if (args.outcome !== undefined) {
    if (OUTCOME_VALUES.has(args.outcome)) {
      must.push({ key: 'outcome', match: { value: args.outcome } });
    } else {
      dropped.push({ field: 'outcome', reason: 'unknown_enum_value' });
    }
  }

  return {
    filter: { must },
    dropped_args: dropped,
    clamped_args: clamped,
  };
}

/**
 * The set of new structured-filter fields the builder consumes. Exposed for
 * telemetry — `valis_search` emits the subset that was actually exercised
 * on each call so the rollout dashboard can prune unused dimensions (FR-014).
 */
export const STRUCTURED_FILTER_FIELDS = [
  'type',
  'status',
  'min_confidence',
  'max_confidence',
  'created_after',
  'created_before',
  'author',
  'affects',
  'pinned',
  'source',
  'outcome',
] as const;

export type StructuredFilterField = (typeof STRUCTURED_FILTER_FIELDS)[number];

/**
 * Compute the subset of structured filter fields present (non-undefined) in
 * the args. Useful for `filter_dim_used` telemetry.
 */
export function usedFilterDimensions(args: SearchFilterArgs): StructuredFilterField[] {
  return STRUCTURED_FILTER_FIELDS.filter(
    (field) => (args as Record<string, unknown>)[field] !== undefined,
  );
}
