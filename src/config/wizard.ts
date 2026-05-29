/**
 * 034 / FR-002 + FR-003: `valis config wizard` — interactive prompt-driven
 * configuration for capture-related settings. Aliases ~/.valis/config.json
 * keys to human-readable prompts; validates input per FR-003's table; writes
 * atomically with summary of changed keys.
 *
 * Contract: specs/034-unified-capture-policy/contracts/cli-config-wizard.md
 *
 * Constraint: no new npm deps. Uses `@inquirer/select` + `@inquirer/input`
 * which are already in package.json.
 */

import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { findProjectConfigPath } from '../config/project.js';
import { record as recordTelemetry } from '../hooks/telemetry.js';

const USER_CONFIG_PATH = resolve(homedir(), '.valis', 'config.json');

interface WizardKey {
  key: string;
  description: string;
  kind: 'bool' | 'int' | 'float01';
  default: boolean | number;
  min?: number;
  max?: number;
}

// FR-003: minimum coverage set. Order matters — surfaces the most-asked
// toggle (enabled) first, then sequencing knobs, then orthogonal toggles.
const WIZARD_KEYS: WizardKey[] = [
  {
    key: 'capture_reminder_enabled',
    description: 'Inject capture-reminder block into UserPromptSubmit hook',
    kind: 'bool',
    default: true,
  },
  {
    key: 'capture_reminder_min_turn',
    description: 'Minimum turn number before first reminder fires',
    kind: 'int',
    default: 5,
    min: 0,
  },
  {
    key: 'capture_reminder_interval',
    description: 'Interval between reminders, in turns',
    kind: 'int',
    default: 5,
    min: 1,
  },
  {
    key: 'capture_reminder_min_tokens',
    description: 'Minimum cumulative tokens before reminder fires',
    kind: 'int',
    default: 4000,
    min: 0,
  },
  {
    key: 'capture_reminder_interval_tokens',
    description: 'Token-based interval between reminders',
    kind: 'int',
    default: 8000,
    min: 1,
  },
  {
    key: 'capture_reminder_min_turn_floor',
    description: 'Hard lower bound on minimum turn',
    kind: 'int',
    default: 2,
    min: 0,
  },
  {
    key: 'per_prompt_augmentation',
    description: 'Auto-augment each user prompt with relevant decisions',
    kind: 'bool',
    default: true,
  },
  {
    key: 'per_prompt_threshold',
    description: 'Relevance threshold (0..1) for per-prompt augmentation hits',
    kind: 'float01',
    default: 0.5,
    min: 0,
    max: 1,
  },
  {
    key: 'per_prompt_budget',
    description: 'Token budget per turn for augmentation block',
    kind: 'int',
    default: 1500,
    min: 0,
  },
  {
    key: 'telemetry',
    description: 'Record local telemetry events (consent state)',
    kind: 'bool',
    default: true,
  },
];

async function readJsonFile(path: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeJsonFile(path: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

async function promptForBool(spec: WizardKey, current: boolean): Promise<boolean> {
  return select<boolean>({
    message: `${spec.key}  ${pc.dim('— ' + spec.description)}`,
    default: current,
    choices: [
      { name: `Yes  ${pc.dim(current === true ? '(current)' : '')}`.trim(), value: true },
      { name: `No   ${pc.dim(current === false ? '(current)' : '')}`.trim(), value: false },
    ],
  });
}

async function promptForNumber(spec: WizardKey, current: number): Promise<number> {
  for (;;) {
    const raw = await input({
      message: `${spec.key}  ${pc.dim('— ' + spec.description)}`,
      default: String(current),
    });
    const n = spec.kind === 'float01' ? Number(raw) : parseInt(raw, 10);
    if (!Number.isFinite(n)) {
      console.error(pc.red('  Not a number. Try again.'));
      continue;
    }
    if (spec.min !== undefined && n < spec.min) {
      console.error(pc.red(`  Must be ≥ ${spec.min}. Try again.`));
      continue;
    }
    if (spec.max !== undefined && n > spec.max) {
      console.error(pc.red(`  Must be ≤ ${spec.max}. Try again.`));
      continue;
    }
    return n;
  }
}

export interface WizardOptions {
  /** Write to `.valis.json` (project scope) instead of `~/.valis/config.json`. */
  project?: boolean;
  /** Override config file path (mostly for tests). */
  configPath?: string;
}

export interface WizardResult {
  scope: 'user' | 'project';
  configPath: string;
  changedKeys: string[];
}

async function resolveTargetPath(opts: WizardOptions): Promise<{ scope: 'user' | 'project'; path: string }> {
  if (opts.configPath) {
    return { scope: opts.project ? 'project' : 'user', path: opts.configPath };
  }
  if (opts.project) {
    const path = await findProjectConfigPath(process.cwd());
    if (!path) {
      throw new Error('No .valis.json found in cwd or ancestors. Run `valis init` first.');
    }
    return { scope: 'project', path };
  }
  return { scope: 'user', path: USER_CONFIG_PATH };
}

/**
 * Run the interactive wizard.
 *
 * Flow per contracts/cli-config-wizard.md:
 *   1. Print context header (target scope + path)
 *   2. Prompt for each WIZARD_KEYS entry with current value pre-filled
 *   3. Print diff summary
 *   4. Confirm save (Yes/No)
 *   5. Atomic write with 0600
 *   6. Emit `wizard_completed` telemetry on success
 */
export async function wizardCommand(opts: WizardOptions = {}): Promise<WizardResult> {
  const { scope, path } = await resolveTargetPath(opts);
  const existing = await readJsonFile(path);

  console.log(pc.bold(`\nValis config wizard`));
  console.log(pc.dim(`  scope: ${scope}`));
  console.log(pc.dim(`  file:  ${path}`));
  console.log('');

  const proposed: Record<string, unknown> = { ...existing };
  for (const spec of WIZARD_KEYS) {
    const current = (existing[spec.key] as boolean | number | undefined) ?? spec.default;
    let next: boolean | number;
    if (spec.kind === 'bool') {
      next = await promptForBool(spec, current as boolean);
    } else {
      next = await promptForNumber(spec, current as number);
    }
    proposed[spec.key] = next;
  }

  // Compute diff against the on-disk values (not against defaults). A key
  // counts as "changed" only when its persisted value moves.
  const changedKeys: string[] = [];
  for (const spec of WIZARD_KEYS) {
    if (existing[spec.key] !== proposed[spec.key]) {
      changedKeys.push(spec.key);
    }
  }

  console.log('');
  if (changedKeys.length === 0) {
    console.log(pc.dim('No changes. Exiting without write.'));
    return { scope, configPath: path, changedKeys: [] };
  }

  console.log(pc.bold('Changes:'));
  for (const key of changedKeys) {
    console.log(`  ${pc.cyan(key)}: ${pc.dim(String(existing[key] ?? '<default>'))} → ${pc.green(String(proposed[key]))}`);
  }

  const confirm = await select<boolean>({
    message: 'Save these changes?',
    choices: [
      { name: 'Yes — write to disk', value: true },
      { name: 'No — discard', value: false },
    ],
  });

  if (!confirm) {
    console.log(pc.yellow('Aborted. No changes written.'));
    return { scope, configPath: path, changedKeys: [] };
  }

  await writeJsonFile(path, proposed);
  console.log(pc.green(`✓ Wrote ${changedKeys.length} change${changedKeys.length === 1 ? '' : 's'} to ${path}`));

  void recordTelemetry('wizard_completed', {
    metadata: { changed_keys: changedKeys, scope },
  });

  return { scope, configPath: path, changedKeys };
}
