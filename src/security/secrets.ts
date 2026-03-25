export interface SecretMatch {
  pattern: string;
  match: string;
}

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

export function detectSecrets(text: string): SecretMatch | null {
  for (const { name, regex } of SECRET_PATTERNS) {
    const match = text.match(regex);
    if (match) {
      return { pattern: name, match: match[0].substring(0, 20) + '...' };
    }
  }
  return null;
}

export function containsSecrets(text: string): boolean {
  return detectSecrets(text) !== null;
}
