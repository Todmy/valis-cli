/**
 * 308 — Static persona-agent registry.
 *
 * A typed const lookup (slug → AgentDef) of the persona agents the MCP
 * navigator can route to. Pure static data — no DB, no migration, no RLS.
 * New agents require a code change + PR. The schema is enforced in
 * test/mcp/agents/registry.test.ts on every CI build.
 */

export interface AgentDef {
  slug: string;
  project_id: string;
  title: string;
  expertise: string;
  when_to_use: string;
  sample_questions: string[];
}

export const AGENTS: Record<string, AgentDef> = {
  negotiator: {
    slug: 'negotiator',
    project_id: 'd023233b-de54-46d4-a500-525acb4d9c0d',
    title: 'Negotiator',
    expertise:
      'Research-backed negotiation: BATNA/ZOPA, anchoring and concessions, ' +
      'countering hardball tactics, and tactical empathy across salary, ' +
      'vendor, and deal negotiations.',
    when_to_use:
      'When the user is preparing for or in a negotiation — anchoring, ' +
      'countering an offer, or facing a hardball tactic.',
    sample_questions: [
      'How do I counter a lowball first offer?',
      'Should I name my salary number first?',
      'How do I respond to a take-it-or-leave-it deadline?',
    ],
  },
};

export function listAgents(): AgentDef[] {
  return Object.values(AGENTS);
}

export function getAgent(slug: string): AgentDef | undefined {
  return AGENTS[slug];
}

export function isAgentSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(AGENTS, slug);
}
