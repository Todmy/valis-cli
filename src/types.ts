export interface Organization {
  id: string;
  name: string;
  api_key: string;
  invite_code: string;
  plan: 'free' | 'team' | 'business' | 'enterprise';
  decision_count: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Project (Phase 4 — Multi-Project Support)
// ---------------------------------------------------------------------------

export type ProjectRole = 'project_admin' | 'project_member';

export interface Project {
  id: string;
  org_id: string;
  name: string;
  invite_code: string;
  created_at: string;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  member_id: string;
  role: ProjectRole;
  joined_at: string;
}

/** Per-directory project config stored in `.valis.json`. */
export interface ProjectConfig {
  project_id: string;
  project_name: string;
}

/** Resolved config combining global ValisConfig with per-directory ProjectConfig. */
export interface ResolvedConfig {
  global: ValisConfig | null;
  project: ProjectConfig | null;
}

export interface Member {
  id: string;
  org_id: string;
  author_name: string;
  role: 'admin' | 'member';
  joined_at: string;
  /** Per-member API key, format `tmm_` + 32 hex. Null for legacy members. */
  api_key?: string | null;
  /** When set, member key is revoked and invalid. */
  revoked_at?: string | null;
}

export type DecisionType = 'decision' | 'constraint' | 'pattern' | 'lesson' | 'pending';
export type DecisionStatus = 'active' | 'deprecated' | 'superseded' | 'proposed';
export type DecisionSource = 'mcp_store' | 'file_watcher' | 'stop_hook' | 'seed' | 'synthesis';

export interface Decision {
  id: string;
  org_id: string;
  type: DecisionType;
  summary: string | null;
  detail: string;
  status: DecisionStatus;
  author: string;
  source: DecisionSource;
  /** UUID FK to projects.id. Required after migration 004. */
  project_id: string;
  session_id: string | null;
  content_hash: string;
  confidence: number | null;
  affects: string[];
  created_at: string;
  updated_at: string;
  /** UUID of the decision this one replaces (target becomes superseded). */
  replaces?: string | null;
  /** UUIDs of decisions this one depends on. */
  depends_on?: string[];
  /** Author who last changed status. */
  status_changed_by?: string | null;
  /** Timestamp of last status change. */
  status_changed_at?: string | null;
  /** Reason for the last status change. */
  status_reason?: string | null;
  /** Whether this decision is pinned (exempt from confidence decay). */
  pinned?: boolean;
  /** How this decision was enriched: 'llm', 'manual', or null if not enriched. */
  enriched_by?: 'llm' | 'manual' | null;
}

export interface RawDecision {
  text: string;
  type?: Exclude<DecisionType, 'pending'>;
  summary?: string;
  affects?: string[];
  confidence?: number;
  project_id?: string;
  session_id?: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'decision_stored'
  | 'decision_deprecated'
  | 'decision_superseded'
  | 'decision_promoted'
  | 'decision_depends_added'
  | 'member_joined'
  | 'member_revoked'
  | 'key_rotated'
  | 'org_key_rotated'
  | 'contradiction_detected'
  | 'contradiction_resolved'
  | 'decision_pinned'
  | 'decision_unpinned'
  | 'decision_enriched'
  | 'decision_auto_deduped'
  | 'pattern_synthesized'
  | 'project_created'
  | 'project_member_added'
  | 'project_member_removed'
  | 'migration_default_project'
  | 'org_created';

export type AuditTargetType = 'decision' | 'member' | 'org';

export interface AuditEntry {
  id: string;
  org_id: string;
  /** Project UUID. Nullable — org-level actions have no project. */
  project_id?: string | null;
  member_id: string;
  action: AuditAction;
  target_type: AuditTargetType;
  target_id: string;
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Contradiction
// ---------------------------------------------------------------------------

export type ContradictionStatus = 'open' | 'resolved';

export interface Contradiction {
  id: string;
  org_id: string;
  /** Project UUID. Required after migration 004. */
  project_id: string;
  decision_a_id: string;
  decision_b_id: string;
  overlap_areas: string[];
  similarity_score: number | null;
  status: ContradictionStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  detected_at: string;
}

// ---------------------------------------------------------------------------
// Store (MCP tool args — extends RawDecision concept for MCP layer)
// ---------------------------------------------------------------------------

export interface StoreArgs extends RawDecision {
  /** UUID of decision being replaced (target transitions to superseded). */
  replaces?: string;
  /** UUIDs of dependency decisions. */
  depends_on?: string[];
  /** Initial status — defaults to 'active'. */
  status?: 'active' | 'proposed';
}

/** Contradiction warning returned alongside a successful store. */
export interface StoreContradictionWarning {
  decision_id: string;
  summary: string;
  author: string;
  overlap_areas: string[];
  similarity: number;
}

/** Supersession detail returned when `replaces` triggers a transition. */
export interface StoreSupersededDetail {
  decision_id: string;
  old_status: DecisionStatus;
  new_status: 'superseded';
}

// ---------------------------------------------------------------------------
// Lifecycle (MCP tool)
// ---------------------------------------------------------------------------

export type LifecycleAction = 'deprecate' | 'promote' | 'history' | 'pin' | 'unpin';

export interface LifecycleArgs {
  action: LifecycleAction;
  decision_id: string;
  reason?: string;
}

export interface LifecycleStatusChange {
  decision_id: string;
  old_status: DecisionStatus;
  new_status: DecisionStatus;
  changed_by: string;
  flagged_dependents: string[];
}

export interface LifecycleHistoryEntry {
  from: DecisionStatus;
  to: DecisionStatus;
  by: string;
  reason: string | null;
  at: string;
}

export interface LifecycleHistoryResponse {
  decision_id: string;
  current_status: DecisionStatus;
  history: LifecycleHistoryEntry[];
}

/** Response when a decision is pinned or unpinned (T043 — US5). */
export interface LifecyclePinResponse {
  decision_id: string;
  pinned: boolean;
  changed_by: string;
}

export type LifecycleResponse =
  | LifecycleStatusChange
  | LifecycleHistoryResponse
  | LifecyclePinResponse;

// ---------------------------------------------------------------------------
// JWT Auth
// ---------------------------------------------------------------------------

export type AuthMode = 'legacy' | 'jwt';

export type MemberRole = Member['role'];

export interface JwtToken {
  /** Raw JWT string. */
  token: string;
  /** ISO-8601 expiry timestamp. */
  expires_at: string;
}

export interface ExchangeTokenResponse {
  token: string;
  expires_at: string;
  member_id: string;
  org_id: string;
  org_name: string;
  role: MemberRole;
  author_name: string;
  auth_mode: AuthMode;
  /** Project UUID when a project-scoped JWT was requested. */
  project_id?: string;
  /** Project name when a project-scoped JWT was requested. */
  project_name?: string;
  /** Project-level role when a project-scoped JWT was requested. */
  project_role?: ProjectRole;
}

export interface TokenCache {
  jwt: JwtToken;
  member_id: string;
  org_id: string;
  role: MemberRole;
  author_name: string;
  /** Project UUID for project-scoped tokens. Undefined for org-level tokens. */
  project_id?: string;
  /** Project-level role for project-scoped tokens. */
  project_role?: ProjectRole;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ValisConfig {
  org_id: string;
  org_name: string;
  api_key: string;
  invite_code: string;
  author_name: string;
  supabase_url: string;
  supabase_service_role_key: string;
  qdrant_url: string;
  qdrant_api_key: string;
  configured_ides: string[];
  created_at: string;
  /** Authentication mode: 'legacy' uses org api_key, 'jwt' uses per-member keys. */
  auth_mode?: AuthMode;
  /** Per-member API key (format `tmm_` + 32 hex). Null when using legacy mode. */
  member_api_key?: string | null;
  /** Member UUID resolved during JWT auth. Null when using legacy mode. */
  member_id?: string | null;
  /** Active project UUID from resolved config. Null when no project configured. */
  project_id?: string | null;
  /** Active project name from resolved config. Null when no project configured. */
  project_name?: string | null;
}

export interface StoreResponse {
  id: string;
  status: 'stored' | 'duplicate';
  synced?: boolean;
  /** When true, the decision was stored with proposed status (Phase 3 — US1). */
  proposed?: boolean;
  /** Contradiction warnings detected after store (Phase 2). */
  contradictions?: StoreContradictionWarning[];
  /** Supersession detail when `replaces` triggered a transition (Phase 2). */
  superseded?: StoreSupersededDetail;
}

export interface StoreErrorResponse {
  error: string;
  pattern?: string;
  action: 'blocked';
  /** Upgrade info when billing limit is reached. */
  upgrade?: {
    message: string;
    checkout_url: string | null;
  };
}

export interface SearchResult {
  id: string;
  score: number;
  type: DecisionType;
  summary: string | null;
  detail: string;
  author: string;
  affects: string[];
  created_at: string;
  /** Decision status (Phase 2). */
  status?: DecisionStatus;
  /** UUID of the decision this one was replaced by, if superseded (Phase 2). */
  replaced_by?: string | null;
  /** Confidence score from payload (Phase 3 — reranker input). */
  confidence?: number | null;
  /** Whether this decision is pinned (Phase 3 — reranker input). */
  pinned?: boolean;
  /** UUIDs of decisions this one depends on (Phase 3 — graph signal input). */
  depends_on?: string[];
  /** BM25 sparse vector score when available (Phase 3 — reranker input). */
  bm25_score?: number;
  /** Human-readable status label for non-active decisions (e.g. 'proposed', 'deprecated'). */
  status_label?: string;
  /** Project name label for cross-project search results (Phase 4 — US3). */
  project_name?: string;
  /** Project UUID from Qdrant payload (Phase 4 — US3). */
  project_id?: string;
}

// ---------------------------------------------------------------------------
// Signal Weights & Reranked Results (Phase 3 — Search Intelligence)
// ---------------------------------------------------------------------------

export interface SignalWeights {
  semantic: number;
  bm25: number;
  recency: number;
  importance: number;
  graph: number;
}

export interface SignalValues {
  semantic_score: number;
  bm25_score: number;
  recency_decay: number;
  importance: number;
  graph_connectivity: number;
}

export interface RerankedResult extends SearchResult {
  /** Composite score from multi-signal reranking. */
  composite_score: number;
  /** Individual signal values for debugging/transparency. */
  signals: SignalValues;
  /** Whether this result was suppressed (only present with --all). */
  suppressed?: boolean;
}

/** Org-level reranking configuration overrides. */
export interface RerankConfig {
  /** Custom signal weights (partial — missing keys use defaults). */
  weights?: Partial<SignalWeights>;
  /** Custom half-life in days for recency decay. Default 90. */
  halfLifeDays?: number;
}

export interface RerankedSearchResponse {
  results: RerankedResult[];
  /** Number of results suppressed from default view. */
  suppressed_count: number;
  offline?: boolean;
  note?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Number of results suppressed from default view. */
  suppressed_count?: number;
  offline?: boolean;
  note?: string;
}

export interface ContextResponse {
  decisions: SearchResult[];
  constraints: SearchResult[];
  patterns: SearchResult[];
  lessons: SearchResult[];
  /** Deprecated/superseded results kept for historical reference. */
  historical?: SearchResult[];
  total_in_brain: number;
  /** Number of results suppressed from default view (T050). */
  suppressed_count?: number;
  note?: string;
  offline?: boolean;
}

export interface DashboardStats {
  total_decisions: number;
  by_type: Record<DecisionType, number>;
  by_author: Record<string, number>;
  recent: Decision[];
  pending_count: number;
  /** Counts by lifecycle status (Phase 2). */
  by_status?: Record<DecisionStatus, number>;
  /** Number of pinned decisions (Phase 3 — US5). */
  pinned_count?: number;
  /** Decisions whose dependencies include deprecated/superseded decisions. */
  dependency_warnings?: DependencyWarning[];
}

export interface DependencyWarning {
  /** The decision that depends on a deprecated/superseded decision. */
  decision_id: string;
  decision_summary: string;
  /** The deprecated/superseded dependency. */
  dependency_id: string;
  dependency_summary: string;
  dependency_status: DecisionStatus;
}

export interface ManifestEntry {
  type: 'mcp_config' | 'claude_md_marker' | 'agents_md_marker' | 'cursorrules_marker' | 'hook_config' | 'config_dir';
  path: string;
  ide?: string;
  created_at: string;
}

export interface Manifest {
  version: string;
  entries: ManifestEntry[];
}

export interface QueueEntry {
  id: string;
  decision: RawDecision;
  author: string;
  source: DecisionSource;
  queued_at: string;
}

// ---------------------------------------------------------------------------
// Plan & Billing (Phase 3)
// ---------------------------------------------------------------------------

/** Valid plan tiers. */
export type PlanTier = 'free' | 'team' | 'business' | 'enterprise';

/** Subscription status mirroring Stripe states. */
export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'trialing';

/** Billing cycle for a subscription. */
export type BillingCycle = 'monthly' | 'annual';

/** Subscription record linking an organization to a billing plan. */
export interface Subscription {
  id: string;
  org_id: string;
  plan: PlanTier;
  billing_cycle: BillingCycle;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

/** Usage overage record for a single billing period. */
export interface UsageOverage {
  id: string;
  org_id: string;
  period_start: string;
  period_end: string;
  extra_decisions: number;
  extra_searches: number;
  amount_cents: number;
  billed_at: string | null;
}

/** Daily enrichment usage per provider for cost ceiling enforcement. */
export interface EnrichmentUsage {
  id: string;
  org_id: string;
  date: string;
  provider: string;
  decisions_enriched: number;
  tokens_used: number;
  cost_cents: number;
}

// ---------------------------------------------------------------------------
// Plan Limits (Phase 3)
// ---------------------------------------------------------------------------

/** Limits for a specific plan tier. */
export interface PlanLimits {
  /** Maximum number of decisions. Infinity for enterprise. */
  decisions: number;
  /** Maximum number of members. Infinity for enterprise. */
  members: number;
  /** Maximum number of searches per day. Infinity for enterprise. */
  searches: number;
  /** Whether overages are allowed (paid plans only). */
  overage: boolean;
}

// ---------------------------------------------------------------------------
// Cleanup & Enrichment (Phase 3)
// ---------------------------------------------------------------------------

/** Report from a cleanup run (dedup + orphan detection). */
export interface CleanupReport {
  /** Exact duplicate decisions auto-deprecated. */
  exact_dupes_deprecated: number;
  /** Near-duplicate pairs flagged for manual review. */
  near_dupes_flagged: number;
  /** Stale orphan (pending) decisions flagged for review. */
  orphans_flagged: number;
  /** Whether this was a dry-run (no mutations applied). */
  dry_run: boolean;
  /** Details of exact duplicates found. */
  exact_dupes: Array<{ kept_id: string; deprecated_ids: string[] }>;
  /** Details of near-duplicate pairs found. */
  near_dupes: Array<{ decision_a_id: string; decision_b_id: string; similarity: number }>;
  /** Details of stale orphan candidates. */
  orphans: Array<{ decision_id: string; age_days: number }>;
}

/** Result from LLM enrichment of a single decision. */
export interface EnrichmentResult {
  /** Decision ID that was enriched. */
  decision_id: string;
  /** Assigned decision type. */
  type: DecisionType;
  /** Generated summary. */
  summary: string;
  /** Inferred affected areas. */
  affects: string[];
  /** Confidence score from the LLM. */
  confidence: number;
  /** Provider used for enrichment. */
  provider: string;
  /** Estimated cost in cents. */
  cost_cents: number;
  /** Tokens consumed. */
  tokens_used: number;
}

/** Candidate pattern identified by the synthesis algorithm. */
export interface PatternCandidate {
  /** Shared affected areas that define this pattern cluster. */
  affects: string[];
  /** Decision IDs in this cluster. */
  decision_ids: string[];
  /** Jaccard cohesion score of the cluster. */
  cohesion: number;
  /** Whether a matching pattern already exists (idempotency check). */
  already_exists: boolean;
}

// ---------------------------------------------------------------------------
// Registration API (Phase 5 — 005-registration-api)
// ---------------------------------------------------------------------------

/** Public Supabase URL for hosted mode. Override with VALIS_SUPABASE_URL env var. */
export const HOSTED_SUPABASE_URL = process.env.VALIS_SUPABASE_URL ?? 'https://rmawxpdaudinbansjfpd.supabase.co';

/** Public Qdrant URL for hosted mode. Override with VALIS_QDRANT_URL env var. */
export const HOSTED_QDRANT_URL = process.env.VALIS_QDRANT_URL ?? 'https://c424cb8c-c7b6-4afc-963a-dfb86f82dd2c.eu-central-1-0.aws.cloud.qdrant.io';

/** Public Vercel API URL for hosted mode. Override with VALIS_API_URL env var. */
export const HOSTED_API_URL = process.env.VALIS_API_URL ?? 'https://valis.krukit.co';

/** Response from the public `/functions/v1/register` endpoint. */
export interface RegistrationResponse {
  member_api_key: string;
  supabase_url: string;
  qdrant_url: string;
  qdrant_api_key?: string;
  org_id: string;
  org_name: string;
  project_id: string;
  project_name: string;
  invite_code: string;
  member_id: string;
}

/** Response from the public `/functions/v1/join-project` endpoint (hosted mode). */
export interface JoinPublicResponse {
  org_id: string;
  org_name: string;
  project_id: string;
  project_name: string;
  member_api_key: string;
  member_id: string;
  supabase_url: string;
  qdrant_url: string;
  qdrant_api_key?: string;
  member_count: number;
  decision_count: number;
  role: ProjectRole;
}
