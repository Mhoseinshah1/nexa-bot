import type { ReactElement } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  API_PREFIX,
  BACKUP_SCHEDULE_SETTING_KEYS,
  CONTROL_ROUTES,
  RECOVERY_KIT_ROUTES,
  featureFlagSchema,
  settingDefinition,
  templateDefinition,
  templateViewSchema,
  type BackupStatusResponse,
  type SettingKey,
  type TemplateKey,
} from '@nexa/contracts';
import { ProductCategoriesPage } from '../../apps/web/src/pages/product-categories';
import { SystemPage } from '../../apps/web/src/pages/system';
import { BackupScheduleCard } from '../../apps/web/src/pages/backup-schedule';
import { ContentPage } from '../../apps/web/src/pages/content';
import { RecoveryKitSection } from '../../apps/web/src/pages/recovery-kit';
import { AuditLogPage } from '../../apps/web/src/pages/audit-log';
import { NotificationsPage } from '../../apps/web/src/pages/alerts';
import { FeaturesPage } from '../../apps/web/src/pages/features';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import { BulkOperationDetailPage } from '../../apps/web/src/pages/bulk-operations';
import { PaymentsPage } from '../../apps/web/src/pages/payments';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { navigate } from '../../apps/web/src/router';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * C4 (W6), table-driven: at every rewired error site — a refused write and a refused load —
 * a `request.invalid`, an unmapped 4xx and a 5xx each render a Persian sentence, and no
 * English sentence the server wrote reaches what the operator reads. Where the site draws
 * the reference (C3), the correlation id is there, left-to-right.
 */

const SERVER = 'The server wrote this sentence for its own log.';
const ISSUE = 'Expected string, received number at this path.';
const ENGLISH = /[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}[\s,.:;]+[A-Za-z]{2,}/u;
const PERSIAN = /[؀-ۿ]/u;
const CORRELATION = 'corr-c4-site';

const VARIANTS = [
  {
    name: 'request.invalid',
    status: 400,
    error: {
      kind: 'VALIDATION',
      code: 'request.invalid',
      message: SERVER,
      details: { issues: [{ path: 'zzz', message: ISSUE }] },
    },
  },
  {
    name: 'an unmapped 4xx',
    status: 422,
    error: { kind: 'VALIDATION', code: 'site.something_new', message: SERVER },
  },
  {
    name: 'a 5xx',
    status: 500,
    error: { kind: 'INTERNAL', code: 'internal.unhandled', message: SERVER },
  },
] as const;

type Variant = (typeof VARIANTS)[number];
type Route = { url: string; method?: string; status?: number; body: unknown };

interface Site {
  readonly name: string;
  /** The request that is refused. */
  readonly refused: { readonly url: string; readonly method: string };
  /** Everything else the page reads. */
  readonly routes: () => Route[];
  readonly render: () => ReactElement;
  /** What the operator does to reach the refusal (nothing, for a refused load). */
  readonly act: () => Promise<void>;
  /** Whether the site draws the code and correlation id (a write's banner, C3). */
  readonly reference: boolean;
}

const go = (url: string) => act(() => navigate(url, { replace: true, force: true }));
afterEach(() => go('/'));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATEGORY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292ca';
const category = {
  id: CATEGORY_ID,
  name: 'عمومی',
  description: null,
  emoji: null,
  status: 'ACTIVE',
  visibility: 'VISIBLE',
  sortOrder: 0,
  productCount: 0,
  createdAt: '2026-02-01T08:00:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
};

const SUPPORT_ROLE = {
  key: 'support',
  name: 'Support',
  isSystem: true,
  immutable: false,
  version: 3,
  permissions: ['tickets.reply', 'tickets.view', 'users.view'],
  assignedAdmins: [],
};

const OWNER_ID = '019a0000-0000-7000-8000-000000000001';
const admin = {
  id: OWNER_ID,
  username: 'mamad',
  displayName: 'Mamad Owner',
  status: 'ACTIVE',
  telegramUserId: null,
  roleKeys: ['owner'],
  createdAt: '2026-09-01T00:00:00.000Z',
  lastLoginAt: null,
};

function settingRow(key: string, value: unknown) {
  const definition = settingDefinition(key as SettingKey);
  return {
    key,
    value,
    source: 'DEFAULT',
    version: null,
    updatedAt: null,
    updatedByAdminId: null,
    description: definition.description,
    zeroMeaning: definition.zeroMeaning,
    mutability: definition.mutability,
    classification: definition.classification,
    configures: definition.configures,
    consumer: definition.consumer,
    storedValueInvalid: false,
  };
}

const BACKUP_STATUS: Pick<
  BackupStatusResponse,
  'scheduleEnabled' | 'intervalMs' | 'dailyTime' | 'scheduleSource' | 'deliveryDestination'
> = {
  scheduleEnabled: false,
  intervalMs: 24 * 3_600_000,
  dailyTime: null,
  scheduleSource: { enabled: 'ENVIRONMENT', interval: 'ENVIRONMENT', dailyTime: 'ENVIRONMENT' },
  deliveryDestination: 'OPS_GROUP_TOPIC',
};

const BALANCE = 'bot.wallet.balance' as TemplateKey;
const balanceTemplate = () => {
  const definition = templateDefinition(BALANCE);
  return templateViewSchema.parse({
    key: BALANCE,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body: 'موجودی کیف پول شما: {balance}',
    defaultBody: 'موجودی کیف پول شما: {balance}',
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

const flag = featureFlagSchema.parse({
  key: 'ops_notifications',
  description: 'Project operational events to the operations destination.',
  enabled: false,
  source: 'TENANT',
  blastRadius: 'LOCAL',
  version: 2,
  reason: null,
  updatedAt: '2026-09-01T00:00:00.000Z',
  updatedByAdminId: 'a1',
  configuration: [],
});

const BULK_ID = '019290ab-cdef-7012-8345-6789abcdef01';
const systemRoute = (query: string) =>
  ({ path: '/system', query: new URLSearchParams(query) }) as unknown as Parameters<
    typeof SystemPage
  >[0]['route'];

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const confirmIfAsked = () => {
  const dialog = screen.queryByRole('alertdialog');
  if (dialog === null) return;
  const buttons = within(dialog).getAllByRole('button');
  fireEvent.click(buttons[buttons.length - 1] as HTMLElement);
};

const nothing = () => Promise.resolve();

// ---------------------------------------------------------------------------
// The sites
// ---------------------------------------------------------------------------

const SITES: readonly Site[] = [
  {
    name: 'product categories: delete',
    refused: { url: `/product-categories/${CATEGORY_ID}`, method: 'DELETE' },
    routes: () => [{ url: '/product-categories', method: 'GET', body: { categories: [category] } }],
    render: () => <ProductCategoriesPage denied={false} mayEdit />,
    act: async () => {
      const cell = await screen.findByText('عمومی');
      fireEvent.click(
        within(cell.closest('tr') as HTMLElement).getByRole('button', { name: t('web.remove') }),
      );
      fireEvent.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'بله، حذف شود' }),
      );
    },
    reference: true,
  },
  {
    name: 'roles: save a role',
    refused: { url: '/rbac/roles/support', method: 'POST' },
    routes: () => [
      { url: '/rbac/roles', method: 'GET', body: { roles: [SUPPORT_ROLE] } },
      { url: '/admins', method: 'GET', body: { admins: [] } },
    ],
    render: () => (
      <SystemPage
        route={systemRoute('section=roles')}
        permissions={['admins.view', 'admins.permissions.edit']}
      />
    ),
    act: async () => {
      const names = await screen.findAllByText(t('web.role_key_support'));
      const row = names.map((node) => node.closest('li.rbac-role')).find((one) => one !== null);
      fireEvent.click(
        within(row as HTMLElement).getByRole('button', { name: new RegExp(t('web.rbac_edit')) }),
      );
      fill(t('web.rbac_name'), 'Support desk');
      fill(t('web.admin_reason_label'), 'rename');
      fireEvent.click(screen.getByRole('button', { name: t('web.rbac_save') }));
    },
    reference: true,
  },
  {
    name: 'backup schedule: save the interval',
    refused: {
      url: `${API_PREFIX}${CONTROL_ROUTES.setting(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes)}`,
      method: 'POST',
    },
    routes: () => [
      {
        url: `${API_PREFIX}${CONTROL_ROUTES.settings}`,
        method: 'GET',
        body: {
          settings: [
            settingRow(BACKUP_SCHEDULE_SETTING_KEYS.enabled, null),
            settingRow(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes, null),
          ],
        },
      },
    ],
    render: () => (
      <BackupScheduleCard
        status={BACKUP_STATUS}
        permissions={['backup.view', 'settings.view', 'settings.edit']}
      />
    ),
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'هر 3 ساعت' }));
      fireEvent.click(screen.getByRole('button', { name: 'ذخیره‌ی فاصله' }));
    },
    reference: true,
  },
  {
    name: 'system: add an administrator',
    refused: { url: '/admins', method: 'POST' },
    routes: () => [
      {
        url: '/roles',
        method: 'GET',
        body: {
          roles: [{ key: 'support', name: 'Support', isSystem: true, permissions: ['users.view'] }],
        },
      },
      { url: '/admins', method: 'GET', body: { admins: [admin] } },
    ],
    render: () => (
      <SystemPage
        route={systemRoute('section=admins')}
        permissions={['admins.view', 'admins.edit']}
      />
    ),
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('web.admin_add') }));
      const form = (await screen.findByLabelText(t('web.admin_username_label'))).closest(
        'form',
      ) as HTMLFormElement;
      fill(t('web.admin_username_label'), 'second');
      fill(t('web.admin_display_name_label'), 'Second');
      fill(t('web.admin_password_label'), 'a-twelve-char-password');
      fireEvent.click(await screen.findByLabelText('Support'));
      fireEvent.click(within(form).getByRole('button', { name: t('web.admin_add') }));
    },
    reference: false,
  },
  {
    name: 'system: connect an administrator’s Telegram',
    refused: { url: `/admins/${OWNER_ID}/telegram`, method: 'POST' },
    routes: () => [{ url: '/admins', method: 'GET', body: { admins: [admin] } }],
    render: () => (
      <SystemPage
        route={systemRoute('section=admins')}
        permissions={['admins.view', 'admins.edit']}
      />
    ),
    act: async () => {
      fireEvent.click(await screen.findByText(t('web.admin_telegram_connect')));
      fill(t('web.admin_telegram_id_label'), '123456789');
      fill(t('web.admin_telegram_reason_label'), 'staging owner');
      const form = screen.getByLabelText(t('web.admin_telegram_id_label')).closest('form');
      fireEvent.click(within(form as HTMLElement).getByText(t('web.admin_telegram_connect')));
    },
    reference: false,
  },
  {
    name: 'content: save a template',
    refused: { url: `/templates/${BALANCE}`, method: 'POST' },
    routes: () => [{ url: '/templates', method: 'GET', body: { templates: [balanceTemplate()] } }],
    render: () => <ContentPage mayEdit denied={false} />,
    act: async () => {
      await screen.findAllByText(/موجودی کیف پول/u);
      const editor = document.getElementById(`body-${BALANCE}`) as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: 'موجودی شما {balance}' } });
      fireEvent.click(screen.getByRole('button', { name: t('web.save') }));
    },
    reference: true,
  },
  {
    name: 'recovery kit: export',
    refused: { url: `${API_PREFIX}${RECOVERY_KIT_ROUTES.export}`, method: 'POST' },
    routes: () => [],
    render: () => <RecoveryKitSection permissions={['recovery.kit.export']} />,
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('web.kit_export_button') }));
      const dialog = await screen.findByRole('dialog');
      fill(t('web.kit_account_password'), 'account-password');
      fill(t('web.kit_passphrase'), 'a long recovery passphrase');
      fill(t('web.kit_passphrase_again'), 'a long recovery passphrase');
      fireEvent.click(within(dialog).getByRole('button', { name: t('web.kit_export_button') }));
    },
    reference: true,
  },
  {
    name: 'audit log: the list',
    refused: { url: '/audit-log', method: 'GET' },
    routes: () => [],
    render: () => (
      <AuditLogPage
        route={{ path: '/audit-log', query: new URLSearchParams() }}
        denied={false}
        mayExport={false}
      />
    ),
    act: nothing,
    reference: false,
  },
  {
    name: 'notifications: send a test',
    refused: { url: '/notifications/test', method: 'POST' },
    routes: () => [
      { url: '/notifications', method: 'GET', body: { notifications: [], nextCursor: null } },
    ],
    render: () => <NotificationsPage mayTest denied={false} />,
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: t('web.send_test') }));
      confirmIfAsked();
    },
    reference: true,
  },
  {
    name: 'features: switch a flag',
    refused: { url: '/features/ops_notifications', method: 'POST' },
    routes: () => [{ url: '/features', method: 'GET', body: { flags: [flag] } }],
    render: () => <FeaturesPage mayEdit denied={false} />,
    act: async () => {
      fireEvent.click(await screen.findByRole('switch'));
      confirmIfAsked();
    },
    reference: true,
  },
  {
    name: 'system: readiness',
    refused: { url: '/system/readiness', method: 'GET' },
    routes: () => [],
    render: () => <SystemPage route={systemRoute('')} permissions={[]} />,
    act: nothing,
    reference: false,
  },
  {
    name: 'dashboard: readiness',
    refused: { url: '/system/readiness', method: 'GET' },
    routes: () => [],
    render: () => <DashboardPage permissions={[]} />,
    act: nothing,
    reference: false,
  },
  {
    name: 'bulk operations: an operation',
    refused: { url: `/bulk-operations/${BULK_ID}`, method: 'GET' },
    routes: () => [],
    render: () => (
      <BulkOperationDetailPage id={BULK_ID} denied={false} mayWallet={false} mayGrant />
    ),
    act: nothing,
    reference: false,
  },
  {
    name: 'payments: the list',
    refused: { url: '/payments', method: 'GET' },
    routes: () => [],
    render: () => (
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />
    ),
    act: nothing,
    reference: false,
  },
  {
    name: 'recovery: the page',
    refused: { url: '/recovery', method: 'GET' },
    routes: () => [],
    render: () => (
      <RecoveryPage
        route={{ path: '/recovery', query: new URLSearchParams() }}
        permissions={['backup.view']}
      />
    ),
    act: nothing,
    reference: false,
  },
];

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** What an element says to a reader: technical details and left-to-right values removed. */
function readable(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('details, .ltr, .mono, [dir="ltr"]')) {
    hidden.remove();
  }
  return copy.textContent ?? '';
}

const errorElements = (container: HTMLElement) =>
  [...container.querySelectorAll('[role="alert"], .empty.error')].filter(
    (element) => readable(element).trim() !== '',
  );

describe.each(SITES)('$name', (site) => {
  it.each(VARIANTS)('says $name in Persian, with no English sentence', async (variant: Variant) => {
    const api = stubApi([
      ...site.routes(),
      {
        url: site.refused.url,
        method: site.refused.method,
        status: variant.status,
        body: { error: { ...variant.error, correlationId: CORRELATION } },
      },
    ]);
    // Drawers and dialogs render in a portal: the whole document is what the operator reads.
    renderPage(site.render());
    const container = document.body;
    await site.act();
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) => call.url.includes(site.refused.url) && call.method === site.refused.method,
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(errorElements(container).length).toBeGreaterThan(0));

    for (const element of errorElements(container)) {
      const text = readable(element);
      expect(text, site.name).toMatch(PERSIAN);
      expect(text, site.name).not.toMatch(ENGLISH);
    }
    // Neither the server's sentence nor the validator's reaches what the operator reads.
    const page = readable(container);
    expect(page).not.toContain(SERVER);
    expect(page).not.toContain(ISSUE);
    if (site.reference) {
      const reference = await screen.findAllByText(CORRELATION);
      expect(reference[0]).toHaveAttribute('dir', 'ltr');
    }
  });
});
