/**
 * Vitest globalSetup/globalTeardown for the E2E suite (gh#318).
 *
 * Runs once per `vitest run`, in the main process rather than a worker — which
 * is why the created-org list travels through the on-disk manifest in
 * `cleanup.ts` rather than through module state.
 *
 * For the 166 non-E2E test files this is a pure no-op: with no orgs recorded,
 * teardown reads an empty (usually absent) manifest and returns immediately.
 */

import { teardownCreatedOrgs, MANIFEST_PATH, readManifest } from './cleanup.js';

export async function setup(): Promise<void> {
  // A non-empty manifest at startup means a previous run died before teardown.
  // Say so rather than silently inheriting someone else's leak.
  const stale = await readManifest();
  if (stale.length > 0) {
    console.warn(
      `[e2e-cleanup] ${stale.length} org(s) left over from a previous run in ` +
        `${MANIFEST_PATH}; they will be cleaned up at the end of this run.`,
    );
  }
}

export async function teardown(): Promise<void> {
  const result = await teardownCreatedOrgs();
  if (result.deleted > 0) {
    console.log(
      `[e2e-cleanup] deleted ${result.deleted}/${result.attempted} test org(s) from Qdrant + Postgres.`,
    );
  }
}
