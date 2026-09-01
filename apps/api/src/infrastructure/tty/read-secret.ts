/**
 * Reads a line from a terminal without echoing it.
 *
 * `readline.question()` echoes. The bootstrap CLI used it for the first owner's
 * password and admitted so in the prompt text — "(input is not hidden)" — while
 * the comment directly above claimed the opposite. The password was printed on
 * screen and left in scrollback and in any terminal capture, during the single
 * most privileged credential setup the installation has.
 *
 * Written against the raw stream rather than by muting `readline`'s private
 * `_writeToOutput`, for one reason: that hook is an undocumented internal, and
 * if a future Node stops calling it the failure is silent — the password simply
 * starts appearing again, and nothing fails. This version can be tested, and is.
 */
export interface SecretInput extends AsyncIterable<string | Uint8Array> {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface SecretOutput {
  write(chunk: string): unknown;
}

const ETX = 0x03; // Ctrl+C
const EOT = 0x04; // Ctrl+D
const BACKSPACE = 0x08;
const DELETE = 0x7f;

/**
 * Resolves with the typed line, never echoing it.
 *
 * On a non-TTY input (a pipe, a heredoc, CI) there is no echo to suppress and
 * no raw mode to set, so the line is simply read.
 */
export function readSecret(
  input: SecretInput,
  output: SecretOutput,
  prompt: string,
): Promise<string> {
  output.write(prompt);

  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return readPlainLine(input, output);
  }

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    input.setRawMode?.(true);
    input.resume?.();

    const finish = (fn: () => void): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      // The Enter keystroke was swallowed with everything else.
      output.write('\n');
      fn();
    };

    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      for (const byte of bytes) {
        if (byte === ETX) {
          finish(() => {
            reject(new Error('Cancelled.'));
          });
          return;
        }
        if (byte === EOT && buffer.length === 0) {
          finish(() => {
            reject(new Error('Cancelled.'));
          });
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          const answer = buffer;
          finish(() => {
            resolve(answer);
          });
          return;
        }
        if (byte === BACKSPACE || byte === DELETE) {
          // Trim a whole code point, not a byte: a multi-byte character
          // half-deleted is a password nobody can retype.
          buffer = [...buffer].slice(0, -1).join('');
          continue;
        }
        // Anything else is content. Deliberately NOT written anywhere.
        buffer += String.fromCharCode(byte);
      }
    };

    input.on('data', onData);
  }).then((answer) =>
    // Re-decode: bytes were accumulated one at a time, so a multi-byte
    // character arrived as several latin-1 chars and must be reassembled.
    Buffer.from(answer, 'latin1').toString('utf8'),
  );
}

async function readPlainLine(input: SecretInput, output: SecretOutput): Promise<string> {
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const newline = buffer.indexOf('\n');
    if (newline !== -1) {
      output.write('\n');
      return buffer.slice(0, newline).replace(/\r$/, '');
    }
  }
  output.write('\n');
  return buffer.replace(/\r$/, '');
}
