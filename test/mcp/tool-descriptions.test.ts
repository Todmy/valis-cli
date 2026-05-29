/**
 * 039/#94 (US3 / FR-007) — static regression test asserting the
 * `valis_search` and `valis_context` tool descriptions instruct the agent to
 * disclose which project was searched and to ask the user before concluding a
 * decision was never made when other accessible projects exist.
 *
 * Reads the server source as text rather than importing TOOL_DEFS (which is
 * module-private) so the assertion is a true static-string guard and does not
 * couple the test to the registry's runtime shape. Keyed on stable phrasing
 * keywords so it survives incidental prompt edits.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = readFileSync(
  resolve(__dirname, '../../src/mcp/server.ts'),
  'utf8',
);

/** Extract a single TOOL_DEFS entry's `description` string literal. */
function descriptionOf(tool: string): string {
  // Match `  <tool>: {\n    description:\n      "..."` — the description is the
  // first double-quoted or single-quoted literal after the tool key.
  const idx = SERVER_SRC.indexOf(`${tool}: {`);
  expect(idx, `${tool} entry present in TOOL_DEFS`).toBeGreaterThan(-1);
  const after = SERVER_SRC.slice(idx);
  const descIdx = after.indexOf('description:');
  expect(descIdx, `${tool} has a description`).toBeGreaterThan(-1);
  const tail = after.slice(descIdx);
  // Capture the (possibly multi-line) first string literal.
  const match = tail.match(/description:\s*(["'`])([\s\S]*?)\1/);
  expect(match, `${tool} description is a string literal`).not.toBeNull();
  return match![2];
}

describe('tool descriptions — scope-disclosure directive (FR-007)', () => {
  for (const tool of ['valis_search', 'valis_context'] as const) {
    it(`${tool} directs the agent to state which project was searched/loaded`, () => {
      const desc = descriptionOf(tool);
      expect(desc).toContain('scope');
      // Must reference the active-project field.
      expect(desc).toMatch(/active_project/);
      // Must tell the agent to state which project it consulted.
      expect(desc).toMatch(/state which project/i);
    });

    it(`${tool} directs the agent to ask before concluding absence`, () => {
      const desc = descriptionOf(tool);
      expect(desc).toMatch(/ask the user before concluding/i);
      expect(desc).toContain('scope_hint');
      expect(desc).toContain('all_projects');
    });
  }
});
