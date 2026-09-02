import {
  money,
  notificationDestinationSchema,
  templateDefinition,
  type Clock,
  type CorrelationId,
  type CurrencyCode,
  type IdGenerator,
  type Logger,
  type OperationalEventRecorder,
  type NotificationDestination,
  type NotificationStatus,
  type ScopeContext,
  type SettingKey,
  type TemplateValue,
  type TemplateValues,
  type TenantId,
} from '@nexa/contracts';
import { asId } from '@nexa/contracts';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import { DEFAULT_TEMPLATE_LOCALE } from '../../templates/application/template-resolver.js';
import type { NotificationIntent, NotificationRepository, NotificationTransport } from './ports.js';

export interface DispatcherOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  /**
   * How long a claim is held before the intent becomes due again.
   *
   * Longer than any plausible send, so a slow Telegram does not get a second
   * dispatcher sending the same message; short enough that a process that died
   * mid-send releases its work in minutes rather than never.
   */
  readonly leaseMs: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
}

/**
 * What one intent's delivery did.
 *
 * `reachedTransport` is separate from the result because the rate ceiling is a
 * courtesy to Telegram, and an intent that failed to render never touched it.
 */
interface DeliveryOutcomeReport {
  readonly result: 'SENT' | 'RETRY' | 'FAILED' | 'SUPERSEDED' | 'RELEASED';
  readonly reachedTransport: boolean;
  /** SUPERSEDED because the intent already said what this attempt reported. */
  readonly alreadyTrue?: boolean;
}

export interface DispatchTickResult {
  readonly claimed: number;
  readonly sent: number;
  /** Attempts that will be retried. */
  readonly failed: number;
  /** Intents that reached a terminal FAILED, this tick. */
  readonly abandoned: number;
  /** Intents swept to FAILED because they had spent every attempt. */
  readonly exhausted: number;
  /**
   * Attempts whose outcome arrived after a later attempt had claimed the row.
   *
   * The attempt is recorded; the intent is left to whoever holds the claim
   * now. Counting these as failures would report an outcome that was refused.
   */
  readonly superseded: number;
  /**
   * Claims whose outcome could NOT be written down.
   *
   * Distinct from `abandoned`, which is a recorded terminal failure. These are
   * intents whose status is unknown to the database: they keep their lease and
   * are met again when it expires, or are swept by `failExhausted` once their
   * attempts are spent. Counting them as failures would report a state nothing
   * has stored.
   *
   * Being met again means being SENT again, and that is worth saying plainly.
   * If the transport succeeded and only the recorder failed, the next claim
   * delivers the same message a second time. This subsystem is at-least-once
   * and has no way to be otherwise: nothing durable records "the send landed"
   * between the API call returning and the attempt row committing. The
   * alternative — the previous code's — was to write FAILED on a guess, which
   * turned a duplicate message into a delivered message filed as permanently
   * failed. A duplicate operational alert is a nuisance; a lost one is the
   * failure this whole module exists to prevent.
   */
  readonly unrecorded: number;
  /**
   * Claims handed back because the tenant stopped while the batch was running.
   *
   * Not a failure and not a send: the attempt is returned, and the intent stays
   * queued until the installation is active. Due again NOW only when the
   * hand-back owns the current claim — a straggler returns its capacity without
   * moving a live attempt's schedule.
   */
  readonly released: number;
  /**
   * Sweep verdicts a hand-back took back, this tick.
   *
   * A terminal state, corrected. `failExhausted` had written the intent off as
   * permanently failed and this says the verdict was wrong: the claims it
   * counted as spent had never reached the transport. That is the intended
   * repair and it is not routine — a non-zero value here means the sweep's
   * safety margin fired on a claim that was still coming back, and how often
   * that happens is a thing an operator should be able to read rather than
   * infer from a row that quietly changed status.
   */
  readonly restored: number;
  /**
   * Hand-backs that could not be recorded, twice.
   *
   * Not a delivery outcome: no transport call happened, so there is nothing to
   * file as sent or failed. The intent keeps its lease and is met again — but
   * one attempt of its allowance is genuinely SPENT, because a claim with
   * neither an attempt row nor a release is indistinguishable from one whose
   * sender died after a successful send, and at-least-once requires that to
   * count. A non-zero value here is a durable loss of capacity, not a delay.
   */
  readonly unreleased: number;
}

/**
 * Sends notification intents, outside every transaction.
 *
 * A poller, structurally the same as `OutboxRelay`: claim with `FOR UPDATE SKIP
 * LOCKED`, commit the claim, do the slow thing, then record what happened.
 *
 * It is NOT an outbox consumer, and that was a correction rather than a
 * preference. The relay runs its consumers inside the claim transaction — that
 * transaction is what makes `processed_messages` an effectively-once claim — so
 * a consumer that sent would hold a database transaction open for as long as
 * Telegram felt like taking. ADR-0018 records the change.
 *
 * Rate limiting is real here even though the research found none in the legacy
 * system: every investigation phase was UI-only, so its absence is NOT_EXPOSED
 * rather than proven, and a mass send against roughly 13,700 customers is
 * documented as visually identical to a one-account send.
 */
export class NotificationDispatcher {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  /** The tick currently running, so `stop` can wait for it. */
  private inFlight: Promise<unknown> | null = null;
  private windowStartedAt = 0;
  private sentInWindow = 0;
  /**
   * Whose rate ceiling applies. Set at boot, once the installation's tenant is
   * resolved — the same shape `Container.setInstallationTenant` uses, and for
   * the same reason: the tenant is a row, so it is not known while the object
   * graph is being constructed.
   */
  private rateLimitScope: ScopeContext | null = null;

  setRateLimitScope(scope: ScopeContext | null): void {
    this.rateLimitScope = scope;
  }

  /**
   * Forgets what has been sent in the current minute.
   *
   * The rate window is PROCESS state: it lives on this object and outlives
   * anything done to the database. That is correct in production — the ceiling
   * is a courtesy to Telegram and Telegram does not care what our tables say —
   * and it is a trap for anything that resets the world and expects a clean
   * dispatcher. The ordering enumeration in the integration suite hit exactly
   * that: 216 sequences share one dispatcher, and after twenty sends the
   * budget was zero, so later sequences claimed nothing and passed their
   * invariants without exercising anything.
   */
  resetRateWindow(): void {
    this.windowStartedAt = 0;
    this.sentInWindow = 0;
  }

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly transport: NotificationTransport,
    private readonly templates: TemplateResolver,
    private readonly settings: SettingsResolver,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    /**
     * The RAW operational-event recorder, never the notifying façade.
     *
     * The façade projects an event at or above the configured severity into a
     * notification intent — and this class is what drains that queue, so wiring
     * it here would make every withdrawn sweep queue a message that this
     * dispatcher then sends and can itself have withdrawn. The amplification
     * would be worst exactly when it hurts: a stopped installation hands back
     * every queued claim at once.
     *
     * The same reason the composition root gives `projectionSettings` its own
     * raw recorder, and the same shape of fix — remove the cycle rather than
     * detect it at runtime.
     */
    private readonly opsLog: OperationalEventRecorder,
    private readonly options: DispatcherOptions,
  ) {}

  /**
   * Says that a sweep's verdict was taken back.
   *
   * A WARN rather than an INFO because the sweep was WRONG: it decided an
   * intent had spent every attempt, and the hand-back proves those claims never
   * reached the transport. The repair is intended and the alternative is worse
   * — a message written off having never been sent — but the safety margin
   * firing on a claim that was still coming back is a tuning signal, and how
   * often it happens should be readable rather than inferred from a row that
   * quietly changed status.
   *
   * Never throws. The release has already committed and the batch behind it
   * must not be stranded by a failure to describe what happened; and at the
   * second call site this runs inside the hand-back's own catch, where a throw
   * would be counted as a hand-back that never happened.
   */
  private async announceRestore(intent: NotificationIntent): Promise<void> {
    try {
      await this.opsLog.record(
        {
          tenantId: asId<'TenantId'>(intent.tenantId) as TenantId,
          botInstanceId: null,
        },
        {
          code: 'notification.sweep_withdrawn',
          severity: 'WARN',
          message:
            'An exhaustion verdict was withdrawn: the claims it counted as spent never reached the transport.',
          context: {
            notificationId: intent.id,
            attemptNumber: intent.attemptCount,
            reason: 'tenant.not_active',
          },
          // One row per WITHDRAWAL, not per intent: the same intent can be
          // swept and withdrawn again later, and collapsing those would hide
          // the second one behind an occurrence counter on a resolved row.
          dedupeKey: `notification:${intent.id}:sweep_withdrawn:${intent.attemptCount}`,
          ...(intent.correlationId ? { correlationId: intent.correlationId as CorrelationId } : {}),
        },
      );
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          notificationId: intent.id,
        },
        'Withdrew a sweep verdict but could not record the operational event',
      );
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.timer = setTimeout(() => {
        // Held so `stop` can wait for it. A tick that is mid-send owns a
        // claimed row, and the outcome of that send has nowhere to go once the
        // pool is closed.
        const running = this.tick()
          .catch((error: unknown) => {
            this.logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'Notification dispatcher tick failed',
            );
          })
          .finally(() => {
            this.inFlight = null;
            loop();
          });
        this.inFlight = running;
        void running;
      }, this.options.pollIntervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  /**
   * Stops the loop AND waits for the tick that is already running.
   *
   * Returning as soon as the next timer is cleared was not stopping, it was
   * abandoning: `container.shutdown()` closes the pool immediately afterwards,
   * so a send in flight during a SIGTERM completed with nowhere to record its
   * attempt or move its intent. The row stayed claimed, its lease expired, and
   * the next deployment sent the same operational alert again — one duplicate
   * per deploy that happened to overlap a send.
   *
   * The wait is bounded by the transport's own timeout, so this cannot hang a
   * shutdown indefinitely.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /**
   * One pass. Tracked, so `stop()` waits for it however it was started.
   *
   * The tracking used to live only in `start()`'s poll loop, which made
   * `stop()` a no-op for any tick begun another way — and made the regression
   * that guards it vacuous, because `await null` still costs a microtask and a
   * test that only waited one microtask could not tell the difference. A
   * running tick owns a claimed row whatever called it, and the outcome of its
   * send has nowhere to go once the pool is closed.
   */
  async tick(): Promise<DispatchTickResult> {
    const running = this.runTick();
    this.inFlight = running;
    try {
      return await running;
    } finally {
      // Only if it is still ours: the poll loop replaces this with its own
      // wrapped promise, and clearing that one would undo the loop's tracking.
      if (this.inFlight === running) this.inFlight = null;
    }
  }

  private async runTick(): Promise<DispatchTickResult> {
    const now = this.clock.now();

    // Before anything else, and regardless of budget: an intent that has spent
    // its attempts is never claimed again, so if nothing sweeps it, it stays
    // PENDING for ever and no screen ever reports it as failed.
    const exhausted = await this.notifications.failExhausted(now, this.options.batchSize, {
      leaseMs: this.options.leaseMs,
      transport: this.transport.kind,
    });

    const budget = await this.remainingBudget(now);
    if (budget <= 0) {
      return {
        claimed: 0,
        sent: 0,
        failed: 0,
        abandoned: 0,
        exhausted,
        superseded: 0,
        unrecorded: 0,
        released: 0,
        restored: 0,
        unreleased: 0,
      };
    }

    const claimed = await this.notifications.claimDue(
      now,
      Math.min(this.options.batchSize, budget),
      this.options.leaseMs,
    );

    let sent = 0;
    let failed = 0;
    let abandoned = 0;
    let superseded = 0;
    let unrecorded = 0;
    let released = 0;
    let restored = 0;
    let unreleased = 0;

    for (const intent of claimed) {
      // `claimDue` already refused an inactive tenant, but it answered ONCE for
      // a batch of up to ten that is then delivered one at a time: a stop that
      // landed while the first send was outstanding was invisible to every
      // intent behind it, so the kill switch governed whichever message
      // happened to be first in the batch and nothing else. `deliver` asks
      // again, on the line before its send.
      let delivery: DeliveryOutcomeReport;
      try {
        delivery = await this.deliver(intent);
      } catch (error) {
        // One intent must not be able to stop the batch.
        //
        // Without this, a single throw aborts the loop and leaves every intent
        // claimed after it leased, with its attempt counter already incremented
        // and no attempt row written. That is ADR-0018's own "sixty identical
        // errors with a scheduler in front of it", reproduced by the thing
        // built to prevent it.
        //
        // Reaching HERE now means one specific thing: `deliver` handles a
        // transport throw itself, so the only way out of it is the RECORDER
        // failing. Nothing about this intent can therefore be written down —
        // including, notably, a status. The first version wrote FAILED anyway,
        // which was wrong twice over: it ignored `maxAttempts`, ending an
        // intent on its first hiccup where the ordinary path would have
        // retried; and the throw can happen AFTER a successful send, so it
        // could file a delivered message as permanently failed.
        //
        // Leaving the row alone is the honest answer. Its lease expires and the
        // loop meets it again — which means sending it again if the transport
        // had in fact succeeded; see `unrecorded` for why that is the trade. If
        // it has spent its attempts by then, `failExhausted` ends it and writes
        // the attempt row that this failure could not, so the history says the
        // outcome was never recorded rather than leaving a gap.
        this.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            notificationId: intent.id,
            attemptCount: intent.attemptCount,
            maxAttempts: intent.maxAttempts,
          },
          'Could not record the outcome of a notification; leaving it to its lease',
        );
        unrecorded += 1;
        // Charged to the ceiling. This catch cannot tell whether the send
        // happened before the recorder failed, and over-counting only slows us
        // down while under-counting could exceed Telegram's limit.
        this.sentInWindow += 1;
        continue;
      }

      if (delivery.result === 'RELEASED') {
        // Put back, NOT failed. A stop is a pause, not a verdict on the
        // message, and the attempt stops counting so a tenant stopped and
        // started three times has not silently spent a message's whole
        // allowance and left `failExhausted` to report a permanent delivery
        // failure for something no transport was ever asked to carry.
        //
        // In its OWN try. This await sat outside the per-intent guard above,
        // so a transient database failure here threw out of the loop and
        // stranded every intent claimed behind it — leased, counter
        // incremented, no attempt row, and nothing to explain it. The whole
        // point of that guard is that one intent cannot stop the batch, and
        // the hand-back was the one step still able to.
        //
        // GUARANTEED BY MECHANISM: the hand-back is idempotent (primary key on
        // the attempt number), it cannot return capacity for a message that
        // was sent (a trigger, since 0014), and it cannot cancel another
        // worker's lease (the ownership predicate).
        //
        // GUARANTEED BY ARGUMENT: that `intent.attemptCount` is THIS tick's
        // claim. It is, because `claimDue` returned the row after incrementing
        // it and nothing between here and there re-reads the counter — but it
        // is an argument about this loop, not a check, and passing a stale
        // number here would return capacity for a claim somebody else holds.
        try {
          const handBack = await this.notifications.releaseClaim({
            tenantId: intent.tenantId,
            notificationId: intent.id,
            attemptNumber: intent.attemptCount,
            now: this.clock.now(),
            reason: 'tenant.not_active',
          });
          if (handBack.released) released += 1;
          if (handBack.restored) {
            restored += 1;
            await this.announceRestore(intent);
          }
        } catch (error) {
          // ONE retry, and it is safe for a reason rather than by hope.
          //
          // A release is keyed by the attempt number it releases, so repeating
          // it is a no-op against the primary key whether or not the first
          // call committed. Mechanism, not hope: that is what makes retrying
          // correct here when retrying a decrement would have been a guess.
          //
          // The retry may report `restored` where the first call already did
          // the restoring, which would double-count. It cannot: the restore is
          // an UPDATE whose predicate requires the intent to be FAILED, and the
          // first call left it PENDING, so a second pass matches nothing.
          //
          // Retried HERE because nothing else can. A claim that recorded
          // neither an attempt row nor a release is indistinguishable, in the
          // database, from one whose sender died after a successful send — and
          // at-least-once says that one must count as spent. So a later pass
          // cannot safely repair this; the only moment we know no transport
          // call happened is now.
          try {
            const handBack = await this.notifications.releaseClaim({
              tenantId: intent.tenantId,
              notificationId: intent.id,
              attemptNumber: intent.attemptCount,
              now: this.clock.now(),
              reason: 'tenant.not_active',
            });
            if (handBack.released) released += 1;
            if (handBack.restored) {
              restored += 1;
              await this.announceRestore(intent);
            }
            continue;
          } catch {
            // Both attempts failed. Said plainly: this attempt of the
            // allowance is now SPENT, not deferred — an earlier version of
            // this comment claimed the cost was recoverable on the next claim,
            // and no code path recovered it.
            //
            // No delivery outcome is invented either. No transport call
            // happened, so there is nothing to file as sent or failed; the
            // intent keeps its lease and is met again with one fewer attempt.
            this.logger.error(
              {
                err: error instanceof Error ? error.message : String(error),
                notificationId: intent.id,
                attemptNumber: intent.attemptCount,
              },
              'Could not record a notification hand-back; the attempt is spent',
            );
            unreleased += 1;
          }
        }
        continue;
      }

      if (delivery.result === 'SENT') sent += 1;
      else if (delivery.result === 'FAILED') abandoned += 1;
      else if (delivery.result === 'SUPERSEDED') {
        superseded += 1;
        this.logger.warn(
          {
            notificationId: intent.id,
            attemptNumber: intent.attemptCount,
            // A SUCCEEDED outcome that did not move the row found it already
            // SENT, which is the same thing this attempt was reporting. That is
            // not the same event as a stale failure arriving after a later
            // claim, and logging both under one sentence described something
            // that had not happened.
            reason: delivery.alreadyTrue
              ? 'the intent was already in that state'
              : 'a later attempt holds the claim',
          },
          'A delivery outcome did not move the intent',
        );
      } else failed += 1;

      // Only work that reached the transport counts against the ceiling. A
      // burst of unrenderable intents would otherwise spend the whole minute's
      // budget without a single byte leaving the process.
      //
      // `reachedTransport` is reported by `deliver` because nothing on the
      // intent can say it. The first version of this line tested
      // `intent.status === 'PENDING'`, which is the claim's own predicate and
      // therefore always true — a guard that did nothing, under a comment
      // claiming it did.
      if (delivery.reachedTransport) this.sentInWindow += 1;
    }

    // Said out loud, because a delivery stop that nobody can see is the exact
    // failure this module exists to prevent. `released` is the only outcome
    // that is neither a send nor a recorded failure, so a bug that made
    // `stillActive` answer no for everybody would otherwise deliver nothing,
    // for every tenant, for ever, in complete silence — and no caller reads
    // this result object, so the count alone rescues nobody.
    if (released > 0) {
      this.logger.warn(
        { released, claimed: claimed.length },
        'Handed claimed notifications back: the tenant is no longer active',
      );
    }

    // A terminal state was corrected, which is the intended repair and still
    // not routine: `failExhausted` had written these intents off as permanently
    // failed on the evidence of a claim that turned out never to have reached
    // the transport. A warning, because the number is a tuning signal for the
    // sweep's safety margin — and because a repair nobody can see is
    // indistinguishable from a row changing status for no reason.
    if (restored > 0) {
      this.logger.warn(
        { restored, claimed: claimed.length },
        'Withdrew exhaustion verdicts: the claims they counted as spent were never sent',
      );
    }

    return {
      claimed: claimed.length,
      sent,
      failed,
      abandoned,
      exhausted,
      superseded,
      unrecorded,
      released,
      restored,
      unreleased,
    };
  }

  /** One intent: render, send outside any transaction, record what happened. */
  /**
   * Is this intent's tenant still open for business?
   *
   * Asked per intent rather than once per batch, and deliberately NOT cached
   * across the loop: a cached answer is the batch-wide answer this exists to
   * replace.
   */
  private async stillActive(intent: NotificationIntent): Promise<boolean> {
    const active = await this.notifications.activeTenants([intent.tenantId]);
    return active.has(intent.tenantId);
  }

  private async deliver(intent: NotificationIntent): Promise<DeliveryOutcomeReport> {
    const scope: ScopeContext = {
      tenantId: asId<'TenantId'>(intent.tenantId) as TenantId,
      botInstanceId: null,
    };
    const startedAt = this.clock.now();

    let text: string;
    let definition;
    let destination: NotificationDestination;
    try {
      // The destination, checked here rather than when the row was read.
      //
      // A jsonb column is only ever as good as the last thing that wrote it,
      // and this is the one place a bad one can be handled without taking
      // anything else down: it fails this intent and the batch continues.
      const parsed = notificationDestinationSchema.safeParse(intent.destination);
      if (!parsed.success) {
        throw new Error(
          `The stored destination is not valid: ${parsed.error.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        );
      }
      // The PARSED value is what gets sent, not the raw cast beside it. Zod
      // strips unknown keys and would apply any coercion the schema grows, so
      // validating one value and sending another is the "the guard checks A and
      // the code uses B" shape — and the obvious future repair here, coercing a
      // chat id that turns out to be stored as a number, would have passed the
      // guard while the transport still received the number.
      destination = parsed.data;

      // Inside the try. `templateDefinition` throws for a key the frozen
      // catalogue no longer declares, which a PENDING row can outlive across a
      // release, and a throw out here would take the whole batch with it.
      definition = templateDefinition(intent.templateKey);
      // Rendering reads the tenant's override, so an operator who reworded the
      // alert gets their wording. It happens before the send and outside any
      // transaction — a template read is cheap, and holding a transaction across
      // the send is the thing this class exists to avoid.
      text = await this.templates.render(
        scope,
        intent.templateKey,
        deserialiseValues(intent),
        DEFAULT_TEMPLATE_LOCALE,
      );
    } catch (error) {
      // A template that cannot render will not render on the next attempt
      // either. Failing it permanently, with the reason recorded, beats retrying
      // it five times and then saying nothing useful.
      await this.record(
        intent,
        {
          outcome: 'FAILED_PERMANENT',
          errorCode: 'notification.render_failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        },
        startedAt,
      );
      // Nothing left the process, so nothing is charged to the rate ceiling.
      return { result: 'FAILED', reachedTransport: false };
    }

    // The tenant's status, asked HERE — after rendering, on the line before the
    // send — and not before `deliver` was called.
    //
    // Before the call was the obvious place and it was wrong: rendering reads
    // the tenant's template override and the feature flags governing it, which
    // is several awaited queries. A stop landing in that window found a check
    // that had already returned true, and the send went out anyway. The comment
    // claimed the window was the unavoidable read-to-send race; it was a
    // multi-query window with a check at the wrong end of it.
    //
    // The unavoidable race is real and remains: a tenant can be stopped between
    // this read and the transport call, and nothing short of a transaction held
    // across the send could close it — which is the thing this class exists not
    // to do. What is closed is every window that did not have to be open.
    if (!(await this.stillActive(intent))) {
      return { result: 'RELEASED', reachedTransport: false };
    }

    // A transport that THROWS is a transport failure, not an unknown one.
    //
    // Left to propagate, it reached the batch's catch, which could only guess
    // at what had happened and guessed permanently-failed — ending an intent on
    // one refused connection, `maxAttempts` notwithstanding. Handled here, it is
    // an ordinary retryable outcome with a reason in its attempt row, and the
    // attempt ceiling decides when to stop, exactly as it does for a transport
    // that returns a failure instead of raising one.
    let result: Awaited<ReturnType<NotificationTransport['send']>>;
    try {
      result = await this.transport.send({
        destination,
        text,
        html: definition.format === 'TELEGRAM_HTML',
        tenantId: intent.tenantId,
      });
    } catch (error) {
      result = {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'notification.transport_threw',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const recorded = await this.record(intent, result, startedAt);
    return {
      result: recorded,
      reachedTransport: true,
      alreadyTrue: recorded === 'SUPERSEDED' && result.outcome === 'SUCCEEDED',
    };
  }

  private async record(
    intent: NotificationIntent,
    result:
      | { outcome: 'SUCCEEDED' }
      | {
          outcome: 'FAILED_RETRYABLE' | 'FAILED_PERMANENT';
          errorCode: string;
          errorMessage: string;
          retryAfterMs?: number;
        },
    startedAt: Date,
  ): Promise<DeliveryOutcomeReport['result']> {
    const finishedAt = this.clock.now();

    // `attemptCount` was already incremented by the claim, so it names THIS
    // attempt. Deriving the number here instead would double-count a claim whose
    // sender died before recording anything.
    const attemptNumber = intent.attemptCount;

    // The NUMBER identifies the attempt; SPEND decides whether any are left.
    //
    // They were the same figure while the counter could be decremented, and are
    // not now that it is monotonic. Reading the number here meant an intent
    // whose claims had been handed back unsent — six stop/start cycles, say —
    // was written off on its FIRST real send, because the claim number had
    // passed `max_attempts` while nothing had been spent. `claimDue`,
    // `failExhausted` and `releaseClaim` were all moved to spend; this was the
    // one place left reading the raw counter, and it is the place that decides
    // whether a message ever gets its allowance.
    const spent = intent.attemptCount - intent.releasedCount;

    let nextStatus: NotificationStatus;
    let nextAttemptAt: Date;

    if (result.outcome === 'SUCCEEDED') {
      nextStatus = 'SENT';
      nextAttemptAt = finishedAt;
    } else if (result.outcome === 'FAILED_PERMANENT' || spent >= intent.maxAttempts) {
      // Bounded on purpose. A permanently wrong destination retried forever is
      // the legacy log group's sixty-identical-errors failure with a scheduler
      // in front of it.
      nextStatus = 'FAILED';
      nextAttemptAt = finishedAt;
    } else {
      nextStatus = 'PENDING';
      // Spend again, not the claim number: backing off `2^(claims - 1)` made
      // the first real retry of an intent that had been handed back six times
      // wait sixty-four times as long as its first failure warranted.
      nextAttemptAt = new Date(finishedAt.getTime() + this.backoffFor(spent, result));
    }

    const { moved } = await this.notifications.recordAttempt({
      attemptId: this.ids.uuid(),
      tenantId: intent.tenantId,
      notificationId: intent.id,
      attemptNumber,
      transport: this.transport.kind,
      outcome: result.outcome,
      startedAt,
      finishedAt,
      errorCode: result.outcome === 'SUCCEEDED' ? null : result.errorCode,
      errorMessage: result.outcome === 'SUCCEEDED' ? null : result.errorMessage,
      retryAfterMs:
        result.outcome === 'FAILED_RETRYABLE' && result.retryAfterMs !== undefined
          ? result.retryAfterMs
          : null,
      nextStatus,
      nextAttemptAt,
    });

    // The row did not move, so this attempt's claim has been superseded by a
    // later one. Saying 'FAILED' or 'RETRY' here would report a transition that
    // the database refused.
    if (!moved) return 'SUPERSEDED';

    if (nextStatus === 'SENT') return 'SENT';
    return nextStatus === 'FAILED' ? 'FAILED' : 'RETRY';
  }

  /**
   * How long to wait before the next attempt.
   *
   * A `retry_after` from the transport wins outright: Telegram knows what it
   * wants and a number we invented would be either rude or slow. Otherwise
   * exponential with jitter, so a batch of failures does not come back in
   * lockstep.
   */
  private backoffFor(
    attemptNumber: number,
    result: { outcome: string; retryAfterMs?: number },
  ): number {
    if (result.retryAfterMs !== undefined) return result.retryAfterMs;
    const exponential = this.options.baseBackoffMs * 2 ** Math.max(attemptNumber - 1, 0);
    const capped = Math.min(exponential, this.options.maxBackoffMs);
    return Math.floor(capped * (0.5 + Math.random() * 0.5));
  }

  /**
   * How many sends are left in the current minute.
   *
   * A plain fixed window rather than a token bucket: the ceiling is a courtesy
   * to Telegram, not an accounting system, and a window an operator can reason
   * about ("twenty a minute") is worth more than one that is smoother.
   */
  private async remainingBudget(now: Date): Promise<number> {
    if (now.getTime() - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now.getTime();
      this.sentInWindow = 0;
    }
    const perMinute = await this.installationRateLimit();
    return Math.max(perMinute - this.sentInWindow, 0);
  }

  /**
   * The rate ceiling.
   *
   * Read from the primary tenant's settings. The dispatcher is
   * installation-wide while the setting is tenant-scoped, and one install serves
   * one customer (ADR-0001), so this is the right answer today and an explicitly
   * wrong one the day an installation serves several tenants at volume. It is
   * called out here rather than discovered later.
   */
  private async installationRateLimit(): Promise<number> {
    if (this.rateLimitScope === null) return this.options.batchSize;
    return this.settings.valueOf<number>(
      this.rateLimitScope,
      'ops.notifications.max_per_minute' as SettingKey,
    );
  }
}

/**
 * Turns a stored payload back into template values.
 *
 * The declaration decides the type, not the JSON: a `DATETIME` placeholder gets
 * a `Date` back from its ISO string and a `MONEY` one gets a `Money` back from
 * its two fields, so the single formatter renders it and no unit is ever typed
 * into copy.
 */
export function deserialiseValues(intent: {
  templateKey: string;
  payload: Record<string, unknown>;
}): TemplateValues {
  const definition = templateDefinition(intent.templateKey as never);
  const out: Record<string, TemplateValue> = {};

  for (const placeholder of definition.placeholders) {
    const raw = intent.payload[placeholder.token];
    if (raw === undefined || raw === null) continue;

    if (placeholder.type === 'DATETIME' && typeof raw === 'string') {
      out[placeholder.token] = new Date(raw);
      continue;
    }
    if (placeholder.type === 'MONEY' && typeof raw === 'object') {
      const value = raw as { amountMinor?: string; currency?: string };
      if (value.amountMinor !== undefined && value.currency !== undefined) {
        out[placeholder.token] = money(BigInt(value.amountMinor), value.currency as CurrencyCode);
        continue;
      }
    }
    out[placeholder.token] = raw as TemplateValue;
  }
  return out;
}
