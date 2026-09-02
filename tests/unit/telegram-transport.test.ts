import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotificationTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/telegram-transport';
import type { OutboundMessage } from '../../apps/api/src/modules/control/notifications/application/ports';

/**
 * How the Telegram transport classifies what comes back.
 *
 * This is the only place in the notification path where a third party decides
 * the outcome, and the retryable/permanent split is what stops a wrong chat id
 * being retried forever — the legacy log group's sixty-identical-errors failure
 * with a scheduler in front of it.
 *
 * `fetch` is stubbed rather than mocked out of a wrapper: the thing under test
 * is the reading of a real HTTP response, so a fake response object is the
 * honest fixture.
 */
describe('the Telegram notification transport', () => {
  const bots = { activeTokenForTenant: async () => 'test-token' };
  const transport = new TelegramNotificationTransport(bots, 'https://telegram.invalid', 1000);

  const message: OutboundMessage = {
    destination: { transport: 'TELEGRAM', chatId: '-100999', topicId: null },
    text: 'hello',
    html: false,
    tenantId: '01900000-0000-7000-8000-000000000001',
  };

  const respond = (status: number, body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: status < 400, status, json: async () => body })),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports a success', async () => {
    respond(200, { ok: true });
    expect(await transport.send(message)).toEqual({ outcome: 'SUCCEEDED' });
  });

  it('honours the retry_after Telegram asks for', async () => {
    // Verbatim, in preference to any back-off we would have computed: Telegram
    // knows what it wants and a number we invented would be rude or slow.
    respond(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 12 } });
    expect(await transport.send(message)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.rate_limited',
      retryAfterMs: 12_000,
    });
  });

  it('treats a rate limit with no retry_after as retryable anyway', async () => {
    respond(429, { ok: false, description: 'Too Many Requests' });
    const result = await transport.send(message);
    expect(result.outcome).toBe('FAILED_RETRYABLE');
    expect(result).not.toHaveProperty('retryAfterMs');
  });

  it('treats a server error as retryable', async () => {
    respond(502, { ok: false, description: 'Bad Gateway' });
    expect(await transport.send(message)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.server_error.502',
    });
  });

  it('treats a rejection as permanent', async () => {
    // A bad chat id, a bot that is not a member, a malformed parse mode. None
    // of these become right by being retried.
    respond(400, { ok: false, description: 'chat not found', error_code: 400 });
    expect(await transport.send(message)).toMatchObject({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
      errorMessage: 'chat not found',
    });
  });

  it('treats a 200 with ok:false as a rejection', async () => {
    // Telegram answers some failures with HTTP 200 and `ok: false`. Reading
    // only the status code would record these as delivered.
    respond(200, { ok: false, description: 'message is empty', error_code: 400 });
    expect(await transport.send(message)).toMatchObject({ outcome: 'FAILED_PERMANENT' });
  });

  it('treats an unreachable API as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    );
    expect(await transport.send(message)).toMatchObject({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
    });
  });

  it('fails permanently when the tenant has no bot to send from', async () => {
    const withoutBot = new TelegramNotificationTransport(
      { activeTokenForTenant: async () => null },
      'https://telegram.invalid',
      1000,
    );
    expect(await withoutBot.send(message)).toMatchObject({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.no_bot_configured',
    });
  });

  it('refuses a destination belonging to another transport', async () => {
    expect(
      await transport.send({ ...message, destination: { transport: 'RECORDING' } }),
    ).toMatchObject({ outcome: 'FAILED_PERMANENT', errorCode: 'transport.mismatch' });
  });

  it('sets a parse mode only for an HTML template, and passes the topic through', async () => {
    const calls: { body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        calls.push({ body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );

    await transport.send(message);
    expect(calls[0]?.body).not.toHaveProperty('parse_mode');
    expect(calls[0]?.body).not.toHaveProperty('message_thread_id');

    await transport.send({
      ...message,
      html: true,
      destination: { transport: 'TELEGRAM', chatId: '-100999', topicId: 7 },
    });
    expect(calls[1]?.body).toMatchObject({ parse_mode: 'HTML', message_thread_id: 7 });
  });
});
