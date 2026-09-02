import {
  money,
  templateDefinition,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type Logger,
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
  readonly result: 'SENT' | 'RETRY' | 'FAILED';
  readonly reachedTransport: boolean;
}

export interface DispatchTickResult {
  readonly claimed: number;
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
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
    const budget = await this.remainingBudget(now);
    if (budget <= 0) return { claimed: 0, sent: 0, failed: 0, abandoned: 0 };

    const claimed = await this.notifications.claimDue(
      now,
      Math.min(this.options.batchSize, budget),
      this.options.leaseMs,
    );

    let sent = 0;
    let failed = 0;
    let abandoned = 0;

    for (const intent of claimed) {
      let delivery: DeliveryOutcomeReport;
      try {
        delivery = await this.deliver(intent);
      } catch (error) {
        // One intent must not be able to stop the batch.
        //
        // Without this, a single throw aborts the loop and leaves every intent
        // claimed after it leased, with its attempt counter already incremented
        // and no attempt row written — and since abandonment happens in
        // `record`, which is the code that did not run, the counter climbs
        // forever and nothing behind it is ever delivered. That is ADR-0018's
        // own "sixty identical errors with a scheduler in front of it",
        // reproduced by the thing built to prevent it.
        this.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            notificationId: intent.id,
          },
          'Notification delivery threw; abandoning this intent and continuing the batch',
        );
        abandoned += 1;
        // Charged to the ceiling, unlike a render failure. This catch cannot
        // tell whether the throw happened before or after the transport was
        // called, and over-counting only slows us down while under-counting
        // could exceed Telegram's limit.
        this.sentInWindow += 1;
        await this.abandon(intent, error);
        continue;
      }

      if (delivery.result === 'SENT') sent += 1;
      else if (delivery.result === 'FAILED') abandoned += 1;
      else failed += 1;

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

    return { claimed: claimed.length, sent, failed, abandoned };
  }

  /**
   * Records an intent as permanently failed after an unexpected throw.
   *
   * Best effort by necessity: if this fails too, the intent stays claimed until
   * its lease expires and the loop meets it again — bounded by the claim
   * predicate, which refuses an intent that has already used its attempts.
   */
  private async abandon(intent: NotificationIntent, cause: unknown): Promise<void> {
    const now = this.clock.now();
    try {
      await this.notifications.recordAttempt({
        attemptId: this.ids.uuid(),
        tenantId: intent.tenantId,
        notificationId: intent.id,
        attemptNumber: intent.attemptCount,
        transport: this.transport.kind,
        outcome: 'FAILED_PERMANENT',
        startedAt: now,
        finishedAt: now,
        errorCode: 'notification.dispatch_failed',
        errorMessage: cause instanceof Error ? cause.message : String(cause),
        retryAfterMs: null,
        nextStatus: 'FAILED',
        nextAttemptAt: now,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error instanceof Error ? error.message : String(error),
          notificationId: intent.id,
        },
        'Could not record the failure of a notification that could not be dispatched',
      );
    }
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
    try {
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

    const result = await this.transport.send({
      destination: intent.destination,
      text,
      html: definition.format === 'TELEGRAM_HTML',
      tenantId: intent.tenantId,
    });

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
  ): Promise<'SENT' | 'RETRY' | 'FAILED'> {
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

    await this.notifications.recordAttempt({
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
