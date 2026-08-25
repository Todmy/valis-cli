import { describe, it, expect, vi } from 'vitest';
import { getWatcherState, initWatcherState, saveState, startWatcher } from '../../src/capture/watcher.js';

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

// gh#342 — an EMFILE surfaced by chokidar used to be an unhandled 'error'
// event, which killed `valis serve` mid-MCP-handshake. A synthetic 'error'
// emit is used instead of real fd exhaustion: exhausting descriptors in CI is
// slow, flaky, and platform-dependent, while the code path under test is the
// listener, not libuv.
describe('Watcher error handling (gh#342)', () => {
  it('survives a watcher error and logs it once, actionably', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const watcher = startWatcher(() => {});

    try {
      const emfile = Object.assign(
        new Error('EMFILE: too many open files, watch'),
        { code: 'EMFILE' },
      );
      watcher.emit('error', emfile);
      watcher.emit('error', emfile);

      // Process is still alive to run this assertion — that is the regression.
      expect(spy).toHaveBeenCalledTimes(1);
      const message = spy.mock.calls[0][0] as string;
      expect(message).toContain('EMFILE');
      expect(message).toContain('VALIS_DISABLE_WATCHER');
    } finally {
      spy.mockRestore();
      await watcher.close();
    }
  });
});
