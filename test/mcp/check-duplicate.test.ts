import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() co-hoists with vi.mock() to avoid TDZ errors
// ---------------------------------------------------------------------------

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'test-org-id',
    org_name: 'Test Org',
    api_key: 'tm_test123',
    author_name: 'tester',
    supabase_url: 'https://test.supabase.co',
    supabase_service_role_key: 'test-key',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-qdrant-key',
    configured_ides: [],
    created_at: new Date().toISOString(),
  }),
}));

vi.mock('../../src/config/project.js', () => ({
  resolveConfig: vi.fn().mockResolvedValue({
    global: {
      org_id: 'test-org-id',
      org_name: 'Test Org',
      api_key: 'tm_test123',
      author_name: 'tester',
      supabase_url: 'https://test.supabase.co',
      supabase_service_role_key: 'test-key',
      qdrant_url: 'https://test.qdrant.io',
      qdrant_api_key: 'test-qdrant-key',
      configured_ides: [],
      created_at: new Date().toISOString(),
    },
    project: {
      project_id: 'test-project-id',
      project_name: 'Test Project',
    },
  }),
}));

vi.mock('../../src/cloud/qdrant.js', () => ({
  getQdrantClient: vi.fn().mockReturnValue({
    query: mockQuery,
  }),
  buildProjectFilter: vi.fn().mockReturnValue({
    must: [{ key: 'org_id', match: { value: 'test-org-id' } }],
  }),
  COLLECTION_NAME: 'decisions_v2',
}));

vi.mock('../../src/cloud/embedding.js', () => ({
  detectEmbeddingStrategy: vi.fn().mockResolvedValue({
    mode: 'server',
    supportsHybrid: true,
    queryForDense: vi.fn().mockReturnValue({ text: 'test', model: 'test-model' }),
  }),
  truncateForEmbedding: vi.fn().mockImplementation((t: string) => t),
  ClientEmbeddingStrategy: class {},
  DENSE_VECTOR_NAME: '',
}));

import { handleCheckDuplicate } from '../../src/mcp/tools/check-duplicate.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCheckDuplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching duplicates above threshold', async () => {
    mockQuery.mockResolvedValue({
      points: [
        {
          id: 'dec-1',
          score: 0.92,
          payload: {
            summary: 'Use PostgreSQL for storage',
            status: 'active',
            created_at: '2026-04-10T12:00:00Z',
          },
        },
        {
          id: 'dec-2',
          score: 0.87,
          payload: {
            summary: 'PostgreSQL for user data',
            status: 'proposed',
            created_at: '2026-04-09T10:00:00Z',
          },
        },
      ],
    });

    const result = await handleCheckDuplicate({ text: 'We should use PostgreSQL' });

    expect(result.duplicates).toHaveLength(2);
    expect(result.duplicates[0].id).toBe('dec-1');
    expect(result.duplicates[0].similarity).toBe(0.92);
    expect(result.duplicates[0].status).toBe('active');
    expect(result.duplicates[1].id).toBe('dec-2');
    expect(result.checked_count).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('returns empty when no matches above threshold', async () => {
    mockQuery.mockResolvedValue({ points: [] });

    const result = await handleCheckDuplicate({ text: 'Completely novel decision' });

    expect(result.duplicates).toHaveLength(0);
    expect(result.checked_count).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('returns error on Qdrant failure without throwing', async () => {
    mockQuery.mockRejectedValue(new Error('connection timeout'));

    const result = await handleCheckDuplicate({ text: 'Test text' });

    expect(result.duplicates).toHaveLength(0);
    expect(result.error).toBe('search_unavailable');
  });

  it('accepts custom threshold', async () => {
    mockQuery.mockResolvedValue({ points: [] });

    await handleCheckDuplicate({ text: 'Test text', threshold: 0.5 });

    expect(mockQuery).toHaveBeenCalledWith(
      'decisions_v2',
      expect.objectContaining({ score_threshold: 0.5 }),
    );
  });

  it('uses default threshold of 0.85', async () => {
    mockQuery.mockResolvedValue({ points: [] });

    await handleCheckDuplicate({ text: 'Test text' });

    expect(mockQuery).toHaveBeenCalledWith(
      'decisions_v2',
      expect.objectContaining({ score_threshold: 0.85 }),
    );
  });

  it('sorts results by descending similarity', async () => {
    mockQuery.mockResolvedValue({
      points: [
        { id: 'low', score: 0.86, payload: { status: 'active' } },
        { id: 'high', score: 0.95, payload: { status: 'active' } },
        { id: 'mid', score: 0.90, payload: { status: 'active' } },
      ],
    });

    const result = await handleCheckDuplicate({ text: 'Test' });

    expect(result.duplicates[0].id).toBe('high');
    expect(result.duplicates[1].id).toBe('mid');
    expect(result.duplicates[2].id).toBe('low');
  });
});
