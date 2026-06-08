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
  | 'decision_consolidated'
  | 'project_created'
  | 'project_member_added'
  | 'project_member_removed'
  | 'migration_default_project'
  | 'org_created'
  | 'outcome_updated'
  | 'evolve'
  | 'cross_org_read'
  // 034 / FR-011 / Q1 + D6: personal-drafts entry promoted to a team
  // project. Audit row written in the source personal-drafts project
  // (Q6 RLS: visible only to the owning member).
  | 'personal_drafts_promoted';

export type AuditTargetType = 'decision' | 'member' | 'org' | 'project';

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
  /** Initial status — defaults to 'proposed' (FR-018: active requires explicit review). */
  status?: 'active' | 'proposed';
}

/**
 * 036 / FR-018: single source of truth for the store-time status default.
 * Every entry point into a store/enqueue path (the MCP handler's `buildExtras`,
 * the offline-queue fallback in `handleStore`, and the proxy server's offline
 * append) must resolve an absent status to 'proposed' — `active` requires
 * explicit review. Consolidated here so the literal lives in exactly one place.
 */
export function normalizeStoreStatus(
  status: unknown,
): 'active' | 'proposed' {
  return status === 'active' ? 'active' : 'proposed';
}

/** Contradiction warning returned alongside a successful store. */
export interface StoreContradictionWarning {
  decision_id: string;
  summary: string;
  author: string;
  overlap_areas: string[];
  /**
   * Cosine similarity in [0,1] when Qdrant was available; `null` when the
   * pair was flagged on the Tier-1 (area-overlap) path with no vector
   * similarity computed. Mirrors `contradictions.similarity_score` in
   * Postgres — never a misleading `0`.
   */
  similarity: number | null;
  /**
   * 044: the opposition-gate verdict that surfaced this pair, when the gate ran.
   * Absent on legacy/abstain-disabled paths (backward-compatible, FR-013).
   */
  verdict_classification?: 'replacement' | 'genuine_conflict' | 'compatible' | 'uncertain';
  /** 044: gate confidence 0–1 (null when abstained). */
  verdict_confidence?: number | null;
  /**
   * 044: present only on a `replacement` verdict — the gate PROPOSES (does not
   * apply) that the newer decision supersede the older. Escalate-first: the
   * deprecate/edge/exclusion happen only on human confirmation (FR-004).
   */
  propose_supersede?: { superseded_id: string; supersedes_id: string };
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
  /**
   * Project UUID the decision belongs to. Required in plugin/OAuth mode when
   * the decision was stored cross-org (issue #54). When provided, the lookup
   * and write paths switch to project-scoped (membership-gated) instead of
   * the default org_id-scoped path.
   */
  project_id?: string;
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

/**
 * Server-side config for remote MCP endpoint.
 * Built from AuthResult + env vars, replaces filesystem-based ValisConfig.
 */
export interface ServerConfig {
  org_id: string;
  member_id: string;
  author_name: string;
  role: string;
  auth_mode: 'jwt';
  supabase_url: string;
  supabase_service_role_key: string;
  qdrant_url: string;
  qdrant_api_key: string;
  api_key: string;
  member_api_key: string;
  project_id?: string | null;
  project_name?: string | null;
  /**
   * Optional funnel-event emitter injected by the web layer (`buildServerConfig*`).
   * CLI stdio mode leaves it undefined — side effects call it via `?.()` so
   * analytics is a pure server-side concern.
   */
  emit_funnel?: (event: string, properties: Record<string, unknown>) => void;
}

export interface StoreResponse {
  id: string;
  status: 'stored' | 'duplicate' | 'duplicate_detected';
  synced?: boolean;
  /** When true, the decision was stored with proposed status (Phase 3 — US1). */
  proposed?: boolean;
  /** Contradiction warnings detected after store (Phase 2). */
  contradictions?: StoreContradictionWarning[];
  /** Supersession detail when `replaces` triggered a transition (Phase 2). */
  superseded?: StoreSupersededDetail;
  /**
   * 027/Track 4: GroundTruthInjector result. Present whenever the pre-write
   * injector ran (which is "always" in handleStore today — the injector is
   * non-blocking and its result is informational unless `status` is set to
   * `duplicate_detected`, in which case `id` is the existing decision UUID
   * and no new row was written).
   */
  ground_truth?: {
    status:
      | 'duplicate_detected'
      | 'neighbours_linked'
      | 'neighbours_informational'
      | 'no_matches'
      | 'injector_failed';
    band: 'duplicate' | 'neighbour' | 'none' | 'failed';
    top_similarity: number;
    candidates: Array<{ id: string; similarity: number }>;
    latency_ms: number;
    reason?: string;
  };
  /**
   * 034 / FR-005: present and `true` when `type` was inferred from content
   * (the caller did not supply an explicit `type`). Callers can detect
   * silent inference and override if desired.
   */
  inferred_type?: boolean;
  /**
   * 034 / FR-006 companion flag: `true` when `summary` was auto-derived
   * from `text` because the caller did not supply one.
   */
  inferred_summary?: boolean;
  /**
   * 034 / FR-008 companion: `'personal-drafts'` when the store call landed
   * in the caller's personal-drafts project because no project scope was
   * resolvable from args / JWT / .valis.json. Absent when an explicit
   * project scope was used (team project or per-call arg).
   */
  inferred_project_scope?: 'personal-drafts';
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
  /**
   * Human-readable diagnostic for `error: 'infrastructure_error'` in server
   * mode. Lets operators (and the agent) triage without prod-log access.
   */
  error_message?: string;
  /**
   * BUG #175: structured warning when the per-call `project_id` arg differs
   * from the JWT-encoded session scope. Mirrors the search-side
   * `project_scope_mismatch` shape so the agent can surface a uniform
   * recovery instruction to the user (restart the session so the JWT
   * picks up the active `.valis.json`).
   */
  project_scope_mismatch?: {
    session_project_id: string;
    current_project_id: string;
    action_required: 'restart_session';
  };
  /**
   * BUG #175: when the OAuth session has no project_id and the member has
   * access to multiple projects, server cannot safely pick a default. Tool
   * returns the candidate list so the agent can ask the user to choose,
   * instead of silently writing to whichever project Supabase happened to
   * return first.
   */
  candidate_project_ids?: string[];
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
  /**
   * 028-phase13/Track 5a — after-the-fact outcome verdict. Read from Qdrant
   * payload so search results carry it without a Postgres round-trip; powers
   * the rerank-time downranking of `outcome='failed'` rows.
   */
  outcome?: 'success' | 'failed' | 'partial' | 'unknown' | null;
  /** BM25 sparse vector score when available (Phase 3 — reranker input). */
  bm25_score?: number;
  /** Human-readable status label for non-active decisions (e.g. 'proposed', 'deprecated'). */
  status_label?: string;
  /** Project name label for cross-project search results (Phase 4 — US3). */
  project_name?: string;
  /** Project UUID from Qdrant payload (Phase 4 — US3). */
  project_id?: string;
  /**
   * Origin of this decision (mcp_store, seed, file_watcher, ...).
   * Surfaced from Qdrant payload so the UI can render "imported via
   * valis index" badges and search filters can target organically-
   * captured vs bulk-seeded subsets.
   */
  source?: DecisionSource;
  /** Human-readable explanation of why this result matched the query (Q4-B). */
  matchReason?: string;
  /** Chain of decision IDs this one superseded, oldest first (Q4-C). */
  supersedes?: string[];
  /** Graph hop distance: 0 = direct search hit, 1 = 1-hop neighbor (Q4-C). */
  graph_hop?: number;
  /** Lifetime count of unique (PR, commit, decision) violation events (Phase 018 — FR-010). */
  violation_count?: number;
  /** Timestamp of most recent violation event (Phase 018 — FR-010). */
  last_violated_at?: string | null;
  /**
   * 0.1.7-dev / BUG #161: which slice of the parent decision text is in
   * `detail`. 'chunk' = matched chunk only; 'siblings' = matched chunk
   * with adjacent ±1 chunks for context (default); 'full' = whole decision
   * detail (opt-in, expensive for long docs).
   */
  detail_scope?: 'chunk' | 'siblings' | 'full';
  /** Index of the matched chunk within the parent decision (0-based). */
  chunk_index?: number;
  /** Total chunks the parent decision was split into. >1 means the matched
   * detail in this result is partial; agent can request expand=full to get
   * the rest. */
  total_chunks?: number;
}

/** Search return granularity (BUG #161 fix). */
export type SearchExpand = 'chunk' | 'siblings' | 'full';

// ---------------------------------------------------------------------------
// Signal Weights & Reranked Results (Phase 3 — Search Intelligence)
// ---------------------------------------------------------------------------

export interface SignalWeights {
  semantic: number;
  bm25: number;
  recency: number;
  importance: number;
  graph: number;
  cluster: number;
}

export interface SignalValues {
  semantic_score: number;
  bm25_score: number;
  recency_decay: number;
  importance: number;
  graph_connectivity: number;
  cluster_boost: number;
}

export interface RerankedResult extends SearchResult {
  /** Composite score from multi-signal reranking. */
  composite_score: number;
  /** Individual signal values for debugging/transparency. */
  signals: SignalValues;
  /** Whether this result was suppressed (only present with --all). */
  suppressed?: boolean;
  /**
   * 028-phase13/Track 5a (FR-015): per-result outcome adjustment diagnostics.
   * `outcome_multiplier` is 0.5 for `outcome='failed'` rows in non-failure-
   * intent queries, 1.0 otherwise. `failure_intent_override` indicates whether
   * the query string matched the keyword heuristic that suppresses downranking.
   */
  outcome?: 'success' | 'failed' | 'partial' | 'unknown' | null;
  outcome_multiplier?: number;
  failure_intent_override?: boolean;
  /**
   * 031/Track 5b — typed-edge neighbourhood. Present ONLY when the caller
   * passed `depth >= 1` on valis_search. Empty array when the hit has no
   * outgoing edges (never `undefined` in that mode). Field is OMITTED on
   * depth=0 calls so existing callers see byte-identical responses (FR-010).
   */
  related?: Array<{
    decision_id: string;
    edge_type: 'supersedes' | 'builds_on' | 'synthesizes' | 'contradicts';
    depth: 1 | 2;
    reason: string | null;
    /** Decision summary — present in `summary` mode (the default). */
    summary?: string | null;
  }>;
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

/**
 * Per-call defensive signal (BUG #118 mitigation, sprint 2026-05-14). When the
 * JWT-encoded session scope differs from the per-call `project_id` arg, the
 * tool still returns JWT-scoped results but appends this field so the agent
 * surfaces the drift to the user immediately. Visible-actionable instead of
 * silent wrong-scope. Full fix (mid-session scope switch) is deferred.
 */
export interface ProjectScopeMismatch {
  session_project_id: string;
  current_project_id: string;
  action_required: 'restart_session';
}

/**
 * 039/#94 — explicit scope descriptor attached to every successful
 * `valis_search` / `valis_context` response. Makes the project boundary
 * visible so the agent can name *which* knowledge base it consulted
 * instead of silently implying the whole team brain was searched.
 *
 * - `active_project` — the project actually queried (id + display name).
 *   On a granted cross-org read (feature 033 `target_project_id`) this is
 *   the TARGET project, not the caller's JWT scope (FR-004). `name` is
 *   `null` when the id resolves but no display name is available. The whole
 *   field is `null` on the `all_projects` path when no single project scope
 *   resolved — the query spanned every accessible project, so there is no
 *   one "active" project to name (finding #2). `queried_all_projects` is the
 *   companion signal in that case.
 * - `accessible_projects` — the projects the authenticated member can read
 *   (best-effort; degrades to `[active_project]` when the membership lookup
 *   is unavailable — CLI stdio mode, missing creds, network failure — per
 *   FR-008 / Constitution III).
 * - `queried_all_projects` — whether the call spanned every accessible
 *   project (i.e. `all_projects: true`).
 */
/**
 * 040/#226 — derived, read-only projection over the `decisions` table for ONE
 * project: the unreviewed draft backlog (`status = 'proposed'`, plus legacy
 * `type = 'pending'` rows normalized into the `decision` bucket). Attached as
 * an independent top-level key on `SearchResponse` / `ContextResponse`. Never
 * persisted — computed per response. OMITTED (key absent), never zero-filled,
 * when the parent path is offline / cross-project / cross-org or the COUNT
 * fails (FR-006). `count` MUST come from a server-side exact COUNT, never a
 * `.length` over a fetched set (lesson `104083be`).
 */
export interface ProposedPending {
  /** Total `proposed`/legacy-`pending` decisions in the active project (exact COUNT). */
  count: number;
  /** Per-type partition; the four counts sum to `count` (FR-003). */
  by_type: {
    decision: number;
    pattern: number;
    lesson: number;
    constraint: number;
  };
  /** ≤3 preview rows. `similarity` is `null` when no semantic score is available (FR-004). */
  top_3: Array<{
    id: string;
    type: string;
    summary: string;
    similarity: number | null;
  }>;
  /** Deep-link to the dashboard triage view, or `null` when no origin is resolvable (FR-005). */
  triage_url: string | null;
}

export interface ScopeEnvelope {
  active_project: { id: string; name: string | null } | null;
  accessible_projects: Array<{ id: string; name: string }>;
  queried_all_projects: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  /** Number of results suppressed from default view. */
  suppressed_count?: number;
  offline?: boolean;
  note?: string;
  /**
   * Machine-readable error code. Surfaces structured failure conditions
   * to the agent — currently used for `project_scope_required` when no
   * project_id could be resolved from any source.
   */
  error?: string;
  project_scope_mismatch?: ProjectScopeMismatch;
  /**
   * 032/Track 6 — structured-filter diagnostics surfaced when the agent
   * passed unparseable or out-of-range filter args. Both arrays are omitted
   * when empty so backward compat callers see byte-identical responses.
   */
  dropped_args?: Array<{ field: string; reason: string }>;
  clamped_args?: Array<{ field: string; original: unknown; clamped: unknown }>;
  /** Filter dimensions exercised on this call — telemetry for FR-014. */
  filter_dim_used?: string[];
  /** Note emitted when `query_mode: metadata_only` ignores a non-empty query string. */
  mode_note?: 'query_string_ignored_in_metadata_mode';
  /**
   * 040/#226 — unreviewed draft backlog for the single active project. Additive,
   * independent of the 039 `scope` envelope (both coexist as separate top-level
   * keys). OMITTED on offline / cross-project / cross-org / COUNT-failure paths
   * (FR-006); `{ count: 0, top_3: [] }` on a healthy zero-draft single-project call.
   */
  proposed_pending?: ProposedPending;
  /**
   * 039/#94 — explicit scope descriptor naming the active project, the
   * member's accessible projects, and whether the query spanned all of
   * them. Present on every successful response (including empty ones).
   * Additive (FR-009). Feature 040/#226 will add a SEPARATE top-level
   * `proposed_pending` field to this same envelope — do NOT add it here
   * (FR-010); keep `scope` / `scope_hint` independent top-level keys.
   */
  scope?: ScopeEnvelope;
  /**
   * 039/#94 — advisory string present ONLY when results are empty AND the
   * member can access >1 project AND the query did not already span all of
   * them. Suggests retrying with `all_projects: true` (FR-005/FR-006).
   */
  scope_hint?: string;
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
  /** Structured error code, e.g. `project_scope_required`. */
  error?: string;
  /** Human-readable hint paired with `error`. */
  note?: string;
  /** CLI-stdio fallback indicator. NEVER set on HTTP transport (per 019 R-001). */
  offline?: boolean;
  project_scope_mismatch?: ProjectScopeMismatch;
  /**
   * 019/US1: caller has zero accessible projects. Distinguishes "no data yet"
   * from "infrastructure failure". Only emitted on HTTP transport when the
   * cross-project fallback returns no project memberships.
   */
  no_accessible_projects?: boolean;
  /**
   * 019/US1: backend genuinely unreachable on HTTP transport. Replaces the
   * (incorrect) `offline:true` signal that was driving uninstalls per BUG #84.
   */
  backend_unavailable?: boolean;
  /**
   * 019/US1 (T068): search backend reachable but raised an error. Distinguished
   * from `backend_unavailable` (network/auth) and `no_accessible_projects` (zero
   * memberships).
   */
  infrastructure_error?: boolean;
  /**
   * BUG #144 (2026-05-03): when `infrastructure_error: true`, surface the
   * underlying error message so operators / agents can triage without
   * prod-log access. Same pattern as `StoreErrorResponse.error_message`.
   */
  error_message?: string;
  /**
   * 039/#94 — explicit scope descriptor (same shape + semantics as
   * `SearchResponse.scope`). Present on every successful response.
   * Additive (FR-009); independent of feature 040/#226's future
   * top-level `proposed_pending` field (FR-010 — do NOT add it here).
   */
  scope?: ScopeEnvelope;
  /**
   * 039/#94 — advisory string on empty multi-project responses (same
   * semantics as `SearchResponse.scope_hint`). For context, "empty" means
   * zero results across `decisions + constraints + patterns + lessons`
   * (historical excluded — superseded/deprecated rows are not "results").
   */
  scope_hint?: string;
  /**
   * 040/#226 — unreviewed draft backlog for the single active project. Same
   * shape + omission semantics as `SearchResponse.proposed_pending`. Additive,
   * independent of the 039 `scope` envelope (both coexist as separate keys).
   */
  proposed_pending?: ProposedPending;
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
  /**
   * 036/FR-003 (#90): the decision's intended lifecycle status at enqueue
   * time. Persisted so the startup-sweep flush can thread it into both
   * Postgres and the Qdrant payload instead of flattening to `active`.
   * Optional + additive — legacy queue entries (written before this field)
   * default to `active` downstream. Mirrors `StoreArgs.status` /
   * `StoreExtras.status`; validation lives at the MCP-tool boundary.
   */
  status?: 'active' | 'proposed';
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

// ---------------------------------------------------------------------------
// CI Enforcement (Phase 018 — 018-ci-enforcement)
// ---------------------------------------------------------------------------

/** Per-project default CI enforcement mode. Overridable per-repo via `.valis.yaml`. */
export type EnforcementMode = 'block' | 'warn' | 'suggest';

/** Per-violation severity assigned by the LLM; drives PR-side behavior. */
export type Severity = 'block' | 'warn' | 'info';

/** Project visibility toggles access to the public `/decisions/{id}` page. */
export type ProjectVisibility = 'private' | 'public';

/** Transient shape returned by `POST /api/check` and the `valis_check_diff` MCP tool. Not stored as a first-class row. */
export interface Violation {
  decision_id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  severity: Severity;
  explanation: string;
  decision_url: string;
}

/** Parsed `.valis.yaml` contents. Unknown fields pass through with a `console.warn`. */
export interface ValisYamlConfig {
  project_id: string;
  enforcement_mode?: EnforcementMode;
}

/** Long-lived, rotatable token scoped to a single project. Returned by dashboard APIs (never by the MCP/CLI layer). */
export interface ProjectScopedToken {
  id: string;
  project_id: string;
  issued_by: string;
  name: string;
  prefix: string;
  scopes: Record<string, boolean>;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}
