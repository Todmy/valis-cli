/**
 * 285/T021: `valis ape` CLI entry — argument parsing + exit-code contract.
 *
 * Contract (plan.md Task 21): parses `--mode <baseline|eval|optimize>`,
 * `--budget-usd <n>` (default 40), `--out <dir>`, `--corpus <path>`,
 * `--projects-dir <dir>`; delegates to `runApe`; exit 0 success, 2 on
 * budget-halt-with-no-improvement, 1 on bad args.
 *
 * The bin exports a pure `runCli(argv, deps)` so this test drives it with a
 * mocked `runApe` and never spawns a real process or touches the network —
 * mirroring the injectable-deps seam used by `runApe` itself (index.test.ts).
 *
 * Named cases: parses mode + budget / default budget 40 / bad mode → exit 1.
 */

import { describe, it, expect, vi } from 'vitest';

import { runCli } from '../../bin/valis-ape.js';
import type { ApeRunOpts } from '../../src/ape/index.js';

/** Build a `runApe` spy that records the opts it was called with. */
function spyApe(returnCode = 0) {
  const calls: ApeRunOpts[] = [];
  const runApe = vi.fn(async (opts: ApeRunOpts) => {
    calls.push(opts);
    return returnCode;
  });
  return { runApe, calls };
}

describe('valis-ape CLI', () => {
  it('parses mode + budget and forwards them to runApe', async () => {
    const { runApe, calls } = spyApe();
    const code = await runCli(
      [
        '--mode',
        'optimize',
        '--budget-usd',
        '12',
        '--corpus',
        'pkg/corpora/c.jsonl',
        '--out',
        '/tmp/out',
        '--projects-dir',
        '/tmp/proj',
      ],
      { runApe },
    );

    expect(code).toBe(0);
    expect(runApe).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({
      mode: 'optimize',
      budgetUsd: 12,
      corpus: 'pkg/corpora/c.jsonl',
      outDir: '/tmp/out',
      projectsDir: '/tmp/proj',
    });
  });

  it('default budget is 40 when --budget-usd omitted', async () => {
    const { runApe, calls } = spyApe();
    const code = await runCli(['--mode', 'baseline'], { runApe });

    expect(code).toBe(0);
    expect(calls[0].budgetUsd).toBe(40);
  });

  it('bad mode → exit 1, runApe not called', async () => {
    const { runApe } = spyApe();
    const code = await runCli(['--mode', 'bogus'], { runApe });

    expect(code).toBe(1);
    expect(runApe).not.toHaveBeenCalled();
  });

  it('missing mode → exit 1, runApe not called', async () => {
    const { runApe } = spyApe();
    const code = await runCli([], { runApe });

    expect(code).toBe(1);
    expect(runApe).not.toHaveBeenCalled();
  });

  it('propagates the runApe exit code (e.g. 2 on budget halt)', async () => {
    const { runApe } = spyApe(2);
    const code = await runCli(['--mode', 'optimize'], { runApe });

    expect(code).toBe(2);
  });
});
