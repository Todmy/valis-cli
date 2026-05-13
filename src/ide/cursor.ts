import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trackFile } from '../config/manifest.js';

const CURSORRULES_INSTRUCTIONS = `## Team Knowledge (Valis)

### Auto-search triggers
Call \`valis_search\` automatically when the user mentions:
- "remember", "recall", "find", "what did we decide", "how did we handle"
- Any question about architecture, conventions, past decisions, or existing patterns

### Auto-store triggers
Call \`valis_store\` when:
- A technical choice is made between alternatives
- The user says "remember this", "store this"
- A constraint is identified (client/regulatory/infra)
- A coding pattern or convention is established
- A lesson is learned from a bug or incident

When storing, always include: \`type\` (decision/constraint/pattern/lesson), \`summary\` (max 100 chars), \`affects\` (list of modules).

### Context loading
Call \`valis_context\` at the start of every new task or when switching to a different part of the codebase.

### Channel reminders
When you receive a \`<channel source="valis" event="capture_reminder">\`, review your recent work and store any decisions made via \`valis_store\`.`;

export async function injectCursorrules(projectDir: string): Promise<void> {
  const cursorrulesPath = join(projectDir, '.cursorrules');
  const startMarker = '<!-- valis:start -->';
  const endMarker = '<!-- valis:end -->';

  let content = '';
  try {
    content = await readFile(cursorrulesPath, 'utf-8');
  } catch {
    // File doesn't exist, create new
  }

  const block = `${startMarker}\n${CURSORRULES_INSTRUCTIONS}\n${endMarker}`;

  if (content.includes(startMarker) && content.includes(endMarker)) {
    // Replace existing block (idempotent)
    const regex = new RegExp(
      `${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`,
    );
    content = content.replace(regex, block);
  } else if (content) {
    // Append to existing file
    content = content.trimEnd() + '\n\n' + block + '\n';
  } else {
    // New file
    content = block + '\n';
  }

  await writeFile(cursorrulesPath, content);
  await trackFile({ type: 'cursorrules_marker', path: cursorrulesPath });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
