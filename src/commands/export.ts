import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../config/project.js';
import { getSupabaseForConfig, getAllDecisions, listMemberProjects } from '../cloud/supabase.js';
import type { Decision } from '../types.js';

export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportOptions {
  format: 'json' | 'md';
  project?: string;
  allProjects?: boolean;
  output?: string;
}

export function decisionMarkdown(decision: Decision): string {
  const affects = decision.affects.length ? decision.affects.join(', ') : 'none';
  return `# ${decision.summary || decision.id}\n\n- **Type:** ${decision.type}\n- **Status:** ${decision.status}\n- **Author:** ${decision.author}\n- **Created:** ${decision.created_at}\n- **Affects:** ${affects}\n- **Decision ID:** ${decision.id}\n\n${decision.detail}\n`;
}

export function buildExportJson(decisions: Decision[], projectIds: string[]) {
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    project_ids: projectIds,
    decisions,
    audit_entries: [],
    contradictions: [],
    decision_edges: [],
    project_members: [],
  };
}

export async function exportCommand(options: ExportOptions): Promise<void> {
  if (!['json', 'md'].includes(options.format)) throw new Error('Format must be json or md');
  const resolved = await resolveConfig();
  if (!resolved.global) throw new Error('Valis is not configured. Run `valis init` first.');
  const config = resolved.global;
  const supabase = getSupabaseForConfig(config);
  const activeProject = resolved.project?.project_id;
  let projectIds: string[] = [];
  if (options.allProjects) {
    if (!config.member_id) throw new Error('--all-projects requires member credentials');
    projectIds = (await listMemberProjects(supabase, config.member_id)).map((p) => p.id);
  } else {
    const projectId = options.project || activeProject;
    if (!projectId) throw new Error('No project selected. Use --project or configure an active project.');
    projectIds = [projectId];
  }
  const decisions: Decision[] = [];
  for (const projectId of projectIds) decisions.push(...await getAllDecisions(supabase, config.org_id, projectId));

  if (options.format === 'json') {
    const target = resolve(options.output || 'valis-export.json');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(buildExportJson(decisions, projectIds), null, 2) + '\n');
    console.log(`Exported ${decisions.length} decisions to ${target}`);
    return;
  }

  const directory = resolve(options.output || 'valis-export');
  await mkdir(directory, { recursive: true });
  const index = ['# Valis decision export', '', `Schema version: ${EXPORT_SCHEMA_VERSION}`, '', '## Decisions', ''];
  for (const decision of decisions) {
    const filename = `${decision.id}.md`;
    await writeFile(join(directory, filename), decisionMarkdown(decision));
    index.push(`- [${decision.summary || decision.id}](./${filename})`);
  }
  await writeFile(join(directory, 'README.md'), index.join('\n') + '\n');
  console.log(`Exported ${decisions.length} decisions to ${directory}`);
}
