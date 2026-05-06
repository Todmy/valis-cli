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

import { readFile } from 'node:fs/promises';
import { resolveProjectMarker } from './project-resolver.js';
import { invalidate as invalidateCache } from './cache.js';
import { record } from './telemetry.js';
import { configPath } from './paths.js';

const VALIS_WRITE_PATTERN = /^valis_(store|lifecycle|sync|create_project|.*write.*)$/i;

interface GlobalConfig {
  org_id?: string;
}

async function loadOrgId(): Promise<string | null> {
  try {
    const data = await readFile(configPath(), 'utf-8');
    const parsed = JSON.parse(data) as GlobalConfig;
    return parsed.org_id ?? null;
  } catch {
    return null;
  }
}

export async function hookPostToolUseCommand(): Promise<void> {
  const toolName = process.env.CLAUDE_TOOL_NAME ?? '';
  if (!toolName || !VALIS_WRITE_PATTERN.test(toolName)) {
    return; // Branch B
  }

  const marker = await resolveProjectMarker();
  if (!marker || !marker.projectId) return;

  const orgId = await loadOrgId();
  if (!orgId) return;

  await invalidateCache(orgId, marker.projectId);
  void record('cache_invalidate', {
    org_id: orgId,
    project_id: marker.projectId,
    metadata: { tool: toolName },
  });
}
