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
} as const satisfies Record<string, TeamindError>;

export function formatError(error: TeamindError): string {
  return `Error: ${error.what}\n\nWhy: ${error.why}\n\nFix: ${error.fix}`;
}
