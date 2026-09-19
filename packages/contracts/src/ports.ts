import type { SecretContext } from './secrets.js';
import type { ActorContext, SourceSurface } from './actor.js';
import type { ScopeContext } from './tenant.js';
import type { CorrelationId } from './ids.js';

/**
 * Ports.
 *
 * The abstractions the domain and application layers depend on. Infrastructure
 * implements them and depends inward; nothing here knows about Postgres, Redis,
 * Nest or Telegram. A lint rule stops domain and application code from importing
 * a framework, which is what keeps this honest rather than decorative.
 */

/** Generates identifiers. UUIDv7, so the id exists before the INSERT. */
export interface IdGenerator {
  uuid(): string;
  /** A short opaque reference that fits Telegram's 64-byte callback_data cap. */
  callbackRef(): string;
}

/**
 * Envelope encryption for stored secrets.
 *
 * Bot tokens — and later panel and gateway credentials — are encrypted with a
 * data key that is itself wrapped by a key-encryption key held outside the
 * database. `keyId` travels with the ciphertext so keys can rotate.
 *
 * No API response ever contains a decrypted secret. In the legacy system the
 * panel detail page rendered dots followed by the real stored secret in the DOM,
 * and panel tokens were typed as plain chat messages into Telegram.
 */
export interface EncryptedSecret {
  readonly keyId: string;
  readonly ciphertext: string;
}

export interface SecretCipher {
  /**
   * `context` is REQUIRED, and it is required on both sides on purpose.
   *
   * Making it a parameter rather than an option means every call site fails to
   * compile until it says what the secret is for and which row owns it. A
   * context that could be omitted would be omitted.
   */
  encrypt(plaintext: string, context: SecretContext): EncryptedSecret;
  decrypt(secret: EncryptedSecret, context: SecretContext): string;
  /**
   * A stable, non-reversible display form, computed server-side.
   *
   * Derived from the ciphertext, so it CHANGES when a secret is re-encrypted
   * under a new key. It is a visual confirmation that two operators are looking
   * at the same stored value right now; it is not an identifier and nothing may
   * persist it or compare it across a rewrap.
   */
  mask(secret: EncryptedSecret): string;
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  trace(context: Record<string, unknown>, message: string): void;
  debug(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

/**
 * The unit of work.
 *
 * Domain changes, the audit row and the outbox rows commit together or not at
 * all. Everything a write path does happens inside one of these.
 */
export interface UnitOfWork<TTransaction = unknown> {
  run<T>(scope: ScopeContext, fn: (tx: TTransaction) => Promise<T>): Promise<T>;

  /**
   * A transaction whose statements all see ONE snapshot.
   *
   * `run` is READ COMMITTED: every statement takes its own snapshot, which is
   * what an optimistic write predicate needs and what a multi-statement READ
   * must not rely on. Two reads inside `run` can straddle another writer's
   * commit and produce a reply describing a state that never existed. Use this
   * where a reply is assembled from more than one read.
   */
  runSnapshot<T>(scope: ScopeContext, fn: (tx: TTransaction) => Promise<T>): Promise<T>;
  /**
   * A savepoint inside an existing transaction.
   *
   * For work that may fail WITHOUT taking the caller's transaction with it.
   * That is not something a `try`/`catch` can provide: in Postgres a failed
   * statement aborts the whole transaction, so catching the error leaves every
   * later statement failing with `current transaction is aborted` and loses the
   * caller's own write — while the catch block reports that it kept it.
   *
   * Used by the operational-event projector, whose contract is that the event
   * survives a projection that could not be built.
   */
  runNested<T>(
    scope: ScopeContext,
    tx: TTransaction,
    fn: (tx: TTransaction) => Promise<T>,
  ): Promise<T>;
}

/**
 * Durable idempotency.
 *
 * Telegram retries webhooks, BullMQ redelivers jobs and gateways double-post
 * callbacks. A command carrying an idempotency key executes once; a replay
 * returns the first result rather than performing the work again.
 */
export interface IdempotencyRecord<TResult = unknown> {
  readonly key: string;
  readonly requestHash: string;
  readonly result: TResult;
  readonly createdAt: Date;
}

/**
 * Which surface minted a key. Keys are unique within a namespace, never across
 * them: two surfaces must not be able to consume each other's keys, even when
 * both run under the same scope.
 */
export type IdempotencyNamespace = SourceSurface;

export interface IdempotencyStore {
  /**
   * Returns the stored result when this key has already completed. Throws a
   * CONFLICT when the key was used with a different request payload — a reused
   * key with different input is a bug, never a replay.
   */
  find<TResult>(
    scope: ScopeContext,
    namespace: IdempotencyNamespace,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyRecord<TResult> | null>;
  /**
   * Stores the result of a completed command against its key.
   *
   * Returns FALSE when a record for this key already existed, which is the
   * signal that a concurrent request with the same key won the race. It is not
   * decoration: `find` runs before the work and cannot see a request that has
   * not committed yet, so two simultaneous submissions of one key both find
   * nothing and both do the work. The insert is where they meet, and a caller
   * that ignores the answer has an idempotency key that stops a SEQUENTIAL
   * replay and nothing else — precisely the case a double-clicked button
   * produces.
   *
   * The loser should abandon its transaction, so its half of the duplicate work
   * is rolled back rather than committed beside the winner's.
   */
  remember<TResult>(
    scope: ScopeContext,
    namespace: IdempotencyNamespace,
    key: string,
    requestHash: string,
    result: TResult,
    tx?: unknown,
  ): Promise<boolean>;
}

export const AUDIT_RESULTS = ['SUCCESS', 'DENIED', 'FAILED'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

/**
 * An audit entry.
 *
 * `action` is a machine code, never a prose sentence. `before` and `after` hold
 * VALUES, not references, so the record still means something after the
 * referenced row changes. Denials are audited too.
 */
export interface AuditEntry {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  /** Mandatory for high-risk actions. */
  readonly reason?: string;
  readonly result: AuditResult;
}

export interface AuditWriter {
  record(scope: ScopeContext, actor: ActorContext, entry: AuditEntry, tx?: unknown): Promise<void>;
}

export const OPERATIONAL_SEVERITIES = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL'] as const;
export type OperationalSeverity = (typeof OPERATIONAL_SEVERITIES)[number];

/**
 * Which slice of the operational log a reader is asking for.
 *
 * `ALL` is the whole stream. `MANAGEMENT` is the far smaller set that wants a
 * person's attention. `MANAGEMENT_CONDITIONS` is narrower still: the subset of
 * management codes that can actually be CLOSED.
 *
 * That third value is not a convenience. A denial and a lockout are facts
 * about a moment; nothing resolves them, and nothing in this product ever
 * will, because there is deliberately no "mark as seen". Shown on a card
 * titled "needs attention" they accumulate for the life of the installation,
 * and after a month of ordinary misclicks that card is denial noise — which is
 * exactly the burial the `MANAGEMENT` scope was introduced to prevent, arrived
 * at from the other direction. So the dashboard asks for conditions, which
 * open and close, and the alerts page asks for the whole management scope,
 * where a one-shot record is history rather than an outstanding task.
 *
 * The distinction exists because the Web Admin's alerts page is not an
 * operational history. Routine events — every probe, every health transition,
 * every delivery attempt — go to the Telegram report group, which is the
 * human-facing operational stream; a page that mixed the two would bury the six
 * events an operator must act on under the six thousand they must not.
 *
 * It is a SERVER-side scope on purpose. Filtering a page of fifty rows in the
 * browser yields a page of two, a cursor that has already skipped past
 * everything else, and paging that silently loses rows — which is the same
 * class of defect as the cursor tie-break this log already had to fix.
 */
export const OPERATIONAL_SCOPES = ['ALL', 'MANAGEMENT', 'MANAGEMENT_CONDITIONS'] as const;
export type OperationalScope = (typeof OPERATIONAL_SCOPES)[number];

/**
 * The FAILURE codes: a state the installation is in that an operator can do
 * something about, and which something later resolves.
 *
 * These are what `MANAGEMENT_CONDITIONS` selects, and the distinction from the
 * recoveries below is not cosmetic. A recovery row is INSERTED, with its own
 * `resolvedAt` left null — it resolves the preceding FAILURE row, never
 * itself, and nothing ever resolves a recovery. Including recoveries in the
 * conditions scope therefore made `scope=MANAGEMENT_CONDITIONS&open=true`
 * return `panel.monitor.tenant_budget_ok` and `settings.stored_value_valid`
 * as open conditions, so the dashboard's "needs attention" card stayed
 * populated by the very rows that say the problem is over.
 *
 * That is the same defect this scope was introduced to fix, reintroduced from
 * the other side: the first version buried the card under unresolvable
 * denials, and its replacement buried it under unresolvable recoveries.
 */
export const MANAGEMENT_CONDITION_FAILURE_CODES = [
  'panel.monitor.tenant_budget_exceeded',
  'settings.stored_value_invalid',
  /**
   * A backup run failed, at whatever stage.
   *
   * A condition rather than a one-shot, because it is a STATE an operator can
   * act on and something later resolves: an installation whose backups have
   * been failing for a week is in a different situation from one that had a
   * single bad night, and the difference is whether the row is still open.
   *
   * It is here, in the tenant-scoped management scope, and not under
   * `SYSTEM_SCOPE` beside the monitor's capacity condition — which is recorded
   * with a null tenant and is therefore invisible to every Web Admin reader,
   * as the comment on `MANAGEMENT_EVENT_CODES` says at length. A backup that
   * has stopped working is the last thing that should be discoverable only by
   * someone who already suspects it. One install serves one customer
   * (ADR-0001), so the installation's own tenant is the right addressee.
   */
  'backup.run_failed',
  /**
   * A recovery failed, at whatever stage.
   *
   * A condition rather than a one-shot for the reason the backup failure is one:
   * it is a STATE an operator has to act on, and something later resolves it.
   * The context carries whether the cutover happened and what the displaced
   * database is called, because after a failed recovery the first question is
   * which database production is now.
   *
   * Deduped PER RECOVERY, unlike `backup.run_failed`, which is deduped
   * installation-wide. A nightly backup failing twice is one condition; two
   * recoveries are two operations against two different artifacts, and
   * collapsing them onto one row would hide the second.
   */
  'recovery.run_failed',
] as const;

/**
 * The RECOVERY codes, each paired with the failure above that it closes.
 *
 * Management history — an operator should be able to see that a condition
 * ended — but never an open condition, because nothing resolves them.
 *
 * `tests/unit/web-money-and-scope.test.ts` › "the condition lifecycle" asserts
 * the two lists are disjoint and that the pairing is total in both directions,
 * so a failure cannot be added without its recovery and a recovery cannot leak
 * into the conditions scope. `tests/integration/web-admin-v2.test.ts` › "never
 * returns a recovery as an open condition" proves it over the real recorder
 * and the real endpoint.
 *
 * That sentence previously named the unit test for a property it did not
 * assert — it looped over the UNION and never imported either list, so
 * re-adding a recovery code to the failure list left it green. The test now
 * exists; the claim came first, which is the defect this note records.
 */
export const MANAGEMENT_CONDITION_RECOVERY_CODES = [
  'panel.monitor.tenant_budget_ok',
  'settings.stored_value_valid',
  /** A backup run succeeded, closing `backup.run_failed`. */
  'backup.run_ok',
  /**
   * A recovery completed AND the installation reported ready, closing
   * `recovery.run_failed` for that recovery.
   *
   * Both halves. A cutover that completed and left the application unable to
   * serve is a failed recovery with a renamed database, which is the worst thing
   * this code could report as a success.
   */
  'recovery.run_ok',
] as const;

/**
 * Failures and recoveries together: the codes that participate in the
 * condition lifecycle at all. NOT the conditions scope — that is the failure
 * list alone.
 */
export const MANAGEMENT_CONDITION_CODES = [
  ...MANAGEMENT_CONDITION_FAILURE_CODES,
  ...MANAGEMENT_CONDITION_RECOVERY_CODES,
] as const;

/**
 * The four administrator-change codes, as a type.
 *
 * Named separately so `AdminManagementService` cannot record a fifth code that
 * this scope does not carry — the failure the `admin.` prefix hid, in the one
 * place that could reintroduce it. `MANAGEMENT_ONE_SHOT_CODES` spreads this
 * rather than restating it, which is what makes that guarantee hold by
 * construction; declared here, above its use, because a `const` referenced
 * before its declaration is a temporal dead zone at module evaluation, not a
 * hoisted binding.
 */
export const MANAGEMENT_ADMIN_EVENT_CODES = [
  'admin.created',
  'admin.password_changed',
  'admin.roles_changed',
  'admin.status_changed',
] as const;
export type ManagementAdminEventCode = (typeof MANAGEMENT_ADMIN_EVENT_CODES)[number];

/**
 * Codes that are records of a moment rather than a state: a denial, a lockout,
 * an administrator changed. `resolvedAt` is permanently null for these BY
 * DESIGN — there is no recovery and deliberately no acknowledgement — so a
 * surface must not render them as "unresolved" or offer them under an
 * open-only filter as though they were outstanding work.
 */
export const MANAGEMENT_ONE_SHOT_CODES = [
  'access.permission_denied',
  'auth.login_locked_out',
  /**
   * An order could not be delivered and its money went back to the wallet.
   *
   * A ONE-SHOT, and the classification is the decision rather than a detail. The
   * pair this replaces — `order.fulfilment_failed` and `order.fulfilment_ok` — was
   * a CONDITION, because an order that was paid and undelivered was a state somebody
   * had to act on. Nobody acts on this one: the refund is on the ledger, the
   * customer has been told, and the order is terminal. Filed as a condition it would
   * be an open ERROR per refunded order with no recovery that could ever close it,
   * which is the queue-that-only-grows the state was removed for.
   *
   * What an operator DOES have to fix — a panel at capacity, unhealthy, or refusing
   * every create — raises its own condition from `PanelSalesGate` and the
   * provisioner, with its own recovery. This says what it cost.
   *
   * Introduced and retired in the same release as the pair it replaces, which is the
   * one circumstance `CLAUDE.md` permits an operational code to be renamed in: no
   * installation carries an open row under either name.
   */
  'order.refunded_undeliverable',
  // DERIVED, not re-typed. `MANAGEMENT_ADMIN_EVENT_CODES` is what types
  // `AdminManagementService.recordAdminChange`, and its whole reason for
  // existing is that the service cannot record a code this scope does not
  // carry. Hand-copying the four here severed that: a fifth admin code would
  // have type-checked, been recordable, and been invisible on the alerts page
  // — the exact defect the `admin.` prefix used to hide. The spread is the
  // guarantee.
  ...MANAGEMENT_ADMIN_EVENT_CODES,
] as const;

/** Whether a code is a one-shot record rather than a closable condition. */
export function isOneShotManagementCode(code: string): boolean {
  return (MANAGEMENT_ONE_SHOT_CODES as readonly string[]).includes(code);
}

/**
 * Whether a code is a RECOVERY — a row that closes a failure and is never
 * closed itself.
 *
 * A surface needs this for the same reason it needs the one-shot predicate,
 * and for one step further along: a recovery's `resolvedAt` is null by design
 * too, so anything that reads "not resolved" as "still a problem" puts a
 * warning on the row whose whole message is that the problem ended. Three
 * kinds, not two.
 */
export function isConditionRecoveryCode(code: string): boolean {
  return (MANAGEMENT_CONDITION_RECOVERY_CODES as readonly string[]).includes(code);
}

/**
 * The management scope: conditions, plus the one-shot records about people and
 * privilege that an operator should be able to find.
 *
 * Enumerated rather than prefix-matched, and every entry is a code some
 * production path actually writes to `operational_events`. That last clause is
 * the whole discipline of this list. It previously carried four entries that
 * no recorder emitted — `internal.unhandled` (an HTTP error-response code),
 * `notification.attempts_exhausted` (a delivery-attempt `errorCode`), and the
 * two `panel.monitor.scheduler_capacity_*` codes, which ARE recorded but under
 * `SYSTEM_SCOPE` with a null tenant, where this tenant-scoped reader can never
 * see them. It also carried an `admin.` PREFIX that matched nothing at all,
 * because `admin.create`/`admin.roles_change`/`admin.status_change` are audit
 * `action` values, not event codes. Together they made the page claim four
 * kinds of coverage it did not have, and no test could tell, because every
 * test that exercised the scope invented its own code.
 *
 * The installation-scoped capacity condition is not lost: it reaches the
 * operator through `GET /system/monitor`, which is installation-scoped by
 * construction and so can answer for a row this reader cannot reach.
 *
 * Each remaining entry has a reason:
 *
 *   - `access.permission_denied`, `auth.login_locked_out` — somebody was
 *     refused, or locked out. Security facts about people. History, not tasks:
 *     they are NOT in `MANAGEMENT_CONDITION_CODES`.
 *   - `admin.created`, `admin.status_changed`, `admin.roles_changed`,
 *     `admin.password_changed` — owner revision 24 names administrator changes
 *     as management-facing. They are recorded beside the audit row they
 *     already produced, in the same transaction, so the page can show them.
 *     Also history rather than tasks.
 *   - `panel.monitor.tenant_budget_*` and `settings.stored_value_*` — the
 *     conditions above, which open and close.
 *
 * Deliberately NOT here: `panel.health.*` and `panel.monitor.probe`. A panel
 * going unreachable and coming back is the routine operational stream, and it
 * is already visible where it is actionable — on the panel itself, and on the
 * dashboard. Putting it here would make this page the log the owner asked for
 * it not to be.
 *
 * Deliberately NOT here either, and this was an OMISSION until it was
 * questioned: `panel.probe.limited` and `panel.probe.ok`. They are a real
 * condition pair — dedupe-keyed, opened by `PanelService.testConnection` when
 * the tenant's outbound-probe budget is spent, closed by the next probe that
 * succeeds — and their twin one lane over, `panel.monitor.tenant_budget_*`,
 * IS in the conditions scope. The asymmetry is the point rather than an
 * oversight: the monitor lane runs unattended, so a budget it exhausts is only
 * ever discoverable from a durable record, while the operator lane exhausts
 * the budget by a person pressing a button and answers that person with a
 * `RATE_LIMITED` error in the same second. A management page carries what
 * nobody has been told; this one has already been told.
 *
 * The consequence, stated rather than hidden: an open `panel.probe.limited`
 * row is reachable from no Web Admin screen, because every screen asks for
 * `MANAGEMENT` or `MANAGEMENT_CONDITIONS` and owner revision 25 removed the
 * general log browser. It is in the database and in the Telegram operational
 * projection, and nowhere else.
 */
export const MANAGEMENT_EVENT_CODES = [
  ...MANAGEMENT_ONE_SHOT_CODES,
  ...MANAGEMENT_CONDITION_CODES,
] as const;

/**
 * An operational event: what the system did, as opposed to who changed what.
 *
 * `dedupeKey` collapses repeats into one row with an occurrence counter — the
 * legacy log group recorded 60 identical TLS errors in a single day with no way
 * to suppress them. A recovery event is emitted explicitly when the condition
 * clears, so a resolved problem stops looking unresolved.
 */
export interface OperationalEventInput {
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly dedupeKey?: string;
  readonly correlationId?: CorrelationId;
  /** Set when this event records recovery from an earlier failure code. */
  readonly recoversCode?: string;
  /**
   * Which SUBJECT'S open condition this recovery closes.
   *
   * `recoversCode` alone resolves every open row of that code in the tenant,
   * which is right for a condition there can only be one of — "this
   * installation cannot reach Telegram" — and wrong for every condition that is
   * ABOUT something. Deduplication is already per subject: the invalid-setting
   * event keys on the setting, the panel-health event keys on the panel.
   * Without this field, repairing one setting marked every other setting's open
   * complaint resolved, and an operator's unresolved list quietly emptied
   * itself of problems nobody had fixed.
   *
   * So a recovery about one subject names that subject's dedupe key, and
   * resolves that row and no other. Omitted for genuinely installation-wide
   * conditions, where the broad behaviour is the correct one.
   */
  readonly recoversDedupeKey?: string;
}

/**
 * What was actually recorded.
 *
 * `isNew` is the field that matters. A deduplicated condition collapses onto one
 * row and increments a counter, so a projection driven by these — an alert, a
 * notification — fires once per CONDITION rather than once per occurrence. The
 * legacy log group posted the same expired-TLS error 36 + 15 + 8 + 1 times in a
 * single day because nothing anywhere could tell those apart (BUG-LGR-028).
 *
 * `reopened` says the row had been marked resolved and this occurrence opened it
 * again, which is worth telling somebody about even though the row is not new.
 */
export interface RecordedOperationalEvent {
  readonly id: string;
  readonly code: string;
  readonly severity: OperationalSeverity;
  readonly message: string;
  readonly occurrenceCount: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly isNew: boolean;
  readonly reopened: boolean;
}

export interface OperationalEventRecorder {
  /**
   * Records what happened.
   *
   * `tx` joins the caller's transaction, the same way the audit writer and the
   * idempotency store do. It matters for the projection into a notification:
   * without it, the event and the decision to tell somebody about it are two
   * separate commits, and a process that dies between them loses the alert
   * PERMANENTLY — the condition's next occurrence is a repeat, not a new one,
   * so nothing would announce it until it resolved and came back.
   */
  record(
    scope: ScopeContext,
    event: OperationalEventInput,
    tx?: unknown,
  ): Promise<RecordedOperationalEvent>;
}

/**
 * Password hashing.
 *
 * `encoded` carries the algorithm and its parameters alongside the digest, so a
 * stored hash is self-describing and the cost can be raised — or the algorithm
 * replaced — without a migration: `needsRehash` reports that a verified
 * password should be re-stored, and the only moment the plaintext exists is the
 * moment it can be re-hashed.
 *
 * There is no `compare(hashA, hashB)`. Verification takes the plaintext and the
 * stored string, so no caller can be tempted to compare two digests with `===`.
 */
export interface PasswordHasher {
  /** Returns the self-describing encoded hash to store. Never reversible. */
  hash(plaintext: string): Promise<string>;
  /** Constant-time within the algorithm. False for any malformed stored value. */
  verify(plaintext: string, encoded: string): Promise<boolean>;
  /** True when `encoded` was produced with weaker parameters than current policy. */
  needsRehash(encoded: string): boolean;
  /**
   * Spends the same work as a real verification against a value that cannot
   * match. Called when no account exists, so the response time of "no such
   * username" and "wrong password" do not differ.
   */
  spendDummyWork(): Promise<void>;
}
