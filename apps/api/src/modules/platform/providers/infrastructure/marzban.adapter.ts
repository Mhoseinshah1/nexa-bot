import {
  providerDescriptor,
  type CreateProviderUserInput,
  type MarzbanActivation,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderFailureResult,
  type ProviderHttpClient,
  type ProviderHttpResult,
  type ProviderLookupOutcome,
  type ProviderProbeOutcome,
  type ProviderServiceTarget,
  type ProviderTarget,
  type ProviderUsage,
  type ProviderUsageOutcome,
  type ProviderUserOutcome,
  type ProviderUserRef,
} from '@nexa/contracts';

/**
 * Marzban.
 *
 * **Where these endpoints come from.** Marzban's own documented API, not from
 * the research corpus. That distinction matters and is stated because the
 * corpus is explicit about the gap: not one Marzban path, method, auth scheme
 * or payload was observable through the legacy bot's Telegram UI, and the
 * investigation briefs forbade recording tokens and Authorization headers. So
 * the corpus establishes that Marzban connects with a username and password and
 * that a reachable panel renders a version and a user count — and says nothing
 * about how. These two calls are validated against a deterministic fake server
 * in `tests/unit/marzban-adapter.test.ts` and have NOT been run against a real
 * Marzban in this phase.
 *
 * The probe is two steps, and the second one is what makes `DEGRADED` a real
 * state rather than a hedge:
 *
 *   1. `POST /api/admin/token` exchanges the credentials for a bearer token.
 *      Rejected here means the credentials are wrong, which is the one failure
 *      an operator can fix directly and the one that must never be retried.
 *   2. `GET /api/system` reads what the panel says about itself. Authentication
 *      has already succeeded at this point, so a failure here is a panel that
 *      is up and correctly configured and unwell — which is exactly what
 *      DEGRADED means, and it is a different remedy from UNREACHABLE.
 *
 * The token is never stored. It lives for one probe and is discarded, so there
 * is no third credential to rotate and nothing extra in a database dump.
 */

/** Marzban's token endpoint. Form-encoded, as an OAuth2 password grant. */
export const TOKEN_PATH = 'api/admin/token';
export const SYSTEM_PATH = 'api/system';
/** Creating a user, and reading one back. Marzban keys users by the name we chose. */
export const USER_PATH = 'api/user';

const DESCRIPTOR: ProviderDescriptor = providerDescriptor('marzban') ?? {
  // Unreachable: `marzban` is in `PROVIDER_TYPES`, and a unit test proves every
  // type has a descriptor. Written as a fallback rather than a `!` so that a
  // contract edit that removed it fails at the type level instead of at
  // runtime on somebody's installation.
  key: 'marzban',
  canonicalName: 'Marzban',
  credentialShape: 'USERNAME_PASSWORD',
  capabilities: ['HEALTH_CHECK'],
  maxRequestsPerProbe: 2,
  requiredActivationFields: [],
};

/**
 * A failed HTTP exchange, as a probe outcome.
 *
 * `401` and `403` become `AUTHENTICATION_FAILED` — the credentials were seen
 * and refused. `429` is neither: nothing is wrong with the credential and
 * nothing is wrong with the panel — this installation is calling it too often,
 * and the remedy is ours. Everything else 4xx or 5xx is the panel's own error:
 * it answered, so it is reachable, and the problem is on its side.
 */
function outcomeFromStatus(status: number): ProviderFailureResult {
  if (status === 401 || status === 403) {
    return { ok: false, failure: 'AUTHENTICATION_FAILED', status };
  }
  if (status === 429) return { ok: false, failure: 'RATE_LIMITED', status };
  return { ok: false, failure: 'PROVIDER_ERROR', status };
}

/** A transport failure keeps the kind the client already normalized. */
function outcomeFromTransport(
  result: Extract<ProviderHttpResult, { ok: false }>,
): ProviderFailureResult {
  return { ok: false, failure: result.failure, status: result.status };
}

/**
 * A JSON body, or null.
 *
 * Never throws and never carries the body forward. A panel that answers with
 * an HTML login page — which is what a misconfigured reverse proxy in front of
 * Marzban does — parses to null here and becomes `MALFORMED_RESPONSE`, which
 * is a far more useful thing to tell an operator than a JSON syntax error
 * quoting the first eighty characters of somebody's login form.
 */
function parseJson(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A version string, if the panel reported one that is safe to keep.
 *
 * Bounded and character-restricted rather than taken as given. It is persisted
 * and shown to an operator, so an unbounded string from an unauthenticated-ish
 * surface would be a place to store whatever the remote end felt like sending.
 */
function safeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * A bearer token for one call sequence, or why one could not be had.
 *
 * The same extraction the 3X-UI adapter needed and for the same reason: the token
 * exchange is a real request with its own failure taxonomy, and a second copy of it
 * would be a second place for "401 means replace the password" to be decided.
 *
 * The token is never stored and never returned past the call that uses it.
 */
type MarzbanAuth = { readonly ok: true; readonly token: string } | ProviderFailureResult;

/**
 * Marzban's user record, reduced to what Nexa keeps.
 *
 * Everything else the panel returns is deliberately not read. Coupling to a large
 * payload means an upstream field rename becomes a Nexa outage, and unknown fields must
 * stay forward compatible.
 */
function usageFromUser(record: Record<string, unknown>): ProviderUsage | null {
  const used = record['used_traffic'];
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const limit = record['data_limit'];
  const expire = record['expire'];
  return {
    usedBytes: BigInt(Math.trunc(used)),
    // Zero and null are both Marzban's "no limit". Kept as null so that "unlimited"
    // and "an allowance of nothing" cannot be confused downstream.
    totalBytes:
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? BigInt(Math.trunc(limit))
        : null,
    // Marzban's `expire` is epoch SECONDS, not milliseconds. The factor of a thousand
    // is the difference between an expiry in 2026 and one in 1970.
    expiresAt:
      typeof expire === 'number' && Number.isFinite(expire) && expire > 0
        ? new Date(Math.trunc(expire) * 1000)
        : null,
    lastConnectionAt: null,
  };
}

/**
 * The subscription URL, absolute.
 *
 * Marzban answers with a PATH — `/sub/<token>` — because it does not know what
 * hostname it is reached by. Joining it onto the base URL the operator configured is
 * the only source of that hostname this installation has. An absolute URL is taken as
 * given, since a panel behind a proxy may be configured to emit one.
 */
function absoluteSubscription(baseUrl: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith('/')) return null;
  return `${baseUrl.replace(/\/+$/, '')}${value}`;
}

export class MarzbanAdapter implements ProviderAdapter {
  readonly descriptor = DESCRIPTOR;

  supports(capability: ProviderCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  /**
   * Exchange the operator's credentials for a bearer token.
   *
   * ONE implementation, used by the probe and by every service call. Rejected here
   * means the credentials are wrong, which is the one failure an operator can fix
   * directly and the one that must never be retried as though it were transient.
   *
   * The token lives for the call sequence that asked for it and is discarded, so there
   * is no third credential to rotate and nothing extra in a database dump.
   */
  private async authenticate(
    target: ProviderTarget,
    http: ProviderHttpClient,
  ): Promise<MarzbanAuth> {
    if (target.credentials.shape !== 'USERNAME_PASSWORD') {
      // The panel is configured with a credential shape Marzban cannot use.
      // Reported as unsupported rather than attempted: sending an empty
      // password to find out would be one more failed login on the operator's
      // own panel, and some of them lock an account for that.
      return { ok: false, failure: 'UNSUPPORTED_CAPABILITY', status: null };
    }

    const login = await http.send({
      method: 'POST',
      path: TOKEN_PATH,
      body: {
        kind: 'form',
        value: {
          username: target.credentials.username,
          password: target.credentials.password,
          grant_type: 'password',
        },
      },
    });
    if (!login.ok) return outcomeFromTransport(login);
    if (login.status < 200 || login.status >= 300) return outcomeFromStatus(login.status);

    const body = parseJson(login.bodyText);
    const token = body?.['access_token'];
    if (typeof token !== 'string' || token.length === 0) {
      // A 200 that carries no token is not a successful login. Treating it as
      // one would report a healthy panel that nothing can actually call.
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: login.status };
    }
    return { ok: true, token };
  }

  async probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome> {
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;
    const token = auth.token;

    const system = await http.send({
      method: 'GET',
      path: SYSTEM_PATH,
      headers: { authorization: `Bearer ${token}` },
    });

    // From here on the credentials are known good, so nothing below may report
    // an authentication failure — it would send an operator to replace a
    // password that just worked.
    if (!system.ok) {
      return { ok: true, providerVersion: null, degraded: true };
    }
    if (system.status < 200 || system.status >= 300) {
      return { ok: true, providerVersion: null, degraded: true };
    }
    const info = parseJson(system.bodyText);
    if (info === null) {
      return { ok: true, providerVersion: null, degraded: true };
    }

    return { ok: true, providerVersion: safeVersion(info['version']), degraded: false };
  }

  /**
   * Create one Marzban user.
   *
   * `proxies` is built from the operator's configured protocols and nothing else.
   * Marzban requires at least one and generates the per-protocol settings itself when
   * handed an empty object, which is why the values here are `{}` rather than invented
   * keys — a fabricated `flow` or `id` would produce an account Marzban accepts and
   * Xray will not serve.
   *
   * `inbounds` is ALWAYS sent, and the activation schema makes it impossible not to
   * have. This docblock used to say the opposite — that absent means "every inbound for
   * those protocols, which is Marzban's own documented default" — and a real v0.8.4
   * panel disagreed: `UserCreate.excluded_inbounds` excludes every inbound NOT listed,
   * so absent excludes ALL of them. The create answers 200, returns a subscription URL,
   * and the customer's subscription is zero bytes. `docs/providers/marzban.md` has the
   * measurement.
   */
  async createUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    input: CreateProviderUserInput,
  ): Promise<ProviderUserOutcome> {
    const activation = target.activation as MarzbanActivation;
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const proxies: Record<string, Record<string, never>> = {};
    for (const protocol of activation.proxyProtocols) proxies[protocol] = {};

    const payload: Record<string, unknown> = {
      username: input.username,
      proxies,
      // Marzban's `expire` is epoch SECONDS. Zero is its own "never expires", which is
      // also what `UNLIMITED_DURATION_DAYS` means, so the unlimited case needs no branch.
      expire: input.expiresAt === null ? 0 : Math.floor(input.expiresAt.getTime() / 1000),
      data_limit: Number(input.volumeBytes ?? 0n),
      data_limit_reset_strategy: 'no_reset',
      status: 'active',
    };
    payload['inbounds'] = activation.inboundTags;

    const created = await http.send({
      method: 'POST',
      path: USER_PATH,
      headers: { authorization: `Bearer ${auth.token}` },
      body: { kind: 'json', value: payload },
    });
    if (!created.ok) return outcomeFromTransport(created);
    if (created.status === 429) return { ok: false, failure: 'RATE_LIMITED', status: 429 };
    if (created.status < 200 || created.status >= 300) {
      /*
       * Nothing after a good token exchange may report an authentication failure — it
       * would send an operator to replace a password that just worked. A 409 for an
       * existing username lands here as `PROVIDER_ERROR`, which classifies as UNKNOWN
       * for a mutating operation and therefore routes to reconciliation. That is the
       * wanted outcome: the existing account is ASKED for and adopted, rather than a
       * status code being read as permission to assume anything about it.
       */
      return { ok: false, failure: 'PROVIDER_ERROR', status: created.status };
    }
    const record = parseJson(created.bodyText);
    if (record === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: created.status };
    }
    const url = absoluteSubscription(target.baseUrl, record['subscription_url']);
    if (url === null) {
      /*
       * A 201 with no usable subscription URL.
       *
       * MALFORMED_RESPONSE, and therefore UNKNOWN for a mutating call — which is
       * right, because the account was very probably created and this installation
       * cannot deliver it. Reconciliation reads the user back and gets the URL.
       */
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: created.status };
    }
    return {
      ok: true,
      // Marzban keys users by the name, and its record carries no separate id that
      // outlives a rename. The username is the identity, so there is no second one to
      // report and inventing a value for this column would be worse than a null.
      providerUserId: null,
      delivery: { kind: 'SUBSCRIPTION_LINK', url },
      usage: usageFromUser(record),
    };
  }

  /**
   * Whether this panel holds a user with that name.
   *
   * 404 is the one status that means ABSENT, and it means it because the request was
   * authenticated: the token exchange already succeeded, so this is Marzban answering
   * a question it understood. An unauthenticated 404 would be a different statement
   * entirely, and cannot occur on this path.
   *
   * Every other failure leaves this installation not knowing, which is never reported
   * as absence — that collapse is exactly how a timeout becomes a duplicate account.
   */
  async lookupUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderLookupOutcome> {
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const read = await http.send({
      method: 'GET',
      path: `${USER_PATH}/${encodeURIComponent(ref.username)}`,
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (!read.ok) return outcomeFromTransport(read);
    if (read.status === 404) return { ok: true, found: false };
    if (read.status === 429) return { ok: false, failure: 'RATE_LIMITED', status: 429 };
    if (read.status < 200 || read.status >= 300) {
      return { ok: false, failure: 'PROVIDER_ERROR', status: read.status };
    }
    const record = parseJson(read.bodyText);
    if (record === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };
    }
    const usage = usageFromUser(record);
    if (usage === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: read.status };
    }
    const url = absoluteSubscription(target.baseUrl, record['subscription_url']);
    return {
      ok: true,
      found: true,
      providerUserId: null,
      // A user that exists with no readable subscription URL is still a user that
      // exists. Reported as NONE rather than refused, because the adoption this read
      // exists for must not be blocked by a delivery detail — an operator can see the
      // service, and re-delivery is its own retryable act.
      delivery: url === null ? { kind: 'NONE' } : { kind: 'SUBSCRIPTION_LINK', url },
      usage,
    };
  }

  /** One user's traffic. A read, so a failure is never `UNKNOWN`. */
  async readUsage(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderUsageOutcome> {
    const found = await this.lookupUser(target, http, ref);
    if (!found.ok) return found;
    if (!found.found) {
      // A service Nexa believes is ACTIVE whose account is gone from the panel is a
      // real divergence an operator has to see. Zero bytes used is what a brand new
      // account looks like, so reporting that instead would hide it.
      return { ok: false, failure: 'PROVIDER_ERROR', status: null };
    }
    if (found.usage === null) return { ok: false, failure: 'MALFORMED_RESPONSE', status: null };
    return { ok: true, usage: found.usage };
  }
}
