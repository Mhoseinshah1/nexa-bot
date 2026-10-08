import { describe, expect, it } from 'vitest';
import {
  LEGACY_BALANCE_CHANGE_CLASSES,
  LEGACY_USER_OUTCOMES,
  LEGACY_USERS_WALLETS_SECTION_VERSION,
} from '@nexa/contracts';
import { decideLegacyUser } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import {
  duplicateSourceIds,
  type PlannedUser,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import {
  buildUsersWalletsSection,
  classifyBalanceChange,
  userOutcome,
} from '../../apps/api/src/modules/platform/legacy-importer/application/users-wallets-reconciliation';
import type { LegacyImportMapRecord } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-import-ports';

/**
 * Mirza migration PR4 — the users-and-wallets reconciliation section, pure. Synthetic
 * figures only; no count here is a real-data expectation.
 */

const C = (n: number) => n.toString(16).padStart(64, '0');

function planned(
  id: string,
  balance: string,
  checksum = C(Number(id) || 1),
  agent = 'f',
  status: 'ACTIVE' | 'BLOCKED' | 'UNKNOWN' = 'ACTIVE',
): PlannedUser {
  const decision = decideLegacyUser({ id, balance, status }, false);
  return {
    row: {
      id,
      balance,
      limitUsertest: '1',
      agent,
      username: null,
      phone: 'ABSENT',
      status,
      checksum,
    },
    decision,
    existingCustomerId: null,
    opening: null,
    trial: null,
  };
}

function mapRow(
  legacyId: string,
  checksum: string,
  over: Partial<LegacyImportMapRecord> = {},
): LegacyImportMapRecord {
  return {
    tenantId: 't',
    legacyTable: 'user',
    legacyId,
    runId: 'r',
    checksum,
    status: 'IMPORTED',
    reasonCode: null,
    entityType: 'CUSTOMER',
    entityId: `c-${legacyId}`,
    attempts: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    reviewState: null,
    reviewResolutionCode: null,
    reviewedAt: null,
    reviewedByActorType: null,
    reviewedByActorId: null,
    reviewReopenedCount: 0,
    ref: `ref-${legacyId}`,
    ...over,
  } as LegacyImportMapRecord;
}

describe('the users-and-wallets section', () => {
  it('classes a changed balance by how it moved; a sign flip is never a plain change', () => {
    expect(classifyBalanceChange(100n, 100n)).toBe('PROFILE_ONLY');
    expect(classifyBalanceChange(100n, 150n)).toBe('POSITIVE_CHANGED');
    expect(classifyBalanceChange(-100n, -150n)).toBe('NEGATIVE_CHANGED');
    expect(classifyBalanceChange(100n, -1n)).toBe('POSITIVE_TO_NEGATIVE');
    expect(classifyBalanceChange(-100n, 1n)).toBe('NEGATIVE_TO_POSITIVE');
    expect(classifyBalanceChange(100n, 0n)).toBe('TO_ZERO');
    expect(classifyBalanceChange(-100n, 0n)).toBe('TO_ZERO');
    expect(classifyBalanceChange(0n, -5n)).toBe('FROM_ZERO');
    expect(classifyBalanceChange(0n, null)).toBe('UNREADABLE_NOW');
    expect(LEGACY_BALANCE_CHANGE_CLASSES).toHaveLength(8);
  });

  it("OQ-LWD-07: blocked users are counted, and their money is in the equations exactly as anybody's", () => {
    const users = [
      planned('301', '500', C(301), 'f', 'BLOCKED'),
      planned('302', '-300', C(302), 'f', 'BLOCKED'),
      planned('303', '200', C(303), 'f', 'BLOCKED'),
      planned('304', '100'),
      planned('305', '900', C(305), 'f', 'UNKNOWN'),
    ];
    const maps = new Map([
      ['301', mapRow('301', C(301))],
      ['302', mapRow('302', C(302))],
      ['303', mapRow('303', C(303), { reasonCode: 'EXISTING_CUSTOMER' })],
      ['304', mapRow('304', C(304))],
      [
        '305',
        mapRow('305', C(305), {
          status: 'MANUAL_REVIEW',
          reasonCode: 'INVALID_SOURCE_ROW',
          entityType: null,
          entityId: null,
          reviewState: 'OPEN',
        }),
      ],
    ]);
    const section = buildUsersWalletsSection({
      sourceFingerprint: C(42),
      synthetic: false,
      currency: 'IRT',
      users,
      mapRows: maps,
      openings: new Map([
        ['301', 500n],
        ['303', 200n],
        ['304', 100n],
      ]),
      debts: new Map([['302', 300n]]),
      openingTotals: { count: 3, sumMinor: 800n, negative: 0 },
      debtTotals: {
        count: 1,
        sumMinor: 300n,
        byState: { PENDING_REVIEW: { count: 1, sumMinor: 300n } },
        synthetic: 0,
      },
    });
    expect(section.users.legacyStatus).toEqual({ ACTIVE: 1, BLOCKED: 3, UNKNOWN: 1 });
    expect(section.users.blocked).toEqual({
      sourceRows: 3,
      importedNew: 2,
      importedExisting: 1,
      notImported: 0,
    });
    expect(section.users.outcomes.SKIPPED_STATUS_UNKNOWN).toBe(1);
    expect(section.wallet.positive).toMatchObject({ users: 3, sumMinor: '800' });
    expect(section.wallet.legacyDebts).toMatchObject({ users: 1, sumMinor: '300' });
    expect(section.holds).toBe(true);
  });

  it('gives every source row exactly one outcome', () => {
    expect(userOutcome(planned('not-an-id', '1'), undefined)).toBe('SKIPPED_INVALID_IDENTITY');
    expect(userOutcome(planned('101', 'x'), undefined)).toBe('SKIPPED_BALANCE_UNREADABLE');
    expect(userOutcome(planned('102', '5'), undefined)).toBe('NOT_YET_IMPORTED');
    // OQ-LWD-07: an unknown User_Status is its own skip, never a balance one, never imported.
    expect(userOutcome(planned('106', '5', C(106), 'f', 'UNKNOWN'), undefined)).toBe(
      'SKIPPED_STATUS_UNKNOWN',
    );
    const p = planned('103', '5');
    expect(userOutcome(p, mapRow('103', p.row.checksum))).toBe('IMPORTED_NEW');
    expect(userOutcome(p, mapRow('103', p.row.checksum, { reasonCode: 'EXISTING_CUSTOMER' }))).toBe(
      'IMPORTED_EXISTING',
    );
    expect(userOutcome(p, mapRow('103', C(999)))).toBe('SOURCE_CHANGED');
    // An imported user whose new balance is unreadable is SOURCE_CHANGED, not a fresh skip.
    expect(userOutcome(planned('104', 'x'), mapRow('104', C(998)))).toBe('SOURCE_CHANGED');
    expect(
      userOutcome(
        planned('105', 'x'),
        mapRow('105', C(105), {
          status: 'MANUAL_REVIEW',
          reviewState: 'DISMISSED',
          reviewResolutionCode: 'WILL_NOT_IMPORT',
          entityType: null,
          entityId: null,
        }),
      ),
    ).toBe('SKIPPED_REVIEW_CLOSED');
  });

  it('finds duplicate ids with an order-free checksum, ignoring ids that are not Telegram ids', () => {
    const rows = [
      { id: '7', checksum: C(1) },
      { id: '8', checksum: C(2) },
      { id: '7', checksum: C(3) },
      { id: 'x', checksum: C(4) },
      { id: 'x', checksum: C(5) },
    ];
    const found = duplicateSourceIds(rows);
    expect([...found.keys()]).toEqual(['7']);
    expect(duplicateSourceIds([...rows].reverse()).get('7')).toBe(found.get('7'));
    expect(found.get('7')).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('closes over every row, proves the money per user, and names nobody', () => {
    const users = [
      planned('201', '500'),
      planned('202', '-300'),
      planned('203', '0'),
      planned('204', '700', C(204), 'n'),
      planned('205', '-50'),
      planned('not-an-id', '1'),
    ];
    const maps = new Map(
      users
        .filter((u) => u.row.id !== 'not-an-id')
        .map((u) => [u.row.id, mapRow(u.row.id, u.row.id === '204' ? C(1) : u.row.checksum)]),
    );
    const section = buildUsersWalletsSection({
      sourceFingerprint: C(42),
      synthetic: false,
      currency: 'IRT',
      users,
      mapRows: maps,
      // 204 changed since: it was recorded as -100 (a debt), it is +700 now.
      openings: new Map([
        ['201', 500n],
        ['999', 40n],
      ]),
      debts: new Map([
        ['202', 300n],
        ['204', 100n],
        ['205', 50n],
      ]),
      openingTotals: { count: 2, sumMinor: 540n, negative: 0 },
      debtTotals: {
        count: 3,
        sumMinor: 450n,
        byState: { PENDING_REVIEW: { count: 3, sumMinor: 450n } },
        synthetic: 0,
      },
    });
    expect(section.version).toBe(LEGACY_USERS_WALLETS_SECTION_VERSION);
    expect(Object.keys(section.users.outcomes)).toEqual([...LEGACY_USER_OUTCOMES]);
    expect(section.users.outcomes).toMatchObject({
      IMPORTED_NEW: 4,
      SOURCE_CHANGED: 1,
      SKIPPED_INVALID_IDENTITY: 1,
    });
    expect(section.users.agents).toEqual({
      sourceRows: 1,
      importedAsCustomers: 0,
      resellerGrants: 'NONE',
    });
    expect(section.wallet.perUser).toEqual({
      matching: 4,
      missingOpening: 0,
      missingDebt: 0,
      priorDebitOpening: 0,
      conflicting: 0,
    });
    expect(section.wallet.carried).toEqual({
      changedOpenings: { count: 0, sumMinor: '0' },
      changedDebts: { count: 1, sumMinor: '100' },
      absentOpenings: { count: 1, sumMinor: '40' },
      absentDebts: { count: 0, sumMinor: '0' },
    });
    expect(section.sourceChanged.byClass.NEGATIVE_TO_POSITIVE).toEqual({
      count: 1,
      recordedSumMinor: '-100',
      sourceSumMinor: '700',
      differenceMinor: '800',
    });
    expect(section.sourceChanged.ownerReview).toEqual({
      POSITIVE_TO_NEGATIVE: [],
      NEGATIVE_TO_POSITIVE: ['ref-204'],
    });
    expect(section.checks.filter((c) => !c.holds)).toEqual([]);
    expect(section.holds).toBe(true);
    const text = JSON.stringify(section);
    for (const id of ['201', '202', '204', '999']) {
      expect(text).not.toMatch(new RegExp(`"${id}"`, 'u'));
    }
  });

  it('fails U6 and U7 on a ledger DEBIT opening, and U4 on a missing debt', () => {
    const users = [planned('301', '-300'), planned('302', '-20')];
    const maps = new Map(users.map((u) => [u.row.id, mapRow(u.row.id, u.row.checksum)]));
    const section = buildUsersWalletsSection({
      sourceFingerprint: C(1),
      synthetic: false,
      currency: 'IRT',
      users,
      mapRows: maps,
      openings: new Map([['301', -300n]]),
      debts: new Map(),
      openingTotals: { count: 1, sumMinor: -300n, negative: 1 },
      debtTotals: { count: 0, sumMinor: 0n, byState: {}, synthetic: 0 },
    });
    const failed = section.checks.filter((c) => !c.holds).map((c) => c.id);
    expect(failed).toEqual(['U2', 'U3', 'U4', 'U5', 'U6', 'U7']);
    expect(section.wallet.perUser).toMatchObject({ priorDebitOpening: 1, missingDebt: 1 });
  });

  it('U8: a real snapshot never reconciles while a debt from a synthetic source is recorded', () => {
    const users = [planned('401', '-10')];
    const maps = new Map(users.map((u) => [u.row.id, mapRow(u.row.id, u.row.checksum)]));
    const build = (synthetic: boolean) =>
      buildUsersWalletsSection({
        sourceFingerprint: C(2),
        synthetic,
        currency: 'IRT',
        users,
        mapRows: maps,
        openings: new Map(),
        debts: new Map([['401', 10n]]),
        openingTotals: { count: 0, sumMinor: 0n, negative: 0 },
        debtTotals: {
          count: 1,
          sumMinor: 10n,
          byState: { PENDING_REVIEW: { count: 1, sumMinor: 10n } },
          synthetic: 1,
        },
      });
    expect(
      build(false)
        .checks.filter((c) => !c.holds)
        .map((c) => c.id),
    ).toEqual(['U8']);
    expect(build(true).holds).toBe(true);
  });
});
