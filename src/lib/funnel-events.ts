/**
 * Funnel event taxonomy — shared by CLI (this package) and web
 * (`packages/web/src/lib/analytics/posthog-server.ts` re-imports the union).
 *
 * Single source of truth so CLI emits and server-side `capture()` calls can
 * never drift. Each event maps to a distinct funnel stage; events on this
 * list are mirrored from CLI → server → PostHog automatically (the bridge
 * in `packages/web/src/lib/adoption-metrics.ts` matches against this list).
 *
 * Events outside this list (e.g. 023 adoption-metrics like
 * `session_started_with_context`) stay in their respective pipelines and
 * are not mirrored.
 */

export const FUNNEL_EVENT_TYPES = [
  /** First CLI run after `npm i -g @valis/cli` — fired before any project work. */
  'install',
  /** Successful `valis init` completion (project created, decisions seeded). */
  'init_completed',
  /** First `valis_store`-stored decision in a fresh project. */
  'first_decision_captured',
  /** First CI `valis check` run that returned at least one block-severity violation. */
  'first_decision_enforced',
  /** Member invited to a project via the dashboard (Resend send). */
  'team_invited',
  /** Second human member joined an org (the team-collaboration threshold). */
  'second_user_joined',
  /** Stripe webhook upgrade from free → paid plan. */
  'paid_upgrade',
  /** Stripe webhook downgrade/cancel from paid → free. */
  'churned',
  /** One privacy-safe event per resolved `valis_consult_agent` call (agent_slug + count only). */
  'agent_consulted',
] as const;

export type FunnelEventName = (typeof FUNNEL_EVENT_TYPES)[number];

export function isFunnelEvent(name: string): name is FunnelEventName {
  return (FUNNEL_EVENT_TYPES as readonly string[]).includes(name);
}
