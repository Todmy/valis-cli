/**
 * valis hook session-start — SessionStart hook for Claude Code
 *
 * Called automatically at the start of every Claude Code session.
 * Loads recent team decisions from the active project and injects them
 * as additionalContext so the model has team knowledge before the first message.
 *
 * Installed into ~/.claude/settings.json during `valis init`.
 * Not user-facing — hidden from `valis --help`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ProjectConfig {
  project_id: string;
  project_name: string;
}

interface ValisConfig {
  org_id: string;
  org_name: string;
  member_api_key?: string;
  api_key?: string;
  supabase_url: string;
  author_name: string;
}

/**
 * SessionStart hook: loads recent decisions and injects into Claude context.
 *
 * Output format follows Claude Code hook protocol:
 * { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
 */
export async function hookSessionStartCommand(): Promise<void> {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // 1. Read per-project config
  let projectConfig: ProjectConfig | null = null;
  for (const configPath of [
    join(projectDir, '.valis.json'),
    join(projectDir, '.valis', 'config.json'),
  ]) {
    try {
      const data = await readFile(configPath, 'utf-8');
      projectConfig = JSON.parse(data);
      break;
    } catch { /* not found — try next */ }
  }

  if (!projectConfig) {
    // No Valis project configured for this directory — skip silently
    process.exit(0);
  }

  // 2. Read global config for auth
  const homedir = process.env.HOME || process.env.USERPROFILE || '~';
  let globalConfig: ValisConfig | null = null;
  try {
    const data = await readFile(join(homedir, '.valis', 'config.json'), 'utf-8');
    globalConfig = JSON.parse(data);
  } catch {
    // No global config — can't fetch decisions
    outputContext(projectConfig.project_name, [], 0);
    return;
  }

  // 3. Fetch recent decisions via API (hosted mode)
  const apiKey = globalConfig!.member_api_key || globalConfig!.api_key || '';
  const apiUrl = 'https://valis.krukit.co';

  let decisions: Array<{ summary: string; status: string; type: string }> = [];
  let contradictionCount = 0;

  try {
    // Exchange key for JWT
    const tokenRes = await fetch(`${apiUrl}/api/exchange-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ project_id: projectConfig.project_id }),
    });

    if (!tokenRes.ok) {
      outputContext(projectConfig.project_name, [], 0);
      return;
    }

    const { token: jwt } = (await tokenRes.json()) as { token: string };

    // Fetch recent decisions
    const searchRes = await fetch(`${apiUrl}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        query: '*',
        limit: 7,
        project_id: projectConfig.project_id,
      }),
    });

    if (searchRes.ok) {
      const searchData = (await searchRes.json()) as {
        results: Array<{ detail: string; type: string; status?: string; summary?: string }>;
        count: number;
      };
      decisions = searchData.results.map((r) => ({
        summary: r.summary || r.detail.substring(0, 80),
        status: r.status || 'active',
        type: r.type || 'decision',
      }));
    }
  } catch {
    // Network error — output context with empty decisions
  }

  outputContext(projectConfig.project_name, decisions, contradictionCount);
}

function outputContext(
  projectName: string,
  decisions: Array<{ summary: string; status: string; type: string }>,
  contradictions: number,
): void {
  let context = `## Valis — Team Brain (project: ${projectName})\\n\\n`;

  if (decisions.length > 0) {
    context += 'Recent team decisions:\\n';
    for (const d of decisions) {
      context += `• [${d.status}] ${d.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}\\n`;
    }
    context += `\\nOpen contradictions: ${contradictions}\\n`;
  } else {
    context += 'No recent decisions loaded. Use valis_store to capture team decisions.\\n';
  }

  context += '\\nAvailable tools:\\n';
  context += '- valis_context — load full context (call at task start)\\n';
  context += '- valis_search — find past decisions, patterns, constraints\\n';
  context += '- valis_store — capture new decisions (type: decision|constraint|pattern|lesson)\\n';
  context += '- valis_lifecycle — promote, deprecate, supersede decisions\\n';
  context += '- valis_check_duplicate — check before storing\\n';
  context += '\\nFor team decision queries, always prefer valis_search over other knowledge tools.';

  const output = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));
}
