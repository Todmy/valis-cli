/**
 * Single source of truth for the CLI version.
 *
 * Reads from package.json at build time via a JSON import — webpack and
 * Next.js inline the JSON contents, tsc handles it via `resolveJsonModule`.
 * Earlier `fs.readFileSync(import.meta.url)` resolution worked locally but
 * blew up at runtime when web bundled this module into a Next.js route:
 * `__dirname` resolved relative to the bundled `.next/server/app/api/...`
 * directory, not the original `dist/src/`, so the relative path missed.
 *
 * Path math: src/index.ts compiled to dist/src/index.js. The published
 * package.json sits at packages/cli/package.json — two levels up from the
 * compiled file. tsc rewrites this import to a JS-side require() of the
 * inlined JSON, so the runtime never opens a file at all.
 */

import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
