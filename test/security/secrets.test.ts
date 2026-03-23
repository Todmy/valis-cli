import { describe, it, expect } from 'vitest';
import { detectSecrets, containsSecrets } from '../../src/security/secrets.js';

describe('Secret Detection', () => {
  describe('AWS Access Key', () => {
    it('detects AWS access key', () => {
      const result = detectSecrets('My key is AKIAIOSFODNN7EXAMPLE');
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('AWS Access Key');
    });

    it('does not flag non-AWS text', () => {
      expect(detectSecrets('AKIA is a prefix but too short')).toBeNull();
    });
  });

  describe('Anthropic API Key', () => {
    it('detects Anthropic key', () => {
      const key = 'sk-ant-' + 'a'.repeat(80);
      const result = detectSecrets(`Using key ${key}`);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('Anthropic API Key');
    });
  });

  describe('OpenAI API Key', () => {
    it('detects old format OpenAI key', () => {
      const key = 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ';
      expect(detectSecrets(key)).not.toBeNull();
    });

    it('detects new proj format OpenAI key', () => {
      const key = 'sk-proj-' + 'a'.repeat(80);
      expect(detectSecrets(key)).not.toBeNull();
    });
  });

  describe('GitHub Token', () => {
    it('detects ghp_ token', () => {
      const token = 'ghp_' + 'A'.repeat(36);
      const result = detectSecrets(`Token: ${token}`);
      expect(result).not.toBeNull();
      expect(result!.pattern).toBe('GitHub Token');
    });

    it('detects github_pat_ token', () => {
      const token = 'github_pat_' + 'A'.repeat(36);
      expect(detectSecrets(token)).not.toBeNull();
    });
  });

  describe('Private Key', () => {
    it('detects RSA private key', () => {
      expect(detectSecrets('-----BEGIN RSA PRIVATE KEY-----')).not.toBeNull();
    });

    it('detects EC private key', () => {
      expect(detectSecrets('-----BEGIN EC PRIVATE KEY-----')).not.toBeNull();
    });

    it('detects generic private key', () => {
      expect(detectSecrets('-----BEGIN PRIVATE KEY-----')).not.toBeNull();
    });
  });

  describe('JWT', () => {
    it('detects JWT token', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
      expect(detectSecrets(jwt)).not.toBeNull();
    });
  });

  describe('Database URL', () => {
    it('detects postgres URL with credentials', () => {
      expect(detectSecrets('postgres://user:pass@host:5432/db')).not.toBeNull();
    });

    it('detects mongodb URL', () => {
      expect(detectSecrets('mongodb://admin:secret@cluster.mongodb.net/mydb')).not.toBeNull();
    });

    it('does not flag URL without credentials', () => {
      expect(detectSecrets('We use postgres as our database')).toBeNull();
    });
  });

  describe('Slack Token', () => {
    it('detects xoxb token', () => {
      expect(detectSecrets('xoxb-1234567890-abcdef')).not.toBeNull();
    });
  });

  describe('Stripe Key', () => {
    it('detects Stripe secret key', () => {
      const key = 'sk_test_' + 'a'.repeat(24);
      expect(detectSecrets(key)).not.toBeNull();
    });

    it('detects Stripe publishable key', () => {
      const key = 'pk_live_' + 'a'.repeat(24);
      expect(detectSecrets(key)).not.toBeNull();
    });
  });

  describe('Generic Secret', () => {
    it('detects password assignment', () => {
      expect(detectSecrets('password = "supersecretpassword123"')).not.toBeNull();
    });

    it('detects api_key assignment', () => {
      expect(detectSecrets("api_key: 'myverylongapikey123'")).not.toBeNull();
    });

    it('does not flag prose usage of token', () => {
      expect(detectSecrets('The token is used to authenticate requests')).toBeNull();
    });
  });

  describe('containsSecrets', () => {
    it('returns true for text with secrets', () => {
      expect(containsSecrets('-----BEGIN PRIVATE KEY-----')).toBe(true);
    });

    it('returns false for clean text', () => {
      expect(containsSecrets('We chose PostgreSQL for user data storage')).toBe(false);
    });
  });

  describe('safe text', () => {
    it('passes normal decision text', () => {
      expect(detectSecrets('We decided to use React for the frontend because of its ecosystem')).toBeNull();
    });

    it('passes text about databases', () => {
      expect(detectSecrets('PostgreSQL is better for ACID compliance than MongoDB')).toBeNull();
    });
  });
});
