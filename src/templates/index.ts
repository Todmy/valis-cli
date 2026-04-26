/**
 * 019/US6 (T060) — Constitution template registry.
 *
 * Templates are version-pinned JSON assets in `./*.json`. The registry is a
 * typed lookup + listTemplates() for the picker UI. Per contracts/templates.md:
 *   - id MUST match filename minus .json
 *   - decision_count MUST equal decisions.length
 *   - validate.test.ts enforces schema across all templates on every CI build
 *
 * NEW templates require a code change + PR + review + version bump. See
 * spec.md FR-037 + visibility/enforcement clarification U2.
 */

import tsSaas from './ts-saas.json' with { type: 'json' };
import fintech from './fintech.json' with { type: 'json' };
import aiAgent from './ai-agent.json' with { type: 'json' };

export type TemplateMinPlan = 'free' | 'pro' | 'team';

export type TemplateDecisionType = 'decision' | 'constraint' | 'pattern' | 'lesson';

export interface TemplateDecision {
  summary: string;
  type: TemplateDecisionType;
  rationale: string;
  affects: string[];
  tags: string[];
}

export interface ConstitutionTemplate {
  id: string;
  version: string;
  name: string;
  tagline: string;
  description: string;
  min_plan: TemplateMinPlan;
  decision_count: number;
  decisions: TemplateDecision[];
}

export const TEMPLATES = {
  'ts-saas': tsSaas as ConstitutionTemplate,
  fintech: fintech as ConstitutionTemplate,
  'ai-agent': aiAgent as ConstitutionTemplate,
} as const;

export type TemplateId = keyof typeof TEMPLATES;

export function getTemplate(id: TemplateId): ConstitutionTemplate {
  return TEMPLATES[id];
}

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

export interface TemplateListItem {
  id: string;
  version: string;
  name: string;
  tagline: string;
  description: string;
  decision_count: number;
  min_plan: TemplateMinPlan;
}

export function listTemplates(): TemplateListItem[] {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    version: t.version,
    name: t.name,
    tagline: t.tagline,
    description: t.description,
    decision_count: t.decision_count,
    min_plan: t.min_plan,
  }));
}

/**
 * Plan ordering (lowest → highest) used for the `min_plan` gate in the
 * create-project route. Index in array == numerical rank.
 */
const PLAN_RANK: Record<TemplateMinPlan | 'business' | 'enterprise', number> = {
  free: 0,
  pro: 1,
  team: 2,
  business: 3,
  enterprise: 4,
};

export function planSatisfies(orgPlan: string, requiredPlan: TemplateMinPlan): boolean {
  const orgRank = PLAN_RANK[orgPlan as keyof typeof PLAN_RANK];
  const requiredRank = PLAN_RANK[requiredPlan];
  if (orgRank === undefined) return false;
  return orgRank >= requiredRank;
}

/**
 * Format `<id>@v<version>` per data-model §8 + contract.
 */
export function templateSourceTag(template: ConstitutionTemplate): string {
  return `${template.id}@v${template.version}`;
}
