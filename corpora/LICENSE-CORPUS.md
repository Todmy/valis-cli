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
