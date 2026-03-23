import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseClaudeMd } from '../../src/seed/parse-claude-md.js';

describe('parseClaudeMd', () => {
  const testDir = join(tmpdir(), 'teamind-test-seed-' + Date.now());

  it('returns empty array for non-existent file', async () => {
    const result = await parseClaudeMd('/non/existent/CLAUDE.md');
    expect(result).toEqual([]);
  });

  it('extracts bullet points as decisions', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'CLAUDE.md');
    await writeFile(filePath, `# Project Rules

- Use TypeScript for all new code in this project
- Never commit directly to main branch without review
- Prefer functional patterns over class-based approaches
`);

    const result = await parseClaudeMd(filePath);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(r => r.text.length > 0)).toBe(true);
    expect(result.every(r => r.type !== undefined)).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });

  it('skips teamind markers', async () => {
    await mkdir(testDir, { recursive: true });
    const filePath = join(testDir, 'CLAUDE.md');
    await writeFile(filePath, `# Rules

- Use ESLint for code quality checks always

<!-- teamind:start -->
## Team Knowledge (Teamind)
- This should be skipped entirely from parsing
<!-- teamind:end -->

- Always run tests before committing code changes
`);

    const result = await parseClaudeMd(filePath);
    const texts = result.map(r => r.text);
    expect(texts.some(t => t.includes('should be skipped'))).toBe(false);
    expect(texts.some(t => t.includes('ESLint'))).toBe(true);

    await rm(testDir, { recursive: true, force: true });
  });
});
