/**
 * E2E teardown: delete every org a run created, in Qdrant and in Postgres (gh#318).
 *
 * Two halves:
 *
 *  1. `trackCreatedOrg()` appends the org to an on-disk JSONL manifest the
 *     *instant* it is created — before the test that uses it has even started.
 *     A mid-run kill (SIGKILL, CI timeout, laptop lid) therefore still leaves a
 *     durable record of what leaked, which `scripts/e2e-sweep.mjs` can consume.
 *
 *  2. `teardownCreatedOrgs()` reads the manifest and deletes. It runs from
 *     vitest's `globalTeardown` (see `global-setup.ts`), which is a separate
 *     process from the test workers — the manifest is what bridges them.
 *
 * Deletion order matters: **Qdrant first, Postgres second.** Every org-scoped
 * Postgres table cascades from `orgs` (`ON DELETE CASCADE`), but that cascade
 * does not reach the vector store. Delete the org row first and the vectors
 * become orphans nothing can find — the 58 stranded points in `decisions_v2`
 * are exactly that failure.
 *
 * Teardown is best-effort and idempotent: an empty manifest, an already-deleted
 * org, or a collection that does not exist are all silent no-ops. It never
 * throws, so it cannot turn a green suite red.
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Path of the created-org manifest. Override with `VALIS_E2E_MANIFEST`. */
export const MANIFEST_PATH =
  process.env.VALIS_E2E_MANIFEST ?? join(HERE, '.created-orgs.jsonl');

/** Qdrant collections that may hold decision vectors. */
export const QDRANT_COLLECTIONS = ['decisions_v2', 'decisions'] as const;

export interface CreatedOrg {
  org_id: string;
  org_name: string;
  /** ISO timestamp of creation — lets the sweep script apply an age cutoff. */
  created_at: string;
  /** Which run produced it; purely for forensics. */
  run_id?: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface TeardownCreds {
  supabaseUrl: string;
  serviceRoleKey: string;
  qdrantUrl: string;
  qdrantApiKey: string;
}

/**
 * Read admin credentials from the environment.
 *
 * Returns `null` when they are absent — the registration path only ever hands
 * the suite a member key, which cannot delete an org. Without these the run can
 * still execute, but it *will* leak, so callers warn loudly.
 */
export function readTeardownCreds(
  env: NodeJS.ProcessEnv = process.env,
): TeardownCreds | null {
  const supabaseUrl = env.VALIS_E2E_SUPABASE_URL ?? '';
  const serviceRoleKey = env.VALIS_E2E_SUPABASE_SERVICE_ROLE_KEY ?? '';
  const qdrantUrl = env.VALIS_E2E_QDRANT_URL ?? '';
  const qdrantApiKey = env.VALIS_E2E_QDRANT_API_KEY ?? '';

  if (!supabaseUrl || !serviceRoleKey || !qdrantUrl || !qdrantApiKey) return null;
  return { supabaseUrl, serviceRoleKey, qdrantUrl, qdrantApiKey };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Append a freshly created org to the manifest. Never throws. */
export async function trackCreatedOrg(entry: CreatedOrg): Promise<void> {
  try {
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await appendFile(MANIFEST_PATH, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn(
      `[e2e-cleanup] could not record org ${entry.org_id} in the manifest ` +
        `(${(err as Error).message}) — it may leak; run scripts/e2e-sweep.mjs`,
    );
  }
}

/** Read the manifest. Missing file → empty list. Malformed lines are skipped. */
export async function readManifest(): Promise<CreatedOrg[]> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, 'utf-8');
  } catch {
    return [];
  }

  const out: CreatedOrg[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CreatedOrg;
      if (parsed?.org_id) out.push(parsed);
    } catch {
      // ignore a torn final line from a killed process
    }
  }
  return out;
}

/** Rewrite the manifest with only the entries that still need cleanup. */
export async function writeManifest(entries: CreatedOrg[]): Promise<void> {
  const body = entries.map((e) => JSON.stringify(e)).join('\n');
  await writeFile(MANIFEST_PATH, body ? body + '\n' : '', 'utf-8');
}

// ---------------------------------------------------------------------------
// Deletion primitives
// ---------------------------------------------------------------------------

/**
 * Delete every point carrying `org_id` from one Qdrant collection.
 *
 * `org_id` is an indexed payload field on every decision point
 * (`src/cloud/qdrant/decisions.ts`), so one filtered delete covers all of the
 * org's projects. A 404 means the collection does not exist — treated as done.
 */
export async function deleteQdrantOrg(
  creds: TeardownCreds,
  collection: string,
  orgId: string,
): Promise<'deleted' | 'missing-collection'> {
  const res = await fetch(
    `${creds.qdrantUrl.replace(/\/$/, '')}/collections/${collection}/points/delete?wait=true`,
    {
      method: 'POST',
      headers: {
        'api-key': creds.qdrantApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: { must: [{ key: 'org_id', match: { value: orgId } }] },
      }),
    },
  );

  if (res.status === 404) return 'missing-collection';
  if (!res.ok) {
    throw new Error(
      `qdrant delete ${collection}/${orgId}: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  return 'deleted';
}

/**
 * Delete the org row from Postgres. Every org-scoped table cascades from here.
 * Deleting an org that is already gone is a successful no-op.
 */
export async function deleteSupabaseOrg(
  creds: TeardownCreds,
  orgId: string,
): Promise<void> {
  const res = await fetch(
    `${creds.supabaseUrl.replace(/\/$/, '')}/rest/v1/orgs?id=eq.${encodeURIComponent(orgId)}`,
    {
      method: 'DELETE',
      headers: {
        apikey: creds.serviceRoleKey,
        Authorization: `Bearer ${creds.serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `supabase delete orgs/${orgId}: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
}

/** Qdrant first, then Postgres. See the module note on why the order matters. */
export async function deleteOrgEverywhere(
  creds: TeardownCreds,
  orgId: string,
): Promise<void> {
  for (const collection of QDRANT_COLLECTIONS) {
    await deleteQdrantOrg(creds, collection, orgId);
  }
  await deleteSupabaseOrg(creds, orgId);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface TeardownResult {
  attempted: number;
  deleted: number;
  failed: CreatedOrg[];
  skippedReason?: 'nothing-to-do' | 'no-credentials';
}

/**
 * Delete every org recorded in the manifest, then rewrite the manifest with
 * whatever could not be deleted. Never throws.
 */
export async function teardownCreatedOrgs(): Promise<TeardownResult> {
  const entries = await readManifest();
  if (entries.length === 0) {
    return { attempted: 0, deleted: 0, failed: [], skippedReason: 'nothing-to-do' };
  }

  const creds = readTeardownCreds();
  if (!creds) {
    console.warn(
      `\n[e2e-cleanup] ${entries.length} org(s) were created but CANNOT be deleted:\n` +
        '  missing VALIS_E2E_SUPABASE_SERVICE_ROLE_KEY / VALIS_E2E_QDRANT_URL / VALIS_E2E_QDRANT_API_KEY.\n' +
        `  They are recorded in ${MANIFEST_PATH}.\n` +
        '  Clean up with: node scripts/e2e-sweep.mjs --apply\n',
    );
    return {
      attempted: entries.length,
      deleted: 0,
      failed: entries,
      skippedReason: 'no-credentials',
    };
  }

  const failed: CreatedOrg[] = [];
  let deleted = 0;

  for (const entry of entries) {
    try {
      await deleteOrgEverywhere(creds, entry.org_id);
      deleted += 1;
    } catch (err) {
      failed.push(entry);
      console.warn(
        `[e2e-cleanup] failed to delete ${entry.org_name} (${entry.org_id}): ${(err as Error).message}`,
      );
    }
  }

  try {
    await writeManifest(failed);
  } catch {
    // manifest is a convenience; the sweep script can still find orgs by name
  }

  if (failed.length > 0) {
    console.warn(
      `[e2e-cleanup] ${failed.length} org(s) left behind — run: node scripts/e2e-sweep.mjs --apply`,
    );
  }

  return { attempted: entries.length, deleted, failed };
}
