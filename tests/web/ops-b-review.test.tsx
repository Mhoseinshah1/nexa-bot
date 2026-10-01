import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { API_PREFIX, BACKUP_ROUTES, RECOVERY_ROUTES } from '@nexa/contracts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { SupportPage } from '../../apps/web/src/pages/support';
import { RemindersPage } from '../../apps/web/src/pages/reminders';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { OpsGroupPage } from '../../apps/web/src/pages/ops-group';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { renderPage, setting, stubApi } from './harness';

/**
 * The Codex review of PR #128 (WEB-OPS-B), one regression per finding. Each test here
 * fails when the rule it names is reverted; none restates behaviour another suite pins.
 */

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

afterEach(() => {
  go('/');
  vi.unstubAllGlobals();
});

const unsavedCount = (count: number) => `${formatNumber(count)} ${t('web.ob_unsaved_count')}`;

/** Replaces `fetch` so every POST waits for `release()`; everything else answers at once. */
function holdWrites(): { release: () => void } {
  const answer = globalThis.fetch;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
    init?.method === 'POST'
      ? held.then(() => answer(input as RequestInfo, init))
      : answer(input as RequestInfo, init),
  );
  return { release: () => release() };
}

// ---------------------------------------------------------------------------
// 1. The overall readiness badge is the server's verdict
// ---------------------------------------------------------------------------

describe('the system status card', () => {
  const statusRoute = { path: '/system', query: new URLSearchParams() };
  const overall = async () =>
    (await screen.findByText(t('web.system_overall'))).closest('.stat') as HTMLElement;

  it('stays ready when only a dependency that does not block readiness is down', async () => {
    stubApi([
      {
        url: '/system/readiness',
        body: {
          status: 'ok',
          dependencies: [
            { name: 'postgres', status: 'up', latencyMs: 2, required: true },
            { name: 'redis', status: 'down', detail: 'ECONNREFUSED', required: false },
          ],
        },
      },
    ]);
    renderPage(<SystemPage route={statusRoute} permissions={[]} />);
    const card = await overall();
    expect(within(card).getByText(t('web.system_overall_ok'))).toBeInTheDocument();
    expect(within(card).queryByText(t('web.system_overall_down'))).toBeNull();
    // Said, as a warning, rather than hidden: the row count still names it.
    expect(card).not.toHaveClass('alert');
    expect(card).toHaveClass('warnish');
  });

  it('says down when the server says the process is degraded', async () => {
    stubApi([
      {
        url: '/system/readiness',
        body: {
          status: 'degraded',
          dependencies: [{ name: 'postgres', status: 'down', required: true }],
        },
      },
    ]);
    renderPage(<SystemPage route={statusRoute} permissions={[]} />);
    const card = await overall();
    expect(within(card).getByText(t('web.system_overall_down'))).toBeInTheDocument();
    expect(card).toHaveClass('alert');
  });
});

// ---------------------------------------------------------------------------
// 6. A revoked panels.view hides the cached monitor profile everywhere
// ---------------------------------------------------------------------------

describe('the monitor tab', () => {
  it('draws nothing from a cached profile once panels.view is revoked', async () => {
    stubApi([
      {
        url: '/system/monitor',
        body: {
          monitor: {
            enabled: true,
            tickMs: 30000,
            healthyIntervalMs: 180000,
            retryableIntervalMs: 120000,
            nonRetryableIntervalMs: 3600000,
            batchSize: 150,
            concurrency: 4,
            tenantsPerTick: 10,
            probeTenantLimit: 100,
            probeTenantWindowMs: 300000,
            probeCooldownMs: 10000,
            budgetReservePercent: 40,
            freshForMs: 900000,
            tenantFreshPanelCeiling: 60,
            installationFreshPanelCeiling: 900,
            tenantTurnCeiling: 60,
            schedulerCapacityExceeded: true,
          },
        },
      },
    ]);
    const monitorRoute = { path: '/system', query: new URLSearchParams('section=monitor') };
    const view = renderPage(<SystemPage route={monitorRoute} permissions={['panels.view']} />);
    expect(await screen.findByText(t('web.monitor_over_capacity_title'))).toBeInTheDocument();
    expect(screen.getByText(t('web.monitor_enabled'))).toBeInTheDocument();

    view.rerender(<SystemPage route={monitorRoute} permissions={[]} />);
    expect(screen.queryByText(t('web.monitor_over_capacity_title'))).toBeNull();
    expect(screen.queryByText(t('web.monitor_enabled'))).toBeNull();
    expect(screen.queryByText(t('web.monitor_tick'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. A close that would discard a draft asks first
// ---------------------------------------------------------------------------

describe('closing a drawer that holds a draft', () => {
  const faq = {
    id: '019250ab-cdef-7012-8345-6789abcdef01',
    question: 'آیا آی‌پی ثابت است؟',
    answer: 'بله.',
    status: 'ACTIVE',
    sortOrder: 10,
    version: 3,
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };
  const discardQuestion = () => screen.queryByRole('alertdialog', { name: t('web.unsaved_title') });
  const escape = () => fireEvent.keyDown(document, { key: 'Escape' });

  it('asks before Escape, the backdrop, ✕ or Cancel throw an FAQ edit away', async () => {
    stubApi([{ url: '/support/faqs', body: { items: [faq] } }]);
    renderPage(<SupportPage denied={false} mayEdit />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_edit') }));
    const drawer = () => screen.queryByRole('dialog', { name: t('web.support_faq_editing') });
    const answer = () =>
      within(drawer() as HTMLElement).getByLabelText(
        t('web.support_faq_answer'),
      ) as HTMLTextAreaElement;

    // Untouched: nothing to lose, so Escape closes at once.
    escape();
    expect(drawer()).toBeNull();
    expect(discardQuestion()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('web.support_faq_edit') }));
    fireEvent.change(answer(), { target: { value: 'بله، ثابت است.' } });

    // Each way out asks, and «stay» keeps the drawer and the draft.
    const closers: (() => void)[] = [
      escape,
      () => fireEvent.mouseDown(document.querySelector('.drawer-layer') as Element),
      () =>
        fireEvent.click(
          within(drawer() as HTMLElement).getByRole('button', { name: t('web.close') }),
        ),
      () =>
        fireEvent.click(
          within(drawer() as HTMLElement).getByRole('button', {
            name: t('web.support_faq_cancel'),
          }),
        ),
    ];
    for (const closeBy of closers) {
      closeBy();
      const question = discardQuestion() as HTMLElement;
      expect(question).not.toBeNull();
      fireEvent.click(within(question).getByRole('button', { name: t('web.unsaved_stay') }));
      expect(discardQuestion()).toBeNull();
      expect(drawer()).not.toBeNull();
      expect(answer().value).toBe('بله، ثابت است.');
    }

    // Only the explicit discard closes it.
    escape();
    fireEvent.click(
      within(discardQuestion() as HTMLElement).getByRole('button', { name: t('web.discard') }),
    );
    expect(drawer()).toBeNull();
  });

  it('keeps the leave guard and the discard question about the same draft', async () => {
    go('/support');
    stubApi([{ url: '/support/faqs', body: { items: [faq] } }]);
    renderPage(
      <>
        <SupportPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_edit') }));
    const drawer = screen.getByRole('dialog', { name: t('web.support_faq_editing') });
    fireEvent.change(within(drawer).getByLabelText(t('web.support_faq_question')), {
      target: { value: 'سؤال تازه' },
    });
    escape();
    // An Escape inside the question is the question's: it cancels it, and the drawer stays.
    escape();
    expect(discardQuestion()).toBeNull();
    expect(screen.getByRole('dialog', { name: t('web.support_faq_editing') })).toBeInTheDocument();
  });

  it('asks before closing the new-administrator drawer throws a typed password away', async () => {
    stubApi([
      { url: '/admins', body: { admins: [] } },
      { url: '/roles', body: { roles: [] } },
    ]);
    const adminsRoute = { path: '/system', query: new URLSearchParams('section=admins') };
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.admin_add') }));
    const drawer = () => screen.queryByRole('dialog', { name: t('web.admin_add_title') });
    fireEvent.change(
      within(drawer() as HTMLElement).getByLabelText(t('web.admin_password_label')),
      { target: { value: 'correct horse battery' } },
    );
    escape();
    const question = discardQuestion() as HTMLElement;
    expect(question).not.toBeNull();
    fireEvent.click(within(question).getByRole('button', { name: t('web.unsaved_stay') }));
    expect(
      (
        within(drawer() as HTMLElement).getByLabelText(
          t('web.admin_password_label'),
        ) as HTMLInputElement
      ).value,
    ).toBe('correct horse battery');

    escape();
    fireEvent.click(
      within(discardQuestion() as HTMLElement).getByRole('button', { name: t('web.discard') }),
    );
    expect(drawer()).toBeNull();
  });

  it('asks before closing an administrator drawer throws a typed new password away', async () => {
    const id = '019a0000-0000-7000-8000-000000000002';
    stubApi([
      {
        url: '/admins',
        body: {
          admins: [
            {
              id,
              username: 'reviewer',
              displayName: 'Reviewer',
              status: 'ACTIVE',
              telegramUserId: null,
              roleKeys: [],
              createdAt: '2026-09-01T00:00:00.000Z',
              lastLoginAt: null,
            },
          ],
        },
      },
      { url: `/admins/${id}/sessions`, body: { sessions: [] } },
      { url: '/roles', body: { roles: [] } },
    ]);
    const adminsRoute = { path: '/system', query: new URLSearchParams('section=admins') };
    renderPage(<SystemPage route={adminsRoute} permissions={['admins.view', 'admins.edit']} />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.admin_manage') }));
    const password = () =>
      screen.queryByLabelText(t('web.admin_new_password_label')) as HTMLInputElement | null;

    // Nothing typed: closes at once.
    escape();
    expect(password()).toBeNull();
    expect(discardQuestion()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t('web.admin_manage') }));
    fireEvent.change(password() as HTMLInputElement, { target: { value: 'a-new-long-secret' } });
    escape();
    fireEvent.click(
      within(discardQuestion() as HTMLElement).getByRole('button', { name: t('web.unsaved_stay') }),
    );
    expect(password()?.value).toBe('a-new-long-secret');
    // The drawer's own close button, not its ✕ (which carries the same name as a label).
    const closeButton = screen
      .getAllByRole('button', { name: t('web.admin_manage_close') })
      .find((button) => !button.hasAttribute('aria-label'));
    fireEvent.click(closeButton as HTMLElement);
    fireEvent.click(
      within(discardQuestion() as HTMLElement).getByRole('button', { name: t('web.discard') }),
    );
    expect(password()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. A reminder row's dirty state is measured against its saved basis
// ---------------------------------------------------------------------------

describe('a reminder row after the shared settings query refetches', () => {
  const firstDays = (value: number, version: number) =>
    setting({
      key: 'reminders.expiry_first_days',
      value,
      version,
      source: 'TENANT',
      configures: 'service_expiry_reminders',
    });
  const secondDays = (value: number, version: number) =>
    setting({
      key: 'reminders.expiry_second_days',
      value,
      version,
      source: 'TENANT',
      configures: 'service_expiry_reminders',
    });
  const threshold = (amountMinor: string, version: number) =>
    setting({
      key: 'wallet.low_balance.threshold',
      value: { amountMinor, currency: 'IRT' },
      version,
      source: 'TENANT',
      configures: 'wallet_low_balance_reminders',
    });
  const page = () =>
    renderPage(
      <RemindersPage mayEdit denied={false} mayViewTemplates={false} mayEditTemplates={false} />,
    );
  const saveIn = (field: HTMLElement) =>
    fireEvent.click(
      within(field.closest('form') as HTMLElement).getByRole('button', { name: t('web.save') }),
    );

  it('follows a newer live value on an untouched row instead of calling it unsaved', async () => {
    stubApi([
      { url: '/settings', body: { settings: [firstDays(3, 1), secondDays(1, 1)] } },
      { url: '/features', body: { flags: [] } },
    ]);
    page();
    const first = (await screen.findByLabelText(t('web.reminders_first_days'))) as HTMLInputElement;
    const second = screen.getByLabelText(t('web.reminders_second_days')) as HTMLInputElement;
    fireEvent.change(second, { target: { value: '2' } });
    expect(screen.getByText(unsavedCount(1))).toBeInTheDocument();

    // A colleague moved the FIRST row meanwhile; the refetch after our save brings it.
    stubApi([
      { url: '/settings/', body: { setting: secondDays(2, 2), changed: true } },
      { url: '/settings', body: { settings: [firstDays(5, 2), secondDays(2, 2)] } },
      { url: '/features', body: { flags: [] } },
    ]);
    saveIn(second);

    await waitFor(() => expect(first.value).toBe('5'));
    expect(screen.queryByText(unsavedCount(1))).toBeNull();
    expect(
      within(first.closest('form') as HTMLElement).queryByText(t('web.ob_unsaved_row')),
    ).toBeNull();
  });

  it('keeps a touched row as typed, and states the version its draft was based on', async () => {
    stubApi([
      { url: '/settings', body: { settings: [firstDays(3, 1), secondDays(1, 1)] } },
      { url: '/features', body: { flags: [] } },
    ]);
    page();
    const first = (await screen.findByLabelText(t('web.reminders_first_days'))) as HTMLInputElement;
    const second = screen.getByLabelText(t('web.reminders_second_days')) as HTMLInputElement;
    fireEvent.change(first, { target: { value: '4' } });
    fireEvent.change(second, { target: { value: '2' } });

    const api = stubApi([
      { url: '/settings/', body: { setting: secondDays(2, 2), changed: true } },
      { url: '/settings', body: { settings: [firstDays(5, 2), secondDays(2, 2)] } },
      { url: '/features', body: { flags: [] } },
    ]);
    saveIn(second);
    await waitFor(() => expect(screen.getByText(unsavedCount(1))).toBeInTheDocument());
    await waitFor(() => expect(api.calls.some((call) => call.method === 'GET')).toBe(true));
    expect(first.value).toBe('4');

    saveIn(first);
    await waitFor(() => {
      const write = api.calls.find((call) => call.url.includes('reminders.expiry_first_days'));
      // The basis it was typed over, so the colleague's change comes back as a conflict.
      expect(write?.body).toMatchObject({ value: 4, expectedVersion: 1 });
    });
  });

  it('is not left unsaved by a value the server stored in its own spelling', async () => {
    stubApi([
      {
        url: '/settings',
        body: { settings: [firstDays(3, 1), threshold('0', 1)] },
      },
      { url: '/features', body: { flags: [] } },
      {
        url: '/settings/reminders.expiry_first_days',
        body: { setting: firstDays(5, 2), changed: true },
      },
      {
        url: '/settings/wallet.low_balance.threshold',
        body: { setting: threshold('5000', 2), changed: true },
      },
    ]);
    page();
    const first = (await screen.findByLabelText(t('web.reminders_first_days'))) as HTMLInputElement;
    const money = screen.getByLabelText(t('web.reminders_wallet_threshold')) as HTMLInputElement;

    fireEvent.change(first, { target: { value: '05' } });
    fireEvent.change(money, { target: { value: '005000' } });
    expect(screen.getByText(unsavedCount(2))).toBeInTheDocument();

    saveIn(first);
    saveIn(money);
    await waitFor(() => expect(first.value).toBe('5'));
    await waitFor(() => expect(money.value).toBe('5000'));
    expect(screen.queryByText(unsavedCount(1))).toBeNull();
    expect(screen.queryByText(unsavedCount(2))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. A failed verification stays the active step
// ---------------------------------------------------------------------------

describe('the recovery step strip after a verification fails', () => {
  const RECOVERY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';
  const uploaded = {
    id: RECOVERY_ID,
    source: 'UPLOAD',
    state: 'UPLOADED',
    stage: 'PARSE_CONTAINER',
    createdAt: '2026-09-09T03:00:00.000Z',
    updatedAt: '2026-09-09T03:00:00.000Z',
    requestedBy: 'owner',
    backupId: null,
    artifactChecksum: null,
    failureCode: null,
    correlationId: 'c1',
    upload: { sizeBytes: 3, archiveSha256: 'b'.repeat(64), clientFilename: 'mine.nxb' },
    verification: null,
    restoreTest: null,
    confirmedAt: null,
    confirmationExpiresAt: null,
    preRestoreBackupId: null,
    cutoverAt: null,
    displacedDatabase: null,
    finishedAt: null,
  };

  it('marks verification as the step that failed, with the upload done', async () => {
    stubApi([
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.status}`,
        body: {
          scheduleEnabled: true,
          intervalMs: 21_600_000,
          lastSucceededAt: null,
          running: null,
          unknownDeliveries: 0,
          quiesced: false,
        },
      },
      {
        url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
        body: {
          uploadEnabled: true,
          maxUploadBytes: 1024,
          foreignInstallationSupported: false,
          confirmationPhrase: 'RESTORE NEXA',
          confirmationTtlMs: 900_000,
        },
      },
      {
        url: `${API_PREFIX}${RECOVERY_ROUTES.list}`,
        body: { recoveries: [], nextCursor: null },
      },
      { url: `${API_PREFIX}${BACKUP_ROUTES.history}`, body: { runs: [], nextCursor: null } },
      { url: `${API_PREFIX}${RECOVERY_ROUTES.upload}`, body: { recovery: uploaded } },
      {
        // Verify answers 200 with the FAILED row for an archive that does not verify.
        url: `${API_PREFIX}${RECOVERY_ROUTES.detail(RECOVERY_ID)}/verify`,
        body: {
          recovery: {
            ...uploaded,
            state: 'FAILED',
            stage: 'CLEANUP',
            failureCode: 'recovery.checksum_mismatch',
            finishedAt: '2026-09-09T03:01:00.000Z',
          },
        },
      },
    ]);
    renderPage(
      <RecoveryPage
        route={{ path: '/recovery', query: new URLSearchParams() }}
        permissions={['backup.view']}
      />,
    );
    fireEvent.change(await screen.findByLabelText(t('web.recovery_upload_choose')), {
      target: {
        files: [
          new File([new Uint8Array([1, 2, 3])], 'mine.nxb', { type: 'application/octet-stream' }),
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'بارگذاری' }));
    fireEvent.click(await screen.findByRole('button', { name: t('web.recovery_verify') }));
    await screen.findByText('FAILED');

    const steps = Array.from(document.querySelectorAll('.recovery-steps li'));
    const [upload, verify, restore] = steps as [HTMLElement, HTMLElement, HTMLElement];
    expect(upload).toHaveClass('done');
    expect(verify).toHaveClass('failed');
    expect(verify).toHaveAttribute('aria-current', 'step');
    expect(verify.textContent).toContain(t('web.status_failed'));
    expect(restore).toHaveClass('todo');
    expect(restore).not.toHaveAttribute('aria-current');
  });
});

// ---------------------------------------------------------------------------
// 5. Focus comes back after a confirmed write settles
// ---------------------------------------------------------------------------

describe('focus after a confirmed write', () => {
  it('returns focus to Save once a confirmed currency change has settled', async () => {
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({ key: 'sales.currency', value: 'IRT', version: 1, configures: null }),
          ],
        },
      },
      {
        url: '/settings/sales.currency',
        body: {
          setting: setting({ key: 'sales.currency', value: 'IRR', version: 2, configures: null }),
          changed: true,
        },
      },
    ]);
    const writes = holdWrites();
    renderPage(<SettingsPage mayEdit denied={false} />);
    const select = await screen.findByLabelText(
      `${t('web.currency')} — ${t('web.setting_sales_currency')}`,
    );
    fireEvent.change(select, { target: { value: 'IRR' } });
    const row = select.closest('article') as HTMLElement;
    const save = within(row).getByRole('button', { name: t('web.save') });
    fireEvent.click(save);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('web.settings_currency_confirm_yes'),
      }),
    );
    await waitFor(() => expect(save).toBeDisabled());
    expect(save).not.toHaveFocus();

    writes.release();
    await waitFor(() => expect(save).toBeEnabled());
    await waitFor(() => expect(save).toHaveFocus());
  });

  const opsGroup = (connection: 'CONNECTED' | 'DISCONNECTED') => ({
    opsGroup: {
      connection,
      group: {
        title: 'Nexa Ops',
        bot: { id: '01900000-0000-7000-8000-00000000a001', username: 'acme_store_bot' },
        connectedAt: '2026-09-01T10:00:00.000Z',
        disconnectedAt: connection === 'CONNECTED' ? null : '2026-09-20T10:00:00.000Z',
      },
      health: 'HEALTHY',
      problems: [],
      checkedAt: null,
      lastDeliveredAt: null,
      topics: [],
      queue: { pending: 0, preserved: 0 },
      laneEnabled: true,
      pendingCodeExpiresAt: null,
      bots: [],
      manual: { configured: false, inUse: false },
    },
  });

  it('hands focus back to the disconnect trigger when the question is cancelled', async () => {
    stubApi([{ url: '/ops-group', body: opsGroup('CONNECTED') }]);
    renderPage(<OpsGroupPage denied={false} mayManage />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.opsgroup_disconnect') }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('web.bot_cancel'),
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t('web.opsgroup_disconnect') })).toHaveFocus(),
    );
  });

  it('puts focus on Reconnect once a confirmed disconnect has settled', async () => {
    stubApi([
      { url: '/ops-group', body: opsGroup('CONNECTED') },
      { url: '/ops-group/disconnect', body: opsGroup('DISCONNECTED') },
    ]);
    const writes = holdWrites();
    renderPage(<OpsGroupPage denied={false} mayManage />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.opsgroup_disconnect') }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('web.opsgroup_disconnect'),
      }),
    );
    const reconnect = screen.getByRole('button', { name: t('web.opsgroup_reconnect') });
    await waitFor(() => expect(reconnect).toBeDisabled());
    expect(document.activeElement).toBe(document.body);

    // The refetch after the write sees the group disconnected.
    stubApi([
      { url: '/ops-group', body: opsGroup('DISCONNECTED') },
      { url: '/ops-group/disconnect', body: opsGroup('DISCONNECTED') },
    ]);
    writes.release();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('web.opsgroup_disconnect') })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t('web.opsgroup_reconnect') })).toHaveFocus(),
    );
  });
});
