import { describe, it, expect } from 'vitest';
import { detectSecrets, containsSecrets } from '../../src/security/secrets.js';

describe('Secret Detection', () => {
  describe('AWS Access Key', () => {
    it('detects AWS access key', async () => {
      const result = await detectSecrets('My key is AKIAIOSFODNN7EXAMPLE');
      expect(result).not.toBeNull();
    });

    it('does not flag non-AWS text', async () => {
      expect(await detectSecrets('AKIA is a prefix but too short')).toBeNull();
    });
  });

  describe('Anthropic API Key', () => {
    it('detects Anthropic key', async () => {
      const key = 'sk-ant-' + 'a'.repeat(80);
      const result = await detectSecrets(`Using key ${key}`);
      expect(result).not.toBeNull();
    });
  });

  describe('OpenAI API Key', () => {
    it('detects old format OpenAI key', async () => {
      const key = 'sk-' + 'a'.repeat(20) + 'T3BlbkFJ';
      expect(await detectSecrets(key)).not.toBeNull();
    });

    it('detects new proj format OpenAI key', async () => {
      const key = 'sk-proj-' + 'a'.repeat(80);
      expect(await detectSecrets(key)).not.toBeNull();
    });
  });

  describe('GitHub Token', () => {
    it('detects ghp_ token', async () => {
      const token = 'ghp_' + 'A'.repeat(36);
      const result = await detectSecrets(`Token: ${token}`);
      expect(result).not.toBeNull();
    });

    it('detects github_pat_ token', async () => {
      const token = 'github_pat_' + 'A'.repeat(36);
      expect(await detectSecrets(token)).not.toBeNull();
    });
  });

  describe('Private Key', () => {
    it('detects RSA private key', async () => {
      expect(await detectSecrets('-----BEGIN RSA PRIVATE KEY-----')).not.toBeNull();
    });

    it('detects EC private key', async () => {
      expect(await detectSecrets('-----BEGIN EC PRIVATE KEY-----')).not.toBeNull();
    });

    it('detects generic private key', async () => {
      expect(await detectSecrets('-----BEGIN PRIVATE KEY-----')).not.toBeNull();
    });
  });

  describe('JWT', () => {
    it('detects JWT token', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
      expect(await detectSecrets(jwt)).not.toBeNull();
    });
  });

  describe('Database URL', () => {
    it('detects postgres URL with credentials', async () => {
      expect(await detectSecrets('postgres://user:pass@host:5432/db')).not.toBeNull();
    });

    it('detects mongodb URL', async () => {
      expect(await detectSecrets('mongodb://admin:secret@cluster.mongodb.net/mydb')).not.toBeNull();
    });

    it('does not flag URL without credentials', async () => {
      expect(await detectSecrets('We use postgres as our database')).toBeNull();
    });
  });

  describe('Slack Token', () => {
    it('detects xoxb token', async () => {
      expect(await detectSecrets('xoxb-1234567890-abcdef')).not.toBeNull();
    });
  });

  describe('Stripe Key', () => {
    it('detects Stripe secret key', async () => {
      const key = 'sk_test_' + 'a'.repeat(24);
      expect(await detectSecrets(key)).not.toBeNull();
    });

    it('detects Stripe publishable key', async () => {
      const key = 'pk_live_' + 'a'.repeat(24);
      expect(await detectSecrets(key)).not.toBeNull();
    });
  });

  describe('Generic Secret', () => {
    it('detects password assignment', async () => {
      expect(await detectSecrets('password = "supersecretpassword123"')).not.toBeNull();
    });

    it('detects api_key assignment', async () => {
      expect(await detectSecrets("api_key: 'myverylongapikey123'")).not.toBeNull();
    });

    it('does not flag prose usage of token', async () => {
      expect(await detectSecrets('The token is used to authenticate requests')).toBeNull();
    });
  });

  describe('containsSecrets', () => {
    it('returns true for text with secrets', async () => {
      expect(await containsSecrets('-----BEGIN PRIVATE KEY-----')).toBe(true);
    });

    it('returns false for clean text', async () => {
      expect(await containsSecrets('We chose PostgreSQL for user data storage')).toBe(false);
    });
  });

  describe('safe text', () => {
    it('passes normal decision text', async () => {
      expect(await detectSecrets('We decided to use React for the frontend because of its ecosystem')).toBeNull();
    });

    it('passes text about databases', async () => {
      expect(await detectSecrets('PostgreSQL is better for ACID compliance than MongoDB')).toBeNull();
    });
  });
});
