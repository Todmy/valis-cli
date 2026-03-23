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
      id: 'result-1',
      score: 0.95,
      type: 'decision',
      summary: 'Chose PostgreSQL',
      detail: 'We chose PostgreSQL for user data',
      author: 'olena',
      affects: ['database'],
      created_at: '2026-03-20T14:30:00Z',
    },
  ]),
}));

import { handleSearch } from '../../../src/mcp/tools/search.js';

describe('handleSearch', () => {
  it('returns search results', async () => {
    const result = await handleSearch({ query: 'database' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].type).toBe('decision');
  });

  it('returns empty results when not configured', async () => {
    const { loadConfig } = await import('../../../src/config/store.js');
    vi.mocked(loadConfig).mockResolvedValueOnce(null);

    const result = await handleSearch({ query: 'test' });
    expect(result.results).toHaveLength(0);
    expect(result.note).toContain('Not configured');
  });
});
