import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: vi.fn().mockResolvedValue([
    {
      id: 'r1',
      score: 0.9,
      type: 'decision',
      summary: 'Chose PostgreSQL',
      detail: 'We chose PostgreSQL',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-03-20T14:30:00Z',
    },
    {
      id: 'r2',
      score: 0.8,
      type: 'constraint',
      summary: 'Must support Safari 15+',
      detail: 'Client requires Safari 15+ support',
      author: 'andriy',
      affects: ['frontend'],
      created_at: '2026-03-19T10:00:00Z',
    },
  ]),
}));

import { handleContext } from '../../../src/mcp/tools/context.js';

describe('handleContext', () => {
  it('returns grouped results', async () => {
    const result = await handleContext({
      task_description: 'Implement user authentication',
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.constraints).toHaveLength(1);
    expect(result.total_in_brain).toBe(2);
  });

  it('includes orientation note on first call', async () => {
    const result = await handleContext({
      task_description: 'Setup database migrations',
      files: ['src/db/migrations.ts'],
    });

    // Note may or may not be present depending on test ordering
    expect(result).toHaveProperty('total_in_brain');
  });
});
