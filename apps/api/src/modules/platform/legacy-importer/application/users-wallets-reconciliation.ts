import {
  LEGACY_USER_STATUS_CLASSES,
  LEGACY_BALANCE_CHANGE_CLASSES,
  LEGACY_BALANCE_CHANGE_OWNER_REVIEW,
  LEGACY_USERS_WALLETS_SECTION_VERSION,
  LEGACY_USER_OUTCOMES,
  type LegacyBalanceChangeClass,
  type LegacyUserOutcome,
} from '@nexa/contracts';
import {
  isReviewClosedToRerun,
  type LegacyImportMapRecord,
} from '../../legacy-import/application/legacy-import-ports.js';
import { legacyIsAgent, parseLegacyBalance } from './decisions.js';
import type { PlannedUser } from './plan.js';

/**
 * Mirza migration PR4 — the users-and-wallets reconciliation section
 * (`docs/legacy-migration/reconciliation.md` §Users and wallets), PURE.
 *
 * `legacy-import reconcile` and `report` print it as `usersWallets`; PR6 folds it, unchanged,
 * into the final report's schema version 2. It answers three questions without naming
 * anybody — counts, sums and opaque map refs only, never a Telegram id, a username or one
 * person's amount:
 *
 * 1. Is every source user row accounted for? One outcome per row (`LEGACY_USER_OUTCOMES`),
 *    and the closure Σ outcomes = source rows.
 * 2. Does the money add up? Σ positive legacy balances of the users imported from THIS
 *    snapshot = the opening CREDITs; Σ |negative| = the opening DEBITs (owner decision
 *    2026-10-17: a negative balance is the wallet's own balance, not a side record); no legacy
 *    debt row exists; and per user, the one opening NEXA posted is exactly the source figure.
 * 3. What changed since the snapshot NEXA imported from? Every SOURCE_CHANGED user is
 *    classed by how its balance moved; the sign flips are listed for the owner by map ref.
 *    Nothing here — or anywhere — applies a changed figure.
 * 4. Where is every source row's money? Each balance lands in exactly one bucket (credited,
 *    debited, zero, held with the outcome that says why, or unreadable — counted
 *    by rows, never summed as 0), and the buckets add up EXACTLY, by sign, to the readable
 *    source sum (U9/U10). Money on a review row is reported, never invisible.
 */

export interface UsersWalletsInput {
  readonly sourceFingerprint: string;
  /** The snapshot carried the synthetic-fixture marker. */
  readonly synthetic: boolean;
  readonly currency: string;
  readonly users: readonly PlannedUser[];
  /** The `user` map rows, by legacy id. */
  readonly mapRows: ReadonlyMap<string, LegacyImportMapRecord>;
  /** Telegram id → SIGNED ledger opening already posted. */
  readonly openings: ReadonlyMap<string, bigint>;
  /** Tenant-wide ledger opening aggregate, by sign. */
  readonly openingTotals: {
    readonly count: number;
    /** Signed. */
    readonly sumMinor: bigint;
    readonly positive: number;
    readonly negative: number;
    readonly creditSumMinor: bigint;
    /** Magnitude. */
    readonly debitSumMinor: bigint;
  };
  /**
   * Rows of the retired legacy-debt side record for this tenant. The importer writes none
   * since owner decision 2026-10-17; one existing means money is held outside the wallet.
   */
  readonly legacyDebtRows: number;
}

interface ChangeTally {
  count: number;
  recordedSumMinor: bigint;
  sourceSumMinor: bigint;
  differenceMinor: bigint;
}

/** One SOURCE_CHANGED user's class, from what NEXA recorded and what the source says now. */
export function classifyBalanceChange(
  recorded: bigint,
  now: bigint | null,
): LegacyBalanceChangeClass {
  if (now === null) return 'UNREADABLE_NOW';
  if (now === recorded) return 'PROFILE_ONLY';
  if (recorded === 0n) return 'FROM_ZERO';
  if (now === 0n) return 'TO_ZERO';
  if (recorded > 0n) return now > 0n ? 'POSITIVE_CHANGED' : 'POSITIVE_TO_NEGATIVE';
  return now < 0n ? 'NEGATIVE_CHANGED' : 'NEGATIVE_TO_POSITIVE';
}

/** Where one source row ended (the closure's classes). */
export function userOutcome(
  planned: PlannedUser,
  map: LegacyImportMapRecord | undefined,
): LegacyUserOutcome {
  const { decision, row } = planned;
  if (decision.kind === 'INVALID_IDENTITY') return 'SKIPPED_INVALID_IDENTITY';
  if (decision.kind === 'MANUAL_REVIEW' && decision.reason === 'DUPLICATE_SOURCE_ID') {
    return 'SKIPPED_DUPLICATE_SOURCE_ID';
  }
  if (map?.status === 'IMPORTED' && map.checksum !== row.checksum) return 'SOURCE_CHANGED';
  if (map !== undefined && map.status === 'MANUAL_REVIEW' && isReviewClosedToRerun(map)) {
    return 'SKIPPED_REVIEW_CLOSED';
  }
  if (decision.kind === 'MANUAL_REVIEW') {
    return decision.reason === 'BALANCE_UNREADABLE'
      ? 'SKIPPED_BALANCE_UNREADABLE'
      : decision.reason === 'STATUS_UNKNOWN'
        ? 'SKIPPED_STATUS_UNKNOWN'
        : 'SKIPPED_BALANCE_OUT_OF_RANGE';
  }
  if (map?.status !== 'IMPORTED') return 'NOT_YET_IMPORTED';
  return map.reasonCode === 'EXISTING_CUSTOMER' ? 'IMPORTED_EXISTING' : 'IMPORTED_NEW';
}

const zeroOutcomes = () =>
  Object.fromEntries(LEGACY_USER_OUTCOMES.map((k) => [k, 0])) as Record<LegacyUserOutcome, number>;

/** The outcomes whose row's money this snapshot does NOT apply: every one but the two IMPORTED. */
export type HeldOutcome = Exclude<LegacyUserOutcome, 'IMPORTED_NEW' | 'IMPORTED_EXISTING'>;
export const HELD_OUTCOMES = LEGACY_USER_OUTCOMES.filter(
  (o): o is HeldOutcome => o !== 'IMPORTED_NEW' && o !== 'IMPORTED_EXISTING',
);

/**
 * The money bucket ONE source row's balance lands in (the `sourceMoney` accounting, U9/U10).
 * Exactly one per row, decided from the row, its outcome and what NEXA recorded for it:
 *
 * - `UNREADABLE`: the cell is not a whole number of Toman. Its value is unknown, so it is
 *   counted by ROWS and never summed — never as a 0 (the closed v1 `legacyTotalMinor` does
 *   read it as 0; this accounting is where that is said).
 * - `CREDITED` / `DEBITED` / `ZERO`: an imported user for whom NEXA holds EXACTLY the
 *   source figure — one opening CREDIT of it, one opening DEBIT of its magnitude, or nothing.
 * - `HELD`: readable, and not applied from this snapshot, with the outcome that says why
 *   (manual review, an invalid identity, a duplicated id, a closed review, a changed source,
 *   or not imported yet).
 * - `UNACCOUNTED`: an imported user for whom NEXA holds something other than the source
 *   figure (nothing, a different amount, the other sign). Never expected.
 */
export type SourceMoneyBucket =
  | { readonly kind: 'UNREADABLE' }
  | { readonly kind: 'CREDITED'; readonly amountMinor: bigint }
  /** `amountMinor` is the magnitude. */
  | { readonly kind: 'DEBITED'; readonly amountMinor: bigint }
  | { readonly kind: 'ZERO' }
  | { readonly kind: 'HELD'; readonly outcome: HeldOutcome; readonly balanceMinor: bigint }
  | { readonly kind: 'UNACCOUNTED'; readonly balanceMinor: bigint };

export function sourceMoneyBucket(
  planned: PlannedUser,
  outcome: LegacyUserOutcome,
  opening: bigint | undefined,
): SourceMoneyBucket {
  const balance = parseLegacyBalance(planned.row.balance);
  if (balance === null) return { kind: 'UNREADABLE' };
  if (outcome !== 'IMPORTED_NEW' && outcome !== 'IMPORTED_EXISTING') {
    return { kind: 'HELD', outcome, balanceMinor: balance };
  }
  if (balance > 0n && opening === balance) return { kind: 'CREDITED', amountMinor: opening };
  if (balance < 0n && opening === balance) return { kind: 'DEBITED', amountMinor: -opening };
  if (balance === 0n && opening === undefined) return { kind: 'ZERO' };
  return { kind: 'UNACCOUNTED', balanceMinor: balance };
}

export interface SignedTally {
  rows: number;
  positive: { rows: number; sumMinor: bigint };
  /** Magnitudes. */
  negative: { rows: number; sumMinor: bigint };
}
const signedTally = (): SignedTally => ({
  rows: 0,
  positive: { rows: 0, sumMinor: 0n },
  negative: { rows: 0, sumMinor: 0n },
});
function addSigned(t: SignedTally, balance: bigint): void {
  t.rows += 1;
  if (balance > 0n) {
    t.positive.rows += 1;
    t.positive.sumMinor += balance;
  } else if (balance < 0n) {
    t.negative.rows += 1;
    t.negative.sumMinor += -balance;
  }
}
const signedView = (t: SignedTally) => ({
  rows: t.rows,
  positive: { rows: t.positive.rows, sumMinor: t.positive.sumMinor.toString() },
  negative: { rows: t.negative.rows, sumMinor: t.negative.sumMinor.toString() },
});

export function buildUsersWalletsSection(input: UsersWalletsInput) {
  const outcomes = zeroOutcomes();
  const agents = { sourceRows: 0, importedAsCustomers: 0 };
  /**
   * OQ-LWD-07: `User_Status` of every source row, and where the BLOCKED ones ended. A blocked
   * user's money is in the equations below exactly like anybody's; these figures say how
   * many there are, how many the import created BLOCKED, and how many matched an existing
   * NEXA customer whose status the import never changes.
   */
  const legacyStatus = Object.fromEntries(LEGACY_USER_STATUS_CLASSES.map((k) => [k, 0])) as Record<
    (typeof LEGACY_USER_STATUS_CLASSES)[number],
    number
  >;
  const blocked = { sourceRows: 0, importedNew: 0, importedExisting: 0, notImported: 0 };
  const positive = { users: 0, sumMinor: 0n };
  const negative = { users: 0, sumMinor: 0n };
  let zero = 0;
  const perUser = {
    /** What NEXA holds is exactly the source figure (a CREDIT, a DEBIT, or nothing for 0). */
    matching: 0,
    /** Non-zero in the source, no opening recorded. */
    missingOpening: 0,
    /** Something is recorded, and it is not the source figure. */
    conflicting: 0,
  };
  const changes = Object.fromEntries(
    LEGACY_BALANCE_CHANGE_CLASSES.map((k) => [
      k,
      { count: 0, recordedSumMinor: 0n, sourceSumMinor: 0n, differenceMinor: 0n },
    ]),
  ) as Record<LegacyBalanceChangeClass, ChangeTally>;
  const ownerReview = Object.fromEntries(
    LEGACY_BALANCE_CHANGE_OWNER_REVIEW.map((k) => [k, [] as string[]]),
  ) as Record<(typeof LEGACY_BALANCE_CHANGE_OWNER_REVIEW)[number], string[]>;

  /**
   * What NEXA recorded that this snapshot does not account for as imported: SOURCE_CHANGED
   * users keep the figure an earlier snapshot recorded (never re-applied), and a user this
   * snapshot no longer has keeps theirs. The tenant-wide equations add both, so they hold
   * exactly when NEXA is consistent, and the difference a newer snapshot brings is shown in
   * `sourceChanged`, never hidden in a failed sum.
   */
  const carried = {
    /** Positive openings: Σ amounts. */
    changedCredits: { count: 0, sumMinor: 0n },
    /** Negative openings: Σ magnitudes. */
    changedDebits: { count: 0, sumMinor: 0n },
    absentCredits: { count: 0, sumMinor: 0n },
    absentDebits: { count: 0, sumMinor: 0n },
  };
  const carry = (
    credit: { count: number; sumMinor: bigint },
    debit: { count: number; sumMinor: bigint },
    opening: bigint,
  ): void => {
    const into = opening < 0n ? debit : credit;
    into.count += 1;
    into.sumMinor += opening < 0n ? -opening : opening;
  };
  /**
   * The source-money accounting: every source row's balance in exactly one bucket
   * (`sourceMoneyBucket`), the readable ones summed by sign, the unreadable ones counted.
   */
  const money = {
    source: signedTally(),
    unreadable: {
      rows: 0,
      byOutcome: zeroOutcomes(),
    },
    credited: { rows: 0, sumMinor: 0n },
    debited: { rows: 0, sumMinor: 0n },
    zero: { rows: 0 },
    held: Object.fromEntries(HELD_OUTCOMES.map((o) => [o, signedTally()])) as Record<
      HeldOutcome,
      SignedTally
    >,
    unaccounted: signedTally(),
  };
  const seen = new Set<string>();
  for (const planned of input.users) {
    seen.add(planned.row.id);
    const map = input.mapRows.get(planned.row.id);
    const outcome = userOutcome(planned, map);
    outcomes[outcome] += 1;
    const bucket = sourceMoneyBucket(planned, outcome, input.openings.get(planned.row.id));
    if (bucket.kind === 'UNREADABLE') {
      money.unreadable.rows += 1;
      money.unreadable.byOutcome[outcome] += 1;
    } else {
      addSigned(money.source, parseLegacyBalance(planned.row.balance) ?? 0n);
      if (bucket.kind === 'CREDITED') {
        money.credited.rows += 1;
        money.credited.sumMinor += bucket.amountMinor;
      } else if (bucket.kind === 'DEBITED') {
        money.debited.rows += 1;
        money.debited.sumMinor += bucket.amountMinor;
      } else if (bucket.kind === 'ZERO') {
        money.zero.rows += 1;
      } else if (bucket.kind === 'HELD') {
        addSigned(money.held[bucket.outcome], bucket.balanceMinor);
      } else {
        addSigned(money.unaccounted, bucket.balanceMinor);
      }
    }
    legacyStatus[planned.row.status] += 1;
    if (planned.row.status === 'BLOCKED') {
      blocked.sourceRows += 1;
      if (outcome === 'IMPORTED_NEW') blocked.importedNew += 1;
      else if (outcome === 'IMPORTED_EXISTING') blocked.importedExisting += 1;
      else blocked.notImported += 1;
    }
    const agent = legacyIsAgent(planned.row.agent);
    if (agent) agents.sourceRows += 1;

    const opening = input.openings.get(planned.row.id);
    const recorded = opening ?? 0n;

    if (outcome === 'SOURCE_CHANGED' && map !== undefined) {
      if (opening !== undefined) carry(carried.changedCredits, carried.changedDebits, opening);
      const now = parseLegacyBalance(planned.row.balance);
      const cls = classifyBalanceChange(recorded, now);
      const t = changes[cls];
      t.count += 1;
      t.recordedSumMinor += recorded;
      if (now !== null) {
        t.sourceSumMinor += now;
        t.differenceMinor += now - recorded;
      }
      if (cls === 'POSITIVE_TO_NEGATIVE' || cls === 'NEGATIVE_TO_POSITIVE') {
        ownerReview[cls].push(map.ref);
      }
      continue;
    }
    if (outcome !== 'IMPORTED_NEW' && outcome !== 'IMPORTED_EXISTING') continue;
    if (planned.decision.kind !== 'IMPORT') continue;
    if (agent) agents.importedAsCustomers += 1;

    const balance = planned.decision.balanceMinor;
    if (balance > 0n) {
      positive.users += 1;
      positive.sumMinor += balance;
    } else if (balance < 0n) {
      negative.users += 1;
      negative.sumMinor += -balance;
    } else {
      zero += 1;
    }
    if (balance !== 0n && opening === undefined) {
      perUser.missingOpening += 1;
    } else if (opening === (balance === 0n ? undefined : balance)) {
      perUser.matching += 1;
    } else {
      perUser.conflicting += 1;
    }
  }

  for (const [id, amount] of input.openings) {
    if (seen.has(id)) continue;
    carry(carried.absentCredits, carried.absentDebits, amount);
  }
  const expectedCredits = {
    count: positive.users + carried.changedCredits.count + carried.absentCredits.count,
    sumMinor: positive.sumMinor + carried.changedCredits.sumMinor + carried.absentCredits.sumMinor,
  };
  const expectedDebits = {
    count: negative.users + carried.changedDebits.count + carried.absentDebits.count,
    sumMinor: negative.sumMinor + carried.changedDebits.sumMinor + carried.absentDebits.sumMinor,
  };
  for (const refs of Object.values(ownerReview)) refs.sort();
  const sourceRows = input.users.length;
  const closureActual = Object.values(outcomes).reduce((a, b) => a + b, 0);
  const minor = (v: bigint) => v.toString();
  const changeView = Object.fromEntries(
    Object.entries(changes).map(([k, t]) => [
      k,
      {
        count: t.count,
        recordedSumMinor: minor(t.recordedSumMinor),
        sourceSumMinor: minor(t.sourceSumMinor),
        differenceMinor: minor(t.differenceMinor),
      },
    ]),
  );
  const changedTotal = Object.values(changes).reduce((a, t) => a + t.count, 0);
  const heldTotal = signedTally();
  for (const t of Object.values(money.held)) {
    heldTotal.rows += t.rows;
    heldTotal.positive.rows += t.positive.rows;
    heldTotal.positive.sumMinor += t.positive.sumMinor;
    heldTotal.negative.rows += t.negative.rows;
    heldTotal.negative.sumMinor += t.negative.sumMinor;
  }
  const bucketRows =
    money.unreadable.rows +
    money.credited.rows +
    money.debited.rows +
    money.zero.rows +
    heldTotal.rows +
    money.unaccounted.rows;
  const accountedPositive = money.credited.sumMinor + heldTotal.positive.sumMinor;
  const accountedNegative = money.debited.sumMinor + heldTotal.negative.sumMinor;

  const checks = [
    {
      id: 'U1',
      what: 'every source user row is in exactly one outcome',
      holds: closureActual === sourceRows,
      expected: String(sourceRows),
      actual: String(closureActual),
    },
    {
      id: 'U2',
      what: 'Σ CREDIT openings = Σ positive balances imported from this snapshot + credits carried (changed or absent users)',
      holds: input.openingTotals.creditSumMinor === expectedCredits.sumMinor,
      expected: minor(expectedCredits.sumMinor),
      actual: minor(input.openingTotals.creditSumMinor),
    },
    {
      id: 'U3',
      what: 'one CREDIT opening per imported positive user, plus the credits carried',
      holds: input.openingTotals.positive === expectedCredits.count,
      expected: String(expectedCredits.count),
      actual: String(input.openingTotals.positive),
    },
    {
      id: 'U4',
      what: 'Σ |DEBIT openings| = Σ |negative balances| imported from this snapshot + debits carried (changed or absent users)',
      holds: input.openingTotals.debitSumMinor === expectedDebits.sumMinor,
      expected: minor(expectedDebits.sumMinor),
      actual: minor(input.openingTotals.debitSumMinor),
    },
    {
      id: 'U5',
      what: 'one DEBIT opening per imported negative user, plus the debits carried',
      holds: input.openingTotals.negative === expectedDebits.count,
      expected: String(expectedDebits.count),
      actual: String(input.openingTotals.negative),
    },
    {
      id: 'U6',
      what: 'no legacy debt side record exists (a negative balance is the wallet balance itself)',
      holds: input.legacyDebtRows === 0,
      expected: '0',
      actual: String(input.legacyDebtRows),
    },
    {
      id: 'U7',
      what: 'per imported user, NEXA holds exactly the source figure',
      holds:
        perUser.matching === positive.users + negative.users + zero &&
        perUser.missingOpening + perUser.conflicting === 0,
      expected: String(positive.users + negative.users + zero),
      actual: String(perUser.matching),
    },
    {
      id: 'U8',
      // Every opening is one of the two signs, and nothing else posts under the reason.
      what: 'openings by sign add up to the opening total (count and signed Σ)',
      holds:
        input.openingTotals.positive + input.openingTotals.negative === input.openingTotals.count &&
        input.openingTotals.creditSumMinor - input.openingTotals.debitSumMinor ===
          input.openingTotals.sumMinor,
      expected: `count=${String(input.openingTotals.count)} sum=${minor(input.openingTotals.sumMinor)}`,
      actual: `count=${String(input.openingTotals.positive + input.openingTotals.negative)} sum=${minor(input.openingTotals.creditSumMinor - input.openingTotals.debitSumMinor)}`,
    },
    {
      id: 'U9',
      // Every source row's money is somewhere a person can see: credited, debited, zero, held
      // with its reason, or unreadable (counted) — and none is unaccounted for.
      what: 'every source balance is in exactly one money bucket (credited, debited, zero, held with a reason, unreadable), none unaccounted',
      holds: bucketRows === sourceRows && money.unaccounted.rows === 0,
      expected: `rows=${String(sourceRows)} unaccounted=0`,
      actual: `rows=${String(bucketRows)} unaccounted=${String(money.unaccounted.rows)}`,
    },
    {
      id: 'U10',
      // Exact, by sign, never netted: Σ readable positive source balances = Σ credited + Σ
      // held positives; Σ |readable negative| = Σ debited + Σ held negatives.
      // NOT independent of U9: a row is CREDITED / DEBITED only when NEXA holds exactly its
      // source figure, so with nothing unaccounted these sums agree by construction. It states
      // U9's accounting in money for the operator; U2–U7 are the independent money checks.
      what: 'source money is accounted exactly: Σ positive = credited + held; Σ |negative| = debited + held (unreadable counted by rows)',
      holds:
        accountedPositive === money.source.positive.sumMinor &&
        accountedNegative === money.source.negative.sumMinor,
      expected: `+${minor(money.source.positive.sumMinor)} -${minor(money.source.negative.sumMinor)}`,
      actual: `+${minor(accountedPositive)} -${minor(accountedNegative)}`,
    },
  ];

  return {
    version: LEGACY_USERS_WALLETS_SECTION_VERSION,
    sourceFingerprint: input.sourceFingerprint,
    users: {
      sourceRows,
      outcomes,
      agents: {
        ...agents,
        /** A legacy agent is an ordinary customer: never a reseller row, never credit. */
        resellerGrants: 'NONE' as const,
      },
      legacyStatus,
      blocked,
    },
    wallet: {
      currency: input.currency,
      positive: {
        users: positive.users,
        sumMinor: minor(positive.sumMinor),
        openingEntries: input.openingTotals.positive,
        openingSumMinor: minor(input.openingTotals.creditSumMinor),
      },
      /**
       * Owner decision 2026-10-17: a negative balance is posted as a DEBIT opening, so the
       * wallet is negative and blocks purchase until topped up. Count and Σ |·| only.
       */
      negative: {
        users: negative.users,
        sumMinor: minor(negative.sumMinor),
        openingEntries: input.openingTotals.negative,
        openingSumMinor: minor(input.openingTotals.debitSumMinor),
      },
      zero: { users: zero },
      legacyDebtRows: input.legacyDebtRows,
      perUser,
      carried: {
        changedCredits: aggregateView(carried.changedCredits),
        changedDebits: aggregateView(carried.changedDebits),
        absentCredits: aggregateView(carried.absentCredits),
        absentDebits: aggregateView(carried.absentDebits),
      },
      /**
       * Every source row's balance, in exactly one bucket (U9), summed exactly by sign (U10).
       * `held` is keyed by the outcome that says why this snapshot's figure is not applied;
       * `unreadable` is counted by rows (its value is unknown), by outcome.
       */
      sourceMoney: {
        sourceRows,
        readable: signedView(money.source),
        unreadable: {
          rows: money.unreadable.rows,
          byOutcome: Object.fromEntries(
            Object.entries(money.unreadable.byOutcome).filter(([, n]) => n > 0),
          ),
        },
        credited: { rows: money.credited.rows, sumMinor: minor(money.credited.sumMinor) },
        debited: { rows: money.debited.rows, sumMinor: minor(money.debited.sumMinor) },
        zero: { rows: money.zero.rows },
        held: {
          ...signedView(heldTotal),
          byOutcome: Object.fromEntries(
            HELD_OUTCOMES.map((o) => [o, signedView(money.held[o])]),
          ) as Record<HeldOutcome, ReturnType<typeof signedView>>,
        },
        unaccounted: signedView(money.unaccounted),
      },
    },
    sourceChanged: {
      users: changedTotal,
      byClass: changeView,
      /** Opaque `legacy_import_map.ref` values — never a Telegram id. For the owner's review. */
      ownerReview,
    },
    checks,
    holds: checks.every((c) => c.holds),
  };
}

export type UsersWalletsSection = ReturnType<typeof buildUsersWalletsSection>;

function aggregateView(a: { readonly count: number; readonly sumMinor: bigint }) {
  return { count: a.count, sumMinor: a.sumMinor.toString() };
}
