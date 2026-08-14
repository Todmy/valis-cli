/**
 * `valis doctor` — gh#340 (option A).
 *
 * Shows the state of the Valis instruction blocks and offers to migrate a
 * frozen one into the managed shape. The offer is a MIGRATION, never a choice
 * between "overwrite" and "keep": overwrite loses the user's text, keep leaves
 * them behind and asks again next bump. Moving their text into the custom
 * region ends the question — the block upgrades itself from then on.
 *
 * The migration moves the ENTIRE previous block body verbatim. An earlier draft
 * moved only the lines that looked like the user's, computed by subtracting the
 * canonical body — and that is unfixable in principle: a line the user happened
 * to write identically to a canonical one, a blank line holding paragraph
 * structure, or a line quoting a Valis marker would all vanish, under a prompt
 * that says "your text is kept". Verbatim costs some duplicated old policy text
 * the user can trim; the heuristic cost silent loss. (Review round 1, P0.)
 *
 * Writes only after an explicit yes (or `--fix`), only over a block that is
 * still in the state that was shown, always after a backup, always atomically.
 */

import { readFile, writeFile, mkdir, copyFile, chmod, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import select from '@inquirer/select';
import {
  GLOBAL_KR_START,
  GLOBAL_KR_END,
  GLOBAL_KR_BODY,
  PROJECT_VALIS_START,
  PROJECT_VALIS_END,
  KR_POLICY_VERSION,
  composeManagedBody,
  carrierForCustomText,
  extractCustomRegion,
} from '../hooks/self-heal-templates.js';
import {
  detectPolicyDrift,
  inspectContent,
  needsAttention,
  migratable,
  type BlockDrift,
} from '../hooks/policy-drift.js';
import { migrationBackupRoot } from '../hooks/paths.js';
import { findProjectMarker } from '../config/project.js';

async function backup(path: string, label: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(migrationBackupRoot(), 'doctor', label, ts);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, path.split('/').pop() || 'file');
  await copyFile(path, dest);
  try {
    await chmod(dest, 0o600);
  } catch {
    /* non-POSIX */
  }
  return dest;
}

/**
 * Same tmp-then-rename discipline self-heal uses, split in two so the caller can
 * do its last check with only a `rename` left to run. Never truncates in place.
 */
async function stageWrite(path: string, content: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { encoding: 'utf-8' });
  return tmp;
}

function movedHeader(): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    `<!-- Moved here verbatim by \`valis doctor\` on ${today}: everything your`,
    `     previous block contained, including the old policy text. Valis never`,
    `     edits this region — trim whatever you do not need. -->`,
  ].join('\n');
}

/**
 * Rewrite one frozen block as a managed block whose custom region holds the
 * previous block body, verbatim. Returns the backup path.
 *
 * Re-reads and re-validates immediately before writing: `doctor` may have sat
 * at a prompt while the user edited the same file in another window, and
 * writing a block computed from stale bytes would delete that edit (review
 * round 1, P0). If the file moved on, this throws and nothing is written.
 */
export async function migrateBlock(drift: BlockDrift): Promise<string> {
  const [start, end, policyBody] =
    drift.surface === 'global'
      ? [GLOBAL_KR_START, GLOBAL_KR_END, GLOBAL_KR_BODY]
      : [
          PROJECT_VALIS_START,
          PROJECT_VALIS_END,
          (await import('../ide/claude-code.js')).AGENT_INSTRUCTIONS,
        ];

  // ONE read. Everything below — classification, the new block, the identity
  // check before the write — is derived from these exact bytes. Reading twice
  // and classifying the second read is a TOCTOU window wide enough to delete an
  // edit the user made in another window while the prompt was open (review
  // round 2, P0).
  const content = await readFile(drift.path, 'utf-8');

  const fresh = await inspectContent(drift.surface, drift.path, content);
  if (fresh.state !== 'frozen') {
    throw new Error(
      `${drift.path} changed since it was inspected (now: ${fresh.state}) — nothing written; run \`valis doctor\` again`,
    );
  }

  const i = content.indexOf(start);
  const j = content.indexOf(end);
  if (i === -1 || j === -1 || j <= i) {
    throw new Error(`markers not found in ${drift.path}`);
  }

  const previousBody = content.slice(i + start.length, j).replace(/^\n/, '').replace(/\n$/, '');
  const customText = `${movedHeader()}\n\n${previousBody}`;
  const carrier = carrierForCustomText(customText);
  const block = `${start}\n${composeManagedBody(policyBody, carrier)}\n${end}`;

  // Post-condition, not an assumption. If the old body happens to contain one
  // of the four region markers — a CLAUDE.md that documents Valis is the
  // obvious case — the composed block fails the exactly-once validation, the
  // composer falls back to the placeholder, and the entire previous body would
  // vanish under a prompt that promised nothing is dropped. Read the result
  // back and refuse unless it round-trips (review round 2, P0).
  if (extractCustomRegion(block) !== customText) {
    throw new Error(
      `${drift.path} could not be migrated safely: the existing block contains a Valis region marker ` +
        `(valis:policy:* / valis:custom:*), which makes the migrated block ambiguous. ` +
        `Nothing was written — remove or reword that line and run \`valis doctor\` again.`,
    );
  }

  const backupPath = await backup(drift.path, drift.surface);

  // Stage the replacement FIRST, so the identity check below has nothing but a
  // `rename` left to run after it. A save that lands inside that window is lost
  // and the backup does not help — it holds the bytes we read, not the ones the
  // editor wrote (review round 3). The window cannot be closed without file
  // locking; it can be made one syscall wide, which is what this ordering buys.
  const tmp = await stageWrite(
    drift.path,
    content.slice(0, i) + block + content.slice(j + end.length),
  );

  const stillThere = await readFile(drift.path, 'utf-8').catch(() => null);
  if (stillThere !== content) {
    await rm(tmp, { force: true });
    throw new Error(
      `${drift.path} was modified while migrating — nothing written; run \`valis doctor\` again`,
    );
  }

  await rename(tmp, drift.path);
  return backupPath;
}

function describe(d: BlockDrift): string {
  if (d.state === 'malformed') {
    return `  ${d.path}\n    markers are duplicated or incomplete — Valis will not touch this file until that is fixed by hand`;
  }
  if (d.state === 'newer') {
    return (
      `  ${d.path}\n` +
      `    policy version '${d.blockVersion}' is unknown to this CLI (current here: ${KR_POLICY_VERSION})\n` +
      `    a newer Valis wrote it — update the CLI rather than migrating, which would downgrade it`
    );
  }
  const behind =
    d.generationsBehind === 1
      ? '1 policy generation behind'
      : `${d.generationsBehind} policy generations behind`;
  const lines = [
    `  ${d.path}`,
    `    ${behind} (block: ${d.blockVersion ?? 'no version marker'}, current: ${KR_POLICY_VERSION})`,
    `    frozen: the block was edited by hand, so every upgrade has skipped it`,
  ];
  if (d.additions.length) {
    lines.push(`    ${d.additions.length} line(s) look like your own text, e.g.:`);
    for (const l of d.additions.slice(0, 6)) lines.push(`      │ ${l}`);
    if (d.additions.length > 6) lines.push(`      │ … ${d.additions.length - 6} more`);
    lines.push('    (a preview only — migration moves the whole block, not just these)');
  } else {
    lines.push('    no lines of your own detected — the block looks simply stale');
  }
  return lines.join('\n');
}

export interface DoctorOptions {
  /** Migrate every frozen block without asking. */
  fix?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
  const marker = await findProjectMarker();
  const drifts = await detectPolicyDrift(marker?.projectDir);
  const problems = needsAttention(drifts);

  if (problems.length === 0) {
    console.log(`Instruction blocks are current (${KR_POLICY_VERSION}). Nothing to do.`);
    return;
  }

  console.log('Valis instruction blocks that are not receiving policy updates:\n');
  for (const d of problems) console.log(describe(d) + '\n');

  const fixable = migratable(problems);
  if (fixable.length === 0) return;

  console.log(
    'Migrating puts the current policy in a region Valis owns, and moves your\n' +
      'entire previous block, verbatim, into a region it never edits. Nothing is\n' +
      'dropped — including old policy text you can then delete by hand. A backup\n' +
      'is written first, and the block updates itself from then on.\n',
  );

  if (!options.fix) {
    const answer = await select({
      message: 'Migrate these blocks?',
      choices: [
        { name: 'Yes — migrate and keep everything I wrote', value: 'yes' },
        { name: 'No — leave everything as it is', value: 'no' },
      ],
    });
    if (answer !== 'yes') {
      console.log('Left unchanged. Run `valis doctor` again whenever you like.');
      return;
    }
  }

  for (const d of fixable) {
    const backupPath = await migrateBlock(d);
    console.log(`migrated ${d.path}\n  backup: ${backupPath}`);
  }
  console.log(`\nDone — blocks are now on ${KR_POLICY_VERSION} and will upgrade themselves.`);
}
