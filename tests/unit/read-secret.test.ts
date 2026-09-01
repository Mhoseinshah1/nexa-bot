import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { readSecret } from '../../apps/api/src/infrastructure/tty/read-secret';

/**
 * The bootstrap CLI reads the first owner's password. `readline.question()`
 * echoes it, which put the installation's most privileged credential on screen
 * and into scrollback. These tests exist because the failure mode is silent:
 * nothing throws when a password is echoed, so only an assertion catches it.
 */

class FakeTty extends EventEmitter {
  readonly isTTY = true;
  raw = false;
  setRawMode(mode: boolean): void {
    this.raw = mode;
  }
  resume(): void {}
  pause(): void {}
  // Present so the type matches; the TTY path never iterates.
  async *[Symbol.asyncIterator](): AsyncIterator<string> {}
  type(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'));
  }
  press(byte: number): void {
    this.emit('data', Buffer.from([byte]));
  }
}

function capture(): { out: string[]; write(chunk: string): void } {
  const out: string[] = [];
  return { out, write: (chunk: string) => void out.push(chunk) };
}

const ENTER = 0x0d;

describe('readSecret', () => {
  it('never writes the typed characters anywhere', async () => {
    const tty = new FakeTty();
    const output = capture();

    const answer = readSecret(tty as never, output, 'Password: ');
    tty.type('hunter2');
    tty.press(ENTER);

    expect(await answer).toBe('hunter2');
    // The prompt and the newline are all that may be written. If the secret
    // appears in the output at all, the CLI has leaked it to the screen.
    expect(output.out.join('')).toBe('Password: \n');
    expect(output.out.join('')).not.toContain('hunter2');
  });

  it('leaves the terminal out of raw mode afterwards', async () => {
    const tty = new FakeTty();
    const answer = readSecret(tty as never, capture(), 'Password: ');
    expect(tty.raw).toBe(true);
    tty.type('x');
    tty.press(ENTER);
    await answer;
    expect(tty.raw).toBe(false);
  });

  it('applies backspace without echoing', async () => {
    const tty = new FakeTty();
    const output = capture();
    const answer = readSecret(tty as never, output, 'Password: ');
    tty.type('abcX');
    tty.press(0x7f);
    tty.press(ENTER);
    expect(await answer).toBe('abc');
    expect(output.out.join('')).toBe('Password: \n');
  });

  it('reassembles multi-byte characters', async () => {
    const tty = new FakeTty();
    const answer = readSecret(tty as never, capture(), 'Password: ');
    tty.type('a-persian-password-رمز');
    tty.press(ENTER);
    expect(await answer).toBe('a-persian-password-رمز');
  });

  it('backspaces a whole character, not a byte of one', async () => {
    // The first version of this accumulated bytes into a latin-1 string and
    // sliced one element off it, so backspacing a Persian character removed a
    // third of it and left a half-character in the password nobody could see
    // or retype. The comment above it claimed it trimmed a code point.
    const tty = new FakeTty();
    const answer = readSecret(tty as never, capture(), 'Password: ');
    tty.type('ok-');
    tty.type('م'); // two bytes in UTF-8
    tty.press(0x7f);
    tty.type('z');
    tty.press(ENTER);
    expect(await answer).toBe('ok-z');
  });

  it('backspaces a multi-byte character delivered in one chunk with others', async () => {
    const tty = new FakeTty();
    const answer = readSecret(tty as never, capture(), 'Password: ');
    tty.type('رمز');
    tty.press(0x7f);
    tty.press(ENTER);
    expect(await answer).toBe('رم');
  });

  it('rejects on Ctrl+C rather than returning a partial password', async () => {
    const tty = new FakeTty();
    const answer = readSecret(tty as never, capture(), 'Password: ');
    tty.type('secr');
    tty.press(0x03);
    await expect(answer).rejects.toThrow('Cancelled.');
    expect(tty.raw).toBe(false);
  });

  it('reads a piped line without touching raw mode', async () => {
    const piped = {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        yield 'from-a-pipe\nleftover';
      },
      on() {},
      off() {},
    };
    const output = capture();
    expect(await readSecret(piped as never, output, 'Password: ')).toBe('from-a-pipe');
    expect(output.out.join('')).toBe('Password: \n');
  });
});
