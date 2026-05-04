/**
 * `valis index <folder>` — bulk-import markdown documentation as decisions.
 *
 * 0.1.5: simplified to interactive prompts only. Two questions:
 *   1) Mode: quick (one decision per file) | detailed (one per H2 heading) |
 *      smart (heuristic — file for short, section for long/multi-H2)
 *   2) Run LLM enrichment after import? (yes/no — token estimate + $ shown)
 *
 * Both decisions are orthogonal: mode = how to split, enrich = whether to
 * pay tokens for type-classification + 'affects' extraction. Quick is the
 * cheapest path. Detailed is the same cost as Quick (regex split, no LLM).
 * Smart adds zero LLM cost but auto-decides the split per-file based on
 * H2 count and content size. LLM enrichment is opt-in regardless of mode.
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
 * Flag overrides (all optional; missing ones are prompted for; intended for
 * scripted runs — interactive users should ignore):
 *   --mode quick|detailed|smart   (preferred)
 *   --strategy file|section       (deprecated 0.1.5 alias for quick/detailed)
 *   --enrich                      (run LLM enrichment after import; default off)
 *   --use-git                     (truthy override; for "no", answer the prompt or use --yes)
 *   --type <decision|pattern|constraint|lesson>
 *   --affects <a,b,c>             (comma-separated tags applied to all)
 *   --dry-run                     (preview only, no writes)
 *   --yes                         (skip prompts AND final confirmation)
 *
 * Examples:
 *   valis index ./docs                                  # fully interactive
 *   valis index ./specs --mode smart --enrich           # CI-style scripted
 *   valis index ./docs --yes                            # all defaults, no prompts
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, relative, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import select from '@inquirer/select';
import pc from 'picocolors';

import { loadConfig } from '../config/store.js';
import { resolveConfig } from '../config/project.js';
import { getSupabaseClient, storeDecision } from '../cloud/supabase.js';
import { getQdrantClient, upsertDecision } from '../cloud/qdrant.js';
import { isHostedMode, resolveApiUrl, resolveApiPath } from '../cloud/api-url.js';
import { getToken } from '../auth/jwt.js';
import { HOSTED_SUPABASE_URL } from '../types.js';
import type { RawDecision, DecisionType } from '../types.js';

type ImportableType = Exclude<DecisionType, 'pending'>;

type IndexMode = 'quick' | 'detailed' | 'smart';

interface IndexOptions {
  mode?: IndexMode;
  /** @deprecated 0.1.5 — use --mode. Mapped: file→quick, section→detailed. */
  strategy?: 'file' | 'section';
  enrich?: boolean;
  useGit?: boolean;
  type?: string;
  affects?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Heuristic: a file with ≥ MIN_H2_FOR_SECTION H2 headings OR larger than
 * MIN_BYTES_FOR_SECTION bytes is treated as multi-decision (split on H2).
 * Below either threshold = single decision per file. Tuned against typical
 * `specs/NNN-feature/spec.md` files (large + many H2 → section) versus
 * `decisions/decision-NNN.md` ADRs (small + few H2 → file).
 */
const SMART_MIN_H2_FOR_SECTION = 3;
const SMART_MIN_BYTES_FOR_SECTION = 5_000;

/** ~4 chars per token is the standard rough approximation across tokenizers. */
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Pricing snapshot 2026-05-04 for anthropic/claude-haiku-4.5 from packages/web/src/lib/llm.ts. */
const HAIKU_PRICING_USD_PER_MTOK = { input: 1.0, output: 5.0 };
/** Heuristic: enrichment system prompt + JSON envelope + classification reply. */
const ENRICH_OUTPUT_TOKENS_PER_DRAFT = 80;
/** Per-call overhead for the enrichment system prompt (sent once per decision). */
const ENRICH_INPUT_OVERHEAD_PER_DRAFT = 200;

interface EnrichmentEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

function estimateEnrichmentCost(drafts: { detail: string }[]): EnrichmentEstimate {
  let inputTokens = 0;
  for (const d of drafts) {
    inputTokens += estimateTokensFromText(d.detail) + ENRICH_INPUT_OVERHEAD_PER_DRAFT;
  }
  const outputTokens = drafts.length * ENRICH_OUTPUT_TOKENS_PER_DRAFT;
  const costUsd =
    (inputTokens * HAIKU_PRICING_USD_PER_MTOK.input +
      outputTokens * HAIKU_PRICING_USD_PER_MTOK.output) /
    1_000_000;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, costUsd };
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n}`;
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) return `<$0.01`;
  if (usd < 1) return `~$${usd.toFixed(2)}`;
  return `~$${usd.toFixed(2)}`;
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

function shouldSplitFileSmart(content: string): boolean {
  // Cheap byte-size gate first — large files are almost always multi-decision.
  if (content.length >= SMART_MIN_BYTES_FOR_SECTION) return true;
  // Otherwise count H2 markers; ≥ N means it's structured as a multi-section doc.
  const h2Count = (content.match(/^##\s+/gm) ?? []).length;
  return h2Count >= SMART_MIN_H2_FOR_SECTION;
}

async function buildDrafts(
  folder: string,
  mode: IndexMode,
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

    // Mode resolution per file: 'quick' = always file; 'detailed' = always
    // section; 'smart' = file unless heuristic says otherwise.
    const useSection: boolean =
      mode === 'detailed' || (mode === 'smart' && shouldSplitFileSmart(content));

    if (useSection) {
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
  mode: IndexMode;
  useGit: boolean;
  type: ImportableType;
  affectsList: string[];
}

/**
 * Map the deprecated --strategy alias to the new --mode space.
 * file → quick, section → detailed. Kept so 0.1.3+ scripts don't break.
 */
function strategyToMode(strategy: 'file' | 'section'): IndexMode {
  return strategy === 'section' ? 'detailed' : 'quick';
}

async function resolveInteractiveOptions(options: IndexOptions): Promise<ResolvedOptions> {
  const yes = options.yes === true;
  const interactive = !yes;

  // Mode: prefer --mode, fall back to legacy --strategy mapping, otherwise prompt.
  const explicitMode: IndexMode | undefined =
    options.mode ?? (options.strategy ? strategyToMode(options.strategy) : undefined);

  const mode: IndexMode = explicitMode
    ? explicitMode
    : interactive
      ? await select({
          message: 'Choose import mode:',
          choices: [
            {
              name: 'Quick     — one decision per file (best for short ADRs)',
              value: 'quick' as IndexMode,
            },
            {
              name: 'Detailed  — one decision per H2 heading (best for long specs)',
              value: 'detailed' as IndexMode,
            },
            {
              name: 'Smart     — auto: file for short, section for long/multi-H2 docs',
              value: 'smart' as IndexMode,
            },
          ],
          default: 'quick',
        })
      : 'quick';

  // 0.1.5: dropped the interactive useGit prompt. Default off — git lookup
  // is slow on large repos and the value (better author attribution) is
  // marginal compared to the friction it adds at the prompt. Use --use-git
  // explicitly when scripted runs need attribution.
  const useGit: boolean = options.useGit ?? false;

  // 0.1.3: dropped the interactive type prompt entirely. Files with a
  // `decision-/pattern-/constraint-/lesson-/postmortem-` prefix get their
  // type inferred (in buildDrafts). Files without a prefix default to
  // `decision` BUT are stored as `status: 'proposed'` so they sit in the
  // drafts queue for triage rather than polluting the active set. The
  // `--type` flag still works as an explicit override for unprefixed files.
  const type: ImportableType =
    (options.type as ImportableType | undefined) ?? 'decision';

  // 0.1.5: dropped the interactive affects prompt. A single global tag
  // applied to every decision is rarely the right call; per-file affects
  // is what users actually want, and that lands with --enrich (LLM
  // extraction) or via per-file frontmatter (deferred per BACKLOG #147 E).
  const affectsRaw = options.affects ?? '';
  const affectsList = affectsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    ...options,
    mode,
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
  const drafts = await buildDrafts(absFolder, resolved_opts.mode, resolved_opts, {
    author,
    affects: resolved_opts.affectsList,
    type: resolved_opts.type,
  });

  if (drafts.length === 0) {
    console.log(pc.yellow('No markdown files found to index.'));
    return;
  }

  renderPreview(drafts);

  // 0.1.5: ask about LLM enrichment AFTER preview (so token estimate uses
  // real draft sizes) but BEFORE confirmation (so user accepts both at once).
  // Hosted-mode only: community users have to run `valis enrich` separately.
  const hostedJwt = config.auth_mode === 'jwt' && isHostedMode(config);
  let runEnrich = options.enrich === true;
  if (!options.yes && options.enrich === undefined && hostedJwt) {
    const est = estimateEnrichmentCost(drafts);
    runEnrich = await select({
      message: 'After import, also run LLM enrichment? (classifies type + extracts affects tags)',
      choices: [
        { name: 'no  — skip enrichment (free)', value: false },
        {
          name:
            `yes — ~${formatTokens(est.inputTokens)} input + ~${formatTokens(est.outputTokens)} output tokens, ` +
            `${formatCostUsd(est.costUsd)} with Anthropic Haiku (current model)`,
          value: true,
        },
      ],
      default: false,
    });
  }

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

  // 0.1.6 / BUG #154: hosted users don't have service_role_key in local
  // config (that's the whole point of hosted mode — server holds the keys).
  // Switch storage path on auth_mode: hosted → POST /api/seed via member
  // api_key; community → direct Supabase + Qdrant write.
  let stored = 0;
  let storedProposed = 0;
  let failed = 0;
  const storedIds: string[] = [];

  if (hostedJwt) {
    const result = await storeDraftsHosted(config, projectId ?? null, drafts);
    stored = result.stored;
    storedProposed = result.storedProposed;
    failed = result.failed;
    storedIds.push(...result.storedIds);
  } else {
    const supabase = getSupabaseClient(
      config.supabase_url ?? '',
      config.supabase_service_role_key ?? '',
    );
    const qdrant = getQdrantClient(config.qdrant_url ?? '', config.qdrant_api_key ?? '');
    for (const d of drafts) {
      const status: 'active' | 'proposed' = d.typeFromPrefix ? 'active' : 'proposed';
      const raw: RawDecision = {
        text: d.detail,
        type: d.type,
        summary: d.summary,
        affects: d.affects,
        project_id: projectId ?? undefined,
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
        storedIds.push(stored_pg.id);
        if (status === 'proposed') storedProposed++;
        if (stored % 10 === 0 || stored === drafts.length) {
          console.log(pc.dim(`  stored ${stored}/${drafts.length}`));
        }
      } catch (err) {
        failed++;
        console.error(pc.red(`  failed ${d.relativePath}: ${(err as Error).message}`));
      }
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

  // 0.1.5: post-import enrichment. Hosted JWT users get server-side
  // /api/enrich which carries the daily-budget gate ($1/day default) and
  // surfaces real input/output token counts back to the CLI for honest
  // cost reporting. Community users see a hint to run `valis enrich`
  // locally with their own ANTHROPIC_API_KEY.
  if (runEnrich && stored > 0) {
    if (!hostedJwt) {
      console.log(
        pc.dim(
          '\nTip: --enrich requires hosted mode. Community users can run ' +
            '`ANTHROPIC_API_KEY=sk-... valis enrich` separately.',
        ),
      );
    } else {
      await runHostedEnrichmentBatched(config, storedIds);
    }
  } else if (storedProposed > 0 && hostedJwt) {
    // Even when the user said no to enrichment, leave a low-key pointer so
    // the proposed-drafts pile doesn't sit indefinitely without triage.
    console.log(
      pc.dim(
        `\nTip: ${storedProposed} drafts are unclassified. ` +
          `Run \`valis enrich\` later (~${formatCostUsd(estimateEnrichmentCost(drafts.filter((d) => !d.typeFromPrefix)).costUsd)}) to classify them.`,
      ),
    );
  }
}

/**
 * 0.1.6 / BUG #154: hosted-mode storage path. POSTs drafts to /api/seed
 * (which already runs server-side with the service_role_key) using the
 * member api_key from config. /api/seed caps at 100 decisions per call,
 * so we batch. Returns the same shape the community-mode loop produces.
 */
async function storeDraftsHosted(
  config: import('../types.js').ValisConfig,
  projectId: string | null,
  drafts: DraftDecision[],
): Promise<{ stored: number; storedProposed: number; failed: number; storedIds: string[] }> {
  const apiKey = config.member_api_key ?? config.api_key;
  if (!apiKey || !projectId) {
    console.error(
      pc.red(
        'Hosted mode requires member_api_key + project_id in config. ' +
          'Run `valis init` then `valis switch --project <name>`.',
      ),
    );
    return { stored: 0, storedProposed: 0, failed: drafts.length, storedIds: [] };
  }

  const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiUrl = resolveApiUrl(config.supabase_url, isHosted);
  const seedUrl = resolveApiPath(apiUrl, 'seed');

  const BATCH_SIZE = 100;
  let stored = 0;
  let storedProposed = 0;
  let failed = 0;
  const storedIds: string[] = [];

  for (let i = 0; i < drafts.length; i += BATCH_SIZE) {
    const batch = drafts.slice(i, i + BATCH_SIZE);
    const payload = {
      project_id: projectId,
      decisions: batch.map((d) => ({
        text: d.detail,
        type: d.type,
        summary: d.summary,
        affects: d.affects,
        status: d.typeFromPrefix ? 'active' : 'proposed',
        // Lower confidence on auto-classified untyped imports so the
        // reranker doesn't promote them above organic captures.
        confidence: d.typeFromPrefix ? undefined : 0.5,
      })),
    };

    let res: Response;
    try {
      res = await fetch(seedUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      failed += batch.length;
      console.error(pc.red(`  batch ${i / BATCH_SIZE + 1} network error: ${(err as Error).message}`));
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(pc.red(`  batch ${i / BATCH_SIZE + 1} HTTP ${res.status}: ${body}`));
      failed += batch.length;
      continue;
    }

    const json = (await res.json()) as {
      stored: number;
      skipped: number;
      total: number;
      decision_ids: string[];
    };

    stored += json.stored;
    failed += json.skipped;
    storedIds.push(...(json.decision_ids ?? []));

    // Track proposed count from the batch slice — server doesn't return it
    // explicitly, but we know the input shape so we can attribute correctly:
    // proposed = drafts in this batch with !typeFromPrefix that succeeded.
    const batchProposed = batch.filter((d) => !d.typeFromPrefix).length;
    const batchProposedSucceeded = Math.min(batchProposed, json.stored);
    storedProposed += batchProposedSucceeded;

    if ((i + BATCH_SIZE) % 100 === 0 || i + BATCH_SIZE >= drafts.length) {
      console.log(
        pc.dim(`  stored ${Math.min(i + BATCH_SIZE, drafts.length)}/${drafts.length}`),
      );
    }
  }

  return { stored, storedProposed, failed, storedIds };
}

/**
 * Call /api/enrich in batches of 20 (the route's hard cap from T032).
 * Surfaces real token+cost back to the user — the *advertised* preview was
 * an estimate; this is what the LLM actually consumed.
 */
async function runHostedEnrichmentBatched(
  config: import('../types.js').ValisConfig,
  decisionIds: string[],
): Promise<void> {
  const apiKey = config.member_api_key ?? config.api_key;
  const projectId = config.project_id ?? undefined;
  const tokenCache = await getToken(config.supabase_url, apiKey, projectId);
  if (!tokenCache) {
    console.error(pc.red('Could not obtain auth token for enrichment. Skipped.'));
    return;
  }

  const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiUrl = resolveApiUrl(config.supabase_url, isHosted);
  const enrichUrl = resolveApiPath(apiUrl, 'enrich');

  const BATCH_SIZE = 20;
  let totalEnriched = 0;
  let totalSkipped = 0;
  let totalCostCents = 0;
  let totalTokens = 0;

  console.log(pc.bold(`\nRunning LLM enrichment on ${decisionIds.length} draft(s)...`));

  for (let i = 0; i < decisionIds.length; i += BATCH_SIZE) {
    const batch = decisionIds.slice(i, i + BATCH_SIZE);
    let res: Response;
    try {
      res = await fetch(enrichUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenCache.jwt.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision_ids: batch }),
      });
    } catch (err) {
      console.error(pc.red(`  batch ${i / BATCH_SIZE + 1} network error: ${(err as Error).message}`));
      continue;
    }

    if (!res.ok) {
      if (res.status === 429) {
        console.log(
          pc.yellow(
            `\n  Daily enrichment budget exhausted at draft ${i}. ` +
              `Remaining drafts kept as proposed; rerun \`valis enrich\` tomorrow to continue.`,
          ),
        );
        break;
      }
      const body = await res.text().catch(() => '');
      console.error(pc.red(`  batch ${i / BATCH_SIZE + 1} HTTP ${res.status}: ${body}`));
      continue;
    }

    const json = (await res.json()) as {
      enriched: Array<{ tokens_used: number; cost_cents: number }>;
      skipped: string[];
      total_cost_cents: number;
    };
    totalEnriched += json.enriched.length;
    totalSkipped += json.skipped.length;
    totalCostCents += json.total_cost_cents;
    for (const e of json.enriched) totalTokens += e.tokens_used;
    console.log(
      pc.dim(
        `  batch ${i / BATCH_SIZE + 1}: ${json.enriched.length} enriched, ${json.skipped.length} skipped`,
      ),
    );
  }

  console.log();
  console.log(pc.green(`✓ Enriched ${totalEnriched} decision(s)`));
  console.log(
    pc.dim(
      `    Tokens used: ${formatTokens(totalTokens)} (input + output combined). ` +
        `Cost: ${formatCostUsd(totalCostCents / 100)} actual.`,
    ),
  );
  if (totalSkipped > 0) {
    console.log(pc.yellow(`    ${totalSkipped} skipped (already enriched or budget hit)`));
  }
}
