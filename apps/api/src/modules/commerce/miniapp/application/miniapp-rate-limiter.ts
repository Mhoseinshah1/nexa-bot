import {
  MINIAPP_ERROR_CODES,
  MINIAPP_RATE_LIMIT_WINDOW_MS,
  NexaError,
  type Clock,
  type IdGenerator,
} from '@nexa/contracts';
import type { InteractionCounter } from '../../customers/application/anti-spam.service.js';

/**
 * The mini app's request budget (Round 9, C5): at most `limit` requests per subject in a
 * rolling `MINIAPP_RATE_LIMIT_WINDOW_MS`, counted in the SAME store the bot's anti-spam
 * counts in (`InteractionCounter`, an atomic Redis increment-and-read) under its own key
 * prefix, so the two budgets never share a window.
 *
 * Why not the bot's anti-spam itself: that counter blocks a CUSTOMER after twenty
 * interactions in ten seconds, and one mini-app screen issues several reads — counting
 * them as bot interactions would block an ordinary customer for browsing. A block the
 * anti-spam did take still applies here: a BLOCKED customer is held by the first gate.
 *
 * Fails open, as anti-spam does: a store that does not answer allows the request. Every
 * request is still authenticated, gated and authorized behind this.
 */
export class MiniAppRateLimiter {
  constructor(
    private readonly deps: {
      readonly counter: InteractionCounter;
      readonly clock: Clock;
      readonly ids: Pick<IdGenerator, 'uuid'>;
    },
  ) {}

  async check(
    subject: {
      readonly tenantId: string;
      readonly botInstanceId: string;
      readonly subject: string;
    },
    limit: number,
  ): Promise<void> {
    const tally = await this.deps.counter.tally({
      tenantId: subject.tenantId,
      botInstanceId: subject.botInstanceId,
      telegramUserId: subject.subject,
      // Every request is its own interaction: a fresh id, so nothing is a "redelivery".
      updateId: this.deps.ids.uuid(),
      nowMs: this.deps.clock.now().getTime(),
      windowMs: MINIAPP_RATE_LIMIT_WINDOW_MS,
    });
    if (tally.state === 'COUNTED' && tally.count > limit) {
      throw new NexaError({
        kind: 'RATE_LIMITED',
        code: MINIAPP_ERROR_CODES.MINIAPP_RATE_LIMITED,
        message: 'Too many requests. Wait a moment.',
        details: { windowMs: MINIAPP_RATE_LIMIT_WINDOW_MS },
      });
    }
  }
}
