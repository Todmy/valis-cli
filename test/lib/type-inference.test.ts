import { describe, it, expect } from 'vitest';
import { inferType, deriveSummary } from '../../src/lib/type-inference.js';

/**
 * SC-005: 30 real-shape fixtures; the heuristic must match the expected
 * type on ≥80% of them. Per FR-004 the classifier is keyword-based; we
 * accept that some genuine-but-unusually-phrased entries fall through to
 * the `lesson` default. The 80% bar is a real-world floor, not a
 * perfection bar.
 */

interface Fixture {
  id: string;
  detail: string;
  summary?: string;
  expected: 'decision' | 'constraint' | 'pattern' | 'lesson';
}

const FIXTURES: Fixture[] = [
  // ---- decision (10) ----
  { id: 'd1', detail: 'We chose PostgreSQL because of MVCC support', expected: 'decision' },
  { id: 'd2', detail: 'Decided to go with Vercel Fluid Compute instead of Lambda', expected: 'decision' },
  { id: 'd3', detail: 'Picked @inquirer/select for wizard prompts since it is already in deps', expected: 'decision' },
  { id: 'd4', detail: 'Going with Tailwind v4 for the new dashboard surface', expected: 'decision' },
  { id: 'd5', detail: 'Will use service-role key on the server only — never ship to client', expected: 'decision' },
  { id: 'd6', detail: 'Switched from Drizzle to plain SQL files for better Supabase compat', expected: 'decision' },
  { id: 'd7', detail: 'Selected Resend for transactional email after evaluating SendGrid and Postmark', expected: 'decision' },
  { id: 'd8', detail: 'Chose to skip the LLM-backed classifier in v1; ship keyword heuristic first', expected: 'decision' },
  { id: 'd9', detail: 'Using @supabase/ssr instead of legacy auth-helpers for the App Router', expected: 'decision' },
  { id: 'd10', detail: 'We went with a single monorepo over split repos to share types', expected: 'decision' },

  // ---- constraint (8) ----
  { id: 'c1', detail: 'Client requires Safari 15 support per the contract', expected: 'constraint' },
  { id: 'c2', detail: 'Must comply with GDPR data-export-on-request within 30 days', expected: 'constraint' },
  { id: 'c3', detail: 'Cannot ship before the 2026-Q3 marketing launch — hard deadline', expected: 'constraint' },
  { id: 'c4', detail: 'Stripe is rate-limited at 100/sec per account in test mode', expected: 'constraint' },
  { id: 'c5', detail: 'Legal flagged session-token-in-localStorage; must move to httpOnly cookie', expected: 'constraint' },
  { id: 'c6', detail: 'Blocked by upstream Vercel quota until the Pro plan upgrade lands', expected: 'constraint' },
  { id: 'c7', detail: 'SLA: 99.5% uptime for the team-dashboard endpoint', expected: 'constraint' },
  { id: 'c8', detail: 'Client requested no third-party analytics on the public marketing site', expected: 'constraint' },

  // ---- pattern (7) ----
  { id: 'p1', detail: 'When writing async iterators always finalize with try/finally', expected: 'pattern' },
  { id: 'p2', detail: 'Convention: every MCP tool handler returns a JSON-serializable object', expected: 'pattern' },
  { id: 'p3', detail: 'Whenever we add a new migration, bump the agent-context-update script run', expected: 'pattern' },
  { id: 'p4', detail: 'Pattern: factor effect handlers into pure functions then wire in the command file', expected: 'pattern' },
  { id: 'p5', detail: 'Prefer pnpm filter --filter valis-cli over cd packages/cli && pnpm', expected: 'pattern' },
  { id: 'p6', detail: 'When using sed -i on macOS always pass the empty string after -i for BSD compat', expected: 'pattern' },
  { id: 'p7', detail: 'All of these MCP tools must respect the project_scope_required contract', expected: 'pattern' },

  // ---- lesson (5) — default catch-all ----
  { id: 'l1', detail: 'Found that the third-party API rate-limits at 50/min not the documented 60', expected: 'lesson' },
  { id: 'l2', detail: 'Turned out the test corpus had three duplicate fixtures — dedup before scoring', expected: 'lesson' },
  { id: 'l3', detail: 'The Supabase edge runtime swallows top-level await rejections silently', expected: 'lesson' },
  { id: 'l4', detail: 'Forgot that auth.jwt() returns null when no JWT — handle the null case explicitly', expected: 'lesson' },
  { id: 'l5', detail: 'Realized: cache TTL of 5 min is the wrong order of magnitude for our access pattern', expected: 'lesson' },
];

describe('inferType', () => {
  it('has 30 fixtures', () => {
    expect(FIXTURES).toHaveLength(30);
  });

  // SC-005 contract: aggregate ≥80% accuracy on the 30-fixture corpus.
  // Per-fixture strictness is over-specification — real captures contain
  // ambiguous keywords (e.g. "access pattern" in a lesson, "must" used
  // imperatively in a pattern statement). The classifier is keyword-based
  // (FR-004 / Principle IV); known false-positives are acceptable when the
  // aggregate bar is met. Failing fixtures are flagged below for visibility
  // but do not fail the build.
  it('meets the ≥80% accuracy floor (SC-005)', () => {
    let hits = 0;
    const misses: string[] = [];
    for (const f of FIXTURES) {
      const r = inferType(f.summary ?? '', f.detail);
      if (r.type === f.expected) hits += 1;
      else misses.push(`${f.id}: expected=${f.expected} got=${r.type}`);
    }
    const accuracy = hits / FIXTURES.length;
    if (misses.length > 0) {
      // Visible in test output; informational, not assertion-failing.
      // eslint-disable-next-line no-console
      console.log(
        `[type-inference] accuracy=${(accuracy * 100).toFixed(1)}% (${hits}/${FIXTURES.length}); known misses:\n  - ${misses.join('\n  - ')}`,
      );
    }
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });

  // Smoke samples — one canonical case per type. These MUST pass; they
  // exercise the core regex tiers and guard against accidental classifier
  // regressions.
  it('classifies a canonical decision', () => {
    expect(inferType('', 'We chose PostgreSQL because of MVCC').type).toBe('decision');
  });

  it('classifies a canonical constraint', () => {
    expect(inferType('', 'Client requires Safari 15 support').type).toBe('constraint');
  });

  it('classifies a canonical pattern', () => {
    expect(inferType('', 'Convention: every handler returns JSON').type).toBe('pattern');
  });

  it('falls through to lesson when nothing matches', () => {
    expect(inferType('', 'The API returns 50/min not 60').type).toBe('lesson');
  });

  it('marks matched=true for non-default tiers', () => {
    const decision = inferType('', 'We chose A because B');
    expect(decision.matched).toBe(true);

    const constraint = inferType('', 'Client requires X');
    expect(constraint.matched).toBe(true);

    const pattern = inferType('', 'Pattern: always X');
    expect(pattern.matched).toBe(true);
  });

  it('marks matched=false for default lesson fallback', () => {
    const r = inferType('', 'A random observation about something');
    expect(r.type).toBe('lesson');
    expect(r.matched).toBe(false);
  });

  it('handles empty inputs without throwing', () => {
    expect(inferType('', '').type).toBe('lesson');
    expect(inferType('summary only', '').type).toBe('lesson');
  });

  it('uses both summary and detail for inference', () => {
    const r = inferType('We chose PostgreSQL', '');
    expect(r.type).toBe('decision');
  });
});

describe('deriveSummary', () => {
  it('returns empty string for empty input', () => {
    expect(deriveSummary('')).toBe('');
  });

  it('returns full string when ≤100 chars', () => {
    expect(deriveSummary('short text')).toBe('short text');
  });

  it('truncates to 100 chars without ellipsis', () => {
    const long = 'a'.repeat(150);
    const result = deriveSummary(long);
    expect(result).toHaveLength(100);
    expect(result.endsWith('…')).toBe(false);
  });

  it('trims trailing whitespace after truncation', () => {
    const padded = 'word '.repeat(30); // produces 150 chars; truncated to 100 ends mid-token
    const result = deriveSummary(padded);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).not.toMatch(/\s$/);
  });
});
