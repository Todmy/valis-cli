/**
 * 034 / T032 — unit tests for the `valis personal-drafts` CLI surface
 * (triage + restore). Verifies the interactive triage walker correctly
 * dispatches B / A / D / S / Q against the cloud helpers (mocked) and
 * that restore maps the helper's null verdict to the exit-2 "no row"
 * contract.
 *
 * Architectural notes:
 *   - readline.createInterface is mocked with a programmable response
 *     queue so each prompt() call pops the next scripted answer. This
 *     keeps the tests deterministic without spawning a real stdin tty.
 *   - @inquirer/select is mocked so the Bind sub-prompt returns a
 *     pre-selected target project id without rendering.
 *   - process.exit is replaced with a throwing stub so we can assert
 *     the exit code from the test instead of crashing the runner.
 *   - The mocked supabase client is `{}` — none of the helpers run
 *     against it because the cloud-layer functions themselves are
 *     mocked at module boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Programmable readline queue — pushed before each test, popped per prompt.
const promptQueue: string[] = [];

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => {
      if (promptQueue.length === 0) return '';
      return promptQueue.shift()!;
    }),
    close: vi.fn(),
  })),
}));

vi.mock('@inquirer/select', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/config/store.js', () => ({
  loadConfig: vi.fn(),
}));

vi.mock('../../src/cloud/supabase/client.js', () => ({
  getSupabaseJwtClient: vi.fn(() => ({})),
  getSupabaseClient: vi.fn(() => ({})),
}));

vi.mock('../../src/cloud/supabase/members.js', () => ({
  listMemberProjects: vi.fn(),
}));

vi.mock('../../src/cloud/supabase/personal-drafts.js', () => ({
  fetchPersonalDrafts: vi.fn(),
  listActiveDrafts: vi.fn(),
  archiveDraft: vi.fn(),
  deleteDraft: vi.fn(),
  restoreDraft: vi.fn(),
  promoteDraftToProject: vi.fn(),
}));

vi.mock('../../src/hooks/telemetry.js', () => ({
  record: vi.fn(),
}));

import { triageCommand, restoreCommand } from '../../src/commands/personal-drafts.js';
import { loadConfig } from '../../src/config/store.js';
import {
  fetchPersonalDrafts,
  listActiveDrafts,
  archiveDraft,
  deleteDraft,
  restoreDraft,
  promoteDraftToProject,
} from '../../src/cloud/supabase/personal-drafts.js';
import { listMemberProjects } from '../../src/cloud/supabase/members.js';
import { record as recordTelemetry } from '../../src/hooks/telemetry.js';
import inquirerSelect from '@inquirer/select';

const baseConfig = {
  org_id: 'org-1',
  org_name: 'Org 1',
  member_id: 'member-1',
  api_key: 'tm_test',
  member_api_key: 'tm_member_test',
  author_name: 'tester',
  auth_mode: 'jwt' as const,
  supabase_url: 'https://test.supabase.co',
  supabase_service_role_key: 'svc',
  qdrant_url: 'https://test.qdrant.io',
  qdrant_api_key: 'q',
  configured_ides: [],
  created_at: new Date().toISOString(),
};

function expectExit(code: number, fn: () => Promise<unknown>) {
  return expect(fn).rejects.toThrowError(`process.exit:${code}`);
}

describe('personal-drafts commands', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    promptQueue.length = 0;
    vi.clearAllMocks();
    vi.mocked(loadConfig).mockResolvedValue(baseConfig as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  // ────────────────────────────────────────────────────────────────────
  // restoreCommand
  // ────────────────────────────────────────────────────────────────────

  describe('restoreCommand', () => {
    it('happy path: flips archived → active, records telemetry', async () => {
      vi.mocked(restoreDraft).mockResolvedValueOnce({
        id: 'draft-42',
        status: 'active',
      });

      await restoreCommand('draft-42');

      expect(restoreDraft).toHaveBeenCalledWith(expect.anything(), 'draft-42');
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_restored',
        expect.objectContaining({
          org_id: 'org-1',
          metadata: { decision_id: 'draft-42' },
        }),
      );
    });

    it('exit-2 when no archived row matches (RLS-hidden or not archived)', async () => {
      vi.mocked(restoreDraft).mockResolvedValueOnce(null);

      await expectExit(2, () => restoreCommand('draft-missing'));

      // Telemetry must NOT fire on the negative path.
      expect(recordTelemetry).not.toHaveBeenCalled();
    });

    it('exit-1 when called with empty id arg', async () => {
      await expectExit(1, () => restoreCommand(''));

      expect(restoreDraft).not.toHaveBeenCalled();
    });

    it('exit-1 when no member context (not logged in)', async () => {
      vi.mocked(loadConfig).mockResolvedValueOnce(null);

      await expectExit(1, () => restoreCommand('any'));
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // triageCommand
  // ────────────────────────────────────────────────────────────────────

  describe('triageCommand', () => {
    const mkDraft = (i: number, overrides: Partial<{ summary: string; text: string }> = {}) => ({
      id: `draft-${i}`,
      type: 'decision',
      summary: overrides.summary ?? `Summary ${i}`,
      text: overrides.text ?? `Text body ${i}`,
      created_at: new Date(2026, 4, i).toISOString(),
    });

    it('returns early with friendly message when no personal-drafts project exists', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce(null);

      await triageCommand();

      expect(listActiveDrafts).not.toHaveBeenCalled();
      expect(archiveDraft).not.toHaveBeenCalled();
      expect(recordTelemetry).not.toHaveBeenCalled();
    });

    it('returns early with success when project exists but has zero active drafts', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([]);

      await triageCommand();

      // Picker source query is short-circuited when there's nothing to triage.
      expect(listMemberProjects).not.toHaveBeenCalled();
      expect(recordTelemetry).not.toHaveBeenCalled();
    });

    it('archive flow: A on every entry archives all and records final counts', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([mkDraft(1), mkDraft(2)] as never);
      vi.mocked(listMemberProjects).mockResolvedValueOnce([]);

      promptQueue.push('a', 'a');

      await triageCommand();

      expect(archiveDraft).toHaveBeenCalledTimes(2);
      expect(archiveDraft).toHaveBeenNthCalledWith(1, expect.anything(), 'draft-1');
      expect(archiveDraft).toHaveBeenNthCalledWith(2, expect.anything(), 'draft-2');
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_triaged',
        expect.objectContaining({
          metadata: expect.objectContaining({ archived: 2, bound: 0, deleted: 0, skipped: 0 }),
        }),
      );
    });

    it('delete flow: D + y confirmation calls deleteDraft; D + n re-prompts without deleting', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([mkDraft(1), mkDraft(2)] as never);
      vi.mocked(listMemberProjects).mockResolvedValueOnce([]);

      // draft-1: D then 'n' (cancel) → re-prompt → 's' (skip)
      // draft-2: D then 'y' (confirm) → delete
      promptQueue.push('d', 'n', 's', 'd', 'y');

      await triageCommand();

      expect(deleteDraft).toHaveBeenCalledTimes(1);
      expect(deleteDraft).toHaveBeenCalledWith(expect.anything(), 'draft-2');
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_triaged',
        expect.objectContaining({
          metadata: expect.objectContaining({ deleted: 1, skipped: 1 }),
        }),
      );
    });

    it('bind flow: B selects a target project via the picker and calls promoteDraftToProject', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([mkDraft(1)] as never);
      vi.mocked(listMemberProjects).mockResolvedValueOnce([
        // The personal-drafts row itself is included in the list returned by
        // listMemberProjects; the command must filter it out before showing
        // the picker. We include it here as a regression guard.
        {
          id: 'pd-1',
          name: 'Personal Drafts',
          decision_count: 7,
        } as never,
        {
          id: 'team-frontend',
          name: 'frontend',
          decision_count: 42,
        } as never,
      ]);
      vi.mocked(inquirerSelect).mockResolvedValueOnce('team-frontend' as never);

      promptQueue.push('b');

      await triageCommand();

      expect(promoteDraftToProject).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          decisionId: 'draft-1',
          sourcePersonalDraftsProjectId: 'pd-1',
          targetProjectId: 'team-frontend',
          targetProjectName: 'frontend',
          actingMemberId: 'member-1',
          orgId: 'org-1',
        }),
      );
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_triaged',
        expect.objectContaining({
          metadata: expect.objectContaining({ bound: 1 }),
        }),
      );
    });

    it('bind with no other projects: warns and re-prompts without calling promoter', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([mkDraft(1)] as never);
      // Only personal-drafts itself exists → filter leaves an empty pool.
      vi.mocked(listMemberProjects).mockResolvedValueOnce([
        { id: 'pd-1', name: 'Personal Drafts', decision_count: 0 } as never,
      ]);

      promptQueue.push('b', 's'); // bind fails, then skip

      await triageCommand();

      expect(promoteDraftToProject).not.toHaveBeenCalled();
      expect(inquirerSelect).not.toHaveBeenCalled();
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_triaged',
        expect.objectContaining({
          metadata: expect.objectContaining({ bound: 0, skipped: 1 }),
        }),
      );
    });

    it('quit flow: Q stops mid-walk; later entries are untouched', async () => {
      vi.mocked(fetchPersonalDrafts).mockResolvedValueOnce({
        id: 'pd-1',
        org_id: 'org-1',
        owner_member_id: 'member-1',
        name: 'Personal Drafts',
        is_personal_drafts: true,
      } as never);
      vi.mocked(listActiveDrafts).mockResolvedValueOnce([
        mkDraft(1),
        mkDraft(2),
        mkDraft(3),
      ] as never);
      vi.mocked(listMemberProjects).mockResolvedValueOnce([]);

      promptQueue.push('a', 'q');

      await triageCommand();

      expect(archiveDraft).toHaveBeenCalledTimes(1);
      expect(archiveDraft).toHaveBeenCalledWith(expect.anything(), 'draft-1');
      // Bound: 0, archived: 1, deleted: 0, skipped: 0 — quit doesn't count
      // the remaining two as "skipped" (they were never offered).
      expect(recordTelemetry).toHaveBeenCalledWith(
        'personal_drafts_triaged',
        expect.objectContaining({
          metadata: expect.objectContaining({ archived: 1, skipped: 0 }),
        }),
      );
    });
  });
});
