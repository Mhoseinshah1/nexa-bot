import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Codex review of #183, finding 9: `process.exit()` inside the CLI's `try` truncated piped
 * output (Node discards what a pipe has not yet taken — 64 KiB here) and skipped the
 * `finally` that shuts the container down. The CLI now returns its code, and exits only
 * through `exitAfterDrain`, once stdout and stderr have flushed.
 */

const ROOT = resolve(__dirname, '../..');
const TSX = resolve(ROOT, 'apps/api/node_modules/.bin/tsx');
const CLI = resolve(ROOT, 'apps/api/src/legacy-import.cli.ts');
const BYTES = 4 * 1024 * 1024;

describe('legacy-import exit', () => {
  it('large output piped to a slow reader arrives whole, with the exit code', async () => {
    const script = [
      `import { exitAfterDrain } from ${JSON.stringify(CLI)};`,
      `process.stdout.write('x'.repeat(${String(BYTES)}));`,
      `process.stderr.write('done\\n');`,
      'await exitAfterDrain(3);',
    ].join('\n');
    const child = spawn(TSX, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let received = 0;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // A slow reader: nothing is read for a while, so the child exits with the pipe full.
    child.stdout.pause();
    await new Promise((r) => setTimeout(r, 1_500));
    child.stdout.on('data', (chunk: Buffer) => (received += chunk.length));
    child.stdout.resume();
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(stderr).toContain('done');
    expect(received).toBe(BYTES);
    expect(code).toBe(3);
  }, 60_000);

  it('the CLI exits in one place only: main returns its code, so finally always runs', () => {
    const source = readFileSync(CLI, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const exits = source.match(/process\.exit\(/gu) ?? [];
    expect(exits).toHaveLength(1);
    const routine = source.slice(source.indexOf('export async function exitAfterDrain'));
    expect(routine.slice(0, routine.indexOf('\n}\n'))).toContain('process.exit(');
  });
});
