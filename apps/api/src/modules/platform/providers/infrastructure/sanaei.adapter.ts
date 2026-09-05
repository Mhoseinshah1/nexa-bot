import {
  providerDescriptor,
  type ProviderConnectionAdapter,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderHttpClient,
  type ProviderHttpResult,
  type ProviderProbeOutcome,
  type ProviderTarget,
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
function fromTransport(result: Extract<ProviderHttpResult, { ok: false }>): ProviderProbeOutcome {
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
function fromApiStatus(status: number): ProviderProbeOutcome {
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
function sessionCookieFrom(setCookie: readonly string[]): string | null {
  for (const header of setCookie) {
    const pair = header.split(';', 1)[0] ?? '';
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    if (pair.slice(0, equals).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(equals + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

export class SanaeiAdapter implements ProviderConnectionAdapter {
  readonly descriptor = DESCRIPTOR;

  supports(capability: ProviderCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  async probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome> {
    switch (target.credentials.shape) {
      case 'OPAQUE_TOKEN':
        return this.probeWithToken(http, target.credentials.token);
      case 'USERNAME_PASSWORD':
        return this.probeWithSession(
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

  /** Mode A. One request; no CSRF, because an authenticated API call bypasses it. */
  private async probeWithToken(
    http: ProviderHttpClient,
    token: string,
  ): Promise<ProviderProbeOutcome> {
    const status = await http.send({
      method: 'GET',
      path: STATUS_PATH,
      headers: { ...XHR_HEADER, authorization: `Bearer ${token}` },
    });
    return this.readStatus(status);
  }

  /** Mode B. csrf-token, then the 2FA question, then login, then the status read. */
  private async probeWithSession(
    http: ProviderHttpClient,
    username: string,
    password: string,
  ): Promise<ProviderProbeOutcome> {
    const csrf = await http.send({ method: 'GET', path: CSRF_PATH, headers: XHR_HEADER });
    if (!csrf.ok) return fromTransport(csrf);
    if (csrf.status < 200 || csrf.status >= 300) {
      return { ok: false, failure: 'PROVIDER_ERROR', status: csrf.status };
    }
    const minted = parseEnvelope(csrf.bodyText);
    if (minted === null || !minted.success || typeof minted.obj !== 'string') {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: csrf.status };
    }
    const csrfToken = minted.obj;
    let session = sessionCookieFrom(csrf.setCookie);
    if (session === null || csrfToken.length === 0) {
      // v3.7.0 binds the token to the session it was minted in. Without the
      // `3x-ui` cookie there is no session to bind to, so a login would be
      // refused for a reason that has nothing to do with the operator's
      // credentials — and a panel that set some OTHER cookie instead is not
      // speaking this contract, which is a compatibility answer rather than an
      // invitation to submit a password and find out.
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: csrf.status };
    }
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
      return { ok: false, failure: 'PROVIDER_ERROR', status: twoFactor.status };
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
    session = sessionCookieFrom(twoFactor.setCookie) ?? session;

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
    // the cookie the flow already holds.
    session = sessionCookieFrom(login.setCookie) ?? session;

    const status = await http.send({
      method: 'GET',
      path: STATUS_PATH,
      headers: { ...XHR_HEADER, cookie: `${SESSION_COOKIE}=${session}` },
    });
    return this.readStatus(status, true);
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
      return authenticated ? degraded() : fromApiStatus(result.status);
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
