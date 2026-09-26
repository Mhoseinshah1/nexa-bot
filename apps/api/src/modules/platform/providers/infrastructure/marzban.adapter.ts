import {
  assertSendableProviderUsername,
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
  type ProviderRemovalOutcome,
  type ProviderServiceTarget,
  type ProviderAllowancePlan,
  type ProviderStateChangeOutcome,
  type ProviderTarget,
  type ProviderUsage,
  type ProviderUsageOutcome,
  type ProviderUserOutcome,
  type ProviderUserRef,
} from '@nexa/contracts';
import { planApplied, readRecordUsage } from './provider-numbers.js';

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
/**
 * Creating a user, reading one back, changing its state and deleting it.
 *
 * ONE constant for all four, because Marzban registers them all under
 * `/api/user`: the create is a POST to the collection, the other three address
 * `/api/user/{username}` with GET, PUT and DELETE. There is no dedicated
 * disable route and no dedicated enable route — both are the ordinary modify
 * call carrying nothing but a status, which is a fact from `app/routers/user.py`
 * at the pinned commit and is verified against the running binary in
 * `docs/providers/marzban.md`.
 */
export const USER_PATH = 'api/user';

/**
 * The two statuses this adapter ever sends.
 *
 * `UserStatusModify` in v0.8.4 accepts only `active`, `disabled` and `on_hold`;
 * `limited` and `expired` are states Marzban puts a user INTO and answers 422
 * for. Nexa never sends `on_hold`, which is Marzban's own deferred-start
 * feature and not a state in `SERVICE_MACHINE`.
 */
const STATUS_DISABLED = 'disabled';
const STATUS_ACTIVE = 'active';

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
  return result.detail === undefined
    ? { ok: false, failure: result.failure, status: result.status }
    : { ok: false, failure: result.failure, status: result.status, detail: result.detail };
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
  // Numbers or canonical numeric strings, `used_traffic` required, `expire` in SECONDS:
  // one reading shared with RickPanel (WP15 G5).
  const read = readRecordUsage(record);
  return read.ok ? read.usage : null;
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
      // A token exchange creates a session and changes no account: a READ (G6).
      effect: 'READ',
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
    /*
     * The third and last place a username is checked, and the only one that stands
     * between a bad name and somebody else's machine.
     *
     * `assertSendable`, NOT `assertNew`, and the difference matters: this method is
     * also reached by a RECONCILE-driven retry that re-sends the name a SERVICE ROW
     * already carries, and a service provisioned before the four-to-twenty contract
     * carries `nx` plus 32 hex. Asserting the minting rule here would crash a
     * recoverable retry for a service the customer is holding.
     *
     * An assertion rather than a refusal: the surface and the allocator have both
     * already validated what they mint, so reaching here with a name that is neither
     * mintable nor legacy means those checks were removed or bypassed — our defect,
     * not the customer's. It runs BEFORE authentication, so it costs no request.
     */
    assertSendableProviderUsername(input.username);
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
    /*
     * A 409 is the panel saying the NAME is taken, and nothing more (WP15 G7).
     *
     * It used to land below as `PROVIDER_ERROR` — UNKNOWN for a create — and reconcile
     * then found the name and adopted the account: somebody else's account, delivered to
     * a paying customer, because a username collision was read as provenance. A 409 is
     * this request REFUSED, which is what `PROVIDER_REFUSED` says and what RickPanel's
     * adapter already answered. Whether the service has provenance from an EARLIER
     * accepted create is the executor's question, from its own durable record.
     */
    if (created.status === 409) {
      return { ok: false, failure: 'PROVIDER_REFUSED', status: 409 };
    }
    if (created.status < 200 || created.status >= 300) {
      // Nothing after a good token exchange may report an authentication failure — it
      // would send an operator to replace a password that just worked.
      return { ok: false, failure: 'PROVIDER_ERROR', status: created.status };
    }
    // From here the panel answered the create with a success: every failure below carries
    // `accepted`, the one provenance a later READ may adopt on (G7).
    const record = parseJson(created.bodyText);
    if (record === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: created.status, accepted: true };
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
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: created.status, accepted: true };
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
    // The record is THERE and its usage cannot be read: a different fact from "not
    // found", and the detail is what lets an operator tell the two apart (G5).
    const usage = readRecordUsage(record);
    if (!usage.ok) {
      return {
        ok: false,
        failure: 'MALFORMED_RESPONSE',
        status: read.status,
        detail: usage.detail,
      };
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
      usage: usage.usage,
    };
  }

  /**
   * Stop this account serving, or start it serving again.
   *
   * ONE implementation for both, because Marzban has one route: `PUT /api/user/{username}`
   * carrying nothing but a status. Two copies would be two places for "a 404 is not a
   * failure to reach the panel" to be decided, and the pair would drift the first time
   * one of them was corrected.
   *
   * The body carries the status and NOTHING else, and that is load-bearing rather than
   * minimalism. `UserModify` treats every omitted field as "no change", but a field
   * that is present is applied: sending `expire`, `data_limit` or `proxies` here would
   * make a suspend silently rewrite the customer's allowance, and sending `proxies`
   * would additionally delete every proxy not named. A suspend changes one thing.
   *
   * The username in the path comes from `ref`, which the executor reads off the stored
   * service row. Nothing a customer can send reaches it — the surfaces address a service
   * by id and the provider username is never accepted as input.
   */
  private async setStatus(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    status: typeof STATUS_ACTIVE | typeof STATUS_DISABLED,
  ): Promise<ProviderStateChangeOutcome> {
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const changed = await http.send({
      method: 'PUT',
      path: `${USER_PATH}/${encodeURIComponent(ref.username)}`,
      headers: { authorization: `Bearer ${auth.token}` },
      body: { kind: 'json', value: { status } },
    });
    if (!changed.ok) return outcomeFromTransport(changed);
    /*
     * 404 is `found: false`, and only here.
     *
     * The request was authenticated — the token exchange already succeeded — so this is
     * Marzban answering a question it understood: it does not have this account. That
     * is a POSITIVE statement and the caller acts on it differently from every other
     * failure. An unauthenticated 404 cannot reach this line.
     */
    if (changed.status === 404) return { ok: true, found: false };
    if (changed.status === 429) return { ok: false, failure: 'RATE_LIMITED', status: 429 };
    if (changed.status < 200 || changed.status >= 300) {
      /*
       * Nothing after a good token exchange may report an authentication failure — it
       * would send an operator to replace a password that just worked. A 422 for a
       * status Marzban will not take lands here as PROVIDER_ERROR, which classifies as
       * UNKNOWN for a mutating operation and routes to reconciliation. That is right:
       * this adapter only ever sends the two statuses v0.8.4 accepts, so a 422 means
       * the panel is not the one this table describes and guessing is worse than asking.
       */
      return { ok: false, failure: 'PROVIDER_ERROR', status: changed.status };
    }
    const record = parseJson(changed.bodyText);
    if (record === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: changed.status };
    }
    /*
     * The panel's own word for what the account is NOW, checked rather than assumed.
     *
     * Marzban returns the whole user record from a modify, so there is no reason to
     * infer the result from the request. A 200 whose record does not carry the status
     * that was asked for is a panel doing something this adapter does not model, and
     * reporting success for it would be reporting a suspension that did not happen.
     */
    if (record['status'] !== status) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: changed.status };
    }
    return { ok: true, found: true, usage: usageFromUser(record) };
  }

  /**
   * Make this account's allowance read as the plan says. `RENEW_USER`, `ADD_VOLUME`
   * and `ADD_TIME`, all three over the one route that performs them.
   *
   * The body carries exactly the fields the plan sets and no others, because an omitted
   * key is no change on this panel and a key set to something read back a moment ago
   * would turn a replay into a different request. `crud.update_user` assigns
   * `dbuser.expire` and `dbuser.data_limit` absolutely, so the same body sent twice
   * leaves the same two numbers — which is the whole basis on which `RENEW`,
   * `ADD_TRAFFIC` and `ADD_TIME` are in `IDEMPOTENT_MUTATIONS`.
   *
   * `expire` is epoch SECONDS. Milliseconds would be a date in the year 58,000 and the
   * panel would take it without complaint, so the conversion is here and the unit is
   * named where somebody editing this will read it.
   *
   * There is deliberately no `status` in the body, and no call to
   * `POST /api/user/{name}/reset` anywhere in this adapter. Marzban decides the status
   * itself from the new numbers — a `limited` account whose limit now exceeds its usage
   * becomes `active`, a `disabled` one stays disabled — and sending one would override
   * a decision the panel is better placed to make. A reset would clear `used_traffic`,
   * and replayed after the customer had consumed more it would destroy real evidence of
   * consumption; `scripts/marzban-allowance-check.sh` row 4 is the measurement showing
   * that raising a limit already keeps the counter.
   *
   * The response's own record is CHECKED rather than the request assumed, exactly as
   * `setStatus` does: a 200 whose user does not carry the values that were asked for is
   * a panel doing something this adapter does not model, and reporting success for it
   * would be reporting a renewal that did not happen.
   */
  async applyAllowance(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    plan: ProviderAllowancePlan,
  ): Promise<ProviderStateChangeOutcome> {
    if (plan.expiresAt === null && plan.trafficLimitBytes === null) {
      /*
       * An empty plan is a caller defect, not a provider one.
       *
       * `provisioning_operations_target_present_check` refuses such a row, so this is
       * unreachable from the executor. It is a refusal rather than an empty PUT because
       * a request that asks for nothing and answers 200 would be recorded as a renewal
       * that succeeded.
       */
      return { ok: false, failure: 'PROVIDER_ERROR', status: null };
    }

    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const body: Record<string, unknown> = {};
    if (plan.expiresAt !== null) {
      body['expire'] = Math.floor(plan.expiresAt.getTime() / 1000);
    }
    if (plan.trafficLimitBytes !== null) {
      /*
       * `0` is what this installation stores for "no limit", and it is what Marzban
       * reads as "no limit" too — `data_limit: 0` becomes SQL NULL. The two sentinels
       * agree, so no branch is needed and none must be added: a branch that skipped the
       * key for zero would leave an unlimited renewal quietly keeping the old cap.
       */
      body['data_limit'] = Number(plan.trafficLimitBytes);
    }

    const changed = await http.send({
      method: 'PUT',
      path: `${USER_PATH}/${encodeURIComponent(ref.username)}`,
      headers: { authorization: `Bearer ${auth.token}` },
      body: { kind: 'json', value: body },
    });
    if (!changed.ok) return outcomeFromTransport(changed);
    // A 404 after a good token exchange is the panel saying it does not hold this
    // account. A positive statement, and the caller acts on it differently.
    if (changed.status === 404) return { ok: true, found: false };
    if (changed.status === 429) return { ok: false, failure: 'RATE_LIMITED', status: 429 };
    if (changed.status < 200 || changed.status >= 300) {
      return { ok: false, failure: 'PROVIDER_ERROR', status: changed.status };
    }
    const record = parseJson(changed.bodyText);
    if (record === null) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: changed.status };
    }
    // Read from the RESPONSE rather than inferred from the request, for the reason
    // `setStatus` states: a 200 whose record still holds the old expiry is a panel doing
    // something this adapter does not model, and success would tell a customer their
    // service was renewed when it was not. `planApplied` folds 0 and null as the panel does.
    const applied = planApplied(record, plan);
    if (applied === 'MALFORMED') {
      return {
        ok: false,
        failure: 'MALFORMED_RESPONSE',
        status: changed.status,
        detail: 'VALUE_MALFORMED',
      };
    }
    if (applied === 'DIFFERENT') {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: changed.status };
    }
    return { ok: true, found: true, usage: usageFromUser(record) };
  }

  /** Disable one account. `DISABLE_USER`. */
  async suspendUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderStateChangeOutcome> {
    return this.setStatus(target, http, ref, STATUS_DISABLED);
  }

  /** Re-enable one account. `ENABLE_USER`. */
  async resumeUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderStateChangeOutcome> {
    return this.setStatus(target, http, ref, STATUS_ACTIVE);
  }

  /**
   * Delete one account. `DELETE_USER`.
   *
   * The 404 here is a SUCCESS, and it is the only place in this adapter where a 404
   * means the work is done rather than that something is missing. A delete replayed
   * after a lost answer finds nothing the second time, and "this account is not on this
   * panel" — which is the whole of what a terminate asks for — holds either way.
   * `wasPresent` is what keeps the operations record able to say which call did it.
   *
   * There is no confirmation step in this method and there must not be one. The
   * decision that a service should be destroyed is made by the customer or an operator,
   * in a surface, before an operation is ever planned; an adapter that re-asked would
   * be a second, weaker gate that looks like a safeguard.
   */
  async terminateUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderRemovalOutcome> {
    const auth = await this.authenticate(target, http);
    if (!auth.ok) return auth;

    const removed = await http.send({
      method: 'DELETE',
      path: `${USER_PATH}/${encodeURIComponent(ref.username)}`,
      headers: { authorization: `Bearer ${auth.token}` },
    });
    if (!removed.ok) return outcomeFromTransport(removed);
    if (removed.status === 404) return { ok: true, wasPresent: false };
    if (removed.status === 429) return { ok: false, failure: 'RATE_LIMITED', status: 429 };
    if (removed.status < 200 || removed.status >= 300) {
      return { ok: false, failure: 'PROVIDER_ERROR', status: removed.status };
    }
    /*
     * The body is deliberately NOT parsed.
     *
     * v0.8.4 answers `{"detail": "User successfully deleted"}`, and reading it would
     * make an English sentence load-bearing — a locale, a proxy that rewrites bodies,
     * or an upstream wording change would each turn a completed delete into a failure.
     * The 2xx is the statement; the sentence is decoration.
     */
    return { ok: true, wasPresent: true };
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
