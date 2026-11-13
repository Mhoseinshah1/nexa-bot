import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { BackupDeliveryReason } from '@nexa/contracts';
import type { BackupDeliveryChannel, DeliveryAttempt } from '../application/ports.js';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import { isMissingForumTopicError } from '../../../../infrastructure/telegram/send-message.js';

/**
 * Sends a backup to Telegram, and is honest about what it learns.
 *
 * A SEPARATE transport from `TelegramNotificationTransport`, and the separation
 * is the point rather than an omission. That one exists to deliver operational
 * alerts and answers in `DELIVERY_OUTCOMES`, whose `FAILED_RETRYABLE` encodes
 * the decision to try again — correct there, because an alert carries a dedupe
 * key and a duplicate costs nothing. This one moves an encrypted database. Its
 * three outcomes are FACTS, and the mapping below is where the difference lives;
 * whether to send a part again is the pipeline's decision (`backup-part-delivery.ts`),
 * never this class's.
 *
 * WHY NOT `fetch` (NEXA-BACKUP-DELIVERY). A 197 MB archive's first 45 MB part failed on the
 * owner's server with «The request did not complete: fetch failed», and the record could say
 * nothing more: `fetch` wraps every transport failure in a `TypeError('fetch failed')` whose
 * real reason is on `error.cause`, and this class kept only `.message`. Worse, `fetch` runs
 * on Node's bundled undici, whose global dispatcher has its OWN timers — `headersTimeout` and
 * `bodyTimeout`, 300 s each — beneath `BACKUP_DELIVERY_TIMEOUT_MS` (10 min). A 45 MB upload on
 * a slow link, or Telegram taking its time to store the file before it answers, is cut off by
 * undici at five minutes with `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` and reported
 * as «fetch failed» — while the request may well have landed. Node exposes no way to give the
 * bundled `fetch` another dispatcher without a dependency on the `undici` package, so this
 * transport speaks HTTP itself through `node:https`: the ONLY deadline is this class's own
 * `timeoutMs`, the body is a multipart stream read from disk (the part's byte range, never a
 * buffer of it), and a failure's whole cause chain — every `code` on the way down — goes into
 * the detail together with how many bytes had left and for how long.
 *
 * WHAT REACHES TELEGRAM. The archive, which is ciphertext, and a caption built
 * by the pipeline from the manifest. No key, no key id, no connection string,
 * no environment. The bot token is in the request path, never in the body and
 * never in an error: every message this class produces is built from the status
 * code, Telegram's own `description`, or an error's `code` and message — and the
 * URL is not among them (a `node:http` error does not quote its path).
 */

export interface TelegramBackupDeliveryOptions {
  readonly apiBaseUrl: string;
  /** The bot to send from. Resolved once, at composition. */
  readonly token: string;
  /** The destination chat. Empty means delivery is not configured. */
  readonly chatId: string;
  /**
   * The forum topic inside that chat, or absent for the chat itself. Set for the
   * operations log group's «💾 بکاپ‌ها» topic (spec §13.1); never for the environment's
   * dedicated chat, which has always been posted to directly.
   */
  readonly messageThreadId?: number | null;
  /**
   * The whole request's deadline: upload, Telegram storing the file, and its answer. The only
   * timer on the request (`BACKUP_DELIVERY_TIMEOUT_MS`).
   */
  readonly timeoutMs: number;
}

/** What a multipart field is: text, or a byte range of a file on disk. */
type Field =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly filename: string;
      readonly path: string;
      readonly start: number;
      /** Exclusive. */
      readonly end: number;
    };

/** The most of an answer we read: a Bot API answer is a few hundred bytes. */
const MAX_ANSWER_BYTES = 256 * 1024;

export class TelegramBackupDelivery implements BackupDeliveryChannel {
  constructor(private readonly options: TelegramBackupDeliveryOptions) {}

  get configured(): boolean {
    return this.options.chatId !== '' && this.options.token !== '';
  }

  async sendDocument(input: {
    archivePath: string;
    filename: string;
    caption: string;
    range?: { start: number; end: number };
  }): Promise<DeliveryAttempt> {
    // An archive upload is the longest-running external call in this codebase.
    // Inside a transaction it would hold a pooled connection for the length of a
    // 50 MiB upload over somebody's home connection.
    assertOutsideTransaction('A backup archive upload');

    // The part is a byte range of the file on disk, streamed as the body: never read into
    // memory. Its size is taken now, so the request carries an exact Content-Length.
    let start: number;
    let end: number;
    try {
      const { size } = await stat(input.archivePath);
      start = input.range?.start ?? 0;
      end = input.range?.end ?? size;
      if (start < 0 || end > size || start > end) {
        throw new RangeError(`the part [${String(start)}, ${String(end)}) is outside the archive`);
      }
    } catch (error) {
      // The archive could not be opened. Nothing was sent, so this is
      // definitive — there is no ambiguity to preserve.
      return {
        state: 'FAILED_DEFINITIVE',
        reason: 'ARCHIVE_UNREADABLE',
        detail: `The archive could not be read for delivery: ${causeChain(error)}`,
      };
    }
    return this.post('sendDocument', [
      ...this.target(),
      { name: 'caption', value: input.caption },
      { name: 'document', filename: input.filename, path: input.archivePath, start, end },
    ]);
  }

  async sendMessage(text: string): Promise<DeliveryAttempt> {
    assertOutsideTransaction('A backup delivery message');
    return this.post('sendMessage', [
      ...this.target(),
      { name: 'text', value: text },
      { name: 'link_preview_options', value: JSON.stringify({ is_disabled: true }) },
    ]);
  }

  private target(): Field[] {
    const fields: Field[] = [{ name: 'chat_id', value: this.options.chatId }];
    const thread = this.options.messageThreadId;
    if (thread !== undefined && thread !== null) {
      fields.push({ name: 'message_thread_id', value: String(thread) });
    }
    return fields;
  }

  /**
   * One request, and the classification that is the whole reason this file
   * exists.
   *
   *   `ok: true`                      SUCCEEDED. Telegram has it.
   *   a parsed rejection               FAILED_DEFINITIVE. It answered, and the
   *                                    answer is no. Resending the same bytes
   *                                    would be refused the same way.
   *   no connection was ever made      FAILED_DEFINITIVE, `CONNECT_FAILED`. Not one
   *                                    byte reached Telegram.
   *   anything else                    OUTCOME_UNKNOWN. A deadline, a dropped
   *                                    socket, a 5xx, a 429, a 2xx whose body
   *                                    would not parse. The document may be in
   *                                    the group.
   *
   * A 429 and a 5xx are OUTCOME_UNKNOWN rather than a retryable failure: Telegram's rate
   * limiter can reject a request it has already accepted the upload for, and a 5xx can
   * follow a write that landed. The pipeline may send such a part again (bounded, in order,
   * under "sent twice is acceptable, lost is not"), and it does so KNOWING the first copy may
   * be in the group — which is what the state says.
   */
  private async post(method: string, fields: readonly Field[]): Promise<DeliveryAttempt> {
    let url: URL;
    try {
      url = new URL(`${this.options.apiBaseUrl}/bot${this.options.token}/${method}`);
    } catch {
      return {
        state: 'FAILED_DEFINITIVE',
        reason: 'CONNECT_FAILED',
        detail: 'The Telegram API base URL is not a URL.',
      };
    }
    const boundary = `----nexa-backup-${randomBytes(12).toString('hex')}`;
    const { heads, tail, length } = multipartFrame(boundary, fields);
    const progress = { connected: false, sent: 0, startedAt: performance.now() };

    let exchange: { response: IncomingMessage; body: Buffer };
    try {
      exchange = await this.exchange(url, boundary, fields, heads, tail, length, progress);
    } catch (error) {
      const elapsed = Math.round((performance.now() - progress.startedAt) / 1000);
      const where = `after ${String(elapsed)} s, ${String(progress.sent)} of ${String(length)} bytes written`;
      if (error instanceof DeadlineExceeded) {
        return {
          state: 'OUTCOME_UNKNOWN',
          reason: 'DEADLINE_EXCEEDED',
          detail:
            `No answer within the delivery deadline (${String(Math.round(this.options.timeoutMs / 1000))} s; ` +
            `BACKUP_DELIVERY_TIMEOUT_MS), ${where}. The upload may have landed.`,
        };
      }
      if (error instanceof SourceUnreadable) {
        // The file vanished or failed mid-read: bytes may already be at Telegram, but the
        // document is incomplete there and Telegram will not post a truncated multipart.
        return {
          state: progress.sent === 0 ? 'FAILED_DEFINITIVE' : 'OUTCOME_UNKNOWN',
          reason: 'ARCHIVE_UNREADABLE',
          detail: `The archive could not be read while it was sent (${where}): ${causeChain(error.source)}`,
        };
      }
      if (!progress.connected) {
        // Not one byte reached Telegram: a definitive non-delivery, and a resend cannot
        // duplicate anything.
        return {
          state: 'FAILED_DEFINITIVE',
          reason: 'CONNECT_FAILED',
          detail: `No connection to Telegram (${where}): ${causeChain(error)}`,
        };
      }
      // A transport failure AFTER the connection was made. The upload may well have
      // completed on Telegram's side while our socket died waiting for the response,
      // which is precisely an unknown outcome.
      return {
        state: 'OUTCOME_UNKNOWN',
        reason: transportReason(error),
        detail: `The request did not complete (${where}): ${causeChain(error)}`,
      };
    }
    return this.classify(exchange.response, exchange.body);
  }

  /** Sends the multipart body and reads the answer, under the one deadline. */
  private exchange(
    url: URL,
    boundary: string,
    fields: readonly Field[],
    heads: readonly Buffer[],
    tail: Buffer,
    length: number,
    progress: { connected: boolean; sent: number },
  ): Promise<{ response: IncomingMessage; body: Buffer }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let request: ClientRequest | null = null;
      const finish = (error: Error | null, value?: { response: IncomingMessage; body: Buffer }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error !== null) {
          request?.destroy();
          reject(error);
        } else if (value !== undefined) {
          resolve(value);
        }
      };
      const deadline = setTimeout(() => finish(new DeadlineExceeded()), this.options.timeoutMs);

      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      request = send(url, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(length),
        },
        // No keep-alive pool: one long request per part, and a socket that a previous
        // part's failure left half-open must never carry the next one.
        agent: false,
      });
      request.on('socket', (socket) => {
        const connected = () => {
          progress.connected = true;
        };
        if (url.protocol === 'https:') socket.once('secureConnect', connected);
        else socket.once('connect', connected);
      });
      request.on('error', (error) => finish(error));
      request.on('response', (response) => {
        // Never follow a redirect: the bot token is in the request PATH, so a 30x
        // to another host would hand the credential over along with the database.
        // `node:http` follows nothing; a 30x is read below as an answer that is not
        // a Bot API answer.
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received <= MAX_ANSWER_BYTES) chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('end', () => finish(null, { response, body: Buffer.concat(chunks) }));
        response.on('close', () => {
          if (!response.complete) finish(new Error('the answer was cut off'));
        });
      });
      void this.writeBody(request, fields, heads, tail, progress).catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  /** The body, field by field; a file field streams its byte range from disk. */
  private async writeBody(
    request: ClientRequest,
    fields: readonly Field[],
    heads: readonly Buffer[],
    tail: Buffer,
    progress: { sent: number },
  ): Promise<void> {
    // Backpressure, and a request that closes under us (an error, the deadline) ends the
    // write loop — which closes the file it was reading — instead of waiting for ever.
    const write = (chunk: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        if (request.destroyed) {
          reject(new Error('the request was closed'));
          return;
        }
        progress.sent += chunk.length;
        if (request.write(chunk)) {
          resolve();
          return;
        }
        const onDrain = () => {
          request.off('close', onClose);
          resolve();
        };
        const onClose = () => {
          request.off('drain', onDrain);
          reject(new Error('the request was closed'));
        };
        request.once('drain', onDrain);
        request.once('close', onClose);
      });
    for (const [index, field] of fields.entries()) {
      const head = heads[index];
      if (head === undefined) throw new Error('multipart frame mismatch');
      await write(head);
      if ('path' in field) {
        if (field.end > field.start) {
          const stream = createReadStream(field.path, {
            start: field.start,
            end: field.end - 1,
            highWaterMark: 256 * 1024,
          });
          try {
            for await (const chunk of stream) await write(chunk as Buffer);
          } catch (error) {
            if (request.destroyed) throw error;
            throw new SourceUnreadable(error);
          }
        }
        await write(Buffer.from('\r\n'));
      }
    }
    await write(tail);
    request.end();
  }

  private classify(response: IncomingMessage, body: Buffer): DeliveryAttempt {
    const status = response.statusCode ?? 0;
    const ok2xx = status >= 200 && status < 300;
    let payload: {
      ok?: boolean;
      description?: string;
      error_code?: number;
      result?: { message_id?: unknown };
      parameters?: { retry_after?: unknown };
    } | null;
    try {
      payload = JSON.parse(body.toString('utf8')) as typeof payload;
    } catch {
      payload = null;
    }

    if (ok2xx && payload?.ok === true) {
      // The message id is what proves a part was delivered (E4). An `ok` without a
      // readable one is still SUCCEEDED — Telegram said so — but carries none, so the
      // local copy is kept: nothing can show this part is in the group by id.
      const messageId = payload.result?.message_id;
      return {
        state: 'SUCCEEDED',
        detail: null,
        messageId:
          typeof messageId === 'number' && Number.isSafeInteger(messageId) ? messageId : null,
      };
    }

    if (payload === null || typeof payload !== 'object') {
      // We could not read the verdict. Whether the document arrived is exactly what we do
      // not know. (A JSON `null` or a bare value is no verdict either — PR #238 review N4.)
      return {
        state: 'OUTCOME_UNKNOWN',
        reason: answerReason(status),
        detail:
          payload === null
            ? `HTTP ${String(status)} with a body that could not be read.`
            : `HTTP ${String(status)} with a body that is not a Bot API answer.`,
      };
    }

    /*
     * PR #238 review N4 (the D1 defect, in this lane's own copy of the call): a 2xx whose
     * body parsed but does not SAY `ok: false` — no `ok`, a bare value — is not a refusal.
     * Telegram accepted the upload; whether the document landed is unknown (ADR-0025).
     */
    if (ok2xx && payload.ok !== false) {
      return {
        state: 'OUTCOME_UNKNOWN',
        reason: 'ANSWER_UNREADABLE',
        detail: `HTTP ${String(status)} with a body that is not a Bot API answer.`,
      };
    }

    if (status >= 500 || status === 429) {
      const retryAfter = payload.parameters?.retry_after;
      const retryAfterMs =
        typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.round(retryAfter * 1000)
          : undefined;
      return {
        state: 'OUTCOME_UNKNOWN',
        reason: status === 429 ? 'RATE_LIMITED' : 'TELEGRAM_SERVER_ERROR',
        detail: `HTTP ${String(status)}: ${payload.description ?? 'no description'}`,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }

    if (status < 400 && !ok2xx) {
      // A 1xx/3xx that parsed (a redirect page): not Telegram's answer, and nothing followed.
      return {
        state: 'OUTCOME_UNKNOWN',
        reason: 'ANSWER_UNREADABLE',
        detail: `HTTP ${String(status)} with a body that is not a Bot API answer.`,
      };
    }

    // A 4xx that parsed: a bad chat id, a bot that is not a member, a file
    // too large. Telegram considered the request and refused it.
    const detail = `HTTP ${String(status)} (${String(payload.error_code ?? 'no code')}): ${
      payload.description ?? 'no description'
    }`;
    // A deleted forum topic is a refusal like any other — nothing was posted — and the
    // one the router can act on: recreate the topic and send once more.
    const topicMissing =
      this.options.messageThreadId !== undefined &&
      this.options.messageThreadId !== null &&
      isMissingForumTopicError(payload.description ?? '');
    return topicMissing
      ? { state: 'FAILED_DEFINITIVE', reason: 'TELEGRAM_REFUSED', detail, topicMissing: true }
      : { state: 'FAILED_DEFINITIVE', reason: 'TELEGRAM_REFUSED', detail };
  }
}

/** This class's own deadline fired. */
class DeadlineExceeded extends Error {
  constructor() {
    super('the delivery deadline passed');
  }
}

/** The archive failed to read while it was being sent. */
class SourceUnreadable extends Error {
  constructor(readonly source: unknown) {
    super('the archive could not be read');
  }
}

/**
 * The multipart frame: one head per field (a file field's bytes follow its head), the
 * closing boundary, and the exact total length, so the request carries a Content-Length.
 */
function multipartFrame(
  boundary: string,
  fields: readonly Field[],
): { heads: Buffer[]; tail: Buffer; length: number } {
  const heads = fields.map((field) =>
    'path' in field
      ? Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"; ` +
            `filename="${quoted(field.filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        )
      : Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n` +
            `${field.value}\r\n`,
        ),
  );
  const tail = Buffer.from(`--${boundary}--\r\n`);
  let length = tail.length;
  for (const [index, field] of fields.entries()) {
    length += heads[index]?.length ?? 0;
    if ('path' in field) length += field.end - field.start + 2;
  }
  return { heads, tail, length };
}

/** A filename inside a quoted header parameter: no quote, no backslash, no line break. */
function quoted(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
}

/** What a 2xx/5xx answer we could not read is. */
function answerReason(status: number): BackupDeliveryReason {
  return status >= 500 ? 'TELEGRAM_SERVER_ERROR' : 'ANSWER_UNREADABLE';
}

/** The `code`s down an error's cause chain, outermost first. */
export function causeCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * An error and its whole cause chain, one link per level: `message (CODE) ← message (CODE)`.
 * Never a stack. A link's message is the error's own words (a `node:http` error does not
 * quote its URL); the stored copy is redacted again on its way into the row.
 */
export function causeChain(error: unknown): string {
  const links: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error || typeof current === 'object') {
      const message = (current as { message?: unknown }).message;
      const code = (current as { code?: unknown }).code;
      const text = typeof message === 'string' && message !== '' ? message : String(current);
      links.push(typeof code === 'string' && code !== '' ? `${text} (${code})` : text);
      current = (current as { cause?: unknown }).cause;
    } else {
      links.push(String(current));
      break;
    }
  }
  return links.join(' ← ');
}

const RESET_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ECONNABORTED',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** A failure after the connection was made, as a reason code. */
function transportReason(error: unknown): BackupDeliveryReason {
  const codes = causeCodes(error);
  if (codes.some((code) => RESET_CODES.has(code))) return 'CONNECTION_RESET';
  const message = error instanceof Error ? error.message : '';
  if (/socket hang up|cut off/i.test(message)) return 'CONNECTION_RESET';
  return 'TRANSPORT_ERROR';
}
