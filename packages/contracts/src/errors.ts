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

  /*
   * The fresh-install bot bootstrap. SEVEN codes, and the split is the point:
   * each one has a DIFFERENT remedy, and collapsing them would tell an operator
   * standing at a half-finished install to try the same thing seven times.
   */

  /**
   * Telegram rejected the token. `getMe` answered, and its answer was no.
   *
   * Distinct from `TELEGRAM_BOOTSTRAP_UNREACHABLE` because the remedy is a new
   * token from BotFather rather than waiting: an installation that cannot reach
   * Telegram at all has a network to fix, and one holding a revoked token has a
   * credential to replace. Telling an operator to check their DNS when the token
   * is wrong is how an install stalls for an afternoon.
   */
  TELEGRAM_BOOTSTRAP_TOKEN_REJECTED: 'telegram.bootstrap_token_rejected',

  /**
   * Telegram could not be reached, or answered in a way that says try again.
   *
   * A timeout, a 5xx, a 429, an unreadable 2xx. The bot instance may well be
   * written already — see ADR-0029 decision 4 — so this is the code that means
   * "rerun this step", not "the install failed".
   */
  TELEGRAM_BOOTSTRAP_UNREACHABLE: 'telegram.bootstrap_unreachable',

  /**
   * The token names a DIFFERENT bot than the one this installation already has.
   *
   * Refused rather than applied, and never automatically resolved. Repointing an
   * installation at another bot leaves every stored `telegram_user_id` attached
   * to conversations that bot has never had, and every stored `chat_id`
   * addressed to a bot that cannot send to it. ADR-0029 decision 3 records the
   * reasoning; the check is on `telegram_bot_id`, because a username can be
   * changed in BotFather and a numeric id cannot.
   */
  TELEGRAM_BOOTSTRAP_DIFFERENT_BOT: 'telegram.bootstrap_different_bot',

  /**
   * This Telegram bot is already bound to ANOTHER tenant on this installation.
   *
   * Distinct from `TELEGRAM_BOOTSTRAP_DIFFERENT_BOT`, which is the same question
   * asked of one row: there the supplied token names a bot this tenant is not
   * bound to; here the token is fine and the BOT is already somebody else's.
   * Different remedy, so a different code.
   *
   * Telegram keeps one webhook per bot, so a second binding does not coexist with
   * the first — it MOVES the delivery, and the first installation goes on
   * reporting `ready` for a URL that receives nothing. `bot_instances_username_key`
   * looked like it prevented this and does not: a username is changed in BotFather
   * at will, and the stored copy goes stale the moment it is. The rule is the
   * partial unique index on `telegram_bot_id`; this is how it reaches an operator.
   */
  TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND: 'telegram.bootstrap_bot_already_bound',

  /**
   * Another bot instance on this installation still stores that username.
   *
   * Its own code rather than a widening of the one above, and
   * `rethrowAlreadyBound` argued this before the code existed: answering
   * "already bound to another tenant" for a username collision "would be a
   * confident wrong answer about a genuinely different mistake".
   *
   * It IS a different mistake. `bot_instances_username_key` is not the identity
   * — a username is changed in BotFather at will and the stored copy goes stale
   * the moment it is — so this fires when a bot takes a name another row is
   * still holding, which is usually a rename nobody reconciled rather than one
   * bot bound twice. Until now it had no translation at all and surfaced as a
   * raw PostgreSQL 23505 (`OQ-TG-04` item 10).
   */
  TELEGRAM_BOOTSTRAP_USERNAME_TAKEN: 'telegram.bootstrap_username_taken',

  /**
   * The configured Telegram API base answered, and what came back is not a bot.
   *
   * The shape a wrong `TELEGRAM_API_BASE_URL` produces: a 2xx that parsed and does
   * not carry a numeric id and a username. `telegramGetMe` has always separated it
   * — `telegram.rejected.getme_shape` rather than `telegram.rejected.401` — and the
   * bootstrap gateway collapsed both into one rejection, so the operator was told
   * Telegram had refused their token and sent to BotFather to reissue a credential
   * that is fine (`OQ-TG-04` items 6 and 7).
   *
   * Distinct from `TELEGRAM_BOOTSTRAP_TOKEN_REJECTED` for the reason that code's
   * own docblock gives about `_UNREACHABLE`: a configuration change and a new
   * credential are not interchangeable remedies, and guessing between them is how
   * an install stalls for an afternoon.
   */
  TELEGRAM_BOOTSTRAP_API_BASE_INVALID: 'telegram.bootstrap_api_base_invalid',

  /**
   * The webhook could not be registered, though the bot instance is written.
   *
   * The one outcome that is deliberately NOT fatal to an install: DNS that has
   * not propagated and a certificate not yet issued both land here, and both are
   * fixed by waiting and rerunning rather than by undoing anything.
   *
   * TRANSIENT ONLY, which is what the code below exists to make true. It used to
   * carry both halves of `WebhookRegistration`, so a URL Telegram had LOOKED AT
   * and refused shared this code — and its one sentence, "rerun the installer to
   * retry the registration" — with the case that waiting actually fixes.
   */
  TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED: 'telegram.bootstrap_webhook_failed',

  /**
   * Telegram looked at the webhook URL and refused it.
   *
   * Not https, a port it does not accept, a name it cannot resolve. An unchanged
   * rerun submits the same URL and is refused identically, which is why this is
   * not `_WEBHOOK_FAILED` (`OQ-TG-04` item 8): one remedy is to wait and the
   * other is to change something, and an operator cannot tell which they have
   * from a code that means both.
   *
   * Nothing is undone by it either. The bot instance and its encrypted token are
   * stored and correct; what is wrong is the URL they were registered against.
   */
  TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED: 'telegram.bootstrap_webhook_refused',

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
   * A username policy that leaves a customer no way to name their service.
   *
   * Both modes off is not a strict configuration, it is a panel nothing can be bought
   * from — and it would fail at the customer's purchase rather than at the operator's
   * save, which is the class of defect `docs/conventions.md` calls a write-only setting.
   */
  PANEL_USERNAME_POLICY_EMPTY: 'panel.username_policy_empty',
  /**
   * The RANDOM template cannot produce a name this provider will accept.
   *
   * Raised at panel create and update, never deferred to a purchase. The detail carries
   * every issue at once — unknown token, no uniqueness token, illegal character, too
   * long — because an operator fixing one per round trip gives up.
   */
  PANEL_USERNAME_TEMPLATE_INVALID: 'panel.username_template_invalid',
  /**
   * The PREFIX_RANDOM prefix cannot produce a name inside the universal contract.
   *
   * Empty, containing something outside `[a-z0-9_-]`, not starting with an English
   * letter, or long enough to leave fewer than six random characters. Like the
   * template refusal it carries every issue at once, and like the template refusal it
   * is raised at the operator's save and never deferred to a customer's purchase.
   */
  PANEL_USERNAME_PREFIX_INVALID: 'panel.username_prefix_invalid',
  /**
   * The saved strategy and the configuration beside it do not describe one generator.
   *
   * `PREFIX_RANDOM` with no prefix, `CUSTOM_TEMPLATE` with no template, or either
   * carrying the other's configuration. It is a separate code from the two above
   * because the fix is different: those say "this value is wrong", this says "this
   * value is missing for the strategy you chose".
   */
  PANEL_USERNAME_STRATEGY_INVALID: 'panel.username_strategy_invalid',
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
  /**
   * A panel was asked to be enabled without a connection test that vouches for
   * what it is now.
   *
   * Enabling is the act that puts a panel in front of customers: the monitor
   * begins probing it and the catalogue begins selling onto it. Doing that on
   * an address nobody has reached, or on credentials replaced since the last
   * green test, is how an installation comes to offer a product it cannot
   * deliver — and the customer finds out after paying, which is the one moment
   * at which this is expensive.
   *
   * A test that SUCCEEDED against a DIFFERENT configuration is the case this
   * exists for, and it is why the check is an identity comparison rather than
   * "has this panel ever been healthy". The remedy is always the same and the
   * message says it: run the connection test again.
   */
  PANEL_NOT_VALIDATED: 'panel.not_validated',
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
   * The customer exists and an operator has blocked them.
   *
   * Distinct from absent, and deliberately so: a block is a decision somebody made and
   * can explain, and collapsing it into "unknown customer" is how the legacy system
   * leaves an operator unable to tell a mistake from a moderation action.
   */
  CUSTOMER_BLOCKED: 'commerce.customer_blocked',

  PRODUCT_NOT_FOUND: 'commerce.product_not_found',
  /** The product exists and is withdrawn from sale. Not the same as absent. */
  PRODUCT_NOT_PURCHASABLE: 'commerce.product_not_purchasable',
  /**
   * The product is priced for an audience this customer is not in.
   *
   * `RESELLERS_ONLY` today, and only that: there is no reseller entitlement in this
   * release, so the audience is refused outright rather than checked. Distinct from
   * NOT_PURCHASABLE because the product IS purchasable — by somebody else — and the
   * operational log has to tell a misconfiguration from a correct refusal.
   */
  PRODUCT_NOT_FOR_AUDIENCE: 'commerce.product_not_for_audience',
  /**
   * The price is in a currency this tenant does not sell in.
   *
   * `sales.currency` is the one unit a tenant prices in. A catalogue holding two
   * currencies is the legacy defect made durable: the same `{price}` placeholder
   * rendered تومان on one template and ریال on its twin, a factor of ten apart.
   * Named rather than folded into a request-invalid, because the operator's fix is
   * to change one field and the message has to say which.
   */
  PRODUCT_CURRENCY_UNSUPPORTED: 'commerce.product_currency_unsupported',
  /** No price pair. `catalog.ts`: an absent price means unsellable, never free. */
  PRODUCT_NOT_PRICED: 'commerce.product_not_priced',
  /** No panel bound, so nothing could deliver it. Named rather than hidden. */
  PRODUCT_NOT_FULFILLABLE: 'commerce.product_not_fulfillable',

  ORDER_NOT_FOUND: 'commerce.order_not_found',
  /** The order is not in the state this command needs. The machine refused it. */
  ORDER_STATE_INVALID: 'commerce.order_state_invalid',
  /** The draft's own deadline passed before it was confirmed. */
  ORDER_EXPIRED: 'commerce.order_expired',

  /**
   * The wallet does not hold enough to cover this debit.
   *
   * A refusal rather than an overdraft: `WALLET_ALLOWS_NEGATIVE_BALANCE` is `false`,
   * and `payment.ts` records that it is a constant so the reseller credit line in 4F
   * has to change data rather than code. The detail carries the SHORTFALL and not the
   * balance — `bot.wallet.insufficient` declares exactly that one placeholder, because
   * the shortfall is the number a customer can act on.
   */
  WALLET_INSUFFICIENT_FUNDS: 'commerce.wallet_insufficient_funds',
  /**
   * An amount in a currency this installation does not sell in.
   *
   * The same rule `PRODUCT_CURRENCY_UNSUPPORTED` states for a price, applied to a
   * balance: a wallet credited in a currency no order can be priced in is money that
   * can never be spent. `sales.currency` is the one denomination, and no conversion
   * exists anywhere to rescue an amount from the wrong one.
   */
  WALLET_CURRENCY_UNSUPPORTED: 'commerce.wallet_currency_unsupported',

  /**
   * A top-up amount this tenant does not offer.
   *
   * The amount travels in the tap — `callback_data` is client-supplied text — so it is
   * MATCHED against `wallet.topup.presets` rather than believed. A customer whose keyboard
   * is older than the configuration gets this rather than an invoice for an amount nobody
   * offers, and a modified client gets it rather than an amount of its own choosing.
   */
  TOPUP_NOT_OFFERED: 'commerce.topup_not_offered',
  /**
   * The amount is below `wallet.topup.minimum`.
   *
   * Its own code rather than `TOPUP_NOT_OFFERED`, because the two are different facts and
   * the customer can act on only one of them: a preset below the minimum is a
   * MISCONFIGURATION the operator must fix, and answering it as "not offered" would send
   * the customer looking for a button that is right there on their screen.
   */
  TOPUP_BELOW_MINIMUM: 'commerce.topup_below_minimum',
  /**
   * Nothing this installation has can fund a top-up right now.
   *
   * No preset is configured, or no enabled payment account exists to transfer to. The
   * same rule `requestManualTransfer` already applies to an order: a destination that
   * cannot be rendered is a refusal, never an invoice with a blank card number.
   */
  TOPUP_UNAVAILABLE: 'commerce.topup_unavailable',

  PAYMENT_NOT_FOUND: 'commerce.payment_not_found',
  /**
   * The payment is not in the state this command needs. `PAYMENT_MACHINE` refused it.
   *
   * A confirmation of something already CONFIRMED is NOT this: that is the end state
   * the caller asked for, and it is answered with the payment. This is a confirmation
   * of something FAILED, CANCELLED, EXPIRED or UNKNOWN — states from which the machine
   * has no `CONFIRM` edge, and the last of which is an absence of an outcome rather
   * than one.
   */
  PAYMENT_STATE_INVALID: 'commerce.payment_state_invalid',
  /**
   * A rail this installation cannot actually perform.
   *
   * `GATEWAY`, and only that, because `SELF_CONTAINED_PAYMENT_METHODS` is the pair
   * that needs no third party. `provider.ts` records the rule this follows: Marzban's
   * descriptor advertising fourteen operations no code could perform was rejected,
   * because what a product publishes is how it tells an operator what it can do. A
   * simulated gateway would be that defect with money attached.
   */
  PAYMENT_METHOD_UNAVAILABLE: 'commerce.payment_method_unavailable',
  /**
   * A confirmed payment does not fund this order, so the order does not settle.
   *
   * `settlementIsFunded` refused, and the `reason` detail says which of its checks —
   * a mismatched amount, a mismatched currency, another customer's payment, an order
   * no longer awaiting one. Never a conversion and never a partial credit: this is a
   * refusal, and `LGR-BR-003`'s split payment is deferred for want of a second rail.
   */
  SETTLEMENT_NOT_FUNDED: 'commerce.settlement_not_funded',

  SERVICE_NOT_FOUND: 'commerce.service_not_found',
  /**
   * This installation does not know whether a provider user exists for this service.
   *
   * The refusal `SERVICE_MACHINE` encodes as the absence of an edge, surfaced. An
   * `UNRECONCILED` service is one whose create timed out or answered with a 5xx: the
   * panel may hold an account, and asking for another one is how a customer ends up
   * paying for one service and occupying two. The remedy is a READ — reconciliation —
   * and it is not something a customer can ask for, so the message says an operator has
   * been told rather than inviting a retry.
   */
  SERVICE_UNRECONCILED: 'commerce.service_unreconciled',
  /**
   * The service has nothing to re-send, or is not in a state where sending means
   * anything.
   *
   * Distinct from `SERVICE_NOT_FOUND` because the service is real and the customer owns
   * it — it simply has no subscription link yet, or it is terminated. Naming it is what
   * stops a "re-send my config" button from answering with an empty message that reads
   * like a delivery.
   */
  SERVICE_NOT_DELIVERABLE: 'commerce.service_not_deliverable',
  /**
   * The panel this order was promised on cannot be operated.
   *
   * One code for four situations that share one remedy — an operator must fix the panel
   * or the product's binding: the panel is `DISABLED`, its provider type resolves to no
   * registered adapter, that adapter does not declare the capability the operation
   * needs, or a field the provider requires before it can be used is unset. The `reason`
   * detail carries which. Not folded into `PRODUCT_NOT_FULFILLABLE`, which means no
   * panel is bound at all: "nothing was chosen" and "what was chosen cannot be used" send
   * an operator to two different screens.
   */
  PANEL_NOT_OPERABLE: 'commerce.panel_not_operable',

  /**
   * The panel this order was promised on may not be SOLD onto right now.
   *
   * A different question from `PANEL_NOT_OPERABLE`, and the two disagree in both
   * directions. Operability asks whether one operation can run against a panel —
   * the adapter, the capability, the activation — and deliberately ignores health.
   * This asks whether the installation may take money for a NEW account on it, and
   * ignores capabilities: a panel that is archived, that is confirmed unreachable,
   * or that is full is perfectly capable of performing an operation and must not be
   * sold.
   *
   * The `reason` detail carries which of the four it is
   * (`PANEL_INELIGIBILITY_REASONS`), because the operator's next move differs for
   * each: restore it, enable it, fix it, or raise the cap. The customer is told
   * only that the product is unavailable — a capacity figure is an operational
   * fact about somebody's machine and not something a buyer is owed.
   */
  PANEL_NOT_ELIGIBLE: 'commerce.panel_not_eligible',

  /**
   * The service exists, the customer owns it, and this action cannot be taken on it
   * in the state it is in.
   *
   * Phase 4E answered this with `ORDER_STATE_INVALID` — a code named for orders, on a
   * path that has no order — because there was nothing better and every caller was a
   * management action rather than a purchase. 4F makes the path one a customer pays
   * through, and a refusal a customer is shown has to name the thing they were looking
   * at. The `state` detail says which state it was refused from.
   */
  SERVICE_ACTION_NOT_ALLOWED: 'commerce.service_action_not_allowed',

  /**
   * The action is real and this installation cannot currently sell it.
   *
   * Distinct from NOT_ALLOWED, which is about the service, and from
   * `PANEL_NOT_OPERABLE`, which is about the panel. This one is about CONFIGURATION:
   * no add-on of that kind is offered, or the product a renewal would be priced from
   * has been withdrawn, is unpriced, or is priced in a currency the tenant does not
   * sell in.
   *
   * Named rather than folded into a not-found, because the operator's fix is to
   * configure something and the message has to say so. `catalog.ts` states the rule
   * this enforces: an absent price means unsellable, never free.
   */
  SERVICE_ACTION_UNAVAILABLE: 'commerce.service_action_unavailable',

  /** No add-on with that id for this tenant. */
  ADDON_NOT_FOUND: 'commerce.addon_not_found',
  /** The add-on exists and is withdrawn. Not the same as absent. */
  ADDON_NOT_PURCHASABLE: 'commerce.addon_not_purchasable',

  /**
   * This service already has a commercial action the panel has not applied yet.
   *
   * A TRANSIENT refusal, and the only one in this group — everything else here says
   * "not for you" or "not offered", and this says "not yet".
   *
   * It exists because a commercial target is ABSOLUTE and computed once, from the
   * service as it stood when the money moved. Two purchases settling before the first
   * reaches the panel both read the same allowance, so both plan the same number: two
   * five-gigabyte packages against a ten-gigabyte service each plan fifteen, the
   * customer is charged twice and the account ends at fifteen. Serialising is what makes
   * "an absolute target is safe to replay" also true across DIFFERENT purchases, and it
   * is enforced by `provisioning_operations_open_commercial_key` rather than by this
   * check alone.
   */
  SERVICE_ACTION_IN_PROGRESS: 'commerce.service_action_in_progress',
  /**
   * The customer asked for a username mode this panel does not offer.
   *
   * Checked server-side even though the surface only draws the buttons the policy
   * allows, for the reason `CLAUDE.md` states about never enforcing by not drawing a
   * button: a callback is a string somebody can send twice, or send after the operator
   * turned that mode off.
   */
  SERVICE_USERNAME_MODE_UNAVAILABLE: 'commerce.service_username_mode_unavailable',
  /**
   * A typed username that does not satisfy the CUSTOM baseline.
   *
   * 4 to 20 characters from `A-Z`, `a-z`, `0-9`, `-` and `_`, with at least one letter
   * and at least one digit. Case is not distinguished — `Ali_2026` is accepted and
   * stored as `ali_2026` — and nothing else is altered: whitespace is refused rather
   * than trimmed.
   *
   * The refusal deliberately does NOT name which clause failed. The whole rule is shown
   * before the customer types, so a per-clause answer adds nothing they did not have
   * and turns the refusal into a probe. Nothing is reserved and no payment is started.
   */
  SERVICE_USERNAME_INVALID: 'commerce.service_username_invalid',
  /**
   * The name is legal and somebody else has it, or is part-way through buying it.
   *
   * Raised BEFORE any debit and before a manual transfer is requested. A RANDOM
   * candidate that collides is regenerated up to `RANDOM_USERNAME_MAX_ATTEMPTS` times
   * before this is raised; a CUSTOM one is raised at once, because there is nothing to
   * regenerate and the customer is the only one who can choose again.
   */
  SERVICE_USERNAME_TAKEN: 'commerce.service_username_taken',
  /**
   * The order is being confirmed and no username has been chosen for it.
   *
   * Reachable in exactly one situation: a panel that offers CUSTOM and nothing else,
   * and an order whose username step was skipped — a DRAFT created before this feature
   * shipped and confirmed after, or a confirm callback replayed from before the step
   * existed. Where RANDOM is allowed the confirmation allocates one instead of raising
   * this, because a customer who is already at the confirm button should not be sent
   * back for something the installation can decide itself.
   *
   * It is a REFUSAL rather than a silently generated name: on a CUSTOM-only panel the
   * operator has said the customer chooses, and choosing for them would be this
   * product's own version of the legacy defect where an admin's name was baked into
   * thirteen thousand customers' records.
   */
  SERVICE_USERNAME_REQUIRED: 'commerce.service_username_required',
  /**
   * The panel's automatic strategy cannot render a legal name for THIS purchase.
   *
   * Distinct from `SERVICE_USERNAME_TAKEN`, and the difference is who can act.
   * `TAKEN` means the names are legal and occupied, so a redraw or a different typed
   * name resolves it. This means no redraw can help: `TELEGRAM_ID_RANDOM` for a
   * Telegram id long enough to push the render past twenty characters, or a strategy
   * whose stored configuration went stale. It is raised BEFORE any debit, and the
   * operator is the one who fixes it.
   */
  SERVICE_USERNAME_UNGENERATABLE: 'commerce.service_username_ungeneratable',
  /**
   * The automatic generator drew its bounded number of candidates and every one was
   * held.
   *
   * Distinct from `SERVICE_USERNAME_TAKEN`, and the difference is whose problem it is.
   * `TAKEN` answers a name the CUSTOMER chose, so "choose another" is the remedy. This
   * answers a name they never saw, so there is nothing for them to choose differently
   * and telling them to try again at a different name would be advice they cannot
   * follow. Raised BEFORE any debit.
   */
  SERVICE_USERNAME_EXHAUSTED: 'commerce.service_username_exhausted',
  /**
   * An UNFUNDED draft is holding a name that the current contract would not mint.
   *
   * A draft frozen before the four-to-twenty contract, or before a panel's strategy
   * changed. The reservation is released and the customer chooses again — safe
   * precisely because no money has moved. A FUNDED or provider-ambiguous name is never
   * touched by this: it belongs to an account that may exist, and the answer there is
   * reconciliation or the automatic refund, never a rename.
   */
  SERVICE_USERNAME_STALE: 'commerce.service_username_stale',

  /**
   * There is not enough of the order's own window left to pay out of band inside it.
   *
   * Before Phase 4G a short window was survivable: nothing expired, and an operator
   * confirming a transfer that arrived after the deadline was deliberately exempt so
   * that money already in the bank was not stranded by a slow review queue. 4G's sweep
   * closes the payment AND the order, and a confirmation is then refused for good — so
   * handing a customer bank instructions thirty seconds before their order dies is
   * handing them a reference nobody will ever be able to honour.
   *
   * The floor is `PAYMENT_WINDOW_MINUTES_MIN`, whose own docblock states the rule this
   * enforces: a window shorter than the time it takes to open a banking app expires the
   * payment underneath the customer. That bound used to constrain only the SETTING; the
   * order's own remaining time could still be shorter than any of it.
   *
   * Distinct from `ORDER_EXPIRED`, which says the window has already closed. This one
   * says it is about to, and the customer's next step is different: place the order
   * again rather than wonder what went wrong.
   */
  PAYMENT_WINDOW_TOO_SHORT: 'commerce.payment_window_too_short',
  /**
   * The customer asked to cancel an order whose transfer they have SAID they sent.
   *
   * 4H gives a customer two new actions on the same message: "I have sent it" and
   * "cancel this order". Between them there is one combination that must not be
   * performed — cancelling an order after claiming to have paid for it. The claim says
   * money may already be in flight, and cancelling would close the payment it was
   * against while a bank transfer is on its way to a reference nobody is holding open.
   *
   * Distinct from `ORDER_STATE_INVALID`, which says the order can no longer be acted
   * on at all. This one says the order is perfectly live and the customer's own earlier
   * claim is what stops them: the remedy is to wait for the review they asked for, and
   * the sentence has to say so or the customer taps again.
   *
   * It is deliberately NOT a permission failure and not a not-found. Both would hide a
   * live order from the person who placed it.
   */
  ORDER_TRANSFER_UNDER_REVIEW: 'commerce.order_transfer_under_review',

  /** No manual-transfer account with that id for this tenant. */
  PAYMENT_ACCOUNT_NOT_FOUND: 'commerce.payment_account_not_found',
  /**
   * Another ENABLED account of this tenant already holds that card number.
   *
   * Scoped to enabled ones on purpose, and the partial unique index says the same thing
   * one layer down. A tenant re-adding a card they disabled last month is doing something
   * ordinary; two live accounts for one card is not, because the two then differ only in
   * a holder name or a label and nothing decides which a customer is shown.
   */
  PAYMENT_ACCOUNT_DUPLICATE: 'commerce.payment_account_duplicate',
  /**
   * A disabled account cannot be made the default, and a default cannot be disabled.
   *
   * One code for both because they are one rule read from two ends: the default is what a
   * new payment is issued against, and `DISABLED` is an operator saying stop using this.
   * A row that was both would defeat the second by way of the first. The remedy is the
   * same from either direction — promote another account — so the message is too.
   */
  PAYMENT_ACCOUNT_DISABLED: 'commerce.payment_account_disabled',
  /**
   * The tenant has no enabled account, so there is nowhere for a transfer to go.
   *
   * A REFUSAL rather than a payment with blank instructions, and the reason is the one
   * `PAYMENT_METHOD_UNAVAILABLE` gives for a gateway with no adapter: what a product
   * offers is how it tells a customer what it can do. A manual-transfer payment with no
   * destination is a reference number and an amount with no way to pay them.
   *
   * The Telegram surface does not draw the button when this would be the answer, so a
   * customer normally never sees it. It is still thrown, because the button is drawn from
   * a read that can be a moment stale and the last enabled account can be disabled in
   * between.
   */
  PAYMENT_DESTINATION_UNCONFIGURED: 'commerce.payment_destination_unconfigured',
  /**
   * The tenant is at `PAYMENT_ACCOUNT_MAX_PER_TENANT`.
   *
   * The rail that makes the account list complete by construction rather than paginated.
   * Named rather than folded into a request-invalid because the operator's remedy is to
   * disable something, and a validation error would not say that.
   */
  PAYMENT_ACCOUNT_LIMIT_REACHED: 'commerce.payment_account_limit_reached',
  /**
   * Two operators promoted different accounts at once, and this one lost.
   *
   * `payment_accounts_tenant_default_key` allows one default per tenant, so the loser's
   * INSERT-side of clear-then-set meets it. Its own code, NOT
   * `PAYMENT_ACCOUNT_DUPLICATE`: that one is documented as another enabled account
   * holding the same CARD NUMBER, a client branching on it would be branching on the
   * wrong fact, and the two constraints are already told apart by name one layer down.
   *
   * It is the one refusal in this family that is plainly RETRYABLE — nothing about the
   * request was wrong, another operator simply committed first — and the message says
   * so, because a refusal an operator cannot act on is the one they report as a bug.
   */
  PAYMENT_ACCOUNT_DEFAULT_CONFLICT: 'commerce.payment_account_default_conflict',

  /** No refund with that id for this tenant. */
  REFUND_NOT_FOUND: 'commerce.refund_not_found',
  /**
   * The payment cannot be refunded at all.
   *
   * Three facts, one code, and the `reason` detail separates them for the operator: the
   * payment never settled (only a CONFIRMED payment took money), its method has no
   * refund channel this release can perform (`GATEWAY`, per `REFUND_METHOD_SUPPORT`), or
   * it is already refunded in full. None of the three is something a different amount
   * would fix, which is what distinguishes this from `REFUND_EXCEEDS_REFUNDABLE`.
   */
  REFUND_NOT_PERMITTED: 'commerce.refund_not_permitted',
  /**
   * The amount asked for is more than the payment has left to give back.
   *
   * Its own code because it is the ONE refund refusal a different request would satisfy,
   * and the detail carries the refundable figure so an operator can act without a second
   * screen. The bound is computed server-side inside the transaction, under a lock —
   * `refundFitsWithin` is the rule and a browser's arithmetic is a suggestion.
   *
   * A refund can never create money, and this is the code that says so.
   */
  REFUND_EXCEEDS_REFUNDABLE: 'commerce.refund_exceeds_refundable',
  /**
   * The refund is not in a state from which this command is possible.
   *
   * `REFUND_TRANSITIONS` refused. A completion of something already COMPLETED is NOT
   * this — that is the end state the caller asked for, and it is answered with the
   * refund, for the reason `PAYMENT_STATE_INVALID` states about a confirmation. This is
   * a completion of something FAILED, or an attempt to revive a terminal refund.
   */
  REFUND_STATE_INVALID: 'commerce.refund_state_invalid',

  /**
   * No configured route of that kind for this tenant.
   *
   * A route is addressed by `(tenant, provider)` and the provider comes off a closed
   * enum, so this is a route nobody has configured yet rather than a malformed
   * identifier — the malformed case never reaches a service, because
   * `paymentGatewayProviderSchema` refuses it at the boundary.
   */
  PAYMENT_GATEWAY_NOT_FOUND: 'commerce.payment_gateway_not_found',
  /**
   * No route can carry this payment for this customer, right now.
   *
   * Deliberately ONE code for four different underlying facts — the route is switched
   * off, or the customer has too few payments, too many, or too young an account — and
   * the split is the opposite of `TOPUP_BELOW_MINIMUM`'s. There the distinction reached
   * a customer who could act on it. Here none of the four is the customer's to act on,
   * and naming which threshold refused them tells whoever holds that chat how this
   * installation's payment gating is configured. The `reason` detail carries it for the
   * operator, through the operational log, which is where an operator looks.
   */
  PAYMENT_GATEWAY_UNAVAILABLE: 'commerce.payment_gateway_unavailable',
  /**
   * The amount is outside what this route accepts.
   *
   * Its own code rather than `PAYMENT_GATEWAY_UNAVAILABLE`, on the same argument that
   * separates `TOPUP_BELOW_MINIMUM` from `TOPUP_NOT_OFFERED`: a bound an operator set on
   * a route is a MISCONFIGURATION when a preset falls outside it, and answering it as
   * "no route available" sends the operator looking at eligibility thresholds instead of
   * at the two numbers that actually refused. The detail says which side it fell on.
   */
  PAYMENT_GATEWAY_AMOUNT_REJECTED: 'commerce.payment_gateway_amount_rejected',

  /**
   * A file arrived and no upload window is open for this customer on this bot.
   *
   * The refusal that keeps the receipt flow from becoming a prompt capture.
   * `INCIDENT-FIN-001` is what the legacy system did with an ordinary message that
   * happened to arrive while a prompt was outstanding: it consumed it and overwrote a
   * production gateway setting. Here a photo with no window open is refused BY NAME
   * rather than attached to whatever payment the customer most recently had, and a
   * customer who sent a screenshot at random is told nothing was expected.
   */
  RECEIPT_NOT_EXPECTED: 'commerce.receipt_not_expected',
  /**
   * The window was open when the customer tapped and had closed by the time the file
   * arrived.
   *
   * Distinct from `RECEIPT_NOT_EXPECTED` because the remedy differs: here the customer
   * did exactly what they were asked and took too long, so they are told to tap the
   * button again. `RECEIPT_CAPTURE_MINUTES` and the payment's own deadline both bound
   * the window and whichever is sooner wins.
   */
  RECEIPT_WINDOW_EXPIRED: 'commerce.receipt_window_expired',
  /**
   * The payment already holds `PAYMENT_RECEIPT_MAX_PER_PAYMENT` receipts.
   *
   * A rail, and named rather than silent for the reason `PAYMENT_ACCOUNT_LIMIT_REACHED`
   * is: a customer who keeps sending screenshots has to learn that the ones already
   * sent are what the reviewer will look at, or they send more.
   */
  RECEIPT_LIMIT_REACHED: 'commerce.receipt_limit_reached',
  /** No receipt with that id for this tenant. */
  RECEIPT_NOT_FOUND: 'commerce.receipt_not_found',
  /**
   * The receipt row exists and Telegram will not produce the bytes.
   *
   * The honest name for the limitation `packages/contracts/src/payment-receipts.ts`
   * states rather than discovers: this installation stores the BINDING and Telegram
   * stores the file, so a rotated bot token or a file Telegram has aged out leaves a row
   * whose image cannot be fetched. A reviewer meeting this is told the file is no longer
   * retrievable — not shown an empty frame, and not told the receipt does not exist.
   */
  RECEIPT_UNAVAILABLE: 'commerce.receipt_unavailable',
} as const;

/*
 * The rest of the family arrives WITH its producer, one subphase at a time.
 *
 * This file carried twenty-seven more codes for one commit — the whole of 4B through 4F —
 * and `scripts/check-boundaries.sh` rejected them, correctly and for a reason it records
 * in its own words: reserving a code keeps a dead name in a FROZEN spec, which is what
 * `CLAUDE.md` means by "no placeholder abstractions". Its `RESERVED_CODES` list is empty
 * deliberately.
 *
 * So `PRODUCT_NOT_PRICED` lands in the commit that refuses an unpriced product,
 * `WALLET_INSUFFICIENT_FUNDS` in the one that refuses a debit, `SERVICE_UNRECONCILED` in
 * the one that refuses to retry after an unknown outcome, and so on. Each is a one-line
 * contract commit beside the path that throws it, which is also the only way a reader can
 * tell a live code from an aspiration.
 */

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[keyof typeof COMMERCE_ERROR_CODES];
