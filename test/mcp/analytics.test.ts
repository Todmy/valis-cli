import { describe, it, expect, vi, beforeEach } from 'vitest';
import { wrapToolWithAnalytics } from '../../src/mcp/analytics.js';
import type { ServerConfig } from '../../src/types.js';

// BUG #183 regression tests: every MCP tool call must emit `mcp_tool_call`
// with duration + success/error classification, and analytics failure must
// NEVER throw into the handler path.

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    ...overrides,
  };
}

const okResult = { content: [{ type: 'text' as const, text: '{"status":"ok"}' }] };

describe('wrapToolWithAnalytics', () => {
  let emit: ReturnType<typeof vi.fn>;
  let config: ServerConfig;

  beforeEach(() => {
    emit = vi.fn();
    config = makeConfig({ emit_funnel: emit });
  });

  it('emits mcp_tool_call on success with full payload', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    const result = await wrapped({ query: 'hello' });

    expect(result).toBe(okResult);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      tool: 'valis_search',
      success: true,
      member_id: 'mem-123',
      org_id: 'org-abc',
      project_id: 'proj-1',
    }));
    const [, payload] = emit.mock.calls[0];
    expect(typeof payload.duration_ms).toBe('number');
    expect(payload.duration_ms).toBeGreaterThanOrEqual(0);
    expect(payload.error_code).toBeUndefined();
  });

  it('emits with success=false and classified error_code on handler failure', async () => {
    class ProjectScopeError extends Error {
      code = 'project_scope_mismatch';
      constructor() { super('JWT scope does not match active .valis.json'); }
    }
    const handler = vi.fn().mockRejectedValue(new ProjectScopeError());
    const wrapped = wrapToolWithAnalytics('valis_store', config, handler);

    await expect(wrapped({ text: 'x' })).rejects.toThrow('JWT scope does not match');
    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      tool: 'valis_store',
      success: false,
      error_code: 'project_scope_mismatch',
      error_message: expect.stringContaining('JWT scope'),
    }));
  });

  it('records target_project_id_passed=true when args carry target_project_id', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    await wrapped({ query: 'hi', target_project_id: 'other-proj-uuid' });

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      target_project_id_passed: true,
    }));
    // Privacy: the actual UUID must not be in the payload.
    const [, payload] = emit.mock.calls[0];
    expect(payload.target_project_id).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain('other-proj-uuid');
  });

  it('omits target_project_id_passed when arg is absent', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    await wrapped({ query: 'hi' });

    const [, payload] = emit.mock.calls[0];
    expect(payload.target_project_id_passed).toBeUndefined();
  });

  it('NEVER throws when emit itself throws — handler result is preserved', async () => {
    const emitThrows = vi.fn().mockImplementation(() => {
      throw new Error('posthog network down');
    });
    const cfg = makeConfig({ emit_funnel: emitThrows });
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_context', cfg, handler);

    const result = await wrapped({ task_description: 'x' });
    expect(result).toBe(okResult);
    expect(emitThrows).toHaveBeenCalled();
  });

  it('NEVER swallows handler error even if emit throws', async () => {
    const emitThrows = vi.fn().mockImplementation(() => {
      throw new Error('posthog network down');
    });
    const cfg = makeConfig({ emit_funnel: emitThrows });
    const handler = vi.fn().mockRejectedValue(new Error('original handler failure'));
    const wrapped = wrapToolWithAnalytics('valis_store', cfg, handler);

    await expect(wrapped({ text: 'x' })).rejects.toThrow('original handler failure');
    expect(emitThrows).toHaveBeenCalled();
  });

  it('is a strict no-op around the handler when configOverride is undefined (stdio path)', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_search', undefined, handler);

    const result = await wrapped({ query: 'hi' });
    expect(result).toBe(okResult);
    expect(handler).toHaveBeenCalledTimes(1);
    // No emit channel, so nothing to assert; the contract is "does not throw".
  });

  it('is a strict no-op when emit_funnel is undefined', async () => {
    const cfg = makeConfig({ emit_funnel: undefined });
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics('valis_search', cfg, handler);

    const result = await wrapped({ query: 'hi' });
    expect(result).toBe(okResult);
  });

  it('truncates very long error messages to keep PostHog payload bounded', async () => {
    const longMessage = 'x'.repeat(500);
    const handler = vi.fn().mockRejectedValue(new Error(longMessage));
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    await expect(wrapped({ query: 'x' })).rejects.toThrow();
    const [, payload] = emit.mock.calls[0];
    expect(payload.error_message.length).toBeLessThanOrEqual(201); // 200 chars + ellipsis
    expect(payload.error_message.endsWith('…')).toBe(true);
  });

  it('falls back to unknown_error code when error has no code field', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('mystery'));
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    await expect(wrapped({ query: 'x' })).rejects.toThrow();
    const [, payload] = emit.mock.calls[0];
    // Error name 'Error' is used when no `code` field exists.
    expect(payload.error_code).toBe('Error');
  });

  it('handles non-Error throwables (string, undefined) without crashing emit', async () => {
    const handler = vi.fn().mockRejectedValue('plain string error');
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler);

    await expect(wrapped({ query: 'x' })).rejects.toBe('plain string error');
    const [, payload] = emit.mock.calls[0];
    expect(payload.error_code).toBe('unknown_error');
    expect(payload.error_message).toBe('plain string error');
  });

  // T2.1: optional result-meta extractor merged into mcp_tool_call on success.
  it('merges result_count into mcp_tool_call on success', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics(
      'valis_search',
      config,
      handler,
      () => ({ result_count: 5 }),
    );

    await wrapped({ query: 'hi' });

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      result_count: 5,
    }));
  });

  it('merges decision_type into mcp_tool_call on success', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics(
      'valis_store',
      config,
      handler,
      () => ({ decision_type: 'pattern' }),
    );

    await wrapped({ text: 'x' });

    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      decision_type: 'pattern',
    }));
  });

  it('omits result-meta on the error path', async () => {
    const extractor = vi.fn(() => ({ result_count: 5, decision_type: 'pattern' }));
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const wrapped = wrapToolWithAnalytics('valis_search', config, handler, extractor);

    await expect(wrapped({ query: 'x' })).rejects.toThrow('boom');
    expect(extractor).not.toHaveBeenCalled();
    const [, payload] = emit.mock.calls[0];
    expect(payload.success).toBe(false);
    expect(payload.result_count).toBeUndefined();
    expect(payload.decision_type).toBeUndefined();
  });

  it('still emits base payload when extractResultMeta throws', async () => {
    const handler = vi.fn().mockResolvedValue(okResult);
    const wrapped = wrapToolWithAnalytics(
      'valis_search',
      config,
      handler,
      () => { throw new Error('extractor blew up'); },
    );

    const result = await wrapped({ query: 'hi' });

    expect(result).toBe(okResult);
    expect(emit).toHaveBeenCalledWith('mcp_tool_call', expect.objectContaining({
      tool: 'valis_search',
      success: true,
    }));
    const [, payload] = emit.mock.calls[0];
    expect(payload.result_count).toBeUndefined();
    expect(payload.decision_type).toBeUndefined();
  });
});
