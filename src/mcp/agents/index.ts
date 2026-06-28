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
      'Research-backed negotiation for ANY deal — money, work, contracts, ' +
      'rent, big purchases, cofounder/equity, and conflicts. Covers BATNA/ZOPA, ' +
      'anchoring and concessions, countering hardball tactics, multi-party ' +
      'dynamics, tactical empathy, and staying calm under pressure.',
    when_to_use:
      'Any negotiation, not just salary: buying or selling, vendor and client ' +
      'contracts, rent, equity splits, workplace asks, or defusing a tense ' +
      'standoff — when preparing, anchoring, countering an offer, or facing a ' +
      'hardball tactic.',
    sample_questions: [
      'How do I get a car dealer to drop the price?',
      'How do I ask for a raise without it backfiring?',
      'Our SaaS vendor is hiking renewal 40% — how do I push back?',
      'Can I negotiate down a rent increase with my landlord?',
      'How do I split equity with a cofounder fairly?',
      'They gave me a take-it-or-leave-it deadline — what do I do?',
      'How do I stay calm when the other side gets aggressive?',
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
