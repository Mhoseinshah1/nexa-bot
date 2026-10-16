import { decideLegacyUser, legacyTelegramId, parseLegacyBalance } from './decisions.js';
import { duplicateSourceIds } from './plan.js';
import type { LegacyUserRow } from './source-snapshot.js';

/**
 * Mirza `.nxpkg` — the converter's per-customer money records and its wallet-history verdicts,
 * set beside the importer's OWN reading of the same snapshot (`docs/legacy-migration/
 * nxpkg-importer.md` §M8). PURE over async iterables, so a 200k-user package is streamed once
 * per file, with one map of the importer's expectation in memory (O(n)).
 *
 * Nothing here writes, and nothing here is evidence about a real backup: it compares two
 * readers of one snapshot and counts where they disagree. Aggregates and codes only — never a
 * Telegram id or one person's amount leaves this module.
 */

/** What the importer's plan does with every source user's money, by Telegram id. */
export interface WalletExpectation {
  /** Telegram id → the positive balance the openings phase posts as one CREDIT. */
  readonly openings: ReadonlyMap<string, bigint>;
  /** Telegram id → the magnitude of the negative balance recorded as a legacy debt. */
  readonly debts: ReadonlyMap<string, bigint>;
  /**
   * Telegram id → the snapshot's `Balance` as the importer reads it (`parseLegacyBalance`;
   * null = unreadable), for every id that is a Telegram id on exactly one source row.
   */
  readonly snapshot: ReadonlyMap<string, bigint | null>;
  readonly totals: {
    readonly openings: { readonly count: number; readonly sumMinor: bigint };
    readonly debts: { readonly count: number; readonly sumMinor: bigint };
  };
}

/**
 * The plan's own rule for a user's money — a duplicated id is held (nothing for any of its
 * rows), then `decideLegacyUser` — with no existing customer (a Fresh Migration has none, and
 * the balance decision does not depend on one). `tests/unit/legacy-converter-crosscheck.test.ts`
 * pins it to `planLegacyImport`'s wallet tallies.
 */
export function walletExpectation(
  users: readonly Pick<LegacyUserRow, 'id' | 'balance' | 'status' | 'checksum'>[],
): WalletExpectation {
  const duplicates = duplicateSourceIds(users);
  const openings = new Map<string, bigint>();
  const debts = new Map<string, bigint>();
  const snapshot = new Map<string, bigint | null>();
  let openingSum = 0n;
  let debtSum = 0n;
  for (const row of users) {
    const tg = legacyTelegramId(row.id);
    if (tg === null || duplicates.has(row.id)) continue;
    snapshot.set(tg, parseLegacyBalance(row.balance));
    const decision = decideLegacyUser(row, false);
    if (decision.kind !== 'IMPORT') continue;
    if (decision.balanceMinor > 0n) {
      openings.set(tg, decision.balanceMinor);
      openingSum += decision.balanceMinor;
    } else if (decision.balanceMinor < 0n) {
      debts.set(tg, -decision.balanceMinor);
      debtSum += -decision.balanceMinor;
    }
  }
  return {
    openings,
    debts,
    snapshot,
    totals: {
      openings: { count: openings.size, sumMinor: openingSum },
      debts: { count: debts.size, sumMinor: debtSum },
    },
  };
}

// --- per customer ----------------------------------------------------------------------------

/** How one money file of the converter compares with the importer, customer by customer. */
export interface PerCustomerTally {
  /** The record names a customer the importer expects, with exactly the importer's amount. */
  matched: number;
  /** The importer expects money for a customer the file has no record of. */
  missing: number;
  /** A record for a customer the importer expects NO such money for. */
  unexpected: number;
  /** A record for an expected customer with a different amount. */
  amountDiffers: number;
  /** A second record for one customer. */
  duplicate: number;
  /**
   * A record whose customer field (`telegram_user_id` for an opening, `legacy_user_id` for a
   * debt) is not a Telegram id, or whose `idempotency_key` names
   * another customer, or whose amount is not minor units: it cannot be matched to anybody.
   */
  unidentified: number;
}

export const PER_CUSTOMER_MISMATCH_KEYS = [
  'missing',
  'unexpected',
  'amountDiffers',
  'duplicate',
  'unidentified',
] as const;

export function perCustomerMismatches(t: PerCustomerTally): number {
  return PER_CUSTOMER_MISMATCH_KEYS.reduce((a, k) => a + t[k], 0);
}

const AMOUNT = /^(0|[1-9][0-9]*)$/u;

/**
 * The field that names the customer, per money file, as the converter writes it
 * (`mirza2nexa/convert.py`, contract 1.x): a `wallet_opening_balance` carries
 * `telegram_user_id`, a `legacy_debt` carries `legacy_user_id` — the name of the debt table's
 * own column it lands in (`docs/MAPPING.md` of the converter). Both hold the Mirza
 * `user.id`, which is the Telegram id. A record without its own file's field is unidentified;
 * the other file's field is never read in its place.
 */
const CUSTOMER_FIELD = {
  'legacy:opening:': 'telegram_user_id',
  'legacy:debt:': 'legacy_user_id',
} as const;

/**
 * Streams one converter money file (`wallet_opening_balances.jsonl` with `legacy:opening:`,
 * `legacy_debts.jsonl` with `legacy:debt:`) against the importer's expectation for it. A
 * customer is identified by the record's `CUSTOMER_FIELD`; its `idempotency_key`, when
 * present, must name the same customer.
 */
export async function crossCheckConverterMoney(
  expected: ReadonlyMap<string, bigint>,
  records: AsyncIterable<Readonly<Record<string, unknown>>>,
  keyPrefix: 'legacy:opening:' | 'legacy:debt:',
): Promise<PerCustomerTally> {
  const customerField = CUSTOMER_FIELD[keyPrefix];
  const tally: PerCustomerTally = {
    matched: 0,
    missing: 0,
    unexpected: 0,
    amountDiffers: 0,
    duplicate: 0,
    unidentified: 0,
  };
  const seen = new Set<string>();
  for await (const record of records) {
    const raw = record[customerField];
    const tg = typeof raw === 'string' ? legacyTelegramId(raw) : null;
    const key = record['idempotency_key'];
    const amount = record['amount_minor'];
    if (
      tg === null ||
      (key !== undefined && key !== `${keyPrefix}${tg}`) ||
      typeof amount !== 'string' ||
      !AMOUNT.test(amount)
    ) {
      tally.unidentified += 1;
      continue;
    }
    if (seen.has(tg)) {
      tally.duplicate += 1;
      continue;
    }
    seen.add(tg);
    const want = expected.get(tg);
    if (want === undefined) tally.unexpected += 1;
    else if (want !== BigInt(amount)) tally.amountDiffers += 1;
    else tally.matched += 1;
  }
  for (const tg of expected.keys()) if (!seen.has(tg)) tally.missing += 1;
  return tally;
}

// --- wallet history verdicts -----------------------------------------------------------------

/** The one `wallet_history_checks` verdict this repository has evidence for (the 1.4.0 fixture). */
export const WALLET_HISTORY_MATCHES = 'MATCHES_SNAPSHOT';
/** Distinct verdict / cause codes kept by name; any beyond are counted under `OTHER`. */
const MAX_CODES = 32;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

export interface WalletHistoryVerdicts {
  /** `wallet_history_checks.jsonl` records read. */
  checks: number;
  /** Of them, verdict `MATCHES_SNAPSHOT`: the history ends at the snapshot balance. */
  matching: number;
  /**
   * Of them, any other verdict: the wallet history does not confirm the snapshot balance (a
   * contradiction, an incomplete chain, or a verdict this repository has no evidence for).
   * Reported; the snapshot balance stays the opening figure.
   */
  notMatching: number;
  byVerdict: Record<string, number>;
  /** `wallet_difference_analysis.jsonl` records read: each one a snapshot≠history difference. */
  differences: number;
  byCause: Record<string, number>;
  /** A record saying the snapshot is NOT the opening figure, or that the opening changed. */
  openingNotSnapshot: number;
  /** A record whose customer is not a Telegram id on exactly one source row. */
  unknownCustomer: number;
  /**
   * A record whose own reading of the snapshot `Balance` differs from the importer's (a figure
   * against another figure, or against an unreadable cell). This one BLOCKS: two readers of
   * the one cell every opening is taken from do not agree, so neither figure is a fact.
   */
  snapshotDisagrees: number;
}

function codeOf(value: unknown, into: Record<string, number>): void {
  let code = typeof value === 'string' && CODE.test(value) ? value : 'UNRECOGNISED';
  if (!(code in into) && Object.keys(into).length >= MAX_CODES) code = 'OTHER';
  into[code] = (into[code] ?? 0) + 1;
}

/** The converter's figure for the snapshot cell: absent (no claim), unreadable, or a value. */
function claimedSnapshot(value: unknown):
  | { readonly claim: false }
  | {
      readonly claim: true;
      readonly value: bigint | null;
    } {
  if (value === undefined) return { claim: false };
  if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/u.test(value)) {
    return { claim: true, value: BigInt(value) };
  }
  return { claim: true, value: null };
}

function judgeSnapshot(
  out: WalletHistoryVerdicts,
  snapshot: ReadonlyMap<string, bigint | null>,
  record: Readonly<Record<string, unknown>>,
  claimed: unknown,
): void {
  const customer = record['customer'] as Readonly<Record<string, unknown>> | null | undefined;
  const raw = customer?.['telegram_user_id'];
  const tg = typeof raw === 'string' ? legacyTelegramId(raw) : null;
  if (tg === null || !snapshot.has(tg)) {
    out.unknownCustomer += 1;
    return;
  }
  if (
    record['snapshot_is_the_opening_figure'] === false ||
    record['opening_balance_changed'] === true
  ) {
    out.openingNotSnapshot += 1;
  }
  const claim = claimedSnapshot(claimed);
  if (claim.claim && claim.value !== (snapshot.get(tg) ?? null)) out.snapshotDisagrees += 1;
}

/**
 * Reads the converter's wallet-history verdicts (archived as history, never applied) and counts
 * them against the importer's reading of the snapshot. The snapshot balance stays the source
 * of truth (owner decision: the opening is `user.Balance`, the history is archive only).
 */
export async function walletHistoryVerdicts(
  snapshot: ReadonlyMap<string, bigint | null>,
  checks: AsyncIterable<Readonly<Record<string, unknown>>> | null,
  differences: AsyncIterable<Readonly<Record<string, unknown>>> | null,
): Promise<WalletHistoryVerdicts> {
  const out: WalletHistoryVerdicts = {
    checks: 0,
    matching: 0,
    notMatching: 0,
    byVerdict: {},
    differences: 0,
    byCause: {},
    openingNotSnapshot: 0,
    unknownCustomer: 0,
    snapshotDisagrees: 0,
  };
  for await (const record of checks ?? []) {
    out.checks += 1;
    if (record['verdict'] === WALLET_HISTORY_MATCHES) out.matching += 1;
    else out.notMatching += 1;
    codeOf(record['verdict'], out.byVerdict);
    const balance = record['snapshot_balance'] as Readonly<Record<string, unknown>> | null;
    judgeSnapshot(
      out,
      snapshot,
      record,
      balance === null ? null : balance === undefined ? undefined : balance['amount_minor'],
    );
  }
  for await (const record of differences ?? []) {
    out.differences += 1;
    codeOf(record['cause'], out.byCause);
    const features = record['features'] as Readonly<Record<string, unknown>> | null | undefined;
    judgeSnapshot(out, snapshot, record, features?.['snapshot_minor']);
  }
  return out;
}
