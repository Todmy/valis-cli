#!/usr/bin/env bash
# Apply the FULL Valis schema from the real migrations directory.
#
# Run by the one-shot `migrate` service once the db is healthy. The
# ./migrations/*.sql files are mounted read-only at /valis-migrations. These
# are a byte-identical mirror of the monorepo canonical supabase/migrations/,
# kept in sync by scripts/sync-selfhost-migrations.sh + a CI drift-guard, so
# self-host never drifts from hosted. A schema_migrations ledger makes re-runs
# idempotent: each file
# is applied at most once, even though this service runs on every
# `docker compose up`.
#
# Connects over the network to the db service as the `postgres` superuser
# (created by the supabase/postgres image's own bootstrap).

set -euo pipefail

MIGRATIONS_DIR=/valis-migrations
PREP_DIR=/prep

export PGHOST="${PGHOST:-db}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:?PGPASSWORD must be set (= POSTGRES_PASSWORD)}"
export PGDATABASE="${PGDATABASE:-postgres}"

psql_run() { psql -v ON_ERROR_STOP=1 --no-psqlrc "$@"; }

echo "[valis] waiting for ${PGHOST}:${PGPORT} ..."
until pg_isready -q; do sleep 1; done

# Ledger of applied migrations.
psql_run -c "CREATE TABLE IF NOT EXISTS public.valis_schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);"

# Set login passwords for the Supabase service roles (the image creates the
# roles but leaves passwords unset). `authenticator` etc. are reserved roles —
# only a superuser may ALTER them, and the image demotes `postgres`, so this
# step connects as supabase_admin (the real superuser; its password is set to
# POSTGRES_PASSWORD by the image bootstrap).
if [ -f "$PREP_DIR/00_role_passwords.sql" ]; then
  echo "[valis]   prep: 00_role_passwords.sql (as supabase_admin)"
  psql_run -U supabase_admin -v pg_password="$PGPASSWORD" -f "$PREP_DIR/00_role_passwords.sql"
fi

# Remaining prep SQL (auth.users stub + auth.jwt helper). Run as supabase_admin
# so it can hand ownership to supabase_auth_admin (GoTrue replaces these on its
# own first boot). Applied every run; all statements are idempotent.
if [ -d "$PREP_DIR" ]; then
  shopt -s nullglob
  for f in "$PREP_DIR"/*.sql; do
    [ "$(basename "$f")" = "00_role_passwords.sql" ] && continue
    echo "[valis]   prep: $(basename "$f") (as supabase_admin)"
    psql_run -U supabase_admin -f "$f"
  done
fi

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[valis] ERROR: ${MIGRATIONS_DIR} not mounted" >&2
  exit 1
fi

shopt -s nullglob
applied=0
skipped=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$f")"
  already="$(psql_run -tAc "SELECT 1 FROM public.valis_schema_migrations WHERE filename = '${name}'")"
  if [ "$already" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "[valis]   applying ${name} ..."
  psql_run -f "$f"
  psql_run -c "INSERT INTO public.valis_schema_migrations(filename) VALUES ('${name}')"
  applied=$((applied + 1))
done

total=$(( applied + skipped ))
if [ "$total" -eq 0 ]; then
  echo "[valis] ERROR: no *.sql files found in ${MIGRATIONS_DIR}" >&2
  exit 1
fi

echo "[valis] migrations: ${applied} applied, ${skipped} already present (${total} total)."
