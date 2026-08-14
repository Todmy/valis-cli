import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trackFile } from '../config/manifest.js';

const CURSORRULES_INSTRUCTIONS = `## Team Knowledge (Valis)

### Auto-search triggers
Call \`valis_search\` automatically when the user mentions:
- "remember", "recall", "find", "what did we decide", "how did we handle"
- Any question about decisions, conventions, or existing patterns

### Auto-store triggers
Call \`valis_store\` when:
- A choice is made between alternatives
- The user says "remember this", "store this"
- A constraint is identified (client/regulatory/infra/scheduling/cost/access)
- A pattern or convention is established
- A lesson is learned from an outcome (good or bad)

When storing, always include: \`type\` (decision/constraint/pattern/lesson), \`summary\` (max 100 chars), \`affects\` (list of modules).

### Reference library — external sources, when a project has one
Some projects carry a read-only corpus of externally authored works (standards,
handbooks) alongside their decisions, reachable via \`library_search\` and
\`library_list\`. Valis holds what the team decided; the library holds what the
literature says. Most projects have none — \`has_library: false\` is a legitimate
state. Pass \`target_project_id\` to read a project other than the active one.

1. **A hybrid question calls both tools.** "Why did we pick X" is a decision AND
   a citation — run \`valis_search\` and \`library_search\`, then answer.
2. **Zero hits in Valis does not close the question.** Never write "there is
   nothing on this" until the library has been asked too.
3. **Cite \`chunk_text\`, never \`contextual_text\`** — the second is a retrieval
   aid written at ingest, not source text. Scores are rank-derived, so nearest
   is not the same as relevant.

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
