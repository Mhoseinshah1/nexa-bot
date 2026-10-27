import { describe, expect, it, vi } from 'vitest';
import { telegramUpdateSchema } from '@nexa/contracts';
import { TelegramWebhookController } from '../../apps/api/src/surfaces/telegram/webhook.controller';

/**
 * R11 A5 — Bot API 10.2 compatibility: an update KIND this installation does not know.
 *
 * Telegram adds top-level update keys on its own schedule (10.2 added the bot
 * `subscription` update). The decoder keeps only `update_id` as required and lets every
 * other key through, and the webhook routes by key presence — so a kind nobody wrote a
 * route for matches none of them. This pins the consequence the receiving end depends on:
 * the route answers a successful 2xx (a non-2xx makes Telegram redeliver it for a day), it
 * raises no exception, no ops event and no log line, and no handler runs.
 *
 * The `subscription` payload below is a representative shape, not a copy of Telegram's
 * schema: the point of the test is that the decoder does not need to know it.
 */
describe('the Telegram webhook and update kinds it does not know', () => {
  const SECRET = 'a-sufficiently-long-secret';
  const BOT = '01900000-0000-7000-8000-00000000a001';

  function controller() {
    const quiet = () => vi.fn();
    const container = {
      config: { TELEGRAM_WEBHOOK_SECRET: SECRET },
      botInstances: {
        findById: async () => ({ id: BOT, tenantId: 'tenant-a', status: 'ACTIVE' }),
        tokenReplacementHeld: async () => false,
      },
      clock: { now: () => new Date('2026-10-27T10:00:00Z') },
      tenants: { findById: async () => ({ id: 'tenant-a', status: 'ACTIVE' }) },
      ids: { uuid: () => '01900000-0000-7000-8000-000000000999' },
      logger: { debug: quiet(), info: quiet(), warn: quiet(), error: quiet(), fatal: quiet() },
      businessConnections: { applyReport: vi.fn() },
      businessConversations: { recordMessage: vi.fn(), recordDeletion: vi.fn() },
      starsPayments: { preCheckout: vi.fn(), recordSuccessfulPayment: vi.fn() },
      opsGroups: { bindFromTelegram: vi.fn(), membershipChanged: vi.fn() },
      botRuntime: { handle: vi.fn(async () => undefined) },
      customers: { resolveFromUpdate: vi.fn() },
      antiSpam: { observe: vi.fn(async () => ({ verdict: 'ALLOWED' })) },
      recordPing: { execute: vi.fn(async () => undefined) },
      opsLog: { record: vi.fn(async () => undefined) },
    };
    const instance = new TelegramWebhookController(container as never);
    return {
      container,
      receive: (body: unknown) => instance.receive(BOT, SECRET, body),
    };
  }

  function expectIgnored(container: ReturnType<typeof controller>['container']) {
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
    expect(container.customers.resolveFromUpdate).not.toHaveBeenCalled();
    expect(container.recordPing.execute).not.toHaveBeenCalled();
    expect(container.antiSpam.observe).not.toHaveBeenCalled();
    expect(container.businessConnections.applyReport).not.toHaveBeenCalled();
    expect(container.businessConversations.recordMessage).not.toHaveBeenCalled();
    expect(container.starsPayments.preCheckout).not.toHaveBeenCalled();
    expect(container.starsPayments.recordSuccessfulPayment).not.toHaveBeenCalled();
    expect(container.opsGroups.bindFromTelegram).not.toHaveBeenCalled();
    expect(container.opsGroups.membershipChanged).not.toHaveBeenCalled();
    // No operator-facing noise: not an ops event, not a log line of any level.
    expect(container.opsLog.record).not.toHaveBeenCalled();
    for (const level of Object.values(container.logger)) expect(level).not.toHaveBeenCalled();
  }

  it('answers a Bot API 10.2 `subscription` update with a success and runs nothing', async () => {
    const { container, receive } = controller();
    await expect(
      receive({
        update_id: 9001,
        subscription: {
          user: { id: 7000001, is_bot: false, first_name: 'Customer' },
          subscription_id: 'sub-1',
          status: 'active',
          expires_at: 1_790_000_000,
        },
      }),
    ).resolves.toEqual({ ok: true });
    expectIgnored(container);
  });

  it('answers a made-up future kind with a success and runs nothing', async () => {
    const { container, receive } = controller();
    await expect(
      receive({
        update_id: 9002,
        quantum_relay_post: { from: { id: 7000001, is_bot: false }, text: '/start' },
      }),
    ).resolves.toEqual({ ok: true });
    expectIgnored(container);
  });

  it('answers an unknown kind that sits beside known-looking keys inside it', async () => {
    const { container, receive } = controller();
    await expect(
      receive({
        update_id: 9003,
        future_thing: {
          message: { text: '/ping' },
          callback_query: { data: 'x' },
          from: { id: 1 },
        },
      }),
    ).resolves.toEqual({ ok: true });
    expectIgnored(container);
  });

  it('still refuses a body with no integer update_id, unknown kind or not', async () => {
    const { receive } = controller();
    await expect(receive({ subscription: { user: { id: 1 } } })).rejects.toThrow();
    await expect(receive({ update_id: '9001', subscription: {} })).rejects.toThrow();
  });

  it('tolerates unknown fields inside a known update and hands them on untouched', async () => {
    const { container, receive } = controller();
    const message = {
      message_id: 1,
      from: { id: 7000001, is_bot: false, first_name: 'C', brand_new_user_field: { a: 1 } },
      chat: { id: 7000001, type: 'private', brand_new_chat_field: true },
      text: 'hello',
      brand_new_message_field: ['x'],
    };
    await expect(
      receive({ update_id: 9004, message, brand_new_top_level_field: 1 }),
    ).resolves.toEqual({ ok: true });
    expect(container.botRuntime.handle).toHaveBeenCalledOnce();
    const call = container.botRuntime.handle.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { update: { message: unknown; brand_new_top_level_field: unknown } },
    ];
    expect(call[2].update.message).toEqual(message);
    expect(call[2].update.brand_new_top_level_field).toBe(1);
  });

  describe('the decoder (telegramUpdateSchema)', () => {
    it('requires only update_id and keeps every other key, at any depth', () => {
      const body = {
        update_id: 5,
        subscription: { user: { id: 1 }, nested: { deeper: [1, 2] } },
        message: { text: 'hi', future_field: 1 },
      };
      expect(telegramUpdateSchema.parse(body)).toEqual(body);
    });

    it('does not accept a missing, fractional or textual update_id', () => {
      for (const bad of [{}, { update_id: 1.5 }, { update_id: '1' }, { update_id: null }]) {
        expect(telegramUpdateSchema.safeParse(bad).success).toBe(false);
      }
    });
  });
});
