import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_PREFIX, BACKUP_ROUTES, type BackupRunSummary } from '@nexa/contracts';
import { BackupDeliveryCell } from '../../apps/web/src/pages/backup-delivery';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * NEXA-BACKUP-DELIVERY: the history's delivery cell. A run kept on the server by design reads
 * as that, never as a failed delivery; a split run shows each part's state and the reason
 * CODE's Persian words; «ارسال دوبارهٔ بخش‌های نرسیده» appears only when the server says the
 * run is redeliverable AND the actor holds `backup.run`, asks first, and posts with a key.
 */

const ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';

function run(overrides: Partial<BackupRunSummary> = {}): BackupRunSummary {
  return {
    id: ID,
    trigger: 'MANUAL',
    state: 'SUCCEEDED',
    stage: 'CLEANUP',
    startedAt: '2026-11-12T11:23:00.000Z',
    finishedAt: '2026-11-12T11:50:00.000Z',
    dumpBytes: '1',
    archiveBytes: '206000000',
    checksum: 'a'.repeat(64),
    verifiedAt: '2026-11-12T11:45:00.000Z',
    deliveryState: 'OUTCOME_UNKNOWN',
    deliveryAttemptedAt: '2026-11-12T11:46:00.000Z',
    deliveryDetailPresent: true,
    deliveryReason: 'CONNECTION_RESET',
    redeliverable: true,
    failureCode: null,
    cleanupOk: true,
    cleanupLeftovers: 0,
    archiveAvailable: true,
    archiveFormat: 'SEVEN_ZIP',
    partCount: 5,
    partsDelivered: 0,
    parts: [1, 2, 3, 4, 5].map((partNumber) => ({
      partNumber,
      bytes: '47185920',
      sha256: String(partNumber).repeat(64),
      deliveryState: partNumber === 1 ? 'OUTCOME_UNKNOWN' : 'NOT_ATTEMPTED',
      deliveryReason: partNumber === 1 ? 'CONNECTION_RESET' : null,
      attempts: partNumber === 1 ? 3 : 0,
    })),
    summaryDeliveryState: null,
    phaseDurationsMs: null,
    ...overrides,
  };
}

describe('a backup run’s delivery, part by part (NEXA-BACKUP-DELIVERY)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an import backup as kept on the server by design, with no parts and no button', () => {
    renderPage(
      <BackupDeliveryCell
        run={run({
          deliveryState: 'NOT_ATTEMPTED',
          deliveryReason: 'LOCAL_ONLY_IMPORT',
          redeliverable: false,
        })}
        mayRun
      />,
    );
    expect(screen.getByText(t('web.backup_delivery_by_design'))).toBeTruthy();
    expect(screen.getByText('طبق طراحی فقط روی سرور نگه داشته شد (بکاپ ایمپورت)')).toBeTruthy();
    expect(screen.queryByText(t('web.recovery_delivery_not_attempted'))).toBeNull();
    expect(screen.queryByRole('list', { name: t('web.backup_parts_title') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.backup_redeliver') })).toBeNull();
  });

  it('names each part’s state and real reason, and why the later parts were not sent', () => {
    renderPage(<BackupDeliveryCell run={run()} mayRun={false} />);
    const list = screen.getByRole('list', { name: t('web.backup_parts_title') });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]?.textContent).toContain(t('web.backup_reason_connection_reset'));
    expect(items[0]?.textContent).toContain(t('web.backup_part_attempts').replace('{n}', '3'));
    expect(items[1]?.textContent).toContain(t('web.backup_part_waiting'));
    // Without backup.run there is no button, whatever the server says.
    expect(screen.queryByRole('button', { name: t('web.backup_redeliver') })).toBeNull();
  });

  it('asks first, then re-delivers through the real endpoint with an idempotency key', async () => {
    const api = stubApi([
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.redeliver(ID)}`,
        method: 'POST',
        body: {
          outcome: 'DELIVERED',
          run: run({ deliveryState: 'SUCCEEDED', deliveryReason: null, redeliverable: false }),
        },
      },
    ]);
    renderPage(<BackupDeliveryCell run={run()} mayRun />);
    fireEvent.click(screen.getByRole('button', { name: t('web.backup_redeliver') }));
    // Nothing is sent before the operator confirms.
    expect(api.calls.some((call) => call.url.includes('/redeliver'))).toBe(false);
    fireEvent.click(
      await screen.findByRole('button', { name: t('web.backup_redeliver_confirm_yes') }),
    );
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes(BACKUP_ROUTES.redeliver(ID)))).toBe(true);
    });
    const call = api.calls.find((c) => c.url.includes('/redeliver'));
    expect(call?.method).toBe('POST');
    expect((call?.body as { idempotencyKey?: string }).idempotencyKey).toEqual(expect.any(String));
    expect(await screen.findByText(t('web.backup_redeliver_delivered'))).toBeTruthy();
  });
});
