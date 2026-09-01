/**
 * Reading answers from a terminal, without echoing the ones that are secret.
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
 *
 * ONE reader serves every question, and it keeps the bytes it has not consumed.
 * A terminal delivers a paste — or fast typing — as one `data` chunk that can
 * carry several answers at once. An earlier version resolved the first answer
 * and dropped the rest of that chunk on the floor, so the next question either
 * hung waiting for input that had already arrived or picked up the wrong text.
 * That is exactly the defect the piped path was fixed for, left in place on the
 * terminal path; keeping the surplus here is what makes the two agree.
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

/** How many bytes the UTF-8 character starting with this byte occupies. */
function characterLength(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

interface PendingRead {
  readonly echo: boolean;
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
  /** The answer so far, as bytes. Decoded once, at the end. */
  readonly bytes: number[];
  /** Bytes of a character not yet complete, held back so echo is not mojibake. */
  readonly partialCharacter: number[];
  escape: 'none' | 'after-esc' | 'csi';
}

export class TerminalReader {
  /** Received but not yet consumed. Survives between questions, deliberately. */
  private surplus: number[] = [];
  private pending: PendingRead | null = null;
  private attached = false;

  constructor(
    private readonly input: SecretInput,
    private readonly output: SecretOutput,
  ) {}

  read(prompt: string, options: { echo: boolean }): Promise<string> {
    this.output.write(prompt);
    return new Promise<string>((resolve, reject) => {
      this.pending = {
        echo: options.echo,
        resolve,
        reject,
        bytes: [],
        partialCharacter: [],
        escape: 'none',
      };
      this.attach();
      // Anything a previous question left behind belongs to this one.
      this.consume();
    });
  }

  /** Restores the terminal. A process that exits in raw mode leaves it broken. */
  close(): void {
    if (!this.attached) return;
    this.input.off('data', this.onData);
    this.input.setRawMode?.(false);
    this.attached = false;
  }

  private attach(): void {
    if (this.attached) return;
    this.input.setRawMode?.(true);
    this.input.resume?.();
    this.input.on('data', this.onData);
    this.attached = true;
  }

  private readonly onData = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (const byte of bytes) this.surplus.push(byte);
    this.consume();
  };

  /**
   * Feeds buffered bytes to the question in progress, and stops the moment one
   * is answered — the remainder stays in `surplus` for the next question.
   */
  private consume(): void {
    while (this.pending !== null && this.surplus.length > 0) {
      const read = this.pending;
      const byte = this.surplus.shift() as number;

      // Raw mode delivers escape sequences verbatim: an arrow key sends
      // ESC [ D, Home sends ESC [ H. Left alone those bytes land IN the answer
      // — silently, for a password — and the operator ends up with a credential
      // they cannot see and could never retype.
      if (read.escape === 'after-esc') {
        // ESC [ and ESC O introduce a multi-byte sequence; ESC with anything
        // else is a two-byte one (Alt+key) and ends here. Treating `[` as a
        // terminator, which it is in the CSI final-byte range, ended the
        // sequence one byte early and let `D` through as content.
        read.escape = byte === 0x5b || byte === 0x4f ? 'csi' : 'none';
        continue;
      }
      if (read.escape === 'csi') {
        // Parameters are 0x30-0x3F and intermediates 0x20-0x2F; the sequence
        // ends at the first final byte, 0x40-0x7E.
        if (byte >= 0x40 && byte <= 0x7e) read.escape = 'none';
        continue;
      }
      if (byte === ESC) {
        read.escape = 'after-esc';
        continue;
      }

      if (byte === ETX || (byte === EOT && read.bytes.length === 0)) {
        this.finish(read, () => {
          read.reject(new Error('Cancelled.'));
        });
        return;
      }

      if (byte === 0x0a || byte === 0x0d) {
        const answer = Buffer.from(read.bytes).toString('utf8');
        this.finish(read, () => {
          read.resolve(answer);
        });
        // Stop here: whatever followed belongs to the NEXT question.
        return;
      }

      if (byte === BACKSPACE || byte === DELETE) {
        // Drop a whole CHARACTER, which may be several bytes. UTF-8
        // continuation bytes are 0b10xxxxxx; discard them, then the lead byte
        // they belong to. Removing one byte instead would leave half a
        // character in the password, which nobody can see or retype.
        const before = read.bytes.length;
        while (read.bytes.length > 0 && (read.bytes[read.bytes.length - 1]! & 0xc0) === 0x80) {
          read.bytes.pop();
        }
        read.bytes.pop();
        read.partialCharacter.length = 0;
        // Rub the character off the screen, but only if it was ever on it.
        if (read.echo && read.bytes.length < before) this.output.write('\b \b');
        continue;
      }

      // Every other C0 control byte is a keystroke, not a character. Ctrl+D
      // mid-password is the clearest case: it would otherwise be stored as a
      // literal 0x04 in the credential.
      if (byte < 0x20) continue;

      read.bytes.push(byte);
      if (!read.echo) continue;

      // Echo whole characters, never single bytes. `String.fromCharCode` per
      // byte re-encodes each one separately, so a Persian name came back as
      // mojibake and an operator could not check what they had typed.
      read.partialCharacter.push(byte);
      const expected = characterLength(read.partialCharacter[0] as number);
      if (read.partialCharacter.length >= expected) {
        this.output.write(Buffer.from(read.partialCharacter).toString('utf8'));
        read.partialCharacter.length = 0;
      }
    }
  }

  private finish(read: PendingRead, settle: () => void): void {
    this.pending = null;
    read.partialCharacter.length = 0;
    // The Enter keystroke was swallowed with everything else.
    this.output.write('\n');
    settle();
  }
}
