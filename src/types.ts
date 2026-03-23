export interface Organization {
  id: string;
  name: string;
  api_key: string;
  invite_code: string;
  plan: 'free' | 'pro' | 'enterprise';
  decision_count: number;
  created_at: string;
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
export type DecisionSource = 'mcp_store' | 'file_watcher' | 'stop_hook' | 'seed';

export interface Decision {
  id: string;
  org_id: string;
  type: DecisionType;
  summary: string | null;
  detail: string;
  status: DecisionStatus;
  author: string;
  source: DecisionSource;
  project_id: string | null;
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
  | 'contradiction_resolved';

export type AuditTargetType = 'decision' | 'member' | 'org';

export interface AuditEntry {
  id: string;
  org_id: string;
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

export type LifecycleAction = 'deprecate' | 'promote' | 'history';

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

export type LifecycleResponse = LifecycleStatusChange | LifecycleHistoryResponse;

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
}

export interface TokenCache {
  jwt: JwtToken;
  member_id: string;
  org_id: string;
  role: MemberRole;
  author_name: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TeamindConfig {
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
}

export interface StoreResponse {
  id: string;
  status: 'stored' | 'duplicate';
  synced?: boolean;
  /** Contradiction warnings detected after store (Phase 2). */
  contradictions?: StoreContradictionWarning[];
  /** Supersession detail when `replaces` triggered a transition (Phase 2). */
  superseded?: StoreSupersededDetail;
}

export interface StoreErrorResponse {
  error: string;
  pattern?: string;
  action: 'blocked';
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
}

export interface SearchResponse {
  results: SearchResult[];
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
  type: 'mcp_config' | 'claude_md_marker' | 'agents_md_marker' | 'hook_config' | 'config_dir';
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
