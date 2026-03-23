import { readFile } from 'node:fs/promises';
import type { RawDecision } from '../types.js';

interface ParsedEntry {
  text: string;
  section: string;
  type: 'decision' | 'constraint' | 'pattern' | 'lesson';
}

const CONSTRAINT_SIGNALS = [
  'must', 'never', 'always', 'do not', "don't", 'avoid',
  'only when', 'only if', 'required', 'mandatory', 'important',
  'override', 'critical',
];

const DECISION_SIGNALS = [
  'use ', 'prefer', 'switch to', 'choose', 'selected',
  'recommend', 'adopt', 'built with', 'powered by',
];

const PATTERN_SIGNALS = [
  'workflow', 'convention', 'approach', 'style', 'format',
  'when ', 'pattern', 'step', 'process',
];

function classifyEntry(text: string): 'decision' | 'constraint' | 'pattern' {
  const lower = text.toLowerCase();

  const constraintScore = CONSTRAINT_SIGNALS.filter((s) => lower.includes(s)).length;
  const decisionScore = DECISION_SIGNALS.filter((s) => lower.includes(s)).length;
  const patternScore = PATTERN_SIGNALS.filter((s) => lower.includes(s)).length;

  if (constraintScore > decisionScore && constraintScore > patternScore) return 'constraint';
  if (decisionScore > patternScore) return 'decision';
  if (patternScore > 0) return 'pattern';
  return 'pattern';
}

export async function parseClaudeMd(filePath: string): Promise<RawDecision[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  // Skip teamind markers
  content = content.replace(
    /<!-- teamind:start -->[\s\S]*?<!-- teamind:end -->/g,
    '',
  );

  const entries: ParsedEntry[] = [];
  const lines = content.split('\n');
  let currentSection = 'General';

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      currentSection = headingMatch[1];
      continue;
    }

    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch && bulletMatch[1].length > 10) {
      const text = bulletMatch[1];
      entries.push({
        text,
        section: currentSection,
        type: classifyEntry(text),
      });
    }
  }

  return entries.map((entry) => ({
    text: entry.text,
    type: entry.type,
    summary: entry.text.length > 100 ? entry.text.substring(0, 97) + '...' : entry.text,
    affects: [entry.section.toLowerCase().replace(/\s+/g, '-')],
  }));
}
