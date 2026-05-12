/**
 * Supabase facade — barrel re-exports the five concern-scoped sub-modules
 * under `cloud/supabase/`. The split happened on the architecture-deepening
 * branch (2026-05-12):
 *
 *   - `cloud/supabase/client.ts`    — connection lifecycle + healthCheck
 *   - `cloud/supabase/decisions.ts` — decision CRUD + queries + lifecycle
 *   - `cloud/supabase/audit.ts`     — audit-trail storage
 *   - `cloud/supabase/members.ts`   — org / project / member operations
 *   - `cloud/supabase/dashboard.ts` — stats aggregation
 *
 * Existing callsites import unchanged. New code SHOULD import directly
 * from the sub-module to make the dependency explicit:
 *
 *   import { storeDecision } from './cloud/supabase/decisions.js';
 *   import { listMemberProjects } from './cloud/supabase/members.js';
 *   import { getAuditTrail } from './cloud/supabase/audit.js';
 */

export * from './supabase/client.js';
export * from './supabase/decisions.js';
export * from './supabase/audit.js';
export * from './supabase/members.js';
export { getDashboardStats } from './supabase/dashboard.js';
