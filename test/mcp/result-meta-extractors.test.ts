import { describe, it, expect, vi } from 'vitest';
import {
  extractSearchResultMeta,
  extractContextResultMeta,
  extractStoreResultMeta,
} from '../../src/mcp/server.js';
import { wrapToolWithAnalytics } from '../../src/mcp/analytics.js';
import type { ServerConfig } from '../../src/types.js';

// T2.2: result-meta extractors wired into tool registration so `mcp_tool_call`
// carries `result_count` (search/context) and `decision_type` (store). The
// extractors run on the wrapped handler's MCP content (the post-toContent
// shape) and must be pure + total — never throw.

function mcpContent(obj: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

describe('extractSearchResultMeta', () => {
  it('returns result_count = results.length', () => {
    const out = extractSearchResultMeta(mcpContent({ results: [{ id: 'a' }, { id: 'b' }] }));
    expect(out).toEqual({ result_count: 2 });
  });

  it('returns result_count = 0 for an empty result set', () => {
    expect(extractSearchResultMeta(mcpContent({ results: [] }))).toEqual({ result_count: 0 });
  });

  it('returns result_count = 0 when results key is missing', () => {
    expect(extractSearchResultMeta(mcpContent({ note: 'offline' }))).toEqual({ result_count: 0 });
  });

  it('is total — never throws on malformed content', () => {
    expect(() => extractSearchResultMeta(undefined)).not.toThrow();
    expect(() => extractSearchResultMeta({ content: [{ type: 'text', text: 'not json' }] })).not.toThrow();
    expect(extractSearchResultMeta(null)).toEqual({});
  });
});

describe('extractContextResultMeta', () => {
  it('sums the four active buckets into result_count', () => {
    const out = extractContextResultMeta(
      mcpContent({
        decisions: [{ id: 'd1' }, { id: 'd2' }],
        constraints: [{ id: 'c1' }],
        patterns: [],
        lessons: [{ id: 'l1' }],
        historical: [{ id: 'h1' }, { id: 'h2' }],
      }),
    );
    // historical excluded — 2 + 1 + 0 + 1 = 4
    expect(out).toEqual({ result_count: 4 });
  });

  it('returns result_count = 0 for an empty context', () => {
    const out = extractContextResultMeta(
      mcpContent({ decisions: [], constraints: [], patterns: [], lessons: [] }),
    );
    expect(out).toEqual({ result_count: 0 });
  });

  it('is total — never throws on malformed content', () => {
    expect(() => extractContextResultMeta(undefined)).not.toThrow();
    expect(extractContextResultMeta({ content: [{ type: 'text', text: '{' }] })).toEqual({});
  });
});

describe('extractStoreResultMeta', () => {
  it('returns decision_type from args.type', () => {
    const out = extractStoreResultMeta(mcpContent({ id: 'x', status: 'stored' }), 'pattern');
    expect(out).toEqual({ decision_type: 'pattern' });
  });

  it('returns {} when no type was supplied', () => {
    expect(extractStoreResultMeta(mcpContent({ id: 'x', status: 'stored' }), undefined)).toEqual({});
  });

  it('is total — never throws', () => {
    expect(() => extractStoreResultMeta(undefined, undefined)).not.toThrow();
  });
});

// Integration: prove the extractors merge into the emitted mcp_tool_call when
// driven through the real wrapper (the same wiring path registerToolFromDef uses).
function makeConfig(emit: (event: string, payload: Record<string, unknown>) => void): ServerConfig {
  return {
    org_id: 'org-abc',
    member_id: 'mem-123',
    author_name: 'tester',
    role: 'member',
    auth_mode: 'jwt',
    supabase_url: 'https://x.supabase.co',
    supabase_service_role_key: 'srk',
    qdrant_url: 'https://q.qdrant.io',
    qdrant_api_key: 'qak',
    api_key: 'tm_x',
    member_api_key: 'tm_x',
    project_id: 'proj-1',
    project_name: 'valis',
    emit_funnel: emit,
  };
}

describe('result-meta extractors wired through wrapToolWithAnalytics', () => {
  it('valis_search emits mcp_tool_call with result_count (incl. 0)', async () => {
    const emit = vi.fn();
    const config = makeConfig(emit);
    const handler = vi.fn().mockResolvedValue(mcpContent({ results: [] }));
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler, extractSearchResultMeta);

    await wrapped({ query: 'hi' });

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      tool: 'valis_search',
      success: true,
      result_count: 0,
    }));
  });

  it('valis_search emits result_count for a non-empty set', async () => {
    const emit = vi.fn();
    const config = makeConfig(emit);
    const handler = vi.fn().mockResolvedValue(mcpContent({ results: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }));
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler, extractSearchResultMeta);

    await wrapped({ query: 'hi' });

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      result_count: 3,
    }));
  });

  it('valis_store emits mcp_tool_call with decision_type from args.type', async () => {
    const emit = vi.fn();
    const config = makeConfig(emit);
    const args = { text: 'a decision text long enough', type: 'decision' };
    const handler = vi.fn().mockResolvedValue(mcpContent({ id: 'x', status: 'stored' }));
    const wrapped = wrapToolWithAnalytics(
      'valis_store',
      config,
      handler,
      (result) => extractStoreResultMeta(result, args.type),
    );

    await wrapped(args);

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      tool: 'valis_store',
      success: true,
      decision_type: 'decision',
    }));
  });
});
