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
} as const satisfies Record<string, TeamindError>;

export function formatError(error: TeamindError): string {
  return `Error: ${error.what}\n\nWhy: ${error.why}\n\nFix: ${error.fix}`;
}
