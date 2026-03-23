import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue(null),
}));

import { startupSweep } from '../../src/capture/startup-sweep.js';

describe('Startup Sweep', () => {
  it('returns zero counts when not configured', async () => {
    const result = await startupSweep();
    expect(result.processed).toBe(0);
    expect(result.queued_flushed).toBe(0);
    expect(result.errors).toBe(0);
  });
});
