import pc from 'picocolors';
import { loadCredentials } from '../config/credentials.js';

export async function whoamiCommand(): Promise<void> {
  const creds = await loadCredentials();

  if (!creds) {
    console.log('Not logged in. Run `valis login`');
    return;
  }

  console.log(`  Name: ${pc.bold(creds.author_name)}`);
  console.log(`  Org:  ${pc.cyan(creds.org_name)}`);
  console.log(`  ID:   ${pc.dim(creds.member_id)}`);
}
