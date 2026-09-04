import type { ServiceId } from './ids.js';

/**
 * The provider adapter contract.
 *
 * Every panel type is an adapter implementing this interface and DECLARING its
 * capabilities as data. Capabilities are never inferred from a version string,
 * and no code outside the adapter registry branches on provider type.
 *
 * The evidence says the differences are of kind, not degree: 3X-UI carries a
 * single opaque token where Marzban has a username and password, and requires a
 * separately configured subscription-link domain because its sub URL is not
 * derived from the panel address. A manual-sale provider has no backend at all.
 * An interface validated against one implementation is not an interface.
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
export const PROVIDER_TYPES = ['marzban', 'sanaei'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export function isProviderType(value: string): value is ProviderType {
  return (PROVIDER_TYPES as readonly string[]).includes(value);
}

/**
 * Static description of a provider type. Display names come from the template
 * catalog; `key` is the stable identifier and is never a display string.
 */
export interface ProviderDescriptor {
  readonly key: ProviderType;
  readonly canonicalName: string;
  readonly credentialShape: CredentialShape;
  readonly capabilities: readonly ProviderCapability[];
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

export interface CreateProviderUserInput {
  /**
   * Deterministic, derived from stable order identifiers, so that a retry after
   * a timeout converges on one remote user instead of creating a second.
   * It is opaque and carries no Telegram id.
   */
  readonly username: string;
  readonly serviceId: ServiceId;
  readonly volumeBytes: bigint | null;
  readonly durationDays: number | null;
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
  'MALFORMED_RESPONSE',
  'PROVIDER_ERROR',
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
  MALFORMED_RESPONSE: false,
  PROVIDER_ERROR: true,
  UNSUPPORTED_CAPABILITY: false,
};

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
  readonly method: 'GET' | 'POST';
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

/** The full provider surface. Phase 4 territory; declared so the seam is visible. */
export interface ProviderAdapter extends ProviderConnectionAdapter {
  createUser(input: CreateProviderUserInput): Promise<ServiceDelivery>;
  readUsage(username: string): Promise<ProviderUsage>;
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
 * `DELIVER_CONFIG_FILE` is declared because Marzban-compatible panels serve
 * per-user configuration files; the flow that delivers them is Phase 4, and
 * declaring the capability now is what lets Phase 4 add it without touching
 * this contract.
 */
const MARZBAN: ProviderDescriptor = {
  key: 'marzban',
  canonicalName: 'Marzban',
  credentialShape: 'USERNAME_PASSWORD',
  capabilities: [
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
    'HEALTH_CHECK',
  ],
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
 * **Capabilities are what this release can DO, not what the panel could do.**
 *
 * Phase 3B implements authentication, connection testing and a read-only
 * health probe, so `HEALTH_CHECK` is the list. It previously carried the
 * fourteen operations 3X-UI supports in principle — creating users, resetting
 * traffic, delivering subscriptions — and none of them exists for this
 * provider. That was not a harmless aspiration: `supports()` answers from this
 * array and the providers endpoint publishes it verbatim, so the release was
 * telling operators it could create a 3X-UI user. Each entry returns when the
 * operation behind it is implemented and tested, in the phase that implements
 * it, and not before.
 *
 * This leaves the catalogue INCONSISTENT with Marzban, which still declares
 * fourteen capabilities while implementing only the same connection half.
 * Marzban is deliberately untouched here — correcting it is not this narrow
 * fix's business, and doing it silently would change another provider's
 * published surface — but the two now mean different things, and the one that
 * is wrong is Marzban's. It is recorded in `docs/providers/sanaei-3xui.md`.
 */
const SANAEI: ProviderDescriptor = {
  key: 'sanaei',
  canonicalName: 'Sanaei (3X-UI)',
  credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
  capabilities: ['HEALTH_CHECK'],
  requiredActivationFields: ['subscriptionDomain'],
};

export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [MARZBAN, SANAEI];

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
