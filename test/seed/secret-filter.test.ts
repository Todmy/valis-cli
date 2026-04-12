import { describe, it, expect } from 'vitest';
import { detectSecrets, containsSecrets } from '../../src/security/secrets.js';

describe('detectSecrets — seed pipeline coverage', () => {
  it('blocks Anthropic API key (sk-ant-api03-...)', () => {
    const text = 'Use this key: sk-ant-api03-' + 'A'.repeat(80) + ' for the API';
    const result = detectSecrets(text);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('Anthropic API Key');
  });

  it('blocks AWS access key (AKIA...)', () => {
    const text = 'Deploy with AKIAIOSFODNN7EXAMPLE credentials';
    const result = detectSecrets(text);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('AWS Access Key');
  });

  it('passes clean decision text', () => {
    const text = 'Use PostgreSQL for the primary database';
    expect(detectSecrets(text)).toBeNull();
    expect(containsSecrets(text)).toBe(false);
  });

  it('blocks Stripe key in summary field', () => {
    const summary = 'Configure sk_test_' + 'X'.repeat(24) + ' for payments';
    const result = detectSecrets(summary);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe('Stripe Key');
  });

  it('filters mixed array — clean pass, secret blocked', () => {
    const items = [
      { text: 'Use JWT for auth', summary: 'JWT auth decision' },
      { text: 'Key is sk-ant-api03-' + 'B'.repeat(80), summary: 'API key storage' },
      { text: 'Deploy to Vercel', summary: 'Hosting decision' },
      { text: 'DB url: postgres://user:pass@host/db', summary: 'DB connection' },
    ];

    const safe = items.filter(d => {
      if (detectSecrets(d.text)) return false;
      if (d.summary && detectSecrets(d.summary)) return false;
      return true;
    });

    expect(safe).toHaveLength(2);
    expect(safe[0].text).toBe('Use JWT for auth');
    expect(safe[1].text).toBe('Deploy to Vercel');
  });

  it('blocks GitHub personal access token', () => {
    const text = 'Token: ghp_' + 'a'.repeat(36);
    expect(detectSecrets(text)).not.toBeNull();
  });

  it('blocks private key header', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...';
    expect(detectSecrets(text)).not.toBeNull();
  });

  it('blocks JWT token', () => {
    const text = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
    expect(detectSecrets(text)).not.toBeNull();
  });
});
