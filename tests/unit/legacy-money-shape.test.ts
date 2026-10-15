import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  planLegacyImport,
  type LegacyPlan,
  type PlannedUser,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import type { RecordedDebt } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import {
  readFromSession,
  type LegacySnapshot,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import {
  buildUsersWalletsSection,
  type UsersWalletsSection,
} from '../../apps/api/src/modules/platform/legacy-importer/application/users-wallets-reconciliation';
import {
  crossCheckConverterMoney,
  walletExpectation,
  walletHistoryVerdicts,
} from '../../apps/api/src/modules/platform/legacy-importer/application/converter-wallet-crosscheck';
import { walletHistoryWarnings } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import type { LegacyImportMapRecord } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-import-ports';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';
import {
  MONEY_SHAPE_DEBTS,
  MONEY_SHAPE_DEBT_SUM,
  MONEY_SHAPE_POSITIVE_SUM,
  moneyShapeUsers,
  spread,
  type MoneyShape,
} from '../support/legacy-money-shape';

/**
 * The real Mirza package's MONEY SHAPE (its totals only), at unit level: positive balances
 * summing to exactly 2,986,130,847 IRT across 4,000 customers, exactly 38 legacy debts summing
 * to 130,634,742 IRT, mixed statuses, zeros, and the rows the importer must hold for review.
 * The plan is the importer's own (`planLegacyImport`); the import's outcome is what the
 * openings phase records for it (one CREDIT per positive, one debt per negative), and every
 * equation of the `usersWallets` section — aggregate AND per customer, and the source-money
 * accounting U9/U10 — is asserted over it. SYNTHETIC data only; NOT EVIDENCE.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const POSITIVES = 4_000;
const ZEROS = 300;

async function snapshotOf(shape: MoneyShape): Promise<LegacySnapshot> {
  const base = buildSyntheticLegacyDataset();
  const dataset = { ...base, tables: { ...base.tables, user: shape.users } };
  const connector = new FixtureLegacySourceConnector(dataset as never);
  return readFromSession(connector.label, await connector.open());
}

function plan(
  snapshot: LegacySnapshot,
  existingOpenings: ReadonlyMap<string, bigint> = new Map(),
  existingDebts: ReadonlyMap<string, RecordedDebt> = new Map(),
): LegacyPlan {
  return planLegacyImport({
    snapshot,
    mapping: parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT),
    salesCurrency: 'IRT',
    existingCustomers: new Map(),
    existingOpenings,
    existingDebts,
    trialOverrides: new Map(),
    trialDecided: new Set(),
    existingShapes: new Map(),
    tariffCandidates: [
      {
        id: 'p-30',
        status: 'ACTIVE',
        audience: 'EVERYONE',
        durationDays: 30,
        trafficBytes: 30n * 1024n ** 3n,
        price: money(200_000n, 'IRT'),
        panelBound: true,
        categoryStatus: 'ACTIVE',
      },
    ],
    inventories: syntheticInventories(PANEL_A, PANEL_B),
  } as never);
}

function mapRow(u: PlannedUser, over: Partial<LegacyImportMapRecord> = {}): LegacyImportMapRecord {
  return {
    tenantId: TENANT,
    legacyTable: 'user',
    legacyId: u.row.id,
    runId: 'r',
    checksum: u.row.checksum,
    status: 'IMPORTED',
    reasonCode: null,
    entityType: 'CUSTOMER',
    entityId: `c-${u.row.id}`,
    attempts: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    reviewState: null,
    reviewResolutionCode: null,
    reviewedAt: null,
    reviewedByActorType: null,
    reviewedByActorId: null,
    reviewReopenedCount: 0,
    ref: `ref-${u.row.id}`,
    ...over,
  } as LegacyImportMapRecord;
}

/**
 * What an APPLY of `planned` records: every importable user's map row, one opening CREDIT per
 * positive, one debt per negative, one review row per held user — or, with `upTo`, only the
 * first `upTo` importable users (a run that crashed part way).
 */
function applied(planned: LegacyPlan, upTo = Number.POSITIVE_INFINITY) {
  const mapRows = new Map<string, LegacyImportMapRecord>();
  const openings = new Map<string, bigint>();
  const debts = new Map<string, bigint>();
  let done = 0;
  for (const u of planned.users) {
    if (u.decision.kind === 'INVALID_IDENTITY') continue;
    if (u.decision.kind === 'MANUAL_REVIEW') {
      mapRows.set(
        u.row.id,
        mapRow(u, {
          status: 'MANUAL_REVIEW',
          reasonCode: u.decision.mapReason,
          entityType: null,
          entityId: null,
          reviewState: 'OPEN',
        }),
      );
      continue;
    }
    if (done >= upTo) continue;
    done += 1;
    mapRows.set(u.row.id, mapRow(u));
    if (u.decision.balanceMinor > 0n) openings.set(u.row.id, u.decision.balanceMinor);
    if (u.decision.balanceMinor < 0n) debts.set(u.row.id, -u.decision.balanceMinor);
  }
  return { mapRows, openings, debts };
}

function section(
  snapshot: LegacySnapshot,
  planned: LegacyPlan,
  state: ReturnType<typeof applied>,
): UsersWalletsSection {
  const sum = (m: ReadonlyMap<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);
  return buildUsersWalletsSection({
    sourceFingerprint: snapshot.fingerprint,
    synthetic: snapshot.synthetic,
    currency: 'IRT',
    users: planned.users,
    mapRows: state.mapRows,
    openings: state.openings,
    debts: state.debts,
    openingTotals: {
      count: state.openings.size,
      sumMinor: sum(state.openings),
      negative: [...state.openings.values()].filter((v) => v < 0n).length,
    },
    debtTotals: {
      count: state.debts.size,
      sumMinor: sum(state.debts),
      byState: { PENDING_REVIEW: { count: state.debts.size, sumMinor: sum(state.debts) } },
      synthetic: snapshot.synthetic ? state.debts.size : 0,
    },
  });
}

const failing = (s: UsersWalletsSection) => s.checks.filter((c) => !c.holds).map((c) => c.id);

describe('the real package money shape, planned and accounted (unit)', () => {
  const shape = moneyShapeUsers({
    positives: POSITIVES,
    zeros: ZEROS,
    idBase: 700_000_000,
    invalidIdentity: true,
    duplicateId: true,
  });

  it('the generator is exactly the shape: 2,986,130,847 over 4,000; 38 debts = 130,634,742', () => {
    expect([...shape.positives.values()].reduce((a, b) => a + b, 0n)).toBe(2_986_130_847n);
    expect(shape.positives.size).toBe(POSITIVES);
    expect(shape.debts.size).toBe(38);
    expect([...shape.debts.values()].reduce((a, b) => a + b, 0n)).toBe(130_634_742n);
    expect([...shape.positives.values()].every((v) => v >= 1n)).toBe(true);
    expect(spread(10n, 10, 3)).toEqual(Array.from({ length: 10 }, () => 1n));
  });

  it('the plan credits exactly the positives, records exactly the 38 debts, and holds the rest for review', async () => {
    const snapshot = await snapshotOf(shape);
    const planned = plan(snapshot);
    const t = planned.tallies;
    expect(t.wallet.positive).toEqual({ count: POSITIVES, sumMinor: MONEY_SHAPE_POSITIVE_SUM });
    expect(t.wallet.negative).toEqual({
      count: MONEY_SHAPE_DEBTS,
      sumMinor: -MONEY_SHAPE_DEBT_SUM,
    });
    expect(t.wallet.zero).toBe(ZEROS);
    expect(t.wallet.openings).toMatchObject({
      POST: POSITIVES,
      RECORD_DEBT: MONEY_SHAPE_DEBTS,
      ZERO_NO_ENTRY: ZEROS,
      CONFLICT: 0,
      ALREADY_POSTED: 0,
    });
    expect(t.customers.manualReview).toEqual({
      BALANCE_UNREADABLE: 2,
      BALANCE_OUT_OF_RANGE: 2,
      DUPLICATE_SOURCE_ID: 2,
      STATUS_UNKNOWN: 2,
    });
    expect(t.customers.invalidIdentity).toBe(1);
    // Mixed statuses: the blocked are imported (BLOCKED) with their money; unknown are held.
    expect(t.customers.blocked.new).toBe(shape.blocked.size);
    expect(t.customers.legacyStatus.UNKNOWN).toBe(2);
    // Per customer: the plan's figure for each user is exactly the source's.
    for (const u of planned.users) {
      if (u.decision.kind !== 'IMPORT') continue;
      const want =
        shape.positives.get(u.row.id) ??
        (shape.debts.has(u.row.id) ? -(shape.debts.get(u.row.id) ?? 0n) : 0n);
      expect(u.decision.balanceMinor, u.row.id).toBe(want);
    }
  });

  it('after the import every equation holds, aggregate AND per customer, and every source unit is accounted (U9/U10)', async () => {
    const snapshot = await snapshotOf(shape);
    const planned = plan(snapshot);
    const s = section(snapshot, planned, applied(planned));
    expect(failing(s)).toEqual([]);
    expect(s.holds).toBe(true);
    expect(s.wallet.positive).toMatchObject({
      users: POSITIVES,
      sumMinor: '2986130847',
      openingEntries: POSITIVES,
      openingSumMinor: '2986130847',
    });
    expect(s.wallet.legacyDebts).toMatchObject({
      users: 38,
      sumMinor: '130634742',
      recorded: 38,
      recordedSumMinor: '130634742',
    });
    expect(s.wallet.ledgerDebitOpenings).toBe(0);
    expect(s.wallet.perUser).toEqual({
      matching: POSITIVES + MONEY_SHAPE_DEBTS + ZEROS,
      missingOpening: 0,
      missingDebt: 0,
      priorDebitOpening: 0,
      conflicting: 0,
    });
    const m = s.wallet.sourceMoney;
    expect(m.credited).toEqual({ rows: POSITIVES, sumMinor: '2986130847' });
    expect(m.debtRecorded).toEqual({ rows: 38, sumMinor: '130634742' });
    expect(m.zero).toEqual({ rows: ZEROS });
    expect(m.unaccounted.rows).toBe(0);
    // Unreadable balances are counted by rows, never summed as 0.
    expect(m.unreadable).toEqual({ rows: 2, byOutcome: { SKIPPED_BALANCE_UNREADABLE: 2 } });
    // Held money, by the outcome that holds it, by sign — exactly.
    expect(m.held.byOutcome.SKIPPED_STATUS_UNKNOWN).toEqual({
      rows: 2,
      positive: { rows: 1, sumMinor: '777000' },
      negative: { rows: 1, sumMinor: '12345' },
    });
    expect(m.held.byOutcome.SKIPPED_BALANCE_OUT_OF_RANGE).toEqual({
      rows: 2,
      positive: { rows: 1, sumMinor: '1000000000001' },
      negative: { rows: 1, sumMinor: '1000000000005' },
    });
    expect(m.held.byOutcome.SKIPPED_DUPLICATE_SOURCE_ID).toEqual({
      rows: 2,
      positive: { rows: 1, sumMinor: '5000' },
      negative: { rows: 1, sumMinor: '7000' },
    });
    expect(m.held.byOutcome.SKIPPED_INVALID_IDENTITY).toEqual({
      rows: 1,
      positive: { rows: 1, sumMinor: '9999' },
      negative: { rows: 0, sumMinor: '0' },
    });
    expect(m.held.positive.sumMinor).toBe(shape.heldSums.positive.toString());
    expect(m.held.negative.sumMinor).toBe(shape.heldSums.negative.toString());
    // The equation itself: Σ source = credited + held, by sign, exactly.
    expect(BigInt(m.readable.positive.sumMinor)).toBe(
      MONEY_SHAPE_POSITIVE_SUM + shape.heldSums.positive,
    );
    expect(BigInt(m.readable.negative.sumMinor)).toBe(
      MONEY_SHAPE_DEBT_SUM + shape.heldSums.negative,
    );
    expect(m.sourceRows).toBe(shape.users.length);
    // Aggregates only: no Telegram id of this dataset is in the section.
    expect(JSON.stringify(s)).not.toMatch(/"70000\d{4}"/u);
  });

  it('a credit moved to another customer keeps every aggregate and is caught per customer (U7, U9, U10)', async () => {
    const snapshot = await snapshotOf(shape);
    const planned = plan(snapshot);
    const state = applied(planned);
    const ids = [...shape.positives.keys()];
    const first = ids[0] ?? '';
    const other = ids.find((id) => shape.positives.get(id) !== shape.positives.get(first)) ?? '';
    // Swap two customers' amounts: Σ and count unchanged.
    const x = state.openings.get(first) ?? 0n;
    const y = state.openings.get(other) ?? 0n;
    expect(x).not.toBe(y);
    state.openings.set(first, y);
    state.openings.set(other, x);
    const s = section(snapshot, planned, state);
    expect(failing(s)).toEqual(['U7', 'U9', 'U10']);
    expect(s.wallet.sourceMoney.unaccounted).toMatchObject({ rows: 2 });
  });

  it('a missing opening, a doubled debt and money on a held row each fail', async () => {
    const snapshot = await snapshotOf(shape);
    const planned = plan(snapshot);
    const missing = applied(planned);
    missing.openings.delete([...shape.positives.keys()][5] ?? '');
    expect(failing(section(snapshot, planned, missing))).toEqual(['U2', 'U3', 'U7', 'U9', 'U10']);

    const wrongDebt = applied(planned);
    const debtor = [...shape.debts.keys()][0] ?? '';
    wrongDebt.debts.set(debtor, (wrongDebt.debts.get(debtor) ?? 0n) * 2n);
    expect(failing(section(snapshot, planned, wrongDebt))).toEqual(['U4', 'U7', 'U9', 'U10']);

    // A held (STATUS_UNKNOWN) user given an opening anyway: never an equation that holds.
    const leak = applied(planned);
    const heldId = shape.held.find((h) => h.why === 'STATUS_UNKNOWN')?.id ?? '';
    leak.openings.set(heldId, 777_000n);
    expect(failing(section(snapshot, planned, leak))).toContain('U2');
  });

  it('a rerun over what the import recorded plans no second credit and no second debt', async () => {
    const snapshot = await snapshotOf(shape);
    const first = plan(snapshot);
    const state = applied(first);
    const debts = new Map(
      [...state.debts].map(([id, amountMinor]) => [id, { amountMinor, synthetic: true }]),
    );
    const again = plan(snapshot, state.openings, debts);
    expect(again.tallies.wallet.openings).toMatchObject({
      POST: 0,
      RECORD_DEBT: 0,
      ALREADY_POSTED: POSITIVES,
      DEBT_ALREADY_RECORDED: MONEY_SHAPE_DEBTS,
      ZERO_NO_ENTRY: ZEROS,
      CONFLICT: 0,
    });
    expect(failing(section(snapshot, again, state))).toEqual([]);
  });

  it('a run that crashed part way accounts its pending money as NOT_YET_IMPORTED; finishing it lands on the same totals', async () => {
    const snapshot = await snapshotOf(shape);
    const planned = plan(snapshot);
    const partial = section(snapshot, planned, applied(planned, 1_500));
    const pm = partial.wallet.sourceMoney;
    expect(pm.unaccounted.rows).toBe(0);
    expect(failing(partial)).toEqual([]);
    const pending = pm.held.byOutcome.NOT_YET_IMPORTED;
    // Σ credited so far + Σ pending = the whole positive total: nothing lost, nothing doubled.
    expect(BigInt(pm.credited.sumMinor) + BigInt(pending.positive.sumMinor)).toBe(
      MONEY_SHAPE_POSITIVE_SUM,
    );
    expect(BigInt(pm.debtRecorded.sumMinor) + BigInt(pending.negative.sumMinor)).toBe(
      MONEY_SHAPE_DEBT_SUM,
    );
    const done = section(snapshot, planned, applied(planned)).wallet.sourceMoney;
    expect(done.credited).toEqual({ rows: POSITIVES, sumMinor: '2986130847' });
    expect(done.held.byOutcome.NOT_YET_IMPORTED.rows).toBe(0);
  });
});

// --- the converter's records, per customer --------------------------------------------------

async function* records(list: readonly Record<string, unknown>[]) {
  for (const r of list) yield r;
}

function converterRecords(
  expected: ReadonlyMap<string, bigint>,
  kind: 'opening' | 'debt',
): Record<string, unknown>[] {
  return [...expected].map(([tg, amount]) => ({
    record_type: kind === 'opening' ? 'wallet_opening_balance' : 'legacy_debt',
    idempotency_key: `legacy:${kind}:${tg}`,
    telegram_user_id: tg,
    amount_minor: amount.toString(),
    currency: 'IRT',
  }));
}

describe("the converter's money records, customer by customer", () => {
  const shape = moneyShapeUsers({
    positives: 500,
    zeros: 20,
    idBase: 710_000_000,
    invalidIdentity: true,
    duplicateId: true,
  });

  it("the expectation is the plan's own: same counts, same sums", async () => {
    const snapshot = await snapshotOf(shape);
    const expectation = walletExpectation(snapshot.users);
    const t = plan(snapshot).tallies.wallet;
    expect(expectation.totals.openings).toEqual({
      count: t.positive.count,
      sumMinor: t.positive.sumMinor,
    });
    expect(expectation.totals.debts).toEqual({
      count: t.negative.count,
      sumMinor: -t.negative.sumMinor,
    });
    expect(expectation.totals.debts).toEqual({ count: 38, sumMinor: MONEY_SHAPE_DEBT_SUM });
  });

  it('a faithful converter matches every customer', async () => {
    const e = walletExpectation((await snapshotOf(shape)).users);
    const openings = await crossCheckConverterMoney(
      e.openings,
      records(converterRecords(e.openings, 'opening')),
      'legacy:opening:',
    );
    expect(openings).toEqual({
      matched: 500,
      missing: 0,
      unexpected: 0,
      amountDiffers: 0,
      duplicate: 0,
      unidentified: 0,
    });
    const debts = await crossCheckConverterMoney(
      e.debts,
      records(converterRecords(e.debts, 'debt')),
      'legacy:debt:',
    );
    expect(debts.matched).toBe(38);
  });

  it('equal totals with two amounts swapped, a credit for a held user, a lost record, a duplicate and a mislabelled key are all counted', async () => {
    const e = walletExpectation((await snapshotOf(shape)).users);
    const list = converterRecords(e.openings, 'opening');
    const [r0, r1] = [list[0], list[1]] as Record<string, unknown>[];
    const swapped = { ...r0, amount_minor: r1?.['amount_minor'] };
    const swapped1 = { ...r1, amount_minor: r0?.['amount_minor'] };
    const heldId = shape.held.find((h) => h.why === 'STATUS_UNKNOWN')?.id ?? '';
    const tally = await crossCheckConverterMoney(
      e.openings,
      records([
        swapped,
        swapped1,
        ...list.slice(2, -1), // the last one is lost
        list[2] as Record<string, unknown>, // a second record for one customer
        { ...list[3], idempotency_key: 'legacy:opening:123456789' }, // names someone else
        { record_type: 'wallet_opening_balance', telegram_user_id: heldId, amount_minor: '777000' },
      ]),
      'legacy:opening:',
    );
    expect(tally).toMatchObject({
      amountDiffers: 2,
      missing: 1,
      duplicate: 1,
      unidentified: 1,
      unexpected: 1,
    });
  });
});

// --- the wallet-history verdicts ------------------------------------------------------------

describe("the converter's wallet-history verdicts", () => {
  const snapshot = new Map<string, bigint | null>([
    ['700000001', 1_323_518n],
    ['700000002', -500n],
    ['700000003', null],
  ]);
  const check = (tg: string, verdict: string, amount: string | null) => ({
    record_type: 'legacy_wallet_history_check',
    customer: { telegram_user_id: tg, source_user_id: tg },
    verdict,
    snapshot_balance: amount === null ? null : { amount_minor: amount, currency: 'IRT' },
    snapshot_is_the_opening_figure: true,
  });

  it('counts contradictions by verdict and cause as warnings, and agrees with the snapshot', async () => {
    const v = await walletHistoryVerdicts(
      snapshot,
      records([
        check('700000001', 'MATCHES_SNAPSHOT', '1323518'),
        check('700000002', 'HISTORY_DIFFERS', '-500'),
        check('700000003', 'SNAPSHOT_UNREADABLE', null),
        check('999999999', 'MATCHES_SNAPSHOT', '1'),
      ]),
      records([
        {
          record_type: 'legacy_wallet_difference',
          customer: { telegram_user_id: '700000001' },
          cause: 'TOPUP_AFTER_HISTORY',
          features: { snapshot_minor: '1323518' },
          snapshot_is_the_opening_figure: true,
          opening_balance_changed: false,
        },
      ]),
    );
    expect(v).toMatchObject({
      checks: 4,
      matching: 2,
      notMatching: 2,
      differences: 1,
      unknownCustomer: 1,
      snapshotDisagrees: 0,
      openingNotSnapshot: 0,
    });
    expect(walletHistoryWarnings(v)).toEqual([
      { code: 'WALLET_HISTORY_NOT_MATCHING_SNAPSHOT', count: 2 },
      { code: 'WALLET_HISTORY_CHECK:HISTORY_DIFFERS', count: 1 },
      { code: 'WALLET_HISTORY_CHECK:SNAPSHOT_UNREADABLE', count: 1 },
      { code: 'WALLET_DIFFERENCE_ANALYSED', count: 1 },
      { code: 'WALLET_DIFFERENCE:TOPUP_AFTER_HISTORY', count: 1 },
      { code: 'WALLET_HISTORY_UNKNOWN_CUSTOMER', count: 1 },
    ]);
  });

  it("a verdict whose snapshot figure is not the importer's is a disagreement (the one that blocks)", async () => {
    const v = await walletHistoryVerdicts(
      snapshot,
      records([
        check('700000001', 'MATCHES_SNAPSHOT', '1323519'), // another figure
        check('700000003', 'MATCHES_SNAPSHOT', '10'), // a figure for an unreadable cell
        check('700000002', 'MATCHES_SNAPSHOT', null), // unreadable for a readable cell
      ]),
      records([
        {
          customer: { telegram_user_id: '700000002' },
          cause: 'X',
          features: { snapshot_minor: '-500' },
          opening_balance_changed: true,
        },
      ]),
    );
    expect(v.snapshotDisagrees).toBe(3);
    expect(v.openingNotSnapshot).toBe(1);
  });

  it('a package with no history files reports nothing', async () => {
    const v = await walletHistoryVerdicts(snapshot, null, null);
    expect(walletHistoryWarnings(v)).toEqual([]);
  });
});
