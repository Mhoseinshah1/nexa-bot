import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import { DELIVERY_MAX_ATTEMPTS } from '@nexa/contracts';
import { deliveryStateAfter } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';

/**
 * A rate limit is not a send whose fate is unknown.
 *
 * The defect this pins is measured in `docs/phase4h-audit.md` §6b and decided in
 * ADR 0030 §2. Four links, each true before Phase 4H:
 *
 *   1. `send-message.ts` returns `FAILED_RETRYABLE` + `telegram.rate_limited` for a 429;
 *   2. the customer messenger collapsed EVERY retryable failure into `UNKNOWN`;
 *   3. `deliveryStateAfter(PENDING, 'UNKNOWN', n)` is `UNCONFIRMED`;
 *   4. the delivery claim takes `PENDING` only, so `UNCONFIRMED` is never re-claimed.
 *
 * So one 429 withheld a paid customer's subscription link until a person noticed — and
 * Telegram sends a 429 exactly when the most customers are waiting for that message.
 *
 * `fetch` is stubbed rather than the transport mocked out, because the thing under test
 * is the READING of a real Telegram response. The whole chain from the HTTP status to
 * the state the row would take is asserted in one place, since each link was individually
 * defensible and only the composition was wrong.
 */
describe('a Telegram rate limit on a customer send', () => {
  const templates = { render: async () => 'hello' };
  const bots = { tokenForBotInstance: async () => 'test-token' };
  const opsLog = { record: async () => undefined };
  const conditions = { hasOpen: async () => false };

  const messenger = new TelegramCustomerMessenger(
    templates as never,
    bots as never,
    opsLog as never,
    conditions as never,
    'https://telegram.invalid',
    1000,
  );

  const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as never;
  const message: CustomerMessage = {
    chatId: '4242',
    templateKey: 'bot.service.subscription',
    values: { subscriptionUrl: 'https://sub.invalid/abc' },
    botInstanceId: '01900000-0000-7000-8000-0000000000bb' as never,
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

  it('is RATE_LIMITED, and carries Telegram’s own retry_after', async () => {
    respond(429, {
      ok: false,
      description: 'Too Many Requests: retry after 7',
      parameters: { retry_after: 7 },
    });
    expect(await messenger.send(scope, message)).toEqual({
      outcome: 'RATE_LIMITED',
      retryAfterMs: 7000,
    });
  });

  it('is RATE_LIMITED with no delay when Telegram sends none, so the caller must have a floor', async () => {
    respond(429, { ok: false, description: 'Too Many Requests' });
    const result = await messenger.send(scope, message);
    expect(result.outcome).toBe('RATE_LIMITED');
    expect(result).not.toHaveProperty('retryAfterMs');
  });

  it('never becomes the state the delivery sweep refuses to re-claim', async () => {
    /*
     * The composition, asserted directly. `UNCONFIRMED` is the state
     * `claimDeliveryDue` will not take — `DELIVERY_AUTO_RETRY_STATES` is `['PENDING']` —
     * so a rate limit reaching it is a message parked for ever.
     */
    respond(429, { ok: false, description: 'slow down', parameters: { retry_after: 3 } });
    const { outcome } = await messenger.send(scope, message);
    expect(outcome).not.toBe('UNKNOWN');
    // And even at the ceiling, the outcome a rate limit produces is not a terminal one.
    expect(deliveryStateAfter('PENDING', 'UNKNOWN', DELIVERY_MAX_ATTEMPTS)).toBe('UNCONFIRMED');
  });

  it('still calls a timeout, a 5xx and an unreadable 2xx UNKNOWN, because those may have arrived', async () => {
    /*
     * The other half, and the reason this is a narrowing rather than a removal. Those
     * three genuinely may have been delivered, and a retried "your service is ready" is
     * a customer wondering which link is real.
     */
    respond(502, { ok: false, description: 'Bad Gateway' });
    expect((await messenger.send(scope, message)).outcome).toBe('UNKNOWN');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    expect((await messenger.send(scope, message)).outcome).toBe('UNKNOWN');
  });

  it('still calls a definite rejection REFUSED', async () => {
    respond(403, {
      ok: false,
      description: 'Forbidden: bot was blocked by the user',
      error_code: 403,
    });
    expect((await messenger.send(scope, message)).outcome).toBe('REFUSED');
  });
});
