import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installReportedPath, telemetryLogPath } from '../../src/hooks/paths.js';
import type { AdoptionEvent, EmitResult } from '../../src/lib/adoption-emit.js';

// Capture every batch handed to emitAdoptionEvents so we can assert that the
// one-time `install` event is (or isn't) prepended.
const emitCalls: { projectId: string; events: AdoptionEvent[] }[] = [];

vi.mock('../../src/lib/adoption-emit.js', () => ({
  emitAdoptionEvents: vi.fn(
    async (projectId: string, events: AdoptionEvent[]): Promise<EmitResult> => {
      emitCalls.push({ projectId, events });
      return { ok: true, status: 200 };
    },
  ),
}));

let tempHome: string;
let prevValisHome: string | undefined;

async function seedTransmittableEvent(projectId: string): Promise<void> {
  // One transmittable, project-scoped event so the flush has something to send.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event: 'prompt_search_served',
    project_id: projectId,
  });
  const path = telemetryLogPath();
  await mkdir(join(tempHome), { recursive: true });
  await writeFile(path, `${line}\n`, 'utf-8');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  emitCalls.length = 0;
  vi.clearAllMocks();
  tempHome = await mkdtemp(join(tmpdir(), 'valis-install-emit-test-'));
  prevValisHome = process.env.VALIS_HOME;
  process.env.VALIS_HOME = tempHome;
});

afterEach(async () => {
  if (prevValisHome === undefined) delete process.env.VALIS_HOME;
  else process.env.VALIS_HOME = prevValisHome;
  await rm(tempHome, { recursive: true, force: true });
});

describe('hooks/flush-telemetry — one-time install funnel event (T3.1)', () => {
  it('first authenticated flush includes install when marker absent, and creates the marker', async () => {
    await seedTransmittableEvent('proj-1');
    const { hookFlushTelemetryCommand } = await import(
      '../../src/hooks/flush-telemetry-handler.js'
    );

    await hookFlushTelemetryCommand();

    expect(emitCalls.length).toBeGreaterThanOrEqual(1);
    const firstBatch = emitCalls[0].events;
    expect(firstBatch[0]).toMatchObject({ event_type: 'install', count: 1 });
    // exactly one install across all batches
    const installCount = emitCalls
      .flatMap((c) => c.events)
      .filter((e) => e.event_type === 'install').length;
    expect(installCount).toBe(1);
    // marker now present
    expect(await exists(installReportedPath())).toBe(true);
  });

  it('subsequent flush omits install when marker present', async () => {
    // Pre-create the marker.
    await mkdir(tempHome, { recursive: true });
    await writeFile(installReportedPath(), '', 'utf-8');
    await seedTransmittableEvent('proj-1');

    const { hookFlushTelemetryCommand } = await import(
      '../../src/hooks/flush-telemetry-handler.js'
    );
    await hookFlushTelemetryCommand();

    const installCount = emitCalls
      .flatMap((c) => c.events)
      .filter((e) => e.event_type === 'install').length;
    expect(installCount).toBe(0);
  });

  it('no install when there is no auth/project (flush sends nothing)', async () => {
    // No telemetry log at all → no flush → nothing emitted, no marker.
    const { hookFlushTelemetryCommand } = await import(
      '../../src/hooks/flush-telemetry-handler.js'
    );
    await hookFlushTelemetryCommand();

    expect(emitCalls.length).toBe(0);
    expect(await exists(installReportedPath())).toBe(false);
  });
});
