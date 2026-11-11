import {
  NexaError,
  RESELLER_WEB_ERROR_CODES,
  RESELLER_WEB_LOGIN_ATTEMPTS_PER_MINUTE,
  type Clock,
  type IdGenerator,
} from '@nexa/contracts';
import type { InteractionCounter } from '../../customers/application/anti-spam.service.js';

const WINDOW_MS = 60_000;

/**
 * PR-4: sign-in attempts per client address — the link exchange and the code step — counted in
 * the same Redis store the mini app's budget uses, under its own prefix. Fails open, as that one
 * does: a store that does not answer allows the attempt; the link itself (256 bits, single use,
 * ten minutes) and the code's own five-attempt bound still stand behind it.
 */
export class ResellerWebLoginRateLimiter {
  constructor(
    private readonly deps: {
      readonly counter: InteractionCounter;
      readonly clock: Clock;
      readonly ids: Pick<IdGenerator, 'uuid'>;
      readonly limit?: number;
    },
  ) {}

  async check(ip: string | null): Promise<void> {
    const tally = await this.deps.counter.tally({
      tenantId: 'reseller-web-login',
      botInstanceId: 'any',
      telegramUserId: `ip:${ip ?? 'unknown'}`,
      updateId: this.deps.ids.uuid(),
      nowMs: this.deps.clock.now().getTime(),
      windowMs: WINDOW_MS,
    });
    const limit = this.deps.limit ?? RESELLER_WEB_LOGIN_ATTEMPTS_PER_MINUTE;
    if (tally.state === 'COUNTED' && tally.count > limit) {
      throw new NexaError({
        kind: 'RATE_LIMITED',
        code: RESELLER_WEB_ERROR_CODES.RATE_LIMITED,
        message: 'Too many sign-in attempts. Wait a moment.',
        details: { windowMs: WINDOW_MS },
      });
    }
  }
}
