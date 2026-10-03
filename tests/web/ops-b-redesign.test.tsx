import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { templateDefinition, templateViewSchema, type TemplateKey } from '@nexa/contracts';
import { SettingsPage } from '../../apps/web/src/pages/settings';
import { RemindersPage } from '../../apps/web/src/pages/reminders';
import { ContentPage } from '../../apps/web/src/pages/content';
import { SupportPage } from '../../apps/web/src/pages/support';
import { TicketDetailPage } from '../../apps/web/src/pages/tickets';
import { OpsGroupPage } from '../../apps/web/src/pages/ops-group';
import { NotificationsPage } from '../../apps/web/src/pages/alerts';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { LeaveGuardHost } from '../../apps/web/src/ui/kit';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';
import { TEMPLATE_COPY_FA } from '../../apps/web/src/i18n/templates.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * What the OPS-B redesign ADDED to its pages, pinned so a later edit cannot quietly drop
 * it: the unsaved-edit count and the one leave guard over every independently saved row,
 * the per-row discard, the confirmation before the selling currency changes, the inline
 * range error, the template list that chooses which card is shown, the drawers, and the
 * step strip on the recovery page. Every behaviour these pages had before keeps its own
 * suite; nothing here restates one.
 */

/** Moves the router itself (not just the address bar), past any guard. */
const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));

afterEach(() => {
  go('/');
});

const unsavedCount = (count: number) => `${formatNumber(count)} ${t('web.ob_unsaved_count')}`;

describe('the settings page, as a product settings page', () => {
  const rows = [
    setting({ key: 'sales.payment_window_minutes', value: 60, version: 2, configures: null }),
    setting({ key: 'sales.currency', value: 'IRT', version: 1, configures: null }),
  ];

  it('counts an unsaved edit, marks its row and its section, and discards it', async () => {
    stubApi([{ url: '/settings', body: { settings: rows } }]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = (await screen.findByLabelText(
      t('web.setting_payment_window_minutes'),
    )) as HTMLInputElement;
    expect(screen.queryByText(unsavedCount(1))).toBeNull();

    fireEvent.change(field, { target: { value: '45' } });
    expect(screen.getByText(unsavedCount(1))).toBeInTheDocument();
    const row = field.closest('article') as HTMLElement;
    expect(within(row).getByText(t('web.ob_unsaved_row'))).toBeInTheDocument();
    // The section list marks the section that holds it.
    const nav = screen.getByRole('navigation', { name: t('web.ob_sections') });
    expect(within(nav).getByText(t('web.ob_unsaved_row'))).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: t('web.discard') }));
    expect(
      (screen.getByLabelText(t('web.setting_payment_window_minutes')) as HTMLInputElement).value,
    ).toBe('60');
    expect(screen.queryByText(unsavedCount(1))).toBeNull();
  });

  it('holds an in-app navigation while any row is unsaved, and lets it go once saved', async () => {
    go('/settings');
    stubApi([
      { url: '/settings', body: { settings: rows } },
      {
        url: '/settings/sales.payment_window_minutes',
        body: {
          setting: setting({
            key: 'sales.payment_window_minutes',
            value: 45,
            version: 3,
            configures: null,
          }),
          changed: true,
        },
      },
    ]);
    renderPage(
      <>
        <SettingsPage mayEdit denied={false} />
        <LeaveGuardHost />
      </>,
    );
    const field = await screen.findByLabelText(t('web.setting_payment_window_minutes'));
    fireEvent.change(field, { target: { value: '45' } });

    act(() => navigate('/panels'));
    expect(window.location.pathname).toBe('/settings');
    const dialog = screen.getByRole('alertdialog', { name: t('web.unsaved_title') });
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.unsaved_stay') }));

    const row = field.closest('article') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: t('web.save') }));
    // The toast names the setting it is about; the banner under the row stays the record.
    expect(
      await screen.findByText(
        `${t('web.ob_toast_saved')} — ${t('web.setting_payment_window_minutes')}`,
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(unsavedCount(1))).toBeNull());
    act(() => navigate('/panels'));
    expect(window.location.pathname).toBe('/panels');
  });

  it('asks before the selling currency changes, and sends nothing on cancel', async () => {
    const api = stubApi([
      { url: '/settings', body: { settings: rows } },
      {
        url: '/settings/sales.currency',
        body: {
          setting: setting({ key: 'sales.currency', value: 'IRR', version: 2, configures: null }),
          changed: true,
        },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const select = await screen.findByLabelText(
      `${t('web.currency')} — ${t('web.setting_sales_currency')}`,
    );
    fireEvent.change(select, { target: { value: 'IRR' } });
    const row = select.closest('article') as HTMLElement;

    fireEvent.click(within(row).getByRole('button', { name: t('web.save') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(t('web.settings_currency_confirm'))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.feature_confirm_cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    fireEvent.click(within(row).getByRole('button', { name: t('web.save') }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: t('web.settings_currency_confirm_yes'),
      }),
    );
    await waitFor(() => {
      const write = api.calls.find((call) => call.method === 'POST');
      expect(write?.body).toMatchObject({ value: 'IRR', expectedVersion: 1 });
    });
  });

  it('never asks about a setting that is not the selling currency', async () => {
    const api = stubApi([
      { url: '/settings', body: { settings: rows } },
      {
        url: '/settings/sales.payment_window_minutes',
        body: { setting: rows[0], changed: false },
      },
    ]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    const field = await screen.findByLabelText(t('web.setting_payment_window_minutes'));
    fireEvent.change(field, { target: { value: '30' } });
    fireEvent.click(
      within(field.closest('article') as HTMLElement).getByRole('button', { name: t('web.save') }),
    );
    await waitFor(() => expect(api.calls.some((call) => call.method === 'POST')).toBe(true));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('lists every group as a section and marks the one chosen', async () => {
    stubApi([{ url: '/settings', body: { settings: rows } }]);
    renderPage(<SettingsPage mayEdit denied={false} />);
    await screen.findByLabelText(t('web.setting_payment_window_minutes'));
    const nav = screen.getByRole('navigation', { name: t('web.ob_sections') });
    const button = within(nav).getByRole('button', { name: t('web.settings_group_sales') });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-current', 'true');
  });
});

describe('the reminders page', () => {
  it('says the range under a whole-number field the moment it is out of it', async () => {
    stubApi([
      {
        url: '/settings',
        body: {
          settings: [
            setting({
              key: 'reminders.expiry_first_days',
              value: 3,
              configures: 'service_expiry_reminders',
            }),
          ],
        },
      },
      { url: '/features', body: { flags: [] } },
    ]);
    renderPage(
      <RemindersPage mayEdit denied={false} mayViewTemplates={false} mayEditTemplates={false} />,
    );
    const field = await screen.findByLabelText(t('web.reminders_first_days'));
    const form = field.closest('form') as HTMLFormElement;
    const save = within(form).getByRole('button', { name: t('web.save') });
    expect(within(form).queryByRole('alert')).toBeNull();

    fireEvent.change(field, { target: { value: '45' } });
    expect(within(form).getByRole('alert').textContent).toContain(t('web.settings_range_from'));
    expect(save).toBeDisabled();
    expect(screen.getByText(unsavedCount(1))).toBeInTheDocument();

    fireEvent.click(within(form).getByRole('button', { name: t('web.discard') }));
    expect((field as HTMLInputElement).value).toBe('3');
    expect(within(form).queryByRole('alert')).toBeNull();
  });
});

describe('the texts page, as a list beside one editor', () => {
  const view = (key: TemplateKey, body: string) => {
    const definition = templateDefinition(key);
    return templateViewSchema.parse({
      key,
      locale: 'fa',
      description: definition.description,
      format: definition.format,
      maxLength: definition.maxLength ?? 4096,
      body,
      defaultBody: body,
      overrideBody: null,
      source: 'DEFAULT',
      overrideSuppressed: false,
      version: null,
      revision: null,
      updatedAt: null,
      updatedByAdminId: null,
      placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
    });
  };
  const BALANCE = 'bot.wallet.balance';
  const CANCELLED = 'bot.order.cancelled';
  const nameOf = (key: TemplateKey) => TEMPLATE_COPY_FA[key]?.[0] ?? '';
  const editor = (key: string) => document.getElementById(`body-${key}`) as HTMLTextAreaElement;
  const shown = (key: string) => editor(key).closest('[hidden]') === null;
  const item = (key: string) => document.getElementById(`template-item-${key}`) as HTMLElement;

  it('shows the chosen template, keeps the other mounted, and marks an unsaved one', async () => {
    stubApi([
      {
        url: '/templates',
        body: {
          templates: [view(BALANCE, 'موجودی: {balance}'), view(CANCELLED, 'سفارش لغو شد.')],
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('button', { name: new RegExp(nameOf(BALANCE)) });

    fireEvent.click(item(BALANCE));
    expect(shown(BALANCE)).toBe(true);
    expect(shown(CANCELLED)).toBe(false);
    expect(item(BALANCE)).toHaveAttribute('aria-current', 'true');

    fireEvent.change(editor(BALANCE), { target: { value: 'موجودی تازه: {balance}' } });
    expect(within(item(BALANCE)).getByText(t('web.ob_unsaved_row'))).toBeInTheDocument();
    expect(screen.getByText(unsavedCount(1))).toBeInTheDocument();

    fireEvent.click(item(CANCELLED));
    expect(shown(CANCELLED)).toBe(true);
    expect(shown(BALANCE)).toBe(false);
    // Hidden, not unmounted: the draft is still there to come back to.
    expect(editor(BALANCE).value).toBe('موجودی تازه: {balance}');
  });

  it('shows the first listed template when the chosen one is filtered out', async () => {
    stubApi([
      {
        url: '/templates',
        body: {
          templates: [view(BALANCE, 'موجودی: {balance}'), view(CANCELLED, 'سفارش لغو شد.')],
        },
      },
    ]);
    renderPage(<ContentPage mayEdit denied={false} />);
    await screen.findByRole('button', { name: new RegExp(nameOf(BALANCE)) });
    fireEvent.click(item(BALANCE));
    fireEvent.change(document.getElementById('templates-search') as HTMLInputElement, {
      target: { value: CANCELLED },
    });
    expect(shown(CANCELLED)).toBe(true);
    expect(shown(BALANCE)).toBe(false);
  });
});

describe('the support page', () => {
  it('edits in a drawer, and guards the page while the drawer holds an edit', async () => {
    go('/support');
    stubApi([
      {
        url: '/support/faqs',
        body: {
          items: [
            {
              id: '019250ab-cdef-7012-8345-6789abcdef01',
              question: 'آیا آی‌پی ثابت است؟',
              answer: 'بله.',
              status: 'ACTIVE',
              sortOrder: 10,
              version: 3,
              createdAt: '2026-09-01T08:00:00.000Z',
              updatedAt: '2026-09-10T12:30:00.000Z',
            },
          ],
        },
      },
    ]);
    renderPage(
      <>
        <SupportPage denied={false} mayEdit />
        <LeaveGuardHost />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.support_faq_edit') }));
    const drawer = screen.getByRole('dialog', { name: t('web.support_faq_editing') });
    // Opened and untouched: nothing to lose, nothing asked.
    act(() => navigate('/support?x=1', { replace: true }));
    fireEvent.change(within(drawer).getByLabelText(t('web.support_faq_answer')), {
      target: { value: 'بله، ثابت است.' },
    });
    act(() => navigate('/panels'));
    expect(window.location.pathname).toBe('/support');
    expect(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).toBeInTheDocument();
  });
});

describe('one ticket', () => {
  it('guards a typed reply against leaving the page', async () => {
    go('/tickets/019300ab-cdef-7012-8345-6789abcdef01');
    stubApi([
      {
        url: '/tickets/019300ab-cdef-7012-8345-6789abcdef01',
        body: {
          ticket: {
            id: '019300ab-cdef-7012-8345-6789abcdef01',
            number: 42,
            status: 'WAITING_FOR_SUPPORT',
            priority: 'HIGH',
            categoryId: '019310ab-cdef-7012-8345-6789abcdef01',
            categoryTitle: 'مشکل اتصال',
            subject: 'سرویس وصل نمی‌شود',
            customerId: '019320ab-cdef-7012-8345-6789abcdef01',
            customerTelegramUserId: '951001',
            customerUsername: 'mary',
            customerDisplayName: 'مریم',
            assignedAdminId: null,
            assignedAdminUsername: null,
            serviceId: null,
            orderId: null,
            paymentId: null,
            createdAt: '2026-09-20T10:00:00.000Z',
            updatedAt: '2026-09-20T11:00:00.000Z',
            lastMessageAt: '2026-09-20T11:00:00.000Z',
            closedAt: null,
          },
          messages: [],
          customer: {
            id: '019320ab-cdef-7012-8345-6789abcdef01',
            telegramUserId: '951001',
            username: 'mary',
            displayName: 'مریم',
            status: 'ACTIVE',
          },
        },
      },
    ]);
    renderPage(
      <>
        <TicketDetailPage
          id="019300ab-cdef-7012-8345-6789abcdef01"
          denied={false}
          mayReply
          mayAssign={false}
          mayClose={false}
        />
        <LeaveGuardHost />
      </>,
    );
    // The state and the priority stand beside the title.
    const state = await screen.findByText(t('web.ticket_status_waiting_for_support'));
    const title = state.closest('h1') as HTMLElement;
    expect(title).not.toBeNull();
    expect(within(title).getByText(t('web.ticket_priority_high'))).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText(t('web.ticket_reply_text')), {
      target: { value: 'در حال بررسی است.' },
    });
    act(() => navigate('/tickets'));
    expect(window.location.pathname).toBe('/tickets/019300ab-cdef-7012-8345-6789abcdef01');
    expect(screen.getByRole('alertdialog', { name: t('web.unsaved_title') })).toBeInTheDocument();
  });
});

describe('the ops group page', () => {
  it('sends nothing when the disconnect question is cancelled', async () => {
    const api = stubApi([
      {
        url: '/ops-group',
        body: {
          opsGroup: {
            connection: 'CONNECTED',
            group: {
              title: 'Nexa Ops',
              bot: { id: '01900000-0000-7000-8000-00000000a001', username: 'acme_store_bot' },
              connectedAt: '2026-09-01T10:00:00.000Z',
              disconnectedAt: null,
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
        },
      },
    ]);
    renderPage(<OpsGroupPage denied={false} mayManage />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.opsgroup_disconnect') }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: t('web.bot_cancel') }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    // The trigger is back, so the question can be asked again.
    expect(screen.getByRole('button', { name: t('web.opsgroup_disconnect') })).toBeEnabled();
  });
});

describe('the notifications page', () => {
  it('marks the delivery whose attempts are shown beside the list', async () => {
    const row = {
      id: 'n1',
      kind: 'OPERATIONAL_EVENT',
      status: 'SENT',
      templateKey: 'event.panel.unreachable',
      attemptCount: 1,
      maxAttempts: 5,
      createdAt: '2026-09-06T08:00:00.000Z',
      lastAttemptAt: '2026-09-06T08:00:01.000Z',
      completedAt: '2026-09-06T08:00:01.000Z',
      correlationId: 'c1',
    };
    stubApi([
      { url: '/notifications?', body: { notifications: [row], nextCursor: null } },
      { url: '/notifications/n1', body: { notification: row, attempts: [], releasedClaims: [] } },
    ]);
    renderPage(<NotificationsPage mayTest={false} denied={false} />);
    const key = await screen.findByRole('button', { name: 'event.panel.unreachable' });
    expect(screen.getByText(t('web.notifications_pick_hint'))).toBeInTheDocument();
    fireEvent.click(key);
    expect(key).toHaveAttribute('aria-pressed', 'true');
    expect(key.closest('tr')).toHaveClass('selected');
    await waitFor(() => expect(screen.queryByText(t('web.notifications_pick_hint'))).toBeNull());
  });
});

describe('the recovery page', () => {
  it('starts its step strip at the upload, and draws no step as a control', async () => {
    stubApi([
      {
        url: '/backups/status',
        body: {
          scheduleEnabled: true,
          intervalMs: 21_600_000,
          scheduleSource: { enabled: 'SETTING', interval: 'SETTING' },
          deliveryDestination: 'OPS_GROUP_TOPIC',
          lastSucceededAt: null,
          running: null,
          unknownDeliveries: 0,
          quiesced: false,
        },
      },
      { url: '/backups?', body: { runs: [], nextCursor: null } },
      {
        url: '/recoveries/capabilities',
        body: {
          uploadEnabled: true,
          maxUploadBytes: 1024,
          foreignInstallationSupported: false,
          confirmationPhrase: 'RESTORE NEXA',
          confirmationTtlMs: 900_000,
        },
      },
      { url: '/recoveries?', body: { recoveries: [], nextCursor: null } },
    ]);
    renderPage(
      <RecoveryPage
        route={{ path: '/recovery', query: new URLSearchParams() }}
        permissions={['backup.view']}
      />,
    );
    const upload = await screen.findByLabelText(t('web.recovery_upload_choose'));
    const strip = document.querySelector('.recovery-steps') as HTMLElement;
    const current = strip.querySelector('[aria-current="step"]') as HTMLElement;
    expect(current.textContent).toContain(t('web.recovery_upload_title'));
    expect(within(strip).queryAllByRole('button')).toHaveLength(0);
    expect(upload).toBeInTheDocument();
    // «Never» is still said, now on its figure card.
    expect(screen.getByText(t('web.recovery_never'))).toBeInTheDocument();
  });
});
