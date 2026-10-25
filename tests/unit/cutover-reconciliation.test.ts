import { describe, expect, it } from 'vitest';
import {
  CUTOVER_DIFFERENCE_KINDS,
  agentProfileIdOf,
  agentStateOf,
  cutoverExitCode,
  cutoverReportJson,
  cutoverReportText,
  reconcileCutover,
  type CutoverReconciliationInput,
  type NexaCustomerWallet,
  type NexaResellerRow,
} from '../../apps/api/src/modules/platform/legacy-cutover/application/cutover-reconciliation';
import { readNexaCutoverState } from '../../apps/api/src/modules/platform/legacy-cutover/infrastructure/pg-cutover-reconciliation.reader';
import type { DatabaseHandle } from '../../apps/api/src/infrastructure/persistence/database';
import { migrationCheckExitCode } from '../../apps/api/src/infrastructure/persistence/migrate';
import {
  parseReconcileArgs,
  reconcileTargetUrl,
  TargetRefused,
  UsageError,
} from '../../apps/api/src/cutover-reconcile.cli';

/**
 * The cutover's balance reconciliation (`docs/cutover/`): Mirza's snapshot against NEXA's
 * wallets, customer by customer, zero tolerance, agent credit listed and never credited.
 * SYNTHETIC values only.
 */

const TG = (n: number) => String(500_000_000 + n);
const wallet = (
  n: number,
  irt: bigint,
  extra: Record<string, bigint> = {},
): NexaCustomerWallet => ({
  customerId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  telegramUserId: TG(n),
  balances: new Map<string, bigint>([['IRT', irt], ...Object.entries(extra)]),
  nonOpeningEntries: 0,
});
const reseller = (n: number, over: Partial<NexaResellerRow> = {}): NexaResellerRow => ({
  resellerId: `00000000-0000-7000-9000-${String(n).padStart(12, '0')}`,
  customerId: wallet(n, 0n).customerId,
  source: 'MIRZA',
  status: 'ACTIVE',
  creditLimitAmount: null,
  tierCreditLimitAmount: 0n,
  importedPurchaseCapMinor: null,
  ...over,
});

/** Three customers and one agent, every wallet exactly the Mirza balance. */
function base(): CutoverReconciliationInput {
  return {
    users: [
      { id: TG(1), balance: '150000', agent: 'f' },
      { id: TG(2), balance: '-20000', agent: 'f' },
      { id: TG(3), balance: '0', agent: null },
      { id: TG(4), balance: '70000', agent: 'n' },
    ],
    agentStates: [{ agentId: TG(4), capRaw: '5000000' }],
    agentProfileIds: new Set(),
    customers: [wallet(1, 150000n), wallet(2, -20000n), wallet(3, 0n), wallet(4, 70000n)],
    heldUsers: new Map(),
    resellers: [reseller(4)],
    legacyDebtRows: 0,
  };
}

const kinds = (input: CutoverReconciliationInput) =>
  reconcileCutover(input).differences.map((d) => d.kind);

describe('cutover reconciliation', () => {
  it('RECONCILED when every wallet is exactly the Mirza balance; agent credit only listed', () => {
    const r = reconcileCutover(base());
    expect(r.verdict).toBe('RECONCILED');
    expect(cutoverExitCode(r.verdict)).toBe(0);
    expect(r.differences).toEqual([]);
    expect(r.matched).toEqual({ rows: 4, sumMinor: 200000n });
    expect(r.mirza.readable).toEqual({ rows: 4, sumMinor: 200000n });
    expect(r.mirza.negative).toEqual({ rows: 1, sumMinor: -20000n });
    expect(r.nexa.wallets).toEqual({ rows: 4, sumMinor: 200000n });
    expect(r.nexa.negativeWallets).toEqual({ rows: 1, sumMinor: -20000n });
    expect(r.agents).toMatchObject({
      mirzaAgents: 1,
      agentsMatched: 1,
      creditListedNotCredited: { rows: 1, sumMinor: 5000000n },
      creditUnreadable: 0,
      resellers: 1,
      resellersFromMirza: 1,
    });
  });

  it('zero tolerance: a wallet one Toman off is a difference', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      customers: [wallet(1, 150001n), ...input.customers.slice(1)],
    });
    expect(r.verdict).toBe('DIFFERENCES');
    expect(cutoverExitCode(r.verdict)).toBe(3);
    expect(r.differences).toEqual([
      expect.objectContaining({
        kind: 'BALANCE_DIFFERS',
        mirzaRow: 1,
        mirzaMinor: 150000n,
        nexaMinor: 150001n,
      }),
    ]);
  });

  it('a negative Mirza balance must be the negative wallet, not zero and not a credit', () => {
    const input = base();
    expect(
      kinds({
        ...input,
        customers: [input.customers[0]!, wallet(2, 0n), ...input.customers.slice(2)],
      }),
    ).toEqual(['BALANCE_DIFFERS']);
    expect(
      kinds({
        ...input,
        customers: [input.customers[0]!, wallet(2, 20000n), ...input.customers.slice(2)],
      }),
    ).toEqual(['BALANCE_DIFFERS']);
  });

  it('an agent whose wallet holds its balance plus its Mirza credit cap is AGENT_CREDIT_IN_WALLET', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      customers: [...input.customers.slice(0, 3), wallet(4, 70000n + 5000000n)],
    });
    expect(r.differences).toEqual([
      expect.objectContaining({
        kind: 'AGENT_CREDIT_IN_WALLET',
        mirzaMinor: 70000n,
        nexaMinor: 5070000n,
      }),
    ]);
    // The cap is still only listed: the figure is the same whatever the wallet holds.
    expect(r.agents.creditListedNotCredited).toEqual({ rows: 1, sumMinor: 5000000n });
  });

  it('a non-agent whose wallet is off by some amount is BALANCE_DIFFERS, never agent credit', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      users: input.users.map((u) => (u.id === TG(4) ? { ...u, agent: 'f' } : u)),
      customers: [...input.customers.slice(0, 3), wallet(4, 70000n + 5000000n)],
      resellers: [],
    });
    expect(r.differences.map((d) => d.kind)).toEqual(['BALANCE_DIFFERS']);
    expect(r.agents.creditListedNotCredited).toEqual({ rows: 0, sumMinor: 0n });
  });

  it('a reseller row with any credit limit, tier limit or imported cap is a difference', () => {
    const input = base();
    expect(kinds({ ...input, resellers: [reseller(4, { creditLimitAmount: 1n })] })).toEqual([
      'RESELLER_CREDIT_LIMIT',
    ]);
    expect(kinds({ ...input, resellers: [reseller(4, { tierCreditLimitAmount: 1000n })] })).toEqual(
      ['RESELLER_TIER_CREDIT_LIMIT'],
    );
    expect(kinds({ ...input, resellers: [reseller(4, { importedPurchaseCapMinor: 0n })] })).toEqual(
      ['RESELLER_PURCHASE_CAP'],
    );
    expect(kinds({ ...input, resellers: [reseller(4, { creditLimitAmount: 0n })] })).toEqual([]);
    expect(kinds({ ...input, resellers: [reseller(1)] })).toEqual(['RESELLER_NOT_A_MIRZA_AGENT']);
  });

  it('a Mirza user with no customer and no map row is MISSING_IN_NEXA', () => {
    const input = base();
    expect(kinds({ ...input, customers: input.customers.slice(1) })).toEqual(['MISSING_IN_NEXA']);
  });

  it('a held row is counted with its money and makes RECONCILED_WITH_HELD, not RECONCILED', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      customers: input.customers.slice(1),
      heldUsers: new Map([[TG(1), { status: 'MANUAL_REVIEW', reasonCode: 'STATUS_UNKNOWN' }]]),
    });
    expect(r.verdict).toBe('RECONCILED_WITH_HELD');
    expect(cutoverExitCode(r.verdict)).toBe(2);
    expect(r.held.HELD_BY_IMPORT).toEqual({ rows: 1, sumMinor: 150000n });
    expect(r.heldByReason).toEqual([{ reason: 'MANUAL_REVIEW:STATUS_UNKNOWN', rows: 1 }]);
    expect(r.matched.rows).toBe(3);
  });

  it('a customer the map says was held is IMPORTED_WHILE_HELD', () => {
    const input = base();
    expect(
      kinds({
        ...input,
        heldUsers: new Map([[TG(1), { status: 'MANUAL_REVIEW', reasonCode: 'X' }]]),
      }),
    ).toEqual(['IMPORTED_WHILE_HELD']);
  });

  it('identities, duplicates and unreadable balances are held, with their rows', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      users: [
        ...input.users,
        { id: 'not-a-telegram-id', balance: '5', agent: null },
        { id: TG(9), balance: '11', agent: null },
        { id: TG(9), balance: '12', agent: null },
        { id: TG(8), balance: 'abc', agent: null },
      ],
    });
    expect(r.verdict).toBe('RECONCILED_WITH_HELD');
    expect(r.held.INVALID_IDENTITY).toEqual({ rows: 1, sumMinor: 5n });
    expect(r.held.DUPLICATE_SOURCE_ID).toEqual({ rows: 2, sumMinor: 23n });
    expect(r.held.BALANCE_UNREADABLE).toEqual({ rows: 1, sumMinor: 0n });
    expect(r.mirza.readable.rows).toBe(7);
  });

  it('an imported customer whose Mirza balance cannot be read is a difference', () => {
    const input = base();
    expect(
      kinds({
        ...input,
        users: input.users.map((u) => (u.id === TG(3) ? { ...u, balance: '1.5' } : u)),
      }),
    ).toEqual(['BALANCE_DIFFERS']);
  });

  it('a customer no Mirza row names is NOT_IN_MIRZA', () => {
    const input = base();
    expect(kinds({ ...input, customers: [...input.customers, wallet(7, 0n)] })).toEqual([
      'NOT_IN_MIRZA',
    ]);
  });

  it('money in another currency, and legacy-debt side records, are differences', () => {
    const input = base();
    expect(
      kinds({
        ...input,
        customers: [wallet(1, 150000n, { USD: 5n }), ...input.customers.slice(1)],
      }),
    ).toEqual(['OTHER_CURRENCY']);
    expect(kinds({ ...input, legacyDebtRows: 2 })).toEqual(['LEGACY_DEBT_ROWS']);
  });

  it('counts every kind, and prints differences only when asked — never a Telegram id', () => {
    const input = base();
    const r = reconcileCutover({
      ...input,
      customers: [wallet(1, 1n), ...input.customers.slice(1)],
    });
    expect(Object.keys(r.differenceCounts)).toEqual([...CUTOVER_DIFFERENCE_KINDS]);
    expect(r.differenceCounts.BALANCE_DIFFERS).toBe(1);
    const quiet = cutoverReportText(r, { listDifferences: false });
    expect(quiet).toContain('verdict: DIFFERENCES');
    expect(quiet).toContain('agent credit LISTED, NOT CREDITED: 1 rows, 5000000 IRT');
    expect(quiet).not.toContain('mirza-row=');
    const loud = cutoverReportText(r, { listDifferences: true });
    expect(loud).toContain('BALANCE_DIFFERS mirza-row=1 customer=');
    for (const text of [quiet, loud, cutoverReportJson(r, { listDifferences: true })]) {
      for (const u of input.users) expect(text).not.toContain(u.id);
    }
    expect(JSON.parse(cutoverReportJson(r, { listDifferences: false }))).not.toHaveProperty(
      'differences',
    );
  });

  it('an agent profile alone makes an agent, so its reseller row is not a stranger', () => {
    const input = base();
    const users = input.users.map((u) => (u.id === TG(4) ? { ...u, agent: 'f' } : u));
    expect(kinds({ ...input, users })).toEqual(['RESELLER_NOT_A_MIRZA_AGENT']);
    const r = reconcileCutover({ ...input, users, agentProfileIds: new Set([TG(4)]) });
    expect(r.differences).toEqual([]);
    expect(r.agents.creditListedNotCredited).toEqual({ rows: 1, sumMinor: 5000000n });
  });

  it('reads an agent profile only when its tier is an agent tier', () => {
    const key = `legacy:agents:profile:${TG(4)}`;
    expect(agentProfileIdOf({ idempotency_key: key, tier: 'n2' })).toBe(TG(4));
    expect(agentProfileIdOf({ idempotency_key: key, tier: 'NOT_AGENT_IN_USER_TABLE' })).toBeNull();
    expect(
      agentProfileIdOf({ idempotency_key: 'legacy:agents:profile:unowned:1', tier: 'n' }),
    ).toBeNull();
  });

  it('reads an agent state record: its owner and the raw cap, never an unowned one', () => {
    expect(
      agentStateOf({
        idempotency_key: `legacy:agents:state:${TG(4)}`,
        credit_debt: { overdraft_limit_raw: '5000000' },
      }),
    ).toEqual({ agentId: TG(4), capRaw: '5000000' });
    expect(agentStateOf({ idempotency_key: 'legacy:agents:state:unowned:3' })).toBeNull();
    expect(agentStateOf({ idempotency_key: `legacy:agents:profile:${TG(4)}` })).toBeNull();
    expect(agentStateOf({ idempotency_key: `legacy:agents:state:${TG(4)}` })).toEqual({
      agentId: TG(4),
      capRaw: null,
    });
  });
});

describe('cutover-reconcile CLI arguments and target', () => {
  const ok = [
    '--package',
    '/p.nxpkg',
    '--package-key-env',
    'NXKEY',
    '--database',
    'nexa_cutover_scratch',
  ];

  it('parses a complete invocation', () => {
    expect(parseReconcileArgs([...ok, '--json', '--list-differences'])).toMatchObject({
      packagePath: '/p.nxpkg',
      packageKeyEnv: 'NXKEY',
      packagePassphraseEnv: null,
      database: 'nexa_cutover_scratch',
      json: true,
      listDifferences: true,
      timeoutMs: 600000,
    });
  });

  it('refuses missing, doubled, unknown and malformed arguments without echoing them', () => {
    expect(() => parseReconcileArgs(ok.slice(2))).toThrow(UsageError);
    expect(() => parseReconcileArgs(ok.slice(0, 4))).toThrow(UsageError);
    expect(() => parseReconcileArgs([...ok, '--package-passphrase-env', 'P'])).toThrow(UsageError);
    expect(() => parseReconcileArgs([...ok, '--database', 'x'])).toThrow(UsageError);
    expect(() => parseReconcileArgs([...ok.slice(0, 4), '--database', 'a;b'])).toThrow(UsageError);
    try {
      parseReconcileArgs([...ok, '123456:SECRET']);
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('SECRET');
    }
  });

  it('never reads the live database: a production-like name is refused', () => {
    const url = 'postgres://nexa:pw@postgres:5432/nexa';
    expect(() => reconcileTargetUrl(url, 'nexa')).toThrow(TargetRefused);
    expect(() => reconcileTargetUrl(url, 'nexa_prod')).toThrow(TargetRefused);
    const target = reconcileTargetUrl(url, 'nexa_cutover_scratch');
    expect(target.url).toBe('postgres://nexa:pw@postgres:5432/nexa_cutover_scratch');
    expect(target.target.database).toBe('nexa_cutover_scratch');
    expect(() => reconcileTargetUrl(undefined, 'nexa_test')).toThrow(UsageError);
  });
});

describe('the NEXA reader and the migration check', () => {
  it('reads inside one READ ONLY transaction and always rolls it back', async () => {
    const statements: string[] = [];
    const client = {
      query: (text: string) => {
        statements.push(text.replace(/\s+/gu, ' ').trim());
        if (text.includes('FROM tenants')) return Promise.resolve({ rows: [{ id: 't1' }] });
        if (text.includes('FROM legacy_wallet_debts')) return Promise.resolve({ rows: [{ n: 0 }] });
        return Promise.resolve({ rows: [] });
      },
    };
    const handle = {
      withClient: (fn: (c: unknown) => Promise<unknown>) => fn(client),
    } as unknown as DatabaseHandle;
    const state = await readNexaCutoverState(handle, {
      tenantSlug: null,
      statementTimeoutMs: 1000,
    });
    expect(state.tenantId).toBe('t1');
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements.filter((q) => /^(INSERT|UPDATE|DELETE|COMMIT)/u.test(q))).toEqual([]);
    // The wallet is every entry, whatever its reason — not the openings alone.
    const walletQuery = statements.find((q) => q.includes('FROM wallet_entries')) ?? '';
    expect(walletQuery).not.toMatch(/WHERE[^]*reason\s*=/u);
  });

  it('rolls back on a failure too', async () => {
    const statements: string[] = [];
    const client = {
      query: (text: string) => {
        statements.push(text.trim());
        return text.includes('FROM tenants')
          ? Promise.resolve({ rows: [] })
          : Promise.resolve({ rows: [] });
      },
    };
    const handle = {
      withClient: (fn: (c: unknown) => Promise<unknown>) => fn(client),
    } as unknown as DatabaseHandle;
    await expect(
      readNexaCutoverState(handle, { tenantSlug: 'x', statementTimeoutMs: 1000 }),
    ).rejects.toThrow('no tenant has slug x');
    expect(statements.at(-1)).toBe('ROLLBACK');
  });

  it('migrate --check passes current and ahead only', () => {
    expect(migrationCheckExitCode({ state: 'current', applied: 3, expected: 3 })).toBe(0);
    expect(migrationCheckExitCode({ state: 'ahead', applied: 4, expected: 3, extra: 1 })).toBe(0);
    expect(
      migrationCheckExitCode({ state: 'behind', applied: 2, expected: 3, missing: ['x'] }),
    ).toBe(1);
    expect(migrationCheckExitCode({ state: 'none', expected: 3 })).toBe(1);
    expect(migrationCheckExitCode({ state: 'diverged', reason: 'x' })).toBe(1);
  });
});
