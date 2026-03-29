import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Open a URL in the user's default browser.
 * Returns true if browser was opened, false if skipped/failed.
 * Never throws — failures are silent.
 */
export async function openBrowser(url: string): Promise<boolean> {
  // Validate URL scheme
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return false;
  } catch {
    return false;
  }

  // Skip in headless environments
  if (
    process.env.BROWSER === 'none' ||
    process.env.SSH_TTY ||
    (!process.env.DISPLAY && platform() === 'linux')
  ) {
    return false;
  }

  const cmd = platform() === 'darwin'
    ? 'open'
    : platform() === 'win32'
      ? 'cmd'
      : 'xdg-open';

  const args = platform() === 'win32'
    ? ['/c', 'start', '', url]
    : [url];

  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000 }, (err) => {
        resolve(!err);
      });
    } catch {
      resolve(false);
    }
  });
}
