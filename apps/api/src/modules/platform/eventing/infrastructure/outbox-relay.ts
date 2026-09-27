import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  DELIVERY_MAX_FAILED_ATTEMPTS,
  OUTBOX_MESSAGE_EXHAUSTED_CODE,
  deliveryRetryDelayMs,
  systemContext,
  type OperationalEventRecorder,
  type Clock,
  type DomainEvent,
  type EventType,
  type Logger,
  type ActorRef,
  type ScopeContext,
} from '@nexa/contracts';
import type {
  Database,
  DatabaseHandle,
  Executor,
} from '../../../../infrastructure/persistence/database.js';
import { withinTransaction } from '../../../../infrastructure/transaction-boundary.js';
import {
  UNGATED,
  type InstallationWriteGate,
} from '../../../../infrastructure/persistence/write-gate.js';
import {
  outboxMessages,
  processedMessages,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type { EventConsumer } from '../application/event-consumer.js';
import { LoopProgress } from '../../../../infrastructure/lifecycle/loop-progress.js';

export interface OutboxRelayOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly maxLagMs: number;
}

export interface RelayBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

/**
 * How long the relay waits before its next batch (WP16 R1,
 * `docs/wp16-admin-ops-audit.md`).
 *
 * Drain at once while a batch PUBLISHED something; otherwise wait the poll interval.
 *
 * The earlier rule was "drain at once while a batch CLAIMED something", and a
 * message whose consumer always throws is claimed by every batch. So one poison
 * message kept the relay spinning in a zero-delay loop, one failed transaction and
 * one error line per spin, for as long as the bug lasted — the "backs off" in the
 * class comment below was not true. A batch that claimed work and published none
 * made no progress, and the next one would make none either until something
 * changed, so it waits like an idle one.
 *
 * WP20 (brief §3.1) added the other half: a failed message is rescheduled on its own
 * `next_attempt_at`, so a poison message no longer takes a batch slot on every poll and
 * the messages behind it are claimed meanwhile.
 */
export function nextRelayDelayMs(result: RelayBatchResult, pollIntervalMs: number): number {
  return result.published > 0 ? 0 : pollIntervalMs;
}

/**
 * The outbox relay.
 *
 * Claims unpublished rows with FOR UPDATE SKIP LOCKED so several relay
 * instances are safe to run at once, dispatches each to the consumers that
 * subscribe to it, then marks the row published.
 *
 * Delivery is at-least-once by construction: a crash between dispatch and the
 * `published_at` update replays the message. That is why every consumer records
 * its own applied event ids in `processed_messages` — the redelivery is
 * received, and its effect happens once.
 *
 * "Once" is only true because the claim and the effect are ONE transaction.
 * Each consumer receives the relay's transaction and writes through it, so the
 * `processed_messages` row and whatever the consumer wrote commit together or
 * roll back together. The earlier shape — the claim inside the relay's
 * transaction, the effect on the consumer's own pooled connection — was two
 * commits: the effect could land and the claim then roll back, and the
 * redelivery applied the effect again. Worse, a consumer that THREW left its
 * claim committed beside the failure bookkeeping, so the retry found the pair
 * already claimed, skipped the consumer, and marked the message published with
 * no effect ever having happened.
 *
 * Each message is dispatched under its own SAVEPOINT. A consumer failure rolls
 * back that message's claim and partial effect while the batch transaction
 * stays usable, so the attempt count and error can still be recorded and the
 * other messages in the batch still publish.
 *
 * A failed message is rescheduled on its own row (WP20, brief §3.1):
 * `deliveryRetryDelayMs` after the Nth failure (5 s, 15 s, 60 s, 5 min, 15 min, then an
 * hour), and only due rows are claimed. After `DELIVERY_MAX_FAILED_ATTEMPTS` real
 * failures it is EXHAUSTED (brief §3.2): no longer claimed, never deleted and never
 * marked published, counted in the system diagnostics, and announced once as an
 * operational event. There is still no dead-letter queue and no control that makes a
 * message succeed: an event that cannot be delivered is a bug to fix.
 *
 * Ordering is per aggregate, as the table promises. A message is not claimed while an
 * earlier message of its aggregate is unpublished and not exhausted, so a failure holds
 * back its own aggregate's later events and nothing else. An exhausted message stops
 * holding them back: it is evidence now, and waiting on it would be waiting for ever.
 *
 * A batch that publishes nothing waits the poll interval before the next
 * (`nextRelayDelayMs`), and lag beyond `maxLagMs` makes the process unhealthy so it is
 * visible rather than silent. An exhausted message is excluded from the lag: it is shown
 * in the diagnostics instead, and would otherwise keep the worker unhealthy for good.
 */
export class OutboxRelay {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Whether the relay is still relaying, for the worker's health check.
   *
   * The failure this catches is specific and silent: if `processBatch` HANGS
   * rather than throwing, `tick` never reaches `scheduleNext`, `running` stays
   * true so `start()` is a no-op, and nothing restarts it. The worker's
   * heartbeat keeps writing because `SELECT 1` on another checkout still
   * succeeds, and the API's outbox-lag probe reports zero lag whenever the
   * outbox happens to be empty. A dead relay in a quiet period was green
   * everywhere, and the first sign was five minutes after traffic resumed.
   */
  private readonly progress: LoopProgress;

  constructor(
    private readonly db: Database,
    private readonly consumers: readonly EventConsumer[],
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: OutboxRelayOptions,
    /**
     * The pool handle, needed only for `lagMsWithin`.
     *
     * Optional because the relay's own loop runs on `db` and has no use for a
     * second checkout; the readiness probe is the only caller that needs its
     * statements bounded by a deadline, and it is a surface, so the checkout
     * has to be opened on this side of the boundary.
     */
    private readonly database?: DatabaseHandle,
    /**
     * The installation write gate. See `processBatch`.
     *
     * Defaulted to `UNGATED` rather than made required, because this constructor
     * has seven parameters and a required eighth would have to be threaded
     * through every test that builds a relay directly — and a test that
     * constructs one to check batching is not a test about recovery. The
     * container passes the real gate, and `worker-loop-health.test.ts` asserts
     * it does, so the default cannot quietly become production's.
     */
    private readonly gate: InstallationWriteGate = UNGATED,
    /**
     * Where an exhausted message is announced (WP20, brief §3.2). Optional for the same
     * reason as the gate; the container passes the real recorder.
     */
    private readonly opsEvents?: Pick<OperationalEventRecorder, 'record'>,
  ) {
    this.progress = new LoopProgress(options.pollIntervalMs);
  }

  /** Whether a batch has completed recently enough. See `LoopProgress`. */
  isFresh(nowMs: number): boolean {
    return this.progress.isFresh(nowMs);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.progress.begin(this.clock.now().getTime());
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A stopped relay makes no claim.
    this.progress.end();
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let result: RelayBatchResult = { claimed: 0, published: 0, failed: 0 };
    try {
      result = await this.processBatch();
    } catch (error) {
      this.logger.error({ err: String(error) }, 'Outbox relay batch failed');
    }
    // Drain quickly while batches make progress; idle politely when they do not.
    this.scheduleNext(nextRelayDelayMs(result, this.options.pollIntervalMs));
  }

  /**
   * Processes one batch. Exposed so tests can drive the relay deterministically
   * instead of waiting on a timer.
   */
  async processBatch(): Promise<RelayBatchResult> {
    /*
     * MARKED as a transaction, so `assertOutsideTransaction` refuses a consumer
     * that sends.
     *
     * This was the hole in item D's fix. `withinTransaction` is called by the unit
     * of work, and the relay opens its claim transaction on the database handle
     * directly — so inside the one transaction `transaction-boundary.ts` names as
     * "the case that makes this urgent rather than theoretical" the guard's store
     * was empty and every sink permitted the call. The rule was enforced
     * everywhere except where it was needed.
     *
     * The label is `system:relay` rather than a tenant's, because the batch spans
     * tenants: it claims whatever is eligible, and a refusal naming one of them
     * would name the wrong one. `transactionLabelFor` produces the same
     * `system:<reason>` shape for a system scope.
     *
     * Not routed through `uow.run`: the unit of work takes one scope and hands the
     * callback one `TransactionScope`, and this transaction deliberately has
     * neither — it reads the tenant table to decide eligibility and dispatches
     * work belonging to several tenants under a savepoint each.
     */
    const result = await withinTransaction('system:relay', () =>
      this.db.transaction(async (tx) => {
        /*
         * THE QUIESCE GATE, again, because this transaction is not the unit of
         * work's.
         *
         * The relay is the one durable write path in this codebase that opens its
         * own transaction on the database handle — which is exactly why item D's
         * fix missed it, and exactly why the quiesce would miss it too. A relay
         * that went on publishing during a cutover would be dispatching work
         * belonging to a database that is about to be replaced, and the consumer
         * effects it commits would be in the OUTGOING database while the messages
         * that caused them survive in the restored one.
         *
         * Left UNCLAIMED rather than claimed-and-skipped, and returned as an
         * ordinary empty batch: the messages are still there, in order, when the
         * recovery finishes — the same treatment a stopped tenant's messages get,
         * and for the same reason.
         */
        const quiescedBy = await this.gate.quiescedBy({ tx });
        if (quiescedBy !== null) {
          this.logger.info(
            { recoveryId: quiescedBy },
            'outbox relay is idle: a recovery is restoring this installation',
          );
          return { claimed: 0, published: 0, failed: 0 };
        }

        // Work belonging to a tenant that is not ACTIVE is left UNCLAIMED, not
        // discarded and not marked published. `eligibleForDispatch` below is the
        // one statement of that rule; readiness uses it too, so the two cannot
        // disagree about what is pending.
        //
        // Stopping a tenant now ends its Web Admin logins and its Telegram
        // intake; a relay that went on dispatching would leave the one half of
        // the installation that talks to the outside world still talking —
        // notifications sent, provisioning performed — for an installation
        // somebody switched off. Skipping rather than dropping is the other half
        // of that: the messages are still there, in order, when the tenant is
        // started again. A message with no tenant is platform work and always
        // eligible.
        const eligible = eligibleForDispatch(await this.activeTenantIds(tx));
        const now = this.clock.now();

        const claimed = await tx
          .select()
          .from(outboxMessages)
          .where(
            and(
              isNull(outboxMessages.publishedAt),
              eligible,
              notExhausted(),
              // Due: never failed, or its own back-off has run out (WP20).
              or(isNull(outboxMessages.nextAttemptAt), lte(outboxMessages.nextAttemptAt, now)),
              noEarlierLiveSibling(),
            ),
          )
          .orderBy(asc(outboxMessages.occurredAt), asc(outboxMessages.sequence))
          .limit(this.options.batchSize)
          .for('update', { skipLocked: true });

        let published = 0;
        let failed = 0;

        // Aggregates whose message failed in THIS batch. Their later messages in the
        // same batch are left unclaimed: a message never overtakes an earlier one of its
        // own aggregate. Across batches the claim's sibling rule does the same. Keyed by
        // tenant too, as that rule is: an aggregate id is not unique across tenants.
        const held = new Set<string>();
        for (const row of claimed) {
          const aggregate = `${row.tenantId ?? '-'}:${row.aggregateType}:${row.aggregateId}`;
          if (held.has(aggregate)) continue;
          // The eligibility above was evaluated when the row was SELECTed, and
          // `FOR UPDATE` locked the message, not its tenant — so a stop could
          // commit between the claim and the dispatch and the delivery would go
          // out anyway, which is the one thing the pause exists to prevent.
          //
          // Locking the tenant row here holds the answer still for the rest of
          // this transaction: a status change either committed before this and is
          // seen, or waits until the dispatch is done. `FOR SHARE` rather than
          // `FOR UPDATE` because several relay workers may hold this at once —
          // they are readers of the status, not writers of it.
          if (row.tenantId !== null && !(await this.tenantIsActive(tx, row.tenantId))) {
            continue;
          }

          const event = toDomainEvent(row);
          try {
            // A SAVEPOINT per message. Drizzle turns a nested `transaction()` on
            // a transaction into SAVEPOINT / ROLLBACK TO, so a consumer that
            // throws takes its claim and its half-written effect back with it —
            // and the batch transaction is still live for the bookkeeping below.
            // Without the savepoint the failed statement would have aborted the
            // whole transaction, and "record the attempt" would itself fail
            // with `current transaction is aborted`.
            await tx.transaction(async (attempt) => {
              await this.dispatch(attempt, event);
              await attempt
                .update(outboxMessages)
                .set({ publishedAt: this.clock.now(), lastError: null, nextAttemptAt: null })
                .where(sql`${outboxMessages.id} = ${row.id}`);
            });
            published += 1;
          } catch (error) {
            failed += 1;
            const message = error instanceof Error ? error.message : String(error);
            held.add(aggregate);
            const failures = row.attempts + 1;
            const exhausted = failures >= DELIVERY_MAX_FAILED_ATTEMPTS;
            const recordFailure = (executor: typeof tx, markExhausted: boolean) =>
              executor
                .update(outboxMessages)
                .set({
                  attempts: sql`${outboxMessages.attempts} + 1`,
                  lastError: message.slice(0, 2000),
                  // Its own row only (WP20): the rest of the batch and the queue behind
                  // it are not held up. Null once exhausted, since nothing will retry it.
                  nextAttemptAt: markExhausted
                    ? null
                    : new Date(this.clock.now().getTime() + deliveryRetryDelayMs(failures)),
                  // Exhaustion is a MARK, written where it is announced, never inferred
                  // from the count: the release before WP20 retried a failing message on
                  // every poll, so a row can reach the count without this relay ever
                  // deciding or saying so. Such a row is still claimed, fails once more
                  // here, and is exhausted and announced then — never exhausted in silence.
                  ...(markExhausted ? { exhaustedAt: this.clock.now() } : {}),
                })
                .where(sql`${outboxMessages.id} = ${row.id}`);
            if (exhausted) {
              try {
                // The mark and its announcement in ONE savepoint. An announcement that
                // throws takes the mark back with it, not the batch: the batch's other
                // messages still publish, and this one is counted, rescheduled and left
                // to be exhausted — and announced — by its next failure. Without the
                // savepoint the throw rolled back the whole batch, and the same message,
                // claimed first on every poll, stalled the relay for every tenant.
                await tx.transaction(async (mark) => {
                  await recordFailure(mark, true);
                  await this.opsEvents?.record(
                    scopeOf(event),
                    {
                      code: OUTBOX_MESSAGE_EXHAUSTED_CODE,
                      severity: 'ERROR',
                      message: `Outbox message ${event.eventType} failed ${String(failures)} times and is no longer retried automatically.`,
                      context: {
                        eventId: event.eventId,
                        eventType: event.eventType,
                        aggregateType: row.aggregateType,
                        attempts: failures,
                      },
                      // One event per message: each exhausted message is its own fact.
                      dedupeKey: event.eventId,
                    },
                    // A transaction SCOPE, as every consumer is handed: the recorder joins
                    // this transaction only through one, and its projection — the
                    // notification that tells an operator — refuses anything else.
                    { tx: mark, scope: scopeOf(event) },
                  );
                });
                this.logger.error(
                  { eventId: event.eventId, eventType: event.eventType, attempts: failures },
                  'Outbox message exhausted its retries; kept as evidence, not retried',
                );
              } catch (announceError) {
                await recordFailure(tx, false);
                this.logger.error(
                  {
                    eventId: event.eventId,
                    eventType: event.eventType,
                    err: String(announceError),
                  },
                  'Outbox message exhaustion could not be announced; it will be retried and announced later',
                );
              }
            } else {
              await recordFailure(tx, false);
              this.logger.error(
                { eventId: event.eventId, eventType: event.eventType, err: message },
                'Outbox consumer failed; message will be retried',
              );
            }
          }
        }

        return { claimed: claimed.length, published, failed };
      }),
    );
    // Progress, recorded on a batch that COMPLETED rather than on the scheduled
    // tick that called it. A finished batch is progress whoever asked for it,
    // and recording it here is what makes the rule reachable from a test
    // without waiting on a timer — `tick` is private and only the timer calls
    // it, so a rule recorded there could not be isolated by any test, which is
    // how the first version of this survived its own falsification run.
    //
    // Deliberately NOT reached when the batch throws: `tick` catches and logs,
    // and a caught-and-logged failure is precisely the state this reports.
    this.progress.record(this.clock.now().getTime());
    return result;
  }

  private async dispatch(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    event: DomainEvent,
  ): Promise<void> {
    for (const consumer of this.consumers) {
      if (!consumer.subscribesTo.includes(event.eventType as EventType)) continue;

      // Effectively-once: claim the (consumer, event) pair first. If the insert
      // reports no row, another delivery already applied it and we skip.
      const claim = await tx
        .insert(processedMessages)
        .values({ consumer: consumer.name, messageId: event.eventId })
        .onConflictDoNothing()
        .returning({ messageId: processedMessages.messageId });

      if (claim.length === 0) continue;

      // The consumer's effect goes through THIS transaction — the one that
      // holds the claim — so the two are one commit. Handing it the scope the
      // event belongs to lets a consumer that records by scope do so without
      // reconstructing it.
      await consumer.handle(event, { tx, scope: scopeOf(event) });
    }
  }

  /**
   * Whether this tenant is open for business, held still for the transaction.
   *
   * Read on the relay's own connection inside the claim transaction, so a
   * concurrent status change cannot slip between the decision and the delivery.
   */
  private async tenantIsActive(tx: Executor, tenantId: string): Promise<boolean> {
    const [row] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for('share');
    return row?.status === 'ACTIVE';
  }

  /**
   * Oldest DISPATCHABLE unpublished message age, for readiness reporting.
   *
   * The same eligibility the claim uses, deliberately. Work paused because its
   * tenant is stopped is never going to publish while that lasts, so counting
   * it would make readiness fall behind for as long as the pause — and an
   * installation somebody switched off on purpose would report itself unready,
   * indefinitely, and be pulled out of service. The relay is healthy; it is
   * waiting, which is what it was told to do.
   */
  /**
   * `lagMs` on a checkout whose statements PostgreSQL will cancel at `deadlineAt`.
   *
   * Here rather than in the readiness probe because opening a checkout is
   * database access, and the probe is a surface. The probe asks for the lag; it
   * does not hold a connection to get it.
   */
  async lagMsWithin(deadlineAt: number): Promise<number> {
    if (this.database === undefined) return this.lagMs();
    return this.database.withExecutor((executor) => this.lagMs(executor), { deadlineAt });
  }

  async lagMs(executor: Executor = this.db): Promise<number> {
    // The executor is a parameter so the readiness probe can run this on a
    // connection whose statement timeout it has bounded; on the pool it would
    // run under the pool's much longer default and outlive the probe.
    const [row] = await executor
      .select({ occurredAt: outboxMessages.occurredAt })
      .from(outboxMessages)
      .where(
        and(
          isNull(outboxMessages.publishedAt),
          eligibleForDispatch(await this.activeTenantIds(executor)),
          // An exhausted message is in the diagnostics, not the lag (WP20).
          notExhausted(),
        ),
      )
      .orderBy(asc(outboxMessages.occurredAt))
      .limit(1);
    if (!row) return 0;
    return this.clock.now().getTime() - row.occurredAt.getTime();
  }

  /**
   * The tenants currently open for business.
   *
   * One installation serves one customer (ADR-0001), so this is a handful of
   * rows at most — cheap enough to read per batch, and far cheaper than making
   * the planner ask the same question once per unpublished message.
   */
  private async activeTenantIds(tx?: Executor): Promise<string[]> {
    const rows = await (tx ?? this.db)
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.status, 'ACTIVE'));
    return rows.map((row) => row.id);
  }

  async isHealthy(): Promise<boolean> {
    return (await this.lagMs()) <= this.options.maxLagMs;
  }
}

/**
 * Which unpublished rows this relay may act on.
 *
 * A message with no tenant is platform work and always eligible. A
 * tenant-scoped one is eligible only while its tenant is ACTIVE: stopping a
 * tenant ends its Web Admin logins and its Telegram intake, and a relay that
 * kept dispatching would leave the half of the installation that talks to the
 * outside world still talking. Skipped, never dropped — the rows stay
 * unpublished, in order, for when the tenant comes back.
 */
function eligibleForDispatch(activeTenantIds: readonly string[]) {
  // An ID LIST, not a correlated EXISTS.
  //
  // As a subquery this had to be evaluated per row, and the only index over
  // unpublished messages orders them by occurrence time — so proving that a
  // stopped tenant's large backlog contains nothing dispatchable meant
  // inspecting every paused row, on every relay poll AND every readiness check.
  // Harmless until connections carried a statement timeout; after it, an
  // installation deliberately paused would start reporting errors instead of
  // sitting healthily idle, which is the opposite of what pausing is for.
  //
  // The list is a snapshot, and that is safe because it is not the authority:
  // every row is re-checked against its tenant under `FOR SHARE` at dispatch,
  // which is what actually stops delivery. This filter only decides what is
  // worth looking at.
  if (activeTenantIds.length === 0) return isNull(outboxMessages.tenantId);
  return or(isNull(outboxMessages.tenantId), inArray(outboxMessages.tenantId, activeTenantIds));
}

/**
 * Not exhausted (WP20, brief §3.2): not marked by the failure that reached
 * `DELIVERY_MAX_FAILED_ATTEMPTS` and announced it. The mark, not the count, so a row whose
 * count grew under an earlier release is retried and announced rather than dropped.
 */
function notExhausted() {
  return isNull(outboxMessages.exhaustedAt);
}

/**
 * No EARLIER message of the same aggregate has failed and is still to be retried.
 *
 * Ordering is per aggregate (the table's promise), so a failed message holds back its own
 * aggregate's later events while it backs off (WP20). An earlier message that has never
 * failed does not hold anything back here: it is claimed in the same batch, ahead of its
 * successors by the batch's order, and the batch's own `held` set stops the successors if
 * it fails. So an aggregate with several queued events still drains in one batch.
 *
 * An exhausted message does not hold anything back either: it will never publish, and
 * holding its successors behind it would hold them for ever.
 *
 * Within ONE TENANT. An aggregate id is not unique across tenants — every tenant's
 * `SystemPinged` is `System:system` — and the claim never takes a stopped tenant's
 * message, so a stopped tenant's failed ping would never be retried, never exhausted, and
 * would hold every other tenant's pings behind it for ever (and count them as lag).
 *
 * Answered by `outbox_messages_live_failure_idx` (`online-indexes.ts`), which holds only
 * the rows this asks about, so the check does not walk an aggregate's published history.
 */
function noEarlierLiveSibling() {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${outboxMessages} AS earlier
    WHERE earlier.aggregate_type = ${outboxMessages.aggregateType}
      AND earlier.aggregate_id = ${outboxMessages.aggregateId}
      AND earlier.tenant_id IS NOT DISTINCT FROM ${outboxMessages.tenantId}
      AND earlier.sequence < ${outboxMessages.sequence}
      AND earlier.published_at IS NULL
      AND earlier.attempts > 0
      AND earlier.exhausted_at IS NULL
  )`;
}

/** The scope a consumer acts in for this event: the tenant's, or the platform's. */
function scopeOf(event: DomainEvent): ScopeContext {
  return event.tenantId === null
    ? systemContext('outbox-relay')
    : { tenantId: event.tenantId as never, botInstanceId: null };
}

function toDomainEvent(row: typeof outboxMessages.$inferSelect): DomainEvent {
  return {
    eventId: row.id,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    tenantId: row.tenantId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    sequence: row.sequence,
    correlationId: row.correlationId,
    causationId: row.causationId,
    actor: row.actor as ActorRef,
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload,
  };
}
