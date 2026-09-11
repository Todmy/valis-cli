import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../config/project.js';
import { getSupabaseForConfig, getAllDecisions, listMemberProjects } from '../cloud/supabase.js';
import type { Decision } from '../types.js';
import { HOSTED_API_URL } from '../types.js';

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

export interface ExportRelatedRows {
  audit_entries: unknown[];
  contradictions: unknown[];
  decision_edges: unknown[];
  project_members: unknown[];
}

export function buildExportJson(
  decisions: Decision[],
  projectIds: string[],
  related: ExportRelatedRows = { audit_entries: [], contradictions: [], decision_edges: [], project_members: [] },
) {
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    project_ids: projectIds,
    decisions,
    ...related,
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
  if (config.auth_mode === 'jwt' && projectIds.length === 1) {
    const token = config.member_api_key || config.api_key;
    const response = await fetch(`${HOSTED_API_URL}/api/projects/${projectIds[0]}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Hosted export failed (${response.status}): ${await response.text()}`);
    const body = await response.json() as { schema_version: number; exported_at: string; project_ids: string[]; decisions: Decision[]; audit_entries: unknown[]; contradictions: unknown[]; decision_edges: unknown[]; project_members: unknown[] };
    const target = options.format === 'json' ? resolve(options.output || 'valis-export.json') : null;
    if (options.format === 'json') {
      await mkdir(dirname(target!), { recursive: true });
      await writeFile(target!, JSON.stringify(body, null, 2) + '\n');
      console.log(`Exported ${body.decisions.length} decisions to ${target}`);
      return;
    }
    const directory = resolve(options.output || 'valis-export');
    await mkdir(directory, { recursive: true });
    const index = ['# Valis decision export', '', `Schema version: ${body.schema_version}`, '', '## Decisions', ''];
    for (const decision of body.decisions) { const filename = `${decision.id}.md`; await writeFile(join(directory, filename), decisionMarkdown(decision)); index.push(`- [${decision.summary || decision.id}](./${filename})`); }
    await writeFile(join(directory, 'README.md'), index.join('\n') + '\n');
    console.log(`Exported ${body.decisions.length} decisions to ${directory}`);
    return;
  }

  const decisions: Decision[] = [];
  for (const projectId of projectIds) decisions.push(...await getAllDecisions(supabase, config.org_id, projectId));
  const fetchRows = async (table: string) => {
    const { data, error } = await supabase.from(table).select('*').in('project_id', projectIds);
    if (error) throw new Error(`Failed to export ${table}: ${error.message}`);
    return data || [];
  };
  const related: ExportRelatedRows = {
    audit_entries: await fetchRows('audit_entries'),
    contradictions: await fetchRows('contradictions'),
    decision_edges: await fetchRows('decision_edges'),
    project_members: await fetchRows('project_members'),
  };

  if (options.format === 'json') {
    const target = resolve(options.output || 'valis-export.json');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(buildExportJson(decisions, projectIds, related), null, 2) + '\n');
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
