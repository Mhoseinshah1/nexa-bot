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

/**
 * The controls WP1 added, and the three Codex findings that had no coverage.
 *
 * `apps/web` had unit coverage for the shared kit and none for this page's new
 * controls, which is exactly where three defects lived: a save button that
 * refused the last role removal, a role picker that went stale under the
 * roster's own poll, and a revoke button disabled by a cached empty list. Each
 * case below fails if its fix is reverted.
 */
describe('the administrator controls', () => {
  const SECOND = '019a0000-0000-7000-8000-000000000002';

  const open = async (): Promise<HTMLElement> => {
    // `web.admin_manage` is also the column header, so this asks for the
    // BUTTON rather than the first element carrying the word.
    const manage = await screen.findByRole('button', { name: t('web.admin_manage') });
    fireEvent.click(manage);
    return manage;
  };

  it('lets an operator remove the LAST role, which the domain supports', async () => {
    const api = stubApi([
      {
        url: '/roles',
        body: {
          roles: [{ key: 'support', name: 'Support', isSystem: true, permissions: ['users.view'] }],
        },
      },
      { url: `/admins/${SECOND}/roles`, body: admin({ id: SECOND, roleKeys: [] }) },
      {
        url: '/admins',
        body: { admins: [admin({ id: SECOND, username: 'parked', roleKeys: ['support'] })] },
      },
      { url: `/admins/${SECOND}/sessions`, body: { sessions: [] } },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);
    await open();

    fireEvent.change(await screen.findByLabelText(t('web.admin_reason_label')), {
      target: { value: 'parking the account' },
    });
    // Uncheck the only role. `setAdminRolesRequestSchema` accepts an empty
    // array; requiring one here made the last role unremovable.
    fireEvent.click(await screen.findByLabelText('Support'));

    const save = screen.getByText(t('web.admin_roles_save'));
    expect(save, 'the last role could not be removed').not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes(`/admins/${SECOND}/roles`))).toBe(true);
    });
    expect(
      api.calls.find((call) => call.url.includes(`/admins/${SECOND}/roles`))?.body,
    ).toMatchObject({ roleKeys: [] });
  });

  it('follows the row when the picker is untouched, and keeps the edit when it is not', async () => {
    /*
     * The roster POLLS, so `row.roleKeys` changes underneath a mounted panel
     * when another operator or the Telegram surface edits the same
     * administrator. A `useState` initialiser runs once, so an untouched picker
     * went on showing the roles as they were when the panel opened — and
     * `setRoles` sends the FULL set, so saving from it silently reverted the
     * other change.
     *
     * Driven here by a status write, whose response replaces the cached row.
     * That is the same prop change the poll delivers, without a four-minute
     * wait: what is under test is that the picker DERIVES from the row rather
     * than snapshotting it.
     */
    const roles = {
      url: '/roles',
      body: {
        roles: [
          { key: 'support', name: 'Support', isSystem: true, permissions: ['users.view'] },
          { key: 'finance', name: 'Finance', isSystem: true, permissions: ['payments.view'] },
        ],
      },
    };
    stubApi([
      roles,
      { url: `/admins/${SECOND}/sessions`, body: { sessions: [] } },
      {
        url: `/admins/${SECOND}/status`,
        // The row comes back carrying a role change somebody else made.
        body: admin({ id: SECOND, username: 'moving', status: 'DISABLED', roleKeys: ['finance'] }),
      },
      {
        url: '/admins',
        body: { admins: [admin({ id: SECOND, username: 'moving', roleKeys: ['support'] })] },
      },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);
    await open();
    expect(await screen.findByLabelText('Support')).toBeChecked();

    fireEvent.change(await screen.findByLabelText(t('web.admin_reason_label')), {
      target: { value: 'stepping back' },
    });
    fireEvent.click(screen.getByText(t('web.admin_disable')));

    await waitFor(async () => {
      expect(await screen.findByLabelText('Finance')).toBeChecked();
    });
    expect(
      screen.getByLabelText('Support'),
      'an untouched picker kept the roles it opened with',
    ).not.toBeChecked();
  });

  it('offers revocation even when the cached session list is empty', async () => {
    /*
     * Gating the button on "we know there is nothing to revoke" sounds careful
     * and locks the operator out: a cached empty result keeps it disabled after
     * the target signs in. Revoking when there is nothing to revoke answers
     * zero, so the server is where that is found out.
     */
    stubApi([
      { url: '/roles', body: { roles: [] } },
      { url: `/admins/${SECOND}/sessions`, body: { sessions: [] } },
      { url: '/admins', body: { admins: [admin({ id: SECOND, username: 'quiet' })] } },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);
    await open();

    expect(await screen.findByText(t('web.admin_sessions_empty'))).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText(t('web.admin_reason_label')), {
      target: { value: 'lost laptop' },
    });
    expect(
      screen.getByText(t('web.admin_sessions_revoke')),
      'a cached empty list disabled the action',
    ).not.toBeDisabled();
  });

  it('sends an idempotency key with a creation, so a retry is not a second command', async () => {
    const api = stubApi([
      {
        url: '/roles',
        body: {
          roles: [{ key: 'support', name: 'Support', isSystem: true, permissions: ['users.view'] }],
        },
      },
      { url: '/admins', body: { admins: [admin()] } },
    ]);
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);

    fireEvent.click(await screen.findByRole('button', { name: t('web.admin_add') }));
    fireEvent.change(await screen.findByLabelText(t('web.admin_username_label')), {
      target: { value: 'newcomer' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_display_name_label')), {
      target: { value: 'New Comer' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_password_label')), {
      target: { value: 'a-twelve-char-password' },
    });
    fireEvent.click(await screen.findByLabelText('Support'));
    const form = screen.getByLabelText(t('web.admin_username_label')).closest('form');
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      expect(api.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const created = api.calls.find((call) => call.method === 'POST');
    // The key was minted and THROWN AWAY once, which made the mechanism present
    // in appearance only while `mutations.retry` re-sent the create.
    expect((created?.body as { idempotencyKey?: string })?.idempotencyKey).toMatch(/.{8,}/);
  });
});
