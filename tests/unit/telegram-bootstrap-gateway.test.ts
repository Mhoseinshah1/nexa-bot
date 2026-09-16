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
    });
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
});
