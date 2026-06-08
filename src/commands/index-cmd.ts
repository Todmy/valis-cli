/**
 * `valis index <folder>` — bulk-import markdown documentation as decisions.
 *
 * 0.1.10: dropped the mode prompt entirely (BACKLOG #162). Every markdown
 * file becomes one decision with the file's H1 as summary and the full
 * body as detail. The body is then chunked by Qdrant ingestion (1500 chars
 * + 200 overlap, paragraph→sentence→hard-slice) so retrieval still hits
 * sub-document chunks via expand='siblings'. Per-H2 splitting at the
 * Postgres level was redundant after the chunking fix landed — agents
 * reason at the decision level, search returns at the chunk level, and
 * the user thinks at the file level. Three-mode prompt was friction
 * without a real use case.
 *
 * Single optional question: run LLM enrichment after import? Token
 * estimate + $ shown so the user sees the cost before opting in.
 *
 * Walks the folder for `.md` / `.markdown` files, optionally pulls git
 * blame for author + first-commit-time, shows a preview, asks for
 * confirmation, then stores each draft via the same path used by
 * `valis_store` (Postgres source-of-truth + Qdrant upsert with chunking +
 * e5-small managed inference).
 *
 * Use cases:
 *   - First-time onboarding: an existing repo with `docs/` directory of
 *     architectural notes. Index in one shot instead of typing each one.
 *   - Migrating from another knowledge tool (Notion export → markdown).
 *
 * Flag overrides (intended for scripted runs):
 *   --enrich                      (run LLM enrichment after import; default off)
 *   --use-git                     (extract author + created_at from git log)
 *   --type <decision|pattern|constraint|lesson>  (default fallback when filename has no prefix)
 *   --affects <a,b,c>             (comma-separated tags applied to all)
 *   --dry-run                     (preview only, no writes)
 *   --yes                         (skip prompts AND final confirmation)
 *
 * Examples:
 *   valis index ./docs                       # interactive (one prompt: enrich?)
 *   valis index ./specs --enrich --yes       # scripted with enrichment
 *   valis index ./docs --yes                 # all defaults, no prompts
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

interface IndexOptions {
  enrich?: boolean;
  useGit?: boolean;
  type?: string;
  affects?: string;
  dryRun?: boolean;
  yes?: boolean;
}

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

/**
 * First non-empty body line with leading markdown markers stripped (heading
 * hashes, list bullets, block-quote). Fenced code blocks are skipped — a line
 * of code is not a summary. Returns null when the body has no usable prose.
 */
function firstMeaningfulLine(content: string): string | null {
  let inFence = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    const stripped = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[>\-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .trim();
    if (stripped) return stripped;
  }
  return null;
}

/**
 * #280: derive a human-readable summary for an indexed markdown file. Order:
 * H1 heading → first meaningful body line → basename (last resort only). The
 * old code fell straight to `basename` when no H1 existed, so files with
 * slug-style names and no H1 (a common export shape) landed a machine slug as
 * their `summary`, polluting every surface that renders it (search, activity
 * feed, relationships, hook injection) and weakening BM25/semantic relevance.
 */
export function deriveSummary(content: string, filePath: string): string {
  const h1 = extractH1(content);
  if (h1) return summarize(h1);
  const bodyLine = firstMeaningfulLine(content);
  if (bodyLine) return summarize(bodyLine);
  return summarize(basename(filePath, extname(filePath)));
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

    // One file → one decision. The body is chunked by Qdrant ingestion at
    // store time so retrieval still hits sub-document chunks via siblings
    // expand. See header docstring for the rationale.
    drafts.push({
      filePath,
      relativePath,
      summary: deriveSummary(content, filePath),
      detail: content.trim(),
      author,
      createdAt,
      type: fileType,
      affects: defaults.affects,
      typeFromPrefix,
    });
  }

  return drafts;
}

function renderPreview(drafts: DraftDecision[]): void {
  // #255: every import lands in the proposed review queue. typeFromPrefix only
  // splits "recognized type" (higher confidence, skips enrichment) from
  // "untyped draft" (needs enrichment) — it no longer affects status.
  const untypedCount = drafts.filter((d) => !d.typeFromPrefix).length;
  const typedCount = drafts.length - untypedCount;
  console.log(pc.bold(`\nPreview — ${drafts.length} draft decision(s):\n`));
  console.log(
    pc.dim('  → all ') +
      pc.yellow('proposed') +
      pc.dim(` (review/promote in dashboard) — ${typedCount} typed, `) +
      pc.dim(`${untypedCount} untyped draft(s) needing enrichment\n`),
  );
  const maxRows = 20;
  const rows = drafts.slice(0, maxRows);
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i];
    const author = pc.dim(`(${d.author}, ${d.createdAt.slice(0, 10)})`);
    const type = d.typeFromPrefix ? pc.cyan(`[${d.type}]`) : pc.yellow(`[${d.type} • draft]`);
    console.log(`  ${pc.gray(`${i + 1}.`)} ${type} ${pc.bold(d.summary)}`);
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
  useGit: boolean;
  type: ImportableType;
  affectsList: string[];
}

async function resolveInteractiveOptions(options: IndexOptions): Promise<ResolvedOptions> {
  // 0.1.10: dropped the mode prompt entirely (BACKLOG #162). One file →
  // one decision is the only mode now. Body chunking happens server-side
  // at Qdrant ingestion, so per-H2 split at the Postgres level was
  // redundant. See header docstring.

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

  // 0.1.5: ask about LLM enrichment AFTER preview (so token estimate uses
  // real draft sizes) but BEFORE confirmation (so user accepts both at once).
  // Hosted-mode only: community users have to run `valis enrich` separately.
  const hostedJwt = config.auth_mode === 'jwt' && isHostedMode(config);
  let runEnrich = options.enrich === true;
  if (!options.yes && options.enrich === undefined && hostedJwt) {
    const est = estimateEnrichmentCost(drafts);
    runEnrich = await select({
      message:
        'Enrich drafts with LLM? — auto-classifies type (decision/pattern/' +
        'constraint/lesson), generates summary, extracts affects-tags, scores ' +
        'confidence. Required for type/area filters + confidence ranking in search.',
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
  let duplicates = 0;
  let invalid = 0;
  let failed = 0;
  const storedIds: string[] = [];

  if (hostedJwt) {
    const result = await storeDraftsHosted(config, projectId ?? null, drafts);
    stored = result.stored;
    storedProposed = result.storedProposed;
    duplicates = result.duplicates;
    invalid = result.invalid;
    failed = result.failed;
    storedIds.push(...result.storedIds);
  } else {
    const supabase = getSupabaseClient(
      config.supabase_url ?? '',
      config.supabase_service_role_key ?? '',
    );
    const qdrant = getQdrantClient(config.qdrant_url ?? '', config.qdrant_api_key ?? '');
    for (const d of drafts) {
      // #255: imports always land in 'proposed' for review — a file is not a
      // human review pass. typeFromPrefix still controls confidence/enrichment
      // (a recognized type is trusted enough to skip auto-classification), but
      // NOT status. Promote via the dashboard/triage queue.
      const status: 'active' | 'proposed' = 'proposed';
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
  console.log(pc.green(`✓ Stored ${stored} decision(s)`));
  if (stored > 0) {
    // #255: all imports are 'proposed' now. storedProposed counts the untyped
    // subset that still needs enrichment (type/summary/affects/confidence).
    console.log(
      pc.dim('    all ') +
        pc.yellow('proposed') +
        pc.dim(' — review/promote in dashboard') +
        (storedProposed > 0
          ? pc.dim(` · ${storedProposed} untyped draft(s) need enrichment`)
          : ''),
    );
  }
  // BUG #174: report duplicates / invalid separately from real failures so
  // safe re-imports (every hash already in DB) don't look like data loss.
  if (duplicates > 0) {
    console.log(
      pc.dim(`○ Skipped ${duplicates} duplicate(s) — already in the team brain`),
    );
  }
  if (invalid > 0) {
    console.log(pc.dim(`○ Skipped ${invalid} malformed draft(s) — text too short`));
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
    // Even when the user said no to enrichment, surface what's left to do.
    // First-time users see "unclassified drafts" as broken — explain WHAT
    // enrichment buys them (type, summary, affects, confidence) so they can
    // judge whether to spend the tokens.
    const cost = formatCostUsd(
      estimateEnrichmentCost(drafts.filter((d) => !d.typeFromPrefix)).costUsd,
    );
    console.log();
    console.log(pc.dim(`Next steps for the ${storedProposed} draft(s):`));
    console.log(
      pc.dim('  • ') +
        pc.bold('valis enrich') +
        pc.dim('          — auto-fill type, summary, affects-tags, confidence ') +
        pc.dim(`(${cost} with Haiku)`),
    );
    console.log(
      pc.dim('  • dashboard → Proposals — review and promote/dismiss manually (free)'),
    );
    console.log(
      pc.dim(
        '  Without either, drafts stay searchable but type/area filters and ' +
          'confidence-ranking won\'t apply.',
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
): Promise<{
  stored: number;
  storedProposed: number;
  duplicates: number;
  invalid: number;
  failed: number;
  storedIds: string[];
}> {
  const apiKey = config.member_api_key ?? config.api_key;
  if (!apiKey || !projectId) {
    console.error(
      pc.red(
        'Hosted mode requires member_api_key + project_id in config. ' +
          'Run `valis init` then `valis switch --project <name>`.',
      ),
    );
    return {
      stored: 0,
      storedProposed: 0,
      duplicates: 0,
      invalid: 0,
      failed: drafts.length,
      storedIds: [],
    };
  }

  const isHosted = config.supabase_url.replace(/\/$/, '') === HOSTED_SUPABASE_URL;
  const apiUrl = resolveApiUrl(config.supabase_url, isHosted);
  const seedUrl = resolveApiPath(apiUrl, 'seed');

  // Batch size 25 (was 100): keeps each round-trip <15s on prod /api/seed
  // (per-decision SHA-256 + Postgres insert + Qdrant managed-inference upsert
  // run sequentially server-side). With 25/batch, the user sees per-batch
  // progress every ~10s instead of one long silence.
  const BATCH_SIZE = 25;
  let stored = 0;
  let storedProposed = 0;
  let duplicates = 0;
  let invalid = 0;
  let failed = 0;
  const storedIds: string[] = [];
  const totalBatches = Math.ceil(drafts.length / BATCH_SIZE);

  console.log(
    pc.bold(
      `\nStoring ${drafts.length} draft(s) in ${totalBatches} batch(es) of up to ${BATCH_SIZE}...`,
    ),
  );

  for (let i = 0; i < drafts.length; i += BATCH_SIZE) {
    const batch = drafts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    const payload = {
      project_id: projectId,
      decisions: batch.map((d) => ({
        text: d.detail,
        type: d.type,
        summary: d.summary,
        affects: d.affects,
        // #255: imports always go to 'proposed' for review (see stdio path).
        status: 'proposed',
        // Lower confidence on auto-classified untyped imports so the
        // reranker doesn't promote them above organic captures.
        confidence: d.typeFromPrefix ? undefined : 0.5,
      })),
    };

    // Pre-fetch progress line so the user knows the round-trip is in flight
    // (not frozen). Plain stdout write so we don't add a newline; we'll
    // overwrite with the result line after fetch returns.
    process.stdout.write(
      pc.dim(`  batch ${batchNum}/${totalBatches} — sending ${batch.length} draft(s)... `),
    );
    const startedAt = Date.now();

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
      process.stdout.write('\n');
      console.error(pc.red(`  batch ${batchNum}/${totalBatches} network error: ${(err as Error).message}`));
      continue;
    }

    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stdout.write('\n');
      console.error(pc.red(`  batch ${batchNum}/${totalBatches} HTTP ${res.status} (${elapsedMs}ms): ${body}`));
      failed += batch.length;
      continue;
    }

    const json = (await res.json()) as {
      stored: number;
      skipped?: number; // legacy field, retained for backward compat
      duplicates?: number;
      invalid?: number;
      failed?: number;
      total: number;
      decision_ids: string[];
      errors?: string[];
    };

    // BUG #174: respect the new fine-grained counters when the server
    // returns them (>=0.5.4 backend). Fall back to legacy {stored, skipped}
    // shape for older deployments — in that case, all non-stored items get
    // lumped into `failed` as before.
    const batchDuplicates = json.duplicates ?? 0;
    const batchInvalid = json.invalid ?? 0;
    const batchFailed =
      json.failed !== undefined
        ? json.failed
        : Math.max(0, (json.skipped ?? 0) - batchDuplicates - batchInvalid);

    stored += json.stored;
    duplicates += batchDuplicates;
    invalid += batchInvalid;
    failed += batchFailed;
    storedIds.push(...(json.decision_ids ?? []));

    // Track proposed count from the batch slice — server doesn't return it
    // explicitly, but we know the input shape so we can attribute correctly:
    // proposed = drafts in this batch with !typeFromPrefix that succeeded.
    const batchProposed = batch.filter((d) => !d.typeFromPrefix).length;
    const batchProposedSucceeded = Math.min(batchProposed, json.stored);
    storedProposed += batchProposedSucceeded;

    // Per-batch result line: stored count + skipped + elapsed time so the
    // user can spot a slow batch (e.g. Qdrant inference cold-start).
    process.stdout.write(
      pc.green(
        `done (${json.stored} stored, ${json.skipped} skipped, ${(elapsedMs / 1000).toFixed(1)}s) `,
      ) + pc.dim(`[${stored}/${drafts.length}]\n`),
    );
  }

  return { stored, storedProposed, duplicates, invalid, failed, storedIds };
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
