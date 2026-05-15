# Valis benchmark corpora — license registry

This file tracks the upstream provenance for each JSONL corpus committed under `packages/cli/corpora/`. New corpora MUST append an entry here (021/T014).

Each entry records: upstream URL, SPDX license identifier, fetch date, SHA-256 of the JSONL file contents, and the human-readable curation rule that selected which records ended up in the slice.

The SHA-256 surfaces silent corpus drift: if two runs of `valis-bench` produce different R@5 numbers against the same `corpus_id`, the artifact's `corpus_provenance.content_hash` vs `latest.json`'s value tells you whether data drift or code drift is responsible.

---

<!-- entries appended by `packages/cli/scripts/fetch-longmemeval.ts` and sibling fetchers -->
## longmemeval-sample

- upstream: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
- license: MIT (per upstream repo LICENSE)
- fetched_at: 2026-05-13
- content sha256: `e7ab1376fd99e5653362b595b51efc74adea01838a5de942db93e47c8c1b0249`
- curation rule: first 500 questions of types single-session-user | single-session-assistant | multi-session | temporal-reasoning | knowledge-update, sorted by question_id ASC; one document per haystack_session, ground_truth = sessions with has_answer:true

## valis-multilingual-en

- upstream: https://github.com/Todmy/valis (Valis-authored)
- license: Apache-2.0
- fetched_at: 2026-05-15
- content sha256: `a37bce0a50b3d4fa021223fbbb0a5be51ffd23f033d1adae500cf3834239949a`
- curation rule: 51 EN team-decision documents + 50 queries with ground_truth, hand-authored to reflect the team-decision profile across 13 topic clusters (auth, deployment, error handling, observability, contracts, data/storage, testing, performance, API design, dev workflow, frontend, search/retrieval, RBAC/billing). Each document is ~200-500 chars; queries mix single-doc (~70%) and multi-doc (~30%) relevance to exercise both precision and recall.

## valis-multilingual-uk (deferred)

- upstream: derived from valis-multilingual-en
- license: Apache-2.0
- regeneration: `pnpm tsx packages/cli/scripts/translate-corpus.ts --source valis-multilingual-en --target uk` (script TODO; CorpusTranslator deep module is shipped in `src/benchmarks/corpus-translator.ts`)
- blocked on: DeepL Free API key (env `DEEPL_API_KEY`); founder UA spot-check pass on 10/15 samples
- curation rule: 1:1 translation of EN slice via DeepL; preserves IDs + ground_truth; `metadata.translation` records provenance per line

## valis-multilingual-pl (deferred)

- upstream: derived from valis-multilingual-en
- license: Apache-2.0
- regeneration: same script as uk with `--target pl`
- blocked on: same DeepL key
- curation rule: same as uk, with target=pl
