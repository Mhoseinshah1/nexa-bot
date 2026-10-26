import { randomBytes } from 'node:crypto';
import {
  assertSendableProviderUsername,
  providerDescriptor,
  type Clock,
  type CreateProviderUserInput,
  type ProviderAdapter,
  type ProviderAllowancePlan,
  type ProviderCapability,
  type ProviderDescriptor,
  type ProviderFailureKind,
  type ProviderFailureResult,
  type ProviderHttpClient,
  type ProviderHttpResult,
  type ProviderLookupOutcome,
  type ProviderProbeOutcome,
  type ProviderRemovalOutcome,
  type ProviderRotationOutcome,
  type ProviderServiceTarget,
  type ProviderStateChangeOutcome,
  type ProviderTarget,
  type ProviderUsage,
  type ProviderUsageOutcome,
  type ProviderUserOutcome,
  type ProviderUserRef,
  type ProviderWriteContext,
} from '@nexa/contracts';
import { SystemClock } from '../../../../infrastructure/clock.js';
import {
  ACCOUNTS_PATH,
  ACCOUNT_SUFFIX,
  CUSTOM_PROTOCOL_NAME,
  CUSTOM_PROTOCOL_VERSION,
  EMPTY_BODY_SHA256,
  HEADER,
  HEALTH_PATH,
  accountPath,
  canonicalRequest,
  formatBytes,
  formatTimestamp,
  parseAccount,
  parseJsonObject,
  protocolPath,
  readSignedError,
  readUnsigned,
  responseSignatureValid,
  safeBridgeVersion,
  sha256Hex,
  sign,
  toWireSecond,
  type CustomAccount,
} from './custom-panel-protocol.js';

/**
 * The `custom` provider: Nexa's OWN bridge protocol, v1 (R10 C2).
 *
 * `docs/protocols/custom-panel.md` is the specification. A third party writes a small
 * HTTPS service — the bridge — that speaks it towards Nexa and their panel's API behind
 * it; this adapter is the only code on Nexa's side that speaks it, and it speaks nothing
 * else. An operator configures a base URL, a secret and a timeout.
 *
 * ## The four rules this adapter exists to keep
 *
 * 1. **Only a SIGNED answer can say yes, absent or refused.** Every response must carry
 *    `X-Nexa-Bridge-Signature` over its status, THIS request's nonce and its body hash.
 *    An unsigned or wrongly signed answer is never a success, never "account not found"
 *    and never a refusal (`readUnsigned`): an unsigned 404 is what a wrong base URL
 *    pointing at some other web server says, and "not found" is the one answer that lets
 *    Nexa create an account again.
 * 2. **An unknown code is an error, not a refusal.** A refusal is DEFINITIVE and a
 *    refused create is refunded; a code outside the protocol's table, or one under the
 *    wrong status, is `PROVIDER_ERROR` — UNKNOWN for a create, settled by a READ.
 * 3. **Every write carries Nexa's operation id and the service's binding.** `operationId`
 *    (the provisioning operation, the same on every attempt) is the bridge's idempotency
 *    key; `nexaRef` (the service's stored `clientId`, written before any call) binds the
 *    account, so a disable or delete by name cannot reach an account Nexa did not create.
 *    A write without an operation id is refused HERE, before anything is sent.
 * 4. **A lookup proves binding, never adopts a stranger.** An account whose `nexaRef` is
 *    not this service's is neither "found" nor "absent": it is a refusal, which leaves a
 *    reconcile UNDECIDED for an operator. Auto-adopting after a lost create (C2-b) is an
 *    open owner question (`OQ-C2-01`) and is not done.
 *
 * No retries and no read-back poll on create: the protocol REQUIRES read-your-writes, so
 * the signed create answer carries the account as the panel holds it.
 */

const DESCRIPTOR: ProviderDescriptor = providerDescriptor('custom') ?? {
  // Unreachable: `custom` is in `PROVIDER_TYPES` and a unit test proves every type has a
  // descriptor. A fallback rather than a `!` so a contract edit removing it fails at the
  // type level, and the fallback declares only the connection half.
  key: 'custom',
  canonicalName: 'Custom',
  credentialShape: 'OPAQUE_TOKEN',
  capabilities: ['HEALTH_CHECK'],
  maxRequestsPerProbe: 1,
  requiredActivationFields: [],
};

export interface CustomPanelAdapterOptions {
  /** The request timestamp's source. Injected so tests can pin the vectors. */
  readonly clock?: Clock;
  /** 32 lowercase hex characters per request. Injected for the same reason. */
  readonly nonce?: () => string;
}

/** One request as an operation asks for it: a method, a path relative to the base, a body. */
interface SignedRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

/** What one signed-or-not exchange produced, before an operation reads it. */
type Exchange =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: Record<string, unknown> | null;
    }
  | ProviderFailureResult;

const UNSUPPORTED: ProviderFailureResult = {
  ok: false,
  failure: 'UNSUPPORTED_CAPABILITY',
  status: null,
};

function failure(kind: ProviderFailureKind, status: number | null): ProviderFailureResult {
  return { ok: false, failure: kind, status };
}

function transportFailure(
  result: Extract<ProviderHttpResult, { ok: false }>,
): ProviderFailureResult {
  return result.detail === undefined
    ? { ok: false, failure: result.failure, status: result.status }
    : { ok: false, failure: result.failure, status: result.status, detail: result.detail };
}

function usageOf(account: CustomAccount): ProviderUsage {
  return {
    usedBytes: account.trafficUsedBytes,
    // `"0"` is the protocol's unlimited and `null` is Nexa's: one translation, here.
    totalBytes: account.trafficLimitBytes === 0n ? null : account.trafficLimitBytes,
    expiresAt: account.expiresAt,
    lastSeen: account.lastConnection,
  };
}

const isSuccess = (status: number): boolean => status >= 200 && status <= 299;

export class CustomPanelAdapter implements ProviderAdapter {
  readonly descriptor = DESCRIPTOR;

  private readonly clock: Clock;
  private readonly nonce: () => string;

  constructor(options: CustomPanelAdapterOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.nonce = options.nonce ?? (() => randomBytes(16).toString('hex'));
  }

  supports(capability: ProviderCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  /**
   * One signed request and the verified reading of its answer.
   *
   * The body is serialised ONCE, here, and those exact bytes are hashed, signed and sent
   * (`json-text`). The secret never leaves this function except as an HMAC.
   */
  private async exchange(
    target: ProviderTarget,
    http: ProviderHttpClient,
    request: SignedRequest,
  ): Promise<Exchange> {
    /*
     * HTTPS only, checked before anything is sent (§2). The panel service refuses an
     * http:// address at create and at every change; this is the same rule where the
     * socket is opened, so a row that reached the database another way is not dialled.
     */
    if (!/^https:\/\//i.test(target.baseUrl)) return failure('BLOCKED_TARGET', null);
    if (target.credentials.shape !== 'OPAQUE_TOKEN') return UNSUPPORTED;
    const secret = target.credentials.token;

    const text = request.body === undefined ? null : JSON.stringify(request.body);
    const timestamp = String(Math.floor(this.clock.now().getTime() / 1000));
    const nonce = this.nonce();
    const signature = sign(
      secret,
      canonicalRequest({
        method: request.method,
        protocolPath: protocolPath(request.path),
        timestamp,
        nonce,
        bodySha256: text === null ? EMPTY_BODY_SHA256 : sha256Hex(text),
      }),
    );

    const result = await http.send({
      method: request.method,
      path: request.path,
      headers: {
        [HEADER.protocol]: String(CUSTOM_PROTOCOL_VERSION),
        [HEADER.timestamp]: timestamp,
        [HEADER.nonce]: nonce,
        [HEADER.signature]: signature,
      },
      ...(text === null ? {} : { body: { kind: 'json-text' as const, text } }),
    });
    if (!result.ok) return transportFailure(result);

    const signed = responseSignatureValid(
      secret,
      { status: result.status, nonce, bodyText: result.bodyText },
      result.headers[HEADER.bridgeSignature],
    );
    if (!signed) return failure(readUnsigned(result.status), result.status);
    return { ok: true, status: result.status, body: parseJsonObject(result.bodyText) };
  }

  /**
   * A signed non-2xx answer to an operation that has no use for "not found".
   * The protocol's table, with `NOT_FOUND` read as the error it is in that context.
   */
  private static errorOf(answer: { status: number; body: Record<string, unknown> | null }) {
    const reading = readSignedError(answer.status, answer.body);
    return failure(reading === 'NOT_FOUND' ? 'PROVIDER_ERROR' : reading, answer.status);
  }

  /**
   * `GET v1/health` (§5.1). A signed 200 naming this protocol and version 1 is the only
   * successful connection test; `upstream` other than `OK` is DEGRADED — the secret is
   * right and something behind the bridge is not.
   */
  async probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome> {
    const answer = await this.exchange(target, http, { method: 'GET', path: HEALTH_PATH });
    if (!answer.ok) return { ok: false, failure: answer.failure, status: answer.status };
    if (!isSuccess(answer.status)) {
      const error = CustomPanelAdapter.errorOf(answer);
      return { ok: false, failure: error.failure, status: error.status };
    }
    const body = answer.body;
    const versions = body?.['protocolVersions'];
    if (
      body === null ||
      body['protocol'] !== CUSTOM_PROTOCOL_NAME ||
      !Array.isArray(versions) ||
      !versions.includes(CUSTOM_PROTOCOL_VERSION)
    ) {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: answer.status };
    }
    const upstream = body['upstream'];
    if (upstream !== 'OK' && upstream !== 'DEGRADED' && upstream !== 'DOWN') {
      return { ok: false, failure: 'MALFORMED_RESPONSE', status: answer.status };
    }
    const bridge = body['bridge'];
    const version =
      typeof bridge === 'object' && bridge !== null && !Array.isArray(bridge)
        ? safeBridgeVersion((bridge as Record<string, unknown>)['version'])
        : null;
    return { ok: true, providerVersion: version, degraded: upstream !== 'OK' };
  }

  /**
   * `POST v1/accounts` (§5.2).
   *
   *   signed 201/200 + Account  -> delivered (200 is a replay of this operation id)
   *   signed 2xx, unreadable    -> MALFORMED_RESPONSE, `accepted`: UNKNOWN, a READ settles
   *   signed 409/422/400        -> PROVIDER_REFUSED: definitive, nothing was created
   *   signed 401/429/501        -> as the table says
   *   anything else             -> UNKNOWN (5xx, unknown code, unsigned, timeout)
   *
   * The entitlement is sent exactly as the order froze it, and the protocol forbids the
   * bridge to reinterpret it: a plan the panel cannot hold is `422 RULE_REFUSED`.
   */
  async createUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    input: CreateProviderUserInput,
  ): Promise<ProviderUserOutcome> {
    assertSendableProviderUsername(input.username);
    // Fail closed, nothing sent: without Nexa's operation id the bridge cannot tell a
    // repeated create from a new one.
    if (input.operationId === undefined) return UNSUPPORTED;

    const answer = await this.exchange(target, http, {
      method: 'POST',
      path: ACCOUNTS_PATH,
      body: {
        operationId: input.operationId,
        username: input.username,
        nexaRef: input.clientId,
        // Zero is the protocol's unlimited, as it is the schema's.
        trafficLimitBytes: formatBytes(input.volumeBytes ?? 0n),
        expiresAt: input.expiresAt === null ? null : formatTimestamp(input.expiresAt),
        deviceLimit: input.deviceLimit,
      },
    });
    if (!answer.ok) return answer;

    if (isSuccess(answer.status)) {
      const account = parseAccount(answer.body?.['account'], input.username);
      if (account === null) {
        // The bridge said it created the account and the answer is unreadable: the
        // create probably happened, and a READ — never a second create — settles it.
        return { ok: false, failure: 'MALFORMED_RESPONSE', status: answer.status, accepted: true };
      }
      if (account.nexaRef !== input.clientId) {
        // A success about an account bound to something else is not this create's
        // account. No provenance: a READ finds the mismatch and leaves it to an operator.
        return { ok: false, failure: 'MALFORMED_RESPONSE', status: answer.status };
      }
      return {
        ok: true,
        // The bridge keys accounts by the name Nexa chose; there is no second identity.
        providerUserId: null,
        delivery: { kind: 'SUBSCRIPTION_LINK', url: account.subscriptionUrl },
        usage: usageOf(account),
      };
    }
    return CustomPanelAdapter.errorOf(answer);
  }

  /**
   * `GET v1/accounts/{username}` (§5.3) — the read every ambiguous outcome is settled by.
   *
   * A SIGNED `404 ACCOUNT_NOT_FOUND` is absent. An account bound to this service's
   * `nexaRef` is found. An account bound to anything else — another ref, or none — is
   * `PROVIDER_REFUSED` (409): the name is held by an account that is not this service's,
   * which is neither absence (that would allow a second create) nor ours to adopt.
   */
  async lookupUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderLookupOutcome> {
    const read = await this.readAccount(target, http, ref);
    if (!read.ok) return read;
    if (!read.found) return { ok: true, found: false };
    return {
      ok: true,
      found: true,
      providerUserId: null,
      delivery: { kind: 'SUBSCRIPTION_LINK', url: read.account.subscriptionUrl },
      usage: usageOf(read.account),
    };
  }

  private async readAccount(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<
    | { readonly ok: true; readonly found: true; readonly account: CustomAccount }
    | { readonly ok: true; readonly found: false }
    | ProviderFailureResult
  > {
    assertSendableProviderUsername(ref.username);
    const answer = await this.exchange(target, http, {
      method: 'GET',
      path: accountPath(ref.username),
    });
    if (!answer.ok) return answer;
    if (!isSuccess(answer.status)) {
      const reading = readSignedError(answer.status, answer.body);
      if (reading === 'NOT_FOUND') return { ok: true, found: false };
      return failure(reading, answer.status);
    }
    const account = parseAccount(answer.body?.['account'], ref.username);
    if (account === null) {
      return {
        ok: false,
        failure: 'MALFORMED_RESPONSE',
        status: answer.status,
        detail: 'VALUE_MALFORMED',
      };
    }
    if (account.nexaRef !== ref.clientId) return failure('PROVIDER_REFUSED', 409);
    return { ok: true, found: true, account };
  }

  /** One account's traffic. A read; an account the bridge does not have is a divergence. */
  async readUsage(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderUsageOutcome> {
    const found = await this.lookupUser(target, http, ref);
    if (!found.ok) return found;
    if (!found.found) return failure('PROVIDER_ERROR', null);
    if (found.usage === null) return failure('MALFORMED_RESPONSE', null);
    return { ok: true, usage: found.usage };
  }

  /**
   * One write addressed to an existing account: `{operationId, nexaRef, …}` to
   * `v1/accounts/{username}/<suffix>`. A signed `404 ACCOUNT_NOT_FOUND` is the positive
   * "not there"; every other non-2xx is the table's reading.
   */
  private async accountWrite(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    suffix: string,
    context: ProviderWriteContext,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<
    | { readonly ok: true; readonly found: true; readonly body: Record<string, unknown> | null }
    | { readonly ok: true; readonly found: false }
    | ProviderFailureResult
  > {
    assertSendableProviderUsername(ref.username);
    const answer = await this.exchange(target, http, {
      method: 'POST',
      path: accountPath(ref.username, suffix),
      body: { operationId: context.operationId, nexaRef: ref.clientId, ...extra },
    });
    if (!answer.ok) return answer;
    if (!isSuccess(answer.status)) {
      const reading = readSignedError(answer.status, answer.body);
      if (reading === 'NOT_FOUND') return { ok: true, found: false };
      return failure(reading, answer.status);
    }
    return { ok: true, found: true, body: answer.body };
  }

  /**
   * The account a write answered with, checked: present, this account, this binding.
   * `null` is `MALFORMED_RESPONSE` — for an idempotent mutation that is a retry under the
   * SAME operation id, which the bridge answers as a replay.
   */
  private static writtenAccount(
    body: Record<string, unknown> | null,
    ref: ProviderUserRef,
  ): CustomAccount | null {
    const account = parseAccount(body?.['account'], ref.username);
    return account !== null && account.nexaRef === ref.clientId ? account : null;
  }

  /**
   * `POST …/allowance` (§5.4): renew, add traffic and add time as ONE call carrying
   * ABSOLUTE targets. An omitted field is unchanged, so a `null` in the plan is not sent
   * — sending `"0"` would make it unlimited, and sending what was read back would turn a
   * replay into a different request.
   *
   * The answer must show the targets applied — read from the account the bridge returns,
   * never inferred from the request. A REPLAY (`"replayed": true`) answers with the
   * account as it is now and the first application wins, so it is not compared.
   */
  async applyAllowance(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    plan: ProviderAllowancePlan,
    context?: ProviderWriteContext,
  ): Promise<ProviderStateChangeOutcome> {
    if (plan.expiresAt === null && plan.trafficLimitBytes === null) {
      // A caller defect, refused rather than sent: a request that asks for nothing and
      // answers 200 would be recorded as a renewal that succeeded.
      return failure('PROVIDER_ERROR', null);
    }
    if (context === undefined) return UNSUPPORTED;
    const written = await this.accountWrite(target, http, ref, ACCOUNT_SUFFIX.allowance, context, {
      ...(plan.expiresAt === null ? {} : { expiresAt: formatTimestamp(plan.expiresAt) }),
      ...(plan.trafficLimitBytes === null
        ? {}
        : { trafficLimitBytes: formatBytes(plan.trafficLimitBytes) }),
    });
    if (!written.ok || !written.found) return written;
    const account = CustomPanelAdapter.writtenAccount(written.body, ref);
    if (account === null) return failure('MALFORMED_RESPONSE', 200);
    if (written.body?.['replayed'] !== true) {
      const expiryApplied =
        plan.expiresAt === null ||
        (account.expiresAt !== null &&
          toWireSecond(account.expiresAt) === toWireSecond(plan.expiresAt));
      const trafficApplied =
        plan.trafficLimitBytes === null || account.trafficLimitBytes === plan.trafficLimitBytes;
      if (!expiryApplied || !trafficApplied) return failure('MALFORMED_RESPONSE', 200);
    }
    return { ok: true, found: true, usage: usageOf(account) };
  }

  /** `POST …/disable` (§5.5). The answer must show `DISABLED` (unless it is a replay). */
  async suspendUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    context?: ProviderWriteContext,
  ): Promise<ProviderStateChangeOutcome> {
    return this.setDisabled(target, http, ref, context, true);
  }

  /** `POST …/enable` (§5.6). The answer must NOT show `DISABLED` (unless it is a replay). */
  async resumeUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    context?: ProviderWriteContext,
  ): Promise<ProviderStateChangeOutcome> {
    return this.setDisabled(target, http, ref, context, false);
  }

  private async setDisabled(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    context: ProviderWriteContext | undefined,
    disabled: boolean,
  ): Promise<ProviderStateChangeOutcome> {
    if (context === undefined) return UNSUPPORTED;
    const written = await this.accountWrite(
      target,
      http,
      ref,
      disabled ? ACCOUNT_SUFFIX.disable : ACCOUNT_SUFFIX.enable,
      context,
    );
    if (!written.ok || !written.found) return written;
    const account = CustomPanelAdapter.writtenAccount(written.body, ref);
    if (account === null) return failure('MALFORMED_RESPONSE', 200);
    if (written.body?.['replayed'] !== true && (account.status === 'DISABLED') !== disabled) {
      // A 200 whose account does not show the change is a suspension that did not happen.
      return failure('MALFORMED_RESPONSE', 200);
    }
    return { ok: true, found: true, usage: usageOf(account) };
  }

  /**
   * `POST …/delete` (§5.7). A signed `404 ACCOUNT_NOT_FOUND` is SUCCESS — "already gone",
   * the normal answer to a delete repeated after a lost response. `409 ACCOUNT_NOT_BOUND`
   * is a refusal and is NOT success: the account is there and is not this service's.
   */
  async terminateUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    context?: ProviderWriteContext,
  ): Promise<ProviderRemovalOutcome> {
    if (context === undefined) return UNSUPPORTED;
    const written = await this.accountWrite(target, http, ref, ACCOUNT_SUFFIX.delete, context);
    if (!written.ok) return written;
    if (!written.found) return { ok: true, wasPresent: false };
    if (written.body?.['deleted'] !== true) return failure('MALFORMED_RESPONSE', 200);
    return { ok: true, wasPresent: true };
  }

  /**
   * `POST …/rotate-link` (§5.8), PROVEN by a read.
   *
   * The new link is taken from `GET v1/accounts/{username}` afterwards, never from the
   * rotation's own answer, and compared with `previousUrl`: different is a rotation that
   * happened, whatever the call answered; the same after a 2xx is a bridge claiming a
   * rotation it did not make (`MALFORMED_RESPONSE`); the same after an ambiguous answer
   * proves nothing happened and returns that answer, so the retry — under the same
   * operation id, which the bridge will not apply twice — can make the first one.
   */
  async rotateSubscription(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    previousUrl: string | null,
    context?: ProviderWriteContext,
  ): Promise<ProviderRotationOutcome> {
    if (context === undefined) return UNSUPPORTED;
    const rotated = await this.accountWrite(target, http, ref, ACCOUNT_SUFFIX.rotateLink, context);
    let unresolved: ProviderFailureResult | null = null;
    if (!rotated.ok) {
      // Only an answer that says NOTHING happened ends it here. Everything that may
      // have — a transport failure, an unsigned answer, a 5xx, an unknown code — is
      // settled by the read below.
      if (
        rotated.failure === 'PROVIDER_REFUSED' ||
        rotated.failure === 'AUTHENTICATION_FAILED' ||
        rotated.failure === 'RATE_LIMITED' ||
        rotated.failure === 'UNSUPPORTED_CAPABILITY' ||
        rotated.failure === 'BLOCKED_TARGET'
      ) {
        return rotated;
      }
      unresolved = rotated;
    } else if (!rotated.found) {
      return { ok: true, found: false };
    }

    const read = await this.readAccount(target, http, ref);
    if (!read.ok) return unresolved ?? read;
    if (!read.found) return { ok: true, found: false };
    if (read.account.subscriptionUrl !== previousUrl) {
      return { ok: true, found: true, subscriptionUrl: read.account.subscriptionUrl };
    }
    return unresolved ?? failure('MALFORMED_RESPONSE', 200);
  }
}
