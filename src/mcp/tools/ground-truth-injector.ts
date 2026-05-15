/**
 * 027/Track 4: GroundTruthInjector — pre-write semantic dedup for valis_store.
 *
 * Runs INSIDE `handleStore` before the database write, scoped to the project
 * the caller is authenticated against. Searches active decisions for semantic
 * neighbours of the candidate text and classifies the top match into one of
 * three similarity bands:
 *
 *   duplicate  [0.92, 1.0]  → short-circuit the write; return existing ID
 *   neighbour  [0.70, 0.92) → write proceeds; auto-populate `depends_on`
 *   none       [0.00, 0.70) → write proceeds unchanged
 *
 * The pattern mirrors `LinkExtractor` (025/T010): generic over `SearchFn`,
 * never-rejects, structured failure surface. The injector adds the duplicate
 * tier which is the load-bearing piece — it converts compounding duplicate
 * pollution into a no-op response with the canonical existing ID.
 *
 * Non-blocking guarantee (Constitution III): the returned Promise NEVER
 * rejects. Search timeouts, search errors, and validation failures all
 * collapse to `status: 'injector_failed'` so the parent `handleStore` can
 * write the decision and the operator can correlate writes-without-injection
 * with backend-health dashboards via the telemetry surface.
 */

export type SearchFn = (text: string) => Promise<Array<{
  id: string;
  similarity: number;
}>>;

export type MatchTier = 'duplicate' | 'neighbour' | 'none' | 'failed';

export type GroundTruthStatus =
  | 'duplicate_detected'
  | 'neighbours_linked'
  | 'neighbours_informational'
  | 'no_matches'
  | 'injector_failed';

export interface GroundTruthCandidate {
  id: string;
  similarity: number;
}

export interface GroundTruthContext {
  status: GroundTruthStatus;
  band: MatchTier;
  /** Present only when status === 'duplicate_detected'. */
  existing_id?: string;
  /** Neighbour candidates ordered by descending similarity, capped at maxCandidates. */
  candidates: GroundTruthCandidate[];
  /** Highest similarity observed (0 when the candidate list is empty). */
  top_similarity: number;
  /** Elapsed wall-clock time in ms (covers the SearchFn round-trip). */
  latency_ms: number;
  /** Sanitised reason string — only present on `status: 'injector_failed'`. */
  reason?: string;
}

export interface InjectGroundTruthOptions {
  /**
   * Duplicate-tier lower bound; default 0.92. Top match at or above this value
   * triggers the short-circuit. Clamped to [0.0, 1.0].
   */
  duplicateThreshold?: number;
  /**
   * Neighbour-tier lower bound; default 0.70. Top match in `[neighbourThreshold,
   * duplicateThreshold)` triggers auto-link. Clamped to [0.0, duplicateThreshold].
   */
  neighbourThreshold?: number;
  /** Top-N neighbour candidates surfaced; default 3. Clamped to [1, 10]. */
  maxCandidates?: number;
  /** Hard timeout for the SearchFn call; default 1500 ms. */
  timeoutMs?: number;
  /**
   * Set true when the caller supplied a non-empty `depends_on` array. The
   * injector then converts `status: 'neighbours_linked'` into
   * `status: 'neighbours_informational'` so the caller-supplied value wins.
   */
  callerSuppliedDependsOn?: boolean;
  /**
   * Set true when the caller supplied `replaces`. The duplicate short-circuit
   * is suppressed — the caller has explicit intent to write a new row that
   * supersedes another. The detected duplicate still appears in metadata for
   * audit/observability.
   */
  callerSuppliedReplaces?: boolean;
}

const DEFAULT_DUPLICATE_THRESHOLD = 0.92;
const DEFAULT_NEIGHBOUR_THRESHOLD = 0.7;
const DEFAULT_MAX_CANDIDATES = 3;
const DEFAULT_TIMEOUT_MS = 1500;
const HARD_CANDIDATE_CAP = 10;

function clamp01(input: number | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  if (!Number.isFinite(input)) return fallback;
  if (input < 0) return 0;
  if (input > 1) return 1;
  return input;
}

function sanitiseReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown_error';
}

function classifyBand(
  similarity: number,
  duplicateThreshold: number,
  neighbourThreshold: number,
): MatchTier {
  if (similarity >= duplicateThreshold) return 'duplicate';
  if (similarity >= neighbourThreshold) return 'neighbour';
  return 'none';
}

/**
 * Run the project-scoped `search` against `text` with a hard timeout, classify
 * the top match into one of the three similarity bands, and return a
 * structured context describing what `handleStore` should do.
 *
 * Never rejects. On any failure (timeout, thrown error, empty/invalid input),
 * returns `status: 'injector_failed'` with a sanitised `reason` and lets the
 * parent `handleStore` proceed unmodified.
 */
export async function injectGroundTruth(
  text: string,
  search: SearchFn,
  opts: InjectGroundTruthOptions = {},
): Promise<GroundTruthContext> {
  const duplicateThreshold = clamp01(
    opts.duplicateThreshold,
    DEFAULT_DUPLICATE_THRESHOLD,
  );
  const neighbourThresholdRaw = clamp01(
    opts.neighbourThreshold,
    DEFAULT_NEIGHBOUR_THRESHOLD,
  );
  // Defensive: never let neighbour exceed duplicate — would mis-classify.
  const neighbourThreshold = Math.min(neighbourThresholdRaw, duplicateThreshold);

  const rawMax = Math.floor(opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  const maxCandidates = Number.isFinite(rawMax)
    ? Math.max(1, Math.min(HARD_CANDIDATE_CAP, rawMax))
    : DEFAULT_MAX_CANDIDATES;
  const timeoutMs =
    Number.isFinite(opts.timeoutMs) && (opts.timeoutMs ?? 0) >= 0
      ? (opts.timeoutMs as number)
      : DEFAULT_TIMEOUT_MS;

  const started = Date.now();

  if (!text || text.trim().length === 0) {
    return {
      status: 'injector_failed',
      band: 'failed',
      candidates: [],
      top_similarity: 0,
      latency_ms: 0,
      reason: 'empty_text',
    };
  }

  // Hard-timeout the SearchFn (FR-010). Cleared in the finally block so a
  // resolved promise doesn't leave the timer running into next tick.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });

  let raw: Awaited<ReturnType<SearchFn>>;
  try {
    raw = await Promise.race([search(text), timeoutPromise]);
  } catch (err) {
    return {
      status: 'injector_failed',
      band: 'failed',
      candidates: [],
      top_similarity: 0,
      latency_ms: Date.now() - started,
      reason: sanitiseReason(err),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (!Array.isArray(raw)) {
    return {
      status: 'injector_failed',
      band: 'failed',
      candidates: [],
      top_similarity: 0,
      latency_ms: Date.now() - started,
      reason: 'invalid_search_result',
    };
  }

  // Empty result set OR project has zero active decisions (FR-013).
  if (raw.length === 0) {
    return {
      status: 'no_matches',
      band: 'none',
      candidates: [],
      top_similarity: 0,
      latency_ms: Date.now() - started,
    };
  }

  const ordered = [...raw].sort((a, b) => b.similarity - a.similarity);
  const top = ordered[0];
  const topSimilarity = top.similarity;
  const band = classifyBand(topSimilarity, duplicateThreshold, neighbourThreshold);

  // Duplicate tier — short-circuit unless the caller explicitly stated
  // they intend a new write that supersedes another (FR-008).
  if (band === 'duplicate' && !opts.callerSuppliedReplaces) {
    return {
      status: 'duplicate_detected',
      band,
      existing_id: top.id,
      candidates: [{ id: top.id, similarity: top.similarity }],
      top_similarity: topSimilarity,
      latency_ms: Date.now() - started,
    };
  }

  // Neighbour tier — auto-populate depends_on UNLESS the caller already
  // supplied one (FR-006). The replaces-suppression path also lands here
  // when duplicate was detected but explicit-supersede intent suppressed it.
  if (band === 'neighbour' || (band === 'duplicate' && opts.callerSuppliedReplaces)) {
    const candidates = ordered
      .filter((c) => c.similarity >= neighbourThreshold)
      .slice(0, maxCandidates)
      .map((c) => ({ id: c.id, similarity: c.similarity }));
    const status: GroundTruthStatus = opts.callerSuppliedDependsOn
      ? 'neighbours_informational'
      : 'neighbours_linked';
    return {
      status,
      band: band === 'duplicate' ? 'duplicate' : 'neighbour',
      candidates,
      top_similarity: topSimilarity,
      latency_ms: Date.now() - started,
    };
  }

  // None tier — no relevant matches; let the write proceed unchanged.
  return {
    status: 'no_matches',
    band: 'none',
    candidates: [],
    top_similarity: topSimilarity,
    latency_ms: Date.now() - started,
  };
}
