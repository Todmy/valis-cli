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
  return handleSearch(
    { query: args.query, target_project_id: agent.project_id },
    configOverride,
  );
}
