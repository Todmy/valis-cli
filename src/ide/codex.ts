import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { trackFile } from '../config/manifest.js';

export async function injectAgentsMdMarkers(projectDir: string): Promise<void> {
  const agentsMdPath = join(projectDir, 'AGENTS.md');
  const startMarker = '<!-- valis:start -->';
  const endMarker = '<!-- valis:end -->';

  const instructions = `## Team Knowledge (Valis)

Use \`valis_search\` before making decisions.
Use \`valis_store\` when decisions are made.
Use \`valis_context\` at the start of each task.`;

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
