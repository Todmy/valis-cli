/**
 * PostToolUse hook handler — Phase A: own-write cache invalidation only.
 *
 * Per FR-006a + contracts/hook-protocol.md PostToolUse Branch A:
 * if the just-completed tool was a Valis write (`valis_store`,
 * `valis_lifecycle`, or any other Valis write tool — see VALIS_WRITE_PATTERN
 * below), invalidate the local context cache so the next SessionStart
 * re-fetches.
 *
 * Branch B (any other tool): empty stdout, exit 0. The capture nudge is
 * Phase B FR-041, deferred behind telemetry.
 */

import { loadHookMarker, loadHookGlobalConfig } from './context.js';
import { invalidate as invalidateCache } from './cache.js';
import { record } from './telemetry.js';

const VALIS_WRITE_PATTERN = /^valis_(store|lifecycle|sync|create_project|.*write.*)$/i;

export async function hookPostToolUseCommand(): Promise<void> {
  const toolName = process.env.CLAUDE_TOOL_NAME ?? '';
  if (!toolName || !VALIS_WRITE_PATTERN.test(toolName)) {
    return; // Branch B
  }

  const marker = await loadHookMarker();
  if (!marker) return;

  const cfg = await loadHookGlobalConfig();
  if (!cfg) return;

  await invalidateCache(cfg.orgId, marker.projectId);
  void record('cache_invalidate', {
    org_id: cfg.orgId,
    project_id: marker.projectId,
    metadata: { tool: toolName },
  });
}
