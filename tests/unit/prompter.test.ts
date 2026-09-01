import { describe, expect, it } from 'vitest';
import { Prompter, PromptInputError } from '../../apps/api/src/infrastructure/tty/prompt';

/**
 * The bootstrap CLI read two answers through `readline/promises` and then the
 * password directly from the same stdin. On a PIPE — how an automated install
 * would drive it — readline buffered ahead, the password line was consumed and
 * discarded, and the process exited **0 having created no owner**: the "returns
 * success and writes nothing" defect this codebase exists to not reproduce.
 *
 * These tests pin the piped path, which is the one that was broken and the one
 * no terminal test would have caught.
 */

function pipedInput(text: string, chunkSize = 1024) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < text.length; i += chunkSize) {
        yield Buffer.from(text.slice(i, i + chunkSize), 'utf8');
      }
    },
    on() {},
    off() {},
  };
}

function capture(): { out: string[]; write(chunk: string): void } {
  const out: string[] = [];
  return { out, write: (chunk: string) => void out.push(chunk) };
}

describe('Prompter on a pipe', () => {
  it('reads consecutive answers from one stream', async () => {
    const prompter = new Prompter(pipedInput('alice\nAlice Smith\nhunter2\n') as never, capture());
    expect(await prompter.line('Owner username: ')).toBe('alice');
    expect(await prompter.line('Display name: ')).toBe('Alice Smith');
    // This is the one that used to come back empty, because readline had
    // already swallowed it.
    expect(await prompter.secret('Password: ')).toBe('hunter2');
  });

  it('reads answers split across chunk boundaries', async () => {
    // A pipe delivers whatever it delivers; a line may span two chunks.
    const prompter = new Prompter(
      pipedInput('alice\nAlice Smith\nhunter2\n', 3) as never,
      capture(),
    );
    expect(await prompter.line('u: ')).toBe('alice');
    expect(await prompter.line('d: ')).toBe('Alice Smith');
    expect(await prompter.secret('p: ')).toBe('hunter2');
  });

  it('accepts a final answer with no trailing newline', async () => {
    const prompter = new Prompter(pipedInput('alice\nAlice\nhunter2') as never, capture());
    await prompter.line('u: ');
    await prompter.line('d: ');
    expect(await prompter.secret('p: ')).toBe('hunter2');
  });

  it('raises when the input ends before an answer', async () => {
    // Silence here is the whole defect: an operator whose heredoc was short
    // was told the install succeeded and had no owner.
    const prompter = new Prompter(pipedInput('alice\n') as never, capture());
    expect(await prompter.line('u: ')).toBe('alice');
    await expect(prompter.line('Display name: ')).rejects.toBeInstanceOf(PromptInputError);
  });

  it('never echoes a piped answer back to the output', async () => {
    // A pipe was never echoing in the first place; writing it back would PRINT
    // a password that was not previously visible anywhere.
    const output = capture();
    const prompter = new Prompter(pipedInput('alice\nAlice\nhunter2\n') as never, output);
    await prompter.line('u: ');
    await prompter.line('d: ');
    await prompter.secret('p: ');
    expect(output.out.join('')).not.toContain('hunter2');
    expect(output.out.join('')).not.toContain('alice');
  });

  it('strips a carriage return from CRLF input', async () => {
    const prompter = new Prompter(pipedInput('alice\r\nAlice\r\nhunter2\r\n') as never, capture());
    expect(await prompter.line('u: ')).toBe('alice');
    await prompter.line('d: ');
    expect(await prompter.secret('p: ')).toBe('hunter2');
  });
});
