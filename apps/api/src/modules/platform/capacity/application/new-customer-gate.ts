import { CAPACITY_ERROR_CODES, NexaError, type Clock } from '@nexa/contracts';
import type { CapacityLimitResolver } from './capacity-limit-resolver.js';
import type { LimitPressureReporter } from './limit-pressure.js';

const MINUTE_MS = 60_000;

/**
 * Phase 6A PR-2: at most `NEW_CUSTOMERS_PER_MINUTE` new customers of one bot per minute,
 * against a spam wave of fresh accounts.
 *
 * Asked by `CustomerService.resolveFromUpdate` INSIDE its transaction, only when that
 * transaction is about to create a customer — a returning customer is never counted and
 * never slowed. Over the limit the call throws a retryable `capacity.new_customer_rate`,
 * which rolls the creation back (nothing is written: no customer, no audit, no event) and
 * which the webhook answers as a non-2xx, so Telegram delivers the same `/start` again a
 * little later. The new customer is slower, never lost.
 *
 * A fixed one-minute window per bot, in this process (the API is one process). A creation
 * whose transaction later fails for another reason has still used its place: the window is
 * a ceiling on load, not a count of customers.
 */
export class NewCustomerGate {
  private readonly windows = new Map<string, { minute: number; admitted: number }>();

  constructor(
    private readonly deps: {
      readonly clock: Clock;
      readonly limits: Pick<CapacityLimitResolver, 'numberOf'>;
      readonly pressure: Pick<LimitPressureReporter, 'hit'>;
    },
  ) {}

  /** Admits one new customer of `tenantId`, or throws the retryable refusal. */
  async admit(tenantId: string): Promise<void> {
    const limit = await this.deps.limits.numberOf(tenantId, 'NEW_CUSTOMERS_PER_MINUTE');
    if (!Number.isFinite(limit)) return;
    const minute = Math.floor(this.deps.clock.now().getTime() / MINUTE_MS);
    let window = this.windows.get(tenantId);
    if (window === undefined || window.minute !== minute) {
      window = { minute, admitted: 0 };
      this.windows.set(tenantId, window);
    }
    if (window.admitted < limit) {
      window.admitted += 1;
      return;
    }
    this.deps.pressure.hit(tenantId, 'NEW_CUSTOMERS_PER_MINUTE');
    throw new NexaError({
      kind: 'RATE_LIMITED',
      code: CAPACITY_ERROR_CODES.NEW_CUSTOMER_RATE,
      message: 'This bot is admitting new customers slowly. Deliver the update again shortly.',
      retryable: true,
    });
  }
}
