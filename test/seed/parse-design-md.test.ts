import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDesignMd } from '../../src/seed/parse-design-md.js';

describe('parseDesignMd', () => {
  const testDir = join(tmpdir(), 'valis-test-design-' + Date.now());

  it('returns empty array for non-existent file', async () => {
    const result = await parseDesignMd('/non/existent/DESIGN.md');
    expect(result).toEqual([]);
  });

  it('returns empty array for empty file', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'empty-DESIGN.md');
    await writeFile(filePath, '');

    const result = await parseDesignMd(filePath);
    expect(result).toEqual([]);

    await rm(testDir, { recursive: true, force: true });
  });

  it('parses Design Decisions with status and structured fields', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `# Project Design

## Design Decisions

### Use PostgreSQL for persistence

**Status:** accepted

**Context:** We need a reliable relational database for storing decisions.

**Decision:** Use PostgreSQL via Supabase for all persistent storage.

**Consequences:** Team must learn Supabase SDK. Migration tooling required.

### Consider Redis for caching

**Status:** proposed

**Context:** Response times are too slow for search queries.

**Decision:** Add Redis as a caching layer in front of Qdrant.

**Consequences:** Extra infrastructure cost and operational complexity.
`);

    const result = await parseDesignMd(filePath);

    expect(result.length).toBe(2);

    // First decision — accepted → confidence 1.0
    expect(result[0].type).toBe('decision');
    expect(result[0].confidence).toBe(1.0);
    expect(result[0].text).toContain('Use PostgreSQL for persistence');
    expect(result[0].text).toContain('reliable relational database');
    expect(result[0].text).toContain('Supabase');
    expect(result[0].affects).toEqual(['design-decisions']);

    // Second decision — proposed → confidence 0.5
    expect(result[1].type).toBe('decision');
    expect(result[1].confidence).toBe(0.5);
    expect(result[1].text).toContain('Consider Redis for caching');

    await rm(testDir, { recursive: true, force: true });
  });

  it('parses Decisions heading variant', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Decisions

### Monorepo structure

**Status:** accepted

**Context:** We have multiple packages that share code.

**Decision:** Use pnpm workspaces for monorepo management.

**Consequences:** All packages share a single lockfile.
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe('decision');
    expect(result[0].affects).toEqual(['decisions']);

    await rm(testDir, { recursive: true, force: true });
  });

  it('uses default confidence 0.8 for unknown status', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Design Decisions

### Use custom logger

**Status:** experimental

**Context:** Standard loggers are too verbose for our needs.

**Decision:** Build a minimal logger wrapper.
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.8);

    await rm(testDir, { recursive: true, force: true });
  });

  it('uses deprecated confidence 0.2', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Design Decisions

### Use MongoDB for storage

**Status:** deprecated

**Context:** Originally chose MongoDB for flexibility.

**Decision:** Use MongoDB as primary datastore.

**Consequences:** Replaced by PostgreSQL decision.
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(1);
    expect(result[0].confidence).toBe(0.2);

    await rm(testDir, { recursive: true, force: true });
  });

  it('parses Constraints section as constraint type', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Constraints

- All API responses must complete within 500ms
- Database migrations must be backward compatible
- Short item
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(2);
    expect(result.every(r => r.type === 'constraint')).toBe(true);
    expect(result[0].affects).toEqual(['constraints']);
    // Short items (< 10 chars) should be skipped
    expect(result.some(r => r.text === 'Short item')).toBe(false);

    await rm(testDir, { recursive: true, force: true });
  });

  it('parses Architecture section as pattern type', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Architecture

- Event-driven architecture with message queues for async processing
- Repository pattern for all database access layers
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(2);
    expect(result.every(r => r.type === 'pattern')).toBe(true);
    expect(result[0].affects).toEqual(['architecture']);

    await rm(testDir, { recursive: true, force: true });
  });

  it('parses a full DESIGN.md with all section types', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `# System Design

## Design Decisions

### Use TypeScript strict mode

**Status:** accepted

**Context:** Type safety reduces runtime errors significantly.

**Decision:** Enable strict mode in all tsconfig files.

**Consequences:** Some legacy code requires type annotations.

## Constraints

- Maximum bundle size must stay under 500KB gzipped
- All public APIs must have OpenAPI documentation

## Architecture

- Hexagonal architecture with ports and adapters pattern
- CQRS for read/write separation in the decision store
`);

    const result = await parseDesignMd(filePath);

    const decisions = result.filter(r => r.type === 'decision');
    const constraints = result.filter(r => r.type === 'constraint');
    const patterns = result.filter(r => r.type === 'pattern');

    expect(decisions.length).toBe(1);
    expect(constraints.length).toBe(2);
    expect(patterns.length).toBe(2);
    expect(result.length).toBe(5);

    await rm(testDir, { recursive: true, force: true });
  });

  it('skips valis markers', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Constraints

- All endpoints must require authentication tokens

<!-- valis:start -->
## Design Decisions

### Hidden decision

**Status:** accepted

**Context:** This should not appear in results at all.

**Decision:** This is inside valis markers.
<!-- valis:end -->

- Rate limiting must be enforced on all public endpoints
`);

    const result = await parseDesignMd(filePath);
    const texts = result.map(r => r.text);
    expect(texts.some(t => t.includes('Hidden decision'))).toBe(false);
    expect(texts.some(t => t.includes('authentication'))).toBe(true);
    expect(texts.some(t => t.includes('Rate limiting'))).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });

  it('generates truncated summary for long text', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    const longConstraint = 'A'.repeat(150) + ' constraint text that is very long and should be truncated in the summary field';
    await writeFile(filePath, `## Constraints

- ${longConstraint}
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(1);
    expect(result[0].summary!.length).toBeLessThanOrEqual(100);
    expect(result[0].summary!.endsWith('...')).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });

  it('skips items with text shorter than 10 characters', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'DESIGN.md');
    await writeFile(filePath, `## Constraints

- Too short
- This constraint is long enough to be captured properly
`);

    const result = await parseDesignMd(filePath);
    expect(result.length).toBe(1);
    expect(result[0].text).toContain('long enough');

    await rm(testDir, { recursive: true, force: true });
  });
});
