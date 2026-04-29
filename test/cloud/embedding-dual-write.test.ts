/**
 * 019/US4 / T031 — dual-write env-gated behavior.
 *
 * Verifies that:
 *  - dual-write is OFF by default (single-collection write only)
 *  - EMBEDDING_DUAL_WRITE=1 produces vector payloads for BOTH versions
 *  - dual-write is OFF when EMBEDDING_DUAL_WRITE=0
 *  - getDualWriteCollection picks the inverse-version collection
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getDualWriteCollection,
  isDualWriteEnabled,
  getActiveEmbeddingVersion,
  getActiveCollectionName,
  vectorForUpsertAtVersion,
  COLLECTION_V1,
  COLLECTION_V2,
  DENSE_MODEL_V1,
  DENSE_MODEL_V2,
  DENSE_VECTOR_NAME,
} from '../../src/cloud/embedding.js';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('US4 — dual-write env gating', () => {
  it('default: getDualWriteCollection returns null when env unset', () => {
    withEnv({ EMBEDDING_DUAL_WRITE: undefined, EMBEDDING_ACTIVE_VERSION: undefined }, () => {
      expect(isDualWriteEnabled()).toBe(false);
      expect(getDualWriteCollection()).toBeNull();
    });
  });

  it('EMBEDDING_DUAL_WRITE=0 keeps dual-write off', () => {
    withEnv({ EMBEDDING_DUAL_WRITE: '0', EMBEDDING_ACTIVE_VERSION: undefined }, () => {
      expect(isDualWriteEnabled()).toBe(false);
      expect(getDualWriteCollection()).toBeNull();
    });
  });

  it('EMBEDDING_DUAL_WRITE=1 + active=v1 → dual target is v2 collection', () => {
    withEnv({ EMBEDDING_DUAL_WRITE: '1', EMBEDDING_ACTIVE_VERSION: 'v1' }, () => {
      expect(isDualWriteEnabled()).toBe(true);
      const target = getDualWriteCollection();
      expect(target).not.toBeNull();
      expect(target!.collection).toBe(COLLECTION_V2);
      expect(target!.version).toBe('v2');
    });
  });

  it('EMBEDDING_DUAL_WRITE=1 + active=v2 → dual target is v1 collection', () => {
    withEnv({ EMBEDDING_DUAL_WRITE: '1', EMBEDDING_ACTIVE_VERSION: 'v2' }, () => {
      const target = getDualWriteCollection();
      expect(target).not.toBeNull();
      expect(target!.collection).toBe(COLLECTION_V1);
      expect(target!.version).toBe('v1');
    });
  });

  it('active version defaults to v1', () => {
    withEnv({ EMBEDDING_ACTIVE_VERSION: undefined }, () => {
      expect(getActiveEmbeddingVersion()).toBe('v1');
      expect(getActiveCollectionName()).toBe(COLLECTION_V1);
    });
  });

  it('EMBEDDING_ACTIVE_VERSION=v2 flips active to v2 + collection to decisions_v2', () => {
    withEnv({ EMBEDDING_ACTIVE_VERSION: 'v2' }, () => {
      expect(getActiveEmbeddingVersion()).toBe('v2');
      expect(getActiveCollectionName()).toBe(COLLECTION_V2);
    });
  });

  it('EMBEDDING_ACTIVE_VERSION=garbage falls back to v1', () => {
    withEnv({ EMBEDDING_ACTIVE_VERSION: 'asdfgh' }, () => {
      expect(getActiveEmbeddingVersion()).toBe('v1');
      expect(getActiveCollectionName()).toBe(COLLECTION_V1);
    });
  });
});

describe('US4 — dual-write produces both vectors', () => {
  it('vectorForUpsertAtVersion produces v1 + v2 Documents independently', () => {
    const v1Vec = vectorForUpsertAtVersion('decision text', 'v1') as Record<string, { text: string; model: string }>;
    const v2Vec = vectorForUpsertAtVersion('decision text', 'v2') as Record<string, { text: string; model: string }>;
    expect(v1Vec[DENSE_VECTOR_NAME].model).toBe(DENSE_MODEL_V1);
    expect(v2Vec[DENSE_VECTOR_NAME].model).toBe(DENSE_MODEL_V2);
    // Same input → both Documents carry the (truncated) same text
    expect(v1Vec[DENSE_VECTOR_NAME].text).toBe('decision text');
    expect(v2Vec[DENSE_VECTOR_NAME].text).toBe('decision text');
  });
});

afterEach(() => {
  // Defense-in-depth: ensure no env leakage between test files.
  delete process.env.EMBEDDING_DUAL_WRITE;
  delete process.env.EMBEDDING_ACTIVE_VERSION;
});
