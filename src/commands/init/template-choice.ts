/**
 * 024 — Constitution template choice for `valis init`.
 *
 * Deep module: one function (`chooseTemplate`) hides flag validation,
 * interactive picker rendering, and plan-gate UX behind a single
 * `Promise<TemplateChoice>` return. Callers in `cases.ts` stay thin —
 * one call near project-name input, one decision pass-through.
 *
 * `null` means "blank project, no template" (preserves legacy behavior).
 * Any non-null value is a typed `TemplateId` validated against the
 * registry at `../../templates/index.ts`.
 *
 * Invariants:
 *  - This module NEVER makes a network call. Validation, plan-gate
 *    decisions, and picker rendering are all local. Network seeding
 *    happens later via `createProject(..., templateId)`.
 *  - `--join` mutual-exclusion is enforced at `initCommand` entry,
 *    BEFORE this module is reached. Same for community-mode rejection.
 *  - Unknown flag values throw `ChooseTemplateError('unknown_template')`
 *    with exit code 2 — fail-fast before any side effect.
 */

import select from '@inquirer/select';
import pc from 'picocolors';
import {
  isTemplateId,
  listTemplates,
  planSatisfies,
  type TemplateId,
  type TemplateMinPlan,
} from '../../templates/index.js';

export type TemplateChoice = TemplateId | null;

export type OrgPlan = 'free' | 'pro' | 'team' | 'business' | 'enterprise';

export interface ChooseTemplateOptions {
  /** Raw value of `--template <name>` from commander; `undefined` if flag omitted. */
  flagValue: string | undefined;
  /** Org's billing plan; used to disable plan-gated picker rows. */
  orgPlan: OrgPlan;
  /** True when stdin is not a TTY (CI, agent harness, scripted install). */
  nonInteractive: boolean;
  /**
   * True when this invocation is creating a fresh project. False for
   * reconfigure / legacy-migration / join paths — in those flows the
   * caller MUST NOT invoke `chooseTemplate` (defense-in-depth: this
   * module throws if it is).
   */
  newProjectFlow: boolean;
}

export type ChooseTemplateErrorKind =
  | 'unknown_template'
  | 'flag_in_wrong_flow'
  | 'community_mode';

export class ChooseTemplateError extends Error {
  constructor(
    public readonly kind: ChooseTemplateErrorKind,
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = 'ChooseTemplateError';
  }
}

/**
 * Resolve the user's template intent into a `TemplateChoice`. See the
 * module header for invariants and the decision table in
 * `specs/024-constitution-templates/contracts/cli-init-template.md`.
 */
export async function chooseTemplate(opts: ChooseTemplateOptions): Promise<TemplateChoice> {
  // Defense in depth — dispatcher should never invoke us in a non-creating flow.
  if (!opts.newProjectFlow) {
    throw new ChooseTemplateError(
      'flag_in_wrong_flow',
      '`--template` is only used for new projects.',
      2,
    );
  }

  // Flag path — fail fast on unknown name, never touch the network.
  if (opts.flagValue !== undefined) {
    if (isTemplateId(opts.flagValue)) {
      return opts.flagValue;
    }
    const available = listTemplates().map((t) => t.id).join(', ');
    throw new ChooseTemplateError(
      'unknown_template',
      `Unknown template '${opts.flagValue}'. Available: ${available}.`,
      2,
    );
  }

  // Non-TTY default — preserve scriptable behavior (FR-008).
  if (opts.nonInteractive) {
    console.log(
      pc.dim('Tip: pass `--template ts-saas` to seed a starter constitution.'),
    );
    return null;
  }

  // Interactive picker (US2). Built from `listTemplates()` so any registry
  // change shows up here automatically — no second list of names.
  const templates = listTemplates();
  type Row = { name: string; value: TemplateChoice; description?: string; disabled?: boolean | string };
  const blankRow: Row = {
    name: pc.bold('Blank project') + pc.dim('  ·  start empty'),
    value: null,
    description: 'Start with no decisions; capture as you go.',
  };
  const templateRows: Row[] = templates.map((t) => {
    const ok = planSatisfies(opts.orgPlan, t.min_plan);
    const planBadge = formatPlanBadge(t.min_plan, ok);
    return {
      name: `${pc.bold(t.name)}  ·  ${t.decision_count} decisions  ·  ${planBadge}`,
      value: t.id as TemplateId,
      description: t.tagline,
      disabled: ok ? false : `requires '${t.min_plan}' plan or higher`,
    };
  });

  const choice = await select<TemplateChoice>({
    message: 'Start with a constitution template?',
    default: null,
    choices: [blankRow, ...templateRows],
  });
  return choice;
}

function formatPlanBadge(minPlan: TemplateMinPlan, satisfied: boolean): string {
  if (minPlan === 'free') return pc.dim('free');
  return satisfied
    ? pc.dim(`requires ${minPlan}`)
    : pc.yellow(`requires ${minPlan} plan`);
}
