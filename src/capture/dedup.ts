import { createHash } from 'node:crypto';

const LRU_MAX = 1000;

class LRUCache<K, V> {
  private map = new Map<K, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Delete oldest entry
      const firstKey = this.map.keys().next().value!;
      this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

const hashCache = new LRUCache<string, string>(LRU_MAX);

export function contentHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

export function isDuplicate(text: string, sessionId?: string): boolean {
  const hash = contentHash(text);
  const key = sessionId ? `${sessionId}:${hash}` : hash;

  if (hashCache.has(key)) {
    return true;
  }

  hashCache.set(key, hash);
  return false;
}

export function markAsSeen(text: string, sessionId?: string): void {
  const hash = contentHash(text);
  const key = sessionId ? `${sessionId}:${hash}` : hash;
  hashCache.set(key, hash);
}
