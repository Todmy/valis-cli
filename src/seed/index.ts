import { join } from 'node:path';
import { parseClaudeMd } from './parse-claude-md.js';
import { parseAgentsMd } from './parse-agents-md.js';
import { parseDesignMd } from './parse-design-md.js';
import { parseGitLog } from './parse-git-log.js';
import type { RawDecision, DecisionSource } from '../types.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QdrantClient } from '@qdrant/js-client-rest';
import { detectSecrets } from '../security/secrets.js';
import { storeDecision } from '../cloud/supabase.js';
import { upsertDecision } from '../cloud/qdrant.js';
import { contentHash } from '../capture/dedup.js';
import { resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';

export interface SeedResult {
  total: number;
  stored: number;
  skipped: number;
  sources: Record<string, number>;
}

/**
 * Hosted-mode seed: parses decisions locally, sends them to the
 * server-side /functions/v1/seed endpoint for storage.
 * No service_role key needed — uses per-member API key.
 */
export async function runHostedSeed(
  projectDir: string,
  supabaseUrl: string,
  apiKey: string,
  projectId: string,
): Promise<SeedResult> {
  const result: SeedResult = { total: 0, stored: 0, skipped: 0, sources: {} };

  const [claudeMdDecisions, agentsMdDecisions, designMdDecisions, gitLogDecisions] = await Promise.all([
    parseClaudeMd(join(projectDir, 'CLAUDE.md')),
    parseAgentsMd(join(projectDir, 'AGENTS.md')),
    parseDesignMd(join(projectDir, 'DESIGN.md')),
    parseGitLog(projectDir),
  ]);

  const allDecisions: Array<{ raw: RawDecision; sourceName: string }> = [
    ...claudeMdDecisions.map((d) => ({ raw: d, sourceName: 'CLAUDE.md' })),
    ...agentsMdDecisions.map((d) => ({ raw: d, sourceName: 'AGENTS.md' })),
    ...designMdDecisions.map((d) => ({ raw: d, sourceName: 'DESIGN.md' })),
    ...gitLogDecisions.map((d) => ({ raw: d, sourceName: 'git-log' })),
  ];

  result.total = allDecisions.length;
  if (result.total === 0) return result;

  // Deduplicate locally before sending
  const seenHashes = new Set<string>();
  const unique: RawDecision[] = [];

  for (const { raw, sourceName } of allDecisions) {
    const hash = contentHash(raw.text);
    if (seenHashes.has(hash)) {
      result.skipped++;
      continue;
    }
    seenHashes.add(hash);
    unique.push(raw);
    result.sources[sourceName] = (result.sources[sourceName] || 0) + 1;
  }

  // Send to server-side seed endpoint
  const isHosted = supabaseUrl.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiBase = resolveApiUrl(supabaseUrl, isHosted);
  const seedUrl = resolveApiPath(apiBase, 'seed');
  try {
    const response = await fetch(seedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        decisions: unique.map((d) => ({
          text: d.text,
          type: d.type,
          summary: d.summary,
          affects: d.affects,
        })),
        project_id: projectId,
      }),
    });

    if (response.ok) {
      const data = await response.json() as { stored: number; skipped: number };
      result.stored = data.stored;
      result.skipped += data.skipped;
    } else {
      // Seed failed server-side — count all as skipped
      result.skipped += unique.length;
    }
  } catch {
    // Network error — count all as skipped
    result.skipped += unique.length;
  }

  return result;
}

export async function runSeed(
  projectDir: string,
  orgId: string,
  author: string,
  supabase: SupabaseClient,
  qdrant: QdrantClient,
  projectId?: string,
): Promise<SeedResult> {
  const result: SeedResult = {
    total: 0,
    stored: 0,
    skipped: 0,
    sources: {},
  };

  // Collect from all parsers
  const [claudeMdDecisions, agentsMdDecisions, designMdDecisions, gitLogDecisions] = await Promise.all([
    parseClaudeMd(join(projectDir, 'CLAUDE.md')),
    parseAgentsMd(join(projectDir, 'AGENTS.md')),
    parseDesignMd(join(projectDir, 'DESIGN.md')),
    parseGitLog(projectDir),
  ]);

  const allDecisions: Array<{ raw: RawDecision; sourceName: string }> = [
    ...claudeMdDecisions.map((d) => ({ raw: d, sourceName: 'CLAUDE.md' })),
    ...agentsMdDecisions.map((d) => ({ raw: d, sourceName: 'AGENTS.md' })),
    ...designMdDecisions.map((d) => ({ raw: d, sourceName: 'DESIGN.md' })),
    ...gitLogDecisions.map((d) => ({ raw: d, sourceName: 'git-log' })),
  ];

  result.total = allDecisions.length;

  // Filter out decisions containing secrets
  const safeDecisions = allDecisions.filter(d => {
    const secret = detectSecrets(d.raw.text);
    if (secret) {
      console.warn('[valis] Blocked seeding decision with ' + secret.pattern + ' — skipped');
      return false;
    }
    if (d.raw.summary) {
      const summarySecret = detectSecrets(d.raw.summary);
      if (summarySecret) {
        console.warn('[valis] Blocked seeding decision with ' + summarySecret.pattern + ' in summary — skipped');
        return false;
      }
    }
    return true;
  });

  // Deduplicate by content hash
  const seenHashes = new Set<string>();

  for (const { raw, sourceName } of safeDecisions) {
    const hash = contentHash(raw.text);
    if (seenHashes.has(hash)) {
      result.skipped++;
      continue;
    }
    seenHashes.add(hash);

    try {
      // Inject project_id into each seeded decision when available
      const rawWithProject = projectId ? { ...raw, project_id: projectId } : raw;
      const decision = await storeDecision(supabase, orgId, rawWithProject, author, 'seed' as DecisionSource);
      await upsertDecision(qdrant, orgId, decision.id, rawWithProject, author).catch(() => {
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
