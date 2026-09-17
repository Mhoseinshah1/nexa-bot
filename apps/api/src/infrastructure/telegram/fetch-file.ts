import { PAYMENT_RECEIPT_MAX_BYTES } from '@nexa/contracts';
import { assertOutsideTransaction } from '../transaction-boundary.js';

/**
 * Downloading a file Telegram is holding for this bot. TWO calls, and both carry the
 * token in the PATH.
 *
 * Which is why `redirect: 'error'` is on both, for the reason `telegramSend` states at
 * length: a 30x from the configured base to an `http://` or third-party location would
 * hand the credential over, and the production-https rule in the config schema binds
 * only the first hop. Telegram does not redirect; anything that does is not Telegram.
 *
 * It is NOT a method on `telegramCall`. The second request is not an API call at all —
 * it fetches `/file/bot<token>/<path>` and the body is bytes rather than a JSON
 * envelope — so sharing that function would mean teaching it two response shapes, which
 * is how the one-implementation rule gets broken from the inside.
 *
 * ## Why `file_path` is validated rather than used
 *
 * `getFile` answers with a relative path and this code concatenates it onto a URL. That
 * makes it the one string in this module that decides WHERE the second request goes, and
 * a value that decides a destination gets checked whatever produced it — the rule
 * `SafeHttpClient` exists for, applied to a string instead of an address. An absolute
 * URL, a scheme, a protocol-relative prefix, a backslash, a `..` segment or a leading
 * slash is refused rather than escaped: this installation knows exactly what a Telegram
 * file path looks like, and anything else is not one.
 */
export type TelegramFileOutcome =
  | {
      readonly outcome: 'SUCCEEDED';
      readonly bytes: Uint8Array;
      readonly mimeType: string | null;
    }
  /**
   * The file is gone, or this bot can no longer reach it.
   *
   * A rotated token and a file Telegram has aged out both land here, which is the
   * limitation `packages/contracts/src/payment-receipts.ts` states rather than
   * discovers: this installation stores the binding and Telegram stores the bytes.
   * The reviewer is told the file is not retrievable — not shown an empty frame, and
   * not told the receipt does not exist.
   */
  | { readonly outcome: 'UNAVAILABLE'; readonly reason: string };

export interface TelegramFileRequest {
  readonly token: string;
  readonly apiBaseUrl: string;
  /** Where FILES live. A different host from the API in Telegram's own deployment. */
  readonly fileBaseUrl: string;
  readonly timeoutMs: number;
  readonly fileId: string;
}

export async function telegramFetchFile(
  request: TelegramFileRequest,
): Promise<TelegramFileOutcome> {
  /*
   * Outside a transaction, and here the reason is not a duplicate side effect: a
   * download of up to `PAYMENT_RECEIPT_MAX_BYTES` inside one would hold a database
   * connection for the length of a network transfer, which is the shape of stall
   * `docs/conventions.md` added this guard to make impossible.
   */
  assertOutsideTransaction('A Telegram file download');

  const described = await describe(request);
  if (described.outcome !== 'SUCCEEDED') return described;
  return download(request, described.filePath, described.declaredSize);
}

type DescribeOutcome =
  | {
      readonly outcome: 'SUCCEEDED';
      readonly filePath: string;
      readonly declaredSize: number | null;
    }
  | { readonly outcome: 'UNAVAILABLE'; readonly reason: string };

async function describe(request: TelegramFileRequest): Promise<DescribeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(`${request.apiBaseUrl}/bot${request.token}/getFile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: request.fileId }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      /*
       * Every non-2xx is UNAVAILABLE, including a 5xx.
       *
       * There is no retryable case here because there is nobody to retry: this runs
       * inside an operator's HTTP request, and a reviewer who sees "not retrievable"
       * clicks again. Reporting a 5xx as retryable would name a lane that does not
       * exist, which is the `DELIVERY_OUTCOMES` collapse `CLAUDE.md` refuses.
       */
      return { outcome: 'UNAVAILABLE', reason: `getFile answered ${String(response.status)}` };
    }
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: { file_path?: unknown; file_size?: unknown };
    } | null;
    if (payload?.ok !== true) {
      return { outcome: 'UNAVAILABLE', reason: 'getFile did not answer ok' };
    }
    const filePath = payload.result?.file_path;
    if (typeof filePath !== 'string' || !isSafeFilePath(filePath)) {
      return { outcome: 'UNAVAILABLE', reason: 'getFile answered no usable file path' };
    }
    const declared = payload.result?.file_size;
    const declaredSize =
      typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0
        ? declared
        : null;
    if (declaredSize !== null && declaredSize > PAYMENT_RECEIPT_MAX_BYTES) {
      return { outcome: 'UNAVAILABLE', reason: 'the file is larger than this API will fetch' };
    }
    return { outcome: 'SUCCEEDED', filePath, declaredSize };
  } catch (error) {
    return { outcome: 'UNAVAILABLE', reason: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function download(
  request: TelegramFileRequest,
  filePath: string,
  declaredSize: number | null,
): Promise<TelegramFileOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(`${request.fileBaseUrl}/file/bot${request.token}/${filePath}`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      return { outcome: 'UNAVAILABLE', reason: `the file answered ${String(response.status)}` };
    }
    /*
     * The bound is enforced WHILE reading, not after.
     *
     * `arrayBuffer()` allocates the whole body first, so a response that lies about or
     * omits `file_size` could put hundreds of megabytes into this process before any
     * check ran — and the check below would then refuse a file that had already done
     * the damage. A declared `Content-Length` is refused up front where it is present,
     * and the stream is read with a running total that aborts the moment it passes the
     * cap. Both are claims from the other side of the network, which is why neither is
     * trusted alone.
     */
    const promised = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isSafeInteger(promised) && promised > PAYMENT_RECEIPT_MAX_BYTES) {
      return { outcome: 'UNAVAILABLE', reason: 'the file is larger than this API will fetch' };
    }
    const read = await readBounded(response, controller);
    if (read === null) {
      return { outcome: 'UNAVAILABLE', reason: 'the file is larger than this API will fetch' };
    }
    const bytes = read;
    if (declaredSize !== null && bytes.byteLength !== declaredSize) {
      /*
       * NOT refused, and that is deliberate. A short read is a truncated download and a
       * long one is a re-encode; either way the bytes in hand are what Telegram served,
       * and refusing a receipt over a size mismatch would hide evidence from a reviewer
       * for a reason that is not about the evidence. The bound above is the rule; this
       * is only an observation, and it is left unreported rather than logged — a log
       * line per reviewer click is the legacy activity feed.
       */
    }
    const declaredType = response.headers.get('content-type');
    return {
      outcome: 'SUCCEEDED',
      bytes,
      mimeType: declaredType === null || declaredType.length === 0 ? null : declaredType,
    };
  } catch (error) {
    return { outcome: 'UNAVAILABLE', reason: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The response body, or null once it passes the cap.
 *
 * Reads chunk by chunk and abandons the request as soon as the running total exceeds
 * `PAYMENT_RECEIPT_MAX_BYTES`, so the peak allocation is bounded by the cap plus one
 * chunk rather than by whatever the far end decides to send. The abort is what stops the
 * transfer; returning without it would leave the socket draining a file nobody wants.
 *
 * A body of `null` is a 200 with nothing in it, which is a zero-byte receipt rather than
 * a failure — the caller's size and type handling says what that is worth.
 */
async function readBounded(
  response: Response,
  controller: AbortController,
): Promise<Uint8Array | null> {
  const body = response.body;
  if (body === null) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > PAYMENT_RECEIPT_MAX_BYTES) {
      controller.abort();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/**
 * What a Telegram file path may look like: segments of unreserved characters.
 *
 * An ALLOW-list, for the reason `normalizeCardNumber` gives one: a deny-list of the
 * separators that would escape the path is a list somebody has to keep complete, and the
 * set of characters a real Telegram file path uses is small and known. `photos/`,
 * `documents/` and `music/` prefixes with a file name is the whole shape.
 */
const SAFE_FILE_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export function isSafeFilePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 512) return false;
  // `..` cannot survive the allow-list as a separator, but it CAN be a whole segment.
  if (candidate.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  return SAFE_FILE_PATH.test(candidate);
}

/** Never the exception object: an abort and a DNS failure both reach a reviewer as text. */
function describeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'the request timed out';
  return 'the file could not be fetched';
}
