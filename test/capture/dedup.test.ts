import { describe, it, expect } from 'vitest';
import { contentHash, isDuplicate, markAsSeen } from '../../src/capture/dedup.js';

describe('Content Dedup', () => {
  describe('contentHash', () => {
    it('produces consistent hash for same text', () => {
      const hash1 = contentHash('Hello World');
      const hash2 = contentHash('Hello World');
      expect(hash1).toBe(hash2);
    });

    it('normalizes whitespace', () => {
      const hash1 = contentHash('Hello  World');
      const hash2 = contentHash('Hello World');
      expect(hash1).toBe(hash2);
    });

    it('is case insensitive', () => {
      const hash1 = contentHash('Hello World');
      const hash2 = contentHash('hello world');
      expect(hash1).toBe(hash2);
    });

    it('trims whitespace', () => {
      const hash1 = contentHash('  Hello World  ');
      const hash2 = contentHash('Hello World');
      expect(hash1).toBe(hash2);
    });
  });

  describe('isDuplicate', () => {
    it('returns false on first call', () => {
      expect(isDuplicate('unique text for dedup test 1')).toBe(false);
    });

    it('returns true on second call with same text', () => {
      const text = 'unique text for dedup test 2';
      isDuplicate(text); // first call marks as seen
      expect(isDuplicate(text)).toBe(true);
    });

    it('handles session-scoped dedup', () => {
      const text = 'session scoped text';
      isDuplicate(text, 'session-1');
      // Same text, different session should not be duplicate
      expect(isDuplicate(text, 'session-2')).toBe(false);
    });
  });
});
