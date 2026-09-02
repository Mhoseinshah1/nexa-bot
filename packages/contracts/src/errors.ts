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
  SECRET_DECRYPT_FAILED: 'platform.secret_decrypt_failed',
  TELEGRAM_BAD_SECRET_TOKEN: 'telegram.bad_secret_token',
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
