import { describe, expect, it, vi } from 'vitest';
import { BUSINESS_UPDATE_FAILED_CODE } from '@nexa/contracts';
import { TelegramWebhookController } from '../../apps/api/src/surfaces/telegram/webhook.controller';

/**
 * TB1 — the webhook routes the four Telegram Business updates before every other route
 * (ADR-0033 §1, `docs/support-agent/tb0-audit.md` §2).
 *
 * The regression this pins: a business message is a chat of the connected ACCOUNT. Before
 * TB1 it was dropped by accident (`telegramFromOf` reads only `message`), and a later change
 * to that reader would have run the customer turn on it — resolving, or creating, a
 * customer row for whoever wrote to the owner.
 */
describe('the Telegram webhook and Business updates', () => {
  const SECRET = 'a-sufficiently-long-secret';
  const BOT = '01900000-0000-7000-8000-00000000a001';

  function controllerWith(
    business: Partial<{
      applyReport: () => Promise<unknown>;
      recordMessage: () => Promise<unknown>;
      recordDeletion: () => Promise<unknown>;
    }> = {},
  ) {
    const container = {
      config: { TELEGRAM_WEBHOOK_SECRET: SECRET },
      botInstances: {
        findById: async () => ({ id: BOT, tenantId: 'tenant-a', status: 'ACTIVE' }),
        tokenReplacementHeld: async () => false,
      },
      clock: { now: () => new Date('2026-10-04T10:00:00Z') },
      tenants: { findById: async () => ({ id: 'tenant-a', status: 'ACTIVE' }) },
      ids: { uuid: () => '01900000-0000-7000-8000-000000000999' },
      businessConnections: {
        applyReport: vi.fn(business.applyReport ?? (async () => ({ change: 'INSERTED' }))),
      },
      businessConversations: {
        recordMessage: vi.fn(business.recordMessage ?? (async () => null)),
        recordDeletion: vi.fn(business.recordDeletion ?? (async () => 0)),
      },
      starsPayments: { preCheckout: vi.fn(), recordSuccessfulPayment: vi.fn() },
      opsGroups: { bindFromTelegram: vi.fn(), membershipChanged: vi.fn() },
      botRuntime: { handle: vi.fn(async () => undefined) },
      customers: { resolveFromUpdate: vi.fn() },
      antiSpam: { observe: vi.fn(async () => ({ verdict: 'ALLOWED' })) },
      recordPing: { execute: vi.fn(async () => undefined) },
      opsLog: { record: vi.fn(async () => undefined) },
    };
    const controller = new TelegramWebhookController(container as never);
    const receive = (update: Record<string, unknown>) =>
      controller.receive(BOT, SECRET, { update_id: 7, ...update });
    return { container, receive };
  }

  const connection = {
    id: 'conn-1',
    user: { id: 5000001, is_bot: false, first_name: 'Owner' },
    user_chat_id: 5000001,
    date: 1_790_000_000,
    is_enabled: true,
    rights: { can_reply: true },
  };
  // A customer's message to the owner. It carries `from` — a human, not a bot — which is
  // exactly what would resolve a customer if it reached the customer turn.
  const customerMessage = {
    message_id: 41,
    business_connection_id: 'conn-1',
    chat: { id: 7000001, type: 'private' },
    from: { id: 7000001, is_bot: false, first_name: 'Customer' },
    date: 1_790_000_100,
    text: '/start',
  };

  function expectNoCustomerTurn(container: ReturnType<typeof controllerWith>['container']) {
    expect(container.botRuntime.handle).not.toHaveBeenCalled();
    expect(container.customers.resolveFromUpdate).not.toHaveBeenCalled();
    expect(container.recordPing.execute).not.toHaveBeenCalled();
    expect(container.antiSpam.observe).not.toHaveBeenCalled();
  }

  it('applies a connection report, never running the customer turn', async () => {
    const { container, receive } = controllerWith();
    expect(await receive({ business_connection: connection })).toEqual({ ok: true });
    expect(container.businessConnections.applyReport).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', botInstanceId: BOT },
      expect.objectContaining({ type: 'SYSTEM_JOB' }),
      expect.objectContaining({
        idempotencyKey: `telegram:${BOT}:update:7`,
        botInstanceId: BOT,
        report: expect.objectContaining({ connectionId: 'conn-1', rights: ['can_reply'] }),
      }),
    );
    expectNoCustomerTurn(container);
  });

  it('fails the request when a connection report could not be applied, so Telegram redelivers it', async () => {
    const { container, receive } = controllerWith({
      applyReport: async () => {
        throw new Error('database unavailable');
      },
    });
    await expect(receive({ business_connection: connection })).rejects.toThrow(
      'database unavailable',
    );
    expect(container.opsLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: BUSINESS_UPDATE_FAILED_CODE }),
    );
    expectNoCustomerTurn(container);
  });

  it('routes a customer’s business message to the business module, never the customer turn', async () => {
    const { container, receive } = controllerWith();
    expect(await receive({ business_message: customerMessage })).toEqual({ ok: true });
    expect(container.businessConversations.recordMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: `telegram:${BOT}:update:7`,
        edited: false,
        message: expect.objectContaining({ fromUserId: '7000001', chatId: '7000001' }),
      }),
    );
    expectNoCustomerTurn(container);
  });

  it('routes an edited business message the same way', async () => {
    const { container, receive } = controllerWith();
    await receive({ edited_business_message: { ...customerMessage, edit_date: 1_790_000_200 } });
    expect(container.businessConversations.recordMessage).toHaveBeenCalledOnce();
    expectNoCustomerTurn(container);
  });

  it('answers 2xx and records it when a message could not be routed, so it cannot loop', async () => {
    const { container, receive } = controllerWith({
      recordMessage: async () => {
        throw new Error('database unavailable');
      },
    });
    expect(await receive({ business_message: customerMessage })).toEqual({ ok: true });
    expect(container.opsLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code: BUSINESS_UPDATE_FAILED_CODE,
        context: expect.objectContaining({ reason: 'MESSAGE_NOT_ROUTED' }),
      }),
    );
    expectNoCustomerTurn(container);
  });

  // TB1 review S3: a failed report must not turn a swallowed failure into a redelivery loop.
  it('still answers 2xx when the message failure cannot even be recorded', async () => {
    const { container, receive } = controllerWith({
      recordMessage: async () => {
        throw new Error('database unavailable');
      },
    });
    container.opsLog.record.mockRejectedValue(new Error('database unavailable'));
    expect(await receive({ business_message: customerMessage })).toEqual({ ok: true });
    const { business_connection_id: _omitted, ...broken } = customerMessage;
    expect(await receive({ business_message: broken })).toEqual({ ok: true });
    expectNoCustomerTurn(container);
  });

  // TB1 review S3, on the deletion path TB2 added: the same guard.
  it('still answers 2xx when a deletion failure cannot even be recorded', async () => {
    const { container, receive } = controllerWith({
      recordDeletion: async () => {
        throw new Error('database unavailable');
      },
    });
    container.opsLog.record.mockRejectedValue(new Error('database unavailable'));
    const deletion = {
      business_connection_id: 'conn-1',
      chat: { id: 7000001, type: 'private' },
      message_ids: [41],
    };
    expect(await receive({ deleted_business_messages: deletion })).toEqual({ ok: true });
    expect(await receive({ deleted_business_messages: { ...deletion, message_ids: 'x' } })).toEqual(
      { ok: true },
    );
    expectNoCustomerTurn(container);
  });

  it('reports a malformed business payload and still never runs the customer turn', async () => {
    const { container, receive } = controllerWith();
    const { business_connection_id: _omitted, ...broken } = customerMessage;
    expect(await receive({ business_message: broken })).toEqual({ ok: true });
    expect(container.businessConversations.recordMessage).not.toHaveBeenCalled();
    expect(container.opsLog.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: BUSINESS_UPDATE_FAILED_CODE }),
    );
    expectNoCustomerTurn(container);
  });

  it('applies a deletion through the conversation module, never the customer turn', async () => {
    const { container, receive } = controllerWith();
    await receive({
      deleted_business_messages: {
        business_connection_id: 'conn-1',
        chat: { id: 7000001, type: 'private' },
        message_ids: [41],
      },
    });
    expect(container.businessConversations.recordDeletion).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        deletion: { connectionId: 'conn-1', chatId: '7000001', messageIds: [41] },
      }),
    );
    expect(container.opsLog.record).not.toHaveBeenCalled();
    expectNoCustomerTurn(container);
  });

  it('keeps an ordinary message on the customer turn', async () => {
    const { container, receive } = controllerWith();
    await receive({
      message: {
        message_id: 1,
        from: { id: 7000001, is_bot: false },
        chat: { id: 7000001, type: 'private' },
        text: 'hello',
      },
    });
    expect(container.botRuntime.handle).toHaveBeenCalledOnce();
    expect(container.businessConversations.recordMessage).not.toHaveBeenCalled();
  });
});
