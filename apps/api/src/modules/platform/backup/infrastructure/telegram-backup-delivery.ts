import { openAsBlob } from 'node:fs';
import type { BackupDelivery, DeliveryAttempt } from '../application/ports.js';

/**
 * Sends a backup to Telegram, and is honest about what it learns.
 *
 * A SEPARATE transport from `TelegramNotificationTransport`, and the separation
 * is the point rather than an omission. That one exists to deliver operational
 * alerts and answers in `DELIVERY_OUTCOMES`, whose `FAILED_RETRYABLE` encodes
 * the decision to try again — correct there, because an alert carries a dedupe
 * key and a duplicate costs nothing. This one moves an encrypted database, and
 * a duplicate costs a second copy of the whole installation in a chat. Its
 * three outcomes are FACTS, and the mapping below is where the difference lives.
 *
 * WHAT REACHES TELEGRAM. The archive, which is ciphertext, and a caption built
 * by the pipeline from the manifest. No key, no key id, no connection string,
 * no environment. The bot token is in the request path, never in the body and
 * never in an error: every message this class produces is built from the status
 * code and Telegram's own `description`, and the URL is not among them.
 */

export interface TelegramBackupDeliveryOptions {
  readonly apiBaseUrl: string;
  /** The bot to send from. Resolved once, at composition. */
  readonly token: string;
  /** The destination chat. Empty means delivery is not configured. */
  readonly chatId: string;
  readonly timeoutMs: number;
}

export class TelegramBackupDelivery implements BackupDelivery {
  constructor(private readonly options: TelegramBackupDeliveryOptions) {}

  get configured(): boolean {
    return this.options.chatId !== '' && this.options.token !== '';
  }

  async sendDocument(input: {
    archivePath: string;
    filename: string;
    caption: string;
  }): Promise<DeliveryAttempt> {
    // `openAsBlob` keeps the file on disk and streams it as the request body,
    // so a 50 MiB archive does not become 50 MiB of heap beside the dump that
    // produced it. At the ceiling that would be survivable; the reason it is
    // done properly is that the ceiling is Telegram's, not ours.
    let body: FormData;
    try {
      const blob = await openAsBlob(input.archivePath);
      body = new FormData();
      body.set('chat_id', this.options.chatId);
      body.set('caption', input.caption);
      body.set('document', blob, input.filename);
    } catch (error) {
      // The archive could not be opened. Nothing was sent, so this is
      // definitive — there is no ambiguity to preserve.
      return {
        state: 'FAILED_DEFINITIVE',
        detail: `The archive could not be read for delivery: ${reason(error)}`,
      };
    }
    return this.post('sendDocument', body);
  }

  async sendMessage(text: string): Promise<DeliveryAttempt> {
    const body = new FormData();
    body.set('chat_id', this.options.chatId);
    body.set('text', text);
    body.set('link_preview_options', JSON.stringify({ is_disabled: true }));
    return this.post('sendMessage', body);
  }

  /**
   * One request, and the classification that is the whole reason this file
   * exists.
   *
   *   `ok: true`                      SUCCEEDED. Telegram has it.
   *   a parsed rejection               FAILED_DEFINITIVE. It answered, and the
   *                                    answer is no. Resending the same bytes
   *                                    would be refused the same way, so there
   *                                    is nothing ambiguous to preserve.
   *   anything else                    OUTCOME_UNKNOWN. A timeout, a dropped
   *                                    socket, a 5xx, a 429, a 2xx whose body
   *                                    would not parse. The document may be in
   *                                    the group.
   *
   * A 429 and a 5xx are OUTCOME_UNKNOWN rather than a retryable failure, which
   * is the one classification here that looks wrong and is not. Telegram's rate
   * limiter can reject a request it has already accepted the upload for, and a
   * 5xx can follow a write that landed. "Retryable" would be a decision this
   * class is not entitled to make about a forty-megabyte document; recording
   * that we do not know leaves the decision to a person, which is what the
   * state is for.
   */
  private async post(method: string, body: FormData): Promise<DeliveryAttempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(
        `${this.options.apiBaseUrl}/bot${this.options.token}/${method}`,
        {
          method: 'POST',
          body,
          signal: controller.signal,
          // Never follow a redirect: the bot token is in the request PATH, so a
          // 30x to another host would hand the credential over along with the
          // database. Telegram does not redirect; anything that does is not
          // Telegram.
          redirect: 'error',
        },
      );

      let payload: { ok?: boolean; description?: string; error_code?: number } | null;
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = null;
      }

      if (response.ok && payload?.ok === true) {
        return { state: 'SUCCEEDED', detail: null };
      }

      if (payload === null) {
        // We could not read the verdict. Whether the document arrived is
        // exactly what we do not know.
        return {
          state: 'OUTCOME_UNKNOWN',
          detail: `HTTP ${response.status} with a body that could not be read.`,
        };
      }

      if (response.status >= 500 || response.status === 429) {
        return {
          state: 'OUTCOME_UNKNOWN',
          detail: `HTTP ${response.status}: ${payload.description ?? 'no description'}`,
        };
      }

      // A 4xx that parsed: a bad chat id, a bot that is not a member, a file
      // too large. Telegram considered the request and refused it.
      return {
        state: 'FAILED_DEFINITIVE',
        detail: `HTTP ${response.status} (${payload.error_code ?? 'no code'}): ${
          payload.description ?? 'no description'
        }`,
      };
    } catch (error) {
      // A timeout or a transport failure, AFTER the body began uploading. The
      // upload may well have completed on Telegram's side while our socket
      // died waiting for the response, which is precisely an unknown outcome
      // and precisely what must not be blindly resent.
      return { state: 'OUTCOME_UNKNOWN', detail: `The request did not complete: ${reason(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** An error's message and nothing else. Never a stack, never a cause chain. */
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
