/**
 * `valis init` — top-level dispatcher.
 *
 * The original 548-LOC `initCommand` became hard to navigate because five
 * independent setup paths (logged-in fast path, --join, reconfigure,
 * legacy migration, fresh install) lived inline as if/else branches.
 *
 * Decomposition: each case is a Module in `./init/cases.ts` and the helpers
 * those cases share live in `./init/helpers.ts`. This file is now the
 * router: it inspects existing state + options and dispatches to one case.
 *
 * The single external export (`initCommand`) is unchanged — bin/valis.ts
 * imports it the same way as before.
 */

import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { findProjectConfig } from '../config/project.js';
import { isLoggedIn } from '../config/credentials.js';
import {
  runLoggedInPath,
  runJoinFlow,
  runReconfigure,
  runLegacyMigration,
  runFreshInstall,
} from './init/cases.js';

export async function initCommand(options: { join?: string }): Promise<void> {
  console.log(pc.bold('\n🧠 Valis Setup\n'));

  // Case A — fast path: user is logged in via `valis login`.
  if (!options.join && (await isLoggedIn())) {
    return runLoggedInPath();
  }

  const existing = await loadConfig();
  const existingProject = await findProjectConfig(process.cwd());

  // Case B — --join <invite-code>.
  if (options.join) {
    return runJoinFlow(options.join, existing);
  }

  // Case C — both global config + .valis.json exist.
  if (existing && existingProject) {
    const outcome = await runReconfigure(existing, existingProject);
    // 'switched' and 'cancelled' are terminal — only 'reset' falls through
    // to a full fresh install below.
    if (outcome !== 'reset') return;
  }

  // Case D — global config exists but no .valis.json (legacy migration).
  if (existing && !existingProject) {
    return runLegacyMigration(existing);
  }

  // Case E — fresh install (no existing config).
  const outcome = await runFreshInstall();
  if (outcome === 'needs_retry') {
    // User chose login mid-flow → recurse so Case A picks up the now-cached
    // credentials.
    return initCommand(options);
  }
}
