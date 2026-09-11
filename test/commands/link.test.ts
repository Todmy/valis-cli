/**
 * gh#322 — `valis link` / `valis unlink`.
 *
 * The user surface is names, never UUIDs: a linked project is something you
 * name in the terminal the same way you name it anywhere else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockLoadConfig = vi.fn();
const mockListMemberProjects = vi.fn();

vi.mock('../../src/config/store.js', () => ({
  loadConfig: (...a: unknown[]) => mockLoadConfig(...a),
}));

vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseForConfig: vi.fn().mockReturnValue({}),
  listMemberProjects: (...a: unknown[]) => mockListMemberProjects(...a),
}));

import { linkCommand, unlinkCommand } from '../../src/commands/link.js';

const ACTIVE = 'a1b2c3d4-e5f6-4890-abcd-ef1234567890';
const OTHER = 'b2c3d4e5-f6a7-4901-bcde-f12345678901';
const THIRD = 'c3d4e5f6-a7b8-4012-cdef-123456789012';

let tmpDir: string;
let exitCode: number | undefined;
let out: string[];
let err: string[];

async function writeMarker(linked?: string[]): Promise<void> {
  await writeFile(
    join(tmpDir, '.valis.json'),
    JSON.stringify({
      project_id: ACTIVE,
      project_name: 'frontend-app',
      ...(linked ? { linked_projects: linked } : {}),
      per_prompt_augmentation: { enabled: true },
    }),
    'utf-8',
  );
}

async function readMarker(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(tmpDir, '.valis.json'), 'utf-8'));
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await mkdtemp(join(tmpdir(), 'valis-link-test-'));
  exitCode = undefined;
  out = [];
  err = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error('__exit__');
  }) as never);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  mockLoadConfig.mockResolvedValue({
    member_id: 'member-1',
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
  });
  mockListMemberProjects.mockResolvedValue([
    { id: ACTIVE, name: 'frontend-app', role: 'project_member', decision_count: 1 },
    { id: OTHER, name: 'backend-api', role: 'project_member', decision_count: 2 },
    { id: THIRD, name: 'Backend-API', role: 'project_member', decision_count: 0 },
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Run a command that may call process.exit, swallowing the sentinel throw. */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if ((e as Error).message !== '__exit__') throw e;
  }
}

describe('valis link', () => {
  it('resolves a name to an id and writes it', async () => {
    await writeMarker();
    mockListMemberProjects.mockResolvedValue([
      { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
      { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
    ]);
    await run(() => linkCommand('backend-api', { cwd: tmpDir }));
    const marker = await readMarker();
    expect(marker.linked_projects).toEqual([OTHER]);
    // Unrelated keys survive the rewrite.
    expect(marker.per_prompt_augmentation).toEqual({ enabled: true });
  });

  it('is a no-op when the project is already linked', async () => {
    await writeMarker([OTHER]);
    mockListMemberProjects.mockResolvedValue([
      { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
      { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
    ]);
    await run(() => linkCommand('backend-api', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toEqual([OTHER]);
    expect(exitCode).toBeUndefined();
  });

  it('refuses to link the active project', async () => {
    await writeMarker();
    await run(() => linkCommand('frontend-app', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  it('exits 1 and writes nothing for an unknown name', async () => {
    await writeMarker();
    await run(() => linkCommand('no-such-project', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('backend-api');
  });

  it('exits 1 and lists the matches for an ambiguous name', async () => {
    await writeMarker();
    await run(() => linkCommand('backend-api', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(err.join('\n')).toContain('Backend-API');
  });

  it('lists the current entries by name when called bare', async () => {
    await writeMarker([OTHER]);
    await run(() => linkCommand(undefined, { cwd: tmpDir }));
    expect(out.join('\n')).toContain('backend-api');
  });

  it('marks an inaccessible linked id rather than hiding it', async () => {
    await writeMarker(['deadbeef-0000-4000-8000-000000000000']);
    await run(() => linkCommand(undefined, { cwd: tmpDir }));
    expect(out.join('\n')).toContain('no longer accessible');
  });

  it('refuses a link past the 20-entry cap', async () => {
    const full = Array.from({ length: 20 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await writeMarker(full);
    mockListMemberProjects.mockResolvedValue([
      { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
      { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
    ]);
    await run(() => linkCommand('backend-api', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toEqual(full);
    expect(exitCode).toBe(1);
  });
});

describe('valis unlink', () => {
  it('removes the entry', async () => {
    await writeMarker([OTHER]);
    mockListMemberProjects.mockResolvedValue([
      { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
      { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
    ]);
    await run(() => unlinkCommand('backend-api', { cwd: tmpDir }));
    expect((await readMarker()).linked_projects).toEqual([]);
  });

  it('exits 1 without writing for an entry that is not linked', async () => {
    await writeMarker([]);
    mockListMemberProjects.mockResolvedValue([
      { id: ACTIVE, name: 'frontend-app', role: 'm', decision_count: 1 },
      { id: OTHER, name: 'backend-api', role: 'm', decision_count: 2 },
    ]);
    await run(() => unlinkCommand('backend-api', { cwd: tmpDir }));
    expect(exitCode).toBe(1);
  });
});
