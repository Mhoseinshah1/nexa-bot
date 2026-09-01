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
const ESC = 0x1b;
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

  return readRaw(input, output, false);
}

/**
 * The same terminal reader, with the echo decision made explicitly.
 *
 * The visible prompts share this loop rather than using `readline`, because
 * mixing the two on one stream is what silently swallowed the password line on
 * a pipe. See `Prompter`. `echo` is the ONLY difference between asking for a
 * username and asking for a password, which is how it should read.
 */
export function readSecretFrom(
  input: SecretInput,
  output: SecretOutput,
  prompt: string,
  options: { echo: boolean },
): Promise<string> {
  output.write(prompt);
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') {
    return readPlainLine(input, output);
  }
  return readRaw(input, output, options.echo);
}

function readRaw(input: SecretInput, output: SecretOutput, echo: boolean): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Raw BYTES, not a string. A password is not necessarily ASCII, and a
    // terminal delivers a multi-byte character as several bytes across one or
    // more chunks; decoding per byte and concatenating would mangle it, and
    // backspace would then delete a third of a character rather than a
    // character. Decoded once, at the end.
    const bytes: number[] = [];
    // Raw mode delivers escape sequences verbatim: an arrow key sends
    // ESC [ D, Home sends ESC [ H, and a paste can carry bracketed-paste
    // markers. Left alone, those bytes land IN the password — silently, since
    // nothing is echoed — and the operator ends up with a credential they
    // cannot see and could never retype. `readline` handles them; reading the
    // stream directly means handling them here.
    let escape: 'none' | 'after-esc' | 'csi' = 'none';
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
      const chunkBytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      for (const byte of chunkBytes) {
        if (escape === 'after-esc') {
          // ESC [ and ESC O introduce a multi-byte sequence; ESC followed by
          // anything else is a two-byte one (Alt+key) and ends here. Treating
          // `[` as a terminator, which it is in the CSI final-byte range, ended
          // the sequence one byte early and let `D` through as content — which
          // is how the first version of this turned a left arrow into a letter
          // in the password.
          escape = byte === 0x5b || byte === 0x4f ? 'csi' : 'none';
          continue;
        }
        if (escape === 'csi') {
          // Parameter bytes are 0x30-0x3F and intermediates 0x20-0x2F; the
          // sequence ends at the first final byte, 0x40-0x7E.
          if (byte >= 0x40 && byte <= 0x7e) escape = 'none';
          continue;
        }
        if (byte === ESC) {
          escape = 'after-esc';
          continue;
        }
        if (byte === ETX) {
          finish(() => {
            reject(new Error('Cancelled.'));
          });
          return;
        }
        if (byte === EOT && bytes.length === 0) {
          finish(() => {
            reject(new Error('Cancelled.'));
          });
          return;
        }
        if (byte === 0x0a || byte === 0x0d) {
          const answer = Buffer.from(bytes).toString('utf8');
          finish(() => {
            resolve(answer);
          });
          return;
        }
        if (byte === BACKSPACE || byte === DELETE) {
          // Drop a whole CHARACTER, which may be several bytes. UTF-8
          // continuation bytes are 0b10xxxxxx; discard them, then the lead
          // byte they belong to. Removing one byte instead would leave a
          // half-character in the password, and the operator would have no way
          // to see it or retype it.
          const before = bytes.length;
          while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) bytes.pop();
          bytes.pop();
          // Rub the character off the screen, but only if it was ever on it.
          if (echo && bytes.length < before) output.write('\b \b');
          continue;
        }
        // Every other C0 control byte is a keystroke, not a character. Ctrl+D
        // mid-password is the clearest case: it would otherwise be stored as a
        // literal 0x04 in the credential. A password may contain anything
        // printable, in any script, but not a raw control byte.
        if (byte < 0x20) continue;
        // Content. Written back only when this is a visible prompt; a secret is
        // deliberately not written anywhere.
        bytes.push(byte);
        if (echo) output.write(String.fromCharCode(byte));
      }
    };

    input.on('data', onData);
  });
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
