import type { ProviderHttpResult } from '@nexa/contracts';
import type { RickpanelReadOnlyHttp } from '../../providers/infrastructure/rickpanel-inventory.js';
import {
  parseJson,
  type RickpanelTokenForm,
} from '../../providers/infrastructure/rickpanel-protocol.js';

/**
 * Load protection for a migration's live RickPanel read (owner requirement on PR #281).
 *
 * A Mirza import reads every account of a production panel, twice, through the panel's
 * paginated list (`GET api/users?offset=&limit=` — the only list route there is). This
 * module sits UNDER `RickpanelInventoryReader`, at the read-only HTTP surface, and decides
 * nothing about the inventory: what is complete, consistent or adoptable is still the
 * reader's two-walk rule, untouched. What it decides is how hard the panel is asked:
 *
 * - PACING: at least `requestIntervalMs` between the starts of two requests, and after a
 *   slow answer (≥ `SLOW_RESPONSE_MS`) as long again before the next one — a struggling
 *   panel is asked at most half the time. One request in flight: the reader awaits each.
 * - ONE LOGIN per read: a successful token exchange is reused by every later walk and
 *   attempt of the SAME read (it lives in this closure only, for this read only). A 401
 *   on a page — the token expired mid-read — buys one fresh login (`maxTokenRefreshes`),
 *   never more; a refused login is never asked again.
 * - BOUNDED RETRIES: a 429 waits the panel's own `Retry-After` (a panel asking for longer
 *   than `maxRetryAfterMs` is not asked again); a timeout, an unreachable panel or a 5xx
 *   waits `INVENTORY_BACKOFF_MS`. Every retry of the read draws on ONE budget
 *   (`maxRetries`), so they cannot multiply. A 4xx, an oversized or malformed answer, a
 *   TLS or a blocked target is final.
 * - CANCELLATION: the step signal is checked before every request, and every wait ends on
 *   it. A held panel lease that is lost stops the read the same way.
 *
 * Counts only leave this module (`PanelReadCounters`): never a token, a username or a row.
 */

export interface PanelReadPolicy {
  /** The least time between the STARTS of two requests to the panel. */
  readonly requestIntervalMs: number;
  /** Retries of one read's requests — pages and logins together — after a transient failure. */
  readonly maxRetries: number;
  /** Fresh logins after the panel refused the reused token mid-read (an expiry). */
  readonly maxTokenRefreshes: number;
  /** The longest `Retry-After` honoured. A panel asking for longer is not asked again. */
  readonly maxRetryAfterMs: number;
}

/** One request a second: the conservative start the owner set. Configurable. */
export const INVENTORY_REQUEST_INTERVAL_MS = 1_000;
/** The waits after a timeout, an unreachable panel, a 5xx, or a 429 that names no wait. */
export const INVENTORY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000];
/** An answer at least this slow makes the next request wait as long again. */
export const SLOW_RESPONSE_MS = 2_000;
/** The longest such extra wait. */
export const MAX_SLOW_GAP_MS = 30_000;

export const DEFAULT_PANEL_READ_POLICY: PanelReadPolicy = Object.freeze({
  requestIntervalMs: INVENTORY_REQUEST_INTERVAL_MS,
  maxRetries: 4,
  maxTokenRefreshes: 1,
  maxRetryAfterMs: 120_000,
});

/** What a read cost the panel. Counts and milliseconds only. */
export interface PanelReadCounters {
  /** Every request sent: logins and pages. */
  requests: number;
  /** Token exchanges sent. */
  logins: number;
  /** Token exchanges answered from this read's own successful login, unsent. */
  tokenReuses: number;
  /** Fresh logins after a 401 on a page. */
  tokenRefreshes: number;
  /** Requests sent again after a transient failure (429, timeout, unreachable, 5xx). */
  retries: number;
  /** Time spent waiting before requests: pacing, backoff and `Retry-After`. */
  waitedMs: number;
  /** The largest list page received, in bytes (to tune the page size from evidence). */
  maxPageBytes: number;
}

export function emptyPanelReadCounters(): PanelReadCounters {
  return {
    requests: 0,
    logins: 0,
    tokenReuses: 0,
    tokenRefreshes: 0,
    retries: 0,
    waitedMs: 0,
    maxPageBytes: 0,
  };
}

/** Why a read waits. Lets a test tell the pause between attempts from pacing. */
export type ReadWaitKind = 'pace' | 'backoff' | 'retry-after' | 'attempt' | 'lock';

/** Time, as the read sees it. The real one waits; a test advances a fake clock. */
export interface ReadClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal | undefined, kind: ReadWaitKind): Promise<void>;
}

/** A wait that ends early, rejecting, when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const realReadClock: ReadClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number, signal: AbortSignal | undefined) => abortableSleep(ms, signal),
});

/**
 * A `Retry-After` as milliseconds from now: delta-seconds or an HTTP-date. Null when the
 * header is absent or unreadable (the backoff applies instead). Never negative.
 */
export function retryAfterDelayMs(header: string | undefined, nowMs: number): number | null {
  if (header === undefined) return null;
  const value = header.trim();
  if (/^\d{1,9}$/u.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

const isTransport = (result: ProviderHttpResult) =>
  !result.ok && (result.failure === 'TIMEOUT' || result.failure === 'UNREACHABLE');

const sameForm = (a: RickpanelTokenForm, b: RickpanelTokenForm) =>
  a.username === b.username && a.password === b.password && a.grant_type === b.grant_type;

function tokenOf(result: ProviderHttpResult): string | null {
  if (!result.ok || result.status < 200 || result.status >= 300) return null;
  const token = parseJson(result.bodyText)?.['access_token'];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export interface ProtectedReadOptions {
  readonly policy: PanelReadPolicy;
  readonly clock: ReadClock;
  readonly counters: PanelReadCounters;
  readonly signal?: AbortSignal;
  /** True once the panel's read lease is lost: no further request is sent. */
  readonly leaseLost?: () => boolean;
}

/**
 * The read-only surface of ONE panel read, paced, authenticated once and bounded. The
 * returned object has the same three fixed reads as the one it wraps, and nothing else.
 */
export function protectedReadSession(
  http: RickpanelReadOnlyHttp,
  options: ProtectedReadOptions,
): RickpanelReadOnlyHttp {
  const { policy, clock, counters, signal } = options;
  // The first request waits a full interval after the read began (after its lease was
  // taken): a read that follows another's on the same panel keeps the same spacing.
  let lastStart = clock.now();
  let lastEnd: number | null = null;
  let lastLatency = 0;
  let retries = 0;
  let refreshes = 0;
  let form: RickpanelTokenForm | null = null;
  let login: ProviderHttpResult | null = null;
  let token: string | null = null;

  const stopIfCancelled = () => {
    signal?.throwIfAborted();
    if (options.leaseLost?.() === true) throw new Error('the panel read lease was lost');
  };

  const wait = async (ms: number, kind: ReadWaitKind) => {
    if (ms <= 0) return;
    counters.waitedMs += ms;
    await clock.sleep(ms, signal, kind);
  };

  const send = async (request: () => Promise<ProviderHttpResult>) => {
    stopIfCancelled();
    const now = clock.now();
    let earliest = Math.max(now, lastStart + policy.requestIntervalMs);
    if (lastEnd !== null && lastLatency >= SLOW_RESPONSE_MS) {
      earliest = Math.max(earliest, lastEnd + Math.min(lastLatency, MAX_SLOW_GAP_MS));
    }
    await wait(earliest - now, 'pace');
    stopIfCancelled();
    const start = clock.now();
    lastStart = start;
    counters.requests += 1;
    try {
      return await request();
    } finally {
      lastEnd = clock.now();
      lastLatency = lastEnd - start;
    }
  };

  /** One more retry, if the read's budget allows; waits first. */
  const retry = async (ms: number, kind: ReadWaitKind): Promise<boolean> => {
    if (retries >= policy.maxRetries) return false;
    retries += 1;
    counters.retries += 1;
    await wait(ms, kind);
    return true;
  };
  const backoff = () =>
    INVENTORY_BACKOFF_MS[Math.min(retries, INVENTORY_BACKOFF_MS.length - 1)] ?? 30_000;

  const exchange = async (given: RickpanelTokenForm): Promise<ProviderHttpResult> => {
    for (;;) {
      const answer = await send(() => http.exchangeToken(given));
      counters.logins += 1;
      // Only the transport is asked again: any ANSWER the token exchange gave (a 401, a
      // 403, a 429, a 4xx) is one more failed login if asked again.
      if (isTransport(answer) && (await retry(backoff(), 'backoff'))) continue;
      const fresh = tokenOf(answer);
      if (fresh !== null) {
        form = given;
        login = answer;
        token = fresh;
      }
      return answer;
    }
  };

  /**
   * One authenticated read, asked again within the read's ONE budget when the answer says
   * nothing about the account: a transport failure, a 429 (after the panel's own
   * `Retry-After`, never longer than the cap), a 5xx. A 401 — the reused token expired — buys
   * one fresh login and the same request again. Anything else is the answer.
   */
  const ask = async (
    request: (currentToken: string | null) => Promise<ProviderHttpResult>,
    isPage: boolean,
  ): Promise<ProviderHttpResult> => {
    for (;;) {
      const answer = await send(() => request(token));
      if (!answer.ok) {
        if (isTransport(answer) && (await retry(backoff(), 'backoff'))) continue;
        return answer;
      }
      if (isPage) {
        counters.maxPageBytes = Math.max(
          counters.maxPageBytes,
          Buffer.byteLength(answer.bodyText, 'utf8'),
        );
      }
      if (answer.status === 401 && form !== null && refreshes < policy.maxTokenRefreshes) {
        // The reused token expired mid-read: one fresh login, then this request again.
        refreshes += 1;
        counters.tokenRefreshes += 1;
        const credentials: RickpanelTokenForm = form;
        login = null;
        token = null;
        await exchange(credentials);
        if (token !== null) continue;
        return answer;
      }
      if (answer.status === 429) {
        const asked = retryAfterDelayMs(answer.headers['retry-after'], Date.now());
        if (asked !== null && asked > policy.maxRetryAfterMs) return answer;
        if (await retry(asked ?? backoff(), asked === null ? 'backoff' : 'retry-after')) continue;
        return answer;
      }
      if (answer.status >= 500 && (await retry(backoff(), 'backoff'))) continue;
      return answer;
    }
  };

  return Object.freeze({
    exchangeToken: async (given: RickpanelTokenForm) => {
      if (login !== null && form !== null && sameForm(given, form)) {
        counters.tokenReuses += 1;
        return login;
      }
      return exchange(given);
    },
    listUsersPage: (bearer: string, offset: number, limit: number) =>
      ask((current) => http.listUsersPage(current ?? bearer, offset, limit), true),
    // An exact lookup (a per-name resolution): the same pacing, budget and refresh as a page.
    // A 404 is an ANSWER ("not on this panel"), handed to the reader like any other status.
    readUser: (bearer: string, username: string) =>
      ask((current) => http.readUser(current ?? bearer, username), false),
  });
}
