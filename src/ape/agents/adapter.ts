/**
 * 285 APE harness — agent adapter seam.
 *
 * The harness talks to an agent-under-test through a thin adapter so the
 * eval/optimizer machinery stays agent-agnostic. Only `ClaudeCodeAdapter`
 * (see ./claude-code.ts) is implemented for the MVP.
 *
 * This module re-exports the `AgentAdapter` contract (and the types it
 * touches) from the shared type surface so adapter implementations and their
 * callers import from a single place.
 */

export type {
  AgentAdapter,
  ParsedSession,
  PatchDescriptor,
} from '../types.js';
