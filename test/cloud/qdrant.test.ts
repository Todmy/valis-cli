import { describe, it, expect } from 'vitest';
import { getQdrantClient, resetClient, healthCheck } from '../../src/cloud/qdrant.js';

describe('Qdrant Client', () => {
  it('creates a client instance', () => {
    resetClient();
    const client = getQdrantClient('https://test.qdrant.io', 'test-key');
    expect(client).toBeDefined();
  });

  it('returns same instance on subsequent calls', () => {
    const client1 = getQdrantClient('https://test.qdrant.io', 'test-key');
    const client2 = getQdrantClient('https://test.qdrant.io', 'test-key');
    expect(client1).toBe(client2);
  });

  it('healthCheck returns false for invalid URL', async () => {
    resetClient();
    const client = getQdrantClient('https://invalid.qdrant.io:6333', 'bad-key');
    const result = await healthCheck(client);
    expect(result).toBe(false);
  });
});
