/**
 * T062 — performance benchmark for the Phase A hook surface.
 *
 * Asserts the success criteria from spec.md:
 *   SC-003 — SessionStart median ≤ 300 ms (cache-hit branch)
 *   SC-004 — UserPromptSubmit median ≤ 500 ms, p95 ≤ 1500 ms
 *   SC-005 — SessionStart payload ≤ 2000 tokens p95
 *   SC-006 — UserPromptSubmit payload ≤ 800 tokens p95
 *
 * The bench uses an in-process mock for the backend search call so the
 * measurement isolates the hook code path from network. Real-cloud
 * benchmarks (T062 production-side) require an actual cloud baseline
 * and are out of scope for the test suite — the deploy checklist runs
 * those manually.
 *
 * Test runs 100 iterations of each hook, captures latency + token
 * estimates, and asserts the percentile budgets. To keep CI fast, this
 * file is opt-in via the `VALIS_RUN_BENCH=1` env var. Run locally:
 *
 *   VALIS_RUN_BENCH=1 pnpm --filter valis-cli test test/performance
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hookSessionStartCommand } from '../../src/hooks/session-start-handler.js';
import { hookUserPromptSubmitCommand } from '../../src/hooks/user-prompt-submit-handler.js';
import { write as writeCache } from '../../src/hooks/cache.js';
import { estimateTokens } from '../../src/hooks/budget.js';
import type { ProjectContextSnapshot } from '../../src/hooks/cache.js';

const SHOULD_RUN = process.env.VALIS_RUN_BENCH === '1';
const ITERATIONS = SHOULD_RUN ? 100 : 5; // smoke iterations for the always-run smoke

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';

let tempHome: string;
let projectDir: string;
let stdoutChunks: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;
let prevValisHome: string | undefined;
let prevClaudeProjectDir: string | undefined;
let prevClaudeSessionId: string | undefined;
let prevClaudeUserPrompt: string | undefined;
let prevFetch: typeof globalThis.fetch | undefined;

function snapshot(numDecisions = 14): ProjectContextSnapshot {
  return {
    org_id: ORG_ID,
    org_name: 'Krukit',
    project_id: PROJECT_ID,
    project_name: 'valis',
    fetched_at: new Date().toISOString(),
    ttl_seconds: 300,
    enforcement_mode: 'advisory',
    decision_count: numDecisions,
    violation_count: 0,
    decisions: Array.from({ length: numDecisions }, (_, i) => ({
      id: `dec-${i}`,
      summary: `Decision ${i}: ${'X'.repeat(60)}`,
      status: 'active' as const,
      type: 'decision' as const,
      affects: ['packages/cli'],
      score: 1 - i / 100,
    })),
    recent_contradictions: [],
    block_envelope: {
      purpose: 'authoritative team knowledge — outranks MEMORY.md and Qdrant for work questions',
      precedence: 'engineering, brand, communication, customer-facing copy, personal workflow, audience patterns, response patterns',
      for_session_template: '<session_id>',
    },
  };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function median(values: number[]): number {
  return percentile(values, 50);
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-bench-'));
  projectDir = await mkdtemp(join(tmpdir(), 'valis-bench-proj-'));
  prevValisHome = process.env.VALIS_HOME;
  prevClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  prevClaudeSessionId = process.env.CLAUDE_SESSION_ID;
  prevClaudeUserPrompt = process.env.CLAUDE_USER_PROMPT;
  prevFetch = globalThis.fetch;
  process.env.VALIS_HOME = tempHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  process.env.CLAUDE_SESSION_ID = 'sess-bench';

  await mkdir(tempHome, { recursive: true });
  await writeFile(
    join(tempHome, 'config.json'),
    JSON.stringify({ org_id: ORG_ID, member_api_key: 'tmm_test', api_base_url: 'http://test' }),
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
  if (prevClaudeUserPrompt === undefined) delete process.env.CLAUDE_USER_PROMPT;
  else process.env.CLAUDE_USER_PROMPT = prevClaudeUserPrompt;
  globalThis.fetch = prevFetch as typeof globalThis.fetch;
  await rm(tempHome, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('SC-003 + SC-005 — SessionStart cache-hit latency & payload size', () => {
  it(`runs ${ITERATIONS} iterations under percentile budgets`, async () => {
    await writeCache(ORG_ID, PROJECT_ID, snapshot());
    const latencies: number[] = [];
    const tokenCounts: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      stdoutChunks.length = 0;
      const t0 = performance.now();
      await hookSessionStartCommand();
      latencies.push(performance.now() - t0);
      const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
      tokenCounts.push(estimateTokens(ctx));
    }

    const med = median(latencies);
    const p95 = percentile(latencies, 95);
    const tokenP95 = percentile(tokenCounts, 95);

    // SC-003: median ≤ 300 ms (the cache-hit branch in particular should
    // be far below 100 ms — that's the realistic budget).
    expect(med, `median latency ${med.toFixed(1)} ms over budget`).toBeLessThanOrEqual(300);
    // Sanity: cache-hit p95 should also be very fast.
    expect(p95).toBeLessThanOrEqual(800);

    // SC-005: payload p95 ≤ 2000 tokens
    expect(tokenP95, `payload p95 ${tokenP95} tokens over budget`).toBeLessThanOrEqual(2000);
  });
});

describe('SC-004 + SC-006 — UserPromptSubmit latency & payload size', () => {
  it(`runs ${ITERATIONS} iterations under percentile budgets`, async () => {
    process.env.CLAUDE_USER_PROMPT = 'how do we cache decisions?';
    // Mock backend search with realistic shape; ~3 results, score 0.8+.
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { id: 'a', summary: 'Use TTL', type: 'decision', score: 0.92 },
          { id: 'b', summary: 'POSIX 0600', type: 'constraint', score: 0.81 },
          { id: 'c', summary: 'AbortController pattern', type: 'pattern', score: 0.76 },
        ],
      }),
    })) as unknown as typeof globalThis.fetch;

    const latencies: number[] = [];
    const tokenCounts: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      stdoutChunks.length = 0;
      const t0 = performance.now();
      await hookUserPromptSubmitCommand();
      latencies.push(performance.now() - t0);
      if (stdoutChunks.length > 0) {
        const ctx = JSON.parse(stdoutChunks[0]).hookSpecificOutput.additionalContext;
        tokenCounts.push(estimateTokens(ctx));
      }
    }

    const med = median(latencies);
    const p95 = percentile(latencies, 95);
    const tokenP95 = percentile(tokenCounts, 95);

    // SC-004: median ≤ 500 ms, p95 ≤ 1500 ms
    expect(med, `median ${med.toFixed(1)} ms over budget`).toBeLessThanOrEqual(500);
    expect(p95, `p95 ${p95.toFixed(1)} ms over budget`).toBeLessThanOrEqual(1500);
    // SC-006: payload p95 ≤ 800 tokens
    expect(tokenP95, `payload p95 ${tokenP95} tokens over budget`).toBeLessThanOrEqual(800);
  });
});
