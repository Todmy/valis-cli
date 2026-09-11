import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wakeUpHosted } from '../../src/commands/wake-up.js';
import type { ValisConfig } from '../../src/types.js';

vi.mock('../../src/auth/jwt.js', () => ({
  getToken: vi.fn().mockResolvedValue({ jwt: { token: 'jwt-token' } }),
}));

const config = {
  supabase_url: 'https://project.supabase.co',
  member_api_key: 'tmm_member',
  api_key: '',
} as ValisConfig;

describe('wakeUpHosted', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses the hosted context endpoint with bearer JWT and no Supabase apikey', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ decisions: [], violation_count: 0 }), { status: 200 }),
    );

    await wakeUpHosted(config, '00000000-0000-0000-0000-000000000001');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://valis.krukit.co/api/projects/00000000-0000-0000-0000-000000000001/context',
      { headers: { Authorization: 'Bearer jwt-token' } },
    );
    const [, options] = fetchMock.mock.calls[0]!;
    expect((options?.headers as Record<string, string>).apikey).toBeUndefined();
  });
});
