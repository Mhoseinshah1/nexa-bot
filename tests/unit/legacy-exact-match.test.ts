import { describe, expect, it } from 'vitest';
import {
  balancesRow,
  exactMatchReport,
  exactMatchRowsFromWire,
  usersRow,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/exact-match';
import {
  exactMatchHolds,
  type ExactMatchRow,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import type { UsersWalletsSection } from '../../apps/api/src/modules/platform/legacy-importer/application/users-wallets-reconciliation';

/**
 * The one-time import's exact-match report (`docs/migration/mirza-import-plan-fa.md` §8):
 * NEXA + every explained gap = Mirza, in rows and in money, or the import is not COMPLETE.
 */
const row = (over: Partial<ExactMatchRow> = {}): ExactMatchRow => ({
  mirzaTable: 'payments',
  nexaTable: 'payments',
  mirzaRows: 10,
  nexaRows: 8,
  mirzaSumMinor: 1_000n,
  nexaSumMinor: 700n,
  explained: [{ reason: 'CUSTOMER_NOT_IMPORTED', rows: 2, sumMinor: 300n }],
  ...over,
});

const tally = (rows: number, pos: string, negRows: number, neg: string) => ({
  rows: rows + negRows,
  positive: { rows, sumMinor: pos },
  negative: { rows: negRows, sumMinor: neg },
});

/** A section where 5 users exist: 2 credited, 1 debited, 1 zero, 1 held for review. */
function section(over: { unaccounted?: number } = {}): UsersWalletsSection {
  return {
    users: {
      sourceRows: 5,
      outcomes: {
        IMPORTED_NEW: 4,
        IMPORTED_EXISTING: 0,
        SKIPPED_INVALID_IDENTITY: 0,
        SKIPPED_BALANCE_UNREADABLE: 0,
        SKIPPED_BALANCE_OUT_OF_RANGE: 0,
        SKIPPED_DUPLICATE_SOURCE_ID: 0,
        SKIPPED_STATUS_UNKNOWN: 1,
        SKIPPED_REVIEW_CLOSED: 0,
        SOURCE_CHANGED: 0,
        NOT_YET_IMPORTED: 0,
      },
    },
    wallet: {
      sourceMoney: {
        // An unaccounted row is a readable source row NEXA holds nothing right for.
        sourceRows: 5 + (over.unaccounted ?? 0),
        readable: tally(3 + (over.unaccounted ?? 0), '1700', 1, '300'),
        unreadable: { rows: 0, byOutcome: {} },
        credited: { rows: 2, sumMinor: '1500' },
        debited: { rows: 1, sumMinor: '300' },
        zero: { rows: 1 },
        held: {
          ...tally(1, '200', 0, '0'),
          byOutcome: { SKIPPED_STATUS_UNKNOWN: tally(1, '200', 0, '0') },
        },
        unaccounted: tally(over.unaccounted ?? 0, '0', 0, '0'),
      },
    },
  } as unknown as UsersWalletsSection;
}

describe('the exact-match report', () => {
  it('holds when NEXA + explained = Mirza, in rows and in money', () => {
    expect(exactMatchHolds(row())).toBe(true);
  });

  it('fails on an unexplained row, and on unexplained money', () => {
    expect(exactMatchHolds(row({ nexaRows: 7 }))).toBe(false);
    expect(exactMatchHolds(row({ nexaSumMinor: 699n }))).toBe(false);
    expect(exactMatchHolds(row({ explained: [] }))).toBe(false);
    // A table with no money must say so on both sides.
    expect(exactMatchHolds(row({ mirzaSumMinor: null, nexaSumMinor: 700n }))).toBe(false);
    expect(
      exactMatchHolds(
        row({
          mirzaSumMinor: null,
          nexaSumMinor: null,
          explained: [{ reason: 'X', rows: 2, sumMinor: null }],
        }),
      ),
    ).toBe(true);
  });

  it('is COMPLETE only when every row holds, and never when it has no row', () => {
    expect(exactMatchReport([row(), row()])).toMatchObject({ holds: true, unexplained: 0 });
    expect(exactMatchReport([row(), row({ nexaRows: 1 })])).toMatchObject({
      holds: false,
      unexplained: 1,
    });
    expect(exactMatchReport([])).toMatchObject({ holds: false, unexplained: 0 });
  });

  it('round-trips through the wire shape without losing a unit', () => {
    const wired = exactMatchReport([
      row({ nexaRows: 10, mirzaSumMinor: -5n, nexaSumMinor: -5n, explained: [] }),
    ]);
    expect(wired.rows[0]).toMatchObject({ mirzaSumMinor: '-5', nexaSumMinor: '-5', holds: true });
    expect(exactMatchRowsFromWire(wired.rows)[0]).toMatchObject({ mirzaSumMinor: -5n });
  });

  it('core rows: every user and every unit of Balance, held rows explained by their outcome', () => {
    const users = usersRow(section());
    expect(users).toMatchObject({ mirzaRows: 5, nexaRows: 4 });
    expect(users.explained).toEqual([
      { reason: 'SKIPPED_STATUS_UNKNOWN', rows: 1, sumMinor: null },
    ]);
    expect(exactMatchHolds(users)).toBe(true);

    const balances = balancesRow(section());
    // Mirza: +1700 −300 = 1400; NEXA: 1500 credited − 300 debited = 1200; held: +200.
    expect(balances).toMatchObject({ mirzaSumMinor: 1400n, nexaSumMinor: 1200n, nexaRows: 4 });
    expect(exactMatchHolds(balances)).toBe(true);
  });

  it('core rows: an UNACCOUNTED balance is never explained', () => {
    expect(exactMatchHolds(balancesRow(section({ unaccounted: 1 })))).toBe(false);
  });
});
