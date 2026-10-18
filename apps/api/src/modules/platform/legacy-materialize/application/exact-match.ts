import {
  LEGACY_USER_OUTCOMES,
  type LegacyExactMatchReport,
  type LegacyExactMatchRow,
} from '@nexa/contracts';
import type { UsersWalletsSection } from '../../legacy-importer/application/users-wallets-reconciliation.js';
import { exactMatchHolds, type ExactMatchRow, type ExplainedGap } from './ports.js';

/**
 * The exact-match report (`docs/migration/mirza-import-plan-fa.md` §8), PURE: the core rows
 * the importer's own reconciliation already proves — every Mirza user and every unit of
 * Mirza `Balance` — and the rows each history step reports, each held to one rule
 * (`exactMatchHolds`): NEXA + every explained gap = Mirza, in rows and, where the table
 * carries money, in money. The import is COMPLETE only when every row holds.
 */

/** Every `user` row: imported (a customer), or held with the outcome that says why. */
export function usersRow(section: UsersWalletsSection): ExactMatchRow {
  const outcomes = section.users.outcomes;
  const imported = outcomes.IMPORTED_NEW + outcomes.IMPORTED_EXISTING;
  const explained: ExplainedGap[] = LEGACY_USER_OUTCOMES.filter(
    (o) => o !== 'IMPORTED_NEW' && o !== 'IMPORTED_EXISTING' && outcomes[o] > 0,
  ).map((o) => ({ reason: o, rows: outcomes[o], sumMinor: null }));
  return {
    mirzaTable: 'user',
    nexaTable: 'customers',
    mirzaRows: section.users.sourceRows,
    nexaRows: imported,
    mirzaSumMinor: null,
    nexaSumMinor: null,
    explained,
  };
}

/**
 * Every `user.Balance`, signed: what NEXA posted as openings (one CREDIT or DEBIT each, none
 * for zero) against the Mirza sum. A held row's balance is explained by its outcome, an
 * unreadable one by rows only (its value is unknown, so it is never summed — and it is not in
 * the Mirza sum either); an UNACCOUNTED row is never explained, so it fails the row.
 */
export function balancesRow(section: UsersWalletsSection): ExactMatchRow {
  const m = section.wallet.sourceMoney;
  const signed = (t: {
    positive: { rows: number; sumMinor: string };
    negative: { rows: number; sumMinor: string };
  }) => BigInt(t.positive.sumMinor) - BigInt(t.negative.sumMinor);
  const explained: ExplainedGap[] = [];
  for (const [outcome, t] of Object.entries(m.held.byOutcome)) {
    if (t.rows > 0) explained.push({ reason: outcome, rows: t.rows, sumMinor: signed(t) });
  }
  if (m.unreadable.rows > 0) {
    explained.push({ reason: 'BALANCE_UNREADABLE', rows: m.unreadable.rows, sumMinor: 0n });
  }
  return {
    mirzaTable: 'user.Balance',
    nexaTable: 'wallet_entries',
    mirzaRows: m.sourceRows,
    nexaRows: m.credited.rows + m.debited.rows + m.zero.rows,
    mirzaSumMinor: signed(m.readable),
    nexaSumMinor: BigInt(m.credited.sumMinor) - BigInt(m.debited.sumMinor),
    explained,
  };
}

export function exactMatchCoreRows(section: UsersWalletsSection): ExactMatchRow[] {
  return [usersRow(section), balancesRow(section)];
}

function wire(row: ExactMatchRow): LegacyExactMatchRow {
  const minor = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    mirzaTable: row.mirzaTable,
    nexaTable: row.nexaTable,
    mirzaRows: row.mirzaRows,
    nexaRows: row.nexaRows,
    mirzaSumMinor: minor(row.mirzaSumMinor),
    nexaSumMinor: minor(row.nexaSumMinor),
    explained: row.explained.map((g) => ({
      reason: g.reason,
      rows: g.rows,
      sumMinor: minor(g.sumMinor),
    })),
    holds: exactMatchHolds(row),
  };
}

export function exactMatchReport(rows: readonly ExactMatchRow[]): LegacyExactMatchReport {
  const wired = rows.map(wire);
  const unexplained = wired.filter((r) => !r.holds).length;
  // No row at all proves nothing: an empty report is never COMPLETE.
  return { rows: wired, unexplained, holds: wired.length > 0 && unexplained === 0 };
}

/** The wire rows back into the builder's shape (a report recorded by an earlier phase). */
export function exactMatchRowsFromWire(rows: readonly LegacyExactMatchRow[]): ExactMatchRow[] {
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return rows.map((r) => ({
    mirzaTable: r.mirzaTable,
    nexaTable: r.nexaTable,
    mirzaRows: r.mirzaRows,
    nexaRows: r.nexaRows,
    mirzaSumMinor: big(r.mirzaSumMinor),
    nexaSumMinor: big(r.nexaSumMinor),
    explained: r.explained.map((g) => ({
      reason: g.reason,
      rows: g.rows,
      sumMinor: big(g.sumMinor),
    })),
  }));
}
