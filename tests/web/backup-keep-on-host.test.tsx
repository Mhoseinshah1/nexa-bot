import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY,
  BACKUP_ARCHIVE_RETENTION_SETTING_KEYS,
  BACKUP_ROUTES,
  BACKUP_SCHEDULE_SETTING_KEYS,
  CONTROL_ROUTES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_ROUTES,
  settingDefinition,
  type BackupStatusResponse,
  type PermissionKey,
  type SettingKey,
} from '@nexa/contracts';
import { BackupScheduleCard } from '../../apps/web/src/pages/backup-schedule';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { SETTINGS_MANAGED_ELSEWHERE } from '../../apps/web/src/settings-presentation';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Owner decision 2026-11-11 — «نگه داشتن نسخه روی سرور» (`backup.archive_keep_on_host`).
 *
 * On «زمان‌بندی بکاپ خودکار»: a switch; turning it OFF asks first, in the owner's own words,
 * and only a confirmation writes; turning it on asks nothing. While off, the archive-retention
 * numbers are greyed with one line saying why. On the Recovery page, a host with no archive
 * leads with «بارگذاری فایل بکاپ».
 */

const EDIT: readonly PermissionKey[] = ['backup.view', 'settings.view', 'settings.edit'];
const OWNER_CONFIRMATION =
  'بعد از رسیدن بکاپ به گروه تلگرام، فایل از روی سرور پاک می‌شود. برای بازیابی باید فایل را از گروه تلگرام دانلود و در صفحهٔ بازیابی بارگذاری کنید.';

function settingRow(key: string, value: unknown, version: number | null) {
  const definition = settingDefinition(key as SettingKey);
  return {
    key,
    value,
    source: version === null ? 'DEFAULT' : 'TENANT',
    version,
    updatedAt: version === null ? null : '2026-11-11T02:00:00.000Z',
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

const STATUS: Pick<
  BackupStatusResponse,
  'scheduleEnabled' | 'intervalMs' | 'dailyTime' | 'scheduleSource' | 'deliveryDestination'
> = {
  scheduleEnabled: true,
  intervalMs: 24 * 3_600_000,
  dailyTime: null,
  scheduleSource: { enabled: 'SETTING', interval: 'SETTING', dailyTime: 'ENVIRONMENT' },
  deliveryDestination: 'OPS_GROUP_TOPIC',
};

function routes(keepOnHost: { value: boolean; version: number | null }) {
  return [
    {
      url: `${API_PREFIX}${CONTROL_ROUTES.settings}`,
      body: {
        settings: [
          settingRow(BACKUP_SCHEDULE_SETTING_KEYS.enabled, true, 1),
          settingRow(BACKUP_SCHEDULE_SETTING_KEYS.intervalMinutes, 1440, 1),
          settingRow(BACKUP_SCHEDULE_SETTING_KEYS.dailyTime, null, null),
          settingRow(BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY, keepOnHost.value, keepOnHost.version),
          settingRow(BACKUP_ARCHIVE_RETENTION_SETTING_KEYS.keepCount, 3, null),
          settingRow(BACKUP_ARCHIVE_RETENTION_SETTING_KEYS.keepDays, 7, 2),
        ],
      },
    },
    {
      url: `${API_PREFIX}${CONTROL_ROUTES.setting(BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY)}`,
      body: {
        setting: settingRow(BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY, !keepOnHost.value, 9),
        changed: true,
      },
    },
  ];
}

const posts = (api: ReturnType<typeof stubApi>) =>
  api.calls.filter((call) => call.method === 'POST');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('«نگه داشتن نسخه روی سرور» on the schedule card', () => {
  it('is on by default, and the retention numbers are drawn as usual', async () => {
    stubApi(routes({ value: true, version: null }));
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    const toggle = await screen.findByRole('switch', { name: 'نگه داشتن نسخه روی سرور' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    const retention = screen.getByTestId('backup-retention');
    expect(retention).not.toHaveClass('is-off');
    expect(retention).not.toHaveAttribute('aria-disabled');
    expect(retention.textContent).toContain('3');
    expect(retention.textContent).toContain('7');
    expect(screen.queryByText(t('web.backup_keep_on_host_off_retention'))).toBeNull();
  });

  it('asks in the owner’s words before turning it off, and a cancel writes nothing', async () => {
    const api = stubApi(routes({ value: true, version: 5 }));
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    const toggle = await screen.findByRole('switch', { name: 'نگه داشتن نسخه روی سرور' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain(OWNER_CONFIRMATION);
    fireEvent.click(within(dialog).getByRole('button', { name: 'انصراف' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts(api)).toHaveLength(0);
  });

  it('writes false through the ordinary settings write only once confirmed', async () => {
    const api = stubApi(routes({ value: true, version: 5 }));
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    const toggle = await screen.findByRole('switch', { name: 'نگه داشتن نسخه روی سرور' });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('alertdialog');
    expect(posts(api)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'بله، خاموش شود' }));
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    const write = posts(api)[0];
    expect(write?.url).toContain(encodeURIComponent(BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY));
    expect(write?.body).toMatchObject({ value: false, expectedVersion: 5 });
    expect(
      String((write?.body as { idempotencyKey: string }).idempotencyKey).length,
    ).toBeGreaterThan(7);
  });

  it('while off: the retention numbers are greyed with the one line that says why, and on asks nothing', async () => {
    const api = stubApi(routes({ value: false, version: 6 }));
    renderPage(<BackupScheduleCard status={STATUS} permissions={EDIT} />);
    const toggle = await screen.findByRole('switch', { name: 'نگه داشتن نسخه روی سرور' });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    const retention = screen.getByTestId('backup-retention');
    expect(retention).toHaveClass('is-off');
    expect(retention).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(t('web.backup_keep_on_host_off_retention'))).toBeInTheDocument();

    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    await waitFor(() => expect(posts(api)).toHaveLength(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(posts(api)[0]?.body).toMatchObject({ value: true, expectedVersion: 6 });
  });

  it('offers nothing to change to an actor without settings.edit', async () => {
    stubApi(routes({ value: true, version: null }));
    renderPage(
      <BackupScheduleCard status={STATUS} permissions={['backup.view', 'settings.view']} />,
    );
    const toggle = await screen.findByRole('switch', { name: 'نگه داشتن نسخه روی سرور' });
    expect(toggle).toBeDisabled();
  });

  it('is drawn on the backup page only, where the confirmation is', () => {
    expect(SETTINGS_MANAGED_ELSEWHERE).toContain(BACKUP_ARCHIVE_KEEP_ON_HOST_SETTING_KEY);
  });
});

describe('the Recovery page when the host holds no archive', () => {
  const BACKUP_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
  const run = (archiveAvailable: boolean) => ({
    id: BACKUP_ID,
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: '2026-11-11T02:00:00.000Z',
    finishedAt: '2026-11-11T02:03:00.000Z',
    dumpBytes: '106875',
    archiveBytes: '107647',
    checksum: 'a'.repeat(64),
    verifiedAt: '2026-11-11T02:02:00.000Z',
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: '2026-11-11T02:03:00.000Z',
    deliveryDetailPresent: false,
    deliveryReason: null,
    redeliverable: false,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable,
    archiveFormat: 'NXB',
    partCount: 1,
    partsDelivered: 1,
    parts: [],
    summaryDeliveryState: null,
    phaseDurationsMs: null,
  });
  const pageRoutes = (runs: unknown[]) => [
    {
      url: `${API_PREFIX}${BACKUP_ROUTES.status}`,
      body: {
        scheduleEnabled: true,
        intervalMs: 86_400_000,
        dailyTime: null,
        scheduleSource: { enabled: 'SETTING', interval: 'SETTING', dailyTime: 'ENVIRONMENT' },
        deliveryDestination: 'OPS_GROUP_TOPIC',
        lastSucceededAt: '2026-11-11T02:00:00.000Z',
        running: null,
        unknownDeliveries: 0,
        quiesced: false,
        archivePassword: { configured: false, setAt: null },
      },
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
      body: {
        uploadEnabled: true,
        maxUploadBytes: 1_048_576,
        foreignInstallationSupported: true,
        confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
        confirmationTtlMs: 600_000,
      },
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.list}`,
      body: { recoveries: [], nextCursor: null },
    },
    { url: `${API_PREFIX}${BACKUP_ROUTES.history}`, body: { runs, nextCursor: null } },
  ];
  const ALL: PermissionKey[] = ['backup.view', 'backup.run', 'backup.download', 'recovery.restore'];
  const render = () =>
    renderPage(
      <RecoveryPage
        route={{ path: '/recovery', query: new URLSearchParams() }}
        permissions={ALL}
      />,
    );
  /** Whether the restore card comes before the schedule card in the document. */
  const restoreLeads = (): boolean => {
    const restore = document.querySelector('.recovery-operations');
    const schedule = screen.getAllByText(t('web.backup_schedule_title'))[0];
    if (restore === null || schedule === undefined) throw new Error('both cards are drawn');
    return Boolean(restore.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  it('leads with «بارگذاری فایل بکاپ» and says where the file is', async () => {
    stubApi(pageRoutes([run(false)]));
    render();
    expect(await screen.findByText('بارگذاری فایل بکاپ')).toBeInTheDocument();
    expect(screen.getByText(t('web.recovery_upload_default_hint'))).toBeInTheDocument();
    expect(restoreLeads()).toBe(true);
  });

  it('keeps today’s page while an archive is on the host', async () => {
    stubApi(pageRoutes([run(true)]));
    render();
    await screen.findByLabelText(t('web.recovery_upload_choose'));
    await screen.findAllByRole('link', { name: new RegExp(t('web.recovery_download')) });
    expect(screen.queryByText('بارگذاری فایل بکاپ')).toBeNull();
    expect(restoreLeads()).toBe(false);
  });
});
