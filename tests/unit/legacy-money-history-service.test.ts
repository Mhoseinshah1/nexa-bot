import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  legacyMoneyHistoryResponseSchema,
  type ActorContext,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  LegacyMoneyHistoryService,
  customerMoneyView,
  type CustomerMoneyFacts,
  type LegacyMoneyHistoryReader,
} from '../../apps/api/src/modules/platform/legacy-history/application/legacy-money-history.service';
import type { PermissionGuard } from '../../apps/api/src/modules/platform/access/application/permission-guard';

/**
 * Mirza `.nxpkg` importer — «سوابق مالی میرزا»: charged on `users.view`, then the customer,
 * then `legacy.history.view` and `legacy.debts.view`, before anything is read; and structurally read-only (the
 * reader runs in a READ ONLY transaction and names no write; the HTTP route is a GET).
 * SYNTHETIC values only.
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const actor = {
  type: 'WEB_ADMIN',
  id: 'a',
  label: 'admin:test',
  surface: 'WEB',
} as unknown as ActorContext;
const CUSTOMER = '019210ab-cdef-7012-8345-6789abcdef01';

const facts: CustomerMoneyFacts = {
  payments: [
    {
      outcome: 'SUCCEEDED',
      method: 'CARD_TO_CARD',
      purpose: 'NOT_IN_SOURCE',
      currency: 'IRT',
      count: 2,
      sumMinor: 300000n,
      unparsed: 0,
    },
    {
      outcome: 'CANCELLED',
      method: 'CARD_TO_CARD',
      purpose: 'NOT_IN_SOURCE',
      currency: 'IRT',
      count: 1,
      sumMinor: 50000n,
      unparsed: 0,
    },
  ],
  walletTransactions: [],
  wheel: [],
  serviceOperations: [],
  referrals: { asReferee: 1, asReferrer: 0, referrerGiftsPaid: 0 },
  discountsUsed: 0,
  opening: {
    openingCredits: [{ amountMinor: 150000n, currency: 'IRT' }],
    openingNonCredits: 0,
    openingReferenceMatches: true,
    debt: null,
    checks: [],
    differences: [],
  },
};

function harness(held: readonly PermissionKey[], exists = true) {
  const asked: string[] = [];
  const guard = {
    check: async (_s: unknown, _a: unknown, permission: PermissionKey) => {
      asked.push(`check:${permission}`);
      if (!held.includes(permission)) {
        throw Object.assign(new Error('Missing permission'), {
          code: 'platform.permission_denied',
        });
      }
    },
  } as unknown as PermissionGuard;
  const reader: LegacyMoneyHistoryReader = {
    forCustomer: async () => {
      asked.push('read');
      return facts;
    },
    forTenant: async () => {
      throw new Error('not in this test');
    },
  };
  const customers = {
    findById: async () => {
      asked.push('customer');
      return exists ? { id: CUSTOMER, telegramUserId: '1000001' } : null;
    },
  };
  return { service: new LegacyMoneyHistoryService({ reader, customers, guard }), asked };
}

describe('the Mirza money history service', () => {
  it('refuses without legacy.history.view, after the customer check and before any read', async () => {
    const { service, asked } = harness(['users.view']);
    await expect(service.forCustomer(scope, actor, CUSTOMER)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(asked).toEqual(['check:users.view', 'customer', 'check:legacy.history.view']);
  });

  it('refuses without legacy.debts.view: the response names the legacy debt', async () => {
    // legacy.history.view alone is not enough: the history card withholds even the debt count
    // without legacy.debts.view, and this response carries the debt's amount and state.
    const { service, asked } = harness(['users.view', 'legacy.history.view']);
    await expect(service.forCustomer(scope, actor, CUSTOMER)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(asked).toEqual([
      'check:users.view',
      'customer',
      'check:legacy.history.view',
      'check:legacy.debts.view',
    ]);
  });

  it('refuses without users.view before looking the customer up', async () => {
    const { service, asked } = harness(['legacy.history.view']);
    await expect(service.forCustomer(scope, actor, CUSTOMER)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    expect(asked).toEqual(['check:users.view']);
  });

  it('answers 404 for a customer of no tenant, reading nothing', async () => {
    const { service, asked } = harness(
      ['users.view', 'legacy.history.view', 'legacy.debts.view'],
      false,
    );
    await expect(service.forCustomer(scope, actor, CUSTOMER)).rejects.toMatchObject({
      code: 'commerce.customer_not_found',
    });
    expect(asked).not.toContain('read');
  });

  it('returns a contract-valid, read-only view that never claims to be part of the balance', async () => {
    const { service } = harness(['users.view', 'legacy.history.view', 'legacy.debts.view']);
    const view = await service.forCustomer(scope, actor, CUSTOMER);
    expect(legacyMoneyHistoryResponseSchema.parse(view)).toEqual(view);
    expect(view.readOnly).toBe(true);
    expect(view.addedToBalance).toBe(false);
    expect(view.payments.succeededByPurpose).toEqual([
      {
        purpose: 'PURPOSE_NOT_IN_SOURCE',
        total: {
          count: 2,
          amounts: [{ amountMinor: '300000', currency: 'IRT' }],
          unparsedAmounts: 0,
          unrecognisedCurrency: 0,
        },
      },
    ]);
    expect(view.payments.excludedByOutcome.map((row) => row.outcome)).toEqual(['CANCELLED']);
    expect(view.opening.credit).toEqual({ amountMinor: '150000', currency: 'IRT' });
    expect(view.reconciliation.status).toBe('NO_WALLET_HISTORY');
  });
});

describe('the money history shows converter codes the way the history card does', () => {
  it('withholds a verdict, cause, certainty or status that is not a code as UNKNOWN', () => {
    const view = customerMoneyView({
      ...facts,
      serviceOperations: [
        { status: 'call 0912 345 6789', currency: 'IRT', count: 1, sumMinor: 1000n, unparsed: 0 },
        { status: 'PAID', currency: 'IRT', count: 1, sumMinor: 2000n, unparsed: 0 },
      ],
      opening: {
        ...facts.opening,
        checks: [
          {
            verdict: 'my name is Ali',
            snapshotMinor: '150000',
            snapshotCurrency: 'IRT',
            historyLastMinor: '150000',
            historyLastCurrency: 'IRT',
            deltaMinor: null,
          },
        ],
        differences: [{ cause: 'free text here', certainty: '123456' }],
      },
    });
    expect(view.reconciliation.historyVerdict).toBe('UNKNOWN');
    expect(view.reconciliation.difference).toEqual({ cause: 'UNKNOWN', certainty: 'UNKNOWN' });
    expect(view.serviceOperations.map((row) => row.status).sort()).toEqual(['PAID', 'UNKNOWN']);
    expect(JSON.stringify(view)).not.toMatch(/Ali|0912|free text|123456/u);
  });
});

describe('the money history is read-only by construction', () => {
  const reader = readFileSync(
    'apps/api/src/modules/platform/legacy-history/infrastructure/drizzle-legacy-money-history.reader.ts',
    'utf8',
  );

  it('the reader runs in a READ ONLY transaction and names no write statement', () => {
    expect(reader).toContain("accessMode: 'read only'");
    expect(reader.match(/this\.db\.transaction\(/gu)).toHaveLength(2);
    expect(reader.match(/\}, SNAPSHOT\);/gu)).toHaveLength(2);
    expect(reader).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/u);
    expect(reader).not.toMatch(/\.(insert|update|delete)\(/u);
  });

  it('the service and the pure module import no wallet, payment, order or refund code', () => {
    for (const file of [
      'apps/api/src/modules/platform/legacy-history/application/legacy-money-history.service.ts',
      'apps/api/src/modules/platform/legacy-history/application/money-reconciliation.ts',
    ]) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /from '[^']*(?:\/wallet\/|\/payments\/|\/orders\/|\/refunds?\/|\/pricing\/|\/provisioning\/)/u,
      );
    }
  });
});
