import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATA_COMPACTION_ROUTES, type DataCompactionPreview } from '@nexa/contracts';
import { DataCompactionCard } from '../../apps/web/src/pages/data-compaction';
import { renderPage, stubApi } from './harness';

/**
 * Round 9 C3: the data compaction's dry-run card. It counts on REQUEST, never on load, and
 * nothing on it deletes.
 */

const PREVIEW: DataCompactionPreview = {
  mode: 'DRY_RUN',
  blockedBy: 'BACKUP_IN_FLIGHT',
  classes: [
    {
      class: 'OPS_NOTIFICATIONS',
      retentionDays: 90,
      cutoff: '2026-07-22T12:00:00.000Z',
      counts: { notifications: 12, notification_delivery_attempts: 30 },
    },
    {
      class: 'CUSTOMER_NOTIFICATIONS',
      retentionDays: 180,
      cutoff: '2026-04-23T12:00:00.000Z',
      counts: { customer_notifications: 7 },
    },
    {
      class: 'RECEIPT_WINDOWS',
      retentionDays: 90,
      cutoff: '2026-07-22T12:00:00.000Z',
      counts: {},
    },
  ],
  lastRun: {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d9',
    trigger: 'WORKER',
    mode: 'DRY_RUN',
    state: 'COMPLETED',
    startedAt: '2026-10-19T21:00:00.000Z',
    finishedAt: '2026-10-19T21:00:01.000Z',
    counts: { notifications: 11 },
    stopReason: null,
  },
};

describe('data compaction card', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for the dry run only when the owner presses, and shows rows per table', async () => {
    const api = stubApi([{ url: DATA_COMPACTION_ROUTES.preview, body: PREVIEW }]);
    renderPage(<DataCompactionCard />);
    expect(api.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'شمارش (بدون حذف)' }));
    await waitFor(() => expect(screen.getByText('notification_delivery_attempts')).toBeTruthy());
    expect(api.calls.map((call) => call.method)).toEqual(['GET']);
    expect(screen.getByText('30')).toBeTruthy();
    expect(screen.getByText('customer_notifications')).toBeTruthy();
    // The mode and the reason the worker waits, in Persian.
    expect(screen.getAllByText('فقط شمارش').length).toBeGreaterThan(0);
    expect(screen.getByText(/یک بکاپ در حال گرفته شدن است/)).toBeTruthy();
    // No control on the card removes anything.
    expect(screen.queryByRole('button', { name: /حذف$/ })).toBeNull();
  });
});
