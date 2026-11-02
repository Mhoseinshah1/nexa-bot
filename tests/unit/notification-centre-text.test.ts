import { describe, expect, it } from 'vitest';
import { MINIAPP_NOTIFICATION_TEXT_MAX } from '@nexa/contracts';
import { notificationCentreText } from '../../apps/api/src/modules/commerce/messaging/application/notification-centre-text';

/**
 * Round 11, B1: the plain words a delivered message is kept under for the notification
 * centre. A pure function of the rendered body and its template's format: it removes what
 * Telegram would have drawn as markup, adds nothing, and says `null` for a body with nothing
 * to list.
 */
describe('notificationCentreText', () => {
  it('keeps a plain-text body exactly as the customer read it, characters that look like markup included', () => {
    expect(notificationCentreText('قیمت <۵۰ & >۲۰ &lt;', 'PLAIN_TEXT')).toBe('قیمت <۵۰ & >۲۰ &lt;');
  });

  it('removes the tags and unescapes the references of a Telegram-HTML body, ampersand last', () => {
    expect(
      notificationCentreText(
        '<b>سلام</b> <a href="https://x.example">لینک</a><br/>a &lt;b&gt; &amp;lt; &quot;q&quot; &#39;s&#39;',
        'TELEGRAM_HTML',
      ),
    ).toBe('سلام لینک\na <b> &lt; "q" \'s\'');
  });

  it('turns an appearance marker into its fallback emoji and decorates nothing', () => {
    const text = notificationCentreText('{icon:success} انجام شد', 'PLAIN_TEXT');
    expect(text).not.toContain('{icon');
    expect(text).toContain('انجام شد');
  });

  it('says nothing to list for a body that is empty once trimmed or only markup', () => {
    expect(notificationCentreText('  \n ', 'PLAIN_TEXT')).toBeNull();
    expect(notificationCentreText('<b></b>', 'TELEGRAM_HTML')).toBeNull();
  });

  it('cuts a long body at the bound with a visible ellipsis, never in the middle of a character', () => {
    const long = '😀'.repeat(MINIAPP_NOTIFICATION_TEXT_MAX + 10);
    const cut = notificationCentreText(long, 'PLAIN_TEXT') as string;
    expect(Array.from(cut)).toHaveLength(MINIAPP_NOTIFICATION_TEXT_MAX);
    expect(cut.endsWith('…')).toBe(true);
    const exact = 'ب'.repeat(MINIAPP_NOTIFICATION_TEXT_MAX);
    expect(notificationCentreText(exact, 'PLAIN_TEXT')).toBe(exact);
  });
});
