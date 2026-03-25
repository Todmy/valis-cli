import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import pc from 'picocolors';
import { loadManifest } from '../config/manifest.js';
import { getConfigDir } from '../config/store.js';

export async function uninstallCommand(options: { yes?: boolean }): Promise<void> {
  if (!options.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        pc.yellow('This will remove all local Valis configuration. Continue? (y/N) '),
      );
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('Aborted.');
        return;
      }
    } finally {
      rl.close();
    }
  }

  const manifest = await loadManifest();

  for (const entry of manifest.entries) {
    try {
      switch (entry.type) {
        case 'mcp_config': {
          // Surgical JSON edit — remove valis from mcpServers
          const data = await readFile(entry.path, 'utf-8');
          const settings = JSON.parse(data);
          if (settings.mcpServers?.valis) {
            delete settings.mcpServers.valis;
            await writeFile(entry.path, JSON.stringify(settings, null, 2));
            console.log(pc.green(`  ✓ Removed MCP config from ${entry.ide || 'unknown'}`));
          }
          break;
        }

        case 'claude_md_marker':
        case 'agents_md_marker':
        case 'cursorrules_marker': {
          // Remove valis markers
          try {
            const content = await readFile(entry.path, 'utf-8');
            const startMarker = '<!-- valis:start -->';
            const endMarker = '<!-- valis:end -->';

            if (content.includes(startMarker)) {
              const regex = new RegExp(
                `\\n?${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}\\n?`,
              );
              const cleaned = content.replace(regex, '\n');
              await writeFile(entry.path, cleaned.trim() + '\n');
              console.log(pc.green(`  ✓ Removed markers from ${entry.path}`));
            }
          } catch {
            // File might not exist anymore
          }
          break;
        }

        case 'hook_config': {
          console.log(pc.dim(`  Skipped hook config: ${entry.path}`));
          break;
        }
      }
    } catch (err) {
      console.log(pc.yellow(`  ⚠ Could not clean ${entry.path}: ${(err as Error).message}`));
    }
  }

  // Delete ~/.valis/
  try {
    await rm(getConfigDir(), { recursive: true, force: true });
    console.log(pc.green(`  ✓ Removed ${getConfigDir()}`));
  } catch {
    // Already gone
  }

  console.log(pc.bold('\nValis uninstalled.'));
  console.log(pc.dim('Cloud data preserved. Contact org admin to delete.\n'));
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
