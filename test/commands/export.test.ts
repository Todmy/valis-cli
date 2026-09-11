import { describe, expect, it } from 'vitest';
import { buildExportJson, decisionMarkdown, EXPORT_SCHEMA_VERSION } from '../../src/commands/export.js';

const decision = {
  id: 'd1', org_id: 'o1', project_id: 'p1', type: 'decision', summary: 'Use Postgres',
  detail: 'Keep the source of truth in Postgres.', status: 'active', author: 'Dmytro',
  source: 'mcp_store', session_id: null, content_hash: 'h', confidence: 1, affects: ['data'],
  created_at: '2026-09-11T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
} as const;

describe('valis export formatters', () => {
  it('emits a versioned lossless envelope with project scope', () => {
    const result = buildExportJson([decision], ['p1']);
    expect(result.schema_version).toBe(EXPORT_SCHEMA_VERSION);
    expect(result.project_ids).toEqual(['p1']);
    expect(result.decisions).toEqual([decision]);
    expect(result).toHaveProperty('audit_entries');
    expect(result).toHaveProperty('decision_edges');
  });

  it('renders an ADR-style markdown document', () => {
    const md = decisionMarkdown(decision);
    expect(md).toContain('# Use Postgres');
    expect(md).toContain('**Type:** decision');
    expect(md).toContain('Keep the source of truth in Postgres.');
  });
});
