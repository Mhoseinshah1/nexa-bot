import { createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import type { Update } from 'grammy/types';
import {
  errors,
  PLATFORM_ERROR_CODES,
  systemContext,
  systemJobActor,
  TELEGRAM_SECRET_TOKEN_HEADER,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The Telegram webhook receiver.
 *
 * Phase 0 scope, deliberately narrow: authenticate the update, acknowledge it,
 * and hand the work to the write path. There is no conversation state machine,
 * no menu, no product flow and no outbound send — those are Phase 1 and Phase 2.
 *
 * Two shapes are fixed here because everything later copies them:
 *
 *   - The webhook ANSWERS IMMEDIATELY and does the work behind the outbox.
 *     Telegram times a webhook out in seconds; a handler that calls a payment
 *     gateway or a panel inline will eventually be that timeout.
 *   - Every update is authenticated by the secret token header. The endpoint
 *     does not exist at all unless the feature is switched on.
 */
@Controller()
export class TelegramWebhookController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('/telegram/webhook')
  async receive(
    @Headers(TELEGRAM_SECRET_TOKEN_HEADER) secretToken: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    const expected = this.container.config.TELEGRAM_WEBHOOK_SECRET;

    if (!expected || !secretTokenMatches(secretToken, expected)) {
      throw errors.unauthenticated(
        PLATFORM_ERROR_CODES.TELEGRAM_BAD_SECRET_TOKEN,
        'Missing or incorrect Telegram secret token.',
      );
    }

    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const updateId = String(update.update_id ?? 'unknown');

    // The update is a trigger; the ping itself is system work, so it acts as
    // SYSTEM_JOB and the audit row names the update that caused it.
    const actor = systemJobActor(`telegram-update:${updateId}`, correlationId);

    if (isPingCommand(update)) {
      await this.container.recordPing.execute(systemContext('telegram-webhook'), actor, {
        // Telegram redelivers an update after a timeout; keying on the update id
        // makes that redelivery a replay rather than a second ping.
        idempotencyKey: `telegram:update:${updateId}`,
        source: 'telegram',
      });
    }

    // Always 200: a non-2xx makes Telegram retry the same update indefinitely,
    // and an update we do not handle is not an error.
    return { ok: true };
  }
}

/**
 * Constant-time comparison.
 *
 * Timing analysis over the network is not a realistic attack on a 16+ character
 * secret, but the comparison costs nothing to do correctly. Both sides are
 * hashed first so the buffers are always equal length and the comparison itself
 * cannot leak the secret's length.
 */
function secretTokenMatches(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function isPingCommand(update: Update): boolean {
  const text = update.message?.text;
  return typeof text === 'string' && text.trim().startsWith('/ping');
}
