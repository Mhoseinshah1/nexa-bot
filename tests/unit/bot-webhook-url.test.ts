import { describe, expect, it } from 'vitest';
import { shownWebhookUrl } from '../../apps/api/src/modules/platform/tenancy/application/bot-management.service';

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
