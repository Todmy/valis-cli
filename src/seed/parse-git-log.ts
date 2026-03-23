import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RawDecision } from '../types.js';

const execFileAsync = promisify(execFile);

const NOISE_PATTERNS = [
  /^chore:\s*(update|rename|remove|fix)\s/i,
  /^fix\s*typo/i,
  /^chore:\s*bump/i,
  /^merge\s/i,
  /^wip/i,
  /^initial commit$/i,
  /^update\s+readme/i,
];

function isNoise(message: string): boolean {
  return NOISE_PATTERNS.some((p) => p.test(message));
}

function classifyCommit(message: string): 'decision' | 'pattern' | 'lesson' {
  const lower = message.toLowerCase();
  if (/refactor|restructure|redesign|migrate|split|extract/.test(lower)) return 'decision';
  if (/fix:|bugfix|hotfix/.test(lower)) return 'lesson';
  return 'pattern';
}

export async function parseGitLog(repoPath: string, limit = 50): Promise<RawDecision[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'log', '--oneline', '--format=%H|%s', `-${limit}`],
      { encoding: 'utf-8' },
    );

    const lines = stdout.trim().split('\n').filter(Boolean);
    const decisions: RawDecision[] = [];

    for (const line of lines) {
      const separatorIndex = line.indexOf('|');
      if (separatorIndex === -1) continue;

      const message = line.substring(separatorIndex + 1);
      if (isNoise(message) || message.length < 10) continue;

      const cleaned = message
        .replace(/^feat:\s*/i, '')
        .replace(/^fix:\s*/i, '')
        .replace(/^chore:\s*/i, '');

      decisions.push({
        text: cleaned.length >= 10 ? cleaned : message,
        type: classifyCommit(message),
        summary: message.length > 100 ? message.substring(0, 97) + '...' : message,
      });
    }

    return decisions;
  } catch {
    return [];
  }
}
