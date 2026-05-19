import type { ServerConfig } from '../../types.js';

const TAXONOMY_VERSION = '1.0.0';

const TAXONOMY_SPEC = {
  types: ['decision', 'constraint', 'pattern', 'lesson'] as const,
  statuses: ['active', 'proposed', 'deprecated', 'superseded'] as const,
  areaConventions: "lowercase, hyphenated (e.g., 'api-design', 'auth', 'database')",
  toolUsage: {
    store: 'When a choice is made between alternatives, constraint identified, pattern established, or lesson learned',
    search: "When recalling past decisions, 'what did we decide about X'",
    context: 'At session start or when switching contexts — loads recent decisions',
    lifecycle: 'To promote proposed→active, or deprecate/supersede active decisions',
    check_duplicate: 'Before storing — informational check for similar existing decisions',
  },
  version: TAXONOMY_VERSION,
};

export async function handleTaxonomy(
  _args: Record<string, never>,
  _configOverride?: ServerConfig,
): Promise<typeof TAXONOMY_SPEC> {
  return TAXONOMY_SPEC;
}
