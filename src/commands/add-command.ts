import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import select from '@inquirer/select';
import input from '@inquirer/input';
import pc from 'picocolors';

export async function addCommandCommand(name?: string): Promise<void> {
  // 1. Get command name
  const commandName = name || await input({ message: 'Command name (without valis- prefix):' });
  const fullName = `valis-${commandName}`;
  const filename = `${fullName}.md`;

  // 2. Ask global or local
  const scope = await select({
    message: `Where should /${fullName} be available?`,
    choices: [
      { name: 'Global (all projects)', value: 'global' },
      { name: 'This project only', value: 'local' },
    ],
  });

  const dir = scope === 'global'
    ? join(homedir(), '.claude', 'commands')
    : join(process.cwd(), '.claude', 'commands');

  const filePath = join(dir, filename);

  // 3. Check if already exists
  if (existsSync(filePath)) {
    console.log(pc.yellow(`Command /${fullName} already exists at ${filePath}`));
    return;
  }

  // 4. Get description
  const description = await input({
    message: 'What does this command do?',
    default: `Custom Valis command: ${commandName}`,
  });

  // 5. Create the command file
  const template = `---
description: ${description}
---

## Task
$ARGUMENTS

## Steps
1. Call valis_search to check relevant team decisions
2. [Add your steps here]
3. Call valis_store if new decisions or lessons emerge
`;

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, template);

  console.log(pc.green(`✓ Created /${fullName}`));
  console.log(pc.dim(`  ${filePath}`));
  console.log(pc.dim(`  Edit the file to customize the command behavior.`));
}
