/**
 * Access resolution for multi-project reads (gh#322).
 *
 * `resolveReadScope` decides *which* projects a read covers; this decides
 * which of them the caller may actually reach. Kept separate because the
 * scope rule is pure and exhaustively testable, while this one talks to
 * Supabase — mixing them would drag mocks into the security-critical branch.
 *
 * Cost shape: the membership list is one query no matter how many candidates
 * arrive. Only candidates absent from that list cost a `canReadProject`
 * round-trip each (a public project in another org — feature 033), and the
 * `linked_projects` cap of 20 bounds that fan-out.
 *
 * Failure is closed, without exception. A membership lookup that throws
 * returns `[]`, never a partial or optimistic set — gh#324 is the record of
 * what the optimistic version costs.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listMemberProjects } from '../cloud/supabase.js';
import { canReadProject } from './project-access.js';

export async function resolveAccessibleProjectIds(
  supabase: SupabaseClient,
  memberId: string,
  candidateIds: string[],
): Promise<string[]> {
  if (!memberId) return [];

  let memberIds: string[];
  try {
    const projects = await listMemberProjects(supabase, memberId);
    memberIds = projects.map((p) => p.id);
  } catch {
    return [];
  }

  const known = new Set(memberIds);
  const outsiders = [...new Set(candidateIds)].filter((id) => !known.has(id));
  if (outsiders.length === 0) return memberIds;

  // Each rejection or throw drops exactly that id; the rest stay intact. A
  // single unreachable project must not blank out a search over the others.
  const verdicts = await Promise.all(
    outsiders.map(async (id) => {
      try {
        return (await canReadProject(supabase, memberId, id)) ? id : null;
      } catch {
        return null;
      }
    }),
  );

  return [...memberIds, ...verdicts.filter((id): id is string => id !== null)];
}
