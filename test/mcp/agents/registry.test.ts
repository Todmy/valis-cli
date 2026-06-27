/**
 * 308 — static agent registry schema + accessor contract.
 *
 * The registry is a typed const lookup of persona agents (slug → AgentDef).
 * This test enforces the schema across all entries on every CI build and
 * pins the seeded `negotiator` entry's project_id.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { AGENTS, listAgents, getAgent, isAgentSlug } from '../../../src/mcp/agents/index.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AgentDefSchema = z.object({
  slug: z.string().min(1),
  project_id: z.string().regex(UUID_RE),
  title: z.string().min(1),
  expertise: z.string().min(1),
  when_to_use: z.string().min(1),
  sample_questions: z.array(z.string().min(1)).min(3),
});

describe('mcp/agents registry', () => {
  it('every entry satisfies AgentDefSchema', () => {
    for (const [key, def] of Object.entries(AGENTS)) {
      expect(() => AgentDefSchema.parse(def)).not.toThrow();
      // key matches its own slug
      expect(def.slug).toBe(key);
    }
  });

  it('getAgent("negotiator") is defined with the seeded project_id', () => {
    const negotiator = getAgent('negotiator');
    expect(negotiator).toBeDefined();
    expect(negotiator?.project_id).toBe('d023233b-de54-46d4-a500-525acb4d9c0d');
  });

  it('getAgent for an unknown slug is undefined', () => {
    expect(getAgent('does-not-exist')).toBeUndefined();
  });

  it('isAgentSlug discriminates known vs unknown slugs', () => {
    expect(isAgentSlug('negotiator')).toBe(true);
    expect(isAgentSlug('nope')).toBe(false);
  });

  it('listAgents returns all entries including negotiator', () => {
    const list = listAgents();
    expect(list.length).toBe(Object.keys(AGENTS).length);
    expect(list.some((a) => a.slug === 'negotiator')).toBe(true);
  });
});
