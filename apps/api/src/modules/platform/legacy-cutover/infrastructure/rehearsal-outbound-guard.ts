/**
 * The cutover rehearsal's outbound wall: while it is installed, every `fetch` this process
 * makes is REFUSED and counted. Telegram is reached through `fetch` and nothing else
 * (`infrastructure/telegram/send-message.ts`, `fetch-file.ts`), so with the guard on, no
 * message, no webhook call and no `getMe` can leave the rehearsal — whatever a bug elsewhere
 * would have asked for. A panel is reached through `safe-http.ts` (`node:http`), not
 * `fetch`, and the only panels the rehearsal's database holds are its own read-only stand-ins.
 *
 * The count is the evidence: the rehearsal's quiet check requires zero attempts, so an
 * attempt is a NO-GO even though it was stopped. The refusal is a `TypeError`, which is what
 * `fetch` itself throws for a network failure, so every caller handles it the way it already
 * handles an unreachable host.
 */
export class RehearsalOutboundGuard {
  private original: typeof fetch | null = null;
  private refused = 0;
  private telegram = 0;

  constructor(private readonly telegramHosts: readonly string[]) {}

  install(): void {
    if (this.original !== null) return;
    const original = globalThis.fetch;
    this.original = original;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
      this.refused += 1;
      if (this.isTelegram(input)) this.telegram += 1;
      return Promise.reject(
        new TypeError('outbound request refused: the cutover rehearsal sends nothing'),
      );
    }) as typeof fetch;
  }

  uninstall(): void {
    if (this.original === null) return;
    globalThis.fetch = this.original;
    this.original = null;
  }

  counts(): { readonly refused: number; readonly telegram: number } {
    return { refused: this.refused, telegram: this.telegram };
  }

  private isTelegram(input: Parameters<typeof fetch>[0]): boolean {
    let host: string;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.telegramHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }
}
