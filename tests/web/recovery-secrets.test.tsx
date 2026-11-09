import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  BACKUP_ROUTES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_ROUTES,
  type PermissionKey,
} from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { RecoveryPage } from '../../apps/web/src/pages/recovery';
import { SecretReentryStrip } from '../../apps/web/src/pages/recovery-secrets';
import { NEXA_ARCHIVE_BYTES, renderPage, stubApi } from './harness';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.3: the refusal panel, its two choices, and the re-entry strip.
 */

const route = { path: '/recovery', query: new URLSearchParams() };
const ALL: PermissionKey[] = ['backup.view', 'backup.run', 'recovery.restore'];
const RECOVERY_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292d9';
const BACKUP_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BACKUP_ID,
    trigger: 'SCHEDULED',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: '2026-09-09T02:00:00.000Z',
    finishedAt: '2026-09-09T02:03:00.000Z',
    dumpBytes: '106875',
    archiveBytes: '107647',
    checksum: 'a'.repeat(64),
    verifiedAt: '2026-09-09T02:02:00.000Z',
    deliveryState: 'SUCCEEDED',
    deliveryAttemptedAt: '2026-09-09T02:03:00.000Z',
    deliveryDetailPresent: false,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable: true,
    archiveFormat: 'NXB',
    partCount: 1,
    partsDelivered: 0,
    parts: [],
    summaryDeliveryState: null,
    phaseDurationsMs: null,
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    upload: { sizeBytes: 107647, archiveSha256: 'b'.repeat(64), clientFilename: 'mine.nxb' },
    verification: null,
    restoreTest: null,
    confirmedAt: null,
    settledAt: null,
    confirmationExpiresAt: null,
    preRestoreBackupId: null,
    cutoverAt: null,
    displacedDatabase: null,
    finishedAt: null,
    ...overrides,
  };
}

const status = (overrides: Record<string, unknown> = {}) => ({
  scheduleEnabled: true,
  intervalMs: 86_400_000,
  dailyTime: null,
  scheduleSource: { enabled: 'SETTING', interval: 'SETTING', dailyTime: 'ENVIRONMENT' },
  deliveryDestination: 'OPS_GROUP_TOPIC',
  lastSucceededAt: '2026-09-09T02:00:00.000Z',
  running: null,
  unknownDeliveries: 0,
  quiesced: false,
  archivePassword: { configured: false, setAt: null },
  ...overrides,
});

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  uploadEnabled: true,
  maxUploadBytes: 1_048_576,
  foreignInstallationSupported: true,
  confirmationPhrase: RECOVERY_CONFIRMATION_PHRASE,
  confirmationTtlMs: 600_000,
  ...overrides,
});

function routes(
  over: {
    status?: Record<string, unknown>;
    runs?: Record<string, unknown>[];
    caps?: Record<string, unknown>;
    recoveries?: Record<string, unknown>[];
  } = {},
) {
  return [
    { url: `${API_PREFIX}${BACKUP_ROUTES.status}`, body: over.status ?? status() },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.capabilities}`,
      body: over.caps ?? capabilities(),
    },
    {
      url: `${API_PREFIX}${RECOVERY_ROUTES.list}`,
      body: { recoveries: over.recoveries ?? [], nextCursor: null },
    },
    {
      url: `${API_PREFIX}${BACKUP_ROUTES.history}`,
      body: { runs: over.runs ?? [run()], nextCursor: null },
    },
  ];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const REFUSED_TEST = {
  restored: true,
  tableCount: 31,
  migrationVerdict: 'CURRENT',
  appliedMigrations: 30,
  expectedMigrations: 30,
  cutoverPermitted: false,
  unreadableSecrets: [
    { purpose: 'bot_instance.token', count: 2 },
    { purpose: 'panel.password', count: 1 },
  ],
};

const refused = (test: Record<string, unknown> = {}) =>
  recovery({
    state: 'FAILED',
    stage: 'CLEANUP',
    failureCode: 'recovery.candidate_secrets_unreadable',
    artifactChecksum: 'c'.repeat(64),
    restoreTest: { ...REFUSED_TEST, ...test },
  });

const VERIFY_URL = `${API_PREFIX}${RECOVERY_ROUTES.detail(RECOVERY_ID)}/verify`;
const ACK_URL = `${API_PREFIX}${RECOVERY_ROUTES.acknowledgeUnreadable(RECOVERY_ID)}`;

/** Uploads a file and verifies it; the verification answers `answer`. */
async function reachRefusal(
  extra: readonly { url: string; body: unknown; status?: number }[],
  answer: Record<string, unknown> = refused(),
  permissions: PermissionKey[] = ALL,
  file: File = new File([NEXA_ARCHIVE_BYTES], 'old.nxb'),
) {
  const api = stubApi([
    ...routes(),
    { url: `${API_PREFIX}${RECOVERY_ROUTES.upload}`, body: { recovery: recovery() } },
    { url: VERIFY_URL, body: { recovery: answer } },
    ...extra,
  ]);
  renderPage(<RecoveryPage route={route} permissions={permissions} />);
  fireEvent.change(await screen.findByLabelText('انتخاب فایل'), {
    target: { files: [file] },
  });
  const send = screen.getByRole('button', { name: 'بارگذاری' });
  await waitFor(() => expect(send).toBeEnabled());
  fireEvent.click(send);
  fireEvent.click(await screen.findByRole('button', { name: 'راستی‌آزمایی و آزمون بازگردانی' }));
  await screen.findByTestId('unreadable-secrets');
  return api;
}

describe('a restore refused for unreadable secrets', () => {
  it('lists each failed kind with its count', async () => {
    await reachRefusal([]);
    const panel = within(screen.getByTestId('unreadable-secrets'));
    expect(panel.getByText('توکن ربات')).toBeInTheDocument();
    expect(panel.getByText('رمز پنل')).toBeInTheDocument();
    expect(panel.getByText(/تعداد: ۲|تعداد: 2/)).toBeInTheDocument();
    expect(panel.getByText(/تعداد: ۱|تعداد: 1/)).toBeInTheDocument();
  });

  it('SFR A1: offers no Recovery Kit and no kit re-test — only re-entering, and says the kit is removed', async () => {
    // MUTATION: drawing the kit choice (its region, its import form or its re-test) again fails this.
    await reachRefusal([], refused(), [...ALL]);
    const panel = within(screen.getByTestId('unreadable-secrets'));
    expect(screen.queryByTestId('unreadable-kit-import')).toBeNull();
    expect(panel.queryByRole('region')).toBeNull();
    expect(panel.queryByText(/کیت بازیابی سرور قبلی/)).toBeNull();
    expect(panel.queryByRole('button', { name: /آزمون دوباره/ })).toBeNull();
    expect(panel.getByText(t('web.secret_unreadable_intro'))).toBeInTheDocument();
    expect(t('web.secret_unreadable_intro')).toContain('کیت بازیابی حذف شده است');
    expect(
      panel.getByRole('button', { name: 'ادامه؛ این‌ها را دوباره وارد می‌کنم' }),
    ).toBeEnabled();
  });

  it('sends the exact list when the operator continues, then asks for the typed phrase', async () => {
    const api = await reachRefusal([
      {
        url: ACK_URL,
        body: {
          recovery: recovery({
            state: 'RESTORE_TEST_PASSED',
            artifactChecksum: 'c'.repeat(64),
            restoreTest: { ...REFUSED_TEST, cutoverPermitted: true, clearUnreadable: true },
          }),
        },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'ادامه؛ این‌ها را دوباره وارد می‌کنم' }));
    const dialog = await screen.findByRole('alertdialog');
    // The dialog repeats the list and says what happens to bots.
    expect(within(dialog).getByText('توکن ربات')).toBeInTheDocument();
    expect(within(dialog).getByText(/متوقف می‌ماند/)).toBeInTheDocument();
    expect(api.calls.some((call) => call.url === ACK_URL)).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'می‌پذیرم، ادامه بده' }));
    await waitFor(() => expect(api.calls.some((call) => call.url === ACK_URL)).toBe(true));
    const body = api.calls.find((call) => call.url === ACK_URL)?.body as {
      unreadable: unknown;
    };
    expect(body.unreadable).toEqual([
      { purpose: 'bot_instance.token', count: 2 },
      { purpose: 'panel.password', count: 1 },
    ]);
    // The normal typed confirmation follows.
    expect(await screen.findByText(RECOVERY_CONFIRMATION_PHRASE)).toBeInTheDocument();
  });

  it('cannot continue past a refund card', async () => {
    await reachRefusal(
      [],
      refused({ unreadableSecrets: [{ purpose: 'payment_gateway.refund_card', count: 1 }] }),
    );
    expect(
      screen.getByRole('button', { name: 'ادامه؛ این‌ها را دوباره وارد می‌کنم' }),
    ).toBeDisabled();
    expect(screen.getByText(/کارت بازپرداخت درگاه با این بازیابی پاک نمی‌شود/)).toBeInTheDocument();
  });
});

describe('the re-entry strip', () => {
  const item = (over: Record<string, unknown>) => ({
    purpose: 'bot_instance.token',
    kind: 'BOT_TOKEN',
    entityId: 'b1',
    label: 'my_bot',
    provider: null,
    reenterAt: 'bots',
    clearedAt: '2026-09-09T03:00:00.000Z',
    recoveryId: RECOVERY_ID,
    ...over,
  });

  it('lists each item with the link to where it is entered again', async () => {
    stubApi([
      {
        url: `${API_PREFIX}${RECOVERY_ROUTES.secretReentry}`,
        body: {
          items: [
            item({}),
            item({
              purpose: 'panel.password',
              kind: 'PANEL_CREDENTIALS',
              entityId: 'p 1',
              label: 'panel-a',
              reenterAt: 'panels',
            }),
            item({
              purpose: 'payment_gateway.api_key',
              kind: 'GATEWAY_KEYS',
              entityId: 'g1',
              label: null,
              provider: 'TETRAPAY',
              reenterAt: 'payment-gateways',
            }),
            item({ purpose: 'backup.archive_password', reenterAt: 'recovery', label: null }),
            item({ purpose: 'support_ai_provider.api_key', reenterAt: 'support-ai' }),
            item({ purpose: 'admin.totp_secret', reenterAt: 'account' }),
            item({ purpose: 'hosting.totp_secret', reenterAt: 'hosting' }),
          ],
        },
      },
    ]);
    renderPage(<SecretReentryStrip mayView />);
    await screen.findByText('رمز پنل');
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs).toEqual([
      '/bots',
      '/panels/p%201',
      '/payment-gateways/tetrapay',
      '/recovery',
      '/support-ai',
      '/account',
      '/hosting',
    ]);
    expect(screen.getAllByText(/my_bot/).length).toBeGreaterThan(0);
  });

  it('draws nothing when the list is empty', async () => {
    const api = stubApi([
      { url: `${API_PREFIX}${RECOVERY_ROUTES.secretReentry}`, body: { items: [] } },
    ]);
    const { container } = renderPage(<SecretReentryStrip mayView />);
    await waitFor(() => expect(api.calls.length).toBe(1));
    expect(container.querySelector('.incident-banners')).toBeNull();
  });

  it('asks nothing and draws nothing without backup.view', async () => {
    const api = stubApi([
      { url: `${API_PREFIX}${RECOVERY_ROUTES.secretReentry}`, body: { items: [item({})] } },
    ]);
    const { container } = renderPage(<SecretReentryStrip mayView={false} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls).toHaveLength(0);
    expect(container.querySelector('.incident-banners')).toBeNull();
  });
});
