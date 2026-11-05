import { CAPACITY_ERROR_CODES, NexaError, isNexaError } from '@nexa/contracts';
import { LimiterDeferral, type KeyedConcurrencyLimiter } from '../domain/keyed-limiter.js';
import type { CapacityLimitResolver } from './capacity-limit-resolver.js';
import type { LimitPressureReporter } from './limit-pressure.js';

/**
 * A bot's database share: at most `limit` of the work started inside `fn` holds a pooled
 * connection at once (`infrastructure/pool-share.ts`). `onWait` is told every time a
 * checkout had to wait for the bot's share.
 */
export interface DbShare {
  run<T>(key: string, limit: number, fn: () => Promise<T>, onWait: () => void): Promise<T>;
}

/** How many of one bot's updates may wait for a turn in this process. */
export const BOT_UPDATE_QUEUE_MAX = 200;
/**
 * How long one update may wait for its turn. Well inside the time Telegram waits for a
 * webhook answer, so a waited update is still answered 2xx rather than timed out and sent
 * twice; past it the update is handed back to Telegram (retryable non-2xx), unprocessed.
 */
export const BOT_UPDATE_MAX_WAIT_MS = 20_000;

/**
 * Phase 6A PR-2: a customer turn of one bot, inside that bot's fair share.
 *
 * - `UPDATE_CONCURRENCY`: at most N of the bot's turns run at once; the rest wait in the
 *   bot's own queue (`KeyedConcurrencyLimiter`), so a flood of one bot is that bot's wait.
 * - `DB_CONNECTIONS`: of those, at most M are inside the database at once.
 *
 * A turn that cannot get a place is NOT run: the webhook answers Telegram with a retryable
 * non-2xx, nothing written, and Telegram delivers the same update again. A turn is never
 * dropped and never answered 2xx unprocessed. Every wait and every refusal is a hit on the
 * owner's pressure alert.
 */
export class BotTurnGuard {
  constructor(
    private readonly deps: {
      readonly limits: Pick<CapacityLimitResolver, 'numberOf'>;
      readonly limiter: KeyedConcurrencyLimiter;
      readonly dbShare: DbShare;
      readonly pressure: Pick<LimitPressureReporter, 'hit'>;
    },
  ) {}

  async run<T>(tenantId: string, turn: () => Promise<T>): Promise<T> {
    const [updates, connections] = await Promise.all([
      this.deps.limits.numberOf(tenantId, 'UPDATE_CONCURRENCY'),
      this.deps.limits.numberOf(tenantId, 'DB_CONNECTIONS'),
    ]);
    const inShare = (): Promise<T> =>
      Number.isFinite(connections)
        ? this.deps.dbShare.run(tenantId, connections, turn, () =>
            this.deps.pressure.hit(tenantId, 'DB_CONNECTIONS'),
          )
        : turn();
    if (!Number.isFinite(updates)) return inShare();
    try {
      const { result, outcome } = await this.deps.limiter.run(tenantId, updates, inShare);
      if (outcome === 'WAITED') this.deps.pressure.hit(tenantId, 'UPDATE_CONCURRENCY');
      return result;
    } catch (error) {
      if (!(error instanceof LimiterDeferral)) throw error;
      this.deps.pressure.hit(tenantId, 'UPDATE_CONCURRENCY');
      throw new NexaError({
        kind: 'RATE_LIMITED',
        code: CAPACITY_ERROR_CODES.UPDATE_QUEUE_FULL,
        message: 'This bot is busy. Deliver the update again shortly.',
        retryable: true,
      });
    }
  }
}

/**
 * The capacity deferral behind an error, if there is one: a capacity guard handing an update
 * back to Telegram, which the webhook must answer as that retryable non-2xx rather than record
 * as a failed turn and answer 2xx. Looked for through `cause` too: a refusal raised inside a
 * pool checkout reaches the turn wrapped by the query layer (drizzle's "Failed query").
 */
export function capacityDeferralOf(error: unknown): NexaError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (
      isNexaError(current) &&
      (current.code === CAPACITY_ERROR_CODES.UPDATE_QUEUE_FULL ||
        current.code === CAPACITY_ERROR_CODES.NEW_CUSTOMER_RATE)
    ) {
      return current;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether an error is (or wraps) a capacity deferral; see `capacityDeferralOf`. */
export function isCapacityDeferral(error: unknown): boolean {
  return capacityDeferralOf(error) !== null;
}
