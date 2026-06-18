# Valis Community Edition

Self-hosted Valis backend with Docker Compose. Your data stays on your
infrastructure. The `valis` CLI talks to this backend exactly as it talks to
the hosted `valis.krukit.co` — via `@supabase/supabase-js` (REST + auth) and
the Qdrant REST API.

## Prerequisites

- **Docker** + **Docker Compose v2** (`docker compose`, not the legacy
  `docker-compose`). The stack runs 6 containers; budget ~2 GB RAM.
- **Node.js 20+** (for the `valis` CLI; 20/22/24 supported).
- **`bash` + `openssl`** on PATH (used by `generate-keys.sh`).
- **`fastembed`** (installed in step 4 below) — self-host generates search
  vectors locally, so this is required for `valis_search` to work.
- Outbound network on first run: pulls the Docker images and downloads the
  local embedding model (~90 MB, once).

## What's included

| Service | Image | Port | Purpose |
|---|---|---|---|
| `db` | `supabase/postgres` | 5432 | Source of truth. Ships the `auth`/`storage` schemas, the `anon`/`authenticated`/`service_role`/`authenticator` roles, the `vector` extension, and the `auth.uid()`/`auth.jwt()` RLS helpers the migrations rely on. |
| `migrate` | `supabase/postgres` | — | One-shot. Applies the **full** Valis schema (all `./migrations/*.sql`) once the db is healthy, then exits. |
| `auth` | `supabase/gotrue` | 9999 (internal) | Supabase Auth — owns `auth.users`, served at `/auth/v1`. |
| `rest` | `postgrest/postgrest` | 3000 (internal) | The REST surface `supabase-js` calls, served at `/rest/v1`. |
| `kong` | `kong` | 8000 (HTTP), 8443 (HTTPS) | API gateway. **This `host:8000` is the Supabase URL the CLI points at.** |
| `qdrant` | `qdrant/qdrant` | 6333 (REST), 6334 (gRPC) | Vector search (local embeddings, 384d + BM25 RRF). |

A bare Postgres is **not** enough: `supabase-js` needs the Supabase REST/auth
layer (PostgREST + GoTrue fronted by Kong). That whole layer is what this stack
provides.

The full current schema is applied on first boot from the co-located
[`./migrations/`](./migrations) directory (mounted read-only). Those files are
a byte-identical mirror of the Valis monorepo's canonical `supabase/migrations/`
— the same schema a hosted instance runs (see `migrations/README.md`).

## Quick start

```bash
# 0. Clone the public repo and enter the community stack
git clone https://github.com/Todmy/valis-cli
cd valis-cli/community

# 1. Configure secrets
cp .env.example .env
./generate-keys.sh          # fills JWT_SECRET, POSTGRES_PASSWORD, ANON_KEY, SERVICE_ROLE_KEY

# 2. Start the backend
docker compose up -d
docker compose ps           # wait for db/auth/kong/qdrant = healthy
docker compose logs migrate # should end: "migrations: N applied, ... (N total)."

# 3. Install the CLI + local embedding engine
npm install -g valis-cli fastembed

# 4. Point the CLI at the backend
valis init
#   Choose: Community
#   Supabase URL:     http://localhost:8000          (the Kong gateway)
#   Service Role Key: <SERVICE_ROLE_KEY value from .env>
#   Qdrant URL:       http://localhost:6333
#   Qdrant API Key:   (leave empty for local)

# 5. Verify connectivity
valis status                # Community mode: confirms Supabase + Qdrant are reachable
```

`generate-keys.sh` prints the exact values to paste into `valis init`.

### How you actually use it

Storing and searching decisions are **MCP tools** (`valis_store`,
`valis_search`, `valis_context`, …), not shell commands — your AI agent calls
them. `valis init` wires the MCP server into your IDE (Claude Code hooks /
Cursor `.cursorrules`), so once init finishes, the agent has team memory
automatically. To run the MCP server manually (e.g. to test or for a custom
client): `valis serve`. Use `valis status` any time to check the backend
connection.

## Configuration

All config lives in `.env` (copied from `.env.example`). The keys a
self-hoster must set:

| Variable | Set by | Description |
|---|---|---|
| `POSTGRES_PASSWORD` | `generate-keys.sh` | DB superuser + service-role password. |
| `JWT_SECRET` | `generate-keys.sh` | Symmetric (HS256) secret used to sign **and** verify every JWT. Must be ≥32 chars. PostgREST and GoTrue both verify against it. |
| `ANON_KEY` | `generate-keys.sh` | A JWT signed with `JWT_SECRET`, claim `role: anon`. |
| `SERVICE_ROLE_KEY` | `generate-keys.sh` | A JWT signed with `JWT_SECRET`, claim `role: service_role`. **This is the key the CLI uses** — it bypasses RLS. |
| `KONG_HTTP_PORT` | you (default `8000`) | Gateway port = the Supabase URL host port. |
| `POSTGRES_PORT` / `QDRANT_HTTP_PORT` / `QDRANT_GRPC_PORT` / `KONG_HTTPS_PORT` | you | Host port overrides if the defaults collide. |

> **Keys are real JWTs, not free-form strings.** `ANON_KEY` and
> `SERVICE_ROLE_KEY` must be HS256 JWTs signed with `JWT_SECRET` and carrying
> the right `role` claim — PostgREST reads `role` to pick the Postgres role,
> and Kong validates the key as an `apikey`. **Always use `generate-keys.sh`**;
> never hand-write these. Re-run the script whenever you change `JWT_SECRET`.

### Resulting CLI config

After `valis init` (Community), `~/.valis/config.json` looks like:

```json
{
  "supabase_url": "http://localhost:8000",
  "supabase_service_role_key": "<SERVICE_ROLE_KEY>",
  "qdrant_url": "http://localhost:6333",
  "qdrant_api_key": ""
}
```

## Search embeddings (local, via fastembed)

Hosted Valis uses Qdrant Cloud's managed inference
(`intfloat/multilingual-e5-small`, 384d). Self-host has **no** managed
inference, so the CLI embeds locally with the optional
[`fastembed`](https://www.npmjs.com/package/fastembed) dependency:

- Install it alongside the CLI: `npm install -g fastembed`.
- Self-host **auto-selects** the local (client) embedding strategy when no
  Qdrant API key is set. To force it explicitly: `export
  QDRANT_EMBEDDING_STRATEGY=client`.
- Model: **`all-MiniLM-L6-v2`** (384d — the only fastembed model matching the
  collection schema). It downloads once on first use (~90 MB).

> **Caveat — vectors are not interchangeable with hosted.** The local model
> (`all-MiniLM-L6-v2`) is **not** the hosted model (`e5-small`), so vectors
> produced by a self-host instance are not comparable with hosted vectors. Each
> instance is internally consistent (it indexes and queries with the same
> model); you just can't mix the two corpora. On a hosted↔self-host migration,
> Postgres (the source of truth) ports cleanly and Qdrant is **re-embedded**
> from it — no data is lost.

## How the schema gets applied

The `supabase/postgres` image owns `/docker-entrypoint-initdb.d` (it bootstraps
roles + the `auth`/`storage` schemas there), so we do **not** mount over it.
Instead the one-shot `migrate` service:

1. Sets login passwords for `authenticator` + `supabase_auth_admin` (the image
   creates the roles but leaves passwords unset).
2. Runs `init-db/00_auth_compat.sql` — provides `auth.users` (FK target for
   migration 009) and `auth.jwt()`, owned by `supabase_auth_admin` so GoTrue's
   own migrations can adopt them.
3. Applies every `./migrations/*.sql` in order, recording each in a
   `public.valis_schema_migrations` ledger so re-runs are idempotent.

`auth`, `rest`, and `kong` only start after `migrate` completes successfully.

## Upgrading

Keep two things in step when a new Valis version ships: the **schema** (this
stack) and the **CLI binary**.

```bash
# 1. Update the schema
cd valis-cli/community
git pull                       # gets the new ./migrations/*.sql
docker compose up -d migrate   # re-runs the one-shot; applies ONLY new files

# 2. Update the CLI
npm install -g valis-cli@latest
```

The ledger skips already-applied migrations (`N applied, M already present`),
so step 1 is always safe to re-run and never touches existing data. Migrations
are additive-only (enforced by a CI lint), so applying new ones to a populated
DB does not drop or rewrite your data.

### Schema ↔ CLI version compatibility

In Community mode the CLI checks, on `valis init` and `valis serve`, that its
expected schema version matches your DB's applied migrations:

- **DB behind the CLI** (you updated the CLI but not the schema) → the CLI
  **stops** with: *"Self-host schema out of date (DB at NNN, this CLI needs
  MMM). Update it: cd valis-cli/community && git pull && docker compose up -d"*.
  Fix: run the schema-update step above. It refuses to write to an incompatible
  schema rather than corrupt data.
- **DB ahead of the CLI** (you updated the schema but not the CLI) → a
  **warning** only: *"Self-host schema is newer than this CLI; update with npm
  i -g valis-cli@latest"*. It keeps working (new migrations are additive).
- **In sync** → silent.

## Data persistence

Docker volumes:
- `db_data` — all decisions, orgs, members, audit trail, auth users
- `qdrant_data` — vector search index

Backup / restore:
```bash
docker compose exec db pg_dump -U postgres postgres > backup.sql
docker compose exec -T db psql -U postgres postgres < backup.sql
```

## Stopping

```bash
docker compose down        # stop, data preserved
docker compose down -v     # stop and DELETE all data
```

## Troubleshooting

- **Ports already in use** (`5432`/`6333`/`8000` taken) → set
  `POSTGRES_PORT` / `QDRANT_HTTP_PORT` / `KONG_HTTP_PORT` (and
  `API_EXTERNAL_URL` to match the new Kong port) in `.env`, then
  `docker compose up -d`.
- **`valis search` errors about fastembed / a missing module** → install the
  embedder: `npm install -g fastembed`. The first search after install
  downloads the model (~90 MB); give it a moment.
- **`Client version X is incompatible with server version Y`** (Qdrant) →
  cosmetic warning only ([#300](https://github.com/Todmy/valis-cli/issues/300));
  all operations work. Safe to ignore.
- **`migrate` exited without applying anything** → check
  `docker compose logs migrate`; ensure `./migrations/*.sql` exist (a partial
  clone can miss them) and the `db` service is healthy first.
- **"schema out of date" on `valis init`** → expected when the CLI is newer
  than the DB; run the [upgrade](#upgrading) step.
- **Auth/REST unhealthy** → almost always a key mismatch. Re-run
  `./generate-keys.sh` (so `ANON_KEY`/`SERVICE_ROLE_KEY` are signed with the
  current `JWT_SECRET`) and `docker compose up -d --force-recreate`.

## Differences from hosted mode

| Feature | Hosted | Community |
|---|---|---|
| Setup | Zero-config | Docker Compose + `generate-keys.sh` |
| Edge Functions | Cloud (13 functions) | Not needed — CLI uses the service-role key directly against PostgREST |
| Search embeddings | Qdrant Cloud managed inference (`e5-small`) | Local `fastembed` (`all-MiniLM-L6-v2`, 384d) — install the `fastembed` package |
| Push | Supabase Realtime (cloud) | Not available (pull-only) |
| `set_config` RPC | Present | Not defined in the open migrations — the CLI calls it best-effort and silently no-ops; RLS still works via explicit `org_id` filters |
| Cross-org public-KB read | Service-role server path | Not available from stdio CLI |
| Billing | Stripe | No limits |
| Data location | Supabase + Qdrant Cloud | Your machine |
