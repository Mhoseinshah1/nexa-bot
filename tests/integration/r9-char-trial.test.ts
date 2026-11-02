import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePanelSellable, tenantA } from './harness';
import { makePin, makeRig, viewOf, type View } from './r9-char-support';

/**
 * Characterization of the trial flow group of `bot-runtime.ts` (Round 9, Phase B).
 * `trials.test.ts` drives the claim service and asserts template keys; this file pins what
 * the bot SAYS and draws for the group's two handlers:
 *
 *   - `/trial` and the `tr:` button -> `beginTrial`: unavailable, issued straight away when
 *     exactly one panel offers a trial, or a choice of panels as buttons;
 *   - `tq:<panel>` -> `claimTrial`: issued, or the one unavailable sentence for every refusal.
 *
 * Pinned as it answers today: intent, template key, rendered text, buttons in order.
 */

const CUSTOMER = '951201';
const SECOND = '951202';

const pin = makePin(expectedViews(), (actual, expected, label) =>
  expect(actual, label).toEqual(expected),
);

describe('the trial flow of the Telegram bot, as it answers today', () => {
  const rig = makeRig();

  beforeAll(async () => {
    await rig.start();
  }, 120_000);
  afterAll(async () => {
    await rig.stop();
  });
  beforeEach(async () => {
    await rig.reset();
  });

  const turn = async (update: ReturnType<typeof rig.tap>): Promise<View> => {
    rig.sent.length = 0;
    const result = await rig.handle(update);
    return viewOf(result, rig.lastDrawn()?.body);
  };

  /** A second sellable panel, so that two panels can offer a trial. */
  async function secondPanel(): Promise<string> {
    const container = rig.ctx().container;
    const id = container.ids.uuid();
    await container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${id}, ${tenantA.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    await makePanelSellable(container, tenantA, id);
    return id;
  }

  async function offerTrial(panelId: string, label: string): Promise<void> {
    const container = rig.ctx().container;
    const owner = await rig.owner();
    const current = await container.panelTrials.get(tenantA, owner, panelId);
    await container.panelTrials.update(tenantA, owner, panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 72,
      label,
    });
  }

  it('says the trial is unavailable when no panel offers one', async () => {
    await rig.resolveCustomer(CUSTOMER);
    await rig.panelId();
    pin('trial.none_offered', await turn(rig.text('/trial', CUSTOMER)));
  });

  it('issues the trial at once when exactly one panel offers it, and refuses the second with the same sentence', async () => {
    await rig.resolveCustomer(CUSTOMER);
    await offerTrial(await rig.panelId(), 'تست رایگان');
    pin('trial.single_issued', await turn(rig.text('/trial', CUSTOMER)));
    // The allowance is spent: every refusal is the one unavailable sentence.
    pin('trial.single_second_refused', await turn(rig.tap('tr:', CUSTOMER)));
    const orders = await rig
      .ctx()
      .container.database.db.execute(sql`SELECT count(*)::int AS n FROM trial_grants`);
    expect((orders.rows[0] as { n: number }).n).toBe(1);
  });

  it('offers a choice of panels as buttons when several offer one, and claims the chosen panel', async () => {
    await rig.resolveCustomer(CUSTOMER);
    const first = await rig.panelId();
    const second = await secondPanel();
    await offerTrial(first, 'پنل اول');
    await offerTrial(second, 'پنل دوم');
    const choice = await turn(rig.text('/trial', CUSTOMER));
    pin('trial.choose_panel', {
      ...choice,
      buttons: choice.buttons.map((row) =>
        row.map(([label, data]) => [label, data.replace(/^tq:<id>$/, 'tq:<panel>')] as const),
      ),
    });
    // The buttons carry the panel ids, in the order the claim service offered them.
    const raw = (
      rig.lastDrawn()?.body['reply_markup'] as {
        inline_keyboard: { callback_data: string }[][];
      }
    ).inline_keyboard
      .flat()
      .map((button) => button.callback_data)
      .filter((data) => data.startsWith('tq:'));
    expect(raw.sort()).toEqual([`tq:${first}`, `tq:${second}`].sort());
    pin('trial.chosen_issued', await turn(rig.tap(`tq:${second}`, CUSTOMER)));
    pin('trial.chosen_second_refused', await turn(rig.tap(`tq:${first}`, CUSTOMER)));
  });

  it('answers a panel that offers no trial, and a customer who is not registered yet, with the unavailable sentence', async () => {
    await rig.resolveCustomer(CUSTOMER);
    await rig.panelId();
    pin(
      'trial.panel_not_offering',
      await turn(rig.tap(`tq:${rig.ctx().container.ids.uuid()}`, CUSTOMER)),
    );
    pin('trial.panel_malformed', await turn(rig.tap('tq:nope', CUSTOMER)));
    // A customer who has not started the bot is resolved by this very turn.
    await offerTrial(await rig.panelId(), 'تست رایگان');
    pin('trial.new_customer_single', await turn(rig.text('/trial', SECOND)));
  });
});

function expectedViews(): Record<string, View> {
  return {
    'trial.none_offered': {
      intent: 'TRIAL_CLAIM',
      key: 'bot.trial.unavailable',
      text: '🧪 در حال حاضر امکان دریافت سرویس تست برای شما وجود ندارد.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.single_issued': {
      intent: 'TRIAL_CLAIM',
      key: 'bot.trial.issued',
      text: '🧪 سرویس تست شما در حال ساخته شدن است. لینک اتصال به\u200cمحض آماده شدن برایتان ارسال می\u200cشود.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.single_second_refused': {
      intent: 'TRIAL_CLAIM',
      key: 'bot.trial.unavailable',
      text: '🧪 در حال حاضر امکان دریافت سرویس تست برای شما وجود ندارد.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.choose_panel': {
      intent: 'TRIAL_CLAIM',
      key: 'bot.trial.choose_panel',
      text: '🧪 سرویس تست را روی کدام سرور می\u200cخواهید؟ یکی را انتخاب کنید:',
      buttons: [
        [['پنل اول — 0.1 گیگابایت / 72 ساعت', 'tq:<panel>']],
        [['پنل دوم — 0.1 گیگابایت / 72 ساعت', 'tq:<panel>']],
        [['🏠 بازگشت به منوی اصلی', 'mm:']],
      ],
    },
    'trial.chosen_issued': {
      intent: 'TRIAL_PANEL',
      key: 'bot.trial.issued',
      text: '🧪 سرویس تست شما در حال ساخته شدن است. لینک اتصال به\u200cمحض آماده شدن برایتان ارسال می\u200cشود.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.chosen_second_refused': {
      intent: 'TRIAL_PANEL',
      key: 'bot.trial.unavailable',
      text: '🧪 در حال حاضر امکان دریافت سرویس تست برای شما وجود ندارد.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.panel_not_offering': {
      intent: 'TRIAL_PANEL',
      key: 'bot.trial.unavailable',
      text: '🧪 در حال حاضر امکان دریافت سرویس تست برای شما وجود ندارد.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.panel_malformed': {
      intent: 'UNSUPPORTED',
      key: 'bot.callback.stale',
      text: 'ℹ️ این دکمه دیگر فعال نیست. برای ادامه، دکمهٔ زیر را بزنید.',
      buttons: [[['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
    'trial.new_customer_single': {
      intent: 'TRIAL_CLAIM',
      key: 'bot.trial.issued',
      text: '🧪 سرویس تست شما در حال ساخته شدن است. لینک اتصال به\u200cمحض آماده شدن برایتان ارسال می\u200cشود.',
      buttons: [[['🏠 بازگشت به لیست سرویس ها', 'sl:1']], [['🏠 بازگشت به منوی اصلی', 'mm:']]],
    },
  };
}
