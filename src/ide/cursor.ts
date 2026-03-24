import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { trackFile } from '../config/manifest.js';

const CURSORRULES_INSTRUCTIONS = `## Team Knowledge (Teamind)

### Auto-search triggers
Call \`teamind_search\` automatically when the user mentions:
- "remember", "recall", "find", "what did we decide", "how did we handle"
- Any question about architecture, conventions, past decisions, or existing patterns

### Auto-store triggers
Call \`teamind_store\` when:
- A technical choice is made between alternatives
- The user says "remember this", "store this"
- A constraint is identified (client/regulatory/infra)
- A coding pattern or convention is established
- A lesson is learned from a bug or incident

When storing, always include: \`type\` (decision/constraint/pattern/lesson), \`summary\` (max 100 chars), \`affects\` (list of modules).

### Context loading
Call \`teamind_context\` at the start of every new task or when switching to a different part of the codebase.

### Channel reminders
When you receive a \`<channel source="teamind" event="capture_reminder">\`, review your recent work and store any decisions made via \`teamind_store\`.`;

export async function configureCursorMCP(): Promise<void> {
  const configPath = join(homedir(), '.cursor', 'mcp.json');

  let config: Record<string, unknown> = {};
  try {
    const data = await readFile(configPath, 'utf-8');
    config = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }

  const mcpServers = (config.mcpServers || {}) as Record<string, unknown>;
  mcpServers['teamind'] = {
    command: 'teamind',
    args: ['serve'],
  };
  config.mcpServers = mcpServers;

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2));

  await trackFile({ type: 'mcp_config', path: configPath, ide: 'cursor' });
}

export async function injectCursorrules(projectDir: string): Promise<void> {
  const cursorrulesPath = join(projectDir, '.cursorrules');
  const startMarker = '<!-- teamind:start -->';
  const endMarker = '<!-- teamind:end -->';

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
