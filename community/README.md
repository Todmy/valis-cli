# Valis Community Edition

Self-hosted Valis backend with Docker Compose. Your data stays on your
infrastructure. The `valis` CLI talks to this backend exactly as it talks to
the hosted `valis.krukit.co` — via `@supabase/supabase-js` (REST + auth) and
the Qdrant REST API.

## What's included

| Service | Image | Port | Purpose |
|---|---|---|---|
| `db` | `supabase/postgres` | 5432 | Source of truth. Ships the `auth`/`storage` schemas, the `anon`/`authenticated`/`service_role`/`authenticator` roles, the `vector` extension, and the `auth.uid()`/`auth.jwt()` RLS helpers the migrations rely on. |
| `migrate` | `supabase/postgres` | — | One-shot. Applies the **full** Valis schema (all `./migrations/*.sql`) once the db is healthy, then exits. |
| `auth` | `supabase/gotrue` | 9999 (internal) | Supabase Auth — owns `auth.users`, served at `/auth/v1`. |
| `rest` | `postgrest/postgrest` | 3000 (internal) | The REST surface `supabase-js` calls, served at `/rest/v1`. |
| `kong` | `kong` | 8000 (HTTP), 8443 (HTTPS) | API gateway. **This `host:8000` is the Supabase URL the CLI points at.** |
| `qdrant` | `qdrant/qdrant` | 6333 (REST), 6334 (gRPC) | Vector search (e5-small 384d + BM25 RRF). |

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

# 3. Point the CLI at it
npm install -g valis-cli
valis init
#   Choose: Community
#   Supabase URL:     http://localhost:8000          (the Kong gateway)
#   Service Role Key: <SERVICE_ROLE_KEY value from .env>
#   Qdrant URL:       http://localhost:6333
#   Qdrant API Key:   (leave empty for local)
```

`generate-keys.sh` prints the exact values to paste into `valis init`.

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

## Upgrading the schema

New Valis migrations land in `./migrations/` (synced from the monorepo
canonical). To apply them to a running self-host DB:

```bash
git pull                       # gets the new ./migrations/*.sql
docker compose up -d migrate   # re-runs the one-shot; applies only new files
```

The ledger skips already-applied migrations, so this is safe to re-run.

## Differences from hosted mode

| Feature | Hosted | Community |
|---|---|---|
| Setup | Zero-config | Docker Compose + `generate-keys.sh` |
| Edge Functions | Cloud (13 functions) | Not needed — CLI uses the service-role key directly against PostgREST |
| Search embeddings | Qdrant Cloud (managed inference) | Local Qdrant (supply your own vectors / BM25 fallback) |
| Push | Supabase Realtime (cloud) | Not available (pull-only) |
| `set_config` RPC | Present | Not defined in the open migrations — the CLI calls it best-effort and silently no-ops; RLS still works via explicit `org_id` filters |
| Cross-org public-KB read | Service-role server path | Not available from stdio CLI |
| Billing | Stripe | No limits |
| Data location | Supabase + Qdrant Cloud | Your machine |
