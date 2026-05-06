import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  read,
  write,
  invalidate,
  isFresh,
  ageSeconds,
  type ProjectContextSnapshot,
} from '../../src/hooks/cache.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';
const PROJECT_X = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeSnapshot(overrides: Partial<ProjectContextSnapshot> = {}): ProjectContextSnapshot {
  return {
    org_id: ORG_A,
    org_name: 'Krukit',
    project_id: PROJECT_X,
    project_name: 'valis',
    fetched_at: new Date().toISOString(),
    ttl_seconds: 300,
    enforcement_mode: 'advisory',
    decision_count: 1,
    violation_count: 0,
    decisions: [],
    recent_contradictions: [],
    block_envelope: {
      purpose: 'p',
      precedence: 'a, b',
      for_session_template: '<session_id>',
    },
    ...overrides,
  };
}

let tempHome: string;
let prevValisHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'valis-cache-test-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('hooks/cache', () => {
  it('returns null on miss', async () => {
    const result = await read(ORG_A, PROJECT_X);
    expect(result).toBeNull();
  });

  it('round-trips a snapshot via write → read', async () => {
    const snap = makeSnapshot();
    await write(ORG_A, PROJECT_X, snap);
    const got = await read(ORG_A, PROJECT_X);
    expect(got).not.toBeNull();
    expect(got!.project_id).toBe(snap.project_id);
    expect(got!.block_envelope.purpose).toBe('p');
  });

  it('writes file with mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const snap = makeSnapshot();
    await write(ORG_A, PROJECT_X, snap);
    const file = join(tempHome, 'cache', ORG_A, `${PROJECT_X}.json`);
    const s = await stat(file);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('separates entries by (org_id, project_id)', async () => {
    const a = makeSnapshot({ org_id: ORG_A, project_name: 'A' });
    const b = makeSnapshot({ org_id: ORG_B, project_name: 'B' });
    await write(ORG_A, PROJECT_X, a);
    await write(ORG_B, PROJECT_X, b);
    expect((await read(ORG_A, PROJECT_X))!.project_name).toBe('A');
    expect((await read(ORG_B, PROJECT_X))!.project_name).toBe('B');
  });

  it('invalidate is idempotent', async () => {
    const snap = makeSnapshot();
    await write(ORG_A, PROJECT_X, snap);
    await invalidate(ORG_A, PROJECT_X);
    expect(await read(ORG_A, PROJECT_X)).toBeNull();
    await invalidate(ORG_A, PROJECT_X);
    expect(await read(ORG_A, PROJECT_X)).toBeNull();
  });

  it('isFresh returns true within TTL and false beyond', () => {
    const fresh = makeSnapshot({ fetched_at: new Date().toISOString() });
    const stale = makeSnapshot({
      fetched_at: new Date(Date.now() - 600_000).toISOString(),
    });
    expect(isFresh(fresh, 300)).toBe(true);
    expect(isFresh(stale, 300)).toBe(false);
  });

  it('ageSeconds reports positive integer for past fetches', () => {
    const snap = makeSnapshot({
      fetched_at: new Date(Date.now() - 10_000).toISOString(),
    });
    const age = ageSeconds(snap);
    expect(age).toBeGreaterThanOrEqual(9);
    expect(age).toBeLessThanOrEqual(11);
  });

  it('written file content is parseable JSON (no partial writes)', async () => {
    const snap = makeSnapshot({ project_name: 'concurrency-target' });
    await write(ORG_A, PROJECT_X, snap);
    const raw = await readFile(
      join(tempHome, 'cache', ORG_A, `${PROJECT_X}.json`),
      'utf-8',
    );
    const parsed = JSON.parse(raw);
    expect(parsed.project_name).toBe('concurrency-target');
  });
});
