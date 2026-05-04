/**
 * `valis index <folder>` — bulk-import markdown documentation as decisions.
 *
 * Interactive by default: only the folder is required. Strategy, git
 * metadata, default type, and affects-tags are asked one prompt at a time.
 * Any of those answers can be pre-filled (and the prompt skipped) by
 * passing the corresponding flag — same way `git commit` skips its editor
 * if `-m` is given. `--yes` short-circuits both the per-question prompts
 * (defaults applied: strategy=file, useGit=false, type=decision, affects=[])
 * and the final confirmation.
 *
 * Walks the folder for `.md` / `.markdown` files, optionally splits each by
 * H2 sections, optionally pulls git blame for author + first-commit-time,
 * shows a preview table, asks for confirmation, then stores each draft via
 * the same path used by `valis_store` (Postgres source-of-truth + Qdrant
 * upsert with chunking + e5-small managed inference).
 *
 * Use cases:
 *   - First-time onboarding: an existing repo with `docs/` directory of
 *     architectural notes. Index in one shot instead of typing each one.
 *   - Migrating from another knowledge tool (Notion export → markdown).
 *
 * Flag overrides (all optional; missing ones are prompted for):
 *   --strategy file|section
 *   --use-git                 (truthy override; for "no", answer the prompt or use --yes)
 *   --type <decision|pattern|constraint|lesson>
 *   --affects <a,b,c>         (comma-separated tags applied to all)
 *   --dry-run                 (preview only, no writes)
 *   --yes                     (skip prompts AND final confirmation)
 *
 * Examples:
 *   valis index ./docs                                  # fully interactive
 *   valis index ./docs --strategy section --use-git     # those two skipped
 *   valis index ./docs --yes                            # all defaults, no prompts
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';

import { loadConfig } from '../config/store.js';
import { resolveConfig } from '../config/project.js';
import { getSupabaseClient, storeDecision } from '../cloud/supabase.js';
import { getQdrantClient, upsertDecision } from '../cloud/qdrant.js';
import type { RawDecision, DecisionType } from '../types.js';

type ImportableType = Exclude<DecisionType, 'pending'>;

interface IndexOptions {
  strategy?: 'file' | 'section';
  useGit?: boolean;
  type?: string;
  affects?: string;
  dryRun?: boolean;
  yes?: boolean;
}

interface DraftDecision {
  filePath: string;
  relativePath: string;
  sectionTitle: string | null;
  summary: string;
  detail: string;
  author: string;
  createdAt: string;
  type: ImportableType;
  affects: string[];
  /**
   * True when `type` was inferred from the filename prefix
   * (`decision-*`, `pattern-*`, `constraint-*`, `lesson-*`,
   * `postmortem-*`) — i.e. the type is high-confidence. False when we
   * fell back to the `--type` default for an unprefixed file — those
   * are stored as `status: 'proposed'` for later triage (0.1.3).
   */
  typeFromPrefix: boolean;
}

const VALID_TYPES: ImportableType[] = ["decision", "pattern", "constraint", "lesson"];

async function* walkMarkdown(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMarkdown(full);
    } else if (e.isFile()) {
      const ext = extname(e.name).toLowerCase();
      if (ext === '.md' || ext === '.markdown') yield full;
    }
  }
}

function splitOnH2(content: string): { sectionTitle: string; body: string }[] {
  const lines = content.split('\n');
  const sections: { sectionTitle: string; body: string }[] = [];
  let currentTitle: string | null = null;
  let currentBody: string[] = [];

  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (m) {
      if (currentTitle !== null) {
        sections.push({ sectionTitle: currentTitle, body: currentBody.join('\n').trim() });
      }
      currentTitle = m[1].trim();
      currentBody = [];
    } else if (currentTitle !== null) {
      currentBody.push(line);
    }
  }
  if (currentTitle !== null) {
    sections.push({ sectionTitle: currentTitle, body: currentBody.join('\n').trim() });
  }
  return sections.filter((s) => s.body.length > 0);
}

function extractH1(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
  }
  return null;
}

function summarize(text: string, max = 100): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + '…';
}

interface GitMeta {
  author: string;
  createdAt: string;
}

/**
 * git log --diff-filter=A --follow --reverse — first author + iso date for
 * the file's add commit. Uses execFileSync (not exec) so file paths can
 * never inject shell tokens — `repoRoot` and `relPath` are forwarded as
 * argv positions, not interpolated.
 */
function gitMetaForFile(repoRoot: string, filePath: string): GitMeta | null {
  try {
    const rel = relative(repoRoot, filePath);
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '--diff-filter=A', '--follow', '--reverse', '--format=%an|%aI', '--', rel],
      { encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    const firstLine = out.split('\n')[0];
    const [author, iso] = firstLine.split('|');
    if (!author || !iso) return null;
    return { author, createdAt: iso };
  } catch {
    return null;
  }
}

function findGitRoot(start: string): string | null {
  try {
    return execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function inferTypeFromFilename(
  filename: string,
  fallback: ImportableType,
): { type: ImportableType; fromPrefix: boolean } {
  const lower = filename.toLowerCase();
  if (lower.startsWith('decision-')) return { type: 'decision', fromPrefix: true };
  if (lower.startsWith('pattern-')) return { type: 'pattern', fromPrefix: true };
  if (lower.startsWith('constraint-')) return { type: 'constraint', fromPrefix: true };
  if (lower.startsWith('lesson-') || lower.startsWith('postmortem-')) {
    return { type: 'lesson', fromPrefix: true };
  }
  return { type: fallback, fromPrefix: false };
}

async function buildDrafts(
  folder: string,
  options: IndexOptions,
  defaults: { author: string; affects: string[]; type: ImportableType },
): Promise<DraftDecision[]> {
  const drafts: DraftDecision[] = [];
  const gitRoot = options.useGit ? findGitRoot(folder) : null;
  if (options.useGit && !gitRoot) {
    console.warn(pc.yellow('warning: --use-git given but folder is not in a git repo; skipping git metadata'));
  }

  for await (const filePath of walkMarkdown(folder)) {
    const content = await readFile(filePath, 'utf8');
    if (content.trim().length === 0) continue;

    const meta = gitRoot ? gitMetaForFile(gitRoot, filePath) : null;
    const author = meta?.author ?? defaults.author;
    const createdAt = meta?.createdAt ?? new Date().toISOString();
    const inferred = inferTypeFromFilename(basename(filePath), defaults.type);
    const fileType = inferred.type;
    const typeFromPrefix = inferred.fromPrefix;
    const relativePath = relative(folder, filePath);

    if (options.strategy === 'section') {
      const fileH1 = extractH1(content);
      const sections = splitOnH2(content);
      if (sections.length === 0) {
        drafts.push({
          filePath,
          relativePath,
          sectionTitle: null,
          summary: summarize(fileH1 ?? basename(filePath, extname(filePath))),
          detail: content.trim(),
          author,
          createdAt,
          type: fileType,
          affects: defaults.affects,
          typeFromPrefix,
        });
        continue;
      }
      for (const sec of sections) {
        const summaryPrefix = fileH1 ? `${fileH1} — ${sec.sectionTitle}` : sec.sectionTitle;
        drafts.push({
          filePath,
          relativePath,
          sectionTitle: sec.sectionTitle,
          summary: summarize(summaryPrefix),
          detail: sec.body,
          author,
          createdAt,
          type: fileType,
          affects: defaults.affects,
          typeFromPrefix,
        });
      }
    } else {
      const h1 = extractH1(content);
      drafts.push({
        filePath,
        relativePath,
        sectionTitle: null,
        summary: summarize(h1 ?? basename(filePath, extname(filePath))),
        detail: content.trim(),
        author,
        createdAt,
        type: fileType,
        affects: defaults.affects,
        typeFromPrefix,
      });
    }
  }

  return drafts;
}

function renderPreview(drafts: DraftDecision[]): void {
  const proposedCount = drafts.filter((d) => !d.typeFromPrefix).length;
  const activeCount = drafts.length - proposedCount;
  console.log(pc.bold(`\nPreview — ${drafts.length} draft decision(s):\n`));
  if (proposedCount > 0) {
    console.log(
      pc.dim(`  → ${activeCount} will be `) +
        pc.green('active') +
        pc.dim(' (typed via filename prefix), ') +
        pc.dim(`${proposedCount} `) +
        pc.yellow('proposed') +
        pc.dim(' (drafts; promote/dismiss in dashboard)\n'),
    );
  }
  const maxRows = 20;
  const rows = drafts.slice(0, maxRows);
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i];
    const sec = d.sectionTitle ? pc.dim(` [${d.sectionTitle}]`) : '';
    const author = pc.dim(`(${d.author}, ${d.createdAt.slice(0, 10)})`);
    const type = d.typeFromPrefix ? pc.cyan(`[${d.type}]`) : pc.yellow(`[${d.type} • draft]`);
    console.log(`  ${pc.gray(`${i + 1}.`)} ${type} ${pc.bold(d.summary)}${sec}`);
    console.log(`     ${pc.gray(d.relativePath)} ${author}`);
  }
  if (drafts.length > maxRows) {
    console.log(pc.dim(`     … and ${drafts.length - maxRows} more`));
  }
}

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${message} [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Fill in any options the user did not pass on the command line by
 * prompting them. `--yes` skips prompts entirely and uses safe defaults.
 *
 * Returned shape adds `affectsList` (parsed) and a narrowed `type` so the
 * caller doesn't re-parse strings.
 */
interface ResolvedOptions extends IndexOptions {
  strategy: 'file' | 'section';
  useGit: boolean;
  type: ImportableType;
  affectsList: string[];
}

async function resolveInteractiveOptions(options: IndexOptions): Promise<ResolvedOptions> {
  const yes = options.yes === true;
  const interactive = !yes;

  const strategy: 'file' | 'section' =
    options.strategy ??
    (interactive
      ? await select({
          message: 'How should each markdown file map to decisions?',
          choices: [
            { name: 'file — one decision per file (good for short notes)', value: 'file' },
            { name: 'section — one decision per H2 heading (good for long docs)', value: 'section' },
          ],
          default: 'file',
        })
      : 'file');

  const useGit: boolean =
    options.useGit ??
    (interactive
      ? await select({
          message: 'Pull author + first-commit date from git log?',
          choices: [
            { name: 'no — use current user / now()', value: false },
            { name: 'yes — git log (folder must be in a git repo)', value: true },
          ],
          default: false,
        })
      : false);

  // 0.1.3: dropped the interactive type prompt entirely. Files with a
  // `decision-/pattern-/constraint-/lesson-/postmortem-` prefix get their
  // type inferred (in buildDrafts). Files without a prefix default to
  // `decision` BUT are stored as `status: 'proposed'` so they sit in the
  // drafts queue for triage rather than polluting the active set. The
  // `--type` flag still works as an explicit override for unprefixed files.
  const type: ImportableType =
    (options.type as ImportableType | undefined) ?? 'decision';

  const affectsRaw =
    options.affects ??
    (interactive
      ? await input({
          message: 'Affects tags applied to every decision (comma-separated, leave blank for none):',
          default: '',
        })
      : '');
  const affectsList = affectsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    ...options,
    strategy,
    useGit,
    type,
    affects: affectsRaw || undefined,
    affectsList,
  };
}

export async function indexCommand(folder: string, options: IndexOptions): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }
  if (!config.org_id) {
    console.error('Error: no org_id in config. Run `valis init` first.');
    process.exit(1);
  }

  const absFolder = resolve(folder);
  const folderStat = await stat(absFolder).catch(() => null);
  if (!folderStat || !folderStat.isDirectory()) {
    console.error(`Error: ${absFolder} is not a directory.`);
    process.exit(1);
  }

  const resolved = await resolveConfig();
  const projectId = resolved.project?.project_id;
  if (!projectId) {
    console.warn(
      pc.yellow('Warning: no project_id resolved from .valis.json. ') +
      pc.yellow('Decisions will be stored without project_id (cross-project visible).'),
    );
  }

  // Resolve missing options interactively (unless --yes was passed).
  // Each flag the user already provided short-circuits its prompt — same
  // ergonomics as `git commit`: pass `-m` and the editor never opens.
  const resolved_opts = await resolveInteractiveOptions(options);

  if (resolved_opts.type && !VALID_TYPES.includes(resolved_opts.type)) {
    console.error(`Error: --type must be one of ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }
  const author = config.member_id ?? 'cli-import';

  console.log(pc.bold(`\nScanning ${absFolder}...`));
  const drafts = await buildDrafts(absFolder, resolved_opts, {
    author,
    affects: resolved_opts.affectsList,
    type: resolved_opts.type,
  });

  if (drafts.length === 0) {
    console.log(pc.yellow('No markdown files found to index.'));
    return;
  }

  renderPreview(drafts);

  if (options.dryRun) {
    console.log(pc.dim('\n(--dry-run; no decisions written)'));
    return;
  }

  if (!options.yes) {
    const ok = await confirm(`\nStore ${drafts.length} decision(s) into project ${projectId ?? '(none)'}?`);
    if (!ok) {
      console.log(pc.yellow('Aborted.'));
      return;
    }
  }

  const supabase = getSupabaseClient(
    config.supabase_url ?? '',
    config.supabase_service_role_key ?? '',
  );
  const qdrant = getQdrantClient(config.qdrant_url ?? '', config.qdrant_api_key ?? '');

  let stored = 0;
  let storedProposed = 0;
  let failed = 0;
  for (const d of drafts) {
    // 0.1.3: files with a recognized prefix (`decision-/pattern-/...`) get
    // typed + active status; files without one get `status: 'proposed'` so
    // they sit in the drafts queue for triage rather than polluting the
    // active set.
    const status: 'active' | 'proposed' = d.typeFromPrefix ? 'active' : 'proposed';
    const raw: RawDecision = {
      text: d.detail,
      type: d.type,
      summary: d.summary,
      affects: d.affects,
      project_id: projectId ?? undefined,
      // Lower confidence on auto-classified untyped imports so the
      // reranker doesn't promote them above organically-captured items.
      confidence: d.typeFromPrefix ? undefined : 0.5,
    };
    try {
      const stored_pg = await storeDecision(supabase, config.org_id, raw, d.author, 'seed', { status });
      await upsertDecision(qdrant, config.org_id, stored_pg.id, raw, d.author, {
        project_id: projectId ?? undefined,
        status,
        source: 'seed',
      });
      stored++;
      if (status === 'proposed') storedProposed++;
      if (stored % 10 === 0 || stored === drafts.length) {
        console.log(pc.dim(`  stored ${stored}/${drafts.length}`));
      }
    } catch (err) {
      failed++;
      console.error(pc.red(`  failed ${d.relativePath}: ${(err as Error).message}`));
    }
  }

  console.log();
  const activeCount = stored - storedProposed;
  console.log(pc.green(`✓ Stored ${stored} decision(s)`));
  if (storedProposed > 0) {
    console.log(
      pc.dim(`    ${activeCount} active (typed via filename prefix), `) +
        pc.yellow(`${storedProposed} proposed`) +
        pc.dim(' (drafts — review in dashboard before promote)'),
    );
  }
  if (failed > 0) console.log(pc.red(`✗ ${failed} failed`));
}
