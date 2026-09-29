import { describe, expect, it, vi } from 'vitest';
import { TelegramWebhookController } from '../../apps/api/src/surfaces/telegram/webhook.controller';
import { STARS_CHARGE_UNMATCHED_CODE } from '../../apps/api/src/modules/commerce/payments/application/telegram-stars-payment.service';

/**
 * Package A: the webhook answers Telegram's two payment updates itself, before the
 * customer turn (`docs/package-a-telegram-stars-audit.md` §2.5–§2.6).
 *
 * The controller is built over a stub container, so what is under test is only its
 * routing: which update reaches which service, and what a failure to RECORD a charge
 * does to the HTTP answer — a non-2xx, so Telegram delivers the update again.
 */
describe('the Telegram webhook and Stars payment updates', () => {
  const SECRET = 'a-sufficiently-long-secret';
  const BOT = '01900000-0000-7000-8000-00000000a001';

  function controllerWith(record: () => Promise<unknown> = async () => 'RECORDED') {
    const container = {
      config: { TELEGRAM_WEBHOOK_SECRET: SECRET },
      botInstances: {
        findById: async () => ({ id: BOT, tenantId: 'tenant-a', status: 'ACTIVE' }),
        // R4: no token replacement in flight, so no update is held back.
        tokenReplacementHeld: async () => false,
      },
      clock: { now: () => new Date('2026-09-29T10:00:00Z') },
      tenants: { findById: async () => ({ id: 'tenant-a', status: 'ACTIVE' }) },
      ids: { uuid: () => '01900000-0000-7000-8000-000000000999' },
      starsPayments: {
        preCheckout: vi.fn(async () => true),
        recordSuccessfulPayment: vi.fn(record),
      },
      botRuntime: { handle: vi.fn(async () => undefined) },
      antiSpam: { observe: vi.fn(async () => ({ verdict: 'ALLOWED' })) },
      recordPing: { execute: vi.fn(async () => undefined) },
      opsLog: { record: vi.fn(async () => undefined) },
    };
    const controller = new TelegramWebhookController(container as never);
    const receive = (update: Record<string, unknown>) =>
      controller.receive(BOT, SECRET, { update_id: 7, ...update });
    return { container, receive };
  }

  const payment = {
    message: {
      message_id: 1,
      from: { id: 910910, is_bot: false },
      chat: { id: 910910, type: 'private' },
      successful_payment: {
        currency: 'XTR',
        total_amount: 81,
        invoice_payload: 'a'.repeat(32),
        telegram_payment_charge_id: 'ch-1',
      },
    },
  };

  it('answers a pre-checkout query through the Stars service, never the customer turn', async () => {
    const { container, receive } = controllerWith();
    await receive({
      pre_checkout_query: {
        id: 'q',
        from: { id: 910910, is_bot: false },
        currency: 'XTR',
        total_amount: 81,
        invoice_payload: 'a'.repeat(32),
      },
    });
    expect(container.starsPayments.preCheckout).toHaveBeenCalledOnce();
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
  });

  it('records a successful payment, never handing it to the customer turn', async () => {
    const { container, receive } = controllerWith();
    expect(await receive(payment)).toEqual({ ok: true });
    expect(container.starsPayments.recordSuccessfulPayment).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', botInstanceId: BOT },
      BOT,
      {
        payerTelegramUserId: '910910',
        currency: 'XTR',
        totalAmount: 81n,
        payload: 'a'.repeat(32),
        chargeId: 'ch-1',
      },
    );
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
  });

  it('fails the request when the charge could not be recorded, so Telegram redelivers it', async () => {
    const { container, receive } = controllerWith(async () => {
      throw new Error('database unavailable');
    });
    await expect(receive(payment)).rejects.toThrow('database unavailable');
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
  });

  it('reports a successful payment it cannot read, and still never runs a turn on it', async () => {
    const { container, receive } = controllerWith();
    const broken = {
      message: {
        ...payment.message,
        successful_payment: {
          ...payment.message.successful_payment,
          telegram_payment_charge_id: '',
        },
      },
    };
    expect(await receive(broken)).toEqual({ ok: true });
    expect(container.starsPayments.recordSuccessfulPayment).not.toHaveBeenCalled();
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
    expect(container.opsLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: STARS_CHARGE_UNMATCHED_CODE }),
    );
  });

  it('keeps an ordinary message on the customer turn', async () => {
    const { container, receive } = controllerWith();
    await receive({
      message: {
        message_id: 2,
        from: { id: 910910, is_bot: false },
        chat: { id: 910910, type: 'private' },
        text: '/start',
      },
    });
    expect(container.botRuntime.handle).toHaveBeenCalledOnce();
    expect(container.starsPayments.preCheckout).not.toHaveBeenCalled();
  });
});
