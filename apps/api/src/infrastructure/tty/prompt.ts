import { TerminalReader, type SecretInput, type SecretOutput } from './read-secret.js';

/**
 * Console prompts for the bootstrap CLI.
 *
 * One reader for every question, which is the whole point of it existing.
 *
 * The CLI previously read the username and display name through
 * `readline/promises` and then read the password from the same stdin
 * underneath it. On a terminal that mostly worked. On a PIPE — which is how an
 * automated install would drive it — it did not: readline buffers ahead, so the
 * password line was consumed and discarded, the pending question never settled,
 * the event loop emptied, and the process exited **0 having created nothing**,
 * with no error and no prompt. An operator scripting an installation would have
 * been told it succeeded and had no owner.
 *
 * That is the legacy system's "returns success and writes nothing" defect,
 * reproduced here, and it predates the password-echo fix rather than being
 * caused by it: the same silence happens on the commit before.
 *
 * So there is no readline. One buffered reader owns the stream, both kinds of
 * question read through it, and reaching end-of-input where a value was
 * required raises instead of returning an empty string.
 */
/**
 * Input ran out where an answer was required.
 *
 * Its own type so the CLI can tell it apart from a bug: a truncated heredoc is
 * an operator mistake and deserves one clear line, not a stack trace.
 */
export class PromptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptInputError';
  }
}

export class Prompter {
  /** Bytes read from the stream but not yet consumed by a completed line. */
  private leftover: Buffer = Buffer.alloc(0);
  private iterator: AsyncIterator<string | Uint8Array> | null = null;
  private terminal: TerminalReader | null = null;

  constructor(
    private readonly input: SecretInput,
    private readonly output: SecretOutput,
  ) {}

  private get isTty(): boolean {
    return this.input.isTTY === true && typeof this.input.setRawMode === 'function';
  }

  /** A visible answer. Echoed on a terminal, as a person expects. */
  async line(prompt: string): Promise<string> {
    if (this.isTty) return this.reader().read(prompt, { echo: true });
    return this.bufferedLine(prompt);
  }

  /** An answer that is never echoed and never written anywhere. */
  async secret(prompt: string): Promise<string> {
    if (this.isTty) return this.reader().read(prompt, { echo: false });
    return this.bufferedLine(prompt);
  }

  /**
   * Restores the terminal. A process that exits while stdin is still in raw
   * mode leaves the operator's shell without echo or line editing.
   */
  close(): void {
    this.terminal?.close();
    this.terminal = null;
  }

  /**
   * One reader for the whole session, not one per question: it holds the bytes
   * a paste delivered past the end of the answer it was asked for.
   */
  private reader(): TerminalReader {
    this.terminal ??= new TerminalReader(this.input, this.output);
    return this.terminal;
  }

  /**
   * One line from a non-terminal stream, keeping whatever followed it.
   *
   * Nothing is echoed: a pipe is not a terminal and never echoed the input in
   * the first place, so writing it back would PRINT a password that was not
   * previously visible.
   */
  private async bufferedLine(prompt: string): Promise<string> {
    this.output.write(prompt);
    this.iterator ??= this.input[Symbol.asyncIterator]();

    for (;;) {
      const newline = this.leftover.indexOf(0x0a);
      if (newline !== -1) {
        const line = this.leftover.subarray(0, newline).toString('utf8');
        this.leftover = this.leftover.subarray(newline + 1);
        this.output.write('\n');
        return line.replace(/\r$/, '');
      }

      const next = await this.iterator.next();
      if (next.done === true) {
        // A final line with no trailing newline is still an answer.
        if (this.leftover.length > 0) {
          const line = this.leftover.toString('utf8');
          this.leftover = Buffer.alloc(0);
          this.output.write('\n');
          return line.replace(/\r$/, '');
        }
        throw new PromptInputError(`Input ended before "${prompt.trim()}" was answered.`);
      }

      const chunk =
        typeof next.value === 'string' ? Buffer.from(next.value, 'utf8') : Buffer.from(next.value);
      this.leftover = Buffer.concat([this.leftover, chunk]);
    }
  }
}
