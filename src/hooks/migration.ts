/**
 * Memory.md migration — feature 023 v2 US3.
 *
 * Detects competing-memory content in:
 *   • <project>/MEMORY.md
 *   • Top-level user MEMORY.md (~/.claude/projects/.../MEMORY.md)
 *   • Project CLAUDE.md work-section blocks
 *   • Registered competing SessionStart hooks (informational only)
 *
 * For accepted candidates: backs up the original to
 * ~/.valis/migrate-backup/<project_id>/<timestamp>/, writes a stub pointer,
 * and records the migration in the per-project manifest. SHA-256 dedup
 * makes re-runs idempotent. A declined-suppression window of 30 days
 * prevents re-prompting on the same content.
 *
 * Per data-model.md §2 + research.md R-11.
 */

import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  chmod,
  rename,
} from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { migrationManifestPath, migrationBackupRoot } from './paths.js';

export type CandidateKind = 'memory_md' | 'project_claude_md' | 'competing_hook';

export type DecisionType = 'decision' | 'pattern' | 'lesson' | 'constraint';

export interface Candidate {
  /** Source kind for downstream UI. */
  kind: CandidateKind;
  /** Absolute path to the source file. */
  path: string;
  /** Full source content (for backup + dedup hash). */
  content: string;
  /** SHA-256 of content (idempotency key). */
  sourceDedupHash: string;
  /** Inferred per-entry decisions ready to seed. */
  entries: TaggedEntry[];
}

export interface TaggedEntry {
  /** Inferred type — affects which Valis store category gets the row. */
  type: DecisionType;
  /** ≤200-char summary the agent and dashboard will display. */
  summary: string;
  /** Full body (markdown). */
  detail: string;
  /** Affected modules / topics inferred from headings. */
  affects: string[];
}

export interface MigrationManifest {
  manifest_version: 1;
  project_id: string;
  project_name: string;
  migrations: MigrationEntry[];
  decline_history: DeclineEntry[];
}

export interface MigrationEntry {
  migrated_at: string;
  source_path: string;
  source_dedup_hash: string;
  backup_path: string;
  entries_migrated: number;
  decision_ids: string[];
}

export interface DeclineEntry {
  declined_at: string;
  source_path: string;
  source_dedup_hash: string;
  reprompt_after: string;
}

const RE_HEADING = /^#{1,3}\s+(.+)$/;
const RE_BULLET = /^[\-\*]\s+(.+)$/;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function tagType(text: string): DecisionType {
  const lower = text.toLowerCase();
  if (/\b(constraint|never|must not|forbid)/.test(lower)) {
    return 'constraint';
  }
  if (/\b(lesson|learned|gotcha|incident|root cause)/.test(lower)) {
    return 'lesson';
  }
  if (/\b(pattern|convention|always|template)/.test(lower)) {
    return 'pattern';
  }
  return 'decision';
}

function summarize(text: string, maxLen = 200): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1).trimEnd() + '…';
}

/**
 * Parse a MEMORY.md / CLAUDE.md fragment into discrete entries.
 *
 * The strategy is intentionally simple: each heading becomes an `affects`
 * scope; each bullet under it becomes one entry. Free-form paragraphs
 * accumulate into the previous entry's detail.
 */
export function parseEntries(content: string): TaggedEntry[] {
  const lines = content.split('\n');
  const entries: TaggedEntry[] = [];
  const affectsStack: string[] = [];
  let pendingDetail: string[] = [];
  let currentEntry: TaggedEntry | null = null;

  const flush = () => {
    if (currentEntry) {
      currentEntry.detail = pendingDetail.join('\n').trim();
      if (currentEntry.summary.length > 0) entries.push(currentEntry);
    }
    pendingDetail = [];
    currentEntry = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const headingMatch = RE_HEADING.exec(line);
    if (headingMatch) {
      flush();
      affectsStack.length = 0;
      affectsStack.push(headingMatch[1].trim());
      continue;
    }
    const bulletMatch = RE_BULLET.exec(line);
    if (bulletMatch) {
      flush();
      const text = bulletMatch[1].trim();
      currentEntry = {
        type: tagType(text),
        summary: summarize(text),
        detail: text,
        affects: [...affectsStack],
      };
      pendingDetail = [text];
      continue;
    }
    if (line.length > 0 && currentEntry) {
      pendingDetail.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * Detect migration candidates in a project directory.
 */
export async function detectCandidates(projectDir: string): Promise<Candidate[]> {
  const result: Candidate[] = [];

  const memoryPath = join(projectDir, 'MEMORY.md');
  if (existsSync(memoryPath)) {
    try {
      const content = await readFile(memoryPath, 'utf-8');
      const entries = parseEntries(content);
      if (entries.length > 0) {
        result.push({
          kind: 'memory_md',
          path: memoryPath,
          content,
          sourceDedupHash: sha256(content),
          entries,
        });
      }
    } catch {
      /* unreadable — skip */
    }
  }

  const claudeMdPath = join(projectDir, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const content = await readFile(claudeMdPath, 'utf-8');
      const workBlocks = extractWorkSections(content);
      if (workBlocks.length > 0) {
        const joined = workBlocks.join('\n\n');
        const entries = parseEntries(joined);
        if (entries.length > 0) {
          result.push({
            kind: 'project_claude_md',
            path: claudeMdPath,
            content: joined,
            sourceDedupHash: sha256(joined),
            entries,
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  return result;
}

const WORK_HEADING = /^##\s+(decisions?|patterns?|lessons?|architecture|conventions?|design|rules)\b/i;

function extractWorkSections(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let inBlock = false;
  let buffer: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inBlock) {
        blocks.push(buffer.join('\n'));
        buffer = [];
      }
      inBlock = WORK_HEADING.test(line);
      if (inBlock) buffer.push(line);
    } else if (inBlock) {
      buffer.push(line);
    }
  }
  if (inBlock && buffer.length > 0) blocks.push(buffer.join('\n'));
  return blocks;
}

// ---------------------------------------------------------------------------
// Manifest persistence
// ---------------------------------------------------------------------------

export async function loadManifest(projectId: string): Promise<MigrationManifest> {
  try {
    const data = await readFile(migrationManifestPath(projectId), 'utf-8');
    const parsed = JSON.parse(data) as MigrationManifest;
    if (parsed.manifest_version !== 1) {
      throw new Error(`Unsupported manifest_version: ${parsed.manifest_version}`);
    }
    return parsed;
  } catch {
    return {
      manifest_version: 1,
      project_id: projectId,
      project_name: '',
      migrations: [],
      decline_history: [],
    };
  }
}

async function saveManifest(manifest: MigrationManifest): Promise<void> {
  const path = migrationManifestPath(manifest.project_id);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    await chmod(tmp, 0o600);
  } catch {
    /* non-POSIX */
  }
  await rename(tmp, path);
}

export function isAlreadyMigrated(
  candidate: Candidate,
  manifest: MigrationManifest,
): boolean {
  return manifest.migrations.some((m) => m.source_dedup_hash === candidate.sourceDedupHash);
}

export function isDeclineSuppressed(
  candidate: Candidate,
  manifest: MigrationManifest,
  now: Date = new Date(),
): boolean {
  const decline = manifest.decline_history.find(
    (d) => d.source_dedup_hash === candidate.sourceDedupHash,
  );
  if (!decline) return false;
  return Date.parse(decline.reprompt_after) > now.getTime();
}

// ---------------------------------------------------------------------------
// Backup + replacement
// ---------------------------------------------------------------------------

function backupTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function stubPointer(_originalPath: string, backupPath: string): string {
  return `# Memory has moved to Valis

For this project, the team brain is Valis. See SessionStart payload or:
  valis search "<your query>"

Original content backed up to:
  ${backupPath}

To remove this pointer (after confirming Valis has all the content you
need), delete this file.
`;
}

/**
 * Backup `candidate.path` atomically into the per-project backup directory,
 * then replace the original with a stub pointer.
 *
 * Returns the backup path. Throws on any I/O failure; the caller must
 * rollback (the manifest entry should NOT be written if this throws).
 */
export async function backupAndStub(
  candidate: Candidate,
  projectId: string,
  now: Date = new Date(),
): Promise<string> {
  const ts = backupTimestamp(now);
  const backupDir = join(migrationBackupRoot(), projectId, ts);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = join(backupDir, basename(candidate.path));

  const tmp = `${backupPath}.${randomBytes(6).toString('hex')}.tmp`;
  await copyFile(candidate.path, tmp);
  await rename(tmp, backupPath);
  try {
    await chmod(backupPath, 0o600);
  } catch {
    /* non-POSIX */
  }

  await writeFile(candidate.path, stubPointer(candidate.path, backupPath), {
    encoding: 'utf-8',
  });
  return backupPath;
}

// ---------------------------------------------------------------------------
// Public migrate() flow
// ---------------------------------------------------------------------------

export interface MigrateResult {
  candidate: Candidate;
  backupPath: string;
  decisionIds: string[]; // populated by the caller after Valis seed
  migratedAt: string;
}

/**
 * Persist a single accepted migration into the per-project manifest.
 * The actual decision-creation is the caller's responsibility (it happens
 * via the existing seed pipeline so the same dedup + lifecycle rules apply).
 */
export async function recordMigration(
  manifest: MigrationManifest,
  result: MigrateResult,
): Promise<void> {
  manifest.migrations.push({
    migrated_at: result.migratedAt,
    source_path: result.candidate.path,
    source_dedup_hash: result.candidate.sourceDedupHash,
    backup_path: result.backupPath,
    entries_migrated: result.candidate.entries.length,
    decision_ids: result.decisionIds,
  });
  await saveManifest(manifest);
}

export async function recordDecline(
  manifest: MigrationManifest,
  candidate: Candidate,
  now: Date = new Date(),
): Promise<void> {
  const repromptAfter = new Date(now.getTime() + 30 * 24 * 3600 * 1000).toISOString();
  manifest.decline_history.push({
    declined_at: now.toISOString(),
    source_path: candidate.path,
    source_dedup_hash: candidate.sourceDedupHash,
    reprompt_after: repromptAfter,
  });
  await saveManifest(manifest);
}

/**
 * Render a short preview suitable for an interactive prompt.
 */
export function renderPreview(candidates: Candidate[]): string {
  const lines: string[] = [];
  lines.push('Found existing memory file:');
  for (const c of candidates) {
    lines.push(`  ${c.path}  (${c.entries.length} entries)`);
  }
  lines.push('');
  lines.push('Sample:');
  let shown = 0;
  for (const c of candidates) {
    for (const e of c.entries.slice(0, 3)) {
      lines.push(`  [${e.type}]  ${e.summary}`);
      shown++;
      if (shown >= 5) break;
    }
    if (shown >= 5) break;
  }
  return lines.join('\n');
}
