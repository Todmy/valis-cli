/**
 * Task 2 — navigator tools `valis_list_agents` + `valis_consult_agent`.
 *
 * The navigator routes a question to ONE specialist persona-agent's knowledge
 * base. `list_agents` exposes the static registry (slug + advertising fields)
 * so the model can pick the best fit; `consult_agent` then reuses the existing
 * search handler with `target_project_id` set to the chosen agent's project,
 * riding the cross-org public-KB read path (feature 033) — no new access path.
 */

import { handleSearch } from './search.js';
import { getAgent, listAgents } from '../agents/index.js';
import type { ServerConfig, SearchResponse } from '../../types.js';

interface AgentCatalogEntry {
  slug: string;
  title: string;
  expertise: string;
  when_to_use: string;
  sample_questions: string[];
}

interface ListAgentsResult {
  agents: AgentCatalogEntry[];
}

/** Read-only catalog of the persona-agents the navigator can route to. */
export function handleListAgents(): ListAgentsResult {
  return {
    agents: listAgents().map((a) => ({
      slug: a.slug,
      title: a.title,
      expertise: a.expertise,
      when_to_use: a.when_to_use,
      sample_questions: a.sample_questions,
    })),
  };
}

interface ConsultAgentArgs {
  agent: string;
  query: string;
}

interface UnknownAgentResult {
  error: string;
  available: string[];
}

/**
 * Route `query` to one agent's KB. Unknown slug → structured error (never
 * throws, never calls search). Known slug → delegate to `handleSearch` with
 * the agent's project as the cross-org target; denial returns empty results.
 */
export async function handleConsultAgent(
  args: ConsultAgentArgs,
  configOverride?: ServerConfig,
): Promise<SearchResponse | UnknownAgentResult> {
  const agent = getAgent(args.agent);
  if (!agent) {
    return {
      error: `Unknown agent '${args.agent}'. Call list_agents first.`,
      available: listAgents().map((a) => a.slug),
    };
  }
  const result = await handleSearch(
    { query: args.query, target_project_id: agent.project_id },
    configOverride,
  );
  // Investor usage metric: one privacy-safe funnel event per resolved consult.
  // The member identity (distinctId) + org (group) are attached by the bridge
  // (buildFunnelEmitter); we pass ONLY the agent slug + count — never the
  // query, the result, or any decision id (Principle XIII — telemetry privacy).
  emitConsultEvent(configOverride, agent.slug);
  return result;
}

/**
 * Fire-and-forget consult funnel emission. A slow or failing sink must NEVER
 * delay or fail the consult response (Principle III — non-blocking), so the
 * emit is wrapped in try/catch and is a strict no-op when no `emit_funnel`
 * bridge is wired (local stdio path).
 */
function emitConsultEvent(config: ServerConfig | undefined, agentSlug: string): void {
  if (!config?.emit_funnel) return;
  try {
    config.emit_funnel('agent_consulted', { agent_slug: agentSlug, count: 1 });
  } catch {
    /* analytics must never break the consult path */
  }
}
