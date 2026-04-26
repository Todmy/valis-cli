import { loadConfig } from '../../config/store.js';
import { getSupabaseClient } from '../../cloud/supabase.js';
import type { ServerConfig, ValisConfig } from '../../types.js';
import {
  TEMPLATES,
  isTemplateId,
  planSatisfies,
  templateSourceTag,
  type ConstitutionTemplate,
  type TemplateId,
} from '../../templates/index.js';

const PLAN_DECISION_LIMITS: Record<string, number> = {
  free: 200,
  team: 1000,
  business: 10000,
  enterprise: Number.POSITIVE_INFINITY,
};

interface CreateProjectArgs {
  project_name: string;
  /** Optional org_id. Defaults to the authenticated member's org. */
  org_id?: string;
  /**
   * 019/US3: enforcement mode for new project.
   * Accepted: 'block' (default) | 'suggest'.
   * 'warn' is REJECTED — see contracts/api-projects.md.
   */
  enforcement_mode?: string;
  /**
   * 019/US6 (T088 + T095): optional template id to seed the project from.
   * Accepted values come from the in-package registry (`./templates/*.json`).
   * Plan-min gate: if the org's plan is below the template's `min_plan`,
   * returns `plan_too_low`. Decision-quota gate: if seeding would push the
   * org over its plan's decision limit, returns `plan_quota_exceeded`. Both
   * gates run BEFORE the project insert so we never leave a partially
   * seeded project behind.
   */
  template_id?: string;
}

interface CreateProjectResponse {
  project_id: string;
  project_name: string;
  role: string;
  invite_code?: string;
  enforcement_mode?: 'block' | 'suggest';
  template_source?: string | null;
  template_version?: string | null;
  decisions_seeded?: number;
  error?: string;
  message?: string;
}

/**
 * 019/US3: validate enforcement_mode at the MCP path.
 * Mirrors the route handler so dashboard, CLI, and MCP all share the same
 * acceptance set.
 */
function validateEnforcementModeArg(
  raw: string | undefined,
): { ok: true; value: 'block' | 'suggest' } | { ok: false; error: string; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: 'block' };
  }
  if (raw === 'warn') {
    return {
      ok: false,
      error: 'invalid_enforcement_mode',
      message:
        '`warn` is no longer accepted for new projects. Use `block` or `suggest`.',
    };
  }
  if (raw === 'block' || raw === 'suggest') {
    return { ok: true, value: raw };
  }
  return {
    ok: false,
    error: 'invalid_enforcement_mode',
    message: 'enforcement_mode must be one of: block, suggest.',
  };
}

/**
 * Generate a human-friendly invite code in format XXXX-XXXX.
 * Uses 32-char alphabet without ambiguous symbols (no 0/O, 1/I/L).
 * Matches the format produced by `packages/web/src/lib/api-keys.ts` so
 * invite codes generated via MCP are indistinguishable from route-generated ones.
 */
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = (len: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(len)))
      .map((b) => chars[b % chars.length])
      .join('');
  return `${part(4)}-${part(4)}`;
}

/**
 * Create a new project within the authenticated member's org and register
 * the member as `project_admin`.
 *
 * Written as a companion to `valis_list_projects` so slash commands such as
 * `/valis:init` can offer "create new project" without leaving the session.
 *
 * Note: this path uses the service-role supabase client and bypasses the
 * plan-limit enforcement that lives in `/api/create-project` route. For 017
 * MVP this is acceptable; 019 should extract a shared `createProjectCore`
 * used by both the route and this handler. See BACKLOG for tracking.
 */
export async function handleCreateProject(
  args: CreateProjectArgs,
  configOverride?: ServerConfig,
): Promise<CreateProjectResponse> {
  try {
    const config = (configOverride ?? (await loadConfig())) as
      | ServerConfig
      | ValisConfig
      | null;
    if (!config) {
      return { project_id: '', project_name: '', role: '', error: 'not_configured' };
    }

    const supabaseUrl = (config as ServerConfig).supabase_url
      ?? (config as ValisConfig).supabase_url;
    const serviceRoleKey = (config as ServerConfig).supabase_service_role_key
      ?? (config as ValisConfig).supabase_service_role_key;
    const memberId = (config as ServerConfig).member_id
      ?? (config as ValisConfig).member_id;
    const orgId = args.org_id
      || (config as ServerConfig).org_id
      || (config as ValisConfig).org_id;

    if (!supabaseUrl || !serviceRoleKey || !memberId || !orgId) {
      return { project_id: '', project_name: '', role: '', error: 'missing_credentials' };
    }

    const projectName = args.project_name.trim();
    if (projectName.length === 0) {
      return { project_id: '', project_name: '', role: '', error: 'project_name_required' };
    }
    if (projectName.length > 100) {
      return { project_id: '', project_name: '', role: '', error: 'project_name_too_long' };
    }

    // 019/US3: enforcement_mode validation BEFORE any insert.
    const modeCheck = validateEnforcementModeArg(args.enforcement_mode);
    if (!modeCheck.ok) {
      return {
        project_id: '',
        project_name: '',
        role: '',
        error: modeCheck.error,
        message: modeCheck.message,
      };
    }
    const effectiveEnforcementMode = modeCheck.value;

    // 019/US6 (T088): template_id validation.
    let chosenTemplate: ConstitutionTemplate | null = null;
    if (args.template_id !== undefined && args.template_id !== null) {
      if (!isTemplateId(args.template_id)) {
        return {
          project_id: '',
          project_name: '',
          role: '',
          error: 'unknown_template',
          message: `Unknown template_id. Available: ${Object.keys(TEMPLATES).join(', ')}.`,
        };
      }
      chosenTemplate = TEMPLATES[args.template_id as TemplateId];
    }

    const supabase = getSupabaseClient(supabaseUrl, serviceRoleKey);

    // 019/US6 (T088): plan-min + decision-quota gates BEFORE any project
    // insert, mirroring /api/create-project. Without these, plugin users
    // could silently bypass the upsell that the dashboard picker enforces.
    if (chosenTemplate) {
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('plan')
        .eq('org_id', orgId)
        .eq('status', 'active')
        .limit(1)
        .single();
      const plan = (subscription?.plan as string | undefined) ?? 'free';

      if (!planSatisfies(plan, chosenTemplate.min_plan)) {
        return {
          project_id: '',
          project_name: '',
          role: '',
          error: 'plan_too_low',
          message: `The '${chosenTemplate.id}' template requires the '${chosenTemplate.min_plan}' plan or higher. Current plan: ${plan}.`,
        };
      }

      const decisionLimit = PLAN_DECISION_LIMITS[plan] ?? 200;
      const { count: currentDecisions } = await supabase
        .from('decisions')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      const usage = currentDecisions ?? 0;
      const projectedUsage = usage + chosenTemplate.decision_count;
      if (projectedUsage > decisionLimit) {
        return {
          project_id: '',
          project_name: '',
          role: '',
          error: 'plan_quota_exceeded',
          message: `This template has ${chosenTemplate.decision_count} decisions. Plan limit ${decisionLimit}, used ${usage}. Upgrade to seed.`,
        };
      }
    }

    const inviteCode = generateInviteCode();
    const templateSource = chosenTemplate ? templateSourceTag(chosenTemplate) : null;
    const templateVersion = chosenTemplate ? chosenTemplate.version : null;

    // 1. Create the project row. `invite_code` is NOT NULL in schema;
    // omitting it triggers a constraint violation (discovered 2026-04-16).
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({
        org_id: orgId,
        name: projectName,
        invite_code: inviteCode,
        enforcement_mode: effectiveEnforcementMode,
        template_source: templateSource,
        template_version: templateVersion,
      })
      .select('id, name, invite_code, enforcement_mode')
      .single();

    if (projectError || !project) {
      return {
        project_id: '',
        project_name: '',
        role: '',
        error: projectError?.message || 'project_insert_failed',
      };
    }

    // 2. Add caller as project_admin
    const { error: memberError } = await supabase
      .from('project_members')
      .insert({
        project_id: project.id,
        member_id: memberId,
        role: 'project_admin',
      });

    if (memberError) {
      // Roll back the orphan project row so we don't leak state on failure.
      await supabase.from('projects').delete().eq('id', project.id);
      return {
        project_id: '',
        project_name: '',
        role: '',
        error: memberError.message,
      };
    }

    // 3. (019/US6) Seed template decisions atomically. Schema columns must
    // match migrations 001 + 011 + 012:
    //   - `author` (TEXT NOT NULL) — we use 'valis-mcp' as the author tag
    //     because the MCP path doesn't carry a human author name reliably.
    //     The route uses `auth.authorName` which we don't have here.
    //   - `source` ('mcp_store'|'file_watcher'|'stop_hook'|'seed') — 'seed'
    //   - `content_hash` (TEXT NOT NULL) — sha256(type|summary|detail)
    //   - `confidence` (REAL 0.0-1.0) — 0.5 (medium) for seeded rows
    let decisionsSeeded = 0;
    if (chosenTemplate) {
      const encoder = new TextEncoder();
      const seedRows = await Promise.all(
        chosenTemplate.decisions.map(async (d) => {
          const normalized = `${d.type}\n${d.summary}\n${d.rationale}`;
          const hashBuffer = await crypto.subtle.digest(
            'SHA-256',
            encoder.encode(normalized),
          );
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const content_hash = hashArray
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
          return {
            id: crypto.randomUUID(),
            org_id: orgId,
            project_id: project.id,
            author: 'valis-mcp',
            source: 'seed' as const,
            content_hash,
            type: d.type,
            summary: d.summary,
            detail: d.rationale,
            affects: d.affects,
            status: 'active' as const,
            confidence: 0.5,
          };
        }),
      );
      const { error: seedError } = await supabase.from('decisions').insert(seedRows);
      if (seedError) {
        // Roll back: project_members + project so the user isn't stuck with
        // a half-seeded project that misrepresents its `decision_count`.
        await supabase.from('project_members').delete().eq('project_id', project.id);
        await supabase.from('projects').delete().eq('id', project.id);
        return {
          project_id: '',
          project_name: '',
          role: '',
          error: 'seed_failed',
          message: seedError.message,
        };
      }
      decisionsSeeded = seedRows.length;
    }

    return {
      project_id: project.id,
      project_name: project.name,
      role: 'project_admin',
      invite_code: project.invite_code,
      enforcement_mode:
        (project.enforcement_mode as 'block' | 'suggest') ?? effectiveEnforcementMode,
      template_source: templateSource,
      template_version: templateVersion,
      decisions_seeded: decisionsSeeded,
    };
  } catch (err) {
    return {
      project_id: '',
      project_name: '',
      role: '',
      error: err instanceof Error ? err.message : 'create_project_failed',
    };
  }
}
