import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramBusinessGateway,
  isUnknownConnection,
} from '../../apps/api/src/modules/commerce/business-chats/infrastructure/telegram-business.gateway';

/**
 * TB1 — `getBusinessConnection`'s answers, mapped (TB1 review S2).
 *
 * Only Telegram saying this connection is unknown is NOT_FOUND, which `verify` records as
 * disabled. A rejected token (401), a 403, or any other 400 is about the request, and must
 * leave the stored connection alone — nothing would ever re-read a connection parked as
 * disabled by mistake.
 */
describe('the Telegram Business gateway', () => {
  const gateway = new TelegramBusinessGateway({
    apiBaseUrl: 'https://api.telegram.test',
    timeoutMs: 1000,
  });

  function answer(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const connection = {
    id: 'conn-1',
    user: { id: 5000001, is_bot: false, first_name: 'Owner' },
    user_chat_id: 5000001,
    date: 1_790_000_000,
    is_enabled: true,
    rights: { can_reply: true },
  };

  it('reads a connection Telegram describes', async () => {
    answer(200, { ok: true, result: connection });
    const found = await gateway.getConnection('token', 'conn-1');
    expect(found).toMatchObject({
      outcome: 'FOUND',
      report: { connectionId: 'conn-1', rights: ['can_reply'] },
    });
  });

  it('reads Telegram naming the business connection invalid as NOT_FOUND', async () => {
    answer(400, {
      ok: false,
      error_code: 400,
      description: 'Bad Request: BUSINESS_CONNECTION_INVALID',
    });
    expect((await gateway.getConnection('token', 'conn-1')).outcome).toBe('NOT_FOUND');
  });

  it.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden: bot was blocked'],
    [400, 'Bad Request: chat not found'],
  ])('never reads a %i (%s) as the connection being gone', async (status, description) => {
    answer(status, { ok: false, error_code: status, description });
    expect((await gateway.getConnection('token', 'conn-1')).outcome).toBe('UNAVAILABLE');
  });

  it('never reads an unreadable 2xx, or an answer about another id, as an answer about this one', async () => {
    answer(200, { ok: true, result: { nonsense: true } });
    expect((await gateway.getConnection('token', 'conn-1')).outcome).toBe('UNAVAILABLE');
    answer(200, { ok: true, result: { ...connection, id: 'conn-other' } });
    expect((await gateway.getConnection('token', 'conn-1')).outcome).toBe('UNAVAILABLE');
  });

  it('names the unknown-connection shape narrowly', () => {
    expect(
      isUnknownConnection('telegram.rejected.400', 'Bad Request: business connection not found'),
    ).toBe(true);
    expect(
      isUnknownConnection('telegram.rejected.401', 'Unauthorized: BUSINESS_CONNECTION_INVALID'),
    ).toBe(false);
    expect(isUnknownConnection('telegram.rejected.400', 'Bad Request: message text is empty')).toBe(
      false,
    );
  });
});
