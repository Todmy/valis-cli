/**
 * `teamind switch` — Switch the active project for the current directory.
 *
 * Usage:
 *   teamind switch --project <name-or-id>   Switch to a named/ID'd project
 *   teamind switch                           Interactive — show list and prompt
 *
 * Updates `.teamind.json` in cwd with the selected project.
 *
 * @module commands/switch
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { findProjectConfig, writeProjectConfig } from '../config/project.js';
import { getSupabaseClient, listMemberProjects, type ProjectInfo } from '../cloud/supabase.js';
import { ERRORS, formatError } from '../errors.js';

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Find a project by name (case-insensitive) or exact UUID match.
 */
function findProject(
  projects: ProjectInfo[],
  nameOrId: string,
): ProjectInfo | undefined {
  // Try exact UUID match first
  const byId = projects.find((p) => p.id === nameOrId);
  if (byId) return byId;

  // Try case-insensitive name match
  const lower = nameOrId.toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lower);
}

export async function switchCommand(options: { project?: string }): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error(formatError(ERRORS.no_project_configured));
    console.error('\nRun `teamind init` first to configure your organization.');
    process.exit(1);
  }

  // Need member_id for listing projects — require JWT auth mode
  if (!config.member_id) {
    console.error(pc.red('Error: Member ID not available.'));
    console.error('Run `teamind init` or `teamind migrate-auth` to set up per-member authentication.');
    process.exit(1);
  }

  // Fetch projects from Supabase
  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);

  let projects: ProjectInfo[];
  try {
    projects = await listMemberProjects(supabase, config.member_id);
  } catch (err) {
    console.error(pc.red(`Failed to list projects: ${(err as Error).message}`));
    process.exit(1);
  }

  if (projects.length === 0) {
    console.error(pc.yellow('No projects found. Run `teamind init` to create one.'));
    process.exit(1);
  }

  // Show current project
  const currentProject = await findProjectConfig(process.cwd());
  if (currentProject) {
    console.log(pc.dim(`Current project: ${currentProject.project_name} (${currentProject.project_id})`));
  } else {
    console.log(pc.dim('Current project: (none)'));
  }

  let selected: ProjectInfo | undefined;

  if (options.project) {
    // Direct switch by name or ID
    selected = findProject(projects, options.project);
    if (!selected) {
      console.error(formatError(ERRORS.project_not_found));
      console.error(pc.dim(`\nAvailable projects:`));
      for (const p of projects) {
        console.error(pc.dim(`  - ${p.name} (${p.id})`));
      }
      process.exit(1);
    }
  } else {
    // Interactive mode — show list and prompt
    console.log(pc.bold('\nAvailable projects:\n'));
    for (let i = 0; i < projects.length; i++) {
      const p = projects[i]!;
      const isCurrent = currentProject?.project_id === p.id;
      const marker = isCurrent ? pc.green(' (current)') : '';
      const count = p.decision_count > 0 ? pc.dim(` — ${p.decision_count} decisions`) : '';
      console.log(`  ${pc.bold(String(i + 1))}. ${p.name}${marker}${count}`);
    }

    const answer = await prompt(`\nSelect project (1-${projects.length}): `);
    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) {
      console.error(pc.red('Invalid selection. Aborted.'));
      process.exit(1);
    }
    selected = projects[idx];
  }

  if (!selected) {
    console.error(pc.red('No project selected.'));
    process.exit(1);
  }

  // Skip if already on this project
  if (currentProject?.project_id === selected.id) {
    console.log(pc.yellow(`Already on project "${selected.name}". No changes made.`));
    return;
  }

  // Write .teamind.json in cwd
  const configPath = await writeProjectConfig(process.cwd(), {
    project_id: selected.id,
    project_name: selected.name,
  });

  console.log(pc.green(`\nSwitched to project "${selected.name}"`));
  console.log(pc.dim(`  Config written to ${configPath}`));
  console.log(pc.dim(`  Project ID: ${selected.id}`));
}
