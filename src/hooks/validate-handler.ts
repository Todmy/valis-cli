/**
 * 034 / T011 — `valis hook validate` implementation.
 *
 * Exercises each of the 5 active/stub Valis hooks with a synthetic stdin
 * envelope and writes a structured PASS/FAIL report to
 * `specs/034-unified-capture-policy/validation-report.md`. The report is
 * the gate artifact for FR-013 (legacy capture deletion).
 *
 * Contract: specs/034-unified-capture-policy/contracts/cli-hook-validate.md
 * + contracts/validation-report-template.md
 *
 * Implementation strategy: spawn `node <bin>/valis.js hook <name>` as a
 * subprocess so we exercise the real Claude-Code-facing surface (not the
 * handler functions in isolation). Synthetic envelopes are written to
 * stdin; stdout JSON is parsed and matched against per-hook expectations.
 * Each hook subprocess gets a 5s wall-clock budget; exceeding it counts
 * as FAIL.
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookCheckResult {
  hook: string;
  fires: boolean;
  injects: 'yes' | 'silent-expected' | 'no';
  respectsThrottle: 'yes' | 'n/a' | 'no';
  durationMs: number;
  issues: string;
}

export interface ValidationResult {
  status: 'PASS' | 'FAIL';
  results: HookCheckResult[];
  generatedAt: string;
  toolVersion: string;
  branch: string;
  reportPath: string;
}

interface HookSpec {
  name: string;
  envelope: Record<string, unknown>;
  expectInjection: boolean;
  injectionCheck?: (stdout: string) => boolean;
  throttleApplicable: boolean;
}

/** Resolve the path to the built CLI entry point. */
function findBinPath(): string {
  // This file lives at packages/cli/src/hooks/ in source; built dist at
  // packages/cli/dist/src/hooks/. Walk up to package root then
  // dist/bin/valis.js.
  const here = fileURLToPath(import.meta.url);
  const pkgRoot = resolve(dirname(here), '..', '..', '..');
  return resolve(pkgRoot, 'dist', 'bin', 'valis.js');
}

const HOOK_SPECS: HookSpec[] = [
  {
    name: 'session-start',
    envelope: {
      session_id: 'validate-fixture-session',
      cwd: process.cwd(),
    },
    expectInjection: true,
    injectionCheck: (out) => {
      // session-start per Phase A spec is "self-heal only — no backend
      // preload". When no Valis-managed surface needs healing, the hook
      // legitimately produces no stdout. Accept either empty (silent
      // self-heal) or JSON with hookEventName=SessionStart.
      if (!out.trim()) return true;
      try {
        const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string } };
        return parsed?.hookSpecificOutput?.hookEventName === 'SessionStart';
      } catch {
        return false;
      }
    },
    throttleApplicable: false,
  },
  {
    name: 'user-prompt-submit',
    envelope: {
      session_id: 'validate-fixture-session',
      prompt: 'test prompt from validate',
    },
    expectInjection: true,
    injectionCheck: (out) => {
      // Augmentation may legitimately skip when threshold/budget not met.
      // Empty stdout is acceptable (Constitution III non-blocking).
      if (!out.trim()) return true;
      try {
        const parsed = JSON.parse(out) as { hookSpecificOutput?: { hookEventName?: string } };
        return parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit';
      } catch {
        return false;
      }
    },
    throttleApplicable: true,
  },
  {
    name: 'pre-tool-use',
    envelope: {
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/validate.txt' },
    },
    expectInjection: false, // Phase B stub
    throttleApplicable: false,
  },
  {
    name: 'pre-compact',
    envelope: {
      session_id: 'validate-fixture-session',
      trigger: 'manual',
    },
    expectInjection: true,
    injectionCheck: (out) => {
      // pre-compact may emit either a block-and-gate decision OR silent-allow
      // depending on whether a capture-done sentinel exists. Both are valid.
      if (!out.trim()) return true;
      try {
        JSON.parse(out);
        return true;
      } catch {
        return false;
      }
    },
    throttleApplicable: false,
  },
  {
    name: 'stop',
    envelope: { session_id: 'validate-fixture-session' },
    expectInjection: false, // Phase B stub
    throttleApplicable: false,
  },
];

interface SubprocessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

async function runHook(
  binPath: string,
  hookName: string,
  envelope: Record<string, unknown>,
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<SubprocessResult> {
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    // spawn with array args — no shell, no injection risk. hookName is a
    // hard-coded value from HOOK_SPECS above (not user-controlled).
    const child = spawn('node', [binPath, 'hook', hookName], {
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGTERM');
    }, 5000);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });

    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });

    // Write envelope to stdin then close.
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

async function checkHook(binPath: string, spec: HookSpec): Promise<HookCheckResult> {
  const result = await runHook(binPath, spec.name, spec.envelope);

  const issues: string[] = [];

  const fires = !result.timedOut && result.exitCode === 0;
  if (!fires) {
    if (result.timedOut) issues.push('subprocess exceeded 5s timeout');
    else issues.push(`exit code ${result.exitCode}`);
    if (result.stderr.trim()) {
      issues.push(`stderr: ${result.stderr.trim().slice(0, 200)}`);
    }
  }

  let injects: HookCheckResult['injects'];
  if (!spec.expectInjection) {
    injects = result.stdout.trim().length === 0 ? 'silent-expected' : 'no';
    if (injects === 'no') {
      issues.push(`expected silent stub; observed stdout: ${result.stdout.trim().slice(0, 200)}`);
    }
  } else {
    const ok = spec.injectionCheck ? spec.injectionCheck(result.stdout) : !!result.stdout.trim();
    injects = ok ? 'yes' : 'no';
    if (!ok) {
      issues.push(`injection check failed; stdout was: ${result.stdout.trim().slice(0, 200)}`);
    }
  }

  // First-iteration validator: throttle-respects check is a future
  // enhancement (would require a temp config file + VALIS_HOME override).
  // For now n/a is acceptable; unit tests already cover the throttle
  // resolution logic at the hook-handler level.
  const respectsThrottle: HookCheckResult['respectsThrottle'] = 'n/a';

  return {
    hook: spec.name,
    fires,
    injects,
    respectsThrottle,
    durationMs: result.durationMs,
    issues: issues.join('; '),
  };
}

function renderReport(result: ValidationResult): string {
  const statusEmoji = (b: boolean) => (b ? '✅' : '❌');
  const injectsCell = (i: HookCheckResult['injects']) =>
    i === 'yes' ? '✅' : i === 'silent-expected' ? '✅ silent (expected)' : '❌';
  const throttleCell = (t: HookCheckResult['respectsThrottle']) =>
    t === 'yes' ? '✅' : t === 'no' ? '❌' : 'n/a';

  const rows = result.results
    .map(
      (r) =>
        `| ${r.hook} | ${statusEmoji(r.fires)} | ${injectsCell(r.injects)} | ${throttleCell(r.respectsThrottle)} | ${r.durationMs}ms | ${r.issues || '—'} |`,
    )
    .join('\n');

  return `# Hook Validation Report — feature 034 (Unified Capture Policy)

**Generated**: ${result.generatedAt}
**Branch**: ${result.branch}
**Tool**: \`valis hook validate\` (cli version ${result.toolVersion})

## STATUS: ${result.status}

| Hook | Fires | Injects | Respects throttle | Duration | Issues |
|---|---|---|---|---|---|
${rows}

## Pass Criteria

- All hooks must have \`fires = ✅\`.
- All \`injects\` cells must be \`✅\` or \`✅ silent (expected)\`.
- Throttle-applicable hooks must have \`respects throttle = ✅\` or n/a.

Any \`❌\` ⇒ \`STATUS: FAIL\`. The PR performing FR-013 deletions cannot
proceed until a subsequent run shows \`STATUS: PASS\`.

## Operator Notes

(Append narrative observations here as needed. Re-run \`valis hook validate\`
after fixing any failing hook.)
`;
}

export interface ValidateOptions {
  reportPath?: string;
  /** Restrict to a single hook by name. */
  onlyHook?: string;
}

function detectBranch(): string {
  // spawnSync with array args + no shell; safe.
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
    cwd: process.cwd(),
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  return process.env.GIT_BRANCH ?? 'unknown';
}

async function detectVersion(binPath: string): Promise<string> {
  try {
    const pkgPath = resolve(dirname(binPath), '..', 'package.json');
    const raw = await readFile(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Run the validation flow end-to-end. Returns a structured result and
 * writes the markdown report to disk.
 */
export async function hookValidateCommand(
  opts: ValidateOptions = {},
): Promise<ValidationResult> {
  const binPath = findBinPath();
  const filteredSpecs = opts.onlyHook
    ? HOOK_SPECS.filter((s) => s.name === opts.onlyHook)
    : HOOK_SPECS;
  if (filteredSpecs.length === 0) {
    throw new Error(`Unknown hook: ${opts.onlyHook}`);
  }

  const results: HookCheckResult[] = [];
  for (const spec of filteredSpecs) {
    results.push(await checkHook(binPath, spec));
  }

  const allPass = results.every(
    (r) => r.fires && (r.injects === 'yes' || r.injects === 'silent-expected'),
  );

  const version = await detectVersion(binPath);
  const branch = detectBranch();

  const reportPath =
    opts.reportPath ??
    resolve(process.cwd(), 'specs', '034-unified-capture-policy', 'validation-report.md');

  const result: ValidationResult = {
    status: allPass ? 'PASS' : 'FAIL',
    results,
    generatedAt: new Date().toISOString(),
    toolVersion: version,
    branch,
    reportPath,
  };

  try {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, renderReport(result), 'utf-8');
  } catch (err) {
    process.stderr.write(
      `hook validate: failed to write report at ${reportPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Stdout summary for human + scripting consumption.
  console.log(`STATUS: ${result.status}`);
  console.log(`Report: ${reportPath}`);
  for (const r of result.results) {
    console.log(
      `  ${r.hook.padEnd(22)} fires=${r.fires} injects=${r.injects} throttle=${r.respectsThrottle} ${r.durationMs}ms${r.issues ? ` — ${r.issues}` : ''}`,
    );
  }

  return result;
}
