import {
  money,
  notificationDestinationSchema,
  templateDefinition,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type Logger,
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
  readonly result: 'SENT' | 'RETRY' | 'FAILED' | 'SUPERSEDED';
  readonly reachedTransport: boolean;
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

  constructor(
    private readonly notifications: NotificationRepository,
    private readonly transport: NotificationTransport,
    private readonly templates: TemplateResolver,
    private readonly settings: SettingsResolver,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: Logger,
    private readonly options: DispatcherOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((error: unknown) => {
            this.logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'Notification dispatcher tick failed',
            );
          })
          .finally(loop);
      }, this.options.pollIntervalMs);
      this.timer.unref?.();
    };
    loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async tick(): Promise<DispatchTickResult> {
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

    for (const intent of claimed) {
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

      if (delivery.result === 'SENT') sent += 1;
      else if (delivery.result === 'FAILED') abandoned += 1;
      else if (delivery.result === 'SUPERSEDED') {
        superseded += 1;
        this.logger.warn(
          { notificationId: intent.id, attemptNumber: intent.attemptCount },
          'A delivery outcome arrived after a later attempt had claimed the intent; the attempt is recorded and the intent was left alone',
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

    return { claimed: claimed.length, sent, failed, abandoned, exhausted, superseded, unrecorded };
  }

  /** One intent: render, send outside any transaction, record what happened. */
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

    return { result: await this.record(intent, result, startedAt), reachedTransport: true };
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

    let nextStatus: NotificationStatus;
    let nextAttemptAt: Date;

    if (result.outcome === 'SUCCEEDED') {
      nextStatus = 'SENT';
      nextAttemptAt = finishedAt;
    } else if (result.outcome === 'FAILED_PERMANENT' || attemptNumber >= intent.maxAttempts) {
      // Bounded on purpose. A permanently wrong destination retried forever is
      // the legacy log group's sixty-identical-errors failure with a scheduler
      // in front of it.
      nextStatus = 'FAILED';
      nextAttemptAt = finishedAt;
    } else {
      nextStatus = 'PENDING';
      nextAttemptAt = new Date(finishedAt.getTime() + this.backoffFor(attemptNumber, result));
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
