import { join } from 'node:path';
import { parseClaudeMd } from './parse-claude-md.js';
import { parseAgentsMd } from './parse-agents-md.js';
import { parseGitLog } from './parse-git-log.js';
import type { RawDecision, DecisionSource } from '../types.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { storeDecision } from '../cloud/supabase.js';
import { upsertDecision } from '../cloud/qdrant.js';
import { contentHash } from '../capture/dedup.js';

export interface SeedResult {
  total: number;
  stored: number;
  skipped: number;
  sources: Record<string, number>;
}

export async function runSeed(
  projectDir: string,
  orgId: string,
  author: string,
  supabase: SupabaseClient,
  qdrant: QdrantClient,
): Promise<SeedResult> {
  const result: SeedResult = {
    total: 0,
    stored: 0,
    skipped: 0,
    sources: {},
  };

  // Collect from all parsers
  const [claudeMdDecisions, agentsMdDecisions, gitLogDecisions] = await Promise.all([
    parseClaudeMd(join(projectDir, 'CLAUDE.md')),
    parseAgentsMd(join(projectDir, 'AGENTS.md')),
    parseGitLog(projectDir),
  ]);

  const allDecisions: Array<{ raw: RawDecision; sourceName: string }> = [
    ...claudeMdDecisions.map((d) => ({ raw: d, sourceName: 'CLAUDE.md' })),
    ...agentsMdDecisions.map((d) => ({ raw: d, sourceName: 'AGENTS.md' })),
    ...gitLogDecisions.map((d) => ({ raw: d, sourceName: 'git-log' })),
  ];

  result.total = allDecisions.length;

  // Deduplicate by content hash
  const seenHashes = new Set<string>();

  for (const { raw, sourceName } of allDecisions) {
    const hash = contentHash(raw.text);
    if (seenHashes.has(hash)) {
      result.skipped++;
      continue;
    }
    seenHashes.add(hash);

    try {
      const decision = await storeDecision(supabase, orgId, raw, author, 'seed' as DecisionSource);
      await upsertDecision(qdrant, orgId, decision.id, raw, author).catch(() => {
        // Qdrant failure non-critical during seed
      });
      result.stored++;
      result.sources[sourceName] = (result.sources[sourceName] || 0) + 1;
    } catch {
      result.skipped++;
    }
  }

  return result;
}
