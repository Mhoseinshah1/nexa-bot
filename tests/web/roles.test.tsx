import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { fetchSession } from '../../apps/web/src/api/client';
import { SystemPage } from '../../apps/web/src/pages/system';
import { t } from '../../apps/web/src/i18n/web.fa';
import { PERMISSION_LABELS } from '../../apps/web/src/rbac-labels';
import { renderPage, stubApi } from './harness';

/**
 * System → Roles (Phase D3), through the real client and schemas against a stubbed
 * `fetch`: the owner role offers no edit, the matrix pulls in prerequisites and removes
 * dependents with a warning, a CRITICAL change needs the typed key before it can be
 * saved, and an edit carries the version it was made from.
 */

const route = {
  path: '/system',
  query: new URLSearchParams('section=roles'),
} as unknown as Parameters<typeof SystemPage>[0]['route'];

const OWNER = {
  key: 'owner',
  name: 'Owner',
  isSystem: true,
  immutable: true,
  version: 1,
  permissions: ['admins.edit', 'users.view'],
  assignedAdmins: [{ id: 'a1', username: 'owner', displayName: 'Owner One', status: 'ACTIVE' }],
};
const SUPPORT = {
  key: 'support',
  name: 'Support',
  isSystem: true,
  immutable: false,
  version: 3,
  permissions: ['tickets.reply', 'tickets.view', 'users.view'],
  assignedAdmins: [],
};
const CUSTOM = {
  key: 'night_shift',
  name: 'Night shift',
  isSystem: false,
  immutable: false,
  version: 1,
  permissions: ['users.view'],
  assignedAdmins: [],
};

function routes(extra: { url: string; body: unknown; status?: number }[] = []) {
  return [
    { url: '/rbac/roles', body: { roles: [OWNER, SUPPORT, CUSTOM] } },
    { url: '/admins', body: { admins: [] } },
    ...extra,
  ];
}

const label = (key: keyof typeof PERMISSION_LABELS) => t(PERMISSION_LABELS[key]!);

describe('the roles section', () => {
  it('lists roles with holders, and offers no edit or delete for the owner role', async () => {
    stubApi(routes());
    renderPage(
      <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />,
    );
    const ownerRow = (await screen.findByText('Owner')).closest('li')!;
    expect(within(ownerRow).getByText(t('web.rbac_immutable'))).toBeInTheDocument();
    expect(within(ownerRow).getByText(/Owner One/)).toBeInTheDocument();
    expect(
      within(ownerRow).queryByRole('button', { name: new RegExp(t('web.rbac_edit')) }),
    ).toBeNull();
    expect(
      within(ownerRow).queryByRole('button', { name: new RegExp(t('web.rbac_delete')) }),
    ).toBeNull();
    // A system role: editable, never deletable.
    const supportRow = screen.getByText('Support').closest('li')!;
    expect(
      within(supportRow).getByRole('button', { name: new RegExp(t('web.rbac_edit')) }),
    ).toBeInTheDocument();
    expect(
      within(supportRow).queryByRole('button', { name: new RegExp(t('web.rbac_delete')) }),
    ).toBeNull();
  });

  it('draws no write controls for a viewer', async () => {
    stubApi(routes());
    renderPage(<SystemPage route={route} permissions={['admins.view']} />);
    await screen.findByText('Support');
    expect(screen.queryByRole('button', { name: new RegExp(t('web.rbac_new_role')) })).toBeNull();
    expect(screen.queryByRole('button', { name: new RegExp(t('web.rbac_edit')) })).toBeNull();
  });

  it('pulls in a prerequisite, and removes dependents with a warning', async () => {
    stubApi(routes());
    renderPage(
      <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(t('web.rbac_new_role')) }),
    );
    const box = (key: string) =>
      document.getElementById(`rbac-perm-${key.replace(/\./g, '-')}`) as HTMLInputElement;
    fireEvent.click(box('receipts.review'));
    // `receipts.review` needs `payments.view`: selecting it pulls the read in, and says so.
    expect(box('payments.view').checked).toBe(true);
    expect(
      screen.getByText(
        t('web.rbac_pulled_prerequisite')
          .replace('{permission}', label('receipts.review'))
          .replace('{requires}', label('payments.view')),
      ),
    ).toBeInTheDocument();
    // Removing the read removes the action that needs it, and says so.
    fireEvent.click(box('payments.view'));
    expect(box('receipts.review').checked).toBe(false);
    expect(
      screen.getByText(
        t('web.rbac_removed_dependents')
          .replace('{permission}', label('payments.view'))
          .replace('{dependents}', label('receipts.review')),
      ),
    ).toBeInTheDocument();
  });

  it('will not save a CRITICAL change until the role key is typed, and sends the version it was edited from', async () => {
    const api = stubApi(
      routes([{ url: '/rbac/roles/support', body: { role: { ...SUPPORT, version: 4 } } }]),
    );
    renderPage(
      <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />,
    );
    const supportRow = (await screen.findByText('Support')).closest('li')!;
    fireEvent.click(
      within(supportRow).getByRole('button', { name: new RegExp(t('web.rbac_edit')) }),
    );

    fireEvent.click(document.getElementById('rbac-perm-refunds-issue')!);
    fireEvent.change(screen.getByLabelText(t('web.admin_reason_label')), {
      target: { value: 'refunds desk' },
    });
    const save = screen.getByRole('button', { name: t('web.rbac_save') });
    expect(save).toBeDisabled();
    fireEvent.change(
      screen.getByLabelText(t('web.rbac_confirm_label').replace('{key}', 'support')),
      {
        target: { value: 'support' },
      },
    );
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => {
      const call = api.calls.find((one) => one.url.endsWith('/rbac/roles/support'));
      expect(call?.body).toMatchObject({
        expectedVersion: 3,
        confirmation: 'support',
        permissions: expect.arrayContaining(['refunds.issue', 'tickets.view']),
      });
      expect(typeof (call?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
    });
  });

  it('searches the matrix', async () => {
    stubApi(routes());
    renderPage(
      <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: new RegExp(t('web.rbac_new_role')) }),
    );
    fireEvent.change(screen.getByLabelText(t('web.rbac_search')), {
      target: { value: 'refunds.issue' },
    });
    expect(screen.getByLabelText(new RegExp(label('refunds.issue')))).toBeInTheDocument();
    expect(screen.queryByLabelText(new RegExp(label('users.view')))).toBeNull();
  });

  it('explains a missing permission in the effective preview', async () => {
    const ADMIN = {
      id: '019a0000-0000-7000-8000-000000000009',
      username: 'helper',
      displayName: 'Helper',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['support'],
      createdAt: '2026-09-01T00:00:00.000Z',
      lastLoginAt: null,
    };
    stubApi([
      { url: '/rbac/roles', body: { roles: [SUPPORT] } },
      { url: '/admins', body: { admins: [ADMIN] } },
      {
        url: `/admins/${ADMIN.id}/effective-permissions`,
        body: {
          adminId: ADMIN.id,
          active: true,
          roles: [{ key: 'support', name: 'Support' }],
          rolePermissions: ['tickets.reply', 'tickets.view', 'users.view'],
          overrides: [
            {
              permissionKey: 'tickets.view',
              effect: 'DENY',
              reason: 'x',
              expiresAt: null,
              active: true,
            },
          ],
          effective: ['users.view'],
        },
      },
    ]);
    renderPage(<SystemPage route={route} permissions={['admins.view']} />);
    await screen.findByRole('option', { name: /Helper/ });
    fireEvent.change(screen.getByLabelText(t('web.rbac_preview_admin')), {
      target: { value: ADMIN.id },
    });
    expect(await screen.findByText(t('web.rbac_preview_missing'))).toBeInTheDocument();
    expect(screen.getByText(t('web.rbac_why_denied'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.rbac_why_requires').replace('{requires}', label('tickets.view'))),
    ).toBeInTheDocument();
  });
});

describe('the label table', () => {
  it('names every permission in the catalogue', async () => {
    const { PERMISSIONS } = await import('@nexa/contracts');
    for (const permission of PERMISSIONS) {
      expect(
        PERMISSION_LABELS[permission.key as keyof typeof PERMISSION_LABELS],
        permission.key,
      ).toBeDefined();
    }
  });
});

describe('Codex review of #161 (web)', () => {
  const ADMIN = {
    id: '019a0000-0000-7000-8000-000000000009',
    username: 'helper',
    displayName: 'Helper',
    status: 'ACTIVE',
    telegramUserId: null,
    roleKeys: ['support'],
    createdAt: '2026-09-01T00:00:00.000Z',
    lastLoginAt: null,
  };
  const PREVIEW = {
    adminId: ADMIN.id,
    active: true,
    roles: [{ key: 'support', name: 'Support' }],
    rolePermissions: ['tickets.reply', 'tickets.view', 'users.view'],
    overrides: [
      {
        permissionKey: 'refunds.issue',
        effect: 'DENY',
        reason: 'never refunds',
        expiresAt: null,
        active: true,
      },
      {
        permissionKey: 'users.block',
        effect: 'GRANT',
        reason: 'temporary cover',
        expiresAt: '2026-09-01T00:00:00.000Z',
        active: false,
      },
    ],
    effective: ['tickets.reply', 'tickets.view', 'users.view'],
  };
  const SESSION = {
    admin: { ...ADMIN, username: 'owner', roleKeys: ['owner'] },
    permissions: ['admins.view', 'admins.permissions.edit'],
    expiresAt: '2026-10-08T00:00:00.000Z',
  };

  /** Mounts the shell's own session query beside the page, as the app does. */
  function SessionProbe() {
    useQuery({ queryKey: ['session'], queryFn: fetchSession });
    return null;
  }

  const count = (api: { calls: { url: string }[] }, fragment: string) =>
    api.calls.filter((call) => call.url.includes(fragment)).length;

  async function openSupportEditor() {
    const supportRow = (await screen.findByText('Support')).closest('li')!;
    fireEvent.click(
      within(supportRow).getByRole('button', { name: new RegExp(t('web.rbac_edit')) }),
    );
    fireEvent.change(screen.getByLabelText(t('web.rbac_name')), {
      target: { value: 'Support desk' },
    });
    fireEvent.change(screen.getByLabelText(t('web.admin_reason_label')), {
      target: { value: 'rename' },
    });
  }

  it('4173474771: a role update re-reads the effective preview and the session', async () => {
    const api = stubApi([
      { url: '/rbac/roles', body: { roles: [SUPPORT] } },
      {
        url: '/rbac/roles/support',
        body: { role: { ...SUPPORT, version: 4, name: 'Support desk' } },
      },
      { url: '/admins', body: { admins: [ADMIN] } },
      { url: `/admins/${ADMIN.id}/effective-permissions`, body: PREVIEW },
      { url: '/auth/session', body: SESSION },
    ]);
    renderPage(
      <>
        <SessionProbe />
        <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />
      </>,
    );
    await screen.findByRole('option', { name: /Helper/ });
    fireEvent.change(screen.getByLabelText(t('web.rbac_preview_admin')), {
      target: { value: ADMIN.id },
    });
    await screen.findByText(t('web.rbac_overrides_title'));
    const previewsBefore = count(api, '/effective-permissions');
    const sessionsBefore = count(api, '/auth/session');

    await openSupportEditor();
    fireEvent.click(screen.getByRole('button', { name: t('web.rbac_save') }));
    await waitFor(() => {
      expect(count(api, '/effective-permissions')).toBeGreaterThan(previewsBefore);
      expect(count(api, '/auth/session')).toBeGreaterThan(sessionsBefore);
    });
  });

  it('4173474772: a version conflict re-reads the role list', async () => {
    const api = stubApi([
      { url: '/rbac/roles', body: { roles: [SUPPORT] } },
      {
        url: '/rbac/roles/support',
        status: 409,
        body: {
          error: {
            kind: 'CONFLICT',
            code: 'role.version_conflict',
            message: 'stale',
            details: { currentVersion: 4 },
            correlationId: 'c',
          },
        },
      },
      { url: '/admins', body: { admins: [] } },
    ]);
    renderPage(
      <SystemPage route={route} permissions={['admins.view', 'admins.permissions.edit']} />,
    );
    await openSupportEditor();
    const listsBefore = api.calls.filter((call) => call.url.endsWith('/rbac/roles')).length;
    fireEvent.click(screen.getByRole('button', { name: t('web.rbac_save') }));
    expect(await screen.findByText(t('web.rbac_error_version'))).toBeInTheDocument();
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url.endsWith('/rbac/roles')).length).toBeGreaterThan(
        listsBefore,
      ),
    );
  });

  it('4173474768: every override is shown — expired ones and DENYs outside the roles, with reason and expiry', async () => {
    stubApi([
      { url: '/rbac/roles', body: { roles: [SUPPORT] } },
      { url: '/admins', body: { admins: [ADMIN] } },
      { url: `/admins/${ADMIN.id}/effective-permissions`, body: PREVIEW },
    ]);
    renderPage(<SystemPage route={route} permissions={['admins.view']} />);
    await screen.findByRole('option', { name: /Helper/ });
    fireEvent.change(screen.getByLabelText(t('web.rbac_preview_admin')), {
      target: { value: ADMIN.id },
    });
    const list = (await screen.findByText(t('web.rbac_overrides_title'))).parentElement!;
    // The DENY on a permission no role grants.
    expect(within(list).getByText('refunds.issue')).toBeInTheDocument();
    expect(within(list).getByText(/never refunds/)).toBeInTheDocument();
    // The EXPIRED grant, marked as such, with its expiry.
    expect(within(list).getByText('users.block')).toBeInTheDocument();
    expect(within(list).getByText(/temporary cover/)).toBeInTheDocument();
    expect(within(list).getByText(t('web.rbac_override_expired'))).toBeInTheDocument();
    expect(
      within(list).getByText(new RegExp(`${t('web.rbac_override_expires')}:`)),
    ).toBeInTheDocument();
    expect(
      within(list).getByText(new RegExp(t('web.rbac_override_no_expiry'))),
    ).toBeInTheDocument();
  });
});
