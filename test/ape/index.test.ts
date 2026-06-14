/**
 * 285/RT12: `runApe` orchestrator (re-plan v2 — in-session subagent architecture).
 *
 * Contract (Re-plan v2 RT12): `runApe(opts) → exitCode`. Modes:
 *   - `baseline` — real-log eval → report (LLM-free, shipped). UNCHANGED.
 *   - `eval` / `optimize` — the standalone API path is REMOVED; these now print a
 *     pointer to the in-session orchestration (Workflow) and return 0. No report,
 *     no patch, no live-model deps.
 *
 * The orchestrator takes injectable sub-module deps so this test can drive the
 * baseline branch with mocks (no live models / disk reads).
 *
 * Named cases: baseline mode still wired (real-log + report) / eval + optimize
 * print the orchestration pointer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runApe } from '../../src/ape/index.js';
import type { ApeRunDeps } from '../../src/ape/index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ape-runape-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeDeps(over: Partial<ApeRunDeps> = {}): ApeRunDeps {
  return {
    evalRealLog: vi.fn(() => ({ sessions: 2, prompts: 6, consultRate: 0.5, injectRate: 0.3 })),
    writeApeReport: vi.fn(async () => ({
      jsonPath: join(tmp, 'run.json'),
      mdPath: join(tmp, 'run.md'),
    })),
    gitCommit: () => 'deadbeef',
    ...over,
  };
}

describe('runApe', () => {
  it('baseline mode still wired — calls real-log + report', async () => {
    const deps = makeDeps();
    const code = await runApe(
      { mode: 'baseline', projectsDir: tmp, outDir: tmp },
      deps,
    );

    expect(code).toBe(0);
    expect(deps.evalRealLog).toHaveBeenCalledTimes(1);
    expect(deps.writeApeReport).toHaveBeenCalledTimes(1);
  });

  it('eval mode prints the orchestration pointer and writes nothing', async () => {
    const deps = makeDeps();
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runApe({ mode: 'eval', corpus: 'c.jsonl', outDir: tmp }, deps);

    expect(code).toBe(0);
    expect(deps.evalRealLog).not.toHaveBeenCalled();
    expect(deps.writeApeReport).not.toHaveBeenCalled();
    const printed = log.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('orchestration');
    expect(printed).toContain('ape/orchestration/');
    // No artifacts written for the pointer path.
    expect(readdirSync(tmp)).toHaveLength(0);
    log.mockRestore();
  });

  it('optimize mode prints the orchestration pointer and writes nothing', async () => {
    const deps = makeDeps();
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runApe({ mode: 'optimize', corpus: 'c.jsonl', outDir: tmp }, deps);

    expect(code).toBe(0);
    expect(deps.writeApeReport).not.toHaveBeenCalled();
    const printed = log.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('orchestration');
    expect(printed).toContain('ape/orchestration/');
    expect(readdirSync(tmp)).toHaveLength(0);
    log.mockRestore();
  });
});
