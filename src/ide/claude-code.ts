import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { trackFile } from '../config/manifest.js';

const AGENT_INSTRUCTIONS = `## Team Knowledge (Valis)

### Auto-search triggers
Call \`valis_search\` automatically when the user mentions:
- "знайди", "пошукай", "згадай", "нагадай", "як ми вирішили", "що ми робили з"
- "remember", "recall", "find", "what did we decide", "how did we handle"
- Any question about architecture, conventions, past decisions, or existing patterns

### Auto-store triggers
Call \`valis_store\` when:
- A technical choice is made between alternatives
- The user says "запам'ятай", "збережи", "remember this", "store this"
- A constraint is identified (client/regulatory/infra)
- A coding pattern or convention is established
- A lesson is learned from a bug or incident

When storing, always include: \`type\` (decision/constraint/pattern/lesson), \`summary\` (max 100 chars), \`affects\` (list of modules).

### Context loading
Call \`valis_context\` at the start of every new task or when switching to a different part of the codebase.

### Channel reminders
When you receive a \`<channel source="valis" event="capture_reminder">\`, review your recent work and store any decisions made via \`valis_store\`.`;

export async function configureClaudeCodeMCP(projectDir: string): Promise<void> {
  // MCP servers must go in ~/.claude.json (not ~/.claude/settings.json)
  // Claude Code reads MCP config from ~/.claude.json "mcpServers" key
  const mcpConfigPath = join(homedir(), '.claude.json');

  let mcpConfig: Record<string, unknown> = {};
  try {
    const data = await readFile(mcpConfigPath, 'utf-8');
    mcpConfig = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }

  const mcpServers = (mcpConfig.mcpServers || {}) as Record<string, unknown>;
  mcpServers['valis'] = {
    command: 'valis',
    args: ['serve'],
    env: {},
  };
  mcpConfig.mcpServers = mcpServers;

  await mkdir(join(homedir(), '.claude'), { recursive: true });
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');

  // Also update settings.json for other settings (cleanupPeriodDays, channels)
  const settingsPath = join(homedir(), '.claude', 'settings.json');

  let settings: Record<string, unknown> = {};
  try {
    const data = await readFile(settingsPath, 'utf-8');
    settings = JSON.parse(data);
  } catch {
    // File doesn't exist yet
  }

  // Set cleanupPeriodDays to prevent auto-cleanup
  settings.cleanupPeriodDays = 99999;

  // Enable development channels for Valis push notifications
  // Note: --dangerously-load-development-channels is a Claude Code CLI flag.
  // Users need to launch Claude Code with this flag for channel push to work:
  //   claude --dangerously-load-development-channels
  // For Enterprise/Team orgs, channelsEnabled must be set by org admin.
  // Channel push is an enhancement — MCP tools work without it.

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  await trackFile({ type: 'mcp_config', path: settingsPath, ide: 'claude-code' });
}

export async function injectClaudeMdMarkers(projectDir: string): Promise<void> {
  const claudeMdPath = join(projectDir, 'CLAUDE.md');
  const startMarker = '<!-- valis:start -->';
  const endMarker = '<!-- valis:end -->';

  let content = '';
  try {
    content = await readFile(claudeMdPath, 'utf-8');
  } catch {
    // File doesn't exist, create new
  }

  const block = `${startMarker}\n${AGENT_INSTRUCTIONS}\n${endMarker}`;

  if (content.includes(startMarker) && content.includes(endMarker)) {
    // Replace existing block
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

  await writeFile(claudeMdPath, content);
  await trackFile({ type: 'claude_md_marker', path: claudeMdPath });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
