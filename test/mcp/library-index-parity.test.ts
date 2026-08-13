/**
 * gh#329 (verify V5) — `REQUIRED_INDEXES` is declared twice: once in the tool
 * (`src/mcp/tools/library-search.ts`) and once in the operator script
 * (`scripts/library-ops.mjs`, which lives in the PARENT repo — this package is
 * a submodule). A comment is the only thing keeping them in step.
 *
 * Drift is silent at ops time and loud at query time: the tool demands an index
 * the script never creates, and the operator learns about it from a user's
 * `library_rebuild_required`. This test makes drift fail in CI instead.
 *
 * The script is outside this package, so a standalone submodule checkout skips
 * rather than fails — an absent file is not evidence of drift.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REQUIRED_INDEXES } from '../../src/mcp/tools/library-search.js';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/library-ops.mjs', import.meta.url));

describe('REQUIRED_INDEXES parity with scripts/library-ops.mjs (gh#329 V5)', () => {
  it.skipIf(!existsSync(SCRIPT))('declares the same fields with the same types', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const block = source.match(/const REQUIRED_INDEXES = \[([\s\S]*?)\];/);
    expect(block, 'REQUIRED_INDEXES literal not found — the script was restructured').not.toBeNull();

    const inScript = [...block![1].matchAll(/field:\s*'([^']+)'\s*,\s*schema:\s*'([^']+)'/g)].map(
      ([, field, schema]) => `${field}:${schema}`,
    );
    const inTool = REQUIRED_INDEXES.map((i) => `${i.field}:${i.dataType}`);

    // Sorted: the contract is the set of (field, type) pairs, not their order.
    expect([...inScript].sort()).toEqual([...inTool].sort());
  });
});
