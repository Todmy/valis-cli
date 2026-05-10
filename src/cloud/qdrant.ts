/**
 * Qdrant facade — barrel re-exports the four concern-scoped sub-modules
 * under `cloud/qdrant/`. The split happened on the architecture-deepening
 * branch (2026-05-10):
 *
 *   - `cloud/qdrant/client.ts`     — connection + collection lifecycle
 *   - `cloud/qdrant/decisions.ts`  — decision CRUD + text helpers
 *   - `cloud/qdrant/search.ts`     — hybrid search + filter builders + query expansion
 *   - `cloud/qdrant/admin.ts`      — migration + reindex + stats + similarity probe
 *
 * Existing callsites keep working unchanged. New code SHOULD import directly
 * from the sub-module to make the dependency explicit:
 *
 *   import { hybridSearch } from './cloud/qdrant/search.js';
 *   import { upsertDecision } from './cloud/qdrant/decisions.js';
 *   import { reindexAllPoints } from './cloud/qdrant/admin.js';
 */

export * from './qdrant/client.js';
export * from './qdrant/decisions.js';
export * from './qdrant/search.js';
export * from './qdrant/admin.js';
