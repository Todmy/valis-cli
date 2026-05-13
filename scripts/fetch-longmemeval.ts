#!/usr/bin/env node

/**
 * 021/T013: fetch and curate the LongMemEval corpus slice.
 *
 * One-shot data prep. Downloads the upstream LongMemEval question set,
 * deterministically slices to 500 questions, transforms each into the
 * Valis benchmark JSONL schema (one combined line per question), and
 * writes `packages/cli/corpora/longmemeval-sample.jsonl`.
 *
 * Why a separate script, not run-time fetch: corpus is part of the published
 * artifact (data-model.md §"corpus provenance" requires SHA-256 of the file
 * content). A run-time download would change between machines and erase
 * reproducibility.
 *
 * LongMemEval upstream:
 *   https://github.com/xiaowu0162/LongMemEval (Apache-2.0 license per repo).
 *   The maintainer publishes the question set as a single JSON file on the
 *   HuggingFace dataset hub. We accept any of the published mirror URLs;
 *   if the default 404s the operator can pass `--source <url>`.
 *
 * Schema we target per question:
 *   - `document`: full conversation context (history concatenated).
 *   - `query`: the test question.
 *   - `ground_truth.relevant_doc_ids`: a single-element array referring to
 *     the document id (this is point-relevance — LongMemEval has one
 *     correct evidence chunk per question in the `single-session-user`
 *     and `multi-session` slices we use).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const DEFAULT_SOURCE =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPORA_DIR = resolve(HERE, '..', 'corpora');
const OUTPUT_FILE = join(CORPORA_DIR, 'longmemeval-sample.jsonl');
const LICENSE_FILE = join(CORPORA_DIR, 'LICENSE-CORPUS.md');

interface LongMemEvalTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

interface LongMemEvalRecord {
  question_id: string;
  question_type?: string;
  question?: string;
  answer?: string;
  haystack_session_ids?: string[];
  haystack_sessions?: LongMemEvalTurn[][];
  answer_session_ids?: string[];
}

interface CombinedLine {
  document: {
    id: string;
    text: string;
    language: 'mixed';
    metadata?: Record<string, unknown>;
  };
  query: {
    id: string;
    text: string;
    language: 'mixed';
    metadata?: Record<string, unknown>;
  };
  ground_truth: {
    query_id: string;
    relevant_doc_ids: string[];
  };
}

interface FetchOptions {
  source: string;
  count: number;
}

async function fetchJsonl(source: string): Promise<LongMemEvalRecord[]> {
  process.stdout.write(`Fetching corpus from ${source} …\n`);
  const res = await fetch(source);
  if (!res.ok) {
    throw new Error(
      `corpus fetch failed: ${res.status} ${res.statusText} (${source})`,
    );
  }
  const raw = await res.text();
  // Upstream may serve either a single JSON array or NDJSON. Try both.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as LongMemEvalRecord[];
    throw new Error('top-level JSON is not an array');
  } catch {
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as LongMemEvalRecord);
  }
}

// Each LongMemEval session is a long conversation (10-50KB), but we want
// the benchmark to reflect Valis's typical decision-size profile (~500-2000
// chars, ~1 chunk per doc). Truncate to MAX_DOC_CHARS so each session
// generates exactly one Qdrant point — keeps inference cost bounded and
// keeps the retrieval comparison apples-to-apples with the prod corpus.
//
// Truncation strategy: prefer turns with has_answer:true (since those carry
// the relevance signal), then fall back to head-of-conversation up to the
// budget. Methodology page documents this; the curation_rule string in
// LICENSE-CORPUS.md surfaces it in the provenance.
const MAX_DOC_CHARS = 1400;

function sessionText(turns: LongMemEvalTurn[]): string {
  if (!Array.isArray(turns)) return '';
  const ordered = [
    ...turns.filter((t) => t?.has_answer === true && typeof t?.content === 'string'),
    ...turns.filter((t) => t?.has_answer !== true && typeof t?.content === 'string'),
  ];
  const out: string[] = [];
  let used = 0;
  for (const t of ordered) {
    const part = `[${t.role ?? 'msg'}] ${t.content}`;
    if (used + part.length + 2 > MAX_DOC_CHARS) {
      const remaining = MAX_DOC_CHARS - used - 2;
      if (remaining > 80) out.push(part.slice(0, remaining) + '…');
      break;
    }
    out.push(part);
    used += part.length + 2;
  }
  return out.join('\n\n');
}

interface CuratedOutput {
  documentLines: Array<{ document: CombinedLine['document'] }>;
  queryLines: Array<{ query: CombinedLine['query']; ground_truth: CombinedLine['ground_truth'] }>;
  rule: string;
  docCount: number;
  queryCount: number;
}

function curate(records: LongMemEvalRecord[], count: number): CuratedOutput {
  const eligibleTypes = new Set([
    'single-session-user',
    'single-session-assistant',
    'multi-session',
    'temporal-reasoning',
    'knowledge-update',
  ]);
  const eligible = records
    .filter((r) => r.question_type === undefined || eligibleTypes.has(r.question_type))
    .filter((r) => typeof r.question === 'string' && r.question.length > 0)
    .filter((r) => Array.isArray(r.haystack_sessions) && Array.isArray(r.haystack_session_ids))
    .sort((a, b) => a.question_id.localeCompare(b.question_id));

  const sliced = eligible.slice(0, count);

  const documentLines: CuratedOutput['documentLines'] = [];
  const queryLines: CuratedOutput['queryLines'] = [];
  const seenDocIds = new Set<string>();

  for (const r of sliced) {
    const sessionIds = r.haystack_session_ids ?? [];
    const sessions = r.haystack_sessions ?? [];
    const relevantDocIds: string[] = [];

    for (let i = 0; i < sessions.length; i++) {
      const sessionId = sessionIds[i] ?? `${r.question_id}-${i}`;
      const docId = `lme-${sessionId}`;
      const text = sessionText(sessions[i]);
      if (text.length === 0) continue;

      if (!seenDocIds.has(docId)) {
        seenDocIds.add(docId);
        documentLines.push({
          document: {
            id: docId,
            text,
            language: 'mixed',
            metadata: {
              source: 'LongMemEval',
              session_id: sessionId,
              original_question_id: r.question_id,
            },
          },
        });
      }

      const hasAnswer = sessions[i].some((t) => t.has_answer === true);
      const answerListed = (r.answer_session_ids ?? []).includes(sessionId);
      if (hasAnswer || answerListed) relevantDocIds.push(docId);
    }

    if (relevantDocIds.length === 0) continue; // skip queries with no resolvable ground truth

    const queryId = `lme-q-${r.question_id}`;
    queryLines.push({
      query: {
        id: queryId,
        text: r.question ?? '(no question)',
        language: 'mixed',
        metadata: {
          original_question_id: r.question_id,
          question_type: r.question_type,
        },
      },
      ground_truth: {
        query_id: queryId,
        relevant_doc_ids: relevantDocIds,
      },
    });
  }

  const rule = `first ${count} questions of types ${[...eligibleTypes].join(' | ')}, sorted by question_id ASC; one document per haystack_session, ground_truth = sessions with has_answer:true`;
  return {
    documentLines,
    queryLines,
    rule,
    docCount: documentLines.length,
    queryCount: queryLines.length,
  };
}

async function appendLicense(
  corpusId: string,
  source: string,
  rule: string,
  hash: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const entry = `\n## ${corpusId}\n\n- upstream: ${source}\n- license: MIT (per upstream repo LICENSE)\n- fetched_at: ${today}\n- content sha256: \`${hash}\`\n- curation rule: ${rule}\n`;

  let existing = '';
  try {
    const { readFile } = await import('node:fs/promises');
    existing = await readFile(LICENSE_FILE, 'utf-8');
  } catch {
    existing =
      '# Valis benchmark corpora — license registry\n\nThis file tracks the upstream provenance for each JSONL corpus committed under `packages/cli/corpora/`. New corpora MUST append an entry here (021/T014).\n';
  }

  // Replace existing block for the same corpus_id, or append.
  const heading = `## ${corpusId}`;
  if (existing.includes(heading)) {
    const before = existing.split(heading)[0];
    const afterRaw = existing.split(heading)[1] ?? '';
    const after = afterRaw.includes('\n## ')
      ? '\n## ' + afterRaw.split('\n## ').slice(1).join('\n## ')
      : '';
    await writeFile(LICENSE_FILE, before.trimEnd() + entry + after, 'utf-8');
  } else {
    await writeFile(LICENSE_FILE, existing.trimEnd() + entry + '\n', 'utf-8');
  }
}

async function main(opts: FetchOptions): Promise<void> {
  await mkdir(CORPORA_DIR, { recursive: true });
  const records = await fetchJsonl(opts.source);
  process.stdout.write(`Fetched ${records.length} upstream records.\n`);

  const { documentLines, queryLines, rule, docCount, queryCount } = curate(records, opts.count);
  if (queryCount < opts.count) {
    process.stdout.write(
      `WARNING: only ${queryCount} eligible queries with resolvable ground truth (asked for ${opts.count}). Continuing.\n`,
    );
  }

  const jsonl =
    [
      ...documentLines.map((d) => JSON.stringify(d)),
      ...queryLines.map((q) => JSON.stringify(q)),
    ].join('\n') + '\n';
  await writeFile(OUTPUT_FILE, jsonl, 'utf-8');
  const hash = createHash('sha256').update(jsonl).digest('hex');

  await appendLicense('longmemeval-sample', opts.source, rule, hash);

  process.stdout.write(
    `\nWrote ${docCount} documents + ${queryCount} queries to ${OUTPUT_FILE}\n`,
  );
  process.stdout.write(`SHA-256: ${hash}\n`);
  process.stdout.write(`License entry updated: ${LICENSE_FILE}\n\n`);
  process.stdout.write(
    'Next: BENCHMARK_QDRANT_URL=… BENCHMARK_QDRANT_API_KEY=… pnpm valis-bench --corpus longmemeval-sample\n',
  );
}

const program = new Command();
program
  .name('fetch-longmemeval')
  .description('Fetch and curate the LongMemEval benchmark corpus slice (021/T013).')
  .option('-s, --source <url>', 'Override upstream URL', DEFAULT_SOURCE)
  .option('-n, --count <number>', 'Number of questions to slice', (v) => parseInt(v, 10), 500)
  .parse(process.argv);

const opts = program.opts<{ source: string; count: number }>();
main(opts).catch((err: unknown) => {
  console.error('fetch-longmemeval:', err);
  process.exit(1);
});
