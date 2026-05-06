/**
 * SessionStart hook roundtrip integration test (T026, US1).
 *
 * Exercises hookSessionStartCommand under simulated Claude-Code env and
 * asserts each documented branch produces the right stdout shape.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hookSessionStartCommand } from '../../src/hooks/session-start-handler.js';
import { write as writeCache } from '../../src/hooks/cache.js';
import type { ProjectContextSnapshot } from '../../src/hooks/cache.js';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeSessionId: string | undefined;
let prevFetch: typeof globalThis.fetch | undefined;

function snapshot(overrides: Partial<ProjectContextSnapshot> = {}): ProjectContextSnapshot {
  return {
    org_id: ORG_ID,
    org_name: 'Krukit',
    project_id: PROJECT_ID,
    project_name: 'valis',
    fetched_at: new Date().toISOString(),
    ttl_seconds: 300,
    enforcement_mode: 'advisory',
    decision_count: 1,
    violation_count: 0,
    decisions: [
      {
        id: 'd-1',
        summary: 'Use TTL + own-write cache invalidation',
        status: 'active',
        type: 'decision',
        affects: ['packages/cli/src/hooks/cache.ts'],
        score: 0.9,
      },
    ],
    recent_contradictions: [],
    block_envelope: {
      purpose: 'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions',
      precedence: 'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns',
      for_session_template: '<session_id>',
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-int-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-proj-'));

  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;
  prevFetch = globalThis.fetch;

  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_SESSION_ID = 'sess-test-1';

  // Default: write a global config + .valis.json marker
  await mkdir(tempHome, { recursive: true });
  await writeFile(
    join(tempHome, 'config.json'),
    JSON.stringify({
      org_id: ORG_ID,
      member_api_key: 'tmm_test',
      api_base_url: 'http://test',
    }),
  );
  await writeFile(
    join(projectDir, '.valis.json'),
    JSON.stringify({ project_id: PROJECT_ID, project_name: 'valis' }),
  );

  stdoutChunks = [];
  writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as ReturnType<typeof vi.spyOn>;
});

afterEach(async () => {
  writeSpy.mockRestore();
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  if (prevClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = prevClaudeProjectDir;
  if (prevClaudeSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = prevClaudeSessionId;
  // Always restore fetch — `prevFetch` is captured before any test mocks
  // so this unconditionally reverts to the native value.
  globalThis.fetch = prevFetch as typeof globalThis.fetch;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('SessionStart roundtrip', () => {
  it('Branch A: fresh cache produces valid JSON with parseable <valis_team_decisions>', async () => {
    await writeCache(ORG_ID, PROJECT_ID, snapshot());
    const t0 = Date.now();
    await hookSessionStartCommand();
    const elapsed = Date.now() - t0;

    expect(stdoutChunks.length).toBe(1);
    const parsed = JSON.parse(stdoutChunks[0]);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<valis_team_decisions /);
    expect(ctx).toContain('for_session="sess-test-1"');
    expect(ctx).toContain('id="d-1"');
    expect(ctx).toContain('</valis_team_decisions>');
    // Cache-hit branch should be fast.
    expect(elapsed).toBeLessThan(500);
  });

  it('Branch D: fresh cache with zero decisions emits <empty_state>', async () => {
    await writeCache(
      ORG_ID,
      PROJECT_ID,
      snapshot({ decision_count: 0, decisions: [] }),
    );
    await hookSessionStartCommand();
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('<empty_state>');
    expect(ctx).toContain('do not invent prior team consensus');
  });

  it('Branch B: stale cache + backend unreachable emits cache_age_seconds', async () => {
    // Cache from 30 minutes ago, TTL 5 min.
    await writeCache(
      ORG_ID,
      PROJECT_ID,
      snapshot({
        fetched_at: new Date(Date.now() - 30 * 60_000).toISOString(),
        ttl_seconds: 300,
      }),
    );
    // Backend fetch fails.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;

    await hookSessionStartCommand();
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/<valis_team_decisions [^>]*cache_age_seconds=/);
    expect(ctx).toContain('Served from local cache');
  });

  it('Branch C: no cache + backend unreachable emits <valis_offline>', async () => {
    // No cache at all; backend fails.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof globalThis.fetch;

    await hookSessionStartCommand();
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/^<valis_offline /);
    expect(ctx).toContain('Do not invent or paraphrase');
  });

  it('Branch E: no .valis.json marker → silent skip (empty stdout)', async () => {
    await rm(join(projectDir, '.valis.json'), { force: true });
    await hookSessionStartCommand();
    expect(stdoutChunks.length).toBe(0);
  });

  it('output is parseable as JSON in all happy branches', async () => {
    await writeCache(ORG_ID, PROJECT_ID, snapshot());
    await hookSessionStartCommand();
    expect(() => JSON.parse(stdoutChunks[0])).not.toThrow();
  });

  it('cache-hit branch emits the canonical labeled-block attributes', async () => {
    await writeCache(ORG_ID, PROJECT_ID, snapshot());
    await hookSessionStartCommand();
    const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('purpose="authoritative team knowledge');
    expect(ctx).toContain('precedence="engineering, brand');
    expect(ctx).toContain('project="valis"');
  });
});
