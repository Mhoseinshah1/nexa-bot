import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  TerminalReader,
  TerminalInputError,
} from '../../apps/api/src/infrastructure/tty/read-secret';

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
const secret = { echo: false };
const visible = { echo: true };

describe('TerminalReader', () => {
  it('never writes the typed characters anywhere', async () => {
    const tty = new FakeTty();
    const output = capture();

    const answer = new TerminalReader(tty as never, output).read('Password: ', secret);
    tty.type('hunter2');
    tty.press(ENTER);

    expect(await answer).toBe('hunter2');
    // The prompt and the newline are all that may be written. If the secret
    // appears in the output at all, the CLI has leaked it to the screen.
    expect(output.out.join('')).toBe('Password: \n');
  });

  it('leaves the terminal out of raw mode after close', async () => {
    const tty = new FakeTty();
    const reader = new TerminalReader(tty as never, capture());
    const answer = reader.read('Password: ', secret);
    expect(tty.raw).toBe(true);
    tty.type('x');
    tty.press(ENTER);
    await answer;
    reader.close();
    expect(tty.raw).toBe(false);
  });

  it('applies backspace without echoing', async () => {
    const tty = new FakeTty();
    const output = capture();
    const answer = new TerminalReader(tty as never, output).read('Password: ', secret);
    tty.type('abcX');
    tty.press(0x7f);
    tty.press(ENTER);
    expect(await answer).toBe('abc');
    expect(output.out.join('')).toBe('Password: \n');
  });

  it('reassembles multi-byte characters', async () => {
    const tty = new FakeTty();
    const answer = new TerminalReader(tty as never, capture()).read('Password: ', secret);
    tty.type('a-persian-password-رمز');
    tty.press(ENTER);
    expect(await answer).toBe('a-persian-password-رمز');
  });

  it('backspaces a whole character, not a byte of one', async () => {
    // An earlier version accumulated bytes into a latin-1 string and sliced one
    // element off it, so backspacing a Persian character removed a third of it
    // and left half a character in the password nobody could see or retype.
    const tty = new FakeTty();
    const answer = new TerminalReader(tty as never, capture()).read('Password: ', secret);
    tty.type('ok-');
    tty.type('م');
    tty.press(0x7f);
    tty.type('z');
    tty.press(ENTER);
    expect(await answer).toBe('ok-z');
  });

  it('ignores arrow keys instead of storing their escape sequence', async () => {
    // Raw mode delivers ESC [ D verbatim. Stored, it becomes three bytes of a
    // password the operator cannot see and could never retype.
    const tty = new FakeTty();
    const answer = new TerminalReader(tty as never, capture()).read('Password: ', secret);
    tty.type('pass');
    tty.press(0x1b);
    tty.type('[D');
    tty.press(0x1b);
    tty.type('[H');
    tty.type('word');
    tty.press(ENTER);
    expect(await answer).toBe('password');
  });

  it('ignores a stray control byte rather than storing it', async () => {
    const tty = new FakeTty();
    const answer = new TerminalReader(tty as never, capture()).read('Password: ', secret);
    tty.type('ab');
    tty.press(0x04);
    tty.press(0x0b);
    tty.type('cd');
    tty.press(ENTER);
    expect(await answer).toBe('abcd');
  });

  it('rejects on Ctrl+C rather than returning a partial password', async () => {
    const tty = new FakeTty();
    const reader = new TerminalReader(tty as never, capture());
    const answer = reader.read('Password: ', secret);
    tty.type('secr');
    tty.press(0x03);
    await expect(answer).rejects.toThrow('Cancelled.');
  });

  it('echoes a visible answer, and rubs out a backspaced character', async () => {
    // `echo` is the only difference between asking for a username and asking
    // for a password, which is one boolean away from a password on the screen.
    const tty = new FakeTty();
    const output = capture();
    const answer = new TerminalReader(tty as never, output).read('Owner username: ', visible);
    tty.type('alix');
    tty.press(0x7f);
    tty.type('ce');
    tty.press(ENTER);
    expect(await answer).toBe('alice');
    expect(output.out.join('')).toBe('Owner username: alix\b \bce\n');
  });

  it('echoes whole characters, not single bytes', async () => {
    // Writing each UTF-8 byte separately re-encodes it, so a Persian display
    // name came back as mojibake and an operator could not check what they had
    // typed — on the account with the most authority in the installation.
    const tty = new FakeTty();
    const output = capture();
    const answer = new TerminalReader(tty as never, output).read('Display name: ', visible);
    tty.type('رضا');
    tty.press(ENTER);
    expect(await answer).toBe('رضا');
    expect(output.out.join('')).toBe('Display name: رضا\n');
  });

  it('echoes a character split across two data chunks exactly once', async () => {
    const tty = new FakeTty();
    const output = capture();
    const answer = new TerminalReader(tty as never, output).read('d: ', visible);
    const bytes = Buffer.from('ض', 'utf8');
    tty.emit('data', bytes.subarray(0, 1));
    tty.emit('data', bytes.subarray(1));
    tty.press(ENTER);
    expect(await answer).toBe('ض');
    expect(output.out.join('')).toBe('d: ض\n');
  });

  it('treats CRLF as one line ending', async () => {
    // A terminal or PTY that sends CRLF would otherwise leave the LF behind,
    // and the next question would consume it immediately and resolve EMPTY —
    // shifting every later answer by one, which makes a correct password
    // confirmation compare the wrong two values and fail.
    const tty = new FakeTty();
    const reader = new TerminalReader(tty as never, capture());

    const first = reader.read('u: ', visible);
    tty.type('alice\r\nAlice Smith\r\nhunter2\r\n');
    expect(await first).toBe('alice');
    expect(await reader.read('d: ', visible)).toBe('Alice Smith');
    expect(await reader.read('p: ', secret)).toBe('hunter2');
  });

  it('rejects a pending read when the terminal ends', async () => {
    // An SSH connection drops, or an installer's pseudo-terminal closes. The
    // reader watched only `data`, so the promise never settled and the CLI hung
    // with its database and Redis handles open and the terminal unrestored —
    // while the piped path raised on exactly the same condition.
    const tty = new FakeTty();
    const reader = new TerminalReader(tty as never, capture());
    const answer = reader.read('p: ', secret);
    tty.type('partial');
    tty.emit('end');
    await expect(answer).rejects.toBeInstanceOf(TerminalInputError);
    expect(tty.raw).toBe(false);
  });

  it('keeps bytes that arrive past the end of an answer', async () => {
    // A paste delivers several answers in ONE chunk. Dropping the surplus made
    // the next question hang waiting for input that had already arrived, or
    // pick up the wrong text — the same defect the piped path was fixed for.
    const tty = new FakeTty();
    const reader = new TerminalReader(tty as never, capture());

    const first = reader.read('u: ', visible);
    tty.type('alice\rAlice Smith\rhunter2\r');
    expect(await first).toBe('alice');

    expect(await reader.read('d: ', visible)).toBe('Alice Smith');
    expect(await reader.read('p: ', secret)).toBe('hunter2');
  });

  it('does not echo a pasted secret that arrived with an earlier answer', async () => {
    const tty = new FakeTty();
    const output = capture();
    const reader = new TerminalReader(tty as never, output);

    const first = reader.read('u: ', visible);
    tty.type('alice\rhunter2\r');
    await first;
    expect(await reader.read('p: ', secret)).toBe('hunter2');
    expect(output.out.join('')).not.toContain('hunter2');
  });
});
