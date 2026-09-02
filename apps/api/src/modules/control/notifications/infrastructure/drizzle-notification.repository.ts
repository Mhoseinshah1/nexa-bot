import { and, asc, desc, eq, lt, lte, inArray, ne, sql } from 'drizzle-orm';
import type {
  DeliveryOutcome,
  IdGenerator,
  NotificationDestination,
  NotificationKind,
  NotificationStatus,
  NotificationTransportKind,
  ScopeContext,
  TemplateKey,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  notificationDeliveryAttempts,
  notificationReleasedClaims,
  notifications,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactSecretText } from '../../../../infrastructure/redaction.js';
import type {
  DeliveryAttemptRecord,
  NotificationIntent,
  NotificationRepository,
  ReleasedClaimRecord,
} from '../application/ports.js';

/**
 * What an intent has actually spent, as SQL.
 *
 * `attempt_count` counts claims ISSUED and never goes down — a claim whose
 * process died with the socket open has to count, or a crash-looping worker
 * retries for ever. Capacity is returned instead by recording the claims that
 * provably never reached the transport, so what remains is the difference.
 *
 * Derived rather than stored, because a stored counter has to be decremented,
 * and a decrement has to decide WHICH claim it belongs to. That decision is
 * what could not be made correctly: matching the current `attempt_count` meant
 * two claims releasing out of order lost one of them.
 */
const spentAttempts = sql`(
  ${notifications.attemptCount} - (
    SELECT count(*)
      FROM ${notificationReleasedClaims}
     WHERE ${notificationReleasedClaims.tenantId} = ${notifications.tenantId}
       AND ${notificationReleasedClaims.notificationId} = ${notifications.id}
  )
)`;

/**
 * The sweep's own bookkeeping row, not a transport refusal.
 *
 * `failExhausted` writes a FAILED_PERMANENT attempt so a terminal intent always
 * has a record of why. That row is a judgement this module made about a missing
 * outcome — unlike a real FAILED_PERMANENT, which is the transport's own
 * refusal — so it is the one such row a later hand-back is allowed to overturn.
 */
const ATTEMPTS_EXHAUSTED_CODE = 'notification.attempts_exhausted';

type Row = typeof notifications.$inferSelect;
type AttemptRow = typeof notificationDeliveryAttempts.$inferSelect;

/**
 * `releasedCount` is how many of this intent's claims were handed back without
 * reaching the transport. Zero unless a caller has counted them: only the
 * dispatch path needs it, and a read that has not counted must not pretend it
 * has — the field says what was measured, not what was assumed.
 */
function toIntent(row: Row, releasedCount = 0): NotificationIntent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as NotificationKind,
    dedupeKey: row.dedupeKey,
    // Cast here, VALIDATED at the point of use.
    //
    // Parsing in this mapper was the obvious move and was worse than the cast
    // it replaced. `claimDue` maps inside its own transaction, so one row whose
    // destination did not parse threw out of the transaction, rolled the claim
    // back, and left that row first in the queue — every subsequent tick
    // selected it, threw, and rolled back. The whole installation's dispatcher
    // would have stopped delivering, for every tenant, permanently, with no
    // attempt row and nothing visible in the admin UI. It also made one bad row
    // able to 500 `list()` for the tenant, so an operator could not even see
    // the queue that had stopped.
    //
    // The dispatcher validates a destination per intent, inside the per-intent
    // error handling that already exists, so a bad one fails that notification
    // and nothing else.
    destination: row.destination as NotificationDestination,
    payload: row.payload as Record<string, unknown>,
    templateKey: row.templateKey as TemplateKey,
    status: row.status as NotificationStatus,
    attemptCount: row.attemptCount,
    releasedCount,
    maxAttempts: row.maxAttempts,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    lastAttemptAt: row.lastAttemptAt,
    nextAttemptAt: row.nextAttemptAt,
    completedAt: row.completedAt,
  };
}

function toAttempt(row: AttemptRow): DeliveryAttemptRecord {
  return {
    id: row.id,
    notificationId: row.notificationId,
    attemptNumber: row.attemptNumber,
    transport: row.transport as NotificationTransportKind,
    outcome: row.outcome as DeliveryOutcome,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    retryAfterMs: row.retryAfterMs,
  };
}

/**
 * A transport's error text, redacted and bounded.
 *
 * The first version wrapped the message in `{ message }` and passed it to
 * `redactRecord`, under a comment saying it therefore shared the one
 * implementation of the rules. It did not: `redactRecord` decides by KEY, the
 * key was `message`, `message` matches no sensitive fragment, and the value was
 * returned exactly as it arrived. The function truncated and nothing else,
 * while its own comment said it redacted.
 *
 * A sentence needs a rule about its CONTENT, which `redactSecretText` is — and
 * this is the one sink where that matters, because Telegram's API errors quote
 * the request URL and the bot token is a segment of it.
 */
function redactErrorMessage(message: string | null): string | null {
  // REDACT, then truncate. The other order cut a bot token in half at offset
  // 2000, which took the surviving fragment below the pattern's length
  // threshold — so the slice defeated the redaction and stored the first half
  // of a credential.
  return message === null ? null : redactSecretText(message).slice(0, 2000);
}

function executorOf(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
  ) {}

  async create(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly kind: NotificationKind;
      readonly dedupeKey: string;
      readonly destination: NotificationDestination;
      readonly payload: Record<string, unknown>;
      readonly templateKey: TemplateKey;
      readonly maxAttempts: number;
      readonly correlationId: string | null;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<{ intent: NotificationIntent; created: boolean }> {
    const tenantId = requireTenantId(scope);
    const executor = executorOf(this.db, tx);

    const inserted = await executor
      .insert(notifications)
      .values({
        id: input.id,
        tenantId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        destination: input.destination,
        payload: input.payload,
        templateKey: input.templateKey,
        status: 'PENDING',
        attemptCount: 0,
        maxAttempts: input.maxAttempts,
        correlationId: input.correlationId,
        createdAt: input.now,
        nextAttemptAt: input.now,
      })
      // The dedupe key is the intent's identity. A second report of the same
      // condition is not an error and must not become a second message.
      .onConflictDoNothing({ target: [notifications.tenantId, notifications.dedupeKey] })
      .returning();

    if (inserted[0]) return { intent: toIntent(inserted[0]), created: true };

    const [existing] = await executor
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.tenantId, tenantId), eq(notifications.dedupeKey, input.dedupeKey)),
      )
      .limit(1);
    if (!existing) {
      throw new Error('notifications insert conflicted but the conflicting row is not visible.');
    }
    return { intent: toIntent(existing), created: false };
  }

  async findById(
    scope: ScopeContext,
    id: string,
    tx?: unknown,
  ): Promise<NotificationIntent | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await executorOf(this.db, tx)
      .select()
      .from(notifications)
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, id)))
      .limit(1);
    return row ? toIntent(row) : null;
  }

  async list(
    scope: ScopeContext,
    options: { limit: number; before?: Date; status?: NotificationStatus },
    tx?: unknown,
  ): Promise<NotificationIntent[]> {
    const tenantId = requireTenantId(scope);
    const filters = [eq(notifications.tenantId, tenantId)];
    if (options.before) filters.push(lt(notifications.createdAt, options.before));
    if (options.status) filters.push(eq(notifications.status, options.status));

    const rows = await executorOf(this.db, tx)
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(options.limit);
    return rows.map(toIntent);
  }

  async attempts(
    scope: ScopeContext,
    notificationId: string,
    tx?: unknown,
  ): Promise<DeliveryAttemptRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(notificationDeliveryAttempts)
      .where(
        and(
          eq(notificationDeliveryAttempts.tenantId, tenantId),
          eq(notificationDeliveryAttempts.notificationId, notificationId),
        ),
      )
      .orderBy(asc(notificationDeliveryAttempts.attemptNumber));
    return rows.map(toAttempt);
  }

  /**
   * The claims this intent gave back, tenant-scoped.
   *
   * The only tenant-scoped reader of this table. Everything else counts these
   * rows inside `spentAttempts`, cross-tenant, for the dispatcher; this one is
   * for a person, so it goes through `requireTenantId` like every other read a
   * surface can reach.
   */
  async releasedClaims(
    scope: ScopeContext,
    notificationId: string,
    tx?: unknown,
  ): Promise<ReleasedClaimRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executorOf(this.db, tx)
      .select()
      .from(notificationReleasedClaims)
      .where(
        and(
          eq(notificationReleasedClaims.tenantId, tenantId),
          eq(notificationReleasedClaims.notificationId, notificationId),
        ),
      )
      .orderBy(asc(notificationReleasedClaims.attemptNumber));
    return rows.map((row) => ({
      attemptNumber: row.attemptNumber,
      releasedAt: row.releasedAt,
      reason: row.reason,
    }));
  }

  /**
   * Claims due intents for the dispatcher.
   *
   * Cross-tenant by necessity and by design: this is installation housekeeping,
   * the same family as `RetentionSweeper`, with no actor to authorize and no one
   * tenant to scope to. It is reachable only from the worker process — a
   * boundary check asserts no surface imports the dispatcher.
   *
   * The claim increments the attempt counter and pushes `next_attempt_at` out by
   * a lease BEFORE the send. If the process dies with the socket open, the row
   * becomes due again when the lease expires instead of being held by a
   * dispatcher that no longer exists, and the attempt counter already reflects
   * the try that vanished.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<NotificationIntent[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.status, 'PENDING'),
            lte(notifications.nextAttemptAt, now),
            // The tenant has to be open for business, the same rule the outbox
            // relay applies to a domain event and for the same reason: a
            // tenant's status is a system-wide kill switch, and a notification
            // queued while it was ACTIVE would otherwise still leave the
            // process after somebody stopped the installation.
            //
            // The row stays PENDING rather than being failed. A stop is not a
            // verdict on the message; it is a pause, and the alert is still
            // worth sending when the tenant comes back.
            inArray(
              notifications.tenantId,
              tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'ACTIVE')),
            ),
            // The backstop. Abandonment normally happens in `recordAttempt`,
            // which is exactly the code that does not run when a dispatch
            // throws before it — so an intent that has already spent its
            // attempts is refused here rather than being claimed forever.
            //
            // SPENT, not claimed. A claim handed back without reaching the
            // transport did not use an attempt, and reading `attempt_count`
            // directly meant a tenant stopped and restarted a few times could
            // exhaust a message that had never been sent once.
            sql`${spentAttempts} < ${notifications.maxAttempts}`,
          ),
        )
        .orderBy(asc(notifications.nextAttemptAt))
        .limit(limit)
        .for('update', { skipLocked: true });

      if (due.length === 0) return [];

      const claimed = await tx
        .update(notifications)
        .set({
          attemptCount: sql`${notifications.attemptCount} + 1`,
          lastAttemptAt: now,
          nextAttemptAt: new Date(now.getTime() + leaseMs),
        })
        .where(
          inArray(
            notifications.id,
            due.map((row) => row.id),
          ),
        )
        .returning();
      // Each claimed intent carries its own release count, so the dispatcher
      // can decide abandonment on SPEND rather than on the claim number. The
      // counter is monotonic now, so `attempt_count` alone says how many times
      // the row has been picked up — not how many attempts it has used.
      const releases = await tx
        .select({
          notificationId: notificationReleasedClaims.notificationId,
          count: sql<number>`count(*)::int`,
        })
        .from(notificationReleasedClaims)
        .where(
          inArray(
            notificationReleasedClaims.notificationId,
            claimed.map((row) => row.id),
          ),
        )
        .groupBy(notificationReleasedClaims.notificationId);
      const byId = new Map(releases.map((r) => [String(r.notificationId), r.count]));
      return claimed.map((row) => toIntent(row, byId.get(String(row.id)) ?? 0));
    });
  }

  /**
   * Which of these tenants are ACTIVE, asked fresh.
   *
   * Cross-tenant by the same argument as `claimDue`: it is asked BY the
   * dispatcher, about the batch the dispatcher is already holding, and there
   * is no actor to authorize. The boundary check names it alongside the other
   * two, so a surface that reached for it fails the build.
   */
  async activeTenants(tenantIds: readonly string[]): Promise<Set<string>> {
    if (tenantIds.length === 0) return new Set();
    const rows = await this.db.transaction(async (tx) =>
      tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.status, 'ACTIVE'), inArray(tenants.id, [...tenantIds]))),
    );
    return new Set(rows.map((row) => String(row.id)));
  }

  /**
   * Un-claims an intent: due again now, with its attempt given back.
   *
   * `attempt_count - 1` is the half that matters. Leaving the counter spent
   * would mean a tenant stopped and started three times had silently consumed
   * a message's whole allowance without ever sending it — the row would then
   * be swept to FAILED by `failExhausted`, reporting a permanent delivery
   * failure for a message no transport was ever asked to carry.
   */
  async releaseClaim(input: {
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly now: Date;
    readonly reason: string;
  }): Promise<{ released: boolean; restored: boolean }> {
    return this.db.transaction(async (tx) => {
      // The release is a FACT about one attempt number, and the primary key is
      // its identity. Two consequences that the old decrement did not have:
      // order does not matter, so two outstanding claims handing back in
      // either order each restore their own capacity; and a repeat is a no-op,
      // so a caller whose commit outcome is unknown may safely try again
      // instead of guessing.
      //
      // Refused if that attempt actually reached the transport. A release
      // means "no transport call happened", and an attempt row is the proof
      // that one did — without this guard a late release could hand back
      // capacity for a message that was really sent.
      const inserted = await tx
        .insert(notificationReleasedClaims)
        .select(
          tx
            .select({
              tenantId: sql`${input.tenantId}::uuid`.as('tenant_id'),
              notificationId: sql`${input.notificationId}::uuid`.as('notification_id'),
              attemptNumber: sql`${input.attemptNumber}::integer`.as('attempt_number'),
              releasedAt: sql`${input.now}::timestamptz`.as('released_at'),
              reason: sql`${input.reason}::text`.as('reason'),
            })
            .from(notifications)
            .where(
              and(
                eq(notifications.tenantId, input.tenantId),
                eq(notifications.id, input.notificationId),
                sql`NOT EXISTS (
                  SELECT 1 FROM ${notificationDeliveryAttempts}
                   WHERE ${notificationDeliveryAttempts.tenantId} = ${input.tenantId}
                     AND ${notificationDeliveryAttempts.notificationId} = ${input.notificationId}
                     AND ${notificationDeliveryAttempts.attemptNumber} = ${input.attemptNumber}
                )`,
                // Only a claim that was actually ISSUED can be handed back.
                // Spend is `attempt_count` minus these rows, so a release for
                // a number above the counter would make it negative — an
                // intent permanently claimable and never sweepable. Nothing in
                // the dispatcher can reach that today; nothing in the table
                // stopped it either.
                sql`${input.attemptNumber} <= ${notifications.attemptCount}`,
              ),
            ),
        )
        .onConflictDoNothing()
        .returning({ attemptNumber: notificationReleasedClaims.attemptNumber });

      const released = inserted.length > 0;

      // Whether or not this call was the one that recorded it, the intent's
      // derived state is brought up to date: due again now, `last_attempt_at`
      // back to the last attempt that actually happened, and — if a sweep had
      // already written the intent off while this claim was outstanding — out
      // of that verdict again.
      //
      // FAILED back to PENDING is the same class of correction as the accepted
      // rule that a late SUCCEEDED moves FAILED to SENT: newer, better
      // evidence about an attempt overrides a judgement made without it. It is
      // deliberately narrow. Only an EXHAUSTION verdict is reversible, and
      // only while the intent is no longer exhausted; a `FAILED_PERMANENT`
      // attempt row is the transport's own refusal and is never overridden by
      // a claim that never spoke to it.
      const restoredRows = await tx
        .update(notifications)
        .set({
          // Rescheduling is the OWNER's business, and only the owner's.
          //
          // The release ROW is keyed by attempt number precisely so a stale
          // hand-back can still return its capacity — that is the whole point.
          // But the previous version dropped the ownership guard from this
          // UPDATE as well, and the two halves are not the same question. A
          // straggler releasing attempt 1 while attempt 2 holds a live lease
          // was moving `next_attempt_at` back to now, so a third worker
          // claimed and SENT the message while attempt 2's send was still in
          // flight. The lease is this module's only concurrency control, and a
          // stale releaser was cancelling it. It also wiped the back-off a
          // live attempt had just computed, turning a rate-limit wait into an
          // immediate re-send.
          //
          // So: reschedule only when this release owns the current claim, or
          // when the intent is FAILED and is being taken back out of a sweep's
          // verdict — where there is no live claim to disturb and the row must
          // become due again for anything to happen at all.
          nextAttemptAt: sql`CASE
            WHEN ${notifications.attemptCount} = ${input.attemptNumber}
              OR ${notifications.status} = 'FAILED'
            THEN ${input.now}
            ELSE ${notifications.nextAttemptAt}
          END`,
          lastAttemptAt: sql`(
            SELECT max(${notificationDeliveryAttempts.finishedAt})
              FROM ${notificationDeliveryAttempts}
             WHERE ${notificationDeliveryAttempts.tenantId} = ${notifications.tenantId}
               AND ${notificationDeliveryAttempts.notificationId} = ${notifications.id}
          )`,
          status: sql`CASE WHEN ${notifications.status} = 'FAILED' THEN 'PENDING' ELSE ${notifications.status} END`,
          // The CHECK constraint insists a terminal status carries a
          // completion time and a pending one does not, so the two move
          // together or the write is refused.
          completedAt: sql`CASE WHEN ${notifications.status} = 'FAILED' THEN NULL ELSE ${notifications.completedAt} END`,
        })
        .where(
          and(
            eq(notifications.tenantId, input.tenantId),
            eq(notifications.id, input.notificationId),
            // PENDING is the ordinary case; FAILED is the sweep-raced one. A
            // SENT intent is left entirely alone — delivery is terminal truth.
            inArray(notifications.status, ['PENDING', 'FAILED']),
            sql`${spentAttempts} < ${notifications.maxAttempts}`,
            // Only a SWEEP verdict is reversible, and it is stated positively
            // rather than as the absence of a real refusal. Asking only "is
            // there no real FAILED_PERMANENT" would also reopen an intent that
            // reached FAILED some other way — a retryable failure on its last
            // attempt, say — which is a verdict nothing here is entitled to
            // overturn. What a hand-back can correct is exactly one thing: the
            // sweep gave up waiting for an outcome that was never coming,
            // because the claim was never sent.
            sql`(
              ${notifications.status} = 'PENDING'
              OR (
                EXISTS (
                  SELECT 1 FROM ${notificationDeliveryAttempts}
                   WHERE ${notificationDeliveryAttempts.tenantId} = ${notifications.tenantId}
                     AND ${notificationDeliveryAttempts.notificationId} = ${notifications.id}
                     AND ${notificationDeliveryAttempts.outcome} = 'FAILED_PERMANENT'
                     AND ${notificationDeliveryAttempts.errorCode} = ${ATTEMPTS_EXHAUSTED_CODE}
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ${notificationDeliveryAttempts}
                   WHERE ${notificationDeliveryAttempts.tenantId} = ${notifications.tenantId}
                     AND ${notificationDeliveryAttempts.notificationId} = ${notifications.id}
                     AND ${notificationDeliveryAttempts.outcome} = 'FAILED_PERMANENT'
                     AND ${notificationDeliveryAttempts.errorCode} IS DISTINCT FROM ${ATTEMPTS_EXHAUSTED_CODE}
                )
              )
            )`,
          ),
        )
        .returning({ status: notifications.status });

      const restored = restoredRows.length > 0;
      if (restored) {
        // Retire the number the sweep already used.
        //
        // `failExhausted` writes its bookkeeping row at `attempt_count + 1`,
        // chosen so it cannot collide with the attempt that was in flight. That
        // was safe while a swept intent stayed terminal for ever. Now that a
        // hand-back can withdraw the verdict, the very next claim would be
        // handed that same number and its `recordAttempt` would die on the
        // unique index — a message sent and then unrecordable, which is the one
        // outcome this module exists to prevent.
        //
        // So the number is retired: recorded as released, because nothing was
        // sent on it, and `attempt_count` advanced past it so the pair still
        // subtracts to the attempts genuinely spent. One real attempt in, one
        // real attempt left.
        await tx.execute(sql`
          INSERT INTO ${notificationReleasedClaims}
            (tenant_id, notification_id, attempt_number, released_at, reason)
          SELECT ${notificationDeliveryAttempts.tenantId},
                 ${notificationDeliveryAttempts.notificationId},
                 ${notificationDeliveryAttempts.attemptNumber},
                 ${input.now},
                 'sweep.withdrawn'
            FROM ${notificationDeliveryAttempts}
           WHERE ${notificationDeliveryAttempts.tenantId} = ${input.tenantId}
             AND ${notificationDeliveryAttempts.notificationId} = ${input.notificationId}
             AND ${notificationDeliveryAttempts.outcome} = 'FAILED_PERMANENT'
             AND ${notificationDeliveryAttempts.errorCode} = ${ATTEMPTS_EXHAUSTED_CODE}
          ON CONFLICT DO NOTHING
        `);

        await tx
          .update(notifications)
          .set({
            attemptCount: sql`greatest(${notifications.attemptCount}, (
              SELECT coalesce(max(${notificationDeliveryAttempts.attemptNumber}), 0)
                FROM ${notificationDeliveryAttempts}
               WHERE ${notificationDeliveryAttempts.tenantId} = ${notifications.tenantId}
                 AND ${notificationDeliveryAttempts.notificationId} = ${notifications.id}
            ))`,
          })
          .where(
            and(
              eq(notifications.tenantId, input.tenantId),
              eq(notifications.id, input.notificationId),
            ),
          );
      }

      return { released, restored };
    });
  }

  /**
   * Fails intents that have spent every attempt and are still PENDING.
   *
   * Deliberately NOT filtered by tenant status, unlike `claimDue` and unlike
   * the per-intent recheck in the dispatcher's batch loop, and the asymmetry is
   * the point rather than an oversight. Those two govern SENDING, and a stopped
   * installation must not send. This governs bookkeeping about sends that have
   * already happened: an intent only reaches `attempt_count = max_attempts` by
   * being claimed, which a stopped tenant cannot be, so its attempts were
   * genuinely spent while it was active. Refusing to say so until the tenant
   * comes back would leave the row PENDING for as long as the pause lasts —
   * the "reported as pending forever" state this sweep exists to end.
   *
   * A pause is still not a verdict, and nothing here makes it one: a late
   * SUCCEEDED can move a swept row from FAILED to SENT whenever it arrives,
   * and a claim handed back by `releaseClaim` has its attempt returned, so a
   * paused tenant's queued work never reaches this predicate at all.
   *
   * Cross-tenant by necessity and by design, on exactly `claimDue`'s argument:
   * this is installation housekeeping with no actor to authorize and no one
   * tenant to scope to. It is reachable only from the worker process — the
   * boundary check names both the dispatcher and this method, so a controller
   * that reached for either fails the build.
   *
   * It exists because two correct rules leave a gap between them. `claimDue`
   * refuses a row that has spent its attempts, or it would be claimed for ever;
   * `recordAttempt` is what normally moves such a row to FAILED, and that is
   * exactly the code that does not run when a dispatch throws before it. In
   * between, a row could sit PENDING for ever: never claimed, never failed, and
   * never appearing in any list of things that went wrong. Silence is the one
   * outcome this subsystem may not produce.
   *
   * `next_attempt_at <= now - leaseMs` is the safety margin, and the margin is
   * the whole correctness argument. `<= now` alone is only proof the lease
   * EXPIRED, which is the state a slow send is in — a five-second lease and an
   * eight-second Telegram call put a live, about-to-succeed send squarely in
   * range, so the sweep would have marked a delivered message permanently
   * failed. A full extra lease of quiet is not a proof either, but it means the
   * sender has been gone for longer than the window the system already treats
   * as "long enough to assume it died", and a late success can still correct
   * the record (`recordAttempt` lets a SUCCEEDED outcome move a FAILED row).
   *
   * One statement, not a select and then an update. The two-statement version
   * re-checked less on the write than it had selected on the read, so anything
   * changing `attempt_count` or `next_attempt_at` in between was invisible to
   * it — and its `LIMIT` had no `ORDER BY`, so which rows a bounded sweep took
   * was arbitrary.
   *
   * A synthetic attempt row is written for each. Without it the intent ends
   * FAILED with a gap where the deciding attempt should be, and the verdict is
   * invented somewhere the history does not show — which is the same "a state
   * nothing recorded" failure this module exists to make hard.
   */
  async failExhausted(
    now: Date,
    limit: number,
    options: { readonly leaseMs: number; readonly transport: NotificationTransportKind },
  ): Promise<number> {
    const deadline = new Date(now.getTime() - options.leaseMs);

    return this.db.transaction(async (tx) => {
      const swept = await tx
        .update(notifications)
        .set({ status: 'FAILED', completedAt: now, nextAttemptAt: now })
        .where(
          inArray(
            notifications.id,
            tx
              .select({ id: notifications.id })
              .from(notifications)
              .where(
                and(
                  eq(notifications.status, 'PENDING'),
                  lte(notifications.nextAttemptAt, deadline),
                  // Spent, on the same reasoning as `claimDue`: an intent
                  // whose claims were handed back unsent is not exhausted, and
                  // sweeping it would report a permanent delivery failure for
                  // a message no transport was ever asked to carry.
                  sql`${spentAttempts} >= ${notifications.maxAttempts}`,
                ),
              )
              .orderBy(asc(notifications.nextAttemptAt))
              .limit(limit)
              .for('update', { skipLocked: true }),
          ),
        )
        .returning({
          id: notifications.id,
          tenantId: notifications.tenantId,
          attemptCount: notifications.attemptCount,
        });

      if (swept.length === 0) return 0;

      // `onConflictDoNothing`, because the alternative failure is catastrophic
      // and the insurance is one clause.
      //
      // A violation here would abort this transaction, `tick()` would throw
      // before claiming anything, and the installation would stop delivering
      // notifications entirely, for every tenant, on every tick, until somebody
      // deleted a row by hand. A sweep whose job is to stop silence must not be
      // able to cause it — and the first version of this insert really could,
      // by taking the number the still-running attempt would use.
      await tx
        .insert(notificationDeliveryAttempts)
        .values(
          swept.map((row) => ({
            id: this.ids.uuid(),
            tenantId: row.tenantId,
            notificationId: row.id,
            // ONE PAST the claim's number, and this is load-bearing.
            //
            // The claim's own number belongs to the attempt whose outcome was
            // never written down — and that attempt may still be running, and
            // may still succeed. `(tenant_id, notification_id, attempt_number)`
            // is unique, so taking its number meant the late success's own
            // `recordAttempt` insert threw, its transaction aborted, and the
            // status update never ran. The correction that makes this sweep's
            // safety margin an acceptable guess rather than a verdict was
            // impossible for precisely the rows the sweep had touched: a
            // delivered message filed as permanently failed, by the change
            // written to stop exactly that.
            //
            // `max_attempts + 1` is a number no claim can produce — `claimDue`
            // only increments rows still below `max_attempts` — so the two
            // records coexist: the sweep's conclusion, and then, if it lands,
            // what actually happened.
            attemptNumber: row.attemptCount + 1,
            transport: options.transport,
            outcome: 'FAILED_PERMANENT' as const,
            startedAt: now,
            finishedAt: now,
            errorCode: ATTEMPTS_EXHAUSTED_CODE,
            errorMessage:
              'The last attempt was claimed and its outcome was never recorded; ' +
              'the lease expired with no attempts left.',
            retryAfterMs: null,
          })),
        )
        .onConflictDoNothing();

      return swept.length;
    });
  }

  async recordAttempt(input: {
    readonly attemptId: string;
    readonly tenantId: string;
    readonly notificationId: string;
    readonly attemptNumber: number;
    readonly transport: NotificationTransportKind;
    readonly outcome: DeliveryOutcome;
    readonly startedAt: Date;
    readonly finishedAt: Date;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly retryAfterMs: number | null;
    readonly nextStatus: NotificationStatus;
    readonly nextAttemptAt: Date;
  }): Promise<{ readonly moved: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.insert(notificationDeliveryAttempts).values({
        id: input.attemptId,
        tenantId: input.tenantId,
        notificationId: input.notificationId,
        attemptNumber: input.attemptNumber,
        transport: input.transport,
        outcome: input.outcome,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        errorCode: input.errorCode,
        // Through a redactor, but NOT the same one as the audit log and the
        // operational log — and this comment said it was, which was the second
        // half of the same mistake as the function it calls.
        //
        // Those two carry structured records and are redacted by KEY. This
        // column carries a sentence from a third party, so the rule has to be
        // about CONTENT. Two rules, two coverage sets, one sink each.
        errorMessage: redactErrorMessage(input.errorMessage),
        retryAfterMs: input.retryAfterMs,
      });

      // Which rows this outcome is allowed to move.
      //
      // A dispatcher whose send outlives its lease is not impossible: the lease
      // exists precisely so a stalled sender's work becomes available again.
      // PENDING alone was not enough to make that safe. Attempt 1 could return
      // RETRYABLE after attempt 2 had claimed the row, replace attempt 2's
      // lease with a short back-off, and let attempt 3 start alongside it —
      // after which attempt 3 could mark the intent FAILED while attempt 2's
      // send was actually succeeding, and attempt 2's own update would then be
      // the one rejected. A delivered message, recorded as permanently failed,
      // by two writers each behaving correctly on its own.
      //
      // `attempt_count` is the claim's identity: it is incremented by the claim
      // and names the attempt in flight. Matching it means a stale writer's
      // status update is a no-op.
      //
      // SUCCESS is the exception, deliberately, and it is a WIDER predicate
      // rather than merely a looser one.
      //
      // Delivery is terminal truth whoever observed it. A late success ends the
      // intent, which stops the next attempt sending the same message again;
      // and it may end an intent `failExhausted` has already written off, which
      // is the correction that makes the sweep's safety margin an acceptable
      // guess rather than a verdict. The only status it may not overwrite is
      // SENT, which already says the same thing.
      //
      // Everything else requires OWNERSHIP of the claim. `attempt_count` is the
      // claim's identity: it is incremented by the claim and names the attempt
      // in flight, so a writer whose send outlived its lease finds it changed
      // and its update matches nothing.
      const predicate =
        input.outcome === 'SUCCEEDED'
          ? [ne(notifications.status, 'SENT')]
          : [
              eq(notifications.status, 'PENDING'),
              eq(notifications.attemptCount, input.attemptNumber),
            ];

      // `last_attempt_at` moves forward for this attempt, unconditionally and
      // separately from the status update below.
      //
      // Separately, because the status update has a predicate that can refuse:
      // a straggler whose send outlived its lease still HAPPENED, and the row
      // recording it is written either way, so the timestamp saying when the
      // intent was last attempted must be written either way too.
      //
      // `greatest` rather than assignment, because outcomes do not arrive in
      // order. A straggler landing after a newer attempt must not drag the
      // timestamp backwards — and `releaseClaim` recomputes it from the attempt
      // rows, which cannot see an attempt still in flight, so without this a
      // release would rewind the timestamp and the late outcome would never
      // push it forward again. The operations view then reported an older
      // attempt, or none, for a delivery that had completed.
      await tx
        .update(notifications)
        .set({
          // PostgreSQL's `greatest` IGNORES nulls — unlike the SQL standard,
          // where any null argument makes the whole expression null — so a row
          // whose `last_attempt_at` is null yields `finishedAt`, and the
          // `coalesce` this used to wrap it in was doing nothing for any
          // possible value. `finishedAt` is a bound parameter and never null,
          // so the all-null case cannot arise either.
          lastAttemptAt: sql`greatest(${notifications.lastAttemptAt}, ${input.finishedAt})`,
        })
        .where(
          and(
            eq(notifications.tenantId, input.tenantId),
            eq(notifications.id, input.notificationId),
          ),
        );

      // The attempt row above is written either way, because it happened.
      const moved = await tx
        .update(notifications)
        .set({
          status: input.nextStatus,
          nextAttemptAt: input.nextAttemptAt,
          // The CHECK constraint insists a terminal status carries a completion
          // time and a pending one does not, so the two can never disagree.
          completedAt: input.nextStatus === 'PENDING' ? null : input.finishedAt,
        })
        .where(
          and(
            eq(notifications.tenantId, input.tenantId),
            eq(notifications.id, input.notificationId),
            ...predicate,
          ),
        )
        .returning({ id: notifications.id });

      return { moved: moved.length > 0 };
    });
  }
}
