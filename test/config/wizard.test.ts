/**
 * 034 / T016 + T017 — unit tests for `valis config wizard`.
 *
 * Strategy: mock @inquirer/select + @inquirer/input with response queues,
 * mock fs reads/writes, and assert the wizard contract documented in
 * `contracts/cli-config-wizard.md`:
 *   - prompts every WIZARD_KEYS entry, default = current value
 *   - skips disk write when nothing changed
 *   - skips disk write when user declines confirm
 *   - re-prompts on invalid numeric input until a valid one arrives
 *   - emits `wizard_completed` telemetry only on a successful write
 *   - writes atomically with 0600
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const selectQueue: unknown[] = [];
const inputQueue: string[] = [];

vi.mock('@inquirer/select', () => ({
  default: vi.fn(async () => {
    if (selectQueue.length === 0) {
      throw new Error('select queue exhausted — test forgot to seed a response');
    }
    return selectQueue.shift();
  }),
}));

vi.mock('@inquirer/input', () => ({
  default: vi.fn(async () => {
    if (inputQueue.length === 0) {
      throw new Error('input queue exhausted — test forgot to seed a response');
    }
    return inputQueue.shift();
  }),
}));

const { writeFileMock, mkdirMock, readFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn().mockResolvedValue(undefined),
  mkdirMock: vi.fn().mockResolvedValue(undefined),
  readFileMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: writeFileMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
}));

vi.mock('../../src/hooks/telemetry.js', () => ({
  record: vi.fn(),
}));

vi.mock('../../src/config/project.js', () => ({
  findProjectConfigPath: vi.fn(),
}));

import { wizardCommand } from '../../src/config/wizard.js';
import { record as recordTelemetry } from '../../src/hooks/telemetry.js';
import { findProjectConfigPath } from '../../src/config/project.js';

/** Push current-value answers for all 10 keys in WIZARD_KEYS order. */
function seedAllDefaults(existing: Record<string, unknown> = {}) {
  // Bool key #1: capture_reminder_enabled (default true)
  selectQueue.push(existing.capture_reminder_enabled ?? true);
  // 5 int keys
  inputQueue.push(String(existing.capture_reminder_min_turn ?? 5));
  inputQueue.push(String(existing.capture_reminder_interval ?? 5));
  inputQueue.push(String(existing.capture_reminder_min_tokens ?? 4000));
  inputQueue.push(String(existing.capture_reminder_interval_tokens ?? 8000));
  inputQueue.push(String(existing.capture_reminder_min_turn_floor ?? 2));
  // Bool: per_prompt_augmentation
  selectQueue.push(existing.per_prompt_augmentation ?? true);
  // Float: per_prompt_threshold
  inputQueue.push(String(existing.per_prompt_threshold ?? 0.5));
  // Int: per_prompt_budget
  inputQueue.push(String(existing.per_prompt_budget ?? 1500));
  // Bool: telemetry
  selectQueue.push(existing.telemetry ?? true);
}

describe('wizardCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    selectQueue.length = 0;
    inputQueue.length = 0;
    vi.clearAllMocks();
    writeFileMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('no-op exits cleanly without writing or emitting telemetry when every answer matches defaults', async () => {
    // Existing file is missing → defaults apply. Re-confirming every
    // default means proposed === existing (both equal default). Wizard
    // takes the "no changes" branch.
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        capture_reminder_enabled: true,
        capture_reminder_min_turn: 5,
        capture_reminder_interval: 5,
        capture_reminder_min_tokens: 4000,
        capture_reminder_interval_tokens: 8000,
        capture_reminder_min_turn_floor: 2,
        per_prompt_augmentation: true,
        per_prompt_threshold: 0.5,
        per_prompt_budget: 1500,
        telemetry: true,
      }),
    );
    seedAllDefaults();

    const result = await wizardCommand();

    expect(result.changedKeys).toEqual([]);
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it('writes atomically with mode 0600 and emits telemetry when at least one key changed', async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({
        capture_reminder_enabled: true,
        capture_reminder_min_turn: 5,
        capture_reminder_interval: 5,
        capture_reminder_min_tokens: 4000,
        capture_reminder_interval_tokens: 8000,
        capture_reminder_min_turn_floor: 2,
        per_prompt_augmentation: true,
        per_prompt_threshold: 0.5,
        per_prompt_budget: 1500,
        telemetry: true,
      }),
    );
    // Flip telemetry off; keep everything else at default.
    seedAllDefaults({ telemetry: false });
    selectQueue.push(true); // confirm save

    const result = await wizardCommand();

    expect(result.changedKeys).toEqual(['telemetry']);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    const [path, body, opts] = writeFileMock.mock.calls[0]!;
    expect(path).toMatch(/\.valis\/config\.json$/);
    expect(JSON.parse(body as string)).toMatchObject({ telemetry: false });
    expect(opts).toMatchObject({ mode: 0o600 });
    expect(recordTelemetry).toHaveBeenCalledWith(
      'wizard_completed',
      expect.objectContaining({
        metadata: expect.objectContaining({
          changed_keys: ['telemetry'],
          scope: 'user',
        }),
      }),
    );
  });

  it('discards changes when user picks "No" at confirm', async () => {
    readFileMock.mockResolvedValueOnce(
      JSON.stringify({ capture_reminder_min_turn: 5 }),
    );
    seedAllDefaults({ capture_reminder_min_turn: 99 });
    selectQueue.push(false); // confirm = No

    const result = await wizardCommand();

    expect(result.changedKeys).toEqual([]); // contract: no-write returns empty changedKeys
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(recordTelemetry).not.toHaveBeenCalled();
  });

  it('re-prompts on non-numeric input then accepts the corrected value', async () => {
    readFileMock.mockResolvedValueOnce('{}');
    // First key is bool (capture_reminder_enabled) — answer default true.
    selectQueue.push(true);
    // capture_reminder_min_turn: bad input → re-prompt → good input.
    inputQueue.push('not a number', '7');
    // Remaining 4 ints stay at defaults.
    inputQueue.push('5', '4000', '8000', '2');
    // per_prompt_augmentation bool
    selectQueue.push(true);
    // per_prompt_threshold float, per_prompt_budget int
    inputQueue.push('0.5', '1500');
    // telemetry bool
    selectQueue.push(true);
    // confirm save
    selectQueue.push(true);

    const result = await wizardCommand();

    expect(result.changedKeys).toContain('capture_reminder_min_turn');
    const body = JSON.parse(writeFileMock.mock.calls[0]![1] as string);
    expect(body.capture_reminder_min_turn).toBe(7);
  });

  it('re-prompts when float01 input falls outside [0,1]', async () => {
    readFileMock.mockResolvedValueOnce('{}');
    selectQueue.push(true); // capture_reminder_enabled
    inputQueue.push('5', '5', '4000', '8000', '2'); // 5 int defaults
    selectQueue.push(true); // per_prompt_augmentation
    // per_prompt_threshold: 1.5 (rejected) → 0.7 (accepted)
    inputQueue.push('1.5', '0.7');
    inputQueue.push('1500'); // per_prompt_budget
    selectQueue.push(true); // telemetry
    selectQueue.push(true); // confirm

    const result = await wizardCommand();

    expect(result.changedKeys).toContain('per_prompt_threshold');
    const body = JSON.parse(writeFileMock.mock.calls[0]![1] as string);
    expect(body.per_prompt_threshold).toBe(0.7);
  });

  it('opts.configPath override directs the write to the supplied path', async () => {
    readFileMock.mockResolvedValueOnce('{}');
    seedAllDefaults({ telemetry: false });
    selectQueue.push(true);

    const result = await wizardCommand({ configPath: '/tmp/explicit.json' });

    expect(writeFileMock.mock.calls[0]![0]).toBe('/tmp/explicit.json');
    expect(result.configPath).toBe('/tmp/explicit.json');
  });

  it('project scope routes through findProjectConfigPath', async () => {
    vi.mocked(findProjectConfigPath).mockResolvedValueOnce('/repo/.valis.json');
    readFileMock.mockResolvedValueOnce('{}');
    seedAllDefaults({ telemetry: false });
    selectQueue.push(true);

    const result = await wizardCommand({ project: true });

    expect(findProjectConfigPath).toHaveBeenCalledTimes(1);
    expect(result.scope).toBe('project');
    expect(result.configPath).toBe('/repo/.valis.json');
    expect(writeFileMock.mock.calls[0]![0]).toBe('/repo/.valis.json');
  });

  it('project scope without a .valis.json raises a clear error', async () => {
    vi.mocked(findProjectConfigPath).mockResolvedValueOnce(null);

    await expect(wizardCommand({ project: true })).rejects.toThrowError(
      /No \.valis\.json found/,
    );
    expect(writeFileMock).not.toHaveBeenCalled();
  });
});
