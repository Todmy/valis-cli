/**
 * 019/US6 (T057) — Constitution template validation.
 *
 * Per contracts/templates.md: every template JSON MUST satisfy schema rules.
 * Runs on every CI build and fails noisily if a template drifts.
 */

import { describe, it, expect } from 'vitest';
import { TEMPLATES, listTemplates, planSatisfies, templateSourceTag } from '../../src/templates/index.js';

const ID_REGEX = /^[a-z][a-z0-9-]*$/;
const SEMVER_REGEX = /^v?[0-9]+\.[0-9]+$/;
const VALID_TYPES = new Set(['decision', 'constraint', 'pattern', 'lesson']);
const VALID_PLANS = new Set(['free', 'pro', 'team']);

describe('Constitution templates — schema invariants', () => {
  for (const [filenameKey, template] of Object.entries(TEMPLATES)) {
    describe(`template ${filenameKey}`, () => {
      it('id matches regex and equals filename minus .json', () => {
        expect(template.id).toMatch(ID_REGEX);
        expect(template.id).toBe(filenameKey);
      });

      it('version matches semver shape', () => {
        expect(template.version).toMatch(SEMVER_REGEX);
      });

      it('decision_count equals decisions.length', () => {
        expect(template.decisions.length).toBe(template.decision_count);
      });

      it('min_plan is one of free | pro | team', () => {
        expect(VALID_PLANS.has(template.min_plan)).toBe(true);
      });

      it('every decision has summary ≤ 200 chars', () => {
        for (const d of template.decisions) {
          expect(d.summary.length).toBeGreaterThan(0);
          expect(d.summary.length).toBeLessThanOrEqual(200);
        }
      });

      it('every decision has rationale ≤ 2000 chars', () => {
        for (const d of template.decisions) {
          expect(d.rationale.length).toBeGreaterThan(0);
          expect(d.rationale.length).toBeLessThanOrEqual(2000);
        }
      });

      it('every decision type is in the allow-list', () => {
        for (const d of template.decisions) {
          expect(VALID_TYPES.has(d.type)).toBe(true);
        }
      });

      it('every decision has a non-empty affects array', () => {
        for (const d of template.decisions) {
          expect(Array.isArray(d.affects)).toBe(true);
          expect(d.affects.length).toBeGreaterThan(0);
          for (const a of d.affects) {
            expect(typeof a).toBe('string');
            expect(a.length).toBeGreaterThan(0);
          }
        }
      });

      it('tags is an array of strings (may be empty)', () => {
        for (const d of template.decisions) {
          expect(Array.isArray(d.tags)).toBe(true);
          for (const t of d.tags) {
            expect(typeof t).toBe('string');
          }
        }
      });

      it(`decision_count is in the documented range for ${filenameKey}`, () => {
        // Per contracts/templates.md "Three launch templates" — counts are pinned.
        const expected: Record<string, number> = {
          'ts-saas': 18,
          fintech: 22,
          'ai-agent': 15,
        };
        expect(template.decision_count).toBe(expected[template.id]);
      });
    });
  }
});

describe('listTemplates() shape', () => {
  it('returns one entry per registered template with the correct fields', () => {
    const list = listTemplates();
    expect(list.length).toBe(Object.keys(TEMPLATES).length);
    for (const item of list) {
      expect(item).toMatchObject({
        id: expect.any(String),
        version: expect.any(String),
        name: expect.any(String),
        tagline: expect.any(String),
        description: expect.any(String),
        decision_count: expect.any(Number),
        min_plan: expect.stringMatching(/^(free|pro|team)$/),
      });
    }
  });
});

describe('planSatisfies()', () => {
  it('free plan satisfies free template', () => {
    expect(planSatisfies('free', 'free')).toBe(true);
  });
  it('free plan does NOT satisfy pro template', () => {
    expect(planSatisfies('free', 'pro')).toBe(false);
  });
  it('team plan satisfies pro template', () => {
    expect(planSatisfies('team', 'pro')).toBe(true);
  });
  it('enterprise plan satisfies all', () => {
    expect(planSatisfies('enterprise', 'free')).toBe(true);
    expect(planSatisfies('enterprise', 'pro')).toBe(true);
    expect(planSatisfies('enterprise', 'team')).toBe(true);
  });
  it('unknown plan name fails closed', () => {
    expect(planSatisfies('mystery', 'free')).toBe(false);
  });
});

describe('templateSourceTag()', () => {
  it('formats as <id>@v<version> per data-model §8', () => {
    expect(templateSourceTag(TEMPLATES['ts-saas'])).toBe('ts-saas@v0.1');
    expect(templateSourceTag(TEMPLATES.fintech)).toBe('fintech@v0.1');
    expect(templateSourceTag(TEMPLATES['ai-agent'])).toBe('ai-agent@v0.1');
  });
});
