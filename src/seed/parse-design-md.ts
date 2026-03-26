import { readFile } from 'node:fs/promises';
import type { RawDecision } from '../types.js';

const STATUS_CONFIDENCE: Record<string, number> = {
  accepted: 1.0,
  proposed: 0.5,
  deprecated: 0.2,
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '-');
}

function parseDecisionSections(lines: string[], sectionName: string): RawDecision[] {
  const decisions: RawDecision[] = [];
  let i = 0;

  while (i < lines.length) {
    const subheadingMatch = lines[i].match(/^###\s+(.+)/);
    if (!subheadingMatch) {
      i++;
      continue;
    }

    const title = subheadingMatch[1];
    i++;

    let status = '';
    let context = '';
    let decision = '';
    let consequences = '';
    let currentField = '';

    while (i < lines.length && !lines[i].match(/^###\s+/)) {
      const line = lines[i];

      const statusMatch = line.match(/\*\*Status:\*\*\s*(.+)/i);
      if (statusMatch) {
        status = statusMatch[1].trim().toLowerCase();
        i++;
        continue;
      }

      if (line.match(/\*\*Context:\*\*/i)) {
        currentField = 'context';
        const inline = line.replace(/\*\*Context:\*\*/i, '').trim();
        if (inline) context = inline;
        i++;
        continue;
      }
      if (line.match(/\*\*Decision:\*\*/i)) {
        currentField = 'decision';
        const inline = line.replace(/\*\*Decision:\*\*/i, '').trim();
        if (inline) decision = inline;
        i++;
        continue;
      }
      if (line.match(/\*\*Consequences:\*\*/i)) {
        currentField = 'consequences';
        const inline = line.replace(/\*\*Consequences:\*\*/i, '').trim();
        if (inline) consequences = inline;
        i++;
        continue;
      }

      // Accumulate text into current field
      if (currentField === 'context') {
        context += (context ? ' ' : '') + line.trim();
      } else if (currentField === 'decision') {
        decision += (decision ? ' ' : '') + line.trim();
      } else if (currentField === 'consequences') {
        consequences += (consequences ? ' ' : '') + line.trim();
      }

      i++;
    }

    const parts = [context, decision, consequences].filter(Boolean);
    const text = parts.length > 0 ? `${title}: ${parts.join(' ')}` : title;

    if (text.length < 10) continue;

    const confidence = STATUS_CONFIDENCE[status] ?? 0.8;

    decisions.push({
      text,
      type: 'decision',
      summary: text.length > 100 ? text.substring(0, 97) + '...' : text,
      affects: [slugify(sectionName)],
      confidence,
    });
  }

  return decisions;
}

function parseBulletItems(
  lines: string[],
  sectionName: string,
  type: 'constraint' | 'pattern',
): RawDecision[] {
  const decisions: RawDecision[] = [];

  for (const line of lines) {
    const bulletMatch = line.match(/^-\s+(.+)/);
    if (bulletMatch && bulletMatch[1].length > 10) {
      const text = bulletMatch[1];
      decisions.push({
        text,
        type,
        summary: text.length > 100 ? text.substring(0, 97) + '...' : text,
        affects: [slugify(sectionName)],
      });
      continue;
    }

    // Also capture non-bullet paragraphs for Architecture sections (type=pattern)
    if (type === 'pattern') {
      const trimmed = line.trim();
      if (trimmed.length > 10 && !trimmed.startsWith('#')) {
        decisions.push({
          text: trimmed,
          type,
          summary: trimmed.length > 100 ? trimmed.substring(0, 97) + '...' : trimmed,
          affects: [slugify(sectionName)],
        });
      }
    }
  }

  return decisions;
}

export async function parseDesignMd(filePath: string): Promise<RawDecision[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  // Skip valis markers
  content = content.replace(
    /<!-- valis:start -->[\s\S]*?<!-- valis:end -->/g,
    '',
  );

  const decisions: RawDecision[] = [];
  const lines = content.split('\n');

  // Split into sections by ## headings
  interface Section {
    name: string;
    lines: string[];
  }

  const sections: Section[] = [];
  let currentSection: Section | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      currentSection = { name: headingMatch[1], lines: [] };
      sections.push(currentSection);
      continue;
    }
    if (currentSection) {
      currentSection.lines.push(line);
    }
  }

  for (const section of sections) {
    const name = section.name.trim();
    const lowerName = name.toLowerCase();

    if (lowerName === 'design decisions' || lowerName === 'decisions') {
      decisions.push(...parseDecisionSections(section.lines, name));
    } else if (lowerName === 'constraints') {
      decisions.push(...parseBulletItems(section.lines, name, 'constraint'));
    } else if (lowerName === 'architecture') {
      decisions.push(...parseBulletItems(section.lines, name, 'pattern'));
    }
  }

  return decisions;
}
