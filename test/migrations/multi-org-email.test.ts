import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPaths = [
  new URL('../../../../supabase/migrations/036_multi_org_email.sql', import.meta.url),
  new URL('../../community/migrations/036_multi_org_email.sql', import.meta.url),
];

describe('multi-org email migration', () => {
  it('drops the legacy global unique constraint and keeps a lookup index', async () => {
    for (const path of migrationPaths) {
      const sql = await readFile(path, 'utf8');
      expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS members_email_key/);
      expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_members_email/);
    }
  });
});
