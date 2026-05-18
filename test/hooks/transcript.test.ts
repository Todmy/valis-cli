/**
 * Unit tests for transcript.ts — JSONL token estimator for capture-reminder
 * token-density scheduling.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptTokens } from '../../src/hooks/transcript.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'valis-transcript-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('readTranscriptTokens', () => {
  it('returns null when path is undefined', async () => {
    const result = await readTranscriptTokens(undefined);
    expect(result).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    const result = await readTranscriptTokens(join(tmpDir, 'missing.jsonl'));
    expect(result).toBeNull();
  });

  it('returns zero tokens for empty file', async () => {
    const path = join(tmpDir, 'empty.jsonl');
    await writeFile(path, '');
    const result = await readTranscriptTokens(path);
    expect(result).toEqual({ totalTokens: 0, totalBytes: 0 });
  });

  it('skips malformed lines but parses valid ones', async () => {
    const path = join(tmpDir, 'mixed.jsonl');
    const content =
      '{"message":{"content":"hello world"}}\n' +
      'this is not json\n' +
      '{"message":{"content":"another valid record"}}\n';
    await writeFile(path, content);
    const result = await readTranscriptTokens(path);
    expect(result).not.toBeNull();
    expect(result!.totalTokens).toBeGreaterThan(0);
    expect(result!.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'));
  });

  it('sums tokens across nested content shapes', async () => {
    const path = join(tmpDir, 'nested.jsonl');
    // Two records: one with flat string content, one with array of typed blocks.
    const records = [
      JSON.stringify({ message: { content: 'a'.repeat(40) } }),
      JSON.stringify({
        message: {
          content: [
            { type: 'text', text: 'b'.repeat(40) },
            { type: 'tool_use', input: { query: 'c'.repeat(40) } },
          ],
        },
      }),
    ];
    await writeFile(path, records.join('\n') + '\n');
    const result = await readTranscriptTokens(path);
    expect(result).not.toBeNull();
    // 3 strings of 40 chars + newlines between them, at chars/4.
    expect(result!.totalTokens).toBeGreaterThanOrEqual(Math.ceil((40 * 3) / 4));
  });

  it('reports current file size in bytes', async () => {
    const path = join(tmpDir, 'size.jsonl');
    const content = '{"message":{"content":"hello"}}\n';
    await writeFile(path, content);
    const result = await readTranscriptTokens(path);
    expect(result).not.toBeNull();
    expect(result!.totalBytes).toBe(Buffer.byteLength(content, 'utf-8'));
  });
});
