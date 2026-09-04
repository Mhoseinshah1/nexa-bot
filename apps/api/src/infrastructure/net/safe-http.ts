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
  /**
   * Additional certificate authorities to trust, as PEM.
   *
   * For the self-hosted case this product is built around: a panel behind an
   * organisation's own CA presents a certificate no public trust store knows.
   * Without this the operator's only options are to disable verification —
   * which this client will not do — or to put a publicly-trusted certificate in
   * front of a machine that may not be reachable from the internet at all.
   *
   * ADDITIONAL, never instead of. The system trust store still applies, and
   * verification stays on: there is no `rejectUnauthorized: false` anywhere in
   * this file and adding one would defeat the point of the rest of it. Leaving
   * this undefined — which is the default and what production uses unless an
   * operator sets `PANEL_HTTP_CA_FILE` — means ordinary public verification.
   */
  readonly caCertificates?: readonly string[];
  /**
   * How a hostname becomes addresses. Defaults to the system resolver.
   *
   * A port, in the sense this codebase already uses for `Clock` and
   * `IdGenerator`: DNS is I/O, and I/O that a security decision depends on has
   * to be controllable or the decision cannot be tested. The pin below is the
   * case in point — it is the difference between "we checked an address" and
   * "we connected to the address we checked", and those two are
   * indistinguishable to a test unless the two resolutions can be made to
   * disagree.
   *
   * The alternatives were considered and are worse: a test cannot make the
   * SYSTEM resolver answer differently on successive queries without rewriting
   * `/etc/resolv.conf` or `/etc/hosts` mid-request, which needs root, races the
   * connection, and would not survive a CI runner. This is the smaller change.
   */
  readonly resolve?: (hostname: string) => Promise<readonly LookupAddress[] | null>;
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
    const addresses = await (this.options.resolve ?? resolveAll)(hostname);
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
            // Trusted IN ADDITION to the system store, and only over TLS.
            // Verification is never turned off; this only widens what counts
            // as a valid issuer, which is what an internal CA needs.
            ...(secure && this.options.caCertificates !== undefined
              ? { ca: [...this.options.caCertificates] }
              : {}),
            port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
            // No connection pool, and this is part of the pin rather than a
            // performance choice. The global agent keys sockets by host and
            // port, NOT by the address they were opened to — so a pooled socket
            // outlives the address check that authorised it, and a later
            // request to the same name would ride a connection to an address
            // this call never approved. A probe is one request every few
            // minutes; a fresh socket costs nothing worth having here.
            agent: false,
            method: request.method,
            path: `${url.pathname}${url.search}`,
            headers,
            // The pin. `net.connect` calls this instead of resolving again, so
            // the socket goes to an address that was judged allowed — there is
            // no second resolution for a rebinding attack to win.
            lookup: (_host, opts, callback) => {
              // UNREACHABLE today, and kept deliberately. `pinned` is chosen
              // from `permitted`, which is already filtered by exactly this
              // predicate, so this branch cannot fire as the code stands — a
              // mutation deleting it leaves every test green, which is stated
              // here rather than left for someone to discover and mistake for
              // covered ground.
              //
              // It earns its place against one specific future edit: a change
              // to how `pinned` is selected — picking from `addresses` rather
              // than `permitted`, say, or taking a caller-supplied address —
              // would silently hand a forbidden destination to the socket, and
              // this is the last statement before one exists.
              if (!addressAllowed(pinned.address, this.options).allowed) {
                (callback as (error: Error | null) => void)(new Error('address not allowed'));
                return;
              }
              // Two shapes, and answering with the wrong one breaks the request
              // rather than the pin. Node asks with `all: true` — happy-eyeballs
              // does, and it is on by default since Node 20 — and then requires
              // an ARRAY; the three-argument form yields
              // `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`.
              //
              // This was wrong until the pin got a test that reaches a socket.
              // Nothing caught it because an IP-literal URL never calls `lookup`
              // at all, and every other test in this suite uses one. A panel
              // addressed by hostname — which is the ordinary case, and the only
              // case the pin exists for — failed every probe, and the operator
              // would have read it as an unreachable panel.
              if (opts !== null && typeof opts === 'object' && opts.all === true) {
                (callback as (e: Error | null, a: LookupAddress[]) => void)(null, [
                  { address: pinned.address, family: pinned.family },
                ]);
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
