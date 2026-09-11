import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationPaths = [
  new URL('../../../../supabase/migrations/037_harden_gap_grants.sql', import.meta.url),
  new URL('../../community/migrations/037_harden_gap_grants.sql', import.meta.url),
];

describe('gap Data API grants migration', () => {
  it('revokes member writes while retaining project-scoped reads', async () => {
    for (const path of migrationPaths) {
      const sql = await readFile(path, 'utf8');
      expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.gap_runs FROM authenticated/);
      expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.gap_questions FROM authenticated/);
      expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.gap_events FROM authenticated/);
      expect(sql).toMatch(/GRANT SELECT ON public\.gap_runs, public\.gap_questions, public\.gap_events TO authenticated/);
    }
  });
});
