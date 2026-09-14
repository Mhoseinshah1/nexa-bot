import {
  providerDescriptor,
  type ProviderAdapter,
  type ProviderConnectionAdapter,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderHttpClient,
  type ProviderHttpResult,
  type ProviderFailureResult,
  type ProviderLookupOutcome,
  type ProviderProbeOutcome,
  type ProviderServiceTarget,
  type ProviderTarget,
  type ProviderUsage,
  type ProviderUsageOutcome,
  type ProviderUserOutcome,
  type ProviderUserRef,
  type CreateProviderUserInput,
  type SanaeiActivation,
} from '@nexa/contracts';

/**
 * Sanaei / 3X-UI.
 *
 * **Where these endpoints come from.** The official MHSanaei/3x-ui source at
 * tag `v3.7.0`, commit `f727d04f6522bb94a8fb52e8352fdcafb51c11e1` — read, not
 * inferred from a similar release and not taken from the research corpus, which
 * records no 3X-UI path or payload at all. The four files that establish every
 * rule below are `internal/web/controller/api.go` (bearer auth, scopes, the
 * 401/404 split), `internal/web/controller/index.go` (login, csrf-token,
 * getTwoFactorEnable), `internal/web/middleware/security.go` and
 * `internal/web/session/csrf.go` (the CSRF contract). What that bounds is
 * stated plainly in `docs/providers/sanaei-3xui.md`: this adapter is verified
 * against the v3.7.0 wire contract and claims nothing about other releases.
 *
 * **Two authentication modes, chosen before this file is reached.** v3.7.0
 * accepts a scoped Bearer token or a session cookie, and the credential
 * resolver decides which — an adapter that could see both would be an adapter
 * that could fall back from a rejected token to the password, which is exactly
 * the escalation an operator who configured token-only access did not ask for.
 *
 * **Mode A, Bearer.** One request:
 *
 *   `GET panel/api/server/status` with `Authorization: Bearer <token>`.
 *
 * No CSRF round trip — `CSRFMiddleware` short-circuits for a request
 * `checkAPIAuth` already authenticated (`api_authed`), so asking for a token
 * first would be a wasted request against a panel that does not want one.
 *
 * **Mode B, session.** Three requests, in this order, because v3.7.0's login
 * route is behind `CSRFMiddleware` and a bare POST to it is answered 403:
 *
 *   1. `GET csrf-token`  → the token, and the `3x-ui` session cookie it is
 *      bound to. `ValidateCSRFToken` compares the submitted header against the
 *      token stored IN THAT SESSION, so the cookie and the token are one unit
 *      and neither works without the other.
 *   2. `POST getTwoFactorEnable` — same cookie, same token. Asked BEFORE any
 *      credential is sent, and this is a deliberate extra request rather than
 *      an optimisation: `defaultLoginLimiter` in v3.7.0 blocks an
 *      IP-and-username pair after enough failures, so discovering 2FA by
 *      submitting a login that cannot succeed spends the operator's own lockout
 *      budget. When it answers true this adapter stops and says so.
 *   3. `POST login` — same cookie, same token, username and password. Then the
 *      status read, with the session cookie the login returned.
 *
 * **A 2xx is not a success.** v3.7.0 answers a wrong username, a wrong password
 * and a wrong 2FA code with HTTP 200 and `{"success": false, …}`. Every
 * response this adapter consumes is parsed for the `{success, msg, obj}`
 * envelope and judged on `success`, never on the status alone.
 *
 * **Nothing upstream says is repeated.** `msg` is localized, and on a failed
 * login it is the panel echoing back a decision made about credentials that
 * were just submitted. It never reaches an outcome: what leaves this file is a
 * failure kind, a status number, and a version string that had to pass a
 * character allowlist to get out.
 */

/**
 * Paths, all RELATIVE and none with a leading slash.
 *
 * The load-bearing detail on this line is the absence of `/`. `webBasePath` is
 * a real v3.7.0 setting — a panel is routinely served at
 * `https://host:2053/a-long-random-path/` — and the client resolves these
 * against that base with WHATWG semantics, where a leading slash discards the
 * configured path and lands on the origin root. A panel would then answer 404
 * for reasons an operator could not possibly diagnose from Nexa's side, and on
 * a differently-configured host the same mistake would send credentials to
 * whatever else is mounted at the root.
 */
const STATUS_PATH = 'panel/api/server/status';
const CSRF_PATH = 'csrf-token';
const TWO_FACTOR_PATH = 'getTwoFactorEnable';
const LOGIN_PATH = 'login';
/**
 * Adding a client to an inbound, and reading one client's traffic.
 *
 * v3.7.0 keys clients BY INBOUND — there is no global client table — which is why
 * `SanaeiActivation` carries an `inboundId` and why guessing one was refused. The
 * traffic read is keyed by `email`, which is 3X-UI's name for the per-client label
 * this adapter sets to the derived provider username.
 */
const ADD_CLIENT_PATH = 'panel/api/inbounds/addClient';
const CLIENT_TRAFFICS_PATH = 'panel/api/inbounds/getClientTraffics';

/**
 * v3.7.0's `checkAPIAuth` answers an unauthenticated `/panel/api` request 401
 * when this header is present and 404 when it is not. Sent so that a rejected
 * token is legible as a rejected token: without it the same condition arrives
 * as a 404, indistinguishable from a panel served at a different base path, and
 * "your token is wrong" would be reported as "there is nothing there".
 */
const XHR_HEADER = { 'x-requested-with': 'XMLHttpRequest' } as const;

const DESCRIPTOR: ProviderDescriptor = providerDescriptor('sanaei') ?? {
  // Unreachable: `sanaei` is in `PROVIDER_TYPES` and a unit test proves every
  // type has a descriptor. A fallback rather than a `!` so that a contract edit
  // removing it fails at the type level rather than at runtime on somebody's
  // installation.
  key: 'sanaei',
  canonicalName: 'Sanaei (3X-UI)',
  credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
  capabilities: ['HEALTH_CHECK'],
  maxRequestsPerProbe: 4,
  requiredActivationFields: ['subscriptionDomain'],
};

/** The `{success, msg, obj}` envelope every v3.7.0 JSON route returns. */
interface Envelope {
  readonly success: boolean;
  readonly obj: unknown;
}

/**
 * The envelope, or null.
 *
 * Never throws, and never carries the body forward. A panel behind a
 * misconfigured proxy answers with an HTML login page; that parses to null here
 * and becomes `MALFORMED_RESPONSE`, which is a more useful thing to tell an
 * operator than a JSON syntax error quoting the first eighty characters of
 * somebody's markup.
 */
function parseEnvelope(bodyText: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record['success'] !== 'boolean') return null;
  return { success: record['success'], obj: record['obj'] };
}

/**
 * A version string, if the panel reported one worth keeping.
 *
 * Bounded and character-restricted rather than taken as given: it is persisted
 * and shown to an operator, so an unbounded string from a remote host would be
 * a place to store whatever that host felt like sending.
 */
function safeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : null;
}

/** A transport failure keeps the kind the client already normalized. */
function fromTransport(result: Extract<ProviderHttpResult, { ok: false }>): ProviderFailureResult {
  return { ok: false, failure: result.failure, status: result.status };
}

/**
 * An HTTP status from an authenticated `/panel/api` call, as an outcome.
 *
 * TWO statuses mean "your credentials were seen and refused", and the third one
 * that looks like it does is the interesting case.
 *
 * 401 is `checkAPIAuth` rejecting an unknown token. It is the answer Nexa
 * actually receives, because this adapter always sends
 * `X-Requested-With: XMLHttpRequest`, and that header is exactly what makes
 * v3.7.0 answer 401 instead of 404. 403 is `enforceTokenScope` refusing a token
 * whose scope does not reach `/server/status`. Both are the operator's
 * credential to fix, and neither is retryable.
 *
 * **404 is NOT an authentication failure here**, and mapping it as one was a
 * defect. The reasoning that produced it — "404 is what checkAPIAuth answers an
 * unauthenticated request" — is true only of a request WITHOUT the XHR header,
 * which is not a request this adapter makes. Under Nexa's own request mode the
 * unauthenticated answer is 401, so a 404 means something else entirely: a
 * `webBasePath` that no longer matches, a reverse proxy routing the panel
 * somewhere else, or an upstream that does not serve this route at all. Telling
 * an operator to replace a valid token in any of those cases sends them to
 * rotate a working credential while the real fault stays where it is — and on a
 * panel with a login limiter, rotating and retesting is not free.
 *
 * It becomes `PROVIDER_ERROR`: the panel answered, so it is reachable, and the
 * problem is on its side. `MALFORMED_RESPONSE` would be the wrong half of the
 * taxonomy — nothing was malformed, a route was absent.
 *
 * **429 is not the panel's fault at all**, and it is the one status where the
 * remedy is ours rather than the operator's: call it less often.
 */
/**
 * 429 at ANY stage, checked before that stage reads the status for itself.
 *
 * The session flow is four requests — csrf-token, the 2FA question, login, then
 * the status read — and each had its own non-2xx branch mapping everything to
 * `PROVIDER_ERROR` or, after a good login, to DEGRADED. A limiter in front of
 * the panel answers 429 to whichever of them arrives first, and only the
 * unauthenticated status read routed through `fromApiStatus`. So a rate-limited
 * login was persisted as a retryable provider fault and re-probed on the SHORT
 * cadence: answering "too many requests" by asking again sooner, which is what
 * a limiter exists to punish. A rate-limited status read after a good login was
 * worse — DEGRADED is `ok: true`, so it earned the HEALTHY cadence.
 *
 * Deliberately NOT read: the `Retry-After` header. The cadence already gives
 * `RATE_LIMITED` the long interval with doubling backoff on top, which is a
 * bound this installation controls; honouring a number from the far end would
 * let a misconfigured or hostile panel choose how long Nexa stops looking at
 * it, and would have to be clamped to something like the cadence anyway.
 */
function rateLimited(status: number): ProviderFailureResult | null {
  return status === 429 ? { ok: false, failure: 'RATE_LIMITED', status } : null;
}

function fromApiStatus(status: number): ProviderFailureResult {
  if (status === 401 || status === 403) {
    return { ok: false, failure: 'AUTHENTICATION_FAILED', status };
  }
  // 429 is the panel, or something in front of it, saying this installation is
  // calling too often. As `PROVIDER_ERROR` it read as "the panel is broken" and
  // earned the monitor's SHORTEST failure cadence — answering "too many
  // requests" by asking again sooner than for any other fault. It is its own
  // kind so the operator is told the true remedy and the cadence backs off.
  if (status === 429) return { ok: false, failure: 'RATE_LIMITED', status };
  return { ok: false, failure: 'PROVIDER_ERROR', status };
}

/**
 * The name of the v3.7.0 session cookie, and the ONLY cookie this adapter
 * replays. `sessions.Sessions("3x-ui", store)` in `internal/web/web.go`.
 */
const SESSION_COOKIE = '3x-ui';

/**
 * The longest a session cookie value or a CSRF token may be before this adapter
 * stops believing it is one.
 *
 * A kilobyte, chosen as a bound rather than as a measurement. The sizes v3.7.0
 * actually mints are not recorded in `docs/research/`, and this comment used to
 * assert them as fact — see `UNK-SANAEI-COOKIE-SIZE` in `docs/open-questions.md`.
 * What the number has to be is large enough that no plausible session id or
 * CSRF token reaches it and small enough to bound a header, and a kilobyte is
 * both by a wide margin whichever the panel mints. Without a
 * bound the only limit was `maxResponseBytes` — half a megabyte by default —
 * and both values are written straight into the headers of the two or three
 * requests that follow, on every probe, for ever.
 *
 * The character set matters more than the length. A value carrying CR or LF
 * makes Node reject the header and THROW, so a panel answering with one turned
 * a probe into an exception the caller has to recover from rather than into the
 * `MALFORMED_RESPONSE` that describes exactly what happened. A panel that
 * answers with something outside this shape is not speaking the v3.7.0
 * contract, which is a compatibility answer, not an error.
 */
const MAX_CREDENTIAL_TOKEN_BYTES = 1024;

/** Whether a provider-supplied string is safe to put in a header, and small. */
function usableHeaderValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_CREDENTIAL_TOKEN_BYTES) return false;
  // Node's own rule for a header value: no control characters at all. Written
  // as an allow-list of the printable range plus tab, because an exclusion list
  // of the characters that happen to matter today is the kind that gets a new
  // exception added to it later.
  return /^[\t\x20-\x7e\u0080-\u00ff]+$/.test(value);
}

/**
 * The session cookie's new value, if this response set one.
 *
 * Deliberately not a cookie jar. Carrying every `Set-Cookie` a panel happens to
 * send would mean replaying cookies belonging to whatever else is deployed at
 * that origin — an analytics tag, a WAF, a reverse proxy's own session — back
 * to the panel on requests that carry credentials, and none of that is part of
 * the v3.7.0 contract. One named cookie is the whole of what authentication
 * needs, so one named cookie is all that is kept; anything else is read past
 * and dropped.
 *
 * Name and value only. Everything after the first `;` instructs a browser about
 * persistence and scope, and this is not a browser: honouring `Domain` would be
 * the one way a cookie could widen where it is sent, and there is no code here
 * that could do that.
 *
 * The lifetime of the returned value is one probe. It lives in a local, is
 * passed forward through the requests of a single session flow, and goes out of
 * scope with them. Nothing writes it to a row, a log or an error.
 */
type SessionCookieRead =
  /** This response set no `3x-ui` cookie. Keep whatever the flow already holds. */
  | { readonly found: false }
  /** It set one. `null` means this adapter will not put that value in a header. */
  | { readonly found: true; readonly value: string | null };

function sessionCookieFrom(setCookie: readonly string[]): SessionCookieRead {
  for (const header of setCookie) {
    const pair = header.split(';', 1)[0] ?? '';
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    if (pair.slice(0, equals).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(equals + 1).trim();
    // FOUND is reported separately from USABLE, and that distinction is the
    // whole reason this returns a pair. Collapsing them to `string | null` made
    // "the panel rotated the session to something unusable" and "the panel did
    // not rotate the session" the same answer, and the callers below read that
    // answer as `?? session` — so an unusable rotation silently kept the cookie
    // it replaced. The panel then rejected the stale cookie with a 401, which
    // this adapter maps to DEGRADED: an operator told the credentials are fine
    // and something else is wrong, about a panel Nexa can never read, with
    // `lastHealthyAt` ticking forward for ever.
    return { found: true, value: usableHeaderValue(value) ? value : null };
  }
  return { found: false };
}

/**
 * One client, as `addClient` wants it.
 *
 * `totalGB` is BYTES despite its name — v3.7.0's `model.Client.TotalGB` is an int64 of
 * bytes and the name is upstream's, not ours. Renaming it here would be a lie about the
 * wire; documenting it is the honest option, and getting it wrong by a factor of a
 * billion is the kind of defect that only shows up when a customer runs out of traffic
 * in four seconds.
 *
 * `expiryTime` is epoch MILLISECONDS. Zero means no expiry in 3X-UI's own encoding, and
 * `UNLIMITED_DURATION_DAYS` is zero for the same reason, so the unlimited case needs no
 * special branch.
 *
 * `flow` is empty deliberately. A non-empty flow (`xtls-rprx-vision`) is only valid on
 * some inbound configurations, and setting one the inbound does not support produces a
 * client the panel accepts and Xray refuses to serve — a service that looks provisioned
 * and does not work. Empty is what every inbound accepts.
 */
function clientSettings(input: {
  readonly clientId: string;
  readonly email: string;
  readonly subId: string;
  readonly totalBytes: bigint;
  readonly expiryEpochMs: number;
  readonly deviceLimit: number | null;
}): string {
  return JSON.stringify({
    clients: [
      {
        id: input.clientId,
        flow: '',
        email: input.email,
        limitIp: input.deviceLimit ?? 0,
        totalGB: Number(input.totalBytes),
        expiryTime: input.expiryEpochMs,
        enable: true,
        tgId: '',
        subId: input.subId,
        reset: 0,
      },
    ],
  });
}

/**
 * The subscription URL for one client.
 *
 * Built from the operator's configured domain, never from the panel's own address:
 * 3X-UI serves subscriptions from a separate listener, frequently on another hostname
 * and port, so a link built from the panel address points a customer at the admin login.
 * `subscriptionDomain` is validated as a host-and-optional-port by
 * `sanaeiActivationSchema`, so nothing here can turn it into a different origin.
 */
function subscriptionUrl(subscriptionDomain: string, subId: string): string {
  return `https://${subscriptionDomain}/sub/${subId}`;
}

/**
 * One client's usage, from `getClientTraffics`.
 *
 * Returns null when the payload is not a client record, which the caller reads as a
 * compatibility failure rather than as an absent client — the two are different
 * answers and collapsing them is how a timeout becomes a duplicate account.
 *
 * `up + down` because 3X-UI counts the directions separately and the customer's
 * allowance is spent by both. `total` and `expiryTime` of zero are 3X-UI's unlimited,
 * and become null here rather than zero: `ProviderUsage.totalBytes` is `bigint | null`
 * precisely so "no limit" and "a limit of nothing" stay apart.
 */
function usageFromClient(obj: unknown): ProviderUsage | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const up = record['up'];
  const down = record['down'];
  const total = record['total'];
  const expiry = record['expiryTime'];
  if (typeof up !== 'number' || typeof down !== 'number') return null;
  if (!Number.isFinite(up) || !Number.isFinite(down) || up < 0 || down < 0) return null;
  const totalBytes =
    typeof total === 'number' && Number.isFinite(total) && total > 0
      ? BigInt(Math.trunc(total))
      : null;
  const expiresAt =
    typeof expiry === 'number' && Number.isFinite(expiry) && expiry > 0
      ? new Date(Math.trunc(expiry))
      : null;
  return {
    usedBytes: BigInt(Math.trunc(up)) + BigInt(Math.trunc(down)),
    totalBytes,
    expiresAt,
    // v3.7.0's client traffic record carries no last-connection timestamp. Null rather
    // than a guess: `bot.service.detail` renders an "as of", and inventing one is how
    // the legacy reports came to disagree with each other.
    lastConnectionAt: null,
  };
}

/**
 * What `authenticate` produced: the headers every later request carries, or why not.
 *
 * `viaLogin` is not decoration. It says the operator's password was accepted moments
 * ago, and therefore that nothing after this point may be reported as an
 * authentication failure — a rule the probe already had and the service calls need
 * for the same reason.
 */
type SanaeiAuth =
  | {
      readonly ok: true;
      readonly headers: Record<string, string>;
      readonly viaLogin: boolean;
    }
  | ProviderFailureResult;

export class SanaeiAdapter implements ProviderAdapter {
  readonly descriptor = DESCRIPTOR;

  supports(capability: ProviderCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  async probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome> {
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;
    const status = await http.send({ method: 'GET', path: STATUS_PATH, headers: auth.headers });
    return this.readStatus(status, auth.viaLogin);
  }

  /**
   * ONE authentication implementation, for the probe and for every service call.
   *
   * Extracted rather than copied, and the reason is the same one `probe-core.ts`
   * records for the probe itself: the session flow below asks a panel whether it
   * requires a second factor BEFORE sending a password, and counts on v3.7.0 binding
   * its CSRF token to the session that minted it. A second copy of that sequence is a
   * copy that will not be updated when one of those facts changes — and the copy that
   * silently keeps the old behaviour is the unattended one, dialling panels on a timer
   * with an operator's credentials.
   *
   * `viaLogin` travels with the headers because it changes how a LATER failure must be
   * read: after a successful login nothing may report an authentication failure, since
   * that would send an operator to replace a password that just worked.
   */
  private async authenticate(
    target: ProviderTarget,
    http: ProviderHttpClient,
  ): Promise<SanaeiAuth> {
    switch (target.credentials.shape) {
      case 'OPAQUE_TOKEN':
        // Mode A. No CSRF, because an authenticated API call bypasses it, and no
        // request at all: a bearer token needs no exchange.
        return {
          ok: true,
          headers: { ...XHR_HEADER, authorization: `Bearer ${target.credentials.token}` },
          viaLogin: false,
        };
      case 'USERNAME_PASSWORD':
        return this.authenticateWithSession(
          http,
          target.credentials.username,
          target.credentials.password,
        );
      default:
        // A shape this provider cannot use. Reported rather than attempted:
        // sending an empty password to find out would be one more failed login
        // on the operator's own panel, and v3.7.0 counts those.
        return { ok: false, failure: 'UNSUPPORTED_CAPABILITY', status: null };
    }
  }

  /** Mode B. csrf-token, then the 2FA question, then login. Three requests. */
  private async authenticateWithSession(
    http: ProviderHttpClient,
    username: string,
    password: string,
  ): Promise<SanaeiAuth> {
    const csrf = await http.send({ method: 'GET', path: CSRF_PATH, headers: XHR_HEADER });
    if (!csrf.ok) return fromTransport(csrf);
    if (csrf.status < 200 || csrf.status >= 300) {
      return (
        rateLimited(csrf.status) ?? { ok: false, failure: 'PROVIDER_ERROR', status: csrf.status }
      );
    }
    const minted = parseEnvelope(csrf.bodyText);
    if (minted === null || !minted.success || typeof minted.obj !== 'string') {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: csrf.status };
    }
    const csrfToken = minted.obj;
    const minting = sessionCookieFrom(csrf.setCookie);
    if (!minting.found || minting.value === null || !usableHeaderValue(csrfToken)) {
      // v3.7.0 binds the token to the session it was minted in. Without the
      // `3x-ui` cookie there is no session to bind to, so a login would be
      // refused for a reason that has nothing to do with the operator's
      // credentials — and a panel that set some OTHER cookie instead is not
      // speaking this contract, which is a compatibility answer rather than an
      // invitation to submit a password and find out.
      //
      // The same answer covers a token or a cookie this adapter will not put in
      // a header: too long, or carrying a control character. Reported as the
      // compatibility failure it is, rather than sent onward to make Node throw
      // on the next request.
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: csrf.status };
    }
    let session: string = minting.value;

    /**
     * Adopt a rotated session, or report that it cannot be adopted.
     *
     * Returns the outcome to return, or null to carry on. A rotation the
     * adapter will not send is the same compatibility failure as a mint it
     * will not send — NOT a reason to keep sending the value the panel just
     * replaced.
     */
    const adoptSession = (
      read: SessionCookieRead,
      status: number,
    ): ProviderFailureResult | null => {
      if (!read.found) return null;
      if (read.value === null) return { ok: false, failure: 'MALFORMED_RESPONSE', status };
      session = read.value;
      return null;
    };

    const authHeaders = (): Record<string, string> => ({
      ...XHR_HEADER,
      'x-csrf-token': csrfToken,
      cookie: `${SESSION_COOKIE}=${session}`,
    });

    // Asked before any credential is sent. A panel with 2FA on cannot be
    // authenticated unattended by a username and password, and finding that out
    // by submitting one would spend a lockout attempt to learn it.
    const twoFactor = await http.send({
      method: 'POST',
      path: TWO_FACTOR_PATH,
      headers: authHeaders(),
      body: { kind: 'json', value: {} },
    });
    if (!twoFactor.ok) return fromTransport(twoFactor);
    if (twoFactor.status < 200 || twoFactor.status >= 300) {
      return (
        rateLimited(twoFactor.status) ?? {
          ok: false,
          failure: 'PROVIDER_ERROR',
          status: twoFactor.status,
        }
      );
    }
    const twoFactorBody = parseEnvelope(twoFactor.bodyText);
    if (twoFactorBody === null || !twoFactorBody.success) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: twoFactor.status };
    }
    // `getTwoFactorEnable` returns a BOOLEAN in `obj`, and this insists on one.
    //
    // The reading that matters is what happens to everything else. Treating
    // "not exactly true" as "2FA is off" would mean a panel answering `null`,
    // `"true"`, `{}` or nothing at all — an incompatible release, a proxy
    // rewriting the body, a route that is not this endpoint — causing Nexa to
    // submit the operator's username and password to find out. A malformed
    // answer to "is a second factor required" is not permission to try one
    // without it, so it is a compatibility failure and no credential is sent.
    if (typeof twoFactorBody.obj !== 'boolean') {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: twoFactor.status };
    }
    if (twoFactorBody.obj) {
      // Deliberately terminal. Nexa stores no TOTP seed and generates no code,
      // so there is nothing to try; retrying would only feed the login limiter.
      return { ok: false, failure: 'AUTHENTICATION_REQUIRES_INTERACTION', status: null };
    }
    const rotatedByTwoFactor = adoptSession(
      sessionCookieFrom(twoFactor.setCookie),
      twoFactor.status,
    );
    if (rotatedByTwoFactor !== null) return rotatedByTwoFactor;

    const login = await http.send({
      method: 'POST',
      path: LOGIN_PATH,
      headers: authHeaders(),
      // JSON rather than form: v3.7.0's `LoginForm` binds both, and one
      // deterministic encoding is one fewer thing for a test to have to cover
      // twice. `twoFactorCode` is absent on purpose — this adapter never has
      // one, and sending an empty string would be a third wrong credential.
      body: { kind: 'json', value: { username, password } },
    });
    if (!login.ok) return fromTransport(login);
    // BEFORE the 403 rule and before the generic non-2xx one. The two are
    // disjoint statuses, and the order says which reading wins if that ever
    // stops being true: a limiter's answer is never a statement about the
    // operator's password.
    const limited = rateLimited(login.status);
    if (limited !== null) return limited;
    if (login.status === 403) {
      // v3.7.0's CSRF middleware aborts with exactly this and no body. It means
      // the token and cookie did not line up, which is a Nexa-side protocol
      // failure and not a statement about the operator's password.
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: login.status };
    }
    if (login.status < 200 || login.status >= 300) {
      return { ok: false, failure: 'PROVIDER_ERROR', status: login.status };
    }
    const loginBody = parseEnvelope(login.bodyText);
    if (loginBody === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: login.status };
    }
    if (!loginBody.success) {
      // The 200-with-success-false case. Wrong username, wrong password and
      // wrong 2FA code all land here, and all three are the same remedy.
      return { ok: false, failure: 'AUTHENTICATION_FAILED', status: login.status };
    }
    // A login that rotates the session replaces it; one that does not keeps
    // the cookie the flow already holds; one that rotates it to something this
    // adapter will not send is reported rather than ignored.
    const rotatedByLogin = adoptSession(sessionCookieFrom(login.setCookie), login.status);
    if (rotatedByLogin !== null) return rotatedByLogin;

    /*
     * The session is established. The CSRF token is deliberately NOT carried forward:
     * v3.7.0's middleware exempts `/panel/api/*` from the CSRF check, and sending a
     * token minted for the login form on an API call is a header that means nothing
     * to the panel and one more thing to get wrong when it rotates.
     */
    return {
      ok: true,
      headers: { ...XHR_HEADER, cookie: `${SESSION_COOKIE}=${session}` },
      viaLogin: true,
    };
  }

  /**
   * Create one client on the configured inbound.
   *
   * The sequence is authenticate, then ONE mutating request. Nothing reads the panel
   * first to see whether the client is already there: a check-then-create is two
   * requests with a race between them, and the thing that makes a duplicate
   * impossible here is not a check but `services_panel_provider_username_key` plus the
   * fact that a create is only ever issued from `PENDING_PROVISION`.
   *
   * A `success: false` envelope is reported as `PROVIDER_ERROR` and NOT parsed for a
   * reason. v3.7.0 answers a duplicate email with a message, and the message is a
   * localisable string that upstream is free to reword — so branching on it would be
   * an adapter whose correctness depends on somebody else's copy. `PROVIDER_ERROR` on
   * a mutating operation classifies as `UNKNOWN` through `failureOutcome`, which sends
   * the operation to reconciliation, and reconciliation ASKS the panel. The duplicate
   * is then adopted rather than guessed at, which is the answer that was wanted.
   */
  async createUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    input: CreateProviderUserInput,
  ): Promise<ProviderUserOutcome> {
    const activation = target.activation as SanaeiActivation;
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const expiryEpochMs =
      input.durationDays === null || input.durationDays <= 0
        ? 0
        : input.expiresAt === null
          ? 0
          : input.expiresAt.getTime();

    const added = await http.send({
      method: 'POST',
      path: ADD_CLIENT_PATH,
      headers: auth.headers,
      // Form, because v3.7.0's handler binds `id` and `settings` from a form and
      // `settings` is itself a JSON STRING rather than a nested object. Sending JSON
      // with a nested object is the shape the panel does not accept.
      body: {
        kind: 'form',
        value: {
          id: String(activation.inboundId),
          settings: clientSettings({
            clientId: input.clientId,
            email: input.username,
            subId: input.subscriptionRef,
            totalBytes: input.volumeBytes ?? 0n,
            expiryEpochMs,
            deviceLimit: input.deviceLimit,
          }),
        },
      },
    });
    if (!added.ok) return fromTransport(added);
    const limited = rateLimited(added.status);
    if (limited !== null) return limited;
    if (added.status < 200 || added.status >= 300) {
      return auth.viaLogin
        ? { ok: false, failure: 'PROVIDER_ERROR', status: added.status }
        : fromApiStatus(added.status);
    }
    const body = parseEnvelope(added.bodyText);
    if (body === null) return { ok: false, failure: 'MALFORMED_RESPONSE', status: added.status };
    if (!body.success) return { ok: false, failure: 'PROVIDER_ERROR', status: added.status };

    return {
      ok: true,
      // 3X-UI's own identifier for the client is the UUID Nexa chose and sent, so this
      // is not a value read back from the panel — it is the one that was written.
      providerUserId: input.clientId,
      delivery: {
        kind: 'SUBSCRIPTION_LINK',
        url: subscriptionUrl(activation.subscriptionDomain, input.subscriptionRef),
      },
      // `addClient` answers with `obj: null`, so there is nothing to report. Null
      // rather than a zero-usage record invented here: a figure with no read behind it
      // is exactly the kind the legacy reports are made of.
      usage: null,
    };
  }

  /**
   * Whether this panel holds a client with that name, and what it looks like.
   *
   * The reconciliation primitive, and the one place `found: false` may be produced.
   * v3.7.0 answers an unknown email with a perfectly successful envelope carrying
   * `obj: null` — so absence is a POSITIVE answer from the panel, which is exactly what
   * makes a fresh create legal after it. Every other shape is a failure: a request that
   * did not arrive, a 500, an unparseable body and a payload that is not a client record
   * all leave this installation not knowing, and not knowing must never read as absent.
   */
  async lookupUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderLookupOutcome> {
    const activation = target.activation as SanaeiActivation;
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const read = await http.send({
      method: 'GET',
      path: `${CLIENT_TRAFFICS_PATH}/${encodeURIComponent(ref.username)}`,
      headers: auth.headers,
    });
    if (!read.ok) return fromTransport(read);
    const limited = rateLimited(read.status);
    if (limited !== null) return limited;
    if (read.status < 200 || read.status >= 300) {
      return auth.viaLogin
        ? { ok: false, failure: 'PROVIDER_ERROR', status: read.status }
        : fromApiStatus(read.status);
    }
    const body = parseEnvelope(read.bodyText);
    if (body === null) return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };
    if (!body.success) {
      /*
       * A successful HTTP call whose envelope says the operation did not succeed.
       *
       * NOT absence. v3.7.0 reports an unknown email as `success: true` with a null
       * `obj`; a false `success` means the panel refused to answer the question, and a
       * refusal to answer is not an answer of "no".
       */
      return { ok: false, failure: 'PROVIDER_ERROR', status: read.status };
    }
    if (body.obj === null || body.obj === undefined) return { ok: true, found: false };

    const usage = usageFromClient(body.obj);
    if (usage === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };
    }
    return {
      ok: true,
      found: true,
      /*
       * Deliberately null.
       *
       * `getClientTraffics` returns the traffic record, whose `id` is the row id of the
       * traffic counter and NOT the client UUID the config is built from. Returning it
       * as `providerUserId` would write a number into a column that elsewhere holds a
       * UUID, and the first thing to read it would be a later operation addressing the
       * wrong thing. The username is the identifier this adapter reconciles by.
       */
      providerUserId: null,
      delivery: {
        kind: 'SUBSCRIPTION_LINK',
        url: subscriptionUrl(activation.subscriptionDomain, ref.subscriptionRef),
      },
      usage,
    };
  }

  /** One client's traffic. A read, so a failure is never `UNKNOWN`. */
  async readUsage(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderUsageOutcome> {
    const found = await this.lookupUser(target, http, ref);
    if (!found.ok) return found;
    if (!found.found) {
      /*
       * The panel does not have this client.
       *
       * Reported as a provider error rather than as zero usage, because a service Nexa
       * believes is ACTIVE whose account has been deleted on the panel is a real
       * divergence an operator has to see — and zero bytes used is what a brand new
       * account looks like.
       */
      return { ok: false, failure: 'PROVIDER_ERROR', status: null };
    }
    if (found.usage === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: null };
    }
    return { ok: true, usage: found.usage };
  }

  /**
   * `GET panel/api/server/status`, strictly.
   *
   * Read-only by choice: a mutating endpoint as a health check is a health
   * check that changes the thing it measures.
   *
   * The parse takes the minimum that identifies a 3X-UI status and nothing
   * more. `obj.xray` is the anchor because it is the field that makes this
   * payload recognisably this panel's, and because v3.7.0's
   * `ServerService.LastStatus()` returns a nil pointer until the first
   * background refresh has run — which serializes to `"obj": null` under a
   * perfectly successful `"success": true`. Accepting that as healthy would
   * report a panel as fine on the strength of an empty answer. Every other
   * field — cpu, mem, disk, the network counters — is deliberately not read:
   * coupling a health check to a large payload means an upstream field rename
   * becomes a Nexa outage, and unknown fields must stay forward compatible.
   *
   * `authenticated` marks the session flow, where the login already succeeded.
   * Nothing after a good login may report an authentication failure: it would
   * send an operator to replace a password that just worked, so a bad answer
   * there is DEGRADED — the panel is up, the credentials are right, and
   * something else is wrong.
   */
  private readStatus(result: ProviderHttpResult, authenticated = false): ProviderProbeOutcome {
    const degraded = (): ProviderProbeOutcome => ({
      ok: true,
      providerVersion: null,
      degraded: true,
    });

    if (!result.ok) return authenticated ? degraded() : fromTransport(result);
    if (result.status < 200 || result.status >= 300) {
      // The 429 check precedes the authenticated shortcut deliberately. After a
      // good login every other bad status is DEGRADED — the panel is up and the
      // credentials are right, so something else is wrong — but DEGRADED is
      // `ok: true` and earns the HEALTHY cadence, which is the one answer a
      // limiter must not get.
      return (
        rateLimited(result.status) ?? (authenticated ? degraded() : fromApiStatus(result.status))
      );
    }
    const body = parseEnvelope(result.bodyText);
    if (body === null || !body.success) {
      return authenticated
        ? degraded()
        : { ok: false, failure: 'MALFORMED_RESPONSE', status: result.status };
    }
    const obj = body.obj;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return authenticated
        ? degraded()
        : { ok: false, failure: 'MALFORMED_RESPONSE', status: result.status };
    }
    const xray = (obj as Record<string, unknown>)['xray'];
    if (typeof xray !== 'object' || xray === null || Array.isArray(xray)) {
      return authenticated
        ? degraded()
        : { ok: false, failure: 'MALFORMED_RESPONSE', status: result.status };
    }
    // The version Nexa reports is the PANEL's, not Xray's: it is what an
    // operator matches against a release, and it is what this adapter's
    // compatibility statement is about. Absent on a panel too old to report
    // one, which is a null version and not a failure.
    const record = obj as Record<string, unknown>;
    return {
      ok: true,
      providerVersion: safeVersion(record['panelVersion']),
      degraded: false,
    };
  }
}
