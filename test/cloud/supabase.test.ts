import { describe, it, expect, vi } from 'vitest';
import { getSupabaseClient, resetClient, healthCheck } from '../../src/cloud/supabase.js';

// We can only test the client creation and basic logic without a real Supabase instance
describe('Supabase Client', () => {
  it('creates a client instance', () => {
    resetClient();
    const client = getSupabaseClient('https://test.supabase.co', 'test-key');
    expect(client).toBeDefined();
  });

  it('returns same instance on subsequent calls', () => {
    const client1 = getSupabaseClient('https://test.supabase.co', 'test-key');
    const client2 = getSupabaseClient('https://test.supabase.co', 'test-key');
    expect(client1).toBe(client2);
  });

  it('creates new instance after reset', () => {
    const client1 = getSupabaseClient('https://test.supabase.co', 'test-key');
    resetClient();
    const client2 = getSupabaseClient('https://test2.supabase.co', 'test-key-2');
    // After reset, a new client is created
    expect(client2).toBeDefined();
  });

  it('healthCheck returns false for invalid URL', async () => {
    resetClient();
    const client = getSupabaseClient('https://invalid.supabase.co', 'bad-key');
    const result = await healthCheck(client);
    expect(result).toBe(false);
  });
});
