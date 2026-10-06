import {
  safeProviderToken,
  type SupportAiFailureClass,
  type SupportAiFailureDetail,
} from '@nexa/contracts';
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
    const read = await readBounded(response, controller);
    // Decided from what the read SAW, never from the signal afterwards: the size cap aborts the
    // controller itself, so "aborted" alone cannot tell a timeout from an oversized body.
    if (read.kind === 'TOO_LARGE') return { kind: 'NETWORK', code: 'body_too_large' };
    if (read.kind === 'FAILED') {
      return read.aborted ? { kind: 'TIMEOUT' } : { kind: 'NETWORK', code: 'body_read_failed' };
    }
    return {
      kind: 'RESPONSE',
      status: response.status,
      headers: response.headers,
      body: read.body,
    };
  } finally {
    clearTimeout(timer);
  }
}

type BoundedRead =
  | { readonly kind: 'BODY'; readonly body: string }
  | { readonly kind: 'TOO_LARGE' }
  | { readonly kind: 'FAILED'; readonly aborted: boolean };

async function readBounded(response: Response, controller: AbortController): Promise<BoundedRead> {
  if (response.body === null) return { kind: 'BODY', body: '' };
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
        return { kind: 'TOO_LARGE' };
      }
      chunks.push(value);
    }
  } catch {
    // The timer's abort surfaces here as a read error; anything else is the connection.
    return { kind: 'FAILED', aborted: controller.signal.aborted };
  }
  return { kind: 'BODY', body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

/**
 * Output-token HEADROOM over what the caller asked for (`OQ-TB-20`). Reasoning and thinking
 * tokens are billed against the same output budget on current models, so a budget sized to the
 * reply alone can be spent before the reply is written — a truncation, read as
 * `INVALID_OUTPUT`, which STOPS the chain. No effort or thinking field is sent (none is proven
 * against the real APIs yet); instead the budget is generous: the caller's figure plus this
 * headroom, capped at `AI_OUTPUT_TOKEN_BUDGET_MAX`, and never below the caller's figure. The
 * reply's real bound is the caller's schema and character limit, not this number.
 */
export const AI_OUTPUT_TOKEN_HEADROOM = 4_096;
/**
 * The cap. 16,384 is the smallest output limit among the models that accept strict structured
 * output at all (the earliest such OpenAI snapshots; every Anthropic model with
 * `output_config`, and every reasoning model, allows more), so the cap never turns a capable
 * model's request into a 400 — while still leaving a decision at the largest configurable
 * reply (`decisionOutputTokens(4000)`) its own full worst-case budget plus the headroom.
 * The earlier cap (8,192, so 8,096 at the largest reply) left a reasoning model only what a
 * 4,000-character Persian reply did not use — a few thousand tokens — before the answer was
 * cut (`finish_reason: length`, read as `truncated`).
 */
export const AI_OUTPUT_TOKEN_BUDGET_MAX = 16_384;

export function outputTokenBudget(requested: number): number {
  return Math.max(
    requested,
    Math.min(requested + AI_OUTPUT_TOKEN_HEADROOM, AI_OUTPUT_TOKEN_BUDGET_MAX),
  );
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

/**
 * A failed call's operator diagnosis (`SUPPORT_AI_FAILURE_CLASSES`). The provider's error
 * `code`, `type` and `param` are kept only as short machine tokens (`safeProviderToken`) —
 * never its `message`, which is prose and may quote the request.
 */
export function failureDetail(
  failureClass: SupportAiFailureClass,
  from: {
    readonly httpStatus?: number | null;
    readonly error?: Record<string, unknown> | null;
  } = {},
): SupportAiFailureDetail {
  const error = from.error ?? null;
  return {
    failureClass,
    httpStatus: from.httpStatus ?? null,
    providerErrorCode: safeProviderToken(error?.code),
    providerErrorType: safeProviderToken(error?.type),
    providerErrorParam: safeProviderToken(error?.param),
  };
}

/**
 * A 2xx whose body is not JSON at all — a proxy's or captive portal's HTML page — is not the
 * provider answering. It is `TEMPORARY` (the next provider may be reachable), never
 * `INVALID_OUTPUT`, which would stop the chain and blame the model, and never `OK`.
 */
export function nonJsonSuccess(
  result: Extract<AiHttpResult, { kind: 'RESPONSE' }>,
  body: unknown,
  prefix: string,
): {
  readonly outcome: 'TEMPORARY';
  readonly code: string;
  readonly detail: SupportAiFailureDetail;
} | null {
  if (result.status < 200 || result.status >= 300) return null;
  if (body !== null && typeof body === 'object') return null;
  return {
    outcome: 'TEMPORARY',
    code: `${prefix}.non_json_body`,
    detail: failureDetail('network', { httpStatus: result.status }),
  };
}

/** `JSON.parse` that returns null instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
