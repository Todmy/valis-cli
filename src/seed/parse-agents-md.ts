import { readFile } from 'node:fs/promises';
import type { RawDecision } from '../types.js';

export async function parseAgentsMd(filePath: string): Promise<RawDecision[]> {
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

  const decisions: RawDecision[] = [];
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
      decisions.push({
        text,
        type: 'pattern',
        summary: text.length > 100 ? text.substring(0, 97) + '...' : text,
        affects: [currentSection.toLowerCase().replace(/\s+/g, '-')],
      });
    }
  }

  return decisions;
}
