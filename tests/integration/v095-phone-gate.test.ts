import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  MANUAL_PAY_CALLBACK_PREFIX,
  START_CAPTCHA_CALLBACK_PREFIX,
  TERMS_ACCEPT_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { SUPPORT_CALLBACK_DATA } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import { SEED_IDS, tenantA } from './harness';
import {
  BOT_A,
  TG,
  customerNamed,
  lastKeyboard,
  lastReply,
  receiptFixture,
  rows,
  say,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * NEXA v095 PR-4 — the bot-wide mandatory phone gate (A), the allowed numbers (B), a payment
 * route's verified-phone rule with its resume (C) and the per-customer exemption (D), end to
 * end through the real runtime, services and PostgreSQL, with a socket standing in for
 * Telegram.
 *
 * Mutation-checked (each broken alone, the named file run, restored; recorded in the PR):
 *  - `phoneGatedAct`'s hold made unreachable -> five A/C tests here go red, the decision
 *    table first;
 *  - the exemption ignored in `PaymentGatewayService.phoneStanding` -> "an exempt customer is
 *    asked by neither A nor C" goes red;
 *  - the IRAN_ONLY check dropped in `verifyOwnContact` -> "with Iran only, refuses a foreign
 *    number" goes red;
 *  - `refuseUnverifiedPhone` moved back behind "route not offered" (its R11 shape) in
 *    `PaymentService` -> three tests of `r11-b7-phone-verification.test.ts` go red (the direct
 *    top-up writes a payment); this file's bot paths stay green because
 *    `WalletTopupFlowService.choose` and `CheckoutService.payByCard` refuse first — the
 *    defence in depth the PR describes;
 *  - `phoneRuleRefuses` always false -> `tests/unit/gateway-eligibility.test.ts` goes red.
 */
describe('NEXA v095 PR-4 — the phone gate, the route rule and the exemption', () => {
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

  const OWN = Number(TG.customer);
  const key = (label: string) => {
    seq += 1;
    return `v095-${label}-${String(seq)}-${String(Date.now())}`;
  };

  async function setFlag(flag: string, enabled: boolean): Promise<void> {
    const current = await f.ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
    await f.ctx.container.featureFlags.set(tenantA, f.owner, {
      key: flag as never,
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(`flag-${flag}`),
      reason: 'NEXA v095 PR-4 integration test.',
    });
  }

  async function setAllowedNumbers(value: 'ALL' | 'IRAN_ONLY'): Promise<void> {
    const before = await f.ctx.container.settingsService.get(
      tenantA,
      f.owner,
      'phone_verification.allowed_numbers',
    );
    await f.ctx.container.settingsService.set(tenantA, f.owner, {
      idempotencyKey: key('allowed'),
      key: 'phone_verification.allowed_numbers',
      value,
      expectedVersion: before.version,
    });
  }

  /** A contact message from the customer, as Telegram delivers one. */
  function shareContact(
    contact: { readonly phone_number: string; readonly user_id?: number },
    from: string = TG.customer,
  ) {
    seq += 1;
    f.sent = [];
    return f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: key('contact'),
      botInstanceId: BOT_A,
      update: {
        update_id: 80_000_000 + seq,
        message: {
          message_id: 9500 + seq,
          date: 0,
          chat: { id: Number(from), type: 'private' },
          from: { id: Number(from), is_bot: false, first_name: 'زهرا' },
          contact: { first_name: 'زهرا', ...contact },
        },
      },
      telegramUserId: from,
      from: { id: Number(from), first_name: 'زهرا' },
    });
  }

  const ownContact = () => shareContact({ phone_number: '989121234567', user_id: OWN });

  const markVerified = (number = '+989121234567') =>
    f.ctx.container.database.db.execute(
      sql`UPDATE customers SET phone_number = ${number}, phone_verified_at = now()
           WHERE id = ${f.customer}`,
    );

  const exempt = (exemptIt: boolean) =>
    f.ctx.container.customerControls.setPhoneExemption(tenantA, f.owner, {
      idempotencyKey: key('exempt'),
      customerId: f.customer,
      exempt: exemptIt,
      reason: 'پشتیبانی تأیید کرد',
    });

  const replyKeyboard = () =>
    (lastReply(f)['reply_markup'] as { keyboard?: { text: string; request_contact?: boolean }[][] })
      ?.keyboard;

  /** Every message the turn sent, in order. */
  const sentTexts = () =>
    f.sent
      .filter((one) => one.method === 'sendMessage' || one.method === 'editMessageText')
      .map((one) => ({
        text: String(one.body['text'] ?? ''),
        keyboard: (one.body['reply_markup'] as { keyboard?: unknown } | undefined)?.keyboard,
      }));

  const paymentCount = async () =>
    Number(
      (
        await rows<{ n: string }>(
          f,
          sql`SELECT count(*)::text AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
        )
      )[0]?.n ?? '0',
    );

  const OPEN: PaymentGatewayConfig = {
    displayName: null,
    instructions: null,
    minAmountMinor: 0n,
    maxAmountMinor: 0n,
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
  };

  const requirePhoneOnTransfer = (required: boolean) =>
    f.ctx.container.paymentGateways.configure(tenantA, f.owner, {
      idempotencyKey: key('cfg'),
      provider: 'MANUAL_TRANSFER',
      config: { ...OPEN, requiresVerifiedPhone: required },
    });

  /** A confirmed order of the fixture's customer, awaiting payment. */
  async function confirmedOrder(label: string) {
    const c = f.ctx.container;
    const products = new DrizzleProductRepository(c.database.db);
    const created = await products.create(tenantA, {
      id: c.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: f.panelA as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: c.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', c.clock.now());
    const order = await c.orders.createDraft(tenantA, systemActor(`${label}-d`), {
      idempotencyKey: key(`${label}-draft`),
      customerId: f.customer,
      productId: created.id,
    });
    return c.orders.confirm(tenantA, systemActor(`${label}-c`), {
      idempotencyKey: key(`${label}-confirm`),
      customerId: f.customer,
      orderId: order.id,
    });
  }

  const orderRow = async (orderId: string) =>
    (
      await rows<{ state: string; expires_at: Date | null }>(
        f,
        sql`SELECT state, expires_at FROM orders WHERE id = ${orderId}`,
      )
    )[0];

  /** Opens the bot's top-up for 200 000 and returns the chooser's MANUAL_TRANSFER button. */
  async function topupChooser(): Promise<string> {
    await tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer);
    await say(f, '200000', TG.customer);
    const route = lastKeyboard(f)
      .map((button) => String(button.callback_data ?? ''))
      .find((data) => data.startsWith(TOPUP_ROUTE_CALLBACK_PREFIX));
    expect(route, JSON.stringify(f.sent)).toBeDefined();
    return route as string;
  }

  // -------------------------------------------------------------------------------------
  // A — the bot-wide gate
  // -------------------------------------------------------------------------------------

  describe('A — the bot-wide mandatory gate', () => {
    it('the gate’s decision table: switch × verified × exempt, for /start, a command, a button and a deep link', async () => {
      for (const on of [false, true]) {
        for (const verified of [false, true]) {
          for (const exemptIt of [false, true]) {
            await f.reset();
            await setFlag('phone_verification', on);
            if (verified) await markVerified();
            if (exemptIt) await exempt(true);
            const held = on && !verified && !exemptIt;
            const label = JSON.stringify({ on, verified, exemptIt });
            for (const turn of [
              () => say(f, '/start', TG.customer),
              () => say(f, '/wallet', TG.customer),
              () => tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer),
              () => say(f, '/start ref-someone', TG.customer),
            ]) {
              const result = await turn();
              if (held) {
                expect(result.replyKey, label).toBe('bot.phone.required');
                // The contact button ALONE: nothing to go back to.
                expect(replyKeyboard(), label).toEqual([
                  [{ text: '📞 Share Contact', request_contact: true }],
                ]);
              } else {
                expect(result.replyKey, label).not.toBe('bot.phone.required');
              }
            }
          }
        }
      }
    });

    it('lets «پشتیبانی», /help and /paysupport through, as the channel and terms gates do, and holds the rest (OQ-V095-P4-01)', async () => {
      await setFlag('phone_verification', true);
      const support = new Set(['bot.support.contact', 'bot.support.unconfigured', 'bot.faq.page']);
      for (const turn of [
        () => say(f, CATALOGUE_FA['bot.menu.help'], TG.customer),
        () => say(f, '/help', TG.customer),
        () => say(f, '/paysupport', TG.customer),
        () => tap(f, SUPPORT_CALLBACK_DATA, TG.customer),
      ]) {
        const result = await turn();
        expect(support.has(String(result.replyKey)), String(result.replyKey)).toBe(true);
      }
      // Nothing was remembered for a turn the gate let through: verifying resumes `/start`.
      const resume = await rows<{ phone_resume: string | null }>(
        f,
        sql`SELECT phone_resume FROM customers WHERE id = ${f.customer}`,
      );
      expect(resume[0]?.phone_resume ?? null).toBeNull();
      // Everything else stays held until the customer verifies.
      for (const turn of [
        () => say(f, '/start', TG.customer),
        () => say(f, '/wallet', TG.customer),
        () => tap(f, TOPUP_MENU_CALLBACK_PREFIX, TG.customer),
      ]) {
        expect((await turn()).replyKey).toBe('bot.phone.required');
      }
    });

    it('asks after the captcha and the terms, in that order, and lets the verified customer in', async () => {
      await setFlag('start_captcha', true);
      await setFlag('phone_verification', true);
      // The terms, published and enforced.
      const draft = await f.ctx.container.terms.createDraft(tenantA, f.owner, {
        idempotencyKey: key('terms-draft'),
        title: 'قوانین',
        body: 'بند یک.',
      });
      const version = await f.ctx.container.terms.publish(tenantA, f.owner, {
        idempotencyKey: key('terms-publish'),
        id: draft.id,
        expectedRevision: draft.revision,
      });
      await setFlag('terms_enforcement', true);
      // A NEW customer, so the captcha asks them.
      const NEW = '750911';
      const first = await say(f, '/start', NEW);
      const captcha = (
        await rows<{ challenge_id: string; answer_index: number }>(
          f,
          sql`SELECT c.challenge_id, c.answer_index FROM customer_captchas c
                JOIN customers u ON u.tenant_id = c.tenant_id AND u.id = c.customer_id
               WHERE u.telegram_user_id = ${NEW}`,
        )
      )[0];
      expect(captcha, String(first.replyKey)).toBeDefined();
      // 1. the captcha's right answer continues as /start — into the terms, not the phone.
      const answered = await tap(
        f,
        `${START_CAPTCHA_CALLBACK_PREFIX}${captcha?.challenge_id ?? ''}:${String(captcha?.answer_index)}`,
        NEW,
      );
      expect(answered.replyKey).toBe('bot.terms.required');
      // 2. the terms accepted; the next turn is the phone.
      await tap(f, `${TERMS_ACCEPT_CALLBACK_PREFIX}${version.id}`, NEW);
      expect((await say(f, '/start', NEW)).replyKey).toBe('bot.phone.required');
      // 3. their own contact: verified, and `/start` (what the gate held) comes back as the menu.
      const verified = await shareContact(
        { phone_number: '989351234567', user_id: Number(NEW) },
        NEW,
      );
      expect(verified.replyKey).not.toBe('bot.phone.required');
      const texts = sentTexts();
      expect(texts[0]?.text).toContain('…4567');
      // The «verified» line takes the contact keyboard away: the main menu replaces it.
      expect(texts[0]?.keyboard).toBeDefined();
      expect(JSON.stringify(texts[0]?.keyboard)).not.toContain('request_contact');
      expect((await say(f, '/wallet', NEW)).replyKey).not.toBe('bot.phone.required');
    });

    it('refuses someone else’s contact and keeps holding the customer', async () => {
      await setFlag('phone_verification', true);
      const result = await shareContact({ phone_number: '989121234567', user_id: OWN + 7 });
      expect(result.replyKey).toBe('bot.phone.not_own');
      expect((await say(f, '/start', TG.customer)).replyKey).toBe('bot.phone.required');
    });

    it('never asks a customer verified earlier, and switching it off asks nobody', async () => {
      await markVerified('+15551234567');
      await setFlag('phone_verification', true);
      expect((await say(f, '/start', TG.customer)).replyKey).not.toBe('bot.phone.required');
      const other = '750912';
      await customerNamed(f, other, 'unverified_v095');
      expect((await say(f, '/start', other)).replyKey).toBe('bot.phone.required');
      await setFlag('phone_verification', false);
      expect((await say(f, '/start', other)).replyKey).not.toBe('bot.phone.required');
    });
  });

  // -------------------------------------------------------------------------------------
  // B — the allowed numbers
  // -------------------------------------------------------------------------------------

  describe('B — the allowed numbers', () => {
    it('accepts every number by default', async () => {
      const result = await shareContact({ phone_number: '15551234567', user_id: OWN });
      expect(result.replyKey).toBe('bot.phone.verified');
    });

    it('with Iran only, refuses a foreign number (nothing stored) and accepts 98…, +98… and 0098…', async () => {
      await setAllowedNumbers('IRAN_ONLY');
      const foreign = await shareContact({ phone_number: '15551234567', user_id: OWN });
      expect(foreign.replyKey).toBe('bot.phone.iran_only');
      const stored = await rows<{ phone_number: string | null }>(
        f,
        sql`SELECT phone_number FROM customers WHERE id = ${f.customer}`,
      );
      expect(stored[0]?.phone_number).toBeNull();
      for (const raw of ['989121234567', '+989121234567', '00989121234567']) {
        const result = await shareContact({ phone_number: raw, user_id: OWN });
        expect(result.replyKey, raw).toBe('bot.phone.verified');
      }
    });

    it('keeps a customer verified earlier with a foreign number verified (decision recorded)', async () => {
      await markVerified('+15551234567');
      await setAllowedNumbers('IRAN_ONLY');
      await setFlag('phone_verification', true);
      expect((await say(f, '/start', TG.customer)).replyKey).not.toBe('bot.phone.required');
      await requirePhoneOnTransfer(true);
      const route = await topupChooser();
      expect((await tap(f, route, TG.customer)).replyKey).not.toBe('bot.phone.gateway_required');
    });
  });

  // -------------------------------------------------------------------------------------
  // C — the route rule, and what verifying resumes
  // -------------------------------------------------------------------------------------

  describe('C — a route that needs a verified number', () => {
    for (const on of [false, true]) {
      it(`asks when the route is chosen, before any payment exists, and resumes it (bot-wide switch ${on ? 'ON' : 'OFF'})`, async () => {
        await requirePhoneOnTransfer(true);
        if (on) {
          // The bot-wide gate is passed by the verification itself; to reach the route with
          // it on, the customer must first be let in — by an exemption that is then lifted.
          await exempt(true);
          await setFlag('phone_verification', true);
        }
        const route = await topupChooser();
        if (on) await exempt(false);
        // With the gate on and the exemption lifted, the gate answers first — and resumes the tap.
        const asked = await tap(f, route, TG.customer);
        expect(asked.replyKey).toBe(on ? 'bot.phone.required' : 'bot.phone.gateway_required');
        if (!on) {
          // «📞 Share Contact» over «↩️ انتخاب درگاه دیگر».
          expect(replyKeyboard()).toEqual([
            [{ text: '📞 Share Contact', request_contact: true }],
            [{ text: CATALOGUE_FA['bot.phone.other_gateway_button'] }],
          ]);
        }
        expect(await paymentCount()).toBe(0);

        const verified = await ownContact();
        // Straight to that route's payment for the same top-up: a transfer instruction now.
        expect(await paymentCount()).toBe(1);
        expect(verified.replyKey).not.toBe('bot.phone.verified');
        const texts = sentTexts();
        expect(texts[0]?.text).toContain('…4567');
        expect(JSON.stringify(texts[0]?.keyboard)).not.toContain('request_contact');
      });
    }

    it('no payment exists before verification for an ORDER either; the order’s hold is untouched, then it resumes', async () => {
      await requirePhoneOnTransfer(true);
      const order = await confirmedOrder('resume');
      const before = await orderRow(order.id);
      const asked = await tap(f, `${MANUAL_PAY_CALLBACK_PREFIX}${order.id}`, TG.customer);
      expect(asked.replyKey).toBe('bot.phone.gateway_required');
      expect(await paymentCount()).toBe(0);
      expect(await orderRow(order.id)).toEqual(before);

      await ownContact();
      expect(await paymentCount()).toBe(1);
      const payment = await rows<{ order_id: string; method: string }>(
        f,
        sql`SELECT order_id, method FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      );
      expect(payment[0]).toMatchObject({ order_id: order.id, method: 'MANUAL_TRANSFER' });
      // The order's own hold and expiry are what they were.
      expect((await orderRow(order.id))?.expires_at).toEqual(before?.expires_at);
    });

    it('«↩️ انتخاب درگاه دیگر» drops the held tap and redraws the methods; a later contact resumes nothing', async () => {
      await requirePhoneOnTransfer(true);
      const route = await topupChooser();
      await tap(f, route, TG.customer);
      const back = await say(f, CATALOGUE_FA['bot.phone.other_gateway_button'], TG.customer);
      expect(back.replyKey).toBe('bot.wallet.topup_method_prompt');
      expect(
        lastKeyboard(f).some((button) =>
          String(button.callback_data ?? '').startsWith(TOPUP_ROUTE_CALLBACK_PREFIX),
        ),
      ).toBe(true);
      const verified = await ownContact();
      expect(verified.replyKey).toBe('bot.phone.verified');
      expect(await paymentCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------------------
  // D — the exemption
  // -------------------------------------------------------------------------------------

  describe('D — «معاف از تأیید شماره»', () => {
    it('an exempt customer is asked by neither A nor C', async () => {
      await requirePhoneOnTransfer(true);
      await setFlag('phone_verification', true);
      await exempt(true);
      expect((await say(f, '/start', TG.customer)).replyKey).not.toBe('bot.phone.required');
      const route = await topupChooser();
      const paid = await tap(f, route, TG.customer);
      expect(paid.replyKey).not.toBe('bot.phone.gateway_required');
      expect(paid.replyKey).not.toBe('bot.phone.required');
      expect(await paymentCount()).toBe(1);
    });

    it('is audited with its reason, emits its event, and appears on the overview', async () => {
      const granted = await exempt(true);
      expect(granted.changed).toBe(true);
      expect(granted.overview.customer.phoneVerificationExemptAt).not.toBeNull();
      expect((await exempt(true)).changed).toBe(false);
      const revoked = await exempt(false);
      expect(revoked.overview.customer.phoneVerificationExemptAt).toBeNull();
      const audits = await rows<{ action: string; reason: string | null }>(
        f,
        sql`SELECT action, reason FROM audit_logs WHERE entity_id = ${f.customer}
             AND action LIKE 'customer.phone_exemption.%' ORDER BY occurred_at`,
      );
      expect(audits.map((row) => row.action)).toEqual([
        'customer.phone_exemption.grant',
        'customer.phone_exemption.grant',
        'customer.phone_exemption.revoke',
      ]);
      expect(audits[0]?.reason).toBe('پشتیبانی تأیید کرد');
      const events = await rows<{ payload: unknown }>(
        f,
        sql`SELECT payload FROM outbox_messages WHERE aggregate_id = ${f.customer}
             AND event_type = 'CustomerPhoneVerificationExemptionChanged' ORDER BY sequence`,
      );
      expect(events.map((row) => row.payload)).toEqual([{ exempt: true }, { exempt: false }]);
    });
  });
});
