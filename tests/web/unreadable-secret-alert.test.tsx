import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { AlertsPage } from '../../apps/web/src/pages/alerts';
import { event, renderPage, stubApi } from './harness';

/*
 * NEXA-FIX-RESTORE-SECRETS §2.6: the «هشدارهای مدیریتی» page reads an unreadable stored
 * secret as its KIND and the page to re-enter it on — from the row's `context.secretKind` —
 * because the operations group may itself need the token that cannot be read.
 */
describe('an unreadable stored secret on the alerts page', () => {
  it('names the kind and where to re-enter it', async () => {
    stubApi([
      {
        url: '/ops-log',
        body: {
          events: [
            event({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d1',
              code: 'secrets.read_failed',
              severity: 'ERROR',
              message: 'A stored bot_instance.token secret cannot be read.',
              context: { secretKind: 'BOT_TOKEN', purpose: 'bot_instance.token' },
            }),
            event({
              id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d2',
              code: 'secrets.read_failed',
              severity: 'ERROR',
              message: 'A stored panel.password secret cannot be read.',
              context: { secretKind: 'PANEL_CREDENTIALS', purpose: 'panel.password' },
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<AlertsPage denied={false} />);

    expect(
      await screen.findByText(
        'توکن ربات قابل خواندن نیست؛ آن را در صفحهٔ ربات‌ها دوباره وارد کنید.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'نام کاربری یا رمز پنل قابل خواندن نیست؛ آن را در صفحهٔ پنل‌ها دوباره وارد کنید.',
      ),
    ).toBeTruthy();
  });
});
