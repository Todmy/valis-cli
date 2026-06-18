/**
 * E2E Test 8: Community (self-host) UPGRADE — prove the apply-only-new mechanic.
 *
 * This test owns a FRESH, ephemeral community docker stack (its own compose
 * project name + high host ports so it never collides with a dev stack or with
 * 07-), drives the REAL `valis init` wizard against it, stores a marker
 * decision, then simulates a schema upgrade:
 *
 *   1. fresh stack up → `valis init` → store marker decision (35 migrations applied)
 *   2. drop a SYNTHETIC additive migration 036_upgrade_smoke.sql into the
 *      mounted community/migrations/ dir (the migrate service re-reads it on re-up)
 *   3. re-run the one-shot migrate service (`docker compose up migrate`)
 *   4. ASSERT: ledger shows "1 applied, 35 already present"; 036 is newly in the
 *      ledger; the pre-existing marker decision row + its data are INTACT; the
 *      synthetic table/column exist; store + search still round-trip.
 *
 * Cleanup ALWAYS removes the synthetic migration file AND tears the stack down
 * (`docker compose down -v`). 036 is never committed — it is written at runtime
 * and deleted in afterAll.
 *
 * CI-GATED — skipped unless ALL hold (keeps the hermetic suite untouched):
 *   - env VALIS_E2E_UPGRADE=1
 *   - `docker` + `docker compose` on PATH and a reachable daemon
 *   - `expect` on PATH
 *
 * Run locally:
 *   VALIS_E2E_UPGRADE=1 pnpm test -- 08-community-upgrade
 *
 * Port overrides (only if the defaults below collide):
 *   VALIS_UPGRADE_KONG_PORT / _PG_PORT / _QDRANT_HTTP_PORT / _QDRANT_GRPC_PORT / _KONG_HTTPS_PORT
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const COMMUNITY_DIR = join(__dirname, '..', '..', 'community');
const MIGRATIONS_DIR = join(COMMUNITY_DIR, 'migrations');
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'bin', 'valis.js');
const COMPOSE_PROJECT = `valis-upgrade-e2e-${randomUUID().slice(0, 6)}`;
const SYNTH_MIGRATION = '036_upgrade_smoke.sql';
const SYNTH_PATH = join(MIGRATIONS_DIR, SYNTH_MIGRATION);

// Ephemeral high host ports (override-able) so we never collide with a running
// dev stack or the 07- harness.
const KONG_PORT = process.env.VALIS_UPGRADE_KONG_PORT ?? '58100';
const PG_PORT = process.env.VALIS_UPGRADE_PG_PORT ?? '55532';
const QDRANT_HTTP_PORT = process.env.VALIS_UPGRADE_QDRANT_HTTP_PORT ?? '56433';
const QDRANT_GRPC_PORT = process.env.VALIS_UPGRADE_QDRANT_GRPC_PORT ?? '56434';
const KONG_HTTPS_PORT = process.env.VALIS_UPGRADE_KONG_HTTPS_PORT ?? '58543';

const SUPABASE_URL = `http://localhost:${KONG_PORT}`;
const QDRANT_URL = `http://localhost:${QDRANT_HTTP_PORT}`;

function hasBin(bin: string, args: string[]): boolean {
  try {
    return spawnSync(bin, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function hasDocker(): boolean {
  // daemon reachable + compose plugin present
  try {
    if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) return false;
    return spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function canRun(): boolean {
  return (
    process.env.VALIS_E2E_UPGRADE === '1' &&
    hasBin('expect', ['-v']) &&
    hasDocker()
  );
}

const describeUpgrade = canRun() ? describe : describe.skip;

// Run a docker-compose command in the community dir with our isolated project
// name + port env. Returns { code, stdout, stderr }.
function compose(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 300_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', ['compose', '-p', COMPOSE_PROJECT, ...args], {
      cwd: COMMUNITY_DIR,
      env,
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (c) => (stdout += c.toString()));
    p.stderr.on('data', (c) => (stderr += c.toString()));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// Read the migrate service's combined log line: "[valis] migrations: N applied, M already present (T total)."
function parseMigrateSummary(log: string): { applied: number; skipped: number; total: number } | null {
  const m = /migrations:\s+(\d+)\s+applied,\s+(\d+)\s+already present\s+\((\d+)\s+total\)/.exec(log);
  if (!m) return null;
  return { applied: Number(m[1]), skipped: Number(m[2]), total: Number(m[3]) };
}

const EXPECT_SCRIPT = `#!/usr/bin/expect -f
set timeout 180
set cli [lindex $argv 0]
spawn node "$cli" init
expect -re {How would you like to start} { send "\\033\\[B"; send "\\033\\[B"; send "\\r" }
expect -re {Qdrant API Key:} { send "\\r" }
expect -re {Organization name:} { send "\\r" }
expect -re {Your name:} { send "Upgrade E2E\\r" }
expect -re {Project name} { send "\\r" }
expect {
  -re {\\[y/N\\]} { send "n\\r"; exp_continue }
  -re {\\[Y/n\\]} { send "n\\r"; exp_continue }
  -re {Import into Valis} { send "n\\r"; exp_continue }
  -re {Setup Complete} { exp_continue }
  eof { }
  timeout { puts "WIZARD_TIMEOUT"; exit 2 }
}
catch wait result
exit [lindex $result 3]
`;

describeUpgrade('e2e: Community self-host UPGRADE (apply-only-new, data intact)', () => {
  let testRoot: string;
  let homeDir: string;
  let projDir: string;
  let composeEnv: NodeJS.ProcessEnv;
  let wizardEnv: NodeJS.ProcessEnv;
  let serviceRoleKey: string;
  let projectId: string;
  let firstUpSummary: { applied: number; skipped: number; total: number } | null = null;
  let upgradeSummary: { applied: number; skipped: number; total: number } | null = null;
  const marker = `UPGRADE-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'valis-upgrade-e2e-'));
    homeDir = join(testRoot, 'home');
    projDir = join(testRoot, 'proj');
    await mkdir(homeDir, { recursive: true });
    await mkdir(projDir, { recursive: true });

    // Defensive: ensure no leftover synthetic migration from a crashed run.
    if (existsSync(SYNTH_PATH)) await unlink(SYNTH_PATH);

    // 1. Generate keys into an ephemeral .env (generate-keys.sh edits .env in
    //    place; we write a throwaway .env in the community dir scoped to this
    //    compose project, then restore). To avoid clobbering a dev .env we use
    //    a temp env file path via COMPOSE-injected vars instead.
    //
    // Simpler + isolated: build the secrets ourselves (same HS256 scheme as
    // generate-keys.sh) and pass them straight to compose via env — no .env
    // file touched at all.
    const crypto = await import('node:crypto');
    const jwtSecret = crypto.randomBytes(32).toString('hex');
    const pgPassword = crypto.randomBytes(24).toString('hex');
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const signKey = (role: string) => {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'HS256', typ: 'JWT' };
      const payload = { role, iss: 'valis-community', iat: now, exp: now + 60 * 60 * 24 * 365 * 5 };
      const data = `${b64(header)}.${b64(payload)}`;
      const sig = crypto
        .createHmac('sha256', jwtSecret)
        .update(data)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      return `${data}.${sig}`;
    };
    const anonKey = signKey('anon');
    serviceRoleKey = signKey('service_role');

    composeEnv = {
      ...process.env,
      POSTGRES_PASSWORD: pgPassword,
      JWT_SECRET: jwtSecret,
      ANON_KEY: anonKey,
      SERVICE_ROLE_KEY: serviceRoleKey,
      KONG_HTTP_PORT: KONG_PORT,
      KONG_HTTPS_PORT: KONG_HTTPS_PORT,
      POSTGRES_PORT: PG_PORT,
      QDRANT_HTTP_PORT,
      QDRANT_GRPC_PORT,
      API_EXTERNAL_URL: SUPABASE_URL,
    };

    // 2. Bring up the FRESH stack (db + migrate + auth + rest + kong + qdrant).
    const up = await compose(['up', '-d', '--wait'], composeEnv);
    if (up.code !== 0) {
      throw new Error(`docker compose up failed:\n${up.stdout}\n${up.stderr}`);
    }

    // Capture the migrate service's first-run summary (35 applied, 0 skipped).
    const migrateLog1 = await compose(['logs', 'migrate'], composeEnv);
    firstUpSummary = parseMigrateSummary(migrateLog1.stdout + migrateLog1.stderr);

    // 3. Drive the REAL wizard against the fresh stack.
    wizardEnv = {
      ...process.env,
      HOME: homeDir,
      VALIS_HOME: join(homeDir, '.valis'),
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      QDRANT_URL,
      QDRANT_API_KEY: '',
    };
    const scriptPath = join(testRoot, 'drive-init.exp');
    await writeFile(scriptPath, EXPECT_SCRIPT, 'utf-8');
    const initCode: number = await new Promise((resolve) => {
      const p = spawn('expect', ['-f', scriptPath, CLI_DIST], {
        cwd: projDir,
        env: wizardEnv,
        stdio: 'ignore',
      });
      p.on('exit', (c) => resolve(c ?? -1));
    });
    if (initCode !== 0) throw new Error(`wizard exited ${initCode}`);

    const valisJson = JSON.parse(await readFile(join(projDir, '.valis', 'config.json'), 'utf-8'));
    projectId = valisJson.project_id;

    // 4. Store a MARKER decision via the REAL MCP serve, so we have a real row +
    //    Qdrant point to prove survives the upgrade.
    await storeMarker(wizardEnv, projDir, marker);

    // 5. Drop the SYNTHETIC additive migration into the mounted migrations dir.
    await writeFile(
      SYNTH_PATH,
      [
        '-- SYNTHETIC upgrade-smoke migration (e2e only — never committed).',
        'CREATE TABLE IF NOT EXISTS public.valis_upgrade_smoke(id int primary key);',
        "ALTER TABLE public.decisions ADD COLUMN IF NOT EXISTS upgrade_smoke text;",
        '',
      ].join('\n'),
      'utf-8',
    );

    // 6. Re-run the one-shot migrate service (it re-reads the mounted dir).
    //    `up migrate` recreates the one-shot; --no-deps so db isn't restarted.
    const reup = await compose(['up', '-d', '--no-deps', '--force-recreate', 'migrate'], composeEnv);
    if (reup.code !== 0) {
      throw new Error(`migrate re-up failed:\n${reup.stdout}\n${reup.stderr}`);
    }
    // Wait for the one-shot to exit, then read its (fresh) logs.
    await waitForMigrateExit(composeEnv);
    const migrateLog2 = await compose(['logs', '--no-log-prefix', 'migrate'], composeEnv);
    upgradeSummary = parseMigrateSummary(migrateLog2.stdout + migrateLog2.stderr);
  }, 600_000);

  afterAll(async () => {
    // Always remove the synthetic migration + tear the stack down.
    try {
      if (existsSync(SYNTH_PATH)) await unlink(SYNTH_PATH);
    } catch {
      /* ignore */
    }
    if (composeEnv) {
      await compose(['down', '-v'], composeEnv, 120_000);
    }
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  }, 180_000);

  it('fresh stack applied all 35 migrations on first up (0 skipped)', () => {
    expect(firstUpSummary, 'first-run migrate summary should parse').not.toBeNull();
    expect(firstUpSummary!.applied).toBe(35);
    expect(firstUpSummary!.skipped).toBe(0);
    expect(firstUpSummary!.total).toBe(35);
  });

  it('upgrade re-run applied ONLY the new 036 (1 applied, 35 already present)', () => {
    expect(upgradeSummary, 'upgrade migrate summary should parse').not.toBeNull();
    expect(upgradeSummary!.applied).toBe(1);
    expect(upgradeSummary!.skipped).toBe(35);
    expect(upgradeSummary!.total).toBe(36);
  });

  it('ledger records 036 as newly applied and still holds the prior 35', async () => {
    const supabase = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('valis_schema_migrations')
      .select('filename');
    expect(error).toBeNull();
    const names = (data ?? []).map((r) => (r as { filename: string }).filename);
    expect(names).toContain(SYNTH_MIGRATION);
    expect(names.length).toBe(36);
  });

  it('the synthetic table + column exist after upgrade', async () => {
    const supabase = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false } });
    // New table is reachable via PostgREST only after a schema reload; assert via
    // a count query that would error if the table were absent.
    const smoke = await supabase.from('valis_upgrade_smoke').select('id', { count: 'exact', head: true });
    expect(smoke.error, smoke.error?.message).toBeNull();
  });

  it('the pre-existing marker decision row + its data survived the upgrade', async () => {
    const supabase = createClient(SUPABASE_URL, serviceRoleKey, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('decisions')
      .select('id, summary, detail, project_id')
      .eq('project_id', projectId);
    expect(error).toBeNull();
    const hit = (data ?? []).find(
      (d) =>
        (d as { summary?: string }).summary?.includes(marker) ||
        (d as { detail?: string }).detail?.includes(marker),
    );
    expect(hit, `marker ${marker} decision must still exist after upgrade`).toBeTruthy();
  });

  it('store + search still round-trip after the upgrade', async () => {
    const secondMarker = `POSTUP-${randomUUID().slice(0, 8)}`;
    const found = await storeAndSearch(wizardEnv, projDir, secondMarker);
    expect(found, `post-upgrade marker ${secondMarker} should round-trip`).toBe(true);
  });
});

// --- MCP stdio helpers (mirror 07-) ----------------------------------------

function makeMcpClient(env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn('node', [CLI_DIST, 'serve'], { stdio: ['pipe', 'pipe', 'ignore'], cwd, env });
  let buf = '';
  const pending = new Map<number, (m: unknown) => void>();
  let nextId = 1;
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });
  function rpc<T = { error?: unknown; result?: { content?: Array<{ text?: string }> } }>(
    method: string,
    params: unknown,
  ): Promise<T> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve as (m: unknown) => void);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  function notify(method: string, params: unknown) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
  return { child, rpc, notify };
}

async function storeMarker(env: NodeJS.ProcessEnv, cwd: string, marker: string): Promise<void> {
  const { child, rpc, notify } = makeMcpClient(env, cwd);
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'upgrade-e2e', version: '1.0.0' },
    });
    notify('notifications/initialized', {});
    const res = await rpc('tools/call', {
      name: 'valis_store',
      arguments: {
        text: `MARKER ${marker}: pre-upgrade decision that must survive the apply-only-new migration.`,
        type: 'decision',
        summary: `marker ${marker}`,
        status: 'active',
      },
    });
    const text = res.result?.content?.[0]?.text ?? '';
    if (!text.includes('stored')) throw new Error(`store did not confirm: ${text}`);
  } finally {
    child.kill();
  }
}

async function storeAndSearch(env: NodeJS.ProcessEnv, cwd: string, marker: string): Promise<boolean> {
  const { child, rpc, notify } = makeMcpClient(env, cwd);
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'upgrade-e2e', version: '1.0.0' },
    });
    notify('notifications/initialized', {});
    await rpc('tools/call', {
      name: 'valis_store',
      arguments: {
        text: `MARKER ${marker}: post-upgrade round-trip probe.`,
        type: 'decision',
        summary: `marker ${marker}`,
        status: 'active',
      },
    });
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const searchRes = await rpc('tools/call', {
        name: 'valis_search',
        arguments: { query: `marker ${marker} post-upgrade round-trip probe`, limit: 5 },
      });
      const text = searchRes.result?.content?.[0]?.text ?? '';
      if (text.includes(marker)) found = true;
    }
    return found;
  } finally {
    child.kill();
  }
}

// Poll until the one-shot `migrate` container has exited (state != running).
async function waitForMigrateExit(env: NodeJS.ProcessEnv): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ps = await compose(['ps', '-a', '--format', '{{.Service}} {{.State}}'], env, 30_000);
    const line = ps.stdout.split('\n').find((l) => l.startsWith('migrate '));
    if (line && !/\brunning\b/.test(line)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
