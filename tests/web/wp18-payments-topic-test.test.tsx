import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Codex review of #82: the financial log goes to the payments topic, and that topic could
 * not be tested — the one test send went to the operations topic. The page now offers both,
 * and the operations test is sent exactly as before, with no target.
 */
describe('the test sends on the notifications page (WP18)', () => {
  const HISTORY = { url: '/notifications', body: { notifications: [], nextCursor: null } };
  const REFUSED = {
    url: '/notifications/test',
    status: 422,
    body: {
      error: {
        kind: 'validation',
        code: 'control.destination_not_configured',
        message: 'none',
        correlationId: 'test',
      },
    },
  };
  const open = () => {
    const api = stubApi([HISTORY, REFUSED]);
    renderPage(
      resolve({ path: '/notifications', query: new URLSearchParams() }, [
        'settings.edit',
        'opslog.view',
      ]).element as ReactElement,
    );
    return api;
  };
  const sent = (calls: readonly { url: string; method: string; body: unknown }[]) =>
    calls.filter((call) => call.method === 'POST' && call.url.endsWith('/notifications/test'));

  it('tests the payments topic with its own target', async () => {
    const api = open();
    fireEvent.click(await screen.findByRole('button', { name: t('web.send_test_payments') }));
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect(sent(api.calls)[0]?.body).toMatchObject({ target: 'PAYMENTS' });
  });

  it('sends the operations test exactly as before, with no target', async () => {
    const api = open();
    fireEvent.click(await screen.findByRole('button', { name: t('web.send_test') }));
    await waitFor(() => expect(sent(api.calls)).toHaveLength(1));
    expect(sent(api.calls)[0]?.body).not.toHaveProperty('target');
  });
});
