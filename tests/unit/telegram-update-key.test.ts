import { describe, expect, it } from 'vitest';
import { telegramUpdateKey } from '../../apps/api/src/surfaces/telegram/webhook.controller';

/**
 * The premise the whole cancellation-concurrency package rests on.
 *
 * `cancelByCustomer` has one production caller and no HTTP route, so every racing
 * pair of requests is a pair of Telegram updates. Whether the idempotency guard
 * can collapse them is decided entirely here, and the two cases are different
 * mechanisms that WP4 must keep apart:
 *
 *   - Telegram REDELIVERS one update — same id, same key, so `replay` answers from
 *     the record and no second transaction opens.
 *   - The customer TAPS TWICE — two updates, two ids, two different keys, which
 *     the replay guard cannot collapse and which therefore race for real.
 *
 * If this ever became one key per (bot, customer) or per callback payload, the
 * second case would stop being reachable and the conditional-audit rule in
 * `OrderService.cancelByCustomer` would look like dead weight. It is not; this is
 * why.
 */
describe('the Telegram idempotency key', () => {
  const BOT = '01900000-0000-7000-8000-000000000001';

  it('is the same for a redelivery of one update', () => {
    expect(telegramUpdateKey(BOT, '55')).toBe(telegramUpdateKey(BOT, '55'));
  });

  it('differs for two updates, which is what makes a double tap a real race', () => {
    expect(telegramUpdateKey(BOT, '55')).not.toBe(telegramUpdateKey(BOT, '56'));
  });

  /**
   * And it is scoped to the bot instance, so two installations sharing an update
   * counter cannot collide into one another's idempotency records.
   */
  it('is scoped to the bot instance', () => {
    const other = '01900000-0000-7000-8000-000000000002';
    expect(telegramUpdateKey(BOT, '55')).not.toBe(telegramUpdateKey(other, '55'));
  });
});
