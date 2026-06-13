/**
 * 285 APE harness — real-log eval (Task 14).
 *
 * The no-labels baseline: parse off-the-shelf Claude Code session JSONL on disk
 * (const II) via `adapter.parseLog` and report how often the live hook/tool path
 * actually fired across real sessions — the fraction of prompts that led to a
 * valis consult and that carried an injected `<valis_search_results>` block.
 *
 * Unlike the offline trial eval (Task 13), this needs NO gold-set labels: it
 * measures observed behaviour, not correctness against an expected label.
 *
 * Reuses the same directory walk shape as the prompt miner (Task 6) so both
 * agree on which files count as session logs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../types.js';

export interface RealLogEvalOpts {
  projectsDir: string;
  adapter: AgentAdapter;
}

export interface RealLogEvalResult {
  sessions: number;
  prompts: number;
  consultRate: number;
  injectRate: number;
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

export function evalRealLog({ projectsDir, adapter }: RealLogEvalOpts): RealLogEvalResult {
  let sessions = 0;
  let prompts = 0;
  let consulted = 0;
  let injected = 0;

  for (const file of listSessionLogs(projectsDir)) {
    const session = adapter.parseLog(readFileSync(file, 'utf8'));
    sessions += 1;
    for (const prompt of session.prompts) {
      prompts += 1;
      if (prompt.consulted) consulted += 1;
      if (prompt.injected) injected += 1;
    }
  }

  // Empty corpus → zeroed counts, no throw (baseline has no gold-set to fail on).
  const consultRate = prompts === 0 ? 0 : consulted / prompts;
  const injectRate = prompts === 0 ? 0 : injected / prompts;

  return { sessions, prompts, consultRate, injectRate };
}
