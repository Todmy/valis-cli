/**
 * Configuration self-healing — fires from SessionStart before the labeled-
 * block injection. Cheap probes detect drift in Valis-managed surfaces and
 * re-apply the canonical template when markers are missing.
 *
 * Goals:
 *   1. Resilient to manual deletion: engineer wipes a Valis section by
 *      accident → next session restores it silently.
 *   2. Project-level install agnostic: works regardless of whether the
 *      Valis CLI / plugin is user-level or project-local — the hook fires
 *      from SessionStart, which Claude Code dispatches in both modes.
 *   3. Respect user customizations: if content INSIDE Valis markers was
 *      modified, never overwrite — log a `config_drift_user_customized`
 *      telemetry event and let the engineer reconcile manually.
 *
 * Surfaces healed:
 *   - ~/.claude/CLAUDE.md Knowledge Retention section (NEW marker)
 *   - <project>/CLAUDE.md Valis markers (existing — re-applied if absent)
 *   - ~/.claude/settings.json Valis hook entries (re-applied if absent)
 *
 * Opt-out: `auto_heal: false` in `~/.valis/config.json`. Default ON because
 * the whole point of feature 023 is to remove agent-discipline burden, and
 * a maintenance hook that breaks silently is the same problem.
 */

import { readFile, writeFile, mkdir, chmod, rename, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  configPath,
  migrationBackupRoot,
  claudeHome,
  installationIdPath,
} from './paths.js';
import { record as recordTelemetry } from './telemetry.js';
import {
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  GLOBAL_KR_BODY,
  PROJECT_VALIS_START,
  PROJECT_VALIS_END,
  SETTINGS_HOOK_COMMANDS,
  canonicalGlobalKrBlock,
} from './self-heal-templates.js';

function contentHash(s: string): string {
  return createHash('sha256').update(s.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

const CANONICAL_GLOBAL_KR_HASH = contentHash(GLOBAL_KR_BODY);

type HealOutcome = 'fresh' | 'repaired' | 'user_customized' | 'opt_out' | 'skipped';

export interface HealReport {
  target: string;
  outcome: HealOutcome;
  notes?: string;
}

interface ValisGlobalConfig {
  auto_heal?: boolean;
}

async function readGlobalConfig(): Promise<ValisGlobalConfig> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf-8')) as ValisGlobalConfig;
  } catch {
    return {};
  }
}

async function backupOriginal(originalPath: string, label: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(migrationBackupRoot(), 'self-heal', label, ts);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, originalPath.split('/').pop() || 'file');
  await copyFile(originalPath, dest);
  try {
    await chmod(dest, 0o600);
  } catch {
    /* non-POSIX */
  }
  return dest;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf-8' });
  await rename(tmp, path);
}

function extractBetween(haystack: string, start: string, end: string): string {
  const i = haystack.indexOf(start);
  const j = haystack.indexOf(end);
  if (i === -1 || j === -1 || j <= i) return '';
  return haystack.slice(i + start.length, j).trim();
}

/**
 * Apply the canonical Knowledge Retention block to a global CLAUDE.md.
 *
 * Strategy:
 *   1. If the existing file has a "# Knowledge Retention" heading, find
 *      that section's bounds (heading -> next top-level heading or EOF) and
 *      replace it with the canonical marker-wrapped block.
 *   2. Otherwise, append the canonical block at the bottom of the file.
 */
export function applyGlobalKrSection(existing: string): string {
  const canonical = canonicalGlobalKrBlock();

  // Case 1: marker block already present (any state, fresh or drifted) —
  // replace just the wrapped block, preserving everything outside the
  // markers verbatim.
  const markerStart = existing.indexOf(GLOBAL_KR_START);
  const markerEnd = existing.indexOf(GLOBAL_KR_END);
  if (markerStart !== -1 && markerEnd !== -1 && markerEnd > markerStart) {
    const before = existing.slice(0, markerStart);
    const after = existing.slice(markerEnd + GLOBAL_KR_END.length);
    return before + canonical + after;
  }

  // Case 2: legacy "# Knowledge Retention" heading without markers —
  // replace from the heading to the next top-level heading or EOF.
  const headingPattern = /^#\s+Knowledge Retention.*$/m;
  const match = headingPattern.exec(existing);
  if (match) {
    const startIdx = match.index;
    const remainder = existing.slice(startIdx + match[0].length);
    const nextHeading = remainder.search(/^#\s+/m);
    const endIdx =
      nextHeading === -1
        ? existing.length
        : startIdx + match[0].length + nextHeading;
    return existing.slice(0, startIdx) + canonical + '\n\n' + existing.slice(endIdx);
  }

  // Case 3: no marker, no legacy heading — append at EOF.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + canonical + '\n';
}

async function healGlobalClaudeMd(): Promise<HealReport> {
  const targetPath = join(claudeHome(), 'CLAUDE.md');
  const target = '~/.claude/CLAUDE.md (Knowledge Retention)';

  let content: string;
  try {
    content = await readFile(targetPath, 'utf-8');
  } catch {
    return { target, outcome: 'skipped', notes: 'global CLAUDE.md absent' };
  }

  const hasMarkers =
    content.includes(GLOBAL_KR_START) && content.includes(GLOBAL_KR_END);

  if (hasMarkers) {
    const between = extractBetween(content, GLOBAL_KR_START, GLOBAL_KR_END);
    const currentHash = contentHash(between);
    if (currentHash === CANONICAL_GLOBAL_KR_HASH) {
      return { target, outcome: 'fresh' };
    }
    return {
      target,
      outcome: 'user_customized',
      notes: `hash drift: expected ${CANONICAL_GLOBAL_KR_HASH}, got ${currentHash}`,
    };
  }

  await backupOriginal(targetPath, 'global-claude-md');
  const newContent = applyGlobalKrSection(content);
  await atomicWrite(targetPath, newContent);
  return { target, outcome: 'repaired' };
}

async function healProjectClaudeMd(projectDir: string): Promise<HealReport> {
  const target = `${projectDir}/CLAUDE.md (valis:start markers)`;
  const targetPath = join(projectDir, 'CLAUDE.md');
  if (!existsSync(targetPath)) {
    return { target, outcome: 'skipped', notes: 'project CLAUDE.md absent' };
  }

  const content = await readFile(targetPath, 'utf-8');
  const hasMarkers =
    content.includes(PROJECT_VALIS_START) && content.includes(PROJECT_VALIS_END);
  if (hasMarkers) return { target, outcome: 'fresh' };

  const { injectClaudeMdMarkers } = await import('../ide/claude-code.js');
  await backupOriginal(targetPath, 'project-claude-md');
  await injectClaudeMdMarkers(projectDir);
  return { target, outcome: 'repaired' };
}

// ---------------------------------------------------------------------------
// Heal target #4 — MCP server entry in ~/.claude.json
//
// `~/.claude.json` lives in $HOME (sibling to ~/.claude/, not inside),
// so we resolve it via homedir() rather than claudeHome() which targets
// the directory. Same env override convention: $CLAUDE_HOME_OVERRIDE.
// ---------------------------------------------------------------------------

function claudeJsonPath(): string {
  // The CLAUDE_HOME_OVERRIDE escape hatch lets tests redirect the file.
  // Production resolves to ~/.claude.json.
  if (process.env.CLAUDE_HOME_OVERRIDE) {
    return join(process.env.CLAUDE_HOME_OVERRIDE, '.claude.json');
  }
  return join(homedir(), '.claude.json');
}

async function healMcpEntry(): Promise<HealReport> {
  const target = '~/.claude.json (mcpServers.valis)';
  const path = claudeJsonPath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return { target, outcome: 'skipped', notes: 'claude.json absent' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { target, outcome: 'skipped', notes: 'claude.json malformed' };
  }

  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  const entry = servers.valis as
    | { command?: string; args?: string[] }
    | undefined;
  const isPresent =
    entry &&
    entry.command === 'valis' &&
    Array.isArray(entry.args) &&
    entry.args[0] === 'serve';
  if (isPresent) return { target, outcome: 'fresh' };

  await backupOriginal(path, 'claude-json');
  servers.valis = { command: 'valis', args: ['serve'], env: {} };
  parsed.mcpServers = servers;
  await atomicWrite(path, JSON.stringify(parsed, null, 2) + '\n');
  void recordTelemetry('mcp_entry_repaired', { metadata: { target } });
  return { target, outcome: 'repaired' };
}

// ---------------------------------------------------------------------------
// Heal target #5 — installation_id recovery
//
// File at ~/.valis/installation-id is a single UUID line. If absent, write
// a new one. Critical: never REWRITE an existing valid UUID — that would
// orphan all prior telemetry attributed to the old installation.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function healInstallationId(): Promise<HealReport> {
  const target = '~/.valis/installation-id';
  const path = installationIdPath();
  try {
    const raw = (await readFile(path, 'utf-8')).trim();
    if (UUID_RE.test(raw)) return { target, outcome: 'fresh' };
    // File present but garbled — overwrite with a fresh UUID + backup.
    await backupOriginal(path, 'installation-id');
  } catch {
    /* missing — fall through to write */
  }
  const newId = randomUUID();
  await atomicWrite(path, newId);
  try {
    await chmod(path, 0o600);
  } catch {
    /* non-POSIX */
  }
  void recordTelemetry('installation_id_recovered', { metadata: { target } });
  return { target, outcome: 'repaired', notes: `wrote ${newId}` };
}

async function healSettingsHooks(): Promise<HealReport> {
  const target = '~/.claude/settings.json (valis hooks)';
  const settingsPath = join(claudeHome(), 'settings.json');
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf-8');
  } catch {
    return { target, outcome: 'skipped', notes: 'settings.json absent' };
  }
  const allPresent = SETTINGS_HOOK_COMMANDS.every((s) => raw.includes(s));
  if (allPresent) return { target, outcome: 'fresh' };

  await backupOriginal(settingsPath, 'settings-json');
  const { configureClaudeCodeMCP } = await import('../ide/claude-code.js');
  await configureClaudeCodeMCP(process.cwd());
  return { target, outcome: 'repaired' };
}

export interface SelfHealOptions {
  projectDir?: string;
  silent?: boolean;
}

/**
 * Run all self-heal checks. Fast path: ~10ms when everything is fresh
 * (file reads + substring checks). Slow path: rare, fires only on drift.
 *
 * Telemetry events:
 *   - config_drift_repaired
 *   - config_drift_user_customized
 */
export async function runSelfHeal(options: SelfHealOptions = {}): Promise<HealReport[]> {
  const cfg = await readGlobalConfig();
  if (cfg.auto_heal === false) {
    return [{ target: 'all', outcome: 'opt_out' }];
  }

  const projectDir = options.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  const [global, project, settings, mcp, installation] = await Promise.all([
    healGlobalClaudeMd().catch((err) => ({
      target: '~/.claude/CLAUDE.md',
      outcome: 'skipped' as HealOutcome,
      notes: `error: ${(err as Error).message}`,
    })),
    healProjectClaudeMd(projectDir).catch((err) => ({
      target: `${projectDir}/CLAUDE.md`,
      outcome: 'skipped' as HealOutcome,
      notes: `error: ${(err as Error).message}`,
    })),
    healSettingsHooks().catch((err) => ({
      target: '~/.claude/settings.json',
      outcome: 'skipped' as HealOutcome,
      notes: `error: ${(err as Error).message}`,
    })),
    healMcpEntry().catch((err) => ({
      target: '~/.claude.json',
      outcome: 'skipped' as HealOutcome,
      notes: `error: ${(err as Error).message}`,
    })),
    healInstallationId().catch((err) => ({
      target: '~/.valis/installation-id',
      outcome: 'skipped' as HealOutcome,
      notes: `error: ${(err as Error).message}`,
    })),
  ]);
  const reports: HealReport[] = [global, project, settings, mcp, installation];

  // Qdrant heal lives in its own module to keep network IO isolated. It
  // honors a 24h cooldown internally and silently skips if Qdrant creds
  // are absent (hosted-mode CLI).
  try {
    const { runQdrantHeal } = await import('./qdrant-self-heal.js');
    const qdrantReports = await runQdrantHeal();
    for (const r of qdrantReports) {
      reports.push({
        target: `qdrant:${r.collection}`,
        outcome:
          r.outcome === 'repaired'
            ? 'repaired'
            : r.outcome === 'fresh'
              ? 'fresh'
              : 'skipped',
        notes: r.repaired_fields ? `fields: ${r.repaired_fields.join(', ')}` : r.notes,
      });
    }
  } catch (err) {
    reports.push({
      target: 'qdrant',
      outcome: 'skipped',
      notes: `qdrant heal error: ${(err as Error).message}`,
    });
  }

  if (!options.silent) {
    for (const r of reports) {
      if (r.outcome === 'repaired') {
        void recordTelemetry('config_drift_repaired', {
          metadata: { target: r.target },
        });
      } else if (r.outcome === 'user_customized') {
        void recordTelemetry('config_drift_user_customized', {
          metadata: { target: r.target, notes: r.notes ?? '' },
        });
      }
    }
  }

  return reports;
}

export const __internal = { extractBetween, contentHash, CANONICAL_GLOBAL_KR_HASH };
