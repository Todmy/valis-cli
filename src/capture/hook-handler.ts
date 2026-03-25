import { createServer, type Server } from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

let server: Server | null = null;

type HookCallback = (event: string, data: unknown) => void;

export function startHookHandler(onHook: HookCallback): Promise<number> {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/hook/stop') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            onHook('stop', data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    server.listen(0, '127.0.0.1', async () => {
      const address = server!.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      // Save port for Claude Code stop hook
      const portFile = join(homedir(), '.valis', 'hook-port');
      await mkdir(join(homedir(), '.valis'), { recursive: true, mode: 0o700 });
      await writeFile(portFile, String(port));

      console.error(`Hook handler listening on 127.0.0.1:${port}`);
      resolve(port);
    });

    server.on('error', reject);
  });
}

export function stopHookHandler(): void {
  if (server) {
    server.close();
    server = null;
  }
}
