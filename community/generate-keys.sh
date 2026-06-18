#!/usr/bin/env bash
# Generate JWT_SECRET + the anon / service_role API keys for the self-host
# stack and write them into ./.env (in place). Idempotent: re-running rotates
# the keys to match the current JWT_SECRET.
#
# The anon / service_role keys are HS256 JWTs signed with JWT_SECRET, carrying
# `role: anon` / `role: service_role`. PostgREST trusts the `role` claim to
# switch into the matching Postgres role; Kong validates the key as an apikey.
#
# Requires: node (the same runtime that ships valis-cli) + openssl.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env found. Run:  cp .env.example .env  first." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required (it ships with the valis-cli install)." >&2
  exit 1
fi

# --- ensure a strong JWT_SECRET (>=32 chars) -------------------------------
JWT_SECRET="$(grep -E '^JWT_SECRET=' .env | head -1 | cut -d= -f2-)"
if [ -z "$JWT_SECRET" ] || [ "${#JWT_SECRET}" -lt 32 ] || [ "$JWT_SECRET" = "change-me-to-a-32-char-min-random-secret" ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  echo "Generated a fresh JWT_SECRET."
fi

# --- ensure a strong POSTGRES_PASSWORD -------------------------------------
PG_PW="$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d= -f2-)"
if [ -z "$PG_PW" ] || [ "$PG_PW" = "change-me-to-a-long-random-password" ]; then
  PG_PW="$(openssl rand -hex 24)"
  echo "Generated a fresh POSTGRES_PASSWORD."
fi

# --- sign the anon + service_role JWTs (HS256) -----------------------------
JWT_EXPIRY="$(grep -E '^JWT_EXPIRY=' .env | head -1 | cut -d= -f2- || true)"
JWT_EXPIRY="${JWT_EXPIRY:-3600}"

sign_key() {
  local role="$1"
  JWT_SECRET="$JWT_SECRET" ROLE="$role" node -e '
    const crypto = require("crypto");
    const secret = process.env.JWT_SECRET;
    const role = process.env.ROLE;
    const b64 = (o) => Buffer.from(JSON.stringify(o))
      .toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const payload = { role, iss: "valis-community", iat: now, exp: now + 60 * 60 * 24 * 365 * 5 };
    const data = b64(header) + "." + b64(payload);
    const sig = crypto.createHmac("sha256", secret).update(data)
      .digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    process.stdout.write(data + "." + sig);
  '
}

ANON_KEY="$(sign_key anon)"
SERVICE_ROLE_KEY="$(sign_key service_role)"

# --- write back into .env (portable in-place edit) -------------------------
set_kv() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # use a temp file to avoid sed -i portability issues across macOS/Linux
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

set_kv JWT_SECRET "$JWT_SECRET"
set_kv POSTGRES_PASSWORD "$PG_PW"
set_kv ANON_KEY "$ANON_KEY"
set_kv SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"

echo "Wrote JWT_SECRET, POSTGRES_PASSWORD, ANON_KEY, SERVICE_ROLE_KEY into .env"
echo
echo "Point the CLI at this backend with:"
echo "  Supabase URL:      http://localhost:$(grep -E '^KONG_HTTP_PORT=' .env | cut -d= -f2- || echo 8000)"
echo "  Service Role Key:  (SERVICE_ROLE_KEY value in .env)"
echo "  Qdrant URL:        http://localhost:$(grep -E '^QDRANT_HTTP_PORT=' .env | cut -d= -f2- || echo 6333)"
