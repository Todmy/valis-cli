/**
 * EmbeddingStrategy abstraction (013-semantic-embeddings).
 *
 * Resolves the embedding generation path at runtime:
 *  - **Server mode** — delegates to Qdrant Cloud managed inference via the
 *    `Document { text, model }` upsert/query format. Default for hosted users.
 *  - **Client mode** — generates dense vectors locally via the optional
 *    `fastembed` ONNX runtime. Used by community / self-hosted deployments
 *    where managed inference is not available. BM25 sparse vectors are not
 *    produced in client mode (FR-009 — fall back to dense-only).
 *
 * The contract is documented in
 * `specs/013-semantic-embeddings/contracts/embedding-strategy.md`.
 */

import type { QdrantClient } from '@qdrant/js-client-rest';

// ---------------------------------------------------------------------------
// Constants — versioned for the bge-m3 migration (US4 / 019-launch-readiness)
// ---------------------------------------------------------------------------

/** v1 (legacy): English-dominant, 384-dim. */
export const DENSE_MODEL_V1 = 'sentence-transformers/all-MiniLM-L6-v2' as const;
export const VECTOR_SIZE_V1 = 384;
/** ~4 chars/token × 512-token window ≈ 2000 char safe ceiling. */
export const MAX_EMBEDDING_INPUT_CHARS_V1 = 2000;

/** v2 (active target): intfloat/multilingual-e5-small, 100+ langs, 384-dim.
 *
 * Why e5-SMALL (not -large): empirical Qdrant Cloud catalog probe (2026-05-03)
 * showed neither bge-m3 nor e5-large is in the free-tier catalog. e5-small is
 * the only free multilingual option. Critically, 384d matches the legacy
 * MiniLM dimensionality — so the prod migration becomes a one-line env flip
 * (no collection drop+recreate). PBaaS A/B test confirmed +16.7pp UA, +23.3pp
 * RU, +40pp JA recall@5 vs MiniLM with zero EN regression — see
 * specs/019-launch-readiness/baselines/pbaas-multilingual-ab-test.md. */
export const DENSE_MODEL_V2 = 'intfloat/multilingual-e5-small' as const;
export const VECTOR_SIZE_V2 = 384;
/** e5-small 512-token window. UA/PL tokenize to ~1.3-1.5x more tokens/char
 * than EN, so 1500 char chunks (1.0x) give safety margin under multilingual
 * tokenizers; chunking module enforces this ceiling. */
export const MAX_EMBEDDING_INPUT_CHARS_V2 = 2000;

export type EmbeddingVersion = 'v1' | 'v2';

/**
 * Active embedding version, gated by env var `EMBEDDING_ACTIVE_VERSION`.
 * Default `v1` until the prod cutover. After alias swap → set to `v2`.
 */
export function getActiveEmbeddingVersion(): EmbeddingVersion {
  return process.env.EMBEDDING_ACTIVE_VERSION === 'v2' ? 'v2' : 'v1';
}

/**
 * Dual-write window flag. When `EMBEDDING_DUAL_WRITE=1`, every embed write
 * produces vectors for BOTH versions and writes to BOTH collections so the
 * inactive version stays warm during the migration / 7-day retention.
 */
export function isDualWriteEnabled(): boolean {
  return process.env.EMBEDDING_DUAL_WRITE === '1';
}

export function getDenseModel(
  version: EmbeddingVersion = getActiveEmbeddingVersion(),
): string {
  return version === 'v2' ? DENSE_MODEL_V2 : DENSE_MODEL_V1;
}

export function getVectorSize(
  version: EmbeddingVersion = getActiveEmbeddingVersion(),
): number {
  return version === 'v2' ? VECTOR_SIZE_V2 : VECTOR_SIZE_V1;
}

export function getMaxEmbeddingInputChars(
  version: EmbeddingVersion = getActiveEmbeddingVersion(),
): number {
  return version === 'v2' ? MAX_EMBEDDING_INPUT_CHARS_V2 : MAX_EMBEDDING_INPUT_CHARS_V1;
}

/**
 * Backward-compat exports — resolved at module load against active version.
 * Hosted users redeploy on env-var flip, so a one-shot resolution is enough.
 */
export const DENSE_MODEL = getDenseModel();
export const VECTOR_SIZE = getVectorSize();
export const MAX_EMBEDDING_INPUT_CHARS = getMaxEmbeddingInputChars();

export const BM25_MODEL = 'Qdrant/bm25' as const;
export const DENSE_VECTOR_NAME = '' as const;
export const BM25_VECTOR_NAME = 'bm25' as const;
export const PROBE_POINT_ID = '00000000-0000-0000-0000-000000000001';
export const PROBE_TEXT = 'embedding strategy detection probe';
export const REINDEX_BATCH_SIZE = 50;
export const REINDEX_ABORT_THRESHOLD = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QdrantDocument {
  text: string;
  model: string;
}

export type UpsertVector =
  | Record<string, QdrantDocument>
  | Record<string, number[]>;

export type DenseQueryInput = QdrantDocument | number[];
export type SparseQueryInput = QdrantDocument | null;

export interface EmbeddingStrategy {
  readonly mode: 'server' | 'client';
  readonly supportsHybrid: boolean;
  vectorForUpsert(text: string): UpsertVector;
  queryForDense(text: string): DenseQueryInput;
  queryForSparse(text: string): SparseQueryInput;
}

// ---------------------------------------------------------------------------
// Quota / rate-limit error class (FR-023a, FR-023b)
// ---------------------------------------------------------------------------

/**
 * Structured error raised when the embedding service rejects a request due
 * to quota or rate-limit exhaustion. Carries enough state for the operator
 * (or the offline queue) to decide on remediation.
 *
 * Per spec clarification Q4: this error is thrown by the Qdrant write path,
 * caught by `upsertDecision` (which routes the decision into the offline
 * queue per FR-023a) and by `reindexAllPoints` (which aborts and reports
 * partial progress per FR-023b). The web search route detects it via the
 * raw 429 response and returns a structured 429 to the dashboard.
 */
export class EmbeddingQuotaError extends Error {
  readonly code = 'embedding_quota_exhausted' as const;

  constructor(
    public readonly tokensUsed: number | undefined,
    public readonly tokensLimit: number | undefined,
    public readonly resetAt: string | undefined,
    public readonly remediationHint: string,
    public readonly strategyMode: 'server' | 'client',
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingQuotaError';
  }
}

/**
 * Inspect an arbitrary thrown value and convert it into an
 * `EmbeddingQuotaError` if it looks like a quota / rate-limit failure.
 * Returns `null` for any other shape, so callers can re-throw the original
 * error untouched.
 *
 * Heuristics:
 *  - HTTP status === 429 (Qdrant client surfaces this on the error object)
 *  - Error message matches /quota|rate.?limit|exceeded|token.*limit/i
 */
export function parseQuotaError(
  err: unknown,
  mode: 'server' | 'client',
): EmbeddingQuotaError | null {
  if (!(err instanceof Error)) return null;

  const status = (err as Error & { status?: number }).status;
  const message = err.message || '';
  const looksLikeQuota =
    status === 429 || /quota|rate.?limit|exceeded|token.*limit/i.test(message);

  if (!looksLikeQuota) return null;

  return new EmbeddingQuotaError(
    undefined,
    undefined,
    undefined,
    'Wait for the quota window to reset, upgrade the inference tier, or switch to client embedding mode (set QDRANT_EMBEDDING_STRATEGY=client).',
    mode,
    message,
  );
}

// ---------------------------------------------------------------------------
// Truncation helper (FR-013b)
// ---------------------------------------------------------------------------

/**
 * Truncate text to the active embedding model's safe character ceiling.
 * Emits a one-line WARN to stderr when truncation occurs so operators can
 * spot abnormally long inputs. The full text MUST remain in payload —
 * callers truncate only the embedding input, not the stored payload.
 */
export function truncateForEmbedding(
  text: string,
  version: EmbeddingVersion = getActiveEmbeddingVersion(),
): string {
  const ceiling = getMaxEmbeddingInputChars(version);
  if (text.length <= ceiling) return text;
  console.warn(
    `[embedding] truncated input from ${text.length} to ${ceiling} chars (version=${version})`,
  );
  return text.slice(0, ceiling);
}

// ---------------------------------------------------------------------------
// ServerInferenceStrategy — Qdrant Cloud managed inference
// ---------------------------------------------------------------------------

export class ServerInferenceStrategy implements EmbeddingStrategy {
  readonly mode = 'server' as const;
  readonly supportsHybrid = true;
  readonly version: EmbeddingVersion;

  constructor(version: EmbeddingVersion = getActiveEmbeddingVersion()) {
    this.version = version;
  }

  vectorForUpsert(text: string): UpsertVector {
    return {
      [DENSE_VECTOR_NAME]: { text, model: getDenseModel(this.version) },
      [BM25_VECTOR_NAME]: { text, model: BM25_MODEL },
    };
  }

  queryForDense(text: string): DenseQueryInput {
    return { text, model: getDenseModel(this.version) };
  }

  queryForSparse(text: string): SparseQueryInput {
    return { text, model: BM25_MODEL };
  }
}

// ---------------------------------------------------------------------------
// ClientEmbeddingStrategy — local fastembed ONNX
// ---------------------------------------------------------------------------

/**
 * Internal type for the lazily-imported fastembed module surface.
 * Mirrors the parts of fastembed@^2.1 that we actually call.
 */
interface FastEmbedModelInstance {
  queryEmbed(text: string): Promise<number[] | Float32Array>;
}

interface FastEmbedFlagEmbeddingStatic {
  init(opts: { model: unknown }): Promise<FastEmbedModelInstance>;
}

interface FastEmbedModule {
  FlagEmbedding: FastEmbedFlagEmbeddingStatic;
  EmbeddingModel: { AllMiniLML6V2: unknown };
}

export class ClientEmbeddingStrategy implements EmbeddingStrategy {
  readonly mode = 'client' as const;
  readonly supportsHybrid = false;

  // Loaded model is cached on the instance after first use to amortize the
  // ~500ms init cost across multiple embed calls in the same process.
  private _modelPromise: Promise<FastEmbedModelInstance> | null = null;

  vectorForUpsert(_text: string): UpsertVector {
    throw new Error(
      'ClientEmbeddingStrategy requires async vectorForUpsertAsync — call await strategy.vectorForUpsertAsync(text) instead.',
    );
  }

  queryForDense(_text: string): DenseQueryInput {
    throw new Error(
      'ClientEmbeddingStrategy requires async queryForDenseAsync — call await strategy.queryForDenseAsync(text) instead.',
    );
  }

  queryForSparse(_text: string): SparseQueryInput {
    return null;
  }

  async vectorForUpsertAsync(text: string): Promise<UpsertVector> {
    const vec = await this._embed(text);
    return { [DENSE_VECTOR_NAME]: vec };
  }

  async queryForDenseAsync(text: string): Promise<number[]> {
    return this._embed(text);
  }

  /** Test seam — subclasses override `_embed` to inject a fake embedder. */
  protected async _embed(text: string): Promise<number[]> {
    const model = await this._loadModel();
    const result = await model.queryEmbed(text);
    return Array.from(result);
  }

  private _loadModel(): Promise<FastEmbedModelInstance> {
    if (this._modelPromise) return this._modelPromise;
    this._modelPromise = (async () => {
      let mod: FastEmbedModule;
      try {
        // The package name is read from a variable so webpack's static
        // analyzer cannot resolve the dynamic import target at build time.
        // fastembed has native onnxruntime bindings (.node binaries) that
        // webpack cannot package. The web package pulls this file in
        // transitively via /api/mcp but never reaches this branch (server
        // inference mode only). Variable-based dynamic imports become
        // runtime requires evaluated by Node's ESM loader, bypassing
        // webpack's module graph entirely.
        const pkg = process.env.VALIS_FASTEMBED_PKG ?? 'fastembed';
        mod = (await import(pkg)) as unknown as FastEmbedModule;
      } catch (innerErr) {
        const inner = (innerErr as Error)?.message ?? String(innerErr);
        throw new Error(
          `fastembed is required for client-side embeddings but is not installed. Install it with: npm install fastembed. Original error: ${inner}`,
        );
      }
      return mod.FlagEmbedding.init({
        model: mod.EmbeddingModel.AllMiniLML6V2,
      });
    })();
    return this._modelPromise;
  }
}

// ---------------------------------------------------------------------------
// detectEmbeddingStrategy — auto-detection probe with per-process cache
// ---------------------------------------------------------------------------

let _cachedStrategy: EmbeddingStrategy | null = null;
let _detectionInFlight: Promise<EmbeddingStrategy> | null = null;

/**
 * Resolve the embedding strategy for this process.
 *
 * 1. Returns the cached strategy if one exists.
 * 2. Honors `QDRANT_EMBEDDING_STRATEGY=server|client` env override (no probe).
 * 3. Otherwise probes by upserting a fixed-UUID point that requests server-side
 *    inference. If the upsert succeeds → server mode. If it throws → client mode.
 *    The probe point is best-effort deleted after a successful upsert.
 *
 * The probe writes a synthetic `org_id: '__probe__'` payload field — real
 * searches always filter by the caller's actual `org_id` and will never match
 * `'__probe__'`, providing defense-in-depth tenant isolation if the delete fails.
 *
 * Concurrent first-time callers in the same process share a single probe via
 * the `_detectionInFlight` promise.
 */
export async function detectEmbeddingStrategy(
  qdrant: QdrantClient,
  collectionName: string,
): Promise<EmbeddingStrategy> {
  if (_cachedStrategy) return _cachedStrategy;
  if (_detectionInFlight) return _detectionInFlight;

  const override = process.env.QDRANT_EMBEDDING_STRATEGY;
  if (override === 'server') {
    _cachedStrategy = new ServerInferenceStrategy();
    return _cachedStrategy;
  }
  if (override === 'client') {
    _cachedStrategy = new ClientEmbeddingStrategy();
    return _cachedStrategy;
  }

  _detectionInFlight = (async () => {
    const probeModel = getDenseModel();
    try {
      await qdrant.upsert(collectionName, {
        points: [
          {
            id: PROBE_POINT_ID,
            // Cast: the JS client `VectorStruct` type does not perfectly model
            // named-vectors-with-Document. Runtime accepts this shape per
            // Qdrant 1.13 REST schema.
            vector: {
              [DENSE_VECTOR_NAME]: { text: PROBE_TEXT, model: probeModel },
              [BM25_VECTOR_NAME]: { text: PROBE_TEXT, model: BM25_MODEL },
            } as never,
            payload: { org_id: '__probe__', __probe: true },
          },
        ],
      });
      // Best-effort cleanup — errors ignored.
      try {
        await qdrant.delete(collectionName, { points: [PROBE_POINT_ID] });
      } catch {
        // Ignored: stale probe will be overwritten on the next probe.
      }
      _cachedStrategy = new ServerInferenceStrategy();
    } catch {
      _cachedStrategy = new ClientEmbeddingStrategy();
    }
    _detectionInFlight = null;
    return _cachedStrategy!;
  })();

  return _detectionInFlight;
}

/**
 * Test-only: clear the per-process cache so the next call to
 * `detectEmbeddingStrategy` re-runs detection. Not intended for production
 * use — production callers should restart the process.
 */
export function _resetStrategyCache(): void {
  _cachedStrategy = null;
  _detectionInFlight = null;
}

// ---------------------------------------------------------------------------
// US4 / 019 — Dual-write helpers for the bge-m3 migration window
// ---------------------------------------------------------------------------

/**
 * Default collection naming convention for the dual-write window.
 *
 * - v1 lives in `'decisions'` (the legacy collection — kept stable for
 *   rollback during the 7-day retention window).
 * - v2 lives in `'decisions_v2'` (created by the migration script).
 *
 * Reads always go through the **active** collection (computed by
 * `getActiveCollectionName`). Writes go through the active collection,
 * plus the dual-write collection when `EMBEDDING_DUAL_WRITE=1`.
 */
export const COLLECTION_V1 = 'decisions' as const;
export const COLLECTION_V2 = 'decisions_v2' as const;

export function getActiveCollectionName(
  version: EmbeddingVersion = getActiveEmbeddingVersion(),
): string {
  return version === 'v2' ? COLLECTION_V2 : COLLECTION_V1;
}

/**
 * When dual-write is enabled, return the *other* collection (so the
 * caller writes to active + this one). Returns null when dual-write is
 * disabled. The "other" collection's version is the inverse of the active
 * version — so callers always cover both halves of the migration matrix.
 */
export function getDualWriteCollection(): {
  collection: string;
  version: EmbeddingVersion;
} | null {
  if (!isDualWriteEnabled()) return null;
  const active = getActiveEmbeddingVersion();
  const otherVersion: EmbeddingVersion = active === 'v1' ? 'v2' : 'v1';
  return {
    collection: getActiveCollectionName(otherVersion),
    version: otherVersion,
  };
}

/**
 * Build a `vectorForUpsert` payload for an arbitrary version, suitable for
 * dual-write. Truncates the input against the destination version's character
 * ceiling (since v1 and v2 have different windows).
 */
export function vectorForUpsertAtVersion(
  text: string,
  version: EmbeddingVersion,
): UpsertVector {
  const strategy = new ServerInferenceStrategy(version);
  const truncated = truncateForEmbedding(text, version);
  return strategy.vectorForUpsert(truncated);
}
