/**
 * 021 public benchmarks — shared type aliases.
 *
 * In-memory + on-disk JSON shapes used by the harness. Mirrors
 * `specs/021-public-benchmarks/data-model.md`.
 *
 * Pure type file — no runtime code, no imports beyond `node:` builtins.
 */

export type Language = 'en' | 'uk' | 'pl' | 'mixed';

export interface Document {
  id: string;
  text: string;
  language?: Language;
  metadata?: Record<string, unknown>;
}

export interface Query {
  id: string;
  text: string;
  language?: Language;
  metadata?: Record<string, unknown>;
}

export interface GroundTruth {
  query_id: string;
  relevant_doc_ids: string[];
}

export interface SearchHit {
  doc_id: string;
  score: number;
  rank: number;
}

export interface CorpusProvenance {
  corpus_id: string;
  upstream_url: string;
  license: string;
  fetched_at: string;
  content_hash: string;
  curation_rule: string;
}

export interface CorpusSlice {
  id: string;
  language: Language;
  documents: Document[];
  queries: Query[];
  ground_truth: GroundTruth[];
  provenance: CorpusProvenance;
}

export interface MetricSet {
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  ndcg_at_10: number;
  wall_clock_ms: number;
  n_queries_evaluated: number;
}

export type Strategy = 'hybrid' | 'dense_only' | 'bm25_only';

export type MetricsByStrategy = Record<Strategy, MetricSet>;

export interface SliceResult {
  corpus: string;
  language: Language;
  n_queries: number;
  n_documents: number;
  metrics: MetricsByStrategy;
  gate_passed: boolean;
}

export interface ProductionStackDescriptor {
  dense_model: string;
  dense_dim: number;
  sparse_model: string;
  chunking: { chars: number; overlap: number; strategy: string };
  fusion: string;
  dedup: string;
}

export interface BenchmarkResult {
  run_id: string;
  published_at: string;
  git_commit: string;
  production_stack: ProductionStackDescriptor;
  slices: Record<string, SliceResult>;
  wall_clock_ms: number;
  harness_version: string;
  corpus_provenance: CorpusProvenance[];
  /**
   * Placeholder flag: set to `true` only on the stub `latest.json` that ships
   * before the first real published run. The web page reads this flag to
   * render a "Coming soon" state instead of zero-value metrics.
   */
  placeholder?: boolean;
}

export type SearchFn = (query: string, k: number) => Promise<SearchHit[]>;

export class BenchmarkCorpusError extends Error {
  constructor(
    message: string,
    public readonly lineNumber?: number,
    public readonly corpusId?: string,
  ) {
    super(message);
    this.name = 'BenchmarkCorpusError';
  }
}
