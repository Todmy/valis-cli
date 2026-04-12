import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() co-hoists with vi.mock() to avoid TDZ errors
// ---------------------------------------------------------------------------

const { mockSelect } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
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

vi.mock('../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: mockSelect,
    }),
  }),
  getSupabaseJwtClient: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      select: mockSelect,
    }),
  }),
}));

import { wakeUpCommand } from '../../src/commands/wake-up.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wakeUpCommand', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('shows decisions when found', async () => {
    const now = new Date();
    const decisions = [
      { id: 'd1', summary: 'Use PostgreSQL', status: 'active', created_at: now.toISOString() },
      { id: 'd2', summary: 'JWT auth', status: 'proposed', created_at: now.toISOString() },
    ];

    // Chain for decisions query
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: decisions, error: null }),
            }),
          }),
        }),
      }),
    });

    // Chain for contradictions count query
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 0 }),
        }),
      }),
    });

    await wakeUpCommand();

    const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Use PostgreSQL');
    expect(output).toContain('JWT auth');
    expect(output).toContain('Open contradictions: 0');
  });

  it('shows empty state when no decisions', async () => {
    // Chain for decisions query — empty
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      }),
    });

    await wakeUpCommand();

    const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('No activity yet');
  });

  it('handles query errors gracefully', async () => {
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        gte: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection failed' } }),
            }),
          }),
        }),
      }),
    });

    // Chain for contradictions (still called after error)
    mockSelect.mockReturnValueOnce({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ count: 0 }),
        }),
      }),
    });

    await wakeUpCommand();

    const output = consoleLogSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Error fetching decisions');
  });
});
