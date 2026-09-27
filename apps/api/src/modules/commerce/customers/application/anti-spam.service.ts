import {
  ANTI_SPAM_MAX_INTERACTIONS,
  ANTI_SPAM_RECOVERED_CODE,
  ANTI_SPAM_UNAVAILABLE_CODE,
  ANTI_SPAM_WINDOW_MS,
  type Clock,
  type Logger,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';

/**
 * Anti-spam (WP20, brief §3.4–§3.5): more than `ANTI_SPAM_MAX_INTERACTIONS` inbound
 * interactions in a rolling `ANTI_SPAM_WINDOW_MS` blocks the customer.
 *
 * The count lives in a store that is not the database on purpose: the brief forbids a row
 * per message, and a counter that must be right under concurrency is an atomic
 * increment-and-read, which Redis does in one step (`RedisInteractionCounter`).
 */

/** What the store answered for one interaction. */
export type InteractionTally =
  | {
      readonly state: 'COUNTED';
      /** Interactions in the window, THIS one included. */
      readonly count: number;
      /** This `update_id` was already counted: a redelivery, which counts once. */
      readonly duplicate: boolean;
    }
  | { readonly state: 'UNAVAILABLE' };

/** The port. Scoped by tenant, bot and Telegram user; deduplicated by `update_id`. */
export interface InteractionCounter {
  tally(input: {
    readonly tenantId: string;
    readonly botInstanceId: string;
    readonly telegramUserId: string;
    readonly updateId: string;
    readonly nowMs: number;
    readonly windowMs: number;
  }): Promise<InteractionTally>;
}

/**
 * What the runtime does with one interaction.
 *
 * - `ALLOWED`: interactions 1–20, or the count is unknown (the store did not answer).
 * - `CROSSED`: the 21st. Block, and tell the customer why.
 * - `FLOODING`: the 22nd and later. Block if nobody has yet, and send nothing: one reply per
 *   message is exactly the amplification a flood is trying to cause.
 */
export type SpamVerdict = 'ALLOWED' | 'CROSSED' | 'FLOODING';

/** The owner's rule, and nothing else: "more than 20", so 20 is allowed and 21 is not. */
export function spamVerdictOf(count: number): SpamVerdict {
  if (count <= ANTI_SPAM_MAX_INTERACTIONS) return 'ALLOWED';
  return count === ANTI_SPAM_MAX_INTERACTIONS + 1 ? 'CROSSED' : 'FLOODING';
}

/** How often, at most, the "anti-spam is off" condition is written while it lasts. */
export const ANTI_SPAM_DEGRADED_RECORD_INTERVAL_MS = 60_000;

export interface AntiSpamDeps {
  readonly counter: InteractionCounter;
  readonly opsEvents: Pick<OperationalEventRecorder, 'record'>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export class AntiSpamService {
  /**
   * When the degradation was last written, in this process. In memory on purpose: it only
   * throttles WRITES of a condition the database already dedupes, so a restart costs one
   * extra occurrence, never a missed one.
   */
  private degradedRecordedAt: number | null = null;

  constructor(private readonly deps: AntiSpamDeps) {}

  /**
   * Counts one interaction and returns what to do with it.
   *
   * Fails OPEN (brief §3.4): when the store does not answer, the interaction is ALLOWED —
   * nobody is blocked on a count nobody could read — and the degradation is recorded as an
   * operational condition, so an operator can see the protection is off.
   */
  async observe(
    scope: TenantContext,
    input: {
      readonly botInstanceId: string;
      readonly telegramUserId: string;
      readonly updateId: string;
    },
  ): Promise<{ readonly verdict: SpamVerdict; readonly count: number | null }> {
    const nowMs = this.deps.clock.now().getTime();
    let tally: InteractionTally;
    try {
      tally = await this.deps.counter.tally({
        tenantId: scope.tenantId,
        botInstanceId: input.botInstanceId,
        telegramUserId: input.telegramUserId,
        updateId: input.updateId,
        nowMs,
        windowMs: ANTI_SPAM_WINDOW_MS,
      });
    } catch {
      tally = { state: 'UNAVAILABLE' };
    }
    if (tally.state === 'UNAVAILABLE') {
      await this.degraded(scope, input.botInstanceId, nowMs);
      return { verdict: 'ALLOWED', count: null };
    }
    await this.recovered(scope, input.botInstanceId);
    return { verdict: spamVerdictOf(tally.count), count: tally.count };
  }

  private async degraded(scope: TenantContext, botInstanceId: string, nowMs: number) {
    if (
      this.degradedRecordedAt !== null &&
      nowMs - this.degradedRecordedAt < ANTI_SPAM_DEGRADED_RECORD_INTERVAL_MS
    ) {
      return;
    }
    this.degradedRecordedAt = nowMs;
    this.deps.logger.warn({ botInstanceId }, 'anti-spam store unavailable; failing open');
    await this.recordQuietly(scope, {
      code: ANTI_SPAM_UNAVAILABLE_CODE,
      severity: 'WARN',
      message: 'Anti-spam could not count interactions; nobody is being blocked for flooding.',
      context: { botInstanceId },
      dedupeKey: botInstanceId,
    });
  }

  private async recovered(scope: TenantContext, botInstanceId: string) {
    if (this.degradedRecordedAt === null) return;
    this.degradedRecordedAt = null;
    await this.recordQuietly(scope, {
      code: ANTI_SPAM_RECOVERED_CODE,
      severity: 'INFO',
      message: 'Anti-spam is counting interactions again.',
      context: { botInstanceId },
      dedupeKey: botInstanceId,
      recoversCode: ANTI_SPAM_UNAVAILABLE_CODE,
      recoversDedupeKey: botInstanceId,
    });
  }

  /** The customer's turn never fails because the operations log could not be written. */
  private async recordQuietly(
    scope: TenantContext,
    event: Parameters<OperationalEventRecorder['record']>[1],
  ) {
    try {
      await this.deps.opsEvents.record(scope, event);
    } catch (error) {
      this.deps.logger.warn({ err: String(error) }, 'anti-spam condition not recorded');
    }
  }
}
