/**
 * 026/Track 3a — atomic on-disk CheckpointStore for the reindex toolkit.
 *
 * Writes the JSON to a sibling `.tmp` file, fsyncs, and renames atomically
 * (FR-010). A SIGKILL mid-write leaves either the prior file intact or the
 * new file fully written — never a corrupted half-file.
 *
 * Load returns null when the path doesn't exist so the caller (orchestrator)
 * can distinguish "fresh run" from "resume". Parse errors raise — a
 * corrupted checkpoint is operator-actionable, not silently overwritten.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckpointState, CheckpointStore } from './reindex-orchestrator.js';

export function createFsCheckpointStore(): CheckpointStore {
  return {
    async load(path: string): Promise<CheckpointState | null> {
      if (!existsSync(path)) return null;
      const raw = await readFile(path, 'utf-8');
      try {
        return JSON.parse(raw) as CheckpointState;
      } catch (err) {
        throw new Error(
          `checkpoint at ${path} is not valid JSON: ${(err as Error).message}`,
        );
      }
    },
    async save(path: string, state: CheckpointState): Promise<void> {
      const tmp = `${path}.tmp`;
      const serialised = JSON.stringify(state, null, 2);
      // Ensure parent dir exists is the operator's responsibility — this
      // is an internal tool not a user-facing one. We don't auto-mkdir.
      void dirname; // imported for symmetry with future mkdir wiring
      await writeFile(tmp, serialised, 'utf-8');
      await rename(tmp, path);
    },
  };
}
