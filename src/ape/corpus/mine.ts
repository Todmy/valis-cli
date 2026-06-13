/**
 * 285 APE harness — JSONL prompt miner (Task 6).
 *
 * Walks off-the-shelf Claude Code session logs (`<project>/<session>.jsonl`
 * under `projectsDir`, const II: parse on disk, no IDE-stream interception) and
 * extracts genuine user-role prompts to seed the gold-set corpus.
 *
 * Reuses `ClaudeCodeAdapter.parseLog` (Task 3) to separate a real prompt from
 * an injected `<valis_search_results>` block and from tool-result echoes:
 *   - injected blocks → `prompt.injected === true`  (dropped)
 *   - tool-result echoes → empty text after `userContentToString` (dropped)
 *
 * Identical prompts are deduped (first occurrence wins, order preserved) and
 * the result is capped at `limit`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../agents/claude-code.js';

export interface MinePromptsOpts {
  projectsDir: string;
  limit: number;
}

export interface MinedPrompt {
  text: string;
  sessionId: string;
}

/** Enumerate `<project>/<session>.jsonl` files one directory deep. */
function listSessionLogs(projectsDir: string): string[] {
  const files: string[] = [];
  for (const project of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(projectsDir, project.name);
    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(join(projectPath, entry.name));
      }
    }
  }
  return files.sort();
}

export function minePrompts({ projectsDir, limit }: MinePromptsOpts): MinedPrompt[] {
  const adapter = new ClaudeCodeAdapter();
  const seen = new Set<string>();
  const mined: MinedPrompt[] = [];

  for (const file of listSessionLogs(projectsDir)) {
    if (mined.length >= limit) break;

    const session = adapter.parseLog(readFileSync(file, 'utf8'));
    for (const prompt of session.prompts) {
      if (mined.length >= limit) break;

      // Exclude hook-injected blocks (carry a <valis_search_results> hit block).
      if (prompt.injected) continue;
      // Exclude tool-result echoes / empty content (no extractable prompt text).
      const text = prompt.text.trim();
      if (!text) continue;
      // Dedup identical prompts (first occurrence wins).
      if (seen.has(text)) continue;

      seen.add(text);
      mined.push({ text, sessionId: session.sessionId });
    }
  }

  return mined;
}
