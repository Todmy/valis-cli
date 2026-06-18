# Migrations — generated mirror (do not hand-edit)

The `*.sql` files in this directory are a **byte-identical read-only mirror**
of the canonical schema in the Valis monorepo at `supabase/migrations/`. That
monorepo set is the single source of truth — it is shared with the hosted
production backend.

These copies exist only so that a self-hoster who clones this public repo can
`docker compose up` and have the `migrate` service apply the schema from a
co-located `./migrations` directory (the monorepo's `../supabase/migrations`
does not exist here).

## Rules

- **Do not edit these files by hand.** Any drift from canonical will fail the
  monorepo CI drift-guard.
- To change the schema: edit the canonical files in the monorepo
  `supabase/migrations/`, then regenerate this mirror with
  `scripts/sync-selfhost-migrations.sh` (run from the monorepo root).
- The drift-guard `diff`s this directory against the canonical set on every CI
  run and fails on any mismatch.
