/**
 * E2E Test 7: valis init — Community (self-host) fresh install, end-to-end.
 *
 * This is the ONLY test that drives the REAL `valis init` inquirer wizard
 * (via a pty through `expect`) against a live self-hosted backend, then
 * round-trips a marker decision through the REAL `valis serve` stdio MCP
 * server. It is the regression guard for the #301 fresh-install fixes:
 *   - service_role_key threaded promptAndCreateProject → createProject
 *   - direct-SQL createProject inserts the project_members (project_admin) row
 *     so MCP `canWriteToProject` succeeds (no project_access_denied).
 *
 * CI-GATED — skipped unless ALL of the following hold (so the hermetic CI
 * suite is untouched):
 *   - env VALIS_E2E_COMMUNITY=1
 *   - env VALIS_COMMUNITY_SUPABASE_URL          (Kong URL, e.g. http://localhost:58000)
 *   - env VALIS_COMMUNITY_SERVICE_ROLE_KEY      (Supabase service_role JWT)
 *   - env VALIS_COMMUNITY_QDRANT_URL            (e.g. http://localhost:56333)
 *   - the `expect` binary is on PATH
 *
 * Run locally against the community docker stack (see community/README.md):
 *   VALIS_E2E_COMMUNITY=1 \
 *   VALIS_COMMUNITY_SUPABASE_URL=http://localhost:58000 \
 *   VALIS_COMMUNITY_SERVICE_ROLE_KEY="$(grep '^SERVICE_ROLE_KEY=' community/.env | cut -d= -f2-)" \
 *   VALIS_COMMUNITY_QDRANT_URL=http://localhost:56333 \
 *   pnpm test -- 07-community-fresh-install
 *
 * Note: QDRANT_API_KEY is deliberately EMPTY — community Qdrant has no key.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VALIS_COMMUNITY_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.VALIS_COMMUNITY_SERVICE_ROLE_KEY ?? '';
const QDRANT_URL = process.env.VALIS_COMMUNITY_QDRANT_URL ?? '';

function hasExpect(): boolean {
  try {
    return spawnSync('expect', ['-v'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function canRunCommunityE2E(): boolean {
  return (
    process.env.VALIS_E2E_COMMUNITY === '1' &&
    !!SUPABASE_URL &&
    !!SERVICE_ROLE_KEY &&
    !!QDRANT_URL &&
    hasExpect()
  );
}

// Resolve the built CLI entrypoint (dist must be built: `pnpm build`).
const CLI_DIST = join(__dirname, '..', '..', 'dist', 'bin', 'valis.js');

const describeCommunity = canRunCommunityE2E() ? describe : describe.skip;

const EXPECT_SCRIPT = `#!/usr/bin/expect -f
set timeout 180
set cli   [lindex $argv 0]
spawn node "$cli" init
# 1. start menu — Community is the 3rd option (Down Down Enter)
expect -re {How would you like to start} { send "\\033\\[B"; send "\\033\\[B"; send "\\r" }
# 2. Qdrant API Key (env empty -> prompt) — empty line
expect -re {Qdrant API Key:} { send "\\r" }
# 3. Organization name (default)
expect -re {Organization name:} { send "\\r" }
# 4. Your name
expect -re {Your name:} { send "Community E2E\\r" }
# 5. Project name (default)
expect -re {Project name} { send "\\r" }
# tail — decline any y/N or [Y/n] prompts, run to Setup Complete / EOF
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

// Minimal in-process MCP stdio client to drive `valis serve`.
function makeMcpClient(env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn('node', [CLI_DIST, 'serve'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    cwd,
    env,
  });
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

describeCommunity('e2e: valis init — Community fresh install (real wizard + real MCP)', () => {
  let testRoot: string;
  let homeDir: string;
  let projDir: string;
  let projectId: string;
  let memberId: string;
  let wizardEnv: NodeJS.ProcessEnv;
  const marker = `CME2E-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), 'valis-community-e2e-'));
    homeDir = join(testRoot, 'home');
    projDir = join(testRoot, 'proj');
    await mkdir(homeDir, { recursive: true });
    await mkdir(projDir, { recursive: true });

    wizardEnv = {
      ...process.env,
      HOME: homeDir,
      VALIS_HOME: join(homeDir, '.valis'),
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      QDRANT_URL,
      QDRANT_API_KEY: '', // EMPTY — community Qdrant has no key
    };

    // Drive the real wizard via expect.
    const scriptPath = join(testRoot, 'drive-init.exp');
    await writeFile(scriptPath, EXPECT_SCRIPT, 'utf-8');

    const code: number = await new Promise((resolve) => {
      const p = spawn('expect', ['-f', scriptPath, CLI_DIST], {
        cwd: projDir,
        env: wizardEnv,
        stdio: 'ignore',
      });
      p.on('exit', (c) => resolve(c ?? -1));
    });
    expect(code, 'wizard should exit 0').toBe(0);

    // Read the project_id the wizard wrote (no manual creation).
    const valisJson = JSON.parse(
      await readFile(join(projDir, '.valis', 'config.json'), 'utf-8'),
    );
    projectId = valisJson.project_id;
    const globalCfg = JSON.parse(
      await readFile(join(homeDir, '.valis', 'config.json'), 'utf-8'),
    );
    memberId = globalCfg.member_id;
  }, 240_000);

  afterAll(async () => {
    if (testRoot) await rm(testRoot, { recursive: true, force: true });
  });

  it('wizard wrote .valis.json with a project_id and service-role global config', () => {
    expect(projectId).toBeTruthy();
    expect(memberId).toBeTruthy();
  });

  it('wizard auto-linked the creator as project_admin (Fix #301)', async () => {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { data, error } = await supabase
      .from('project_members')
      .select('member_id, role')
      .eq('project_id', projectId)
      .eq('member_id', memberId)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.role).toBe('project_admin');
  });

  it('wizard auto-created the Qdrant collection', async () => {
    const res = await fetch(`${QDRANT_URL}/collections`);
    const body = (await res.json()) as { result: { collections: Array<{ name: string }> } };
    const names = body.result.collections.map((c) => c.name);
    expect(names).toContain('decisions_v2');
  });

  it('round-trips a marker through the REAL valis serve MCP (store + search)', async () => {
    const { child, rpc, notify } = makeMcpClient(wizardEnv, projDir);
    try {
      const init = await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'community-e2e', version: '1.0.0' },
      });
      expect((init as { error?: unknown }).error).toBeUndefined();
      notify('notifications/initialized', {});

      const storeRes = await rpc('tools/call', {
        name: 'valis_store',
        arguments: {
          text: `MARKER ${marker}: community self-host fresh-install MCP round-trip regression probe.`,
          type: 'decision',
          summary: `marker ${marker}`,
          status: 'active',
        },
      });
      const storeText = storeRes.result?.content?.[0]?.text ?? '';
      expect(storeText).toContain('stored');

      // Qdrant indexing is eventually consistent — retry the search.
      let found = false;
      let lastText = '';
      for (let i = 0; i < 20 && !found; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const searchRes = await rpc('tools/call', {
          name: 'valis_search',
          arguments: { query: `marker ${marker} self-host round-trip probe`, limit: 5 },
        });
        lastText = searchRes.result?.content?.[0]?.text ?? '';
        if (lastText.includes(marker)) found = true;
      }
      expect(found, `marker ${marker} should be returned by valis_search`).toBe(true);
    } finally {
      child.kill();
    }
  }, 90_000);
});
