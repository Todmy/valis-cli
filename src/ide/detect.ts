import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DetectedIDE {
  name: string;
  configPath: string;
  detected: boolean;
}

export async function detectIDEs(): Promise<DetectedIDE[]> {
  const home = homedir();
  const ides: DetectedIDE[] = [];

  // Claude Code
  const claudeDir = join(home, '.claude');
  const claudeDetected = await exists(claudeDir);
  ides.push({
    name: 'claude-code',
    configPath: join(claudeDir, 'settings.json'),
    detected: claudeDetected,
  });

  // Codex
  const codexDir = join(home, '.codex');
  const codexDetected = await exists(codexDir);
  ides.push({
    name: 'codex',
    configPath: join(codexDir, 'config.json'),
    detected: codexDetected,
  });

  return ides;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
