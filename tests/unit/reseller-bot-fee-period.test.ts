import { describe, expect, it } from 'vitest';
import {
  addMonthsUtc,
  noticeDay,
  renewalDue,
  shortWalletAction,
} from '../../apps/api/src/modules/commerce/reseller-bots/domain/fee-period';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the dedicated bot’s billing calendar (reseller-phase PR-6)', () => {
  it('adds calendar months in UTC, clamping to the month’s last day', () => {
    expect(addMonthsUtc(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addMonthsUtc(new Date('2026-12-15T00:00:00Z'), 1).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z',
    );
  });

  it('a running bot’s next period continues the paid one; nothing is due before it ends', () => {
    const paidThrough = new Date('2026-03-01T00:00:00Z');
    const sub = { paidThrough, lastPeriod: 1, feeStoppedAt: null };
    expect(renewalDue(sub, new Date('2026-02-28T23:59:59Z'), 3).kind).toBe('NOT_DUE');
    const due = renewalDue(sub, new Date('2026-03-02T00:00:00Z'), 3);
    expect(due).toMatchObject({ kind: 'DUE', period: 2, restarts: false });
    if (due.kind !== 'DUE') throw new Error('due');
    expect(due.start.toISOString()).toBe(paidThrough.toISOString());
    expect(due.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(due.graceEndsAt.getTime()).toBe(paidThrough.getTime() + 3 * DAY_MS);
  });

  it('after a stop, or a window long over, the new period starts now (missed months are not charged)', () => {
    const now = new Date('2026-05-10T00:00:00Z');
    const stopped = renewalDue(
      { paidThrough: new Date('2026-05-01T00:00:00Z'), lastPeriod: 1, feeStoppedAt: now },
      now,
      3,
    );
    expect(stopped).toMatchObject({ kind: 'DUE', period: 2, restarts: true });
    const stale = renewalDue(
      { paidThrough: new Date('2026-03-01T00:00:00Z'), lastPeriod: 1, feeStoppedAt: null },
      now,
      3,
    );
    expect(stale).toMatchObject({ kind: 'DUE', period: 2, restarts: true });
    if (stale.kind !== 'DUE') throw new Error('due');
    expect(stale.start.toISOString()).toBe(now.toISOString());
  });

  it('a short wallet is told during the grace days, stopped after, and left alone once stopped', () => {
    const graceEndsAt = new Date('2026-03-04T00:00:00Z');
    expect(shortWalletAction(new Date('2026-03-03T23:00:00Z'), graceEndsAt, false)).toBe('NOTICE');
    expect(shortWalletAction(graceEndsAt, graceEndsAt, false)).toBe('STOP');
    expect(shortWalletAction(graceEndsAt, graceEndsAt, true)).toBe('WAIT');
    expect(noticeDay(new Date('2026-03-03T23:59:59Z'))).toBe('2026-03-03');
  });
});
