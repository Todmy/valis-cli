import { describe, it, expect, vi } from 'vitest';
import {
  ClusterRegistry,
  CLUSTER_SIMILARITY_THRESHOLD,
  MIN_SINGLETONS_FOR_CLUSTER,
} from '../../src/synthesis/cluster-registry.js';

// ---------------------------------------------------------------------------
// Qdrant mock
// ---------------------------------------------------------------------------

function createMockQdrant() {
  const payloads = new Map<string, Record<string, unknown>>();

  return {
    payloads,

    query: vi.fn().mockResolvedValue({ points: [] }),

    scroll: vi.fn().mockImplementation((_collection: string, opts: Record<string, unknown>) => {
      // Return points that match the filter from our payload store
      const filter = opts.filter as Record<string, unknown> | undefined;
      const points: Array<{ id: string; payload: Record<string, unknown> }> = [];

      for (const [id, payload] of payloads) {
        // Basic filter matching
        if (filter?.must) {
          const mustClauses = filter.must as Array<Record<string, unknown>>;
          let matches = true;

          for (const clause of mustClauses) {
            if (clause.key && clause.match) {
              const matchVal = (clause.match as Record<string, unknown>).value;
              if (payload[clause.key as string] !== matchVal) {
                matches = false;
                break;
              }
            }
          }

          // Check must_not
          if (matches && filter.must_not) {
            const mustNotClauses = filter.must_not as Array<Record<string, unknown>>;
            for (const clause of mustNotClauses) {
              if (clause.is_null) {
                const key = (clause.is_null as Record<string, unknown>).key as string;
                if (payload[key] === undefined || payload[key] === null) {
                  matches = false;
                  break;
                }
              }
            }
          }

          if (!matches) continue;
        }

        points.push({ id, payload });
      }

      return Promise.resolve({ points: points.slice(0, (opts.limit as number) || 100) });
    }),

    setPayload: vi.fn().mockImplementation((_collection: string, opts: Record<string, unknown>) => {
      const payload = opts.payload as Record<string, unknown>;
      const pointIds = opts.points as string[];
      for (const id of pointIds) {
        const existing = payloads.get(id) ?? {};
        payloads.set(id, { ...existing, ...payload });
      }
      return Promise.resolve();
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClusterRegistry', () => {
  const orgId = 'org-test-123';

  describe('constants', () => {
    it('has correct similarity threshold', () => {
      expect(CLUSTER_SIMILARITY_THRESHOLD).toBe(0.75);
    });

    it('requires 3 singletons to form a cluster', () => {
      expect(MIN_SINGLETONS_FOR_CLUSTER).toBe(3);
    });
  });

  describe('assignCluster', () => {
    it('returns null when no similar decisions exist', async () => {
      const mock = createMockQdrant();
      const registry = new ClusterRegistry(mock as never, orgId);

      const result = await registry.assignCluster('dec-1', 'Some decision text', ['auth']);
      expect(result).toBeNull();
    });

    it('assigns to existing cluster when best match is above threshold', async () => {
      const mock = createMockQdrant();

      // Pre-populate: a decision with a cluster
      mock.payloads.set('dec-existing', {
        org_id: orgId,
        cluster_id: 'cluster_existing',
        affects: ['auth', 'api'],
        type: 'decision',
        detail: 'Existing decision',
        summary: 'Existing',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });

      // Mock query to return a similar decision with cluster
      mock.query.mockResolvedValueOnce({
        points: [
          {
            id: 'dec-existing',
            score: 0.85,
            payload: {
              cluster_id: 'cluster_existing',
              affects: ['auth', 'api'],
              org_id: orgId,
            },
          },
        ],
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const result = await registry.assignCluster('dec-new', 'Auth API decision', ['auth', 'api']);

      // Should have set cluster_id on the new decision
      expect(mock.setPayload).toHaveBeenCalledWith('decisions', {
        payload: { cluster_id: 'cluster_existing' },
        points: ['dec-new'],
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe('cluster_existing');
    });

    it('creates new cluster when 3+ singletons are mutually similar', async () => {
      const mock = createMockQdrant();

      // Pre-populate singletons (no cluster_id)
      mock.payloads.set('dec-s1', {
        org_id: orgId,
        affects: ['auth'],
        type: 'decision',
        detail: 'Singleton 1',
        summary: 'S1',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });
      mock.payloads.set('dec-s2', {
        org_id: orgId,
        affects: ['auth'],
        type: 'decision',
        detail: 'Singleton 2',
        summary: 'S2',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });

      // Mock query: return 2 singletons above threshold
      mock.query.mockResolvedValueOnce({
        points: [
          {
            id: 'dec-s1',
            score: 0.82,
            payload: { cluster_id: null, affects: ['auth'], org_id: orgId },
          },
          {
            id: 'dec-s2',
            score: 0.78,
            payload: { cluster_id: null, affects: ['auth'], org_id: orgId },
          },
        ],
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const result = await registry.assignCluster('dec-new', 'Auth decision', ['auth']);

      expect(result).not.toBeNull();
      expect(result!.member_count).toBe(3);
      // All 3 decisions should have cluster_id set
      expect(mock.setPayload).toHaveBeenCalledTimes(3);
    });

    it('leaves as singleton when no match above threshold', async () => {
      const mock = createMockQdrant();

      mock.query.mockResolvedValueOnce({
        points: [
          {
            id: 'dec-unrelated',
            score: 0.45,
            payload: { cluster_id: null, affects: ['database'], org_id: orgId },
          },
        ],
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const result = await registry.assignCluster('dec-new', 'Auth decision', ['auth']);

      expect(result).toBeNull();
      expect(mock.setPayload).not.toHaveBeenCalled();
    });

    it('returns null gracefully when query search fails', async () => {
      const mock = createMockQdrant();
      mock.query.mockRejectedValueOnce(new Error('Qdrant unavailable'));

      const registry = new ClusterRegistry(mock as never, orgId);
      const result = await registry.assignCluster('dec-1', 'Test', ['test']);

      expect(result).toBeNull();
    });
  });

  describe('listClusters', () => {
    it('returns empty array when no clusters exist', async () => {
      const mock = createMockQdrant();
      const registry = new ClusterRegistry(mock as never, orgId);

      const clusters = await registry.listClusters();
      expect(clusters).toEqual([]);
    });

    it('groups decisions by cluster_id', async () => {
      const mock = createMockQdrant();

      // Populate with clustered decisions
      mock.payloads.set('dec-1', {
        org_id: orgId,
        cluster_id: 'cluster_a',
        affects: ['auth'],
      });
      mock.payloads.set('dec-2', {
        org_id: orgId,
        cluster_id: 'cluster_a',
        affects: ['auth', 'api'],
      });
      mock.payloads.set('dec-3', {
        org_id: orgId,
        cluster_id: 'cluster_b',
        affects: ['database'],
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const clusters = await registry.listClusters();

      expect(clusters).toHaveLength(2);

      // Sorted by member_count descending
      expect(clusters[0].id).toBe('cluster_a');
      expect(clusters[0].member_count).toBe(2);
      expect(clusters[0].affects).toContain('auth');
      expect(clusters[0].affects).toContain('api');

      expect(clusters[1].id).toBe('cluster_b');
      expect(clusters[1].member_count).toBe(1);
    });
  });

  describe('mergeClusters', () => {
    it('reassigns all B members to A', async () => {
      const mock = createMockQdrant();

      mock.payloads.set('dec-a1', {
        org_id: orgId,
        cluster_id: 'cluster_a',
        affects: ['auth'],
        type: 'decision',
        detail: 'A1',
        summary: 'A1',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });
      mock.payloads.set('dec-b1', {
        org_id: orgId,
        cluster_id: 'cluster_b',
        affects: ['api'],
        type: 'decision',
        detail: 'B1',
        summary: 'B1',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });
      mock.payloads.set('dec-b2', {
        org_id: orgId,
        cluster_id: 'cluster_b',
        affects: ['api'],
        type: 'decision',
        detail: 'B2',
        summary: 'B2',
        author: 'test',
        status: 'active',
        created_at: new Date().toISOString(),
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const merged = await registry.mergeClusters('cluster_a', 'cluster_b');

      // B members should now have cluster_a
      expect(mock.payloads.get('dec-b1')?.cluster_id).toBe('cluster_a');
      expect(mock.payloads.get('dec-b2')?.cluster_id).toBe('cluster_a');

      // Merged cluster should have all 3 members
      expect(merged.member_count).toBe(3);
      expect(merged.id).toBe('cluster_a');
    });
  });

  describe('getMembers', () => {
    it('returns decisions for a specific cluster', async () => {
      const mock = createMockQdrant();

      mock.payloads.set('dec-1', {
        org_id: orgId,
        cluster_id: 'cluster_x',
        affects: ['auth'],
        type: 'decision',
        detail: 'Decision 1',
        summary: 'D1',
        author: 'alice',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
      });
      mock.payloads.set('dec-2', {
        org_id: orgId,
        cluster_id: 'cluster_x',
        affects: ['auth', 'api'],
        type: 'constraint',
        detail: 'Decision 2',
        summary: 'D2',
        author: 'bob',
        status: 'active',
        created_at: '2026-01-02T00:00:00Z',
      });
      mock.payloads.set('dec-other', {
        org_id: orgId,
        cluster_id: 'cluster_y',
        affects: ['database'],
        type: 'decision',
        detail: 'Other',
        summary: 'Other',
        author: 'carol',
        status: 'active',
        created_at: '2026-01-03T00:00:00Z',
      });

      const registry = new ClusterRegistry(mock as never, orgId);
      const members = await registry.getMembers('cluster_x');

      expect(members).toHaveLength(2);
      expect(members.map((m) => m.id).sort()).toEqual(['dec-1', 'dec-2']);
      expect(members[0].author).toBeTruthy();
      expect(members[0].affects.length).toBeGreaterThan(0);
    });

    it('returns empty array for non-existent cluster', async () => {
      const mock = createMockQdrant();
      const registry = new ClusterRegistry(mock as never, orgId);

      const members = await registry.getMembers('cluster_nonexistent');
      expect(members).toEqual([]);
    });
  });
});
