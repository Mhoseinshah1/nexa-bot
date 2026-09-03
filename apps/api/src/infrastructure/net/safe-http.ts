import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type {
  ProviderFailureKind,
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
} from '@nexa/contracts';
import { addressAllowed, checkUrl, type UrlPolicyOptions } from './url-policy.js';

/**
 * The one way anything in this installation makes an outbound provider call.
 *
 * Built on `node:https` rather than `fetch`, and that is the load-bearing
 * decision in this file. `fetch` gives no hook on address resolution, so with
 * it the only available SSRF defence is "resolve the name, check the answer,
 * then ask fetch to resolve it again and hope it gets the same one". That gap
 * is DNS rebinding: a name whose TTL is zero answers with an allowed address
 * for the check and a forbidden one for the connection, and nothing in between
 * would notice.
 *
 * `http.request` takes a `lookup` function, which `net.connect` calls to decide
 * where the socket actually goes. Supplying one that returns a PINNED,
 * already-validated address closes the window by construction: there is no
 * second resolution to disagree with the first.
 *
 * Everything else the client enforces is here because an adapter must not be
 * able to opt out of it:
 *
 *   - a total deadline, covering DNS, connect, TLS and the whole body;
 *   - a response size cap, enforced while reading rather than after;
 *   - redirects NEVER followed;
 *   - normalized failures, so no adapter re-derives the taxonomy from a message;
 *   - bounded retry that refuses to retry a deterministic failure;
 *   - diagnostics that carry a status number and nothing else.
 */

export interface SafeHttpOptions extends UrlPolicyOptions {
  /** The whole call: DNS, connect, TLS, request, response body. */
  readonly totalTimeoutMs: number;
  /** Bytes of response body kept. Reading stops the moment this is passed. */
  readonly maxResponseBytes: number;
  /**
   * Extra attempts after the first, for TRANSIENT failures only.
   *
   * Zero by default and zero for probes. An authentication probe retried on a
   * schedule is a credential-stuffing loop pointed at the operator's own panel,
   * and several panels lock an account after enough of them — so a
   * deterministic failure is never retried whatever this says. Backoff between
   * scheduled probes is the health scheduler's job, not this client's.
   */
  readonly maxRetries: number;
}

export const DEFAULT_SAFE_HTTP: Omit<SafeHttpOptions, 'allowLoopback'> = {
  totalTimeoutMs: 10_000,
  maxResponseBytes: 512 * 1024,
  maxRetries: 0,
};

/** Failures where another attempt could plausibly land differently. */
const TRANSIENT: ReadonlySet<ProviderFailureKind> = new Set<ProviderFailureKind>([
  'UNREACHABLE',
  'TIMEOUT',
]);

/**
 * A Node error code, as one of our kinds.
 *
 * The default is `UNREACHABLE` rather than a generic internal failure: every
 * code that reaches here without matching is a socket-level problem, and
 * telling an operator "the panel could not be reached" is both true and
 * actionable where "an internal error occurred" is neither.
 */
function failureFromError(error: unknown, timedOut: boolean): ProviderFailureKind {
  if (timedOut) return 'TIMEOUT';
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'TIMEOUT';
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
    code === 'EPROTO'
  ) {
    return 'TLS_FAILED';
  }
  return 'UNREACHABLE';
}

/**
 * Every address a name resolves to, or null when it resolves to nothing.
 *
 * `all: true` matters: a name with one allowed and one forbidden address must
 * be judged on the address that will actually be dialled, and taking only the
 * first answer means the decision depends on resolver ordering.
 */
async function resolveAll(hostname: string): Promise<readonly LookupAddress[] | null> {
  return new Promise((resolve) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      resolve(error !== null || addresses.length === 0 ? null : addresses);
    });
  });
}

interface Attempt {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

export class SafeHttpClient {
  constructor(private readonly options: SafeHttpOptions) {}

  /**
   * A client bound to one base URL.
   *
   * This is what an adapter receives. It cannot widen the options, cannot
   * change the base, and cannot address another host: `send` resolves the
   * adapter's PATH against the base and refuses anything absolute.
   */
  forBase(baseUrl: string): ProviderHttpClient {
    return {
      send: (request: ProviderHttpRequest) => this.send(baseUrl, request),
    };
  }

  async send(baseUrl: string, request: ProviderHttpRequest): Promise<ProviderHttpResult> {
    // An adapter states a path. An absolute URL here would be an adapter
    // choosing its own destination, which is the thing the whole design
    // removes — so it is refused rather than resolved.
    if (/^[a-z][a-z0-9+.-]*:/i.test(request.path) || request.path.startsWith('//')) {
      return { ok: false, failure: 'BLOCKED_TARGET', status: null };
    }

    let target: URL;
    try {
      target = new URL(request.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    } catch {
      return { ok: false, failure: 'BLOCKED_TARGET', status: null };
    }

    // The composed URL is re-checked, not just the base. `..` segments in a
    // path cannot change the host, but the scheme and the policy rules are
    // cheap to re-assert and a future caller may compose differently.
    const verdict = checkUrl(target.toString(), this.options);
    if (!verdict.allowed) return { ok: false, failure: 'BLOCKED_TARGET', status: null };

    let failure: ProviderFailureKind = 'UNREACHABLE';
    let status: number | null = null;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const outcome = await this.attempt(verdict.url, request);
      if (outcome.ok) return outcome;
      failure = outcome.failure;
      status = outcome.status;
      if (!TRANSIENT.has(outcome.failure)) break;
    }
    return { ok: false, failure, status };
  }

  private async attempt(url: URL, request: ProviderHttpRequest): Promise<ProviderHttpResult> {
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

    // Resolve ONCE, judge every answer, and keep the one that will be dialled.
    const addresses = await resolveAll(hostname);
    if (addresses === null) return { ok: false, failure: 'UNREACHABLE', status: null };
    const permitted = addresses.filter(
      (entry) => addressAllowed(entry.address, this.options).allowed,
    );
    if (permitted.length === 0) return { ok: false, failure: 'BLOCKED_TARGET', status: null };
    const pinned = permitted[0]!;

    const body = encodeBody(request);
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain;q=0.5, */*;q=0.1',
      'user-agent': 'nexa-bot',
      ...(request.headers ?? {}),
    };
    if (body !== null) {
      headers['content-type'] = body.contentType;
      headers['content-length'] = String(Buffer.byteLength(body.payload));
    }

    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;

    return new Promise<ProviderHttpResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let outgoing: ClientRequest | null = null;

      const finish = (result: ProviderHttpResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        outgoing?.destroy();
        resolve(result);
      };

      // ONE deadline for the whole call. A per-socket timeout does not bound a
      // server that sends a byte every few seconds forever, which is the shape
      // that ties up a worker without ever looking like a failure.
      const deadline = setTimeout(() => {
        timedOut = true;
        finish({ ok: false, failure: 'TIMEOUT', status: null });
      }, this.options.totalTimeoutMs);

      try {
        outgoing = send(
          {
            protocol: url.protocol,
            // The NAME stays the host header and the TLS server name, so
            // certificate validation is against the name the operator
            // configured. Only where the socket goes is pinned.
            host: hostname,
            ...(secure ? { servername: hostname } : {}),
            port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
            // The pin. `net.connect` calls this instead of resolving again, so
            // the socket goes to an address that was judged allowed — there is
            // no second resolution for a rebinding attack to win.
            lookup: (_host, _opts, callback) => {
              // Re-checked here rather than trusted from the closure. This is
              // the last point before a socket exists, and a check at the last
              // point is the one that cannot be skipped by a path that
              // constructs options differently later.
              if (!addressAllowed(pinned.address, this.options).allowed) {
                (callback as (error: Error | null) => void)(new Error('address not allowed'));
                return;
              }
              (callback as (e: Error | null, a: string, f: number) => void)(
                null,
                pinned.address,
                pinned.family,
              );
            },
          },
          (response: IncomingMessage) => {
            const code = response.statusCode ?? 0;

            // Redirects are NEVER followed. A 30x from an operator-configured
            // panel is either a misconfiguration the operator should fix — an
            // http base that redirects to https — or somebody moving the
            // request to a host the policy already refused. Following it would
            // re-open every question this file answers, one hop later.
            if (code >= 300 && code < 400) {
              response.resume();
              finish({ ok: false, failure: 'MALFORMED_RESPONSE', status: code });
              return;
            }

            const chunks: Buffer[] = [];
            let size = 0;
            let overflowed = false;

            response.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > this.options.maxResponseBytes) {
                // Stopped WHILE reading, not after. A cap applied to a
                // completed buffer has already spent the memory it was meant
                // to protect.
                overflowed = true;
                response.destroy();
                finish({ ok: false, failure: 'MALFORMED_RESPONSE', status: code });
                return;
              }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (overflowed) return;
              const collected: Record<string, string> = {};
              for (const [key, value] of Object.entries(response.headers)) {
                collected[key.toLowerCase()] = Array.isArray(value)
                  ? value.join(', ')
                  : (value ?? '');
              }
              finish({
                ok: true,
                status: code,
                headers: collected,
                bodyText: Buffer.concat(chunks).toString('utf8'),
              });
            });
            response.on('error', (error: unknown) => {
              finish({ ok: false, failure: failureFromError(error, timedOut), status: code });
            });
          },
        );
      } catch (error) {
        finish({ ok: false, failure: failureFromError(error, timedOut), status: null });
        return;
      }

      outgoing.on('error', (error: unknown) => {
        finish({ ok: false, failure: failureFromError(error, timedOut), status: null });
      });

      if (body !== null) outgoing.write(body.payload);
      outgoing.end();
    });
  }
}

function encodeBody(
  request: ProviderHttpRequest,
): { readonly payload: string; readonly contentType: string } | null {
  if (request.body === undefined) return null;
  if (request.body.kind === 'json') {
    return { payload: JSON.stringify(request.body.value), contentType: 'application/json' };
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(request.body.value)) form.append(key, value);
  return { payload: form.toString(), contentType: 'application/x-www-form-urlencoded' };
}

/** Attempts are an internal shape; exported only so tests can name it. */
export type { Attempt };
