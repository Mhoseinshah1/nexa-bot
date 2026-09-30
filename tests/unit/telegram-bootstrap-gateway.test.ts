import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramBotBootstrapGateway } from '../../apps/api/src/modules/platform/tenancy/infrastructure/telegram-bot-bootstrap.gateway';

/**
 * The translation the bootstrap gateway exists to do, and the one it used to lose.
 *
 * This class's own docblock states its job: "The transport answers in its own
 * vocabulary — retryable, permanent, 429, an unreadable 2xx — and the application
 * layer asks a question about a bot. Collapsing one into the other is this file's
 * whole job." `OQ-TG-04` items 6 and 7 are what happened when it collapsed two
 * causes that the transport had already separated.
 *
 * `fetch` is stubbed rather than the transport mocked out, for the reason
 * `telegram-transport.test.ts` gives: what is under test is the reading of a real
 * HTTP response, so a fake response object is the honest fixture. Mocking
 * `telegramGetMe` would let this file assert that the gateway maps an outcome it
 * was handed — which is true of the version that had the defect.
 */
describe('the Telegram bootstrap gateway — identify', () => {
  const gateway = new TelegramBotBootstrapGateway('https://telegram.invalid', 1000);

  const respond = (status: number, body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: status < 400, status, json: async () => body })),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('identifies a bot', async () => {
    respond(200, { ok: true, result: { id: 8123456789, username: 'acme_bot' } });
    expect(await gateway.identify('t')).toEqual({
      outcome: 'IDENTIFIED',
      botId: '8123456789',
      username: 'acme_bot',
      // Absent from this answer, so not claimed either way.
      isBot: null,
    });
  });

  it('carries is_bot as Telegram answered it (R4)', async () => {
    respond(200, { ok: true, result: { id: 8123456789, is_bot: true, username: 'acme_bot' } });
    expect(await gateway.identify('t')).toMatchObject({ outcome: 'IDENTIFIED', isBot: true });
    respond(200, { ok: true, result: { id: 8123456789, is_bot: false, username: 'someone' } });
    expect(await gateway.identify('t')).toMatchObject({ outcome: 'IDENTIFIED', isBot: false });
  });

  it('reports a token Telegram looked at and refused as REJECTED', async () => {
    respond(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    expect((await gateway.identify('t')).outcome).toBe('REJECTED');
  });

  /*
   * The defect, from the outside.
   *
   * A 2xx that parses and does not describe a bot is what a wrong
   * `TELEGRAM_API_BASE_URL` produces. Both this and the 401 above arrive as
   * `FAILED_PERMANENT`, and answering `REJECTED` for both is what told an
   * operator their token had been revoked and sent them to BotFather.
   */
  it('reports an API base that is not Telegram as NOT_TELEGRAM, not REJECTED', async () => {
    respond(200, { ok: true, result: { something: 'else' } });
    expect((await gateway.identify('t')).outcome).toBe('NOT_TELEGRAM');
  });

  it('reports a 2xx whose id is not a number as NOT_TELEGRAM', async () => {
    // A JSON API that answers every path with a generic object is the realistic
    // wrong host, and it is the case a check for "no result at all" would miss.
    respond(200, { ok: true, result: { id: 'eight', username: 'acme_bot' } });
    expect((await gateway.identify('t')).outcome).toBe('NOT_TELEGRAM');
  });

  it('keeps a rate limit UNREACHABLE rather than filing it as a bad token', async () => {
    respond(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } });
    expect((await gateway.identify('t')).outcome).toBe('UNREACHABLE');
  });

  it('keeps a 5xx UNREACHABLE', async () => {
    respond(502, { ok: false, description: 'Bad Gateway' });
    expect((await gateway.identify('t')).outcome).toBe('UNREACHABLE');
  });

  it("carries a 429's retry_after into a command registration, and nothing else's (Codex #2)", async () => {
    const commands = [{ command: 'start', description: 'شروع' }];
    respond(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 } });
    expect(await gateway.registerCommands({ token: 't', commands })).toEqual({
      outcome: 'UNREACHABLE',
      code: 'telegram.rate_limited',
      retryAfterMs: 7_000,
    });
    respond(502, { ok: false, description: 'Bad Gateway' });
    expect(await gateway.registerCommands({ token: 't', commands })).toEqual({
      outcome: 'UNREACHABLE',
      code: 'telegram.server_error.502',
    });
    respond(400, { ok: false, description: 'Bad Request: BOT_COMMAND_INVALID' });
    expect(await gateway.registerCommands({ token: 't', commands })).toEqual({
      outcome: 'REFUSED',
      code: 'telegram.rejected.400',
    });
  });
});

/**
 * R4 — the webhook calls a token replacement makes, read off the wire. The request bodies
 * are the Bot API's documented fields, and the answers are its documented shapes.
 */
describe('the Telegram bootstrap gateway — webhook calls', () => {
  const gateway = new TelegramBotBootstrapGateway('https://telegram.invalid', 1000);
  let sent: Array<{ url: string; body: unknown }>;

  const respond = (status: number, body: unknown) => {
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        sent.push({ url, body: JSON.parse(init.body) as unknown });
        return { ok: status < 400, status, json: async () => body };
      }),
    );
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resets allowed_updates to the default set only when asked, and keeps the queue', async () => {
    respond(200, { ok: true, result: true, description: 'Webhook was set' });
    const input = {
      token: 't',
      url: 'https://bot.example.test/telegram/webhook/b',
      secretToken: 's'.repeat(20),
      dropPendingUpdates: false,
    };
    expect(await gateway.registerWebhook({ ...input, resetAllowedUpdates: true })).toEqual({
      outcome: 'REGISTERED',
    });
    expect(sent[0]?.body).toEqual({
      url: input.url,
      secret_token: input.secretToken,
      drop_pending_updates: false,
      allowed_updates: [],
    });
    // The bootstrap's call is unchanged: no field, so Telegram keeps what it had.
    await gateway.registerWebhook(input);
    expect(sent[1]?.body).not.toHaveProperty('allowed_updates');
  });

  it('reads allowed_updates when Telegram reports a list, and null for the default set', async () => {
    respond(200, {
      ok: true,
      result: {
        url: 'https://bot.example.test/telegram/webhook/b',
        has_custom_certificate: false,
        pending_update_count: 2,
        max_connections: 40,
        allowed_updates: ['message', 7],
      },
    });
    expect(await gateway.readWebhook('t')).toMatchObject({
      outcome: 'READ',
      url: 'https://bot.example.test/telegram/webhook/b',
      pendingUpdateCount: 2,
      allowedUpdates: ['message'],
    });
    respond(200, {
      ok: true,
      result: { url: '', has_custom_certificate: false, pending_update_count: 0 },
    });
    expect(await gateway.readWebhook('t')).toMatchObject({
      outcome: 'READ',
      url: null,
      allowedUpdates: null,
    });
  });

  it('removes a webhook keeping the queue, and keeps an unanswered removal distinct', async () => {
    respond(200, { ok: true, result: true, description: 'Webhook was deleted' });
    expect(await gateway.removeWebhook('t')).toEqual({ outcome: 'REMOVED' });
    expect(sent[0]?.url).toMatch(/\/deleteWebhook$/u);
    expect(sent[0]?.body).toEqual({ drop_pending_updates: false });

    respond(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    expect(await gateway.removeWebhook('t')).toEqual({ outcome: 'REFUSED' });
    respond(502, { ok: false, description: 'Bad Gateway' });
    expect(await gateway.removeWebhook('t')).toEqual({ outcome: 'UNREACHABLE' });
  });
});
