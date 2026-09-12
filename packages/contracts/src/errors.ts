/**
 * The error taxonomy.
 *
 * Every failure carries a stable machine code. Both the Telegram surface and
 * the HTTP surface map from these codes, so one failure reads the same way in
 * both places — which is precisely what the legacy system's `کد خطا : 0`
 * (indistinguishable DNS, timeout, auth and HTTP failures) does not do.
 *
 * `catch {}` fails the build. A caught error is either handled or rethrown as
 * a typed error from this taxonomy.
 */

export const ERROR_KINDS = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'PERMISSION_DENIED',
  'UNAUTHENTICATED',
  'PRECONDITION_FAILED',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_REJECTED',
  'TIMEOUT',
  'CONFIGURATION',
  'INTERNAL',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** HTTP status per kind. Surfaces map from the kind, never from the message. */
export const ERROR_KIND_HTTP_STATUS: Readonly<Record<ErrorKind, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION_DENIED: 403,
  UNAUTHENTICATED: 401,
  PRECONDITION_FAILED: 412,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_REJECTED: 502,
  TIMEOUT: 504,
  CONFIGURATION: 500,
  INTERNAL: 500,
};

export interface NexaErrorOptions {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly message: string;
  /** Structured, non-sensitive context. Never put a credential here. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** True when a retry with the same input could plausibly succeed. */
  readonly retryable?: boolean;
}

export class NexaError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(options: NexaErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'NexaError';
    this.kind = options.kind;
    this.code = options.code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(options.kind);
  }

  get httpStatus(): number {
    return ERROR_KIND_HTTP_STATUS[this.kind];
  }

  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      code: this.code,
      message: this.message,
      details: this.details,
      retryable: this.retryable,
    };
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorKind>(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'TIMEOUT']);

export function isNexaError(value: unknown): value is NexaError {
  return value instanceof NexaError;
}

/** Frequently used constructors, so call sites stay short and codes stay stable. */
export const errors = {
  validation: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'VALIDATION', code, message, ...(details ? { details } : {}) }),
  notFound: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'NOT_FOUND', code, message, ...(details ? { details } : {}) }),
  conflict: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'CONFLICT', code, message, ...(details ? { details } : {}) }),
  permissionDenied: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'PERMISSION_DENIED', code, message, ...(details ? { details } : {}) }),
  unauthenticated: (code: string, message: string) =>
    new NexaError({ kind: 'UNAUTHENTICATED', code, message }),
  /**
   * The request is well-formed and the thing it asks for is not currently
   * possible — an archived panel being edited, say. Distinct from CONFLICT,
   * which means somebody else changed the state underneath you: retrying a
   * conflict after re-reading can succeed, while retrying this cannot until
   * the precondition itself is changed.
   */
  preconditionFailed: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'PRECONDITION_FAILED', code, message, ...(details ? { details } : {}) }),
  configuration: (code: string, message: string, details?: Record<string, unknown>) =>
    new NexaError({ kind: 'CONFIGURATION', code, message, ...(details ? { details } : {}) }),
  internal: (code: string, message: string, cause?: unknown) =>
    new NexaError({ kind: 'INTERNAL', code, message, ...(cause !== undefined ? { cause } : {}) }),
} as const;

/** Codes emitted by the Phase 0 foundation itself. */
export const PLATFORM_ERROR_CODES = {
  TENANT_CONTEXT_MISSING: 'platform.tenant_context_missing',
  TENANT_NOT_FOUND: 'platform.tenant_not_found',
  PERMISSION_DENIED: 'platform.permission_denied',
  IDEMPOTENCY_PAYLOAD_MISMATCH: 'platform.idempotency_payload_mismatch',
  /** Another request holding the same idempotency key committed first. */
  IDEMPOTENCY_IN_FLIGHT: 'platform.idempotency_in_flight',
  UNKNOWN_EVENT_TYPE: 'platform.unknown_event_type',
  CONFIG_INVALID: 'platform.config_invalid',
  /**
   * Authenticated decryption failed. ONE code for every cause.
   *
   * A wrong tenant, a wrong row, a wrong purpose, a flipped ciphertext bit and
   * an edited authentication tag are indistinguishable at the cryptographic
   * boundary, and they must stay that way: a code that said WHICH
   * authenticated field was wrong would be an oracle an attacker could query
   * one field at a time. The audit trail records the attempt; the caller is
   * told only that it failed.
   */
  SECRET_AUTH_FAILED: 'platform.secret_auth_failed',
  /** The envelope names a key this installation does not hold. */
  SECRET_KEY_UNKNOWN: 'platform.secret_key_unknown',
  /** The envelope version is not one this release can read. */
  SECRET_VERSION_UNSUPPORTED: 'platform.secret_version_unsupported',
  /**
   * The stored key id disagrees with the key id inside the envelope.
   *
   * Distinct from an authentication failure because it is not a cryptographic
   * outcome — it is a bookkeeping contradiction, and it matters operationally:
   * key retirement counts dependencies using the COLUMN, so a row whose column
   * lies could let a key be retired while a ciphertext still needs it.
   */
  SECRET_KEY_ID_MISMATCH: 'platform.secret_key_id_mismatch',
  TELEGRAM_BAD_SECRET_TOKEN: 'telegram.bad_secret_token',

  /**
   * A backup archive failed authenticated decryption. ONE code, as above.
   *
   * Same argument as `SECRET_AUTH_FAILED`, and it needs restating because an
   * archive is a file somebody can hold: a wrong key, a modified byte, a
   * truncated download and an edited header are indistinguishable at the AEAD
   * boundary and must stay that way. A code that named which of the four had
   * failed would let whoever holds the archive tell how close their guess was.
   */
  BACKUP_ARCHIVE_AUTH_FAILED: 'backup.archive_auth_failed',
  /**
   * The archive is not readable AS AN ARCHIVE: wrong magic, an implausible
   * length, a future format version, a header that is not JSON.
   *
   * Deliberately NOT an authentication failure. Nothing has been decrypted at
   * this point and nothing has been trusted; a restore tool needs to be able to
   * say "this is not a Nexa backup" without implying it tried a key against it.
   */
  BACKUP_ARCHIVE_MALFORMED: 'backup.archive_malformed',
  /**
   * The archive decrypted, and the bytes that came out are not the bytes that
   * went in.
   *
   * Distinct from an authentication failure because it means something on OUR
   * side of the AEAD is wrong — the tag verified, so the ciphertext is intact.
   * It is also the check that stays meaningful years later, when the only thing
   * anyone has is a file and a manifest.
   */
  BACKUP_CHECKSUM_MISMATCH: 'backup.checksum_mismatch',
  /**
   * A real `pg_restore` into a real empty database did not produce a database.
   *
   * The stage that makes this a backup rather than a file. A run that reaches
   * it and fails deletes its archive rather than delivering it: an archive
   * nobody can restore is worse than none, because its existence stops somebody
   * looking for a real one.
   */
  BACKUP_VERIFICATION_FAILED: 'backup.verification_failed',
  /** `pg_dump`, `pg_restore` or `psql` could not be run, or did not succeed. */
  BACKUP_TOOL_FAILED: 'backup.tool_failed',
  /**
   * A restore was aimed at the database this installation is running on.
   *
   * The one refusal here that exists to prevent a catastrophe rather than to
   * report one. A restore overwrites; there is no default target, and the live
   * one is refused even when named explicitly.
   */
  BACKUP_UNSAFE_RESTORE_TARGET: 'backup.unsafe_restore_target',
  /** A run finished and its own row could not be read back. */
  BACKUP_RUN_MISSING: 'backup.run_missing',
  /**
   * A backup could not take the installation's lock.
   *
   * NOT the ordinary busy answer — that is a return value, because one backup
   * at a time is the invariant working rather than a failure. This is the
   * narrow race where the holder released the lock between our INSERT losing
   * and our reading who won, so there is no holder to name and inventing one
   * would be worse than saying so.
   */
  BACKUP_ALREADY_RUNNING: 'backup.already_running',

  /**
   * A recovery refused something, and the response says only which class.
   *
   * ONE code at the HTTP boundary, with the specific `RECOVERY_FAILURE_CODES`
   * value on the recovery ROW where an authenticated operator reads it beside
   * the request it belongs to. The split matters because these endpoints are the
   * ones somebody probes: a distinct HTTP code per cause would let a caller
   * holding an archive learn, one request at a time, whether it was the key, the
   * format or the checksum that stopped them — which is the oracle
   * `BACKUP_ARCHIVE_AUTH_FAILED` exists to avoid, rebuilt at a different layer.
   */
  RECOVERY_REFUSED: 'recovery.refused',
  /**
   * A destructive recovery already holds the installation.
   *
   * A CONFLICT, not a validation error: the caller did nothing wrong, and one
   * destructive recovery at a time is the invariant working rather than a
   * failure. Raised from the partial unique index, so it is true across
   * processes and replicas.
   */
  RECOVERY_ALREADY_ACTIVE: 'recovery.already_active',
  /**
   * The installation is refusing new durable writes while a recovery runs.
   *
   * Deliberately distinguishable from a stopped tenant. An operator who saw
   * "this tenant is not accepting work" during a restore would go and look at
   * the tenant, which is the one place the answer is not.
   */
  RECOVERY_QUIESCED: 'recovery.quiesced',
  /**
   * The typed confirmation is missing, wrong, expired, for another artifact, or
   * has already been spent.
   *
   * One code for all five. The differences are useful to an operator reading
   * their own recovery row, and to nobody else.
   */
  RECOVERY_CONFIRMATION_INVALID: 'recovery.confirmation_invalid',
} as const;

/**
 * Codes emitted by identity, authentication and authorization.
 *
 * `AUTH_INVALID_CREDENTIALS` is deliberately the ONLY code a failed login can
 * produce. Unknown username, wrong password and disabled account all map to it,
 * so the response is not an account oracle; the audit row records which it was.
 */
export const IDENTITY_ERROR_CODES = {
  AUTH_INVALID_CREDENTIALS: 'auth.invalid_credentials',
  AUTH_RATE_LIMITED: 'auth.rate_limited',
  // One code for every way a session fails to authenticate: unknown, revoked,
  // expired. `auth.session_expired` used to sit here beside it and was emitted
  // by nothing — which was the only thing keeping it honest, because telling a
  // caller a session EXPIRED tells them it existed, and this block's whole
  // point is that the response is not an account oracle.
  AUTH_SESSION_INVALID: 'auth.session_invalid',
  /**
   * The session is fine; the INSTALLATION is paused.
   *
   * Distinct from `auth.session_invalid` because the two call for opposite
   * responses from a client: an invalid session means sign in again, a stopped
   * tenant means wait. Collapsing them showed an operator holding a perfectly
   * good cookie a sign-in form during every maintenance window, and invited
   * them to authenticate their way out of something authentication cannot fix.
   *
   * Not an oracle: it is only ever returned to a caller who already presented a
   * valid session, and it discloses that an installation they can already reach
   * is paused. The LOGIN path stays generic, and still reports this as the one
   * indistinguishable credential failure.
   */
  AUTH_TENANT_SUSPENDED: 'auth.tenant_suspended',
  AUTH_REQUIRED: 'auth.required',
  AUTH_ORIGIN_REJECTED: 'auth.origin_rejected',
  ADMIN_NOT_FOUND: 'admin.not_found',
  ADMIN_USERNAME_TAKEN: 'admin.username_taken',
  ADMIN_TELEGRAM_ID_TAKEN: 'admin.telegram_id_taken',
  ADMIN_SELF_MODIFICATION: 'admin.self_modification_denied',
  ADMIN_LAST_OWNER: 'admin.last_owner_protected',
  ADMIN_PRIVILEGE_ESCALATION: 'admin.privilege_escalation_denied',
  ADMIN_PASSWORD_REUSED: 'admin.password_reused',
  ADMIN_PASSWORD_STALE: 'admin.password_stale',
  ROLE_NOT_FOUND: 'role.not_found',
  BOOTSTRAP_ALREADY_DONE: 'bootstrap.already_completed',
} as const;

/**
 * Codes emitted by the control plane — templates, settings, feature flags,
 * notifications and the operational-event surface.
 *
 * `VERSION_CONFLICT` is the one worth reading twice. It is returned when a write
 * carried an expectation about the row it was replacing and the row had already
 * moved. It is NOT an error the client should retry blindly: the change was
 * built on state that is now stale, so the correct response is to re-read and
 * decide again. The legacy alternative is that the second save silently
 * discards the first, with nothing anywhere to notice it by.
 */
export const CONTROL_ERROR_CODES = {
  UNKNOWN_KEY: 'control.unknown_key',
  INVALID_VALUE: 'control.invalid_value',
  VERSION_CONFLICT: 'control.version_conflict',
  /** A template body that would ship a broken message to customers. */
  TEMPLATE_INVALID: 'control.template_invalid',
  /** A revert with nothing to revert: this tenant has no override of the key. */
  TEMPLATE_NOT_OVERRIDDEN: 'control.template_not_overridden',
  /** A TENANT_WIDE flag toggled without the confirmation the protocol requires. */
  CONFIRMATION_REQUIRED: 'control.confirmation_required',
  /** A notification asked for with no destination configured. */
  DESTINATION_NOT_CONFIGURED: 'control.destination_not_configured',
  NOTIFICATION_NOT_FOUND: 'control.notification_not_found',
  /**
   * An idempotency record names a notification that no longer exists.
   *
   * Distinct from NOT_FOUND on purpose. That one answers "no such notification
   * in this tenant" to somebody who asked for one; this one says a COMPLETED
   * command's record points at nothing, which is a corrupt store rather than a
   * bad request, and a client that could not tell them apart would retry the
   * one that cannot succeed.
   */
  NOTIFICATION_RECORD_ORPHANED: 'control.notification_record_orphaned',
} as const;

/**
 * Codes emitted by panels, providers and the outbound HTTP layer.
 *
 * `PANEL_NOT_FOUND` is deliberately the only answer to "that panel is not
 * yours". A tenant asking about another tenant's panel id gets exactly what it
 * gets for an id that never existed, because a distinguishable "forbidden"
 * turns any id into an oracle for whether it exists somewhere on the
 * installation.
 *
 * `PANEL_TARGET_BLOCKED` names a URL this installation refuses to call. It is a
 * VALIDATION failure rather than an upstream one: nothing was contacted, and
 * saying so is what stops an operator retrying a URL that will never be
 * allowed. What it must never say is WHICH rule matched or what the host
 * resolved to — a blocked-target message that names the resolved address is a
 * port scanner with a friendly error format.
 */
export const PANEL_ERROR_CODES = {
  /** The request body does not match its contract schema. */
  PANEL_REQUEST_INVALID: 'panel.request_invalid',
  PANEL_NOT_FOUND: 'panel.not_found',
  /** A name already used by another live panel of this tenant. */
  PANEL_NAME_TAKEN: 'panel.name_taken',
  /** The base URL is malformed, uses a scheme this installation will not call, or embeds credentials. */
  PANEL_URL_INVALID: 'panel.url_invalid',
  /** The URL is well-formed and resolves somewhere this installation refuses to call. */
  PANEL_TARGET_BLOCKED: 'panel.target_blocked',
  /** An operation that only makes sense on a live panel, asked of an archived one. */
  PANEL_ARCHIVED: 'panel.archived',
  /** A probe was asked for on a panel with no credentials configured. */
  PANEL_CREDENTIALS_MISSING: 'panel.credentials_missing',
  /**
   * A credential field the provider's shape cannot use.
   *
   * Refused rather than stored. An API token on a `USERNAME_PASSWORD` provider
   * was accepted, encrypted and written, and then ignored by every probe — a
   * write that reported success and could never take effect.
   */
  PANEL_CREDENTIAL_UNSUPPORTED: 'panel.credential_unsupported',
  /**
   * This tenant has used its outbound-probe capacity for now.
   *
   * The per-panel cooldown is deliberately configuration-aware, so an
   * operator who corrects an address or a credential can test it at once.
   * That also means alternating two configurations retests on every change,
   * and the total number of real provider probes a tenant makes has to be
   * bounded by something that configuration cannot reset. This is that bound:
   * a token bucket per tenant, across every panel and every API process, that
   * counts only requests which were about to make a real outbound call. The
   * details carry a retry-after and nothing about any target.
   */
  PANEL_PROBE_LIMITED: 'panel.probe_limited',
  /**
   * The panel changed while its connection test was in flight.
   *
   * A probe reads a panel's address and credentials, then spends as long as the
   * network takes. If a rotation or an address change commits in that window,
   * the answer describes a configuration that no longer exists — and writing it
   * as the panel's health would mark replacement credentials healthy on the
   * strength of a login the old ones performed, or bury the evidence that a
   * corrected panel now works. The result is refused rather than stored, and
   * the operator is asked to run the test again against what the panel is now.
   */
  PANEL_CONFIGURATION_CHANGED: 'panel.configuration_changed',
  /**
   * A persisted provider type that this release has no adapter for.
   *
   * Reached only when a value gets past the CHECK constraint — a migration, a
   * direct database write, or a downgrade to a release that knows fewer
   * providers. It fails closed rather than falling back to a default adapter,
   * because the default would be operating somebody's production panel with the
   * wrong protocol.
   */
  PROVIDER_TYPE_UNSUPPORTED: 'panel.provider_type_unsupported',
  /**
   * There IS an adapter for this provider, and it does not perform this operation.
   *
   * Distinct from `PROVIDER_TYPE_UNSUPPORTED`, which means there is no adapter at
   * all, and the operator's next move differs: that one is "this release cannot
   * talk to this provider", this one is "this release talks to this provider and
   * cannot do this particular thing with it".
   *
   * Vacuous today — both registered providers declare `HEALTH_CHECK` — and the
   * reason it exists anyway is that the alternative was worse than vacuous. The
   * refusal had no branch, so it fell through to the cooldown case: the operator
   * pressed Test connection, the request returned 200 with `probed: false`, and
   * nothing anywhere said why. A silent no-op is the one outcome an operator
   * cannot debug.
   */
  PANEL_CAPABILITY_UNSUPPORTED: 'panel.capability_unsupported',
} as const;

/**
 * Phase 4 — commerce, settlement and provisioning.
 *
 * One family rather than five, because the distinction an error code family draws is
 * "which module owns the remedy", and for all of these it is the same surface and the
 * same operator. Splitting them would mean a customer-facing refusal whose prefix told
 * a reader which of our modules refused, which is not information they have.
 *
 * Every code here is a statement a surface can safely render the template for. None of
 * them carries a value, a balance or a provider response: `errors.ts` already fixes
 * that, and `docs/open-questions.md` records customer-supplied text reaching an
 * operational projection as the Phase 4 hazard.
 */
export const COMMERCE_ERROR_CODES = {
  /** The request body does not match its contract schema. */
  COMMERCE_REQUEST_INVALID: 'commerce.request_invalid',

  CUSTOMER_NOT_FOUND: 'commerce.customer_not_found',
  /**
   * The customer is blocked. Distinct from a permission denial: nothing the customer
   * can do changes it, and the operator who can is not on this surface.
   */
  CUSTOMER_BLOCKED: 'commerce.customer_blocked',

  PRODUCT_NOT_FOUND: 'commerce.product_not_found',
  /** Listed, but not sellable — inactive, or its panel is gone. */
  PRODUCT_UNAVAILABLE: 'commerce.product_unavailable',
  /**
   * The product has no price configured. NOT "the price is zero": a tenant that has
   * not priced a plan has not finished configuring it, and selling it for nothing is
   * the expensive reading.
   */
  PRODUCT_NOT_PRICED: 'commerce.product_not_priced',

  ORDER_NOT_FOUND: 'commerce.order_not_found',
  /** The order is not in a state this command is legal from. */
  ORDER_STATE_INVALID: 'commerce.order_state_invalid',
  ORDER_EXPIRED: 'commerce.order_expired',

  PAYMENT_NOT_FOUND: 'commerce.payment_not_found',
  PAYMENT_STATE_INVALID: 'commerce.payment_state_invalid',
  /** A gateway was asked for and this installation has none configured. */
  PAYMENT_METHOD_UNCONFIGURED: 'commerce.payment_method_unconfigured',
  /** Evidence was required and what was supplied does not establish the payment. */
  PAYMENT_EVIDENCE_INVALID: 'commerce.payment_evidence_invalid',

  /**
   * The debit would take the balance past what this customer may owe.
   *
   * The message names no balance. A refusal that quoted the figure would put a
   * customer's balance into an error body that a surface may log.
   */
  WALLET_INSUFFICIENT_FUNDS: 'commerce.wallet_insufficient_funds',
  /** An amount that is zero, negative, or past the sanity ceiling. */
  WALLET_AMOUNT_INVALID: 'commerce.wallet_amount_invalid',

  SERVICE_NOT_FOUND: 'commerce.service_not_found',
  SERVICE_STATE_INVALID: 'commerce.service_state_invalid',
  /**
   * The panel this service lives on cannot perform the operation asked of it.
   *
   * Named rather than silently skipped, because `provider.ts` records the rule: the
   * thing publishing a capability list is how the product tells an operator what it
   * can do, and a button that quietly does nothing is worse than one that is absent.
   */
  SERVICE_CAPABILITY_UNSUPPORTED: 'commerce.service_capability_unsupported',
  /**
   * The service is in an unreconciled state, so this installation does not know what
   * exists on the provider. The remedy is reconciliation, never a retry.
   */
  SERVICE_UNRECONCILED: 'commerce.service_unreconciled',

  OPERATION_NOT_FOUND: 'commerce.operation_not_found',
  /** The operation has exhausted its attempts. An operator decides what happens next. */
  OPERATION_ATTEMPTS_EXHAUSTED: 'commerce.operation_attempts_exhausted',

  DISCOUNT_NOT_FOUND: 'commerce.discount_not_found',
  /** Inactive, outside its window, or over a redemption limit. */
  DISCOUNT_NOT_REDEEMABLE: 'commerce.discount_not_redeemable',
  /** This customer has already used it as many times as they may. */
  DISCOUNT_ALREADY_REDEEMED: 'commerce.discount_already_redeemed',

  REFERRAL_NOT_ATTRIBUTABLE: 'commerce.referral_not_attributable',

  /** No trial product is configured, so this installation offers no trial. */
  TRIAL_UNCONFIGURED: 'commerce.trial_unconfigured',
  TRIAL_ALREADY_TAKEN: 'commerce.trial_already_taken',

  RESELLER_NOT_FOUND: 'commerce.reseller_not_found',
  RESELLER_CREDIT_EXCEEDED: 'commerce.reseller_credit_exceeded',
} as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[keyof typeof COMMERCE_ERROR_CODES];
