import pc from 'picocolors';
import { loadConfig } from '../config/store.js';
import { isHostedMode, resolveMcpEndpoint } from '../cloud/api-url.js';
import { flushQueue, getCount } from '../offline/queue.js';

export async function syncCommand(): Promise<void> {
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Valis not configured. Run `valis init` first.');
    process.exit(1);
  }

  if (!isHostedMode(config)) {
    console.log(pc.yellow('Sync is only available in hosted mode'));
    return;
  }

  const count = await getCount();
  if (count === 0) {
    console.log(pc.dim('No pending items'));
    return;
  }

  console.log(`Syncing ${pc.bold(String(count))} pending item(s)...`);

  const mcpEndpoint = resolveMcpEndpoint(config);
  const bearerToken = config.member_api_key || config.api_key;
  const result = await flushQueue(mcpEndpoint, bearerToken);

  console.log(
    `Synced ${pc.green(String(result.synced))}, ` +
      `failed ${pc.red(String(result.failed))}, ` +
      `${pc.dim(String(result.remaining))} remaining`,
  );
}
