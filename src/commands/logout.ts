import pc from 'picocolors';
import { clearCredentials, isLoggedIn } from '../config/credentials.js';

export async function logoutCommand(): Promise<void> {
  const loggedIn = await isLoggedIn();

  if (!loggedIn) {
    console.log(pc.dim('Not logged in.'));
    return;
  }

  await clearCredentials();
  console.log(pc.green('✓ Logged out'));
}
