/**
 * Task 2 — navigator tools `valis_list_agents` + `valis_consult_agent`.
 *
 * `handleListAgents` is pure (reads the static registry). `handleConsultAgent`
 * routes a query to the matched agent's KB by reusing the existing search
 * handler with `target_project_id` set to the agent's project_id — the same
 * cross-org public-KB read path (feature 033) gated by `canReadProject`.
 *
 * Search deps are mocked exactly like search.public.test.ts; `handleSearch`
 * itself is wrapped in a spy (via importActual) so we can assert it is/ isn't
 * called AND still exercise its real deny behaviour for the access test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/store.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    org_id: 'caller-org',
    qdrant_url: 'https://test.qdrant.io',
    qdrant_api_key: 'test-key',
  }),
}));

vi.mock('../../../src/cloud/qdrant.js', async () => ({
  mmrRerank: (
    await vi.importActual<typeof import('../../../src/cloud/qdrant/search.js')>(
      '../../../src/cloud/qdrant/search.js',
    )
  ).mmrRerank,
  getQdrantClient: vi.fn().mockReturnValue({}),
  hybridSearch: vi.fn().mockResolvedValue([
    {
      id: 'result-1',
      score: 0.95,
      type: 'decision',
      summary: 'Negotiation tactic from the negotiator KB',
      detail: 'Some content',
      author: 'publisher',
      affects: ['negotiation'],
      created_at: '2026-05-01T12:00:00Z',
      confidence: 0.9,
      pinned: false,
      depends_on: [],
    },
  ]),
}));

vi.mock('../../../src/billing/usage.js', () => ({
  checkUsageBeforeSearch: vi.fn().mockResolvedValue({ allowed: true }),
  incrementUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/cloud/supabase.js', () => ({
  getSupabaseClient: vi.fn().mockReturnValue({}),
  getSupabaseJwtClient: vi.fn().mockReturnValue({}),
  getDecisionsByIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../src/lib/project-access.js', () => ({
  canReadProject: vi.fn(),
}));

vi.mock('../../../src/cloud/supabase/audit.js', () => ({
  storeAuditEntry: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/cloud/api-url.js', () => ({
  isHostedMode: vi.fn().mockReturnValue(false),
}));

// Wrap the real handleSearch in a spy: assert call/no-call AND exercise its
// real deny behaviour (test 4) with the mocked sub-deps above.
vi.mock('../../../src/mcp/tools/search.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/mcp/tools/search.js')>();
  return { ...actual, handleSearch: vi.fn(actual.handleSearch) };
});

import { handleListAgents, handleConsultAgent } from '../../../src/mcp/tools/agents.js';
import { handleSearch } from '../../../src/mcp/tools/search.js';
import { canReadProject } from '../../../src/lib/project-access.js';
import type { SearchResponse } from '../../../src/types.js';

const NEGOTIATOR_PROJECT_ID = 'd023233b-de54-46d4-a500-525acb4d9c0d';

const httpServerOverride = {
  org_id: 'caller-org',
  member_id: 'caller-member-id',
  author_name: 'Caller',
  role: 'project_member',
  auth_mode: 'jwt' as const,
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'srv-key',
  qdrant_url: 'https://test.qdrant.io',
  qdrant_api_key: 'test-key',
  api_key: 'tok',
  member_api_key: 'tok',
  project_id: 'own-project-id',
};

describe('navigator tools — list_agents + consult_agent (Task 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_agents returns an agents array including negotiator with its fields', () => {
    const result = handleListAgents();
    expect(Array.isArray(result.agents)).toBe(true);
    const negotiator = result.agents.find((a) => a.slug === 'negotiator');
    expect(negotiator).toBeDefined();
    expect(negotiator).toMatchObject({
      slug: 'negotiator',
      title: 'Negotiator',
    });
    expect(typeof negotiator?.expertise).toBe('string');
    expect(typeof negotiator?.when_to_use).toBe('string');
    expect(Array.isArray(negotiator?.sample_questions)).toBe(true);
  });

  it('consult_agent with an unknown slug returns an error + available list, never calling search', async () => {
    const result = await handleConsultAgent(
      { agent: 'nope', query: 'how do I anchor?' },
      httpServerOverride,
    );

    expect(result).toEqual({
      error: "Unknown agent 'nope'. Call list_agents first.",
      available: ['negotiator'],
    });
    expect(handleSearch).not.toHaveBeenCalled();
  });

  it('consult_agent routes to the matched agent KB via target_project_id', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);

    await handleConsultAgent(
      { agent: 'negotiator', query: 'how do I counter a lowball?' },
      httpServerOverride,
    );

    expect(handleSearch).toHaveBeenCalledTimes(1);
    const searchArgs = vi.mocked(handleSearch).mock.calls[0][0];
    expect(searchArgs.target_project_id).toBe(NEGOTIATOR_PROJECT_ID);
    expect(searchArgs.query).toBe('how do I counter a lowball?');
  });

  it('consult_agent returns empty results (not 403/throw) when access is denied', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(false);

    const result = (await handleConsultAgent(
      { agent: 'negotiator', query: 'q' },
      httpServerOverride,
    )) as SearchResponse;

    expect(result.results).toEqual([]);
  });

  it('emits exactly one agent_consulted funnel event with agent_slug + count', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);
    const emit_funnel = vi.fn();

    await handleConsultAgent(
      { agent: 'negotiator', query: 'how do I anchor high?' },
      { ...httpServerOverride, emit_funnel },
    );

    expect(emit_funnel).toHaveBeenCalledTimes(1);
    const [event, props] = emit_funnel.mock.calls[0];
    expect(event).toBe('agent_consulted');
    expect(props).toMatchObject({ agent_slug: 'negotiator', count: 1 });
  });

  it('agent_consulted payload carries NO query/result/decision-id (privacy — Principle XIII)', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);
    const emit_funnel = vi.fn();
    const query = 'SECRET sensitive negotiation question about the acme deal';

    await handleConsultAgent(
      { agent: 'negotiator', query },
      { ...httpServerOverride, emit_funnel },
    );

    const props = emit_funnel.mock.calls[0][1] as Record<string, unknown>;
    // ONLY agent_slug + count — identity rides as distinctId/group on the bridge.
    expect(Object.keys(props).sort()).toEqual(['agent_slug', 'count']);
    expect(props).not.toHaveProperty('query');
    expect(props).not.toHaveProperty('decision_id');
    expect(props).not.toHaveProperty('results');
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain(query);
  });

  it('a throwing funnel sink never breaks the consult response (non-blocking — Principle III)', async () => {
    vi.mocked(canReadProject).mockResolvedValueOnce(true);
    const emit_funnel = vi.fn(() => {
      throw new Error('sink down');
    });

    const result = (await handleConsultAgent(
      { agent: 'negotiator', query: 'q' },
      { ...httpServerOverride, emit_funnel },
    )) as SearchResponse;

    expect(Array.isArray(result.results)).toBe(true);
  });

  it('unknown-slug guard path emits NO funnel event', async () => {
    const emit_funnel = vi.fn();

    await handleConsultAgent(
      { agent: 'nope', query: 'q' },
      { ...httpServerOverride, emit_funnel },
    );

    expect(emit_funnel).not.toHaveBeenCalled();
  });
});
