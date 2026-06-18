#!/usr/bin/env node
/**
 * Prebuild generator — derives the schema-migration version this CLI expects
 * from the MAX migration filename in `community/migrations/` (the byte-identical
 * mirror of the monorepo canonical `supabase/migrations/`).
 *
 * Writes `src/generated/schema-version.ts` with the parsed numeric prefix as
 * `REQUIRED_SCHEMA_MIGRATION`. Runs as the package `prebuild` step so the value
 * can never drift from the shipped migration set: every `pnpm build` regenerates
 * it. The generated file is gitignored (see .gitignore) — it is a pure build
 * artifact derived from the migrations on disk.
 *
 * The Community version-guard (`src/cloud/schema-guard.ts`) compares this value
 * against the max applied migration in the self-host `valis_schema_migrations`
 * ledger.
 */

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'community', 'migrations');
const OUT_DIR = join(PKG_ROOT, 'src', 'generated');
const OUT_FILE = join(OUT_DIR, 'schema-version.ts');

function maxMigrationNumber() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  let max = 0;
  for (const f of files) {
    const m = /^(\d+)/.exec(f);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    if (n > max) max = n;
  }
  if (max === 0) {
    throw new Error(
      `No numeric-prefixed *.sql migrations found in ${MIGRATIONS_DIR}`,
    );
  }
  return max;
}

const required = maxMigrationNumber();

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by scripts/gen-schema-version.mjs (the package \`prebuild\` step)
 * from the MAX migration filename in community/migrations/. Regenerated on
 * every \`pnpm build\`. Gitignored — never commit.
 */
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT_FILE,
  `${banner}\nexport const REQUIRED_SCHEMA_MIGRATION = ${required};\n`,
  'utf-8',
);

console.log(
  `[gen-schema-version] REQUIRED_SCHEMA_MIGRATION=${required} → src/generated/schema-version.ts`,
);
