import { writeFile } from 'node:fs/promises';
import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { getSupabaseClient, getAllDecisions } from '../cloud/supabase.js';
import type { Decision } from '../types.js';

export async function exportCommand(options: {
  json?: boolean;
  markdown?: boolean;
  output?: string;
}): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  const supabase = getSupabaseClient(config.supabase_url, config.supabase_service_role_key);
  const decisions = await getAllDecisions(supabase, config.org_id);

  if (decisions.length === 0) {
    console.log('No decisions to export.');
    return;
  }

  let output: string;

  if (options.markdown) {
    output = formatMarkdown(decisions, config.org_name);
  } else {
    // Default to JSON
    output = JSON.stringify(decisions, null, 2);
  }

  if (options.output) {
    await writeFile(options.output, output);
    console.log(pc.green(`✓ Exported ${decisions.length} decisions to ${options.output}`));
  } else {
    process.stdout.write(output);
  }
}

function formatMarkdown(decisions: Decision[], orgName: string): string {
  const lines: string[] = [
    `# Team Decisions — ${orgName}`,
    ``,
    `Exported: ${new Date().toISOString()}`,
    `Total: ${decisions.length}`,
    ``,
  ];

  const grouped: Record<string, Decision[]> = {};
  for (const d of decisions) {
    const type = d.type || 'other';
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(d);
  }

  for (const [type, items] of Object.entries(grouped)) {
    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s (${items.length})`);
    lines.push('');
    for (const d of items) {
      lines.push(`### ${d.summary || d.detail.substring(0, 80)}`);
      lines.push('');
      lines.push(d.detail);
      lines.push('');
      lines.push(`- **Author**: ${d.author}`);
      lines.push(`- **Status**: ${d.status}`);
      if (d.affects.length > 0) {
        lines.push(`- **Affects**: ${d.affects.join(', ')}`);
      }
      lines.push(`- **Date**: ${d.created_at}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
