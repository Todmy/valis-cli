/**
 * Single source of truth for the CLI version.
 *
 * Reads from the published package.json at runtime so a release bump
 * (`pnpm version`) propagates to `valis -V`, MCP server `clientInfo`,
 * and the proxy handshake without manual sync. Previously the version
 * lived in 4 places, which silently desynced (bug discovered when
 * 0.1.8 published to npm but `valis -V` still reported 0.1.7).
 *
 * Path math: src/index.ts compiles to dist/src/index.js. The repo's
 * package.json sits at packages/cli/package.json — i.e. two levels up
 * from the compiled file. npm tarballs always include package.json
 * at the package root, so `../../package.json` resolves correctly in
 * an installed copy too.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, '..', '..', 'package.json'), 'utf8'),
) as { version: string };

export const VERSION: string = pkg.version;
