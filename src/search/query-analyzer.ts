/**
 * Pre-retrieval query analysis for search intelligence (from Q4-B).
 *
 * Analyzes the search query to detect type, extract entities, and identify
 * negation patterns. The resulting `QueryAnalysis` is fed into the two-stage
 * reranker to adjust signal weights.
 *
 * @module search/query-analyzer
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Query intent classification. */
export type QueryType = 'factual' | 'exploratory' | 'negation';

/** Result of pre-retrieval query analysis. */
export interface QueryAnalysis {
  /** Detected query intent. */
  type: QueryType;
  /** Key entities/terms extracted from the query. */
  entities: string[];
  /** Whether the query contains negation patterns. */
  hasNegation: boolean;
  /** Original unmodified query text. */
  originalQuery: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Words that indicate a factual question. */
const FACTUAL_MARKERS = [
  'what', 'which', 'who', 'where', 'when', 'how',
  'does', 'do', 'is', 'are', 'was', 'were', 'will', 'can',
];

/** Words that indicate negation intent. */
const NEGATION_MARKERS = [
  'not', "don't", "dont", "doesn't", "doesnt",
  'avoid', 'never', 'without', 'instead of',
  "shouldn't", "shouldnt", "won't", "wont",
  "can't", "cant", 'no', 'exclude', 'except',
  "isn't", "isnt", "aren't", "arent",
];

/** Common English stopwords to filter out of entity extraction. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't',
  'just', 'don', 'should', 'now', 'what', 'which', 'who', 'whom', 'this',
  'that', 'these', 'those', 'am', 'or', 'and', 'but', 'if', 'because',
  'about', 'up', 'it', 'its', 'we', 'they', 'them', 'their', 'my', 'your',
  'our', 'his', 'her', 'i', 'me', 'he', 'she', 'you',
  // Negation markers kept as stopwords for entity extraction
  "don't", "dont", "doesn't", "doesnt", "shouldn't", "shouldnt",
  "won't", "wont", "can't", "cant", "isn't", "isnt", "aren't", "arent",
  'avoid', 'never', 'without', 'instead', 'exclude', 'except',
  // Question words
  'decisions', 'decision', 'about',
]);

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Analyze a search query before retrieval.
 *
 * Determines query type (factual, exploratory, negation), extracts key
 * entities, and detects negation patterns.
 *
 * @param query  Raw search query string.
 * @returns Query analysis with type, entities, and negation flag.
 */
export function analyzeQuery(query: string): QueryAnalysis {
  const lower = query.toLowerCase().trim();
  const hasNegation = detectNegation(lower);
  const type = classifyQuery(lower, hasNegation);
  const entities = extractEntities(lower);

  return {
    type,
    entities,
    hasNegation,
    originalQuery: query,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect negation patterns in a lowercased query.
 */
function detectNegation(lower: string): boolean {
  for (const marker of NEGATION_MARKERS) {
    // Match as whole word boundary (or multi-word phrase)
    if (marker.includes(' ')) {
      if (lower.includes(marker)) return true;
    } else {
      // Word-boundary check via regex
      const re = new RegExp(`\\b${escapeRegex(marker)}\\b`);
      if (re.test(lower)) return true;
    }
  }
  return false;
}

/**
 * Classify query type based on patterns.
 */
function classifyQuery(lower: string, hasNegation: boolean): QueryType {
  if (hasNegation) return 'negation';

  // Factual: starts with a question word or ends with '?'
  if (lower.endsWith('?')) return 'factual';

  const firstWord = lower.split(/\s+/)[0];
  if (firstWord && FACTUAL_MARKERS.includes(firstWord)) return 'factual';

  // Default: exploratory (e.g. "decisions about auth", "caching strategy")
  return 'exploratory';
}

/**
 * Extract key entities from the query (non-stopword tokens).
 */
function extractEntities(lower: string): string[] {
  const tokens = lower
    .replace(/[?!.,;:'"()\[\]{}]/g, '') // strip punctuation
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // Deduplicate while preserving order
  return [...new Set(tokens)];
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
