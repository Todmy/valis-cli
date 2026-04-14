import { lintSource } from '@secretlint/core';
import { creator as presetCreator } from '@secretlint/secretlint-rule-preset-recommend';

export interface SecretMatch {
  pattern: string;
  match: string;
}

// Layer 1: Custom regex patterns — kept for reliability + backward compatibility.
// Secretlint preset nominally covers some of these, but smoke testing showed
// gaps (AWS AKIA disabled by default, Private Key header-only not caught).
// Belt-and-suspenders: our regex catches known formats instantly, secretlint
// layer 3 adds coverage for formats we don't have regex for.
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9_-]{80,}/ },
  { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9]{20,}T3BlbkFJ|sk-proj-[a-zA-Z0-9_-]{80,}/ },
  { name: 'GitHub Token', regex: /ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{36,}|gho_[A-Za-z0-9]{36}/ },
  { name: 'Private Key', regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ/ },
  { name: 'Database URL', regex: /(postgres|mysql|mongodb|redis):\/\/[^\s]+@/ },
  { name: 'Slack Token', regex: /xox[bpras]-[0-9]{10,}/ },
  { name: 'Stripe Key', regex: /(sk|pk)_(test|live)_[A-Za-z0-9]{24,}/ },
  { name: 'Supabase Service Role Key', regex: /sb_secret_[A-Za-z0-9_-]{20,}/ },
  { name: 'Generic Secret', regex: /(password|secret|token|api_key)\s*[:=]\s*['"][^\s]{8,}/ },
];

// Layer 2: Shannon entropy for catching unknown secret types
export function shannonEntropy(str: string): number {
  const len = str.length;
  if (len === 0) return 0;
  const freq: Record<string, number> = {};
  for (let i = 0; i < len; i++) freq[str[i]] = (freq[str[i]] || 0) + 1;
  let entropy = 0;
  for (const c in freq) {
    const p = freq[c] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasHighEntropyToken(text: string, threshold = 4.5, minLen = 20): string | null {
  const tokens = text.split(/[\s=:'"`,;{}()\[\]]+/);
  for (const t of tokens) {
    if (t.length >= minLen && shannonEntropy(t) >= threshold) {
      return t;
    }
  }
  return null;
}

// Layer 3: Secretlint config — built once, reused across calls
const secretlintConfig = {
  rules: [{ id: 'preset-recommend', rule: presetCreator, options: {} }],
};

export async function detectSecrets(text: string): Promise<SecretMatch | null> {
  // Layer 1: Fast custom regex (~0.001ms)
  for (const { name, regex } of SECRET_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      return { pattern: name, match: match[0].substring(0, 20) + '...' };
    }
  }

  // Layer 2: Entropy scan (~0.002ms)
  const highEntropyToken = hasHighEntropyToken(text);
  if (highEntropyToken) {
    return { pattern: 'High-entropy token', match: highEntropyToken.substring(0, 20) + '...' };
  }

  // Layer 3: Secretlint preset — catches GCP, GitLab, NPM, SendGrid, 1Password, etc.
  try {
    const result = await lintSource({
      source: { filePath: '/v/input.txt', content: text, ext: '.txt', contentType: 'text' },
      options: { config: secretlintConfig },
    });
    if (result.messages.length > 0) {
      const msg = result.messages[0];
      return {
        pattern: msg.ruleId ?? 'secretlint',
        match: text.substring(msg.range[0], msg.range[0] + 20) + '...',
      };
    }
  } catch {
    // Secretlint failure — layers 1+2 already ran, degrade gracefully
  }

  return null;
}

export async function containsSecrets(text: string): Promise<boolean> {
  return (await detectSecrets(text)) !== null;
}
