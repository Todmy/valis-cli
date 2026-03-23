import pc from 'picocolors';
import { loadConfig, updateConfig } from '../config/store.js';
import { exchangeToken } from '../auth/jwt.js';

/**
 * One-time migration from org-level (legacy) auth to per-member JWT auth.
 *
 * Flow:
 * 1. Verify current auth is legacy (org-level key)
 * 2. Call exchange-token to get JWT + member details
 * 3. Update local config with auth_mode: 'jwt'
 * 4. Test round-trip with new auth
 * 5. Print status
 */
export async function migrateAuthCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Teamind not configured. Run `teamind init` first.');
    process.exit(1);
  }

  // 1. Verify current auth is legacy
  if (config.auth_mode === 'jwt') {
    console.log(pc.yellow('Already using per-member JWT auth. No migration needed.'));
    return;
  }

  console.log(pc.bold('\nMigrating to per-member auth...\n'));

  // Determine which key to use — prefer member_api_key if available
  const apiKey = config.member_api_key || config.api_key;

  // 2. Call exchange-token
  console.log('  Exchanging API key for JWT token...');
  const resp = await exchangeToken(config.supabase_url, apiKey);

  if (!resp) {
    console.error(
      pc.red('\nToken exchange failed. Ensure your API key is valid and the server is reachable.'),
    );
    process.exit(1);
  }

  console.log(`  ${pc.green('OK')} — token received for ${resp.author_name} (${resp.role})`);

  // 3. Update local config
  console.log('  Updating local config...');
  await updateConfig({
    auth_mode: 'jwt',
    member_api_key: config.member_api_key || null,
    member_id: resp.member_id,
  });

  console.log(`  ${pc.green('OK')} — auth_mode set to jwt`);

  // 4. Test round-trip — exchange again to confirm config is coherent
  console.log('  Testing round-trip auth...');
  const verify = await exchangeToken(config.supabase_url, apiKey);

  if (!verify) {
    console.error(
      pc.yellow('\nWarning: Round-trip verification failed. Config was updated but auth may be unstable.'),
    );
    return;
  }

  console.log(`  ${pc.green('OK')} — round-trip verified`);

  // 5. Print status
  console.log(pc.bold(pc.green('\nMigration complete.')));
  console.log(
    'Migrated to per-member auth. Org-level key still works for other members until admin disables it.',
  );
  console.log(`  Member:    ${resp.author_name}`);
  console.log(`  Role:      ${resp.role}`);
  console.log(`  Org:       ${resp.org_name}`);
  console.log(`  Auth mode: jwt`);
  console.log();
}
