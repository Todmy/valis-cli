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
import { isTemplateId, listTemplates } from '../templates/index.js';
import {
  runLoggedInPath,
  runJoinFlow,
  runReconfigure,
  runLegacyMigration,
  runFreshInstall,
} from './init/cases.js';

export interface InitOptions {
  join?: string;
  template?: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(pc.bold('\n🧠 Valis Setup\n'));

  // 024 — Fail fast on mutually-exclusive flags BEFORE any state inspection.
  // `--template` is for newly created projects only; `--join` joins an
  // existing project and would silently seed decisions into someone else's
  // project — a trust-breaking outcome.
  if (options.join && options.template) {
    console.error(
      'Cannot combine --join and --template. Templates only apply to newly created projects.',
    );
    process.exit(2);
  }

  // 024 US1.4 — validate `--template` value against the local registry
  // BEFORE any state inspection or network call. Fail-fast contract.
  if (options.template !== undefined && !isTemplateId(options.template)) {
    const available = listTemplates().map((t) => t.id).join(', ');
    console.error(`Unknown template '${options.template}'. Available: ${available}.`);
    process.exit(2);
  }

  // 024 US1.5 — refuse `--template` when a project is already configured
  // here. Forcing explicit `rm .valis.json` first prevents silent overwrite
  // of an existing project's identity.
  if (options.template) {
    const existingHere = await findProjectConfig(process.cwd());
    if (existingHere) {
      console.error(
        'A project is already configured here. Use `valis switch` to change projects, or remove .valis.json first.',
      );
      process.exit(1);
    }
  }

  const loggedIn = await isLoggedIn();

  // 024 FR-011 — templates require an existing Valis account. The seeding
  // endpoint (`/api/create-project` with `template_id`) needs a known
  // `org_id`, which the fresh-install `register` flow doesn't expose until
  // it has already created a blank project. Community / self-hosted mode
  // also fails this gate (no `tmm_` member key). Route users to the
  // supported path explicitly instead of silently degrading.
  if (options.template && !loggedIn) {
    console.error(
      'Templates require an existing Valis account. Run `valis login` first, then re-run `valis init --template <name>`.',
    );
    process.exit(2);
  }

  // Case A — fast path: user is logged in via `valis login`.
  if (!options.join && loggedIn) {
    return runLoggedInPath(options);
  }

  const existing = await loadConfig();
  const existingProject = await findProjectConfig(process.cwd());

  // Case B — --join <invite-code>.
  if (options.join) {
    return runJoinFlow(options.join, existing);
  }

  // Case C — both global config + .valis.json exist.
  if (existing && existingProject) {
    if (options.template) {
      console.log(
        pc.yellow('`--template` is only used for new projects; ignoring for this flow.'),
      );
    }
    const outcome = await runReconfigure(existing, existingProject);
    // 'switched' and 'cancelled' are terminal — only 'reset' falls through
    // to a full fresh install below.
    if (outcome !== 'reset') return;
  }

  // Case D — global config exists but no .valis.json (legacy migration).
  if (existing && !existingProject) {
    if (options.template) {
      console.log(
        pc.yellow('`--template` is only used for new projects; ignoring for this flow.'),
      );
    }
    return runLegacyMigration(existing);
  }

  // Case E — fresh install (no existing config).
  const outcome = await runFreshInstall(options);
  if (outcome === 'needs_retry') {
    // User chose login mid-flow → recurse so Case A picks up the now-cached
    // credentials.
    return initCommand(options);
  }
}
