export interface TeamindError {
  code: string;
  what: string;
  why: string;
  fix: string;
}

export const ERRORS = {
  cloud_unreachable: {
    code: 'cloud_unreachable',
    what: 'Cannot connect to Teamind cloud services',
    why: 'Supabase or Qdrant Cloud is unreachable. This may be a network issue or service outage.',
    fix: 'Check your internet connection. Run `teamind status` to see which service is down. Decisions will be queued locally and synced when connection is restored.',
  },
  org_not_found: {
    code: 'org_not_found',
    what: 'Organization not found',
    why: 'The configured organization ID does not exist or has been deleted.',
    fix: 'Run `teamind init` to create a new organization or `teamind init --join <invite-code>` to join an existing one.',
  },
  invite_invalid: {
    code: 'invite_invalid',
    what: 'Invalid invite code',
    why: 'The invite code does not match any active organization.',
    fix: 'Ask your team lead for the correct invite code. It should be in the format XXXX-XXXX.',
  },
  free_tier_limit: {
    code: 'free_tier_limit',
    what: 'Free tier limit reached',
    why: 'Your organization has reached the maximum number of members (3) or decisions (500) on the free plan.',
    fix: 'Upgrade to the Pro plan for up to 50 members and 10,000 decisions, or remove unused members.',
  },
  secret_detected: {
    code: 'secret_detected',
    what: 'Secret detected in decision text',
    why: 'The text contains what appears to be a secret (API key, password, token). Storing secrets in the team brain is a security risk.',
    fix: 'Remove the secret from the text and try again. If this is a false positive, rephrase the text to avoid the pattern.',
  },
  qdrant_unreachable: {
    code: 'qdrant_unreachable',
    what: 'Cannot connect to Qdrant Cloud',
    why: 'The Qdrant search service is unreachable. Search functionality is unavailable.',
    fix: 'Check your QDRANT_URL and QDRANT_API_KEY in config. Run `teamind status` for diagnostics.',
  },
  dual_write_partial: {
    code: 'dual_write_partial',
    what: 'Decision partially stored',
    why: 'The decision was written to one backend but failed on the other. Data will be eventually consistent.',
    fix: 'The system will automatically retry the failed write. Run `teamind status` to check sync status.',
  },

  // Phase 3: Search Intelligence, Data Quality & Growth
  plan_limit_reached: {
    code: 'plan_limit_reached',
    what: 'Plan limit reached',
    why: 'Your organization has exceeded the allowed usage for your current plan.',
    fix: 'Run `teamind upgrade` to upgrade your plan, or wait for the next billing period.',
  },
  enrichment_disabled: {
    code: 'enrichment_disabled',
    what: 'LLM enrichment is not available',
    why: 'No LLM provider API key is configured. Enrichment requires an Anthropic or OpenAI API key.',
    fix: 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment, then run `teamind enrich` again.',
  },
  enrichment_ceiling_reached: {
    code: 'enrichment_ceiling_reached',
    what: 'Daily enrichment cost ceiling reached',
    why: 'The configured daily cost ceiling for LLM enrichment has been reached. No further enrichments will run today.',
    fix: 'Wait until tomorrow for the ceiling to reset, or increase the ceiling with `teamind enrich --ceiling <dollars>`.',
  },
  enrichment_provider_error: {
    code: 'enrichment_provider_error',
    what: 'LLM provider returned an error',
    why: 'The LLM provider (Anthropic or OpenAI) returned an error during enrichment. The decision was not enriched.',
    fix: 'Check your API key validity and provider status. Run `teamind enrich` again to retry failed decisions.',
  },
  subscription_past_due: {
    code: 'subscription_past_due',
    what: 'Subscription payment past due',
    why: 'Your subscription payment has failed. You have a 7-day grace period before downgrade to free tier limits.',
    fix: 'Update your payment method at your Stripe billing portal, or run `teamind upgrade` to re-enter billing.',
  },
  search_rerank_failed: {
    code: 'search_rerank_failed',
    what: 'Search reranking failed',
    why: 'The multi-signal reranker encountered an error. Falling back to raw semantic similarity scores.',
    fix: 'This is a transient error. Search results may be less accurate. Retry your search.',
  },
  cleanup_protected_decision: {
    code: 'cleanup_protected_decision',
    what: 'Decision is protected from cleanup',
    why: 'The decision is pinned or has inbound dependencies. It cannot be auto-deprecated by cleanup.',
    fix: 'Unpin the decision or remove its dependents first, then re-run cleanup.',
  },
  synthesis_no_patterns: {
    code: 'synthesis_no_patterns',
    what: 'No patterns detected',
    why: 'The synthesis algorithm did not find enough clustered decisions to form a pattern (minimum 3 decisions with shared areas).',
    fix: 'This is informational. Patterns emerge naturally as more decisions are stored with overlapping affects areas.',
  },
  // Phase 4: Multi-Project Support
  no_project_configured: {
    code: 'no_project_configured',
    what: 'No project configured for this directory',
    why: 'This command requires a project context but no .teamind.json was found in this directory or any parent.',
    fix: 'Run `teamind init` in your project directory to create or select a project, or `teamind init --join <invite-code>` to join one.',
  },
  project_not_found: {
    code: 'project_not_found',
    what: 'Project not found',
    why: 'The specified project ID or name does not exist in your organization.',
    fix: 'Run `teamind switch` to see available projects, or `teamind init` to create a new one.',
  },
  no_project_access: {
    code: 'no_project_access',
    what: 'No access to this project',
    why: 'You are not a member of the requested project and do not have org admin privileges.',
    fix: 'Ask a project admin to invite you using the project invite code, or run `teamind init --join <invite-code>`.',
  },
  wrong_project: {
    code: 'wrong_project',
    what: 'Decision belongs to a different project',
    why: 'The target decision belongs to a project that does not match your current project context.',
    fix: 'Switch to the correct project with `teamind switch --project <name>` or `cd` to the directory configured for that project.',
  },
  project_name_exists: {
    code: 'project_name_exists',
    what: 'Project name already exists',
    why: 'A project with this name already exists in your organization. Project names must be unique within an org.',
    fix: 'Choose a different project name.',
  },
  project_name_required: {
    code: 'project_name_required',
    what: 'Project name is required',
    why: 'A project name must be provided to create a new project.',
    fix: 'Provide a project name (1-100 characters).',
  },
  project_name_too_long: {
    code: 'project_name_too_long',
    what: 'Project name is too long',
    why: 'Project names must be between 1 and 100 characters.',
    fix: 'Shorten the project name to 100 characters or fewer.',
  },
  already_project_member: {
    code: 'already_project_member',
    what: 'Already a member of this project',
    why: 'You are already a member of the project associated with this invite code.',
    fix: 'No action needed. Run `teamind status` to see your current project.',
  },
  invalid_project_config: {
    code: 'invalid_project_config',
    what: 'Invalid project configuration',
    why: 'The .teamind.json file in this directory is malformed or contains invalid data.',
    fix: 'Delete the .teamind.json file and run `teamind init` to recreate it, or fix the JSON manually.',
  },

  // Phase 5: Registration API
  registration_service_unavailable: {
    code: 'registration_service_unavailable',
    what: 'Registration service is unavailable',
    why: 'The hosted registration endpoint is unreachable. This may be a network issue or service outage.',
    fix: 'Check your internet connection and try again. If the problem persists, visit the Teamind status page.',
  },
  rate_limit_exceeded: {
    code: 'rate_limit_exceeded',
    what: 'Registration rate limit exceeded',
    why: 'Too many registration attempts from your IP address. The limit is 10 registrations per hour.',
    fix: 'Wait an hour before trying again, or contact support if you need more registrations.',
  },
  org_name_taken: {
    code: 'org_name_taken',
    what: 'Organization name is already taken',
    why: 'Another organization is already using this name. Organization names must be globally unique.',
    fix: 'Choose a different organization name and try again.',
  },
  invalid_org_name: {
    code: 'invalid_org_name',
    what: 'Invalid organization name',
    why: 'Organization names must be 1-100 characters and may contain letters, numbers, spaces, and hyphens.',
    fix: 'Choose a name using only letters, numbers, spaces, and hyphens (1-100 characters).',
  },
  invalid_project_name: {
    code: 'invalid_project_name',
    what: 'Invalid project name',
    why: 'Project names must be 1-100 characters and may contain letters, numbers, spaces, and hyphens.',
    fix: 'Choose a name using only letters, numbers, spaces, and hyphens (1-100 characters).',
  },
  invalid_invite_code_join: {
    code: 'invalid_invite_code_join',
    what: 'Invalid invite code',
    why: 'The invite code does not match any active project. It may have expired or been entered incorrectly.',
    fix: 'Ask your team lead for the correct invite code. It should be in the format XXXX-XXXX.',
  },
} as const satisfies Record<string, TeamindError>;

export function formatError(error: TeamindError): string {
  return `Error: ${error.what}\n\nWhy: ${error.why}\n\nFix: ${error.fix}`;
}
