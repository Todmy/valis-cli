import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 034-unified-capture-policy / FR-018: regression that the new telemetry
 * event variants (capture_succeeded, recall_hit, wizard_completed,
 * personal_drafts_triaged, personal_drafts_restored) round-trip cleanly
 * through the existing JSONL append pipeline.
 *
 * We point telemetryLogPath() at a temp file so the test does not touch
 * the maintainer's real ~/.valis/telemetry.jsonl.
 */

let tempDir: string;
let tempLog: string;

vi.mock('../../src/hooks/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hooks/paths.js')>();
  return {
    ...actual,
    telemetryLogPath: () => tempLog,
  };
});

import { record } from '../../src/hooks/telemetry.js';

describe('telemetry — 034 new event variants', () => {
  beforeEach(async () => {
    tempDir = await mkdir(join(tmpdir(), `valis-telemetry-test-${Date.now()}-${Math.random()}`), {
      recursive: true,
    }) as unknown as string;
    // mkdir returns undefined on success in some Node versions; recompute the path.
    tempDir = join(tmpdir(), `valis-telemetry-test-${Date.now()}-${Math.random()}`);
    await mkdir(tempDir, { recursive: true });
    tempLog = join(tempDir, 'telemetry.jsonl');
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('records capture_succeeded with full payload', async () => {
    await record('capture_succeeded', {
      org_id: 'org-1',
      project_id: 'project-personal-drafts-uuid',
      metadata: {
        path: 'valis',
        type: 'decision',
        inferred_type: true,
        inferred_project_scope: 'personal-drafts',
      },
    });

    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.event).toBe('capture_succeeded');
    expect(line.project_id).toBe('project-personal-drafts-uuid');
    expect(line.metadata.path).toBe('valis');
    expect(line.metadata.type).toBe('decision');
    expect(line.metadata.inferred_type).toBe(true);
    expect(line.metadata.inferred_project_scope).toBe('personal-drafts');
  });

  it('records capture_succeeded with qdrant_legacy path for baseline measurement', async () => {
    await record('capture_succeeded', {
      project_id: 'p1',
      metadata: { path: 'qdrant_legacy', type: 'lesson' },
    });
    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.metadata.path).toBe('qdrant_legacy');
  });

  it('records recall_hit per result', async () => {
    await record('recall_hit', {
      project_id: 'p1',
      metadata: {
        decision_id: 'd1',
        score: 0.87,
        source_tool: 'valis_search',
      },
    });
    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.event).toBe('recall_hit');
    expect(line.metadata.decision_id).toBe('d1');
    expect(line.metadata.score).toBe(0.87);
    expect(line.metadata.source_tool).toBe('valis_search');
  });

  it('records wizard_completed with changed keys list', async () => {
    await record('wizard_completed', {
      metadata: {
        changed_keys: ['capture_reminder_enabled', 'capture_reminder_interval'],
        scope: 'user',
      },
    });
    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.event).toBe('wizard_completed');
    expect(line.metadata.changed_keys).toEqual([
      'capture_reminder_enabled',
      'capture_reminder_interval',
    ]);
    expect(line.metadata.scope).toBe('user');
  });

  it('records personal_drafts_triaged with action counts', async () => {
    await record('personal_drafts_triaged', {
      project_id: 'p-drafts',
      metadata: { bound: 3, archived: 1, deleted: 0, skipped: 2 },
    });
    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.event).toBe('personal_drafts_triaged');
    expect(line.metadata.bound).toBe(3);
    expect(line.metadata.archived).toBe(1);
  });

  it('records personal_drafts_restored', async () => {
    await record('personal_drafts_restored', {
      project_id: 'p-drafts',
      metadata: { decision_id: 'd-restored' },
    });
    const raw = await readFile(tempLog, 'utf-8');
    const line = JSON.parse(raw.trim());
    expect(line.event).toBe('personal_drafts_restored');
    expect(line.metadata.decision_id).toBe('d-restored');
  });

  it('appends multiple events as separate JSONL lines', async () => {
    await record('capture_succeeded', { metadata: { path: 'valis', type: 'lesson' } });
    await record('recall_hit', { metadata: { decision_id: 'd2', score: 0.5, source_tool: 'valis_context' } });
    const raw = await readFile(tempLog, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('capture_succeeded');
    expect(JSON.parse(lines[1]).event).toBe('recall_hit');
  });
});
