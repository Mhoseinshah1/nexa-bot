import { describe, expect, it } from 'vitest';
import { shownWebhookUrl } from '../../apps/api/src/modules/platform/tenancy/application/bot-management.service';
import {
  allowedUpdatesNarrowed,
  expectedWebhookUrl,
  TELEGRAM_HANDLED_UPDATE_TYPES,
  TELEGRAM_WEBHOOK_PATH_PREFIX,
  telegramWebhookUrl,
} from '../../apps/api/src/modules/platform/tenancy/domain/webhook-url';
import { TELEGRAM_WEBHOOK_ROUTE_PREFIX } from '../../apps/api/src/surfaces/telegram/webhook.controller';

/**
 * WP13 review — the live check's webhook URL. Ours is shown in full; anybody else's is cut
 * to its origin, because the path of a foreign registration is where a bot token lives.
 */
describe('the webhook URL the live check may show', () => {
  const RECORDED = 'https://bot.example.test/telegram/webhook/a1';

  it('shows the recorded URL in full', () => {
    expect(shownWebhookUrl(RECORDED, RECORDED)).toBe(RECORDED);
  });

  it('cuts a foreign URL to its origin, whatever its path carries', () => {
    expect(shownWebhookUrl('https://legacy.example.test/123:SECRET/hook', RECORDED)).toBe(
      'https://legacy.example.test/…',
    );
    // With nothing recorded, nothing is known to be ours.
    expect(shownWebhookUrl('https://legacy.example.test/123:SECRET', null)).toBe(
      'https://legacy.example.test/…',
    );
  });

  it('shows no URL for an empty registration or one that does not parse', () => {
    expect(shownWebhookUrl(null, RECORDED)).toBeNull();
    expect(shownWebhookUrl('not a url 123:SECRET', RECORDED)).toBeNull();
  });
});

/**
 * R4 — the URL a token replacement registers. The API is not told the public origin, so
 * it recomposes the URL from the registration the installer RECORDED, and trusts it only
 * when the recomposition is exactly that record.
 */
describe('the webhook URL a token replacement registers', () => {
  const BOT = '01900000-0000-7000-8000-00000000a001';
  const RECORDED = `https://bot.example.test/telegram/webhook/${BOT}`;

  it('is composed on the route the webhook controller serves', () => {
    expect(TELEGRAM_WEBHOOK_PATH_PREFIX).toBe(TELEGRAM_WEBHOOK_ROUTE_PREFIX);
    expect(telegramWebhookUrl('https://bot.example.test', BOT)).toBe(RECORDED);
  });

  it('is the recorded registration, recomposed, when that is exactly this bot on https', () => {
    expect(expectedWebhookUrl(RECORDED, BOT)).toBe(RECORDED);
    expect(expectedWebhookUrl(`https://bot.example.test:8443/telegram/webhook/${BOT}`, BOT)).toBe(
      `https://bot.example.test:8443/telegram/webhook/${BOT}`,
    );
  });

  it('is unknown for anything the installer did not register for this bot', () => {
    for (const recorded of [
      null,
      'not a url',
      `http://bot.example.test/telegram/webhook/${BOT}`,
      `https://bot.example.test/telegram/webhook/01900000-0000-7000-8000-00000000a002`,
      'https://bot.example.test/telegram/webhook/a1',
      `https://bot.example.test/prefix/telegram/webhook/${BOT}`,
      `https://bot.example.test/telegram/webhook/${BOT}/`,
      `https://bot.example.test/telegram/webhook/${BOT}?x=1`,
      `https://bot.example.test/telegram/webhook/${BOT}#x`,
      `https://user:pass@bot.example.test/telegram/webhook/${BOT}`,
      // Normalisation would change it: not exactly what was recorded.
      `https://BOT.example.test:443/telegram/webhook/${BOT}`,
    ]) {
      expect(expectedWebhookUrl(recorded, BOT), String(recorded)).toBeNull();
    }
  });

  it('shows the expected URL in full, as it shows the recorded one', () => {
    expect(shownWebhookUrl(RECORDED, null, RECORDED)).toBe(RECORDED);
    expect(shownWebhookUrl('https://legacy.example.test/1:S', null, RECORDED)).toBe(
      'https://legacy.example.test/…',
    );
  });

  it('calls an update set narrowed only when it leaves out a type the bot handles', () => {
    expect(allowedUpdatesNarrowed(null)).toBe(false);
    expect(allowedUpdatesNarrowed([])).toBe(false);
    expect(allowedUpdatesNarrowed([...TELEGRAM_HANDLED_UPDATE_TYPES, 'chat_member'])).toBe(false);
    expect(allowedUpdatesNarrowed(['message'])).toBe(true);
    for (const missing of TELEGRAM_HANDLED_UPDATE_TYPES) {
      expect(
        allowedUpdatesNarrowed(TELEGRAM_HANDLED_UPDATE_TYPES.filter((type) => type !== missing)),
        missing,
      ).toBe(true);
    }
  });
});
