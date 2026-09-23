import { z } from 'zod';
import type { ServiceId } from './ids.js';

/**
 * The provider adapter contract.
 *
 * Every panel type is an adapter implementing this interface and DECLARING its
 * capabilities as data. Capabilities are never inferred from a version string,
 * and no code outside the adapter registry branches on provider type.
 *
 * The differences are of kind, not degree, and they are now verified rather
 * than assumed. These are separate products with separate APIs; nothing below
 * is shared between them beyond this interface.
 *
 *   - **Marzban** authenticates with a username and password, which it
 *     exchanges through its own API for an ephemeral Bearer token. Nexa stores
 *     the pair and never the token: the token lives for one probe.
 *   - **Sanaei / 3X-UI v3.7.0** accepts EITHER a scoped Bearer API token or a
 *     browser-style session obtained by logging in — and that login is bound to
 *     a CSRF token minted in the same session, so it is a sequence rather than
 *     a request. It also needs a separately configured subscription-link
 *     domain, because its sub URL is not derived from the panel address.
 *
 * A manual-sale provider has no backend at all. An interface validated against
 * one implementation is not an interface.
 *
 * Phase 0 shipped the vocabulary; Phase 3 populates the descriptors and
 * implements the CONNECTION half. The service half — creating users, reading
 * usage — is Phase 4, and is deliberately a separate interface so that a Phase
 * 3 adapter is complete rather than three-quarters stubbed. A stub that returns
 * "not implemented" is a placeholder abstraction, which this codebase refuses.
 */

export const PROVIDER_CAPABILITIES = [
  'CREATE_USER',
  'RENEW_USER',
  'DELETE_USER',
  'DISABLE_USER',
  'ENABLE_USER',
  'READ_USAGE',
  'RESET_USAGE',
  'ADD_VOLUME',
  'ADD_TIME',
  'ROTATE_SUBSCRIPTION_LINK',
  'DELIVER_SUBSCRIPTION_LINK',
  'DELIVER_RAW_CONFIGS',
  'DELIVER_CONFIG_FILE',
  'LIMIT_DEVICES',
  'INACTIVE_ACCOUNT_INBOUND',
  'HEALTH_CHECK',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

/**
 * What a provider needs in order to authenticate.
 *
 * `TOKEN_OR_USERNAME_PASSWORD` is not a convenience: 3X-UI v3.7.0 accepts a
 * scoped Bearer API token AND a browser-style session login, and both
 * authenticate the same `/panel/api` surface. A provider that genuinely has two
 * modes must say so, because the alternative is a descriptor that names one and
 * an adapter that quietly tries the other.
 *
 * The SELECTION between them is made once, by the credential resolver, and the
 * adapter is handed an already-narrowed `OPAQUE_TOKEN` or `USERNAME_PASSWORD`.
 * That is what makes "a configured API token is never silently replaced by the
 * password" a property of the resolver rather than a rule every adapter has to
 * remember.
 */
export const CREDENTIAL_SHAPES = [
  'USERNAME_PASSWORD',
  'OPAQUE_TOKEN',
  'TOKEN_OR_USERNAME_PASSWORD',
  'NONE',
] as const;
export type CredentialShape = (typeof CREDENTIAL_SHAPES)[number];

/**
 * Which credential fields a shape can actually USE.
 *
 * The descriptor was fetched and shown, and nothing enforced it. A Marzban
 * panel — `USERNAME_PASSWORD` — accepted an API token, stored the secret, and
 * then failed every connection test with "credentials missing", because
 * `toProviderCredentials` ignores a field the shape does not name. The Web
 * Admin had accepted a credential that could never affect the panel: a write
 * that reports success and does nothing, which is the legacy behaviour this
 * codebase exists to end.
 *
 * Exported so the service refuses it and the forms do not offer it — the
 * server is the enforcement, the UI merely stops asking.
 */
export const CREDENTIAL_FIELDS_BY_SHAPE: Readonly<
  Record<CredentialShape, readonly ('username' | 'password' | 'apiToken')[]>
> = {
  USERNAME_PASSWORD: ['username', 'password'],
  OPAQUE_TOKEN: ['apiToken'],
  TOKEN_OR_USERNAME_PASSWORD: ['username', 'password', 'apiToken'],
  NONE: [],
};

/** Whether `field` is one the given shape can use. */
export function shapeAcceptsCredential(
  shape: CredentialShape,
  field: 'username' | 'password' | 'apiToken',
): boolean {
  return CREDENTIAL_FIELDS_BY_SHAPE[shape].includes(field);
}

/**
 * Whether the credentials a panel HOLDS are enough for the shape to authenticate.
 *
 * The mirror of `toProviderCredentials` in the probe core, which returns `null`
 * — and therefore `CREDENTIALS_MISSING`, a 412 — for exactly these cases. It
 * lives here rather than in the surface because there are now two callers with
 * one question between them, and a surface that answers it differently from the
 * server is the defect this branch exists to remove: a "test connection" button
 * on a panel whose stored credentials cannot produce a request.
 *
 * `TOKEN_OR_USERNAME_PASSWORD` is satisfied by EITHER, matching the probe
 * core's precedence exactly; `NONE` is satisfied by nothing being needed.
 *
 * Takes presence, not values. `PanelSummaryResponse.credentials` carries three
 * `configured` booleans and no ciphertext — deliberately, so no response
 * builder can acquire a secret — which is precisely enough to answer this.
 */
export function shapeIsSatisfiedBy(
  shape: CredentialShape,
  configured: { username: boolean; password: boolean; apiToken: boolean },
): boolean {
  switch (shape) {
    case 'USERNAME_PASSWORD':
      return configured.username && configured.password;
    case 'OPAQUE_TOKEN':
      return configured.apiToken;
    case 'TOKEN_OR_USERNAME_PASSWORD':
      return configured.apiToken || (configured.username && configured.password);
    case 'NONE':
      return true;
  }
}

/**
 * The provider types this release can operate, as a closed set.
 *
 * A hybrid on purpose. The identifier is persisted — `panels.provider_type` —
 * but the SET is code, and the adapter registry is exhaustive over it. A
 * persisted string can therefore never instantiate an adapter that does not
 * exist: an unrecognised value fails the CHECK constraint on the way in, and
 * fails `PROVIDER_TYPE_UNSUPPORTED` on the way out if a migration or a direct
 * database write ever gets one past it.
 *
 * A `provider_definitions` table was the alternative and is rejected: a row
 * there would let an operator name a provider with no code behind it, and the
 * first thing that happens next is a panel pointing at it.
 */
export const PROVIDER_TYPES = ['marzban', 'rickpanel', 'sanaei'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export function isProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * The per-panel configuration a provider needs before it can build a config at all.
 *
 * `requiredActivationFields` below has named this since Phase 3 and nothing stored a
 * value for it, so a 3X-UI panel could be connected, probed and shown as healthy while
 * being unable to produce the one thing a customer buys. These schemas are that field
 * list made real: declared per provider, validated at the boundary, and stored on the
 * panel.
 *
 * Declared as SCHEMAS rather than an open `jsonb` blob for the same reason
 * `settings.ts` has a registry: a key that is not declared does not exist, and an
 * untyped bag on a panel row is how a provider ends up reading a field somebody
 * invented in a support conversation.
 *
 * None of these has a default, and that is deliberate. Guessing which inbound a
 * customer's account is created on is guessing which server they connect to; the
 * research is explicit that the legacy system's inbound selection was never observable,
 * so a default here would be a fabricated product decision. An unset panel refuses with
 * `PANEL_NOT_OPERABLE` and names the field.
 *
 * Marzban's `inboundTags` was the exception until a real panel closed it, and the way
 * it failed is worth keeping: an optional field documented as defaulting to "every
 * inbound" actually defaulted to NONE, so the guess was not merely unprincipled — it
 * was wrong, and it produced accounts a customer could not connect with while every
 * status code said success.
 */
export const MARZBAN_PROXY_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks'] as const;
export type MarzbanProxyProtocol = (typeof MARZBAN_PROXY_PROTOCOLS)[number];

export const marzbanActivationSchema = z
  .object({
    /**
     * Which proxy protocols a created user is given. At least one, because a Marzban
     * user with no proxies is an account that cannot connect to anything.
     */
    proxyProtocols: z.array(z.enum(MARZBAN_PROXY_PROTOCOLS)).min(1).max(4),
    /**
     * Inbound tags per protocol, and REQUIRED — one entry per protocol, each naming at
     * least one tag.
     *
     * This field was optional, documented as "absent means every inbound Marzban has
     * for that protocol, which is Marzban's own default and not an invention of ours".
     * That sentence was wrong, and a panel said so. `UserCreate.excluded_inbounds` in
     * Marzban v0.8.4 computes the set of inbounds to EXCLUDE as every inbound for each
     * requested protocol that is not listed here, so an absent key excludes all of
     * them. The create still answers 200 and still returns a subscription URL; what the
     * customer receives is a zero-byte subscription. Measured on the binary, in
     * `docs/providers/marzban.md`.
     *
     * So there is no default and cannot be one, for the same reason `proxyProtocols`
     * has none: choosing an inbound is choosing which server a customer connects to.
     * A panel that does not name its tags is `PANEL_NOT_OPERABLE` and the operator is
     * told which field is missing — which is the outcome this schema exists to produce,
     * and is strictly better than a panel that provisions accounts serving nothing.
     */
    inboundTags: z.record(
      z.string().min(1).max(64),
      z.array(z.string().min(1).max(64)).min(1).max(32),
    ),
  })
  .superRefine((value, ctx) => {
    /*
     * Every configured protocol must have tags, not just SOME protocol.
     *
     * A record keyed by `vless` alone satisfies the field while a panel configured for
     * `vless` and `vmess` silently creates every vmess proxy with no inbound — the same
     * zero-byte subscription as before, reached by a narrower path. The cross-field
     * check is here rather than in the service because this is the shape's own rule and
     * every caller validates through this schema.
     */
    for (const protocol of value.proxyProtocols) {
      const tags = value.inboundTags[protocol];
      if (tags === undefined || tags.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['inboundTags', protocol],
          message: `inboundTags must name at least one inbound for ${protocol}`,
        });
      }
    }
  });
export type MarzbanActivation = z.infer<typeof marzbanActivationSchema>;

export const sanaeiActivationSchema = z.object({
  /**
   * The host that serves `/sub/`.
   *
   * Separate from the panel's own address because 3X-UI does not derive it: the
   * subscription service is a different listener, frequently on a different hostname
   * and port, and a link built from the panel address points at the admin panel.
   * Host and optional port only — a full URL here would let a panel row name a
   * destination the URL policy never saw.
   */
  subscriptionDomain: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*(:\d{1,5})?$/,
      'must be a host, optionally with a port',
    ),
  /** Which inbound a created client is added to. 3X-UI keys clients by inbound. */
  inboundId: z.number().int().positive().max(1_000_000),
});
export type SanaeiActivation = z.infer<typeof sanaeiActivationSchema>;

/**
 * RickPanel needs NOTHING configured before it can create a user.
 *
 * An empty object, and it is a statement rather than a placeholder. The attached
 * RickPanel contract says of `POST /api/user`: "`inbounds` and a partial
 * `proxies` set are accepted but ignored: every user gets every protocol and
 * every inbound." There is no protocol to choose and no inbound to name, because
 * the panel chooses both and does not offer the caller a say.
 *
 * Marzban's schema is the opposite and is right to be: omitting `inboundTags`
 * there excludes every inbound and delivers a zero-byte subscription, which is
 * why those two fields have no default and cannot have one. Sharing one schema
 * between the two panels would mean either weakening Marzban's rule — the
 * expensive one, measured on a binary — or demanding two fields from a RickPanel
 * operator that their panel will throw away. Both are worse than two schemas.
 *
 * `.strict()` is deliberate: a `proxyProtocols` key arriving here is a
 * misconfigured panel or a copied Marzban payload, and accepting it silently
 * would let an operator believe they had configured something.
 */
export const rickpanelActivationSchema = z.object({}).strict();
export type RickpanelActivation = z.infer<typeof rickpanelActivationSchema>;

export const panelActivationSchema = z.union([
  marzbanActivationSchema,
  rickpanelActivationSchema,
  sanaeiActivationSchema,
]);
export type PanelActivation = MarzbanActivation | RickpanelActivation | SanaeiActivation;

/** The schema a panel's activation must satisfy, by provider type. Exhaustive. */
export const PANEL_ACTIVATION_SCHEMAS: Readonly<{
  marzban: typeof marzbanActivationSchema;
  rickpanel: typeof rickpanelActivationSchema;
  sanaei: typeof sanaeiActivationSchema;
}> = {
  marzban: marzbanActivationSchema,
  rickpanel: rickpanelActivationSchema,
  sanaei: sanaeiActivationSchema,
};

/**
 * Parse a panel's stored activation against its provider's schema, treating an
 * UNSET activation as an empty one.
 *
 * The normalisation is the whole point, and it exists because leaving it to each
 * caller produced the bug this function was extracted to kill. A panel row's
 * `activation` is nullable, so every evaluator has to decide what `null` means,
 * and two of them decided differently: one answered "the fields this provider
 * requires, and RickPanel requires none, so nothing is missing"; the other asked
 * zod, which rejects `null` whatever the schema is. A RickPanel with no
 * activation row was therefore SELLABLE and NOT OPERABLE at the same time —
 * which is `decideEligibility` and `decideOperability` disagreeing about whether
 * an order can be delivered, and that disagreement is exactly what takes a
 * customer's money for an account that cannot be made.
 *
 * `{}` is the truthful normalisation rather than a convenient one. "Unset" and
 * "set to nothing" are the same fact about a panel, and each provider's own
 * schema is then left to decide whether nothing is enough: `rickpanelActivationSchema`
 * accepts `{}` because a RickPanel has nothing to configure, while Marzban's and
 * 3X-UI's reject it and name the fields they are missing — `proxyProtocols`,
 * `inboundTags`, `subscriptionDomain`, `inboundId` — which is strictly better
 * than a hand-kept list of required keys, because it cannot fall out of step
 * with the schema it describes.
 *
 * The inverse rule matters as much: this NEVER rewrites an activation an
 * operator set. A present-but-invalid activation is passed through unchanged and
 * fails, because silently repairing a misconfiguration is how the legacy system
 * hid them.
 */
export function parsePanelActivation(
  providerType: ProviderType,
  activation: unknown,
): z.ZodSafeParseResult<PanelActivation> {
  const candidate = activation === null || activation === undefined ? {} : activation;
  return PANEL_ACTIVATION_SCHEMAS[providerType].safeParse(
    candidate,
  ) as z.ZodSafeParseResult<PanelActivation>;
}

/**
 * Static description of a provider type. Display names come from the template
 * catalog; `key` is the stable identifier and is never a display string.
 */
export interface ProviderDescriptor {
  readonly key: ProviderType;
  readonly canonicalName: string;
  readonly credentialShape: CredentialShape;
  /**
   * The operations THIS RELEASE can actually execute for this provider.
   *
   * Not a feature matrix, and not a statement about what the panel supports.
   * `supportsCapability` answers from this array and the providers endpoint
   * publishes it verbatim, so every entry is a promise the product makes to an
   * operator — and one it must be able to keep by calling code that exists.
   *
   * The field carried two meanings for a release, and that is what forced this
   * comment: one provider listed what its adapter did, another listed what its
   * panel could do in a later phase, and the same field on the same endpoint
   * meant different things depending on which row you read. Phase 3 connection
   * adapters therefore expose exactly `HEALTH_CHECK`.
   *
   * **Widening this list is a code and test change, never a declaration.** A
   * capability appears here in the same commit as the operation behind it:
   * implemented, wired into the application, and tested for that provider. The
   * catalogue is then fail-closed by construction — an operation that is not
   * listed cannot be offered, which is the correct failure when the
   * alternative is offering one nothing can perform.
   *
   * If a later phase genuinely needs "what could this panel do in principle" —
   * to plan a migration, or to warn before a downgrade — that is a SEPARATE
   * concept with its own name. This field is not to be overloaded again.
   */
  readonly capabilities: readonly ProviderCapability[];
  /**
   * The most HTTP requests one probe of this provider can make.
   *
   * Scheduling arithmetic, not a protocol fact, and it is here rather than
   * inferred because the number is a property of the adapter's flow and only
   * the adapter's author knows it.
   *
   * The per-panel cooldown is floored on the wall time a probe can occupy, so a
   * second probe cannot start while the first is still on the wire. That floor
   * was computed as one request's budget — `timeout * (1 + retries)` — because
   * `SafeHttpClient` starts its deadline PER REQUEST, and a probe was assumed
   * to be one request. For Marzban it is two: a token exchange and a status
   * read. For 3X-UI's session mode it is four: a CSRF token, a two-factor
   * pre-check, a login and a status read. At the defaults that made the floor
   * ten seconds while a session probe could occupy forty, so a second probe of
   * the same panel could be granted while the first login sequence was still
   * running — against a panel that counts failed logins per address and
   * username, which is the account lockout the cooldown exists to prevent.
   *
   * Count every `send` on the longest path through the adapter. Too high costs
   * a longer minimum cooldown; too low reopens the race above, so round up.
   */
  readonly maxRequestsPerProbe: number;
  /**
   * Fields that must be configured before this provider can build a config at
   * all. 3X-UI needs a subscription-link domain; Marzban does not.
   */
  readonly requiredActivationFields: readonly string[];
}

/**
 * What a customer actually receives. The payload is provider-specific — a
 * subscription link, raw configs, a file, or a credential pair — so the adapter
 * returns a typed delivery object rather than a link string.
 */
export type ServiceDelivery =
  | { readonly kind: 'SUBSCRIPTION_LINK'; readonly url: string }
  | { readonly kind: 'RAW_CONFIGS'; readonly configs: readonly string[] }
  | {
      readonly kind: 'CONFIG_FILE';
      readonly filename: string;
      readonly contentType: string;
      readonly content: Uint8Array;
    }
  | { readonly kind: 'CREDENTIALS'; readonly username: string; readonly secretRef: string }
  | { readonly kind: 'NONE' };

export interface ProviderUsage {
  readonly usedBytes: bigint;
  readonly totalBytes: bigint | null;
  readonly expiresAt: Date | null;
  readonly lastConnectionAt: Date | null;
}

/**
 * The three identities one service has on a panel.
 *
 * All three are STORED on the service row, written before any provider call, and that
 * is the property the whole unknown-outcome design rests on: after a create whose
 * answer was lost, every one of them is already in a row Nexa holds, so the account
 * can be ASKED for by name instead of created again.
 *
 * They used to be derived from the service id instead, which bought the same
 * recoverability and gave it away: two of them were capabilities anybody holding the
 * id could compute (`SUBSCRIPTION_REF_LENGTH`), and the third could not be chosen
 * before the money moved, because the service it was derived from did not exist yet.
 */
export interface ProviderUserRef {
  /**
   * The name this installation gave the account: `services.provider_username`, read
   * from the row, never recomputed. It was chosen or drawn under `service-username.ts`
   * and reserved before the money moved.
   *
   * It may be a name the customer typed, so it is not opaque — but it is canonicalised
   * and bounded to `[a-z0-9_-]{4,20}`, which is what keeps a Telegram display name's
   * Persian characters, emoji and somebody's real name off a third party's panel.
   */
  readonly username: string;
  /**
   * What a subscription URL is built from. Random, and stored on the service row:
   * a capability, never derived from anything a log carries.
   *
   * Separate from the username because the username is visible in an operator's client
   * list and this is a bearer capability for one customer's configuration.
   */
  readonly subscriptionRef: string;
  /**
   * The UUID a panel that keys clients by one uses. Random, and stored beside it.
   *
   * 3X-UI's VLESS client id is this value, and it is what the customer's configuration
   * authenticates with. Derived from its own namespace so that reading any one of these
   * three off a panel screen does not yield the others.
   */
  readonly clientId: string;
}

export interface CreateProviderUserInput extends ProviderUserRef {
  readonly serviceId: ServiceId;
  readonly volumeBytes: bigint | null;
  readonly durationDays: number | null;
  /**
   * The absolute moment this service expires, or null for no limit.
   *
   * Computed ONCE by the caller from the `Clock` port and passed in, rather than
   * derived here from `durationDays`. An adapter that called a clock would compute a
   * different expiry on every retry of the same operation — so a create and the
   * reconcile that adopts it would disagree about when the customer's service ends.
   */
  readonly expiresAt: Date | null;
  readonly deviceLimit: number | null;
}

/**
 * Why a provider call did not succeed — the normalized taxonomy.
 *
 * The whole point is that these are indistinguishable at the call site
 * otherwise. The legacy system renders DNS failure, timeout, authentication
 * rejection and an HTTP 500 identically as `کد خطا : 0`, so an operator cannot
 * tell "you typed the password wrong" from "the machine is off".
 *
 * Each value is produced by the HTTP layer or an adapter, never by a surface,
 * and each maps to exactly one operator remedy:
 *
 *   `AUTHENTICATION_FAILED`  the credentials were rejected — replace them
 *   `AUTHENTICATION_REQUIRES_INTERACTION`
 *                            the credentials are not rejected and cannot be
 *                            used unattended — configure an API token
 *   `UNREACHABLE`            DNS, connection refused, network down — check the host
 *   `TIMEOUT`                it answered too slowly, or not at all in time
 *   `TLS_FAILED`             certificate or handshake — check the certificate
 *   `BLOCKED_TARGET`         the URL resolves somewhere this installation refuses to call
 *   `RATE_LIMITED`           it answered "too many requests" — call it less often
 *   `MALFORMED_RESPONSE`     it answered, and the answer was not what this provider returns
 *   `PROVIDER_ERROR`         it answered with its own failure
 *   `UNSUPPORTED_CAPABILITY` this provider cannot do what was asked
 */
export const PROVIDER_FAILURE_KINDS = [
  'AUTHENTICATION_FAILED',
  /**
   * The panel wants a second factor this installation deliberately cannot
   * supply.
   *
   * Distinct from `AUTHENTICATION_FAILED` because the remedy is different and
   * the wrong remedy is harmful. "The credentials were rejected" sends an
   * operator to retype a password that is very probably correct, and 3X-UI
   * v3.7.0 blocks an IP-and-username pair after enough failed attempts — so
   * conflating the two turns a configuration gap into a lockout. What this
   * says instead is: this panel requires a one-time code, Nexa does not store
   * or generate one, configure an API token for unattended access.
   */
  'AUTHENTICATION_REQUIRES_INTERACTION',
  'UNREACHABLE',
  'TIMEOUT',
  'TLS_FAILED',
  'BLOCKED_TARGET',
  /**
   * The panel said this installation is calling it too often.
   *
   * Folded into `PROVIDER_ERROR` until now, and that conflation is exactly
   * backwards for the one thing an operator needs to do about it. Both are
   * retryable, so both are retried — but `PROVIDER_ERROR` means "the panel is
   * broken, look at the panel", while this means "the panel is fine and WE are
   * the problem". An operator sent to debug a healthy panel changes nothing,
   * the calls continue at the same rate, and several panels escalate from a
   * 429 to a block.
   *
   * It is deliberately not `AUTHENTICATION_FAILED` either, whatever the status
   * code a particular panel chooses: nothing is wrong with the credential, and
   * telling somebody to rotate one is how a rate limit becomes a lockout on a
   * panel that limits logins.
   */
  'RATE_LIMITED',
  'MALFORMED_RESPONSE',
  'PROVIDER_ERROR',
  /**
   * The panel understood the request and REFUSED it, for a reason that will not
   * change by asking again.
   *
   * Split out of `PROVIDER_ERROR`, which is declared retryable and rightly so:
   * a 500 is a panel having a bad moment and the next attempt may well work.
   * This is the opposite statement — the panel is healthy, it read the request,
   * and it says no. An admin's user limit is reached; the service will not
   * accept a subscription this short; the account may only delete expired
   * users. Each is an operator's decision on their own panel, and each will be
   * made again identically at every attempt.
   *
   * It is declared because RickPanel makes the distinction explicit — its
   * `POST /api/user` answers `400` "saying which rule was hit" — and because
   * retrying one is the exact shape of the incident this release is fixing:
   * five attempts, seven minutes, a deterministic refusal each time, and a
   * customer whose money was already taken. An adapter must raise it only when
   * the panel's own answer says the refusal is a RULE rather than a fault; a
   * status code alone is not enough, and where an adapter cannot tell, the
   * retryable kind is the safer mistake.
   *
   * `DEFINITIVE`, and that is load-bearing for a mutating call: the panel
   * answered, so nothing was left in flight and there is no phantom account to
   * reconcile.
   */
  'PROVIDER_REFUSED',
  'UNSUPPORTED_CAPABILITY',
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

/**
 * Whether trying again could plausibly produce a different answer.
 *
 * Not a detail. A deterministic rejection retried on a schedule is a
 * credential-stuffing loop pointed at the operator's own panel, and several
 * panels lock an account after enough of them.
 */
export const PROVIDER_FAILURE_RETRYABLE: Readonly<Record<ProviderFailureKind, boolean>> = {
  AUTHENTICATION_FAILED: false,
  // Retrying cannot conjure a second factor, and each attempt counts against
  // the panel's own login limiter.
  AUTHENTICATION_REQUIRES_INTERACTION: false,
  UNREACHABLE: true,
  TIMEOUT: true,
  TLS_FAILED: false,
  BLOCKED_TARGET: false,
  // Retryable, because the limit is by definition temporary — but the CADENCE
  // is the remedy, not the retry. The monitor names this kind explicitly and
  // waits its LONG interval for it rather than its retryable one: calling a
  // rate limiter back sooner than any other failure is the behaviour it exists
  // to punish. See `baseIntervalMs`.
  RATE_LIMITED: true,
  MALFORMED_RESPONSE: false,
  PROVIDER_ERROR: true,
  // The panel said no and will say no again. Retrying it is a schedule pointed
  // at an operator's own panel that cannot produce a different answer.
  PROVIDER_REFUSED: false,
  UNSUPPORTED_CAPABILITY: false,
};

/**
 * Whether the provider's verdict is KNOWN, as a fact about the wire.
 *
 * A different question from `PROVIDER_FAILURE_RETRYABLE`, and the difference is
 * the one this axis exists for. Retryability encodes a DECISION — "trying again
 * could plausibly help" — and answering it does not require knowing whether the
 * request arrived. Definiteness is a FACT: did the provider answer?
 *
 * Conflating the two is safe while every provider call is a READ. A status probe
 * that may or may not have reached the panel can simply be repeated. It stops
 * being safe the moment a call MUTATES, which is Phase 4: a create-user request
 * that reached the panel and whose response was lost must not be retried, because
 * the retry creates a second user — and `TIMEOUT` is marked retryable.
 *
 * So this is declared now, before the first mutating call exists, rather than
 * after the first duplicate. It has no consumer yet and that is stated rather
 * than hidden: `PROVIDER_FAILURE_RETRYABLE` still drives the probe lane, because
 * a read is correctly governed by retryability alone.
 *
 *   - `DEFINITIVE` — the provider answered, or nothing was sent. Either way this
 *     installation knows what happened on the other side.
 *   - `UNKNOWN` — a request may have been written to the socket and the verdict
 *     lost. Nothing may be blindly retried; the next step is reconciliation.
 *
 * Two kinds are `UNKNOWN` and the reasoning for each is below. The other nine
 * are `DEFINITIVE`, and `BLOCKED_TARGET` is the one worth saying out loud: it is
 * definitive because NOTHING WAS SENT — the URL policy refused before a socket
 * opened — which is a stronger guarantee than an answer.
 */
export const PROVIDER_FAILURE_DEFINITENESS = ['DEFINITIVE', 'UNKNOWN'] as const;
export type ProviderFailureDefiniteness = (typeof PROVIDER_FAILURE_DEFINITENESS)[number];

export const PROVIDER_FAILURE_DEFINITIVE: Readonly<
  Record<ProviderFailureKind, ProviderFailureDefiniteness>
> = {
  // The panel answered, and what it said was no.
  AUTHENTICATION_FAILED: 'DEFINITIVE',
  AUTHENTICATION_REQUIRES_INTERACTION: 'DEFINITIVE',
  /**
   * Overloaded, and therefore UNKNOWN.
   *
   * `UNREACHABLE` covers both "DNS resolved nothing", which is genuinely
   * definitive, and a socket error during the RESPONSE phase — the request was
   * written, the panel may have acted on it, and the answer never arrived.
   * `safe-http.ts` does not record which of the two happened, so the kind cannot
   * distinguish them and the safe reading is the pessimistic one.
   *
   * Narrowing this is a real improvement and it is not a table edit: it needs the
   * client to record whether the request reached the socket. Until it does,
   * calling a lost response definitive would be calling an unknown outcome known,
   * which is the error that duplicates a provider user.
   */
  UNREACHABLE: 'UNKNOWN',
  /**
   * The deadline fired. Whether it fired before or after the request body was
   * written is not recorded, and on a slow panel the second is the likely case.
   */
  TIMEOUT: 'UNKNOWN',
  // The handshake failed, so no request was ever written.
  TLS_FAILED: 'DEFINITIVE',
  // Refused by the URL policy before a socket opened. Nothing was sent at all,
  // which is the strongest form of definitive available.
  BLOCKED_TARGET: 'DEFINITIVE',
  // The panel answered 429, which is an answer.
  RATE_LIMITED: 'DEFINITIVE',
  // The panel answered and the answer could not be parsed. It ANSWERED, so
  // whatever it did, it did before replying — a malformed 200 from a mutating
  // call means the mutation probably happened, and the adapter's job is to say
  // so rather than to retry.
  MALFORMED_RESPONSE: 'DEFINITIVE',
  // A 5xx is an answer. Retryable for a READ; for a mutation an adapter must
  // still decide whether the provider is idempotent on that path.
  PROVIDER_ERROR: 'DEFINITIVE',
  // The panel read the request and refused it by a rule of its own. It
  // answered, and it did nothing — which is the point: a refused create leaves
  // no account behind to reconcile, so a mutating call may treat this as FAILED
  // rather than UNKNOWN and refund at once.
  PROVIDER_REFUSED: 'DEFINITIVE',
  // Refused locally, before anything was sent.
  UNSUPPORTED_CAPABILITY: 'DEFINITIVE',
};

/**
 * Whether this installation's request reached the provider's socket.
 *
 * Carried on a result rather than inferred from a kind, because the kind cannot
 * know: `UNREACHABLE` is returned both for a name that does not resolve and for a
 * connection that dropped mid-response, and only the client that made the call
 * can tell those apart.
 *
 * Declared here so the shape exists before the first mutating call, and so
 * `PROVIDER_FAILURE_DEFINITIVE` has a way to be narrowed by evidence rather than
 * by optimism: a result that reports `requestSent: false` is definitive whatever
 * its kind says.
 *
 *   - `NOT_SENT` — resolution or connection failed before any byte was written.
 *   - `SENT` — the request was written in full; the response is what went wrong.
 *   - `UNRECORDED` — the client did not track it. The honest value for every
 *     result produced today, and the reason this is a three-valued field rather
 *     than a boolean: `false` would be a claim nothing supports.
 */
export const PROVIDER_REQUEST_DELIVERY = ['NOT_SENT', 'SENT', 'UNRECORDED'] as const;
export type ProviderRequestDelivery = (typeof PROVIDER_REQUEST_DELIVERY)[number];

/**
 * What this installation knows about one failed provider call.
 *
 * `kind` is what went wrong, `requestSent` is what reached the wire, and
 * `definiteness` is the verdict the two produce together — derived by
 * `providerFailureDefiniteness` rather than stored, so the two cannot disagree.
 */
export interface ProviderFailureFacts {
  readonly kind: ProviderFailureKind;
  readonly requestSent: ProviderRequestDelivery;
}

/**
 * The verdict for one failure, narrowed by evidence where there is any.
 *
 * `NOT_SENT` makes any kind definitive: if nothing was written, nothing happened
 * on the other side, whatever the error looked like. That is the one direction
 * evidence may narrow in — `SENT` must NOT make a definitive kind unknown, since
 * a 429 is a 429 whether or not the request arrived, and treating an answer as
 * ambiguous would block a retry that is safe.
 */
export function providerFailureDefiniteness(
  facts: ProviderFailureFacts,
): ProviderFailureDefiniteness {
  if (facts.requestSent === 'NOT_SENT') return 'DEFINITIVE';
  return PROVIDER_FAILURE_DEFINITIVE[facts.kind];
}

/**
 * What a connection probe found. The ONLY thing an adapter tells the
 * application about a panel's reachability.
 *
 * Every field here is safe to persist, to log and to show an operator. There is
 * deliberately no free-text `detail` carrying whatever the provider said: that
 * field is where a `WWW-Authenticate` header, a redirect target containing a
 * session id, or an echoed request body ends up. What survives normalization is
 * a kind and — where the provider states one and it is safe — its version.
 *
 * No latency either. The adapter does not own a clock, and an adapter that
 * timed itself would be measuring its own arithmetic as well as the network.
 * The service measures the call and composes the two.
 */
/**
 * The failure arm every provider result shares.
 *
 * One shape across probe, create, lookup and usage, so one classifier reads all of
 * them and `failureOutcome` has exactly one input to interpret. A second, subtly
 * different failure shape per operation is how a taxonomy stops being a taxonomy.
 */
export interface ProviderFailureResult {
  readonly ok: false;
  readonly failure: ProviderFailureKind;
  readonly status: number | null;
}

export type ProviderProbeOutcome =
  | {
      readonly ok: true;
      /**
       * The provider's own version string, when it reports one.
       *
       * Reported for the operator, never branched on: capabilities are declared
       * by the descriptor. A version that decided behaviour would make every
       * provider upgrade a silent change to what this installation believes it
       * can do.
       */
      readonly providerVersion: string | null;
      /**
       * True when authentication succeeded but a follow-up read did not, so the
       * panel is up and configured correctly and something else is wrong.
       */
      readonly degraded: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: ProviderFailureKind;
      /**
       * The upstream HTTP status, when there was one. A number is not a
       * disclosure; the body and the headers would be.
       */
      readonly status: number | null;
    };

/**
 * One outbound request, as an adapter may ask for it.
 *
 * Deliberately not a URL and a fetch: an adapter states a path and a body, and
 * the client it was handed decides what may actually be contacted. `path` is
 * resolved against the panel's base URL BY THE CLIENT, so an adapter cannot
 * reach a different host by returning an absolute URL, and a redirect cannot
 * move it to one.
 */
export interface ProviderHttpRequest {
  /*
   * Four methods, and the list is a closed set rather than `string` for the same
   * reason `path` is not a URL: what an adapter may do is decided here, once.
   *
   * `PUT` and `DELETE` arrived with the management operations — Marzban changes a
   * user's state with `PUT /api/user/{username}` and removes one with `DELETE` —
   * and nothing below the type changed to accept them: `SafeHttpClient` passes the
   * method straight to `node:http`, which has always supported both. What the type
   * still refuses is everything else, so an adapter cannot reach for `PATCH`,
   * `CONNECT` or a method a proxy in front of a panel treats specially without this
   * line, and this file, changing first.
   */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Resolved against the target's base URL. Absolute URLs are refused. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?:
    | { readonly kind: 'json'; readonly value: unknown }
    | { readonly kind: 'form'; readonly value: Readonly<Record<string, string>> };
}

export type ProviderHttpResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      /** Bounded by the client. An adapter never sees more than the cap. */
      readonly bodyText: string;
      /**
       * `Set-Cookie` values, one entry per header, exactly as sent.
       *
       * Separate from `headers` because that map is `Record<string, string>`
       * and `Set-Cookie` is the one header that legitimately repeats. Joining
       * repeated values with a comma — which is what flattening does — is
       * ambiguous for cookies specifically, since an `Expires` attribute
       * contains a comma of its own, so a joined string cannot be split back
       * into the cookies that were actually set.
       *
       * Exposed because a session-authenticating provider cannot work without
       * it, and the alternative was an adapter opening its own socket. Reading
       * a header is not a widening of what an adapter may CONTACT: the client
       * still decides the destination, and nothing here lets a cookie reach an
       * origin the client did not already allow.
       */
      readonly setCookie: readonly string[];
    }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * The only way an adapter can reach the network.
 *
 * An adapter is HANDED one of these, already bound to one panel's base URL,
 * one timeout budget, one response-size cap and the installation's URL policy.
 * It cannot construct one, cannot widen it, and cannot address a different
 * host through it. "Do not let every adapter instantiate an unrestricted HTTP
 * client" is therefore a property of the type rather than a rule somebody has
 * to remember at review time.
 */
export interface ProviderHttpClient {
  send(request: ProviderHttpRequest): Promise<ProviderHttpResult>;
}

/**
 * What a panel's credentials look like once decrypted, at the boundary where an
 * adapter needs them.
 *
 * Passed to the adapter and never returned by it. Nothing in this type is
 * loggable, and nothing constructs one outside the credential resolver.
 */
export type ProviderCredentials =
  | { readonly shape: 'USERNAME_PASSWORD'; readonly username: string; readonly password: string }
  | { readonly shape: 'OPAQUE_TOKEN'; readonly token: string }
  | { readonly shape: 'NONE' };

/**
 * Everything an adapter needs to reach one panel, with no reference to a
 * database row.
 *
 * The adapter is handed values, not a `Panel`. That is what keeps provider code
 * out of the domain: an adapter cannot accidentally read a tenant id, cannot
 * write a row, and cannot be given the wrong panel's credentials by holding on
 * to an entity across a call.
 */
export interface ProviderTarget {
  readonly baseUrl: string;
  readonly credentials: ProviderCredentials;
}

/**
 * A target plus the per-panel configuration the SERVICE half needs.
 *
 * Two types rather than one optional field, because the difference is real: a health
 * probe genuinely does not need to know which inbound a user would be created on, and
 * a create genuinely cannot proceed without it. Splitting them means the service
 * methods cannot be called without activation and `probe` cannot be made to load it —
 * a type doing the work a runtime check would otherwise do badly.
 */
export interface ProviderServiceTarget extends ProviderTarget {
  readonly activation: PanelActivation;
}

/**
 * The connection half of a provider — everything Phase 3 needs and nothing it
 * does not.
 *
 * An adapter implementing this is COMPLETE. `ProviderAdapter` below extends it
 * with the service operations, and arrives when there is a service to operate.
 */
export interface ProviderConnectionAdapter {
  readonly descriptor: ProviderDescriptor;
  supports(capability: ProviderCapability): boolean;
  /**
   * Authenticate, and read whatever the provider states about itself.
   *
   * Never throws for a provider-side outcome: an unreachable host, a rejected
   * password and a malformed body are all RESULTS, because the caller must
   * record each of them differently and an exception forces every caller to
   * re-derive that taxonomy from a message.
   */
  probe(target: ProviderTarget, http: ProviderHttpClient): Promise<ProviderProbeOutcome>;
}

/**
 * What a create attempt produced.
 *
 * A RESULT, never a thrown error, for the same reason `probe` is: an unreachable
 * host, a refused credential and an unparseable body are three different facts that
 * three different pieces of code have to record differently, and an exception forces
 * every caller to re-derive that taxonomy from a message.
 *
 * `providerUserId` is whatever the panel calls this account in its own terms, when it
 * says: Marzban answers with its user record, 3X-UI's client carries the UUID the
 * config is built from. Null is legitimate — some panels key only on the username we
 * chose — and the username remains the identifier reconciliation asks for either way.
 */
export type ProviderUserOutcome =
  | {
      readonly ok: true;
      readonly providerUserId: string | null;
      readonly delivery: ServiceDelivery;
      /** What the panel says the account's limits are NOW, if it said. */
      readonly usage: ProviderUsage | null;
    }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * What a lookup of one provider username established.
 *
 * Three outcomes, and the difference between the second and the third is the whole
 * reason reconciliation is safe. `found: false` is a POSITIVE statement — the panel
 * answered, and it does not have this account — and it is the only thing that makes a
 * fresh create legal after an unknown outcome. `ok: false` is "this installation still
 * does not know", which leaves the service exactly where it was.
 *
 * An adapter must never report `found: false` because a request failed. That collapse
 * is precisely how a timeout becomes a duplicate account.
 */
export type ProviderLookupOutcome =
  | { readonly ok: true; readonly found: false }
  | {
      readonly ok: true;
      readonly found: true;
      readonly providerUserId: string | null;
      readonly delivery: ServiceDelivery;
      readonly usage: ProviderUsage | null;
    }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

export type ProviderUsageOutcome =
  | { readonly ok: true; readonly usage: ProviderUsage }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * What an attempt to change one existing account's state established.
 *
 * `found` carries exactly the meaning it carries on `ProviderLookupOutcome`, and for
 * the same reason: `found: false` is a POSITIVE statement — the panel answered, it is
 * authenticated, and it does not have this account. It is never reported because a
 * request failed. The two are different facts and an installation that collapses them
 * suspends a service it never touched.
 *
 * A panel that does have the account and applied the change answers `found: true`, and
 * carries whatever it said about the account's limits while it was answering. Marzban
 * returns its whole user record from the modify call, so refreshing usage costs nothing;
 * `null` is legitimate for a provider whose change route says less.
 */
export type ProviderStateChangeOutcome =
  | { readonly ok: true; readonly found: true; readonly usage: ProviderUsage | null }
  | { readonly ok: true; readonly found: false }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * What an attempt to delete one account established.
 *
 * `wasPresent: false` is a SUCCESS, and that is the point of having the field rather
 * than a bare boolean: a replayed delete is the normal case after a lost answer, and
 * the second one finds nothing. The goal — this account is not on this panel — holds
 * either way, so the operation succeeds; the flag is what lets the operations record
 * say which of the two happened instead of implying the second one did the work.
 *
 * It is NOT an excuse to report success from a request that failed. Only a panel that
 * answered, authenticated, that it does not have the account may set it.
 */
export type ProviderRemovalOutcome =
  | { readonly ok: true; readonly wasPresent: boolean }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * The full provider surface: the connection half plus the service operations.
 *
 * Every method takes the `target` and the `http` client per call, exactly as `probe`
 * does, so an adapter holds no panel state between calls. That is not style — an
 * adapter that remembered a target could be handed the wrong panel's credentials by
 * outliving a request, and the type is what makes that impossible rather than a rule
 * somebody has to remember.
 *
 * `lookupUser` is on this interface and requires no capability, matching
 * `OPERATION_REQUIRED_CAPABILITIES.RECONCILE` being empty: reading a user is how both
 * adapters already establish health, so a provider that can be probed can be
 * reconciled.
 */
export interface ProviderAdapter extends ProviderConnectionAdapter {
  createUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    input: CreateProviderUserInput,
  ): Promise<ProviderUserOutcome>;
  lookupUser(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderLookupOutcome>;
  readUsage(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderUsageOutcome>;

  /*
   * The three management operations, and they are OPTIONAL — one at a time.
   *
   * Optional because the alternative is worse in both directions. Required methods
   * would force every adapter to grow three implementations the moment one provider
   * has them, and an adapter that cannot really disable a user would have to answer
   * something: a thrown error, a false success, or a refusal invented per adapter. The
   * capability array already exists to say what a provider can do, and this makes the
   * TYPE agree with it rather than compete with it.
   *
   * One at a time, not a bundle, because they are three capabilities in
   * `PROVIDER_CAPABILITIES` and a provider may serve one and not the next. Bundling
   * them would mean a panel that can disable an account but not delete one is either
   * described as doing neither or advertised as doing both — the second being the
   * failure mode this whole array was rewritten to stop.
   *
   * A method present without its capability declared, or a capability declared without
   * its method, is a defect in the adapter and not a state a caller has to handle:
   * `canDisableUser`, `canEnableUser` and `canDeleteUser` below require BOTH, so either
   * half alone reads as "cannot", which is the fail-closed direction.
   */
  suspendUser?(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderStateChangeOutcome>;
  resumeUser?(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderStateChangeOutcome>;
  terminateUser?(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
  ): Promise<ProviderRemovalOutcome>;

  /*
   * The commercial half: make this account's allowance read as the caller says.
   *
   * ONE method for three capabilities, which is the opposite arrangement to the three
   * above, and the difference is real rather than stylistic.
   *
   * `suspendUser`, `resumeUser` and `terminateUser` are three different requests — two
   * statuses and a delete — so three methods describe three things. A renewal, an extra
   * traffic purchase and an extra time purchase are ONE request on the pinned Marzban:
   * a single `PUT /api/user/{username}` carrying an expiry, an allowance, or both, and
   * an omitted key means no change (`scripts/marzban-allowance-check.sh`, row 3). Three
   * methods here would be three copies of one call differing only in which field they
   * left out, and the copy that drifts is the one nobody is looking at.
   *
   * It takes a TARGET rather than an increment, and that is the load-bearing part.
   * `IDEMPOTENT_MUTATIONS` includes `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` only because
   * of it: replaying "make the expiry this instant and the allowance these bytes" is a
   * no-op, and replaying "add thirty days" is a customer receiving sixty.
   *
   * `null` on either field means the caller did not buy it and the adapter must not
   * send it. An adapter that substituted a value it read back would turn a replay into
   * a different request, which is exactly the property the target exists to remove.
   *
   * Which of the three operations an adapter may be asked to perform is still three
   * separate promises, declared in `capabilities` and checked by the three predicates
   * below. A panel that can extend an expiry but not raise a limit declares `ADD_TIME`
   * and not `ADD_VOLUME`, and `decideOperability` refuses the other before anything is
   * dialled.
   */
  applyAllowance?(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    plan: ProviderAllowancePlan,
  ): Promise<ProviderStateChangeOutcome>;

  /**
   * Replace the account's subscription link with a new one the panel mints.
   *
   * `previousUrl` is the link this installation last stored, and it is what lets the
   * method settle its own ambiguity: after the rotation call it reads the account back,
   * and a link DIFFERENT from `previousUrl` is the proof the rotation happened, however
   * the rotation call itself was answered. The same link after an ambiguous answer is
   * the proof it did not, which makes a retry a first attempt rather than a second.
   * `docs/rickpanel-rotate-audit.md` D4 is the full table.
   *
   * The new link is taken from the READ, never from the rotation response, and a
   * rotation that answered 2xx while the link stayed the same is refused rather than
   * reported: a customer told they have a new link must actually have one.
   *
   * Optional, and gated by `canRotateSubscription`, which requires the method AND the
   * `ROTATE_SUBSCRIPTION_LINK` capability — the same pairing as every other optional
   * operation here.
   */
  rotateSubscription?(
    target: ProviderServiceTarget,
    http: ProviderHttpClient,
    ref: ProviderUserRef,
    previousUrl: string | null,
  ): Promise<ProviderRotationOutcome>;
}

/**
 * What a rotation produced.
 *
 * `found: false` is the panel saying it does not hold the account, as for the other
 * management calls. The link on success is a bearer capability: it goes to the
 * service row and the delivery lane, and never into a log, an audit row or an event.
 */
export type ProviderRotationOutcome =
  | { readonly ok: true; readonly found: true; readonly subscriptionUrl: string }
  | { readonly ok: true; readonly found: false }
  | { readonly ok: false; readonly failure: ProviderFailureKind; readonly status: number | null };

/**
 * The absolute state a commercial operation asks a provider to make true.
 *
 * Structurally `OperationTarget` from `provisioning.ts`, restated here because
 * `provider.ts` describes a wire contract and must not depend on the operation
 * vocabulary that happens to drive it — the same separation `ProviderUserRef` keeps
 * from `services`. The executor converts.
 *
 * `expiresAt` is an instant, not a duration. `trafficLimitBytes` is the TOTAL
 * allowance including whatever has already been consumed, not a delta: the pinned
 * Marzban keeps `used_traffic` when a limit is raised and compares the two to decide
 * whether the account is `limited`, so a number that excluded consumption would cut a
 * customer off at exactly the point they had already reached.
 *
 * `null` means the caller did not buy that field, and it is NOT "unlimited" —
 * unlimited traffic is zero, the sentinel the whole codebase already uses.
 */
export interface ProviderAllowancePlan {
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint | null;
}

/** An adapter narrowed to one it is safe to call `suspendUser` on. */
export type CanDisableUser = ProviderAdapter & Pick<Required<ProviderAdapter>, 'suspendUser'>;
/** An adapter narrowed to one it is safe to call `resumeUser` on. */
export type CanEnableUser = ProviderAdapter & Pick<Required<ProviderAdapter>, 'resumeUser'>;
/** An adapter narrowed to one it is safe to call `terminateUser` on. */
export type CanDeleteUser = ProviderAdapter & Pick<Required<ProviderAdapter>, 'terminateUser'>;

/*
 * Each of these asks TWO questions and requires both answers, and the pairing is the
 * whole mechanism.
 *
 * `typeof … === 'function'` alone would let an adapter be called for an operation its
 * descriptor does not advertise, so the providers endpoint and the customer's buttons
 * would disagree with what the executor actually does. `supports(…)` alone would let a
 * descriptor edit make the executor call a method that is not there — a TypeError
 * inside a claimed operation, which is the one failure shape this module's outcome
 * types exist to keep out of provider code.
 */
export function canDisableUser(adapter: ProviderAdapter): adapter is CanDisableUser {
  return typeof adapter.suspendUser === 'function' && adapter.supports('DISABLE_USER');
}

export function canEnableUser(adapter: ProviderAdapter): adapter is CanEnableUser {
  return typeof adapter.resumeUser === 'function' && adapter.supports('ENABLE_USER');
}

export function canDeleteUser(adapter: ProviderAdapter): adapter is CanDeleteUser {
  return typeof adapter.terminateUser === 'function' && adapter.supports('DELETE_USER');
}

/** An adapter narrowed to one it is safe to call `rotateSubscription` on. */
export type CanRotateSubscription = ProviderAdapter &
  Pick<Required<ProviderAdapter>, 'rotateSubscription'>;

export function canRotateSubscription(adapter: ProviderAdapter): adapter is CanRotateSubscription {
  return (
    typeof adapter.rotateSubscription === 'function' && adapter.supports('ROTATE_SUBSCRIPTION_LINK')
  );
}

/** An adapter narrowed to one it is safe to call `applyAllowance` on. */
export type CanApplyAllowance = ProviderAdapter & Pick<Required<ProviderAdapter>, 'applyAllowance'>;

/*
 * Three predicates over ONE method, and each asks its own capability.
 *
 * The method is shared because the request is; the promises are separate because a
 * panel may extend a window and refuse to raise an allowance, or price the two
 * differently, or implement one and not the other. Collapsing them into a single
 * `canApplyAllowance` would advertise all three the moment a provider could do any —
 * the failure mode the capability array was rewritten to stop.
 */
export function canRenewUser(adapter: ProviderAdapter): adapter is CanApplyAllowance {
  return typeof adapter.applyAllowance === 'function' && adapter.supports('RENEW_USER');
}

export function canAddVolume(adapter: ProviderAdapter): adapter is CanApplyAllowance {
  return typeof adapter.applyAllowance === 'function' && adapter.supports('ADD_VOLUME');
}

export function canAddTime(adapter: ProviderAdapter): adapter is CanApplyAllowance {
  return typeof adapter.applyAllowance === 'function' && adapter.supports('ADD_TIME');
}

/** Whether this adapter implements the service half, not just the connection half. */
export function isServiceAdapter(adapter: ProviderConnectionAdapter): adapter is ProviderAdapter {
  const candidate = adapter as Partial<ProviderAdapter>;
  return (
    typeof candidate.createUser === 'function' &&
    typeof candidate.lookupUser === 'function' &&
    typeof candidate.readUsage === 'function'
  );
}

export function supportsCapability(
  descriptor: ProviderDescriptor,
  capability: ProviderCapability,
): boolean {
  return descriptor.capabilities.includes(capability);
}

/**
 * Marzban.
 *
 * Username and password, exchanged for a bearer token at `/api/admin/token`.
 * The token is ephemeral and is never stored: it lives for one probe and is
 * discarded, so there is no third credential to rotate and nothing to leak from
 * a database dump.
 *
 * **Capabilities are exactly `HEALTH_CHECK`**, because that is what this
 * release can execute for Marzban: the adapter implements
 * `ProviderConnectionAdapter` and nothing else. It previously declared the
 * fourteen operations a Marzban-compatible panel serves — creating users,
 * reading usage, delivering configuration files — on the reasoning that
 * declaring them now would let Phase 4 add the flows without touching this
 * contract. That reasoning is rejected: the endpoint publishing this array is
 * how the product tells an operator what it can do, so the array was
 * advertising operations no code could perform. Each returns in the commit
 * that implements it.
 */
const MARZBAN: ProviderDescriptor = {
  key: 'marzban',
  canonicalName: 'Marzban',
  credentialShape: 'USERNAME_PASSWORD',
  /*
   * Seven, and each one is executed by code in `marzban.adapter.ts` that has been
   * RUN against a panel.
   *
   * `DELIVER_SUBSCRIPTION_LINK` because `createUser` returns Marzban's own
   * `subscription_url` made absolute. `READ_USAGE` because `readUsage` reads
   * `used_traffic` back.
   *
   * `DISABLE_USER`, `ENABLE_USER` and `DELETE_USER` joined them only after
   * `tests/acceptance/real-panel-marzban.test.ts` drove the shipped adapter against
   * a real v0.8.4 and watched one account stop serving while its sibling kept
   * serving, watched it start again, and watched one account be deleted while the
   * sibling survived. That ordering — implement, prove, then advertise — is the
   * owner's, and it is why the three were absent from the commit that wrote the
   * methods: this array is what tells an operator what the product can do, and a
   * promise made before the evidence exists is the kind this array's history is
   * made of.
   *
   * `RENEW_USER`, `ADD_VOLUME` and `ADD_TIME` joined them in Phase 4F, and under the
   * same rule again: `applyAllowance` was written, then
   * `tests/acceptance/real-panel-marzban.test.ts` A8 drove the shipped adapter against
   * a real v0.8.4 and an independent observer watched one account's expiry and
   * allowance become exactly what was asked for while its sibling's stayed where they
   * were, watched the same plan replayed leave both numbers alone, watched an omitted
   * field mean no change rather than a reset, and watched a username shaped like a path
   * fail to reach the sibling. Three capabilities rather than one because they are
   * three promises — a panel may extend a window and refuse to raise a limit — even
   * though one method performs all three, which is what the pinned panel's single
   * modify route makes true.
   *
   * The other six are absent because this release cannot perform them — rotating a
   * link, resetting usage, limiting devices — and each returns in the commit that
   * implements it, per that same rule.
   */
  capabilities: [
    'HEALTH_CHECK',
    'CREATE_USER',
    'READ_USAGE',
    'DELIVER_SUBSCRIPTION_LINK',
    'DISABLE_USER',
    'ENABLE_USER',
    'DELETE_USER',
    'RENEW_USER',
    'ADD_VOLUME',
    'ADD_TIME',
  ],
  // A token exchange, then a status read.
  maxRequestsPerProbe: 2,
  /*
   * Which proxy protocols a created user gets, and which inbounds each one uses.
   *
   * Empty until Phase 4D, on the reasoning that Marzban needs no configuration to be
   * PROBED — which is true, and was the wrong question. Marzban requires at least one
   * proxy protocol to create a user, and there is no safe default: choosing one is
   * choosing what a customer's client speaks.
   *
   * `inboundTags` joined it once a real panel showed that omitting it does not mean
   * "every inbound" but "no inbound" — a create that answers 200 and delivers a
   * zero-byte subscription. Choosing an inbound is choosing which server a customer
   * reaches, so it has no default either.
   */
  requiredActivationFields: ['proxyProtocols', 'inboundTags'],
};

/**
 * RickPanel.
 *
 * A Marzban-DERIVED panel, and the derivation is what makes it dangerous: it
 * speaks `POST /api/admin/token`, `POST /api/user` and
 * `GET /api/user/{username}` on the same paths, with the same bearer scheme and
 * several of Marzban v0.8.4's own field names — `data_limit_reset_strategy`,
 * `on_hold_expire_duration`, `sub_updated_at`. A panel that answers the same
 * routes reads as the same product, which is exactly how the production
 * deployment came to register one as `marzban`, and how the legacy system did
 * too: the corpus's own test panel is labelled `TEST_MARZBAN_RICKPANEL`.
 *
 * It is not the same product. `docs/rickpanel-adapter-audit.md` has the full
 * comparison; three differences are why this is a separate type rather than a
 * flag on the other one:
 *
 *   1. **Activation is meaningless here.** RickPanel documents that `inbounds`
 *      and a partial `proxies` set "are accepted but ignored: every user gets
 *      every protocol and every inbound". Marzban's rule — name your inbounds or
 *      deliver zero bytes — is the opposite fact about the opposite panel.
 *      `requiredActivationFields` is therefore empty, and that emptiness is
 *      measured against the contract rather than assumed for convenience.
 *   2. **A create returns before the nodes have the user.** The adapter reads
 *      the user back before reporting a delivery, because a 200 here proves
 *      acceptance and nothing about existence.
 *   3. **400 is a deterministic refusal**, carrying an admin's user limit or a
 *      service rule, where Marzban's equivalent is a 422 about a status value.
 *
 * **On the capabilities below.** They are declared without a real-panel
 * acceptance, which is a deliberate and recorded deviation from this
 * repository's declare-after-acceptance rule — see
 * `docs/rickpanel-adapter-audit.md` §4. Declaring nothing would leave every
 * RickPanel unsellable and the production incident unfixed;
 * `tests/acceptance/real-panel-rickpanel.test.ts` is what turns the promise into
 * evidence, and it has not been run.
 *
 * `ROTATE_SUBSCRIPTION_LINK` is declared on different and stronger ground: the
 * owner's direct calls to a correctly connected panel showed `revoke_sub` changing
 * the link and the token and nothing else, and the adapter method that performs it
 * proves every rotation by reading the new link back
 * (`docs/rickpanel-rotate-audit.md`). What was NOT shown — that the old link stops
 * working — is claimed nowhere. `RESET_USAGE` stays undeclared: the route exists,
 * and what it resets has not been measured.
 */
const RICKPANEL: ProviderDescriptor = {
  key: 'rickpanel',
  canonicalName: 'RickPanel',
  /*
   * An admin username and password, exchanged for a bearer JWT at
   * `POST /api/admin/token`. The same shape as Marzban's and for the same
   * reason: the token is ephemeral, lives for one exchange and is never stored,
   * so there is no third credential to rotate.
   */
  credentialShape: 'USERNAME_PASSWORD',
  capabilities: [
    'HEALTH_CHECK',
    'CREATE_USER',
    'READ_USAGE',
    'DELIVER_SUBSCRIPTION_LINK',
    'DISABLE_USER',
    'ENABLE_USER',
    'DELETE_USER',
    'RENEW_USER',
    'ADD_VOLUME',
    'ADD_TIME',
    'ROTATE_SUBSCRIPTION_LINK',
  ],
  // A token exchange, then a status read. The create path's read-back is not a
  // probe and is budgeted by the operation, not by this number.
  maxRequestsPerProbe: 2,
  /*
   * EMPTY, and this is the field the hotfix turns on.
   *
   * `decideEligibility` refuses a sale when a panel's activation does not parse,
   * so a RickPanel registered as `marzban` would need two fields configured that
   * RickPanel throws away — a fiction an operator would have to invent to make
   * their own panel sellable. Under its own type there is nothing to configure,
   * which is the truth about this panel, and a `rickpanel` panel with working
   * credentials and a successful connection test is sellable immediately.
   */
  requiredActivationFields: [],
};

/**
 * Sanaei / 3X-UI.
 *
 * TWO authentication modes, and that is a fact from the source rather than an
 * accommodation: MHSanaei/3x-ui v3.7.0 (`f727d04f6522bb94a8fb52e8352fdcafb51c11e1`)
 * authenticates `/panel/api/*` with EITHER a scoped Bearer API token or a
 * browser-style session cookie obtained by logging in. `checkAPIAuth` in
 * `internal/web/controller/api.go` accepts both, so a descriptor naming only
 * one would be describing a panel that does not exist.
 *
 * Phase 3B resolves them in a fixed order — a configured API token is used as
 * a token and is never silently replaced by the password — and the resolver,
 * not the adapter, is where that happens.
 *
 * `UNK-XUI-010` is CLOSED by this, and it is worth saying how, because the
 * corpus could not close it: the research recorded that the legacy bot
 * collected one opaque `توکن` field and stored it in its password column with
 * the username left null (WEB-BR-007), which is a UI-layer shape and not a
 * protocol fact. The upstream source settles it, and the deterministic fake
 * server in this repository reproduces the wire contract it establishes.
 *
 * The subscription-link domain still has to be configured separately, because
 * the panel does not derive it from its own address. That is Phase 4's
 * business; it is declared here so the seam stays visible.
 *
 * **Capabilities are exactly `HEALTH_CHECK`**, on the same rule as every other
 * provider: this release implements authentication, connection testing and a
 * read-only health probe for 3X-UI, and declaring more would advertise
 * operations no code can perform.
 */
const SANAEI: ProviderDescriptor = {
  key: 'sanaei',
  canonicalName: 'Sanaei (3X-UI)',
  credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
  /*
   * The same rule as Marzban's list: each is executed by code in `sanaei.adapter.ts`.
   *
   * `LIMIT_DEVICES` is here because `createUser` has always written `limitIp` from the
   * order's frozen `deviceLimit` — the capability was simply never declared. That made
   * the descriptor understate the adapter, which is the less dangerous direction of the
   * two but still a lie a surface reads: anything asking "can this panel limit devices"
   * was told no about a panel that does.
   */
  capabilities: [
    'HEALTH_CHECK',
    'CREATE_USER',
    'READ_USAGE',
    'DELIVER_SUBSCRIPTION_LINK',
    'LIMIT_DEVICES',
  ],
  // The SESSION path, which is the longest: CSRF token, two-factor pre-check,
  // login, status read. The bearer path is one request; the floor takes the
  // worst case, because a panel configured with a password takes that path and
  // the cooldown is set once for the provider.
  maxRequestsPerProbe: 4,
  requiredActivationFields: ['subscriptionDomain', 'inboundId'],
};

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [MARZBAN, RICKPANEL, SANAEI];

/**
 * The most requests any registered provider's probe can make.
 *
 * Derived, never restated. The per-panel cooldown is one number for the whole
 * installation — it is configuration, not per-provider — so it has to be floored
 * on the worst case across every provider, and a hand-written constant here
 * would be a second copy that a new adapter silently falsifies.
 */
export const MAX_REQUESTS_PER_PROBE: number = PROVIDER_DESCRIPTORS.reduce(
  (most, descriptor) => Math.max(most, descriptor.maxRequestsPerProbe),
  1,
);

const DESCRIPTOR_BY_KEY = new Map<ProviderType, ProviderDescriptor>(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

/**
 * The descriptor for a provider type.
 *
 * Total over `ProviderType` by construction — the map is built from the same
 * frozen list the type is derived from, and a unit test proves every type has
 * one. It returns `null` rather than throwing so that the one caller that
 * legitimately holds an unvalidated string (a row read from the database) can
 * decide what an unknown value means there.
 */
export function providerDescriptor(key: string): ProviderDescriptor | null {
  return isProviderType(key) ? (DESCRIPTOR_BY_KEY.get(key) ?? null) : null;
}
