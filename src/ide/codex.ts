import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { trackFile } from '../config/manifest.js';

export async function configureCodexMCP(): Promise<void> {
  const configPath = join(homedir(), '.codex', 'config.json');

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

  await trackFile({ type: 'mcp_config', path: configPath, ide: 'codex' });
}

export async function injectAgentsMdMarkers(projectDir: string): Promise<void> {
  const agentsMdPath = join(projectDir, 'AGENTS.md');
  const startMarker = '<!-- teamind:start -->';
  const endMarker = '<!-- teamind:end -->';

  const instructions = `## Team Knowledge (Teamind)

Use \`teamind_search\` before making architectural decisions.
Use \`teamind_store\` when decisions are made.
Use \`teamind_context\` at the start of each task.`;

  let content = '';
  try {
    content = await readFile(agentsMdPath, 'utf-8');
  } catch {
    // File doesn't exist
  }

  const block = `${startMarker}\n${instructions}\n${endMarker}`;

  if (content.includes(startMarker) && content.includes(endMarker)) {
    const regex = new RegExp(
      `${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}`,
    );
    content = content.replace(regex, block);
  } else if (content) {
    content = content.trimEnd() + '\n\n' + block + '\n';
  } else {
    content = block + '\n';
  }

  await writeFile(agentsMdPath, content);
  await trackFile({ type: 'agents_md_marker', path: agentsMdPath });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
