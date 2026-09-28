import {
  SUBSCRIPTION_FILES_MAX_COUNT,
  SUBSCRIPTION_FILES_MAX_TOTAL_BYTES,
  SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH,
  SUBSCRIPTION_FILE_MAX_BYTES,
  SUBSCRIPTION_FILE_MEDIA_TYPES,
  SUBSCRIPTION_FILE_NAME_MAX_LENGTH,
  type ProviderSubscriptionFile,
  type SubscriptionFileMediaType,
} from '@nexa/contracts';

/**
 * Package E — a provider's subscription-files answer, decoded and bounded.
 *
 * Pure: the adapter hands in the response body and gets back files or `null` for an
 * answer that is not one (`docs/package-e-rickpanel-files-audit.md` §1, §3). The bytes
 * are credentials, so nothing here logs, throws with, or keeps a copy of them: a bad
 * entry becomes one more `failed`, never an error message carrying what was in it.
 */

/**
 * The standard alphabet, then at most two `=`. A flat character class, not a repeated
 * group: a grouped pattern backtracks per quantum and overflows V8's stack on a
 * multi-megabyte payload, which is exactly the size a real file can be.
 */
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeStrictBase64(text: string): Uint8Array | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64_ALPHABET.test(text)) return null;
  const bytes = Buffer.from(text, 'base64');
  if (bytes.toString('base64') !== text) return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * A file name a customer's device can save: a base name, no control characters, no
 * quotes, bounded. A name that reduces to nothing becomes `subscription-<n>`.
 */
export function safeFileName(value: unknown, index: number): string {
  const fallback = `subscription-${String(index + 1)}`;
  if (typeof value !== 'string') return fallback;
  const base = value.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"'`<>|*?:]/g, '').trim();
  const bounded = cleaned.slice(0, SUBSCRIPTION_FILE_NAME_MAX_LENGTH);
  // A name of only dots would be a directory reference, not a file.
  return bounded.length === 0 || /^\.+$/.test(bounded) ? fallback : bounded;
}

/** A provider's media type, mapped into the closed set; anything else is octet-stream. */
export function safeMediaType(value: unknown): SubscriptionFileMediaType {
  if (typeof value !== 'string') return 'application/octet-stream';
  const [type, ...parameters] = value
    .toLowerCase()
    .split(';')
    .map((part) => part.trim());
  // A `charset` parameter is harmless; any other one is a type this code did not vet.
  if (parameters.some((parameter) => !/^charset=[a-z0-9._-]+$/.test(parameter))) {
    return 'application/octet-stream';
  }
  return (SUBSCRIPTION_FILE_MEDIA_TYPES as readonly string[]).includes(type ?? '')
    ? (type as SubscriptionFileMediaType)
    : 'application/octet-stream';
}

/** A provider's caption, without control characters (a newline stays), bounded; or null. */
export function safeCaption(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH
    ? `${cleaned.slice(0, SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH - 1)}…`
    : cleaned;
}

/**
 * The entries of a files answer: a bare array, or an object whose `files` is one. The
 * document does not state the envelope, so both are accepted and nothing else is —
 * an answer in any other shape is malformed, never an empty list.
 */
function entriesOf(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) return body;
  if (typeof body === 'object' && body !== null) {
    const files = (body as Record<string, unknown>)['files'];
    if (Array.isArray(files)) return files;
  }
  return null;
}

/**
 * The files in a successful answer, or null when the answer is malformed.
 *
 * An entry is FAILED — counted, not read — when it carries an `error`, has no content,
 * does not decode, is empty, is over `SUBSCRIPTION_FILE_MAX_BYTES`, or would take the
 * total over `SUBSCRIPTION_FILES_MAX_TOTAL_BYTES`. More entries than
 * `SUBSCRIPTION_FILES_MAX_COUNT` is malformed rather than truncated: a panel answering
 * with hundreds of formats is not one this code understands.
 */
export function parseSubscriptionFiles(
  bodyText: string,
): { readonly files: readonly ProviderSubscriptionFile[]; readonly failed: number } | null {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const entries = entriesOf(body);
  if (entries === null || entries.length > SUBSCRIPTION_FILES_MAX_COUNT) return null;

  const files: ProviderSubscriptionFile[] = [];
  let failed = 0;
  let total = 0;
  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      failed += 1;
      return;
    }
    const record = entry as Record<string, unknown>;
    const content = record['content_b64'];
    const error = record['error'];
    if ((error !== undefined && error !== null) || typeof content !== 'string') {
      failed += 1;
      return;
    }
    const bytes = decodeStrictBase64(content);
    if (
      bytes === null ||
      bytes.byteLength === 0 ||
      bytes.byteLength > SUBSCRIPTION_FILE_MAX_BYTES ||
      total + bytes.byteLength > SUBSCRIPTION_FILES_MAX_TOTAL_BYTES
    ) {
      failed += 1;
      return;
    }
    total += bytes.byteLength;
    files.push({
      fileName: safeFileName(record['filename'], index),
      mediaType: safeMediaType(record['media_type']),
      bytes,
      caption: safeCaption(record['caption']),
    });
  });
  return { files, failed };
}

/** The panel's documented window, used when a 429 does not say how long to wait. */
export const SUBSCRIPTION_FILES_DEFAULT_RETRY_MS = 60_000;

/**
 * A `Retry-After` in delta-seconds, as milliseconds; anything else (absent, an HTTP
 * date, garbage) is the documented one-minute window. Bounded to an hour so a panel
 * cannot tell a customer to come back next year.
 */
export function retryAfterMs(header: string | undefined): number {
  if (header !== undefined && /^\d{1,6}$/.test(header.trim())) {
    return Math.min(Number(header.trim()) * 1000, 3_600_000);
  }
  return SUBSCRIPTION_FILES_DEFAULT_RETRY_MS;
}
