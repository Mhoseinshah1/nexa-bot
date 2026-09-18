import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SystemPage } from '../../apps/web/src/pages/system';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * System → Administrators → the Telegram binding.
 *
 * An installation can already hold an owner with no binding (v0.2.5 created
 * them that way), and the bot's `/link` has to be sent by an administrator who
 * is already bound — so this cell is the one supported way such an
 * installation gets its first Telegram administrator. Driven through the real
 * client and the real schema, against a stubbed `fetch`.
 */

const OWNER_ID = '019a0000-0000-7000-8000-000000000001';

function admin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: OWNER_ID,
    username: 'mamad',
    displayName: 'Mamad Owner',
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['owner'],
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: null,
    ...overrides,
  };
}

const adminsRoute = {
  path: '/system',
  query: new URLSearchParams('section=admins'),
} as unknown as Parameters<typeof SystemPage>[0]['route'];

describe('the administrators section', () => {
  it('shows an unbound administrator as not connected, and a bound one by numeric id', async () => {
    stubApi([
      {
        url: '/admins',
        body: {
          admins: [
            admin(),
            admin({
              id: '019a0000-0000-7000-8000-000000000002',
              username: 'reviewer',
              telegramUserId: '123456789',
              roleKeys: ['receipt_reviewer'],
            }),
          ],
        },
      },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view']} />);

    expect(await screen.findByText(t('web.admin_telegram_not_connected'))).toBeInTheDocument();
    expect(screen.getByText('123456789')).toBeInTheDocument();
    // A viewer may look and not touch: no connect, edit or remove control at all.
    expect(screen.queryByText(t('web.admin_telegram_connect'))).toBeNull();
    expect(screen.queryByText(t('web.admin_telegram_edit'))).toBeNull();
  });

  it('connects an existing unbound owner through the audited route', async () => {
    const api = stubApi([
      { url: '/admins', body: { admins: [admin()] } },
      { url: `/admins/${OWNER_ID}/telegram`, body: admin({ telegramUserId: '123456789' }) },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);

    fireEvent.click(await screen.findByText(t('web.admin_telegram_connect')));
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_id_label')), {
      target: { value: '123456789' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_reason_label')), {
      target: { value: 'staging owner' },
    });
    const form = screen.getByLabelText(t('web.admin_telegram_id_label')).closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.click(within(form).getByText(t('web.admin_telegram_connect')));

    await waitFor(() => {
      const call = api.calls.find((one) => one.url.includes(`/admins/${OWNER_ID}/telegram`));
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({ telegramUserId: '123456789', reason: 'staging owner' });
    });
    // The server's own row replaces the roster entry: the id is shown, the
    // form is gone, and the operator is told the owner has to /start the bot.
    expect(await screen.findByText('123456789')).toBeInTheDocument();
    expect(screen.queryByText(t('web.admin_telegram_not_connected'))).toBeNull();
    expect(screen.getByText(t('web.admin_telegram_connected_done'))).toBeInTheDocument();
  });

  it('refuses a value that is not a numeric id before any request is made', async () => {
    const api = stubApi([{ url: '/admins', body: { admins: [admin()] } }]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);

    fireEvent.click(await screen.findByText(t('web.admin_telegram_connect')));
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_id_label')), {
      target: { value: '@mamad' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_reason_label')), {
      target: { value: 'typo' },
    });
    const form = screen.getByLabelText(t('web.admin_telegram_id_label')).closest('form');
    if (form === null) throw new Error('no form');
    fireEvent.submit(form);

    expect(await screen.findByRole('alert')).toHaveTextContent(t('web.admin_telegram_id_invalid'));
    expect(api.calls.some((one) => one.url.includes('/telegram'))).toBe(false);
  });

  it('offers replace and remove for a bound administrator, and reports a taken id', async () => {
    const BOUND = admin({ telegramUserId: '123456789' });
    const api = stubApi([
      { url: '/admins', body: { admins: [BOUND] } },
      {
        url: `/admins/${OWNER_ID}/telegram`,
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'admin.telegram_id_taken',
            message: 'That Telegram account is already linked to an administrator.',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);

    fireEvent.click(await screen.findByText(t('web.admin_telegram_edit')));
    expect(screen.getByText(t('web.admin_telegram_remove'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_id_label')), {
      target: { value: '987654321' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_reason_label')), {
      target: { value: 'new phone' },
    });
    fireEvent.click(screen.getByText(t('web.admin_telegram_replace')));

    expect(await screen.findByRole('alert')).toHaveTextContent(t('web.admin_telegram_id_taken'));
    const call = api.calls.find((one) => one.url.includes(`/admins/${OWNER_ID}/telegram`));
    expect(call?.body).toEqual({ telegramUserId: '987654321', reason: 'new phone' });
    // The binding on screen is still the one the server holds.
    expect(screen.getByText('123456789')).toBeInTheDocument();
  });

  it('removes a binding with a null id and the reason', async () => {
    const api = stubApi([
      { url: '/admins', body: { admins: [admin({ telegramUserId: '123456789' })] } },
      { url: `/admins/${OWNER_ID}/telegram`, body: admin({ telegramUserId: null }) },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);

    fireEvent.click(await screen.findByText(t('web.admin_telegram_edit')));
    fireEvent.change(screen.getByLabelText(t('web.admin_telegram_reason_label')), {
      target: { value: 'left' },
    });
    fireEvent.click(screen.getByText(t('web.admin_telegram_remove')));

    await waitFor(() => {
      const call = api.calls.find((one) => one.url.includes(`/admins/${OWNER_ID}/telegram`));
      expect(call?.body).toEqual({ telegramUserId: null, reason: 'left' });
    });
    expect(await screen.findByText(t('web.admin_telegram_not_connected'))).toBeInTheDocument();
    expect(screen.getByText(t('web.admin_telegram_removed_done'))).toBeInTheDocument();
  });
});
