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
}

export interface StoreResponse {
  id: string;
  status: 'stored' | 'duplicate';
  synced?: boolean;
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
