import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tenantA } from './harness';
import {
  REMINDERS_OPT_IN_CALLBACK_DATA,
  REMINDERS_OPT_OUT_CALLBACK_DATA,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import {
  TG,
  customerNamed,
  lastKeyboard,
  receiptFixture,
  rows,
  say,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Round 11, B6 — the bot's half of the customer's reminder switch: a button on the support
 * screen, under the `customer_reminder_opt_out` flag (OFF by default).
 *
 * OFF: neither button is drawn and a stale tap is answered `bot.reminders.unavailable` and
 * changes nothing. ON: the screen offers the reverse of the state, a tap stores the choice for
 * THE TAPPER ONLY, answers with the way back, and a repeated tap changes nothing more.
 */
describe('the bot’s reminder switch (R11 B6)', () => {
  let f: ReceiptFixture;
  let seq = 0;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const optOutAt = async (customerId: string = f.customer): Promise<Date | null> =>
    (
      await rows<{ at: Date | null }>(
        f,
        sql`SELECT reminders_opt_out_at AS at FROM customers WHERE id = ${customerId}`,
      )
    )[0]?.at ?? null;

  async function setPolicy(enabled: boolean) {
    const current = await f.ctx.container.featureFlagResolver.resolve(
      tenantA,
      'customer_reminder_opt_out',
    );
    return f.ctx.container.featureFlags.set(tenantA, f.owner, {
      key: 'customer_reminder_opt_out',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: `reminder-policy-${String((seq += 1))}`,
      reason: 'R11 B6 integration test.',
    });
  }

  const callbacks = () => lastKeyboard(f).map((button) => button.callback_data);

  it('is OFF by default: no button on the support screen, and a stale tap changes nothing', async () => {
    expect(
      (await f.ctx.container.featureFlagResolver.resolve(tenantA, 'customer_reminder_opt_out'))
        .enabled,
    ).toBe(false);
    await say(f, '/paysupport', TG.customer);
    expect(callbacks()).not.toContain(REMINDERS_OPT_OUT_CALLBACK_DATA);
    expect(callbacks()).not.toContain(REMINDERS_OPT_IN_CALLBACK_DATA);

    expect((await tap(f, REMINDERS_OPT_OUT_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.reminders.unavailable',
    );
    expect((await tap(f, REMINDERS_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.reminders.unavailable',
    );
    expect(await optOutAt()).toBeNull();
  });

  it('ON: the support screen offers the reverse of the state and a tap stores it and answers the way back', async () => {
    await setPolicy(true);
    await say(f, '/paysupport', TG.customer);
    expect(callbacks()).toContain(REMINDERS_OPT_OUT_CALLBACK_DATA);
    expect(callbacks()).not.toContain(REMINDERS_OPT_IN_CALLBACK_DATA);

    const out = await tap(f, REMINDERS_OPT_OUT_CALLBACK_DATA, TG.customer);
    expect(out.replyKey).toBe('bot.reminders.opted_out');
    expect(callbacks()).toContain(REMINDERS_OPT_IN_CALLBACK_DATA);
    const stored = await optOutAt();
    expect(stored).not.toBeNull();

    // The screen now offers the way back, and not the thing just done.
    await say(f, '/paysupport', TG.customer);
    expect(callbacks()).toContain(REMINDERS_OPT_IN_CALLBACK_DATA);
    expect(callbacks()).not.toContain(REMINDERS_OPT_OUT_CALLBACK_DATA);

    // A repeated opt-out is answered the same and changes nothing (the conditional UPDATE).
    expect((await tap(f, REMINDERS_OPT_OUT_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.reminders.opted_out',
    );
    expect(await optOutAt()).toEqual(stored);

    expect((await tap(f, REMINDERS_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.reminders.opted_in',
    );
    expect(await optOutAt()).toBeNull();
  });

  it('changes only the tapper’s own setting, and leaves the promotional preference alone', async () => {
    await setPolicy(true);
    const other = await customerNamed(f, '750901', 'other_user');
    await tap(f, REMINDERS_OPT_OUT_CALLBACK_DATA, TG.customer);
    expect(await optOutAt(f.customer)).not.toBeNull();
    expect(await optOutAt(other)).toBeNull();
    const marketing = await rows<{ at: Date | null }>(
      f,
      sql`SELECT marketing_opt_out_at AS at FROM customers WHERE id = ${f.customer}`,
    );
    expect(marketing[0]?.at).toBeNull();
  });

  it('turning the switch off keeps the stored choice and answers a later tap “unavailable”', async () => {
    await setPolicy(true);
    await tap(f, REMINDERS_OPT_OUT_CALLBACK_DATA, TG.customer);
    const stored = await optOutAt();
    await setPolicy(false);
    expect((await tap(f, REMINDERS_OPT_IN_CALLBACK_DATA, TG.customer)).replyKey).toBe(
      'bot.reminders.unavailable',
    );
    expect(await optOutAt()).toEqual(stored);
  });
});
