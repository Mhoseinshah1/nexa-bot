import { assertOutsideTransaction } from '../transaction-boundary.js';

/**
 * TB4 — ONE HTTPS request to an AI provider (ADR-0034 §2). Every adapter's network call goes
 * through here, so each inherits the same discipline:
 *
 * - it refuses to run inside a database transaction (a provider call can take a minute);
 * - `redirect: 'error'` — a key in a header must never follow a redirect to another host;
 * - an abort timeout, and a BOUNDED read of the body;
 * - it never throws: a timeout, a network failure and an HTTP answer are three distinct
 *   results, because they map to three different outcomes.
 *
 * Nothing about the request or the response body is logged here: both are a customer's
 * conversation.
 */
export type AiHttpResult =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      readonly headers: Headers;
      readonly body: string;
    }
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'NETWORK'; readonly code: string };

export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A provider answer larger than this is not a support decision. */
export const AI_RESPONSE_MAX_BYTES = 1_000_000;

export async function aiHttpRequest(
  request: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly timeoutMs: number;
  },
  doFetch: AiFetch = (url, init) => fetch(url, init),
): Promise<AiHttpResult> {
  assertOutsideTransaction('An AI provider call');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(request.url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'TIMEOUT' };
      return { kind: 'NETWORK', code: error instanceof Error ? error.name : 'unknown' };
    }
    const body = await readBounded(response, controller);
    if (body === null) {
      return controller.signal.aborted ? { kind: 'TIMEOUT' } : { kind: 'NETWORK', code: 'body_too_large' };
    }
    return { kind: 'RESPONSE', status: response.status, headers: response.headers, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, controller: AbortController): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AI_RESPONSE_MAX_BYTES) {
        controller.abort();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The provider's own wait, in milliseconds: `retry-after-ms` first (OpenAI's), then
 * `retry-after` as seconds or an HTTP date. Null when absent or unreadable — never invented.
 */
export function retryAfterMsOf(headers: Headers, nowMs: number): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/u.test(ms.trim())) return Math.round(Number(ms));
  const value = headers.get('retry-after');
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/u.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** `JSON.parse` that returns null instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
