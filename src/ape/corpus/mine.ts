/**
 * 285/RT3 APE harness — JSONL scenario miner (reshaped from single-prompt).
 *
 * Walks off-the-shelf Claude Code session logs (`<project>/<session>.jsonl`
 * under `projectsDir`, const II: parse on disk, no IDE-stream interception) and
 * extracts multi-turn user-prompt SEQUENCES to seed the gold-set corpus.
 *
 * A *scenario* is a run of CONSECUTIVE typed user prompts within a single
 * session, of length L. The `mix` (a `ScenarioMix`, e.g. `{ 1: 3, 2: 2, 3: 1 }`)
 * sets how many scenarios of each turn-length to mine; windows are taken
 * non-overlapping from the start of each session so the same prompts aren't
 * reused across buckets and the result is deterministic (sessions sorted).
 *
 * Reuses `ClaudeCodeAdapter.parseLog` (Task 3) to separate a real prompt from
 * an injected `<valis_search_results>` block and from tool-result echoes:
 *   - injected blocks → `prompt.injected === true`  (dropped)
 *   - tool-result echoes → empty text after parsing (dropped)
 *
 * Output is a `RawScenario` (turns + provenance only); the consult/inject/
 * stratum labels are authored downstream (RT-label), never derived here.
 * NOTE: `RawScenario` is defined locally; RT9 promotes the canonical type into
 * `ape/types.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../agents/claude-code.js';
import { DEFAULT_SCENARIO_MIX, type ScenarioMix } from './schema.js';

export interface MineScenariosOpts {
  projectsDir: string;
  /** Length-bucket → target count. Defaults to `DEFAULT_SCENARIO_MIX`. */
  mix?: ScenarioMix;
}

/** A mined, pre-label scenario: consecutive typed prompts + provenance. */
export interface RawScenario {
  turns: string[];
  sourceSession: string;
}

/**
 * Legacy single-prompt mined shape. Kept as a backward-compat alias so the not-
 * yet-reshaped label path (`corpus/label.ts`) still type-checks; the labeling
 * reshape (RT-label) drops it. RT3 owns only `mine.ts`.
 */
export interface MinedPrompt {
  text: string;
  sessionId: string;
}

/** Enumerate `<project>/<session>.jsonl` files one directory deep, sorted. */
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

/** Typed prompts of a session in order: drops injected blocks + empty echoes. */
function sessionPrompts(
  file: string,
  adapter: ClaudeCodeAdapter,
): { sessionId: string; prompts: string[] } {
  const session = adapter.parseLog(readFileSync(file, 'utf8'));
  const prompts: string[] = [];
  for (const prompt of session.prompts) {
    if (prompt.injected) continue; // hook-injected <valis_search_results> block
    const text = prompt.text.trim();
    if (!text) continue; // tool-result echo / empty content
    prompts.push(text);
  }
  return { sessionId: session.sessionId, prompts };
}

/**
 * Mine multi-turn scenarios honouring the length-bucket `mix`.
 *
 * For each requested length L, slide a NON-overlapping window of size L over the
 * typed prompts of each session (in sorted order), collecting up to `mix[L]`
 * scenarios. Sessions shorter than L for a bucket contribute nothing to it.
 */
export function mineScenarios({
  projectsDir,
  mix = DEFAULT_SCENARIO_MIX,
}: MineScenariosOpts): RawScenario[] {
  const adapter = new ClaudeCodeAdapter();
  const sessions = listSessionLogs(projectsDir).map((f) => sessionPrompts(f, adapter));

  const out: RawScenario[] = [];
  // Stable bucket order (ascending length) so output is deterministic.
  const lengths = Object.keys(mix)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);

  for (const len of lengths) {
    const target = mix[len];
    if (!target || target <= 0) continue;
    let collected = 0;

    for (const { sessionId, prompts } of sessions) {
      if (collected >= target) break;
      for (let i = 0; i + len <= prompts.length; i += len) {
        if (collected >= target) break;
        out.push({ turns: prompts.slice(i, i + len), sourceSession: sessionId });
        collected++;
      }
    }
  }

  return out;
}
