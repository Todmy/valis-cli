import { ERRORS, formatError } from '../errors.js';
import type { JoinPublicResponse, RegistrationResponse } from '../types.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import { resolveApiUrl, resolveApiPath } from './api-url.js';

// ---------------------------------------------------------------------------
// Public registration API base URL
// ---------------------------------------------------------------------------

/**
 * Resolve the Supabase URL used for calling public Edge Functions.
 * In hosted mode this comes from the types module constants;
 * callers may also pass an explicit URL for community/testing setups.
 */
function resolveBaseUrl(supabaseUrl?: string): string {
  if (supabaseUrl) return supabaseUrl.replace(/\/$/, '');
  // Fallback: use environment variable if present
  return (process.env.TEAMIND_REGISTRATION_URL ?? '').replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// register — POST /functions/v1/register  (US1)
// ---------------------------------------------------------------------------

/**
 * Register a new organization + project + member via the public registration
 * endpoint.  No credentials are required — the endpoint is rate-limited by IP.
 */
export async function register(
  orgName: string,
  projectName: string,
  authorName: string,
  supabaseUrl?: string,
): Promise<RegistrationResponse> {
  const base = resolveBaseUrl(supabaseUrl);
  if (!base) {
    throw new Error(formatError(ERRORS.registration_service_unavailable));
  }

  const isHosted = base === HOSTED_SUPABASE_URL.replace(/\/$/, '');
  const apiBase = resolveApiUrl(base, isHosted);
  const registerUrl = resolveApiPath(apiBase, 'register');

  let response: Response;
  try {
    response = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        org_name: orgName,
        project_name: projectName,
        author_name: authorName,
      }),
    });
  } catch {
    throw new Error(formatError(ERRORS.registration_service_unavailable));
  }

  if (response.ok) {
    return response.json() as Promise<RegistrationResponse>;
  }

  // Map HTTP errors to user-friendly messages
  const body = await response.json().catch(() => ({ error: 'unknown' }));
  const code = (body as Record<string, string>).error;

  switch (response.status) {
    case 409:
      throw new Error(formatError(ERRORS.org_name_taken));
    case 429:
      throw new Error(formatError(ERRORS.rate_limit_exceeded));
    case 400:
      if (code === 'invalid_name') {
        const field = (body as Record<string, string>).field;
        throw new Error(
          formatError(field === 'project_name' ? ERRORS.invalid_project_name : ERRORS.invalid_org_name),
        );
      }
      // Generic validation
      throw new Error(
        formatError(
          code === 'org_name_required'
            ? ERRORS.invalid_org_name
            : code === 'project_name_required'
              ? ERRORS.invalid_project_name
              : ERRORS.registration_service_unavailable,
        ),
      );
    default:
      throw new Error(formatError(ERRORS.registration_service_unavailable));
  }
}

// ---------------------------------------------------------------------------
// joinPublic — POST /functions/v1/join-project  (US2)
// ---------------------------------------------------------------------------

/**
 * Join an existing project via a public invite code.
 * No credentials are required — the endpoint creates a member and returns
 * per-member credentials + public URLs so the CLI can be fully configured
 * from scratch.
 */
export async function joinPublic(
  inviteCode: string,
  authorName: string,
  supabaseUrl?: string,
): Promise<JoinPublicResponse> {
  const base = resolveBaseUrl(supabaseUrl);
  if (!base) {
    throw new Error(formatError(ERRORS.registration_service_unavailable));
  }

  const isHosted = base === HOSTED_SUPABASE_URL.replace(/\/$/, '');
  const apiBase = resolveApiUrl(base, isHosted);
  const joinUrl = resolveApiPath(apiBase, 'join-project');

  let response: Response;
  try {
    response = await fetch(joinUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invite_code: inviteCode,
        author_name: authorName,
      }),
    });
  } catch {
    throw new Error(formatError(ERRORS.registration_service_unavailable));
  }

  if (response.ok) {
    return response.json() as Promise<JoinPublicResponse>;
  }

  // Map HTTP errors to user-friendly messages
  const body = await response.json().catch(() => ({ error: 'unknown' }));
  const code = (body as Record<string, string>).error;

  switch (response.status) {
    case 404:
      throw new Error(formatError(ERRORS.invalid_invite_code_join));
    case 409:
      throw new Error(formatError(ERRORS.already_project_member));
    case 403:
      throw new Error(formatError(ERRORS.free_tier_limit));
    default:
      throw new Error(
        formatError(
          code === 'invite_code_required' || code === 'author_name_required'
            ? ERRORS.registration_service_unavailable
            : ERRORS.registration_service_unavailable,
        ),
      );
  }
}
