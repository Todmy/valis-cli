import { describe, it, expect } from 'vitest';
import { getWatcherState, initWatcherState, saveState } from '../../src/capture/watcher.js';

describe('Watcher', () => {
  it('initializes state', async () => {
    await initWatcherState();
    const state = getWatcherState();
    expect(state).toHaveProperty('offsets');
    expect(state).toHaveProperty('last_activity');
  });

  it('state has correct shape', () => {
    const state = getWatcherState();
    expect(typeof state.offsets).toBe('object');
    expect(typeof state.last_activity).toBe('object');
  });
});
