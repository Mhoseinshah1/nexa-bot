import {
  legacyIsAgent,
  legacyTelegramId,
  parseLegacyBalance,
} from '../../legacy-importer/application/decisions.js';

/**
 * The cutover's balance reconciliation (`docs/cutover/`), PURE: the Mirza package's own
 * snapshot set beside what a NEXA database holds NOW, customer by customer, with zero
 * tolerance.
 *
 * It is not the importer's reconcile. That one compares the openings the importer POSTED with
 * the source (`users-wallets-reconciliation.ts`); this one compares the WALLET — every ledger
 * entry of every reason, summed — with Mirza's `user.Balance`, so a movement after the import,
 * a second credit, or a reseller's agent credit that reached the wallet is a difference here
 * even when every opening is right. It reads; it decides nothing and writes nothing.
 *
 * Three rules, each a way to sign off on money that is not there:
 *
 * 1. **Zero tolerance.** A readable Mirza balance either equals the customer's NEXA wallet
 *    exactly, or is a difference. There is no threshold and no rounding: both sides are whole
 *    Toman (`IRT` minor units).
 * 2. **Mirza agent credit is not wallet money** (owner decision 2026-10-01, no reseller
 *    credit). An agent's `maxbuyagent` (`agent_state.credit_debt.overdraft_limit_raw`) is
 *    listed on its own line and never added to anything. An agent whose wallet holds its
 *    balance PLUS its cap is named `AGENT_CREDIT_IN_WALLET`; a reseller row carrying any
 *    credit limit, tier credit limit or imported purchase cap is a difference too.
 * 3. **Nothing is explained away silently.** A row the importer held for review (its
 *    `legacy_import_map` row says why), an id that is not a Telegram id, a duplicated id and an
 *    unreadable balance are counted, with the money they carry, under `held` — which makes
 *    the verdict `RECONCILED_WITH_HELD`, a sign-off the owner gives by name, never `RECONCILED`.
 *
 * Aggregates by default. `differences` carries NEXA customer ids and Mirza row ordinals —
 * never a Telegram id — and one person's amounts; the CLI prints it only when asked, on the
 * operator's terminal.
 */

export const CUTOVER_RECONCILIATION_CURRENCY = 'IRT';

/** One `source/tables/user.jsonl` row, as the importer's snapshot reader reads it. */
export interface MirzaUserRow {
  readonly id: string;
  readonly balance: string | null;
  readonly agent: string | null;
}

/** One `records/agents/state.jsonl` record's facts: whose, and the raw cap. */
export interface MirzaAgentState {
  /** The Mirza `user.id` the state names (`legacy:agents:state:<id>`). */
  readonly agentId: string;
  /** `credit_debt.overdraft_limit_raw` exactly as packaged (Mirza `maxbuyagent`). */
  readonly capRaw: string | null;
}

export interface NexaCustomerWallet {
  readonly customerId: string;
  readonly telegramUserId: string;
  /** Currency → signed Σ (CREDIT − DEBIT) of every ledger entry of this customer. */
  readonly balances: ReadonlyMap<string, bigint>;
  /** Ledger entries whose reason is not `MIGRATION_OPENING_BALANCE`. */
  readonly nonOpeningEntries: number;
}

export interface NexaHeldUser {
  /** The `legacy_import_map` row's status (`MANUAL_REVIEW`, `FAILED`, …), never IMPORTED. */
  readonly status: string;
  readonly reasonCode: string | null;
}

export interface NexaResellerRow {
  readonly resellerId: string;
  readonly customerId: string;
  readonly source: string;
  readonly status: string;
  /** The reseller's own credit limit; NULL inherits the tier's. */
  readonly creditLimitAmount: bigint | null;
  readonly tierCreditLimitAmount: bigint | null;
  /** The deprecated imported `maxbuyagent` column; must be NULL. */
  readonly importedPurchaseCapMinor: bigint | null;
}

export interface CutoverReconciliationInput {
  readonly users: readonly MirzaUserRow[];
  readonly agentStates: readonly MirzaAgentState[];
  /**
   * Mirza user ids whose `records/agents/profiles.jsonl` record carries an agent tier (`n`,
   * `n2`) — what the resellers step makes a reseller from. A user is an agent when `user.agent`
   * says so OR its profile does.
   */
  readonly agentProfileIds: ReadonlySet<string>;
  readonly customers: readonly NexaCustomerWallet[];
  /** Legacy user id → its map row, for every `user` map row that is not IMPORTED. */
  readonly heldUsers: ReadonlyMap<string, NexaHeldUser>;
  readonly resellers: readonly NexaResellerRow[];
  /** Rows of the retired legacy wallet-debt side record for the tenant (a count, never an amount). */
  readonly legacyDebtRows: number;
}

export const CUTOVER_DIFFERENCE_KINDS = [
  /** A readable Mirza user with a Telegram id, no NEXA customer and no map row saying why. */
  'MISSING_IN_NEXA',
  /** The customer's NEXA wallet is not exactly the Mirza balance. */
  'BALANCE_DIFFERS',
  /** An agent whose wallet holds its Mirza balance plus its Mirza credit cap. */
  'AGENT_CREDIT_IN_WALLET',
  /** A customer's wallet holds money in a currency other than IRT. */
  'OTHER_CURRENCY',
  /** A NEXA customer whose Telegram id no Mirza row carries. */
  'NOT_IN_MIRZA',
  /** A customer exists although the import map says the row was held. */
  'IMPORTED_WHILE_HELD',
  /** A reseller's own credit limit is set and not zero. */
  'RESELLER_CREDIT_LIMIT',
  /** A reseller's tier carries a credit limit that is not zero. */
  'RESELLER_TIER_CREDIT_LIMIT',
  /** The deprecated imported purchase cap column holds a value. */
  'RESELLER_PURCHASE_CAP',
  /** A reseller row for a customer Mirza did not mark as an agent. */
  'RESELLER_NOT_A_MIRZA_AGENT',
  /** The tenant holds legacy-debt side records: money outside the wallet. */
  'LEGACY_DEBT_ROWS',
] as const;
export type CutoverDifferenceKind = (typeof CUTOVER_DIFFERENCE_KINDS)[number];

export const CUTOVER_HELD_KINDS = [
  'INVALID_IDENTITY',
  'DUPLICATE_SOURCE_ID',
  'BALANCE_UNREADABLE',
  'HELD_BY_IMPORT',
] as const;
export type CutoverHeldKind = (typeof CUTOVER_HELD_KINDS)[number];

export interface CutoverDifference {
  readonly kind: CutoverDifferenceKind;
  /** 1-based position of the Mirza row in `user.jsonl`, or null. Never the Telegram id. */
  readonly mirzaRow: number | null;
  readonly customerId: string | null;
  readonly resellerId: string | null;
  readonly mirzaMinor: bigint | null;
  readonly nexaMinor: bigint | null;
}

export interface MoneyTally {
  rows: number;
  /** Signed Σ, IRT minor units. */
  sumMinor: bigint;
}

export type CutoverVerdict = 'RECONCILED' | 'RECONCILED_WITH_HELD' | 'DIFFERENCES';

export interface CutoverReconciliation {
  readonly currency: typeof CUTOVER_RECONCILIATION_CURRENCY;
  readonly verdict: CutoverVerdict;
  readonly mirza: {
    readonly rows: number;
    /** Rows whose balance is a readable whole number, and their signed Σ. */
    readonly readable: MoneyTally;
    readonly positive: MoneyTally;
    readonly negative: MoneyTally;
    readonly zero: number;
  };
  readonly nexa: {
    readonly customers: number;
    /** Signed Σ of every IRT wallet in the tenant. */
    readonly wallets: MoneyTally;
    readonly negativeWallets: MoneyTally;
    readonly nonOpeningEntries: number;
    readonly legacyDebtRows: number;
  };
  /** Mirza rows whose NEXA wallet equals their balance exactly. */
  readonly matched: MoneyTally;
  /** Mirza rows not migrated, by why. Each is listed; none is a match. */
  readonly held: Readonly<Record<CutoverHeldKind, MoneyTally>>;
  readonly heldByReason: readonly { readonly reason: string; readonly rows: number }[];
  readonly agents: {
    /** Mirza users `user.agent` or an agent profile marks as agents. */
    readonly mirzaAgents: number;
    readonly agentsMatched: number;
    /** Agent credit, LISTED, never credited: caps that read as a whole number > 0. */
    readonly creditListedNotCredited: MoneyTally;
    /** Caps present but not a whole number (counted, never summed). */
    readonly creditUnreadable: number;
    readonly resellers: number;
    readonly resellersFromMirza: number;
  };
  readonly differenceCounts: Readonly<Record<CutoverDifferenceKind, number>>;
  readonly differences: readonly CutoverDifference[];
}

const tally = (): MoneyTally => ({ rows: 0, sumMinor: 0n });
const add = (t: MoneyTally, amount: bigint): void => {
  t.rows += 1;
  t.sumMinor += amount;
};

export function reconcileCutover(input: CutoverReconciliationInput): CutoverReconciliation {
  const currency = CUTOVER_RECONCILIATION_CURRENCY;
  const differences: CutoverDifference[] = [];
  const diff = (d: Partial<CutoverDifference> & { kind: CutoverDifferenceKind }): void => {
    differences.push({
      mirzaRow: null,
      customerId: null,
      resellerId: null,
      mirzaMinor: null,
      nexaMinor: null,
      ...d,
    });
  };

  const customersByTg = new Map<string, NexaCustomerWallet>();
  for (const c of input.customers) customersByTg.set(c.telegramUserId, c);

  const idRows = new Map<string, number>();
  for (const u of input.users) idRows.set(u.id, (idRows.get(u.id) ?? 0) + 1);

  const caps = new Map<string, string | null>();
  for (const s of input.agentStates) caps.set(s.agentId, s.capRaw);

  const readable = tally();
  const positive = tally();
  const negative = tally();
  let zero = 0;
  const matched = tally();
  const held = Object.fromEntries(CUTOVER_HELD_KINDS.map((k) => [k, tally()])) as Record<
    CutoverHeldKind,
    MoneyTally
  >;
  const heldReasons = new Map<string, number>();
  const credit = tally();
  let creditUnreadable = 0;
  let mirzaAgents = 0;
  let agentsMatched = 0;
  const agentTgs = new Set<string>();
  const seenTgs = new Set<string>();

  input.users.forEach((user, index) => {
    const row = index + 1;
    const balance = parseLegacyBalance(user.balance);
    if (balance !== null) {
      add(readable, balance);
      if (balance > 0n) add(positive, balance);
      else if (balance < 0n) add(negative, balance);
      else zero += 1;
    }
    const tg = legacyTelegramId(user.id);
    const isAgent = legacyIsAgent(user.agent) || input.agentProfileIds.has(user.id);
    if (isAgent) {
      mirzaAgents += 1;
      if (tg !== null) agentTgs.add(tg);
      const capRaw = caps.get(user.id) ?? null;
      if (capRaw !== null && capRaw.trim() !== '') {
        const cap = parseLegacyBalance(capRaw);
        if (cap === null) creditUnreadable += 1;
        else if (cap > 0n) add(credit, cap);
      }
    }
    if (tg === null) {
      add(held.INVALID_IDENTITY, balance ?? 0n);
      return;
    }
    seenTgs.add(tg);
    const customer = customersByTg.get(tg);
    if ((idRows.get(user.id) ?? 0) > 1) {
      add(held.DUPLICATE_SOURCE_ID, balance ?? 0n);
      if (customer !== undefined) {
        diff({ kind: 'IMPORTED_WHILE_HELD', mirzaRow: row, customerId: customer.customerId });
      }
      return;
    }
    const heldRow = input.heldUsers.get(user.id);
    if (customer === undefined) {
      if (balance === null) {
        add(held.BALANCE_UNREADABLE, 0n);
        return;
      }
      if (heldRow !== undefined) {
        add(held.HELD_BY_IMPORT, balance);
        const reason = `${heldRow.status}:${heldRow.reasonCode ?? '-'}`;
        heldReasons.set(reason, (heldReasons.get(reason) ?? 0) + 1);
        return;
      }
      diff({ kind: 'MISSING_IN_NEXA', mirzaRow: row, mirzaMinor: balance });
      return;
    }
    if (heldRow !== undefined) {
      diff({ kind: 'IMPORTED_WHILE_HELD', mirzaRow: row, customerId: customer.customerId });
      return;
    }
    for (const [cur, amount] of customer.balances) {
      if (cur !== currency && amount !== 0n) {
        diff({
          kind: 'OTHER_CURRENCY',
          mirzaRow: row,
          customerId: customer.customerId,
          nexaMinor: amount,
        });
      }
    }
    const nexa = customer.balances.get(currency) ?? 0n;
    if (balance === null) {
      // NEXA imported a customer whose Mirza balance cannot be read: whatever the wallet
      // holds, nobody can say it is the Mirza figure.
      diff({
        kind: 'BALANCE_DIFFERS',
        mirzaRow: row,
        customerId: customer.customerId,
        nexaMinor: nexa,
      });
      return;
    }
    if (nexa === balance) {
      add(matched, balance);
      if (isAgent) agentsMatched += 1;
      return;
    }
    const capRaw = isAgent ? (caps.get(user.id) ?? null) : null;
    const cap = capRaw === null ? null : parseLegacyBalance(capRaw);
    diff({
      kind:
        cap !== null && cap !== 0n && nexa === balance + cap
          ? 'AGENT_CREDIT_IN_WALLET'
          : 'BALANCE_DIFFERS',
      mirzaRow: row,
      customerId: customer.customerId,
      mirzaMinor: balance,
      nexaMinor: nexa,
    });
  });

  const wallets = tally();
  const negativeWallets = tally();
  let nonOpeningEntries = 0;
  const customerTg = new Map<string, string>();
  for (const c of input.customers) {
    customerTg.set(c.customerId, c.telegramUserId);
    const amount = c.balances.get(currency) ?? 0n;
    add(wallets, amount);
    if (amount < 0n) add(negativeWallets, amount);
    nonOpeningEntries += c.nonOpeningEntries;
    if (!seenTgs.has(c.telegramUserId)) {
      diff({ kind: 'NOT_IN_MIRZA', customerId: c.customerId, nexaMinor: amount });
    }
  }

  let resellersFromMirza = 0;
  for (const r of input.resellers) {
    if (r.source === 'MIRZA') resellersFromMirza += 1;
    const base = { customerId: r.customerId, resellerId: r.resellerId };
    if (r.creditLimitAmount !== null && r.creditLimitAmount !== 0n) {
      diff({ kind: 'RESELLER_CREDIT_LIMIT', ...base, nexaMinor: r.creditLimitAmount });
    }
    if (r.tierCreditLimitAmount !== null && r.tierCreditLimitAmount !== 0n) {
      diff({ kind: 'RESELLER_TIER_CREDIT_LIMIT', ...base, nexaMinor: r.tierCreditLimitAmount });
    }
    if (r.importedPurchaseCapMinor !== null) {
      diff({ kind: 'RESELLER_PURCHASE_CAP', ...base, nexaMinor: r.importedPurchaseCapMinor });
    }
    const tg = customerTg.get(r.customerId);
    if (tg === undefined || !agentTgs.has(tg)) {
      diff({ kind: 'RESELLER_NOT_A_MIRZA_AGENT', ...base });
    }
  }

  if (input.legacyDebtRows > 0) {
    diff({ kind: 'LEGACY_DEBT_ROWS', nexaMinor: BigInt(input.legacyDebtRows) });
  }

  const differenceCounts = Object.fromEntries(
    CUTOVER_DIFFERENCE_KINDS.map((k) => [k, differences.filter((d) => d.kind === k).length]),
  ) as Record<CutoverDifferenceKind, number>;
  const heldRows = CUTOVER_HELD_KINDS.reduce((n, k) => n + held[k].rows, 0);
  const verdict: CutoverVerdict =
    differences.length > 0 ? 'DIFFERENCES' : heldRows > 0 ? 'RECONCILED_WITH_HELD' : 'RECONCILED';

  return {
    currency,
    verdict,
    mirza: { rows: input.users.length, readable, positive, negative, zero },
    nexa: {
      customers: input.customers.length,
      wallets,
      negativeWallets,
      nonOpeningEntries,
      legacyDebtRows: input.legacyDebtRows,
    },
    matched,
    held,
    heldByReason: [...heldReasons]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([reason, rows]) => ({ reason, rows })),
    agents: {
      mirzaAgents,
      agentsMatched,
      creditListedNotCredited: credit,
      creditUnreadable,
      resellers: input.resellers.length,
      resellersFromMirza,
    },
    differenceCounts,
    differences,
  };
}

/** Exit codes: 0 every row matched; 2 no difference but rows held; 3 any difference. */
export function cutoverExitCode(verdict: CutoverVerdict): 0 | 2 | 3 {
  return verdict === 'RECONCILED' ? 0 : verdict === 'RECONCILED_WITH_HELD' ? 2 : 3;
}

/** The agent a `records/agents/profiles.jsonl` record names when its tier is an agent tier. */
export function agentProfileIdOf(record: Readonly<Record<string, unknown>>): string | null {
  const key = record['idempotency_key'];
  if (typeof key !== 'string') return null;
  const m = /^legacy:agents:profile:(.+)$/u.exec(key);
  if (m === null || (m[1] as string).startsWith('unowned:')) return null;
  const tier = record['tier'];
  return tier === 'n' || tier === 'n2' ? (m[1] as string) : null;
}

/** The agent a `records/agents/state.jsonl` record names, or null (unowned / malformed). */
export function agentStateOf(record: Readonly<Record<string, unknown>>): MirzaAgentState | null {
  const key = record['idempotency_key'];
  if (typeof key !== 'string') return null;
  const m = /^legacy:agents:state:(.+)$/u.exec(key);
  if (m === null || (m[1] as string).startsWith('unowned:')) return null;
  const creditDebt = record['credit_debt'];
  const raw =
    creditDebt !== null && typeof creditDebt === 'object'
      ? (creditDebt as Record<string, unknown>)['overdraft_limit_raw']
      : null;
  return {
    agentId: m[1] as string,
    capRaw: typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : null,
  };
}

const money = (t: MoneyTally): string => `${String(t.rows)} rows, ${t.sumMinor.toString()} IRT`;

/** The plain-text report: aggregates only, and the differences only when asked. */
export function cutoverReportText(
  r: CutoverReconciliation,
  options: { readonly listDifferences: boolean },
): string {
  const lines: string[] = [];
  lines.push(
    'Cutover balance reconciliation (read only; tolerance zero; nothing here moves money)',
  );
  lines.push(`verdict: ${r.verdict}`);
  lines.push(
    `mirza user rows: ${String(r.mirza.rows)}; readable ${money(r.mirza.readable)}; positive ${money(r.mirza.positive)}; negative ${money(r.mirza.negative)}; zero ${String(r.mirza.zero)}`,
  );
  lines.push(
    `nexa customers: ${String(r.nexa.customers)}; wallets ${money(r.nexa.wallets)}; negative wallets ${money(r.nexa.negativeWallets)}; non-opening ledger entries ${String(r.nexa.nonOpeningEntries)}; legacy debt rows ${String(r.nexa.legacyDebtRows)}`,
  );
  lines.push(`matched exactly: ${money(r.matched)}`);
  for (const k of CUTOVER_HELD_KINDS) lines.push(`held ${k}: ${money(r.held[k])}`);
  for (const h of r.heldByReason) lines.push(`  held by import ${h.reason}: ${String(h.rows)}`);
  const a = r.agents;
  lines.push(
    `mirza agents: ${String(a.mirzaAgents)}; matched ${String(a.agentsMatched)}; resellers ${String(a.resellers)} (from Mirza ${String(a.resellersFromMirza)})`,
  );
  lines.push(
    `agent credit LISTED, NOT CREDITED: ${money(a.creditListedNotCredited)}; unreadable caps ${String(a.creditUnreadable)}`,
  );
  for (const k of CUTOVER_DIFFERENCE_KINDS) {
    lines.push(`difference ${k}: ${String(r.differenceCounts[k])}`);
  }
  if (options.listDifferences) {
    lines.push('differences (terminal only; never paste):');
    for (const d of r.differences) {
      lines.push(
        [
          `  ${d.kind}`,
          d.mirzaRow === null ? null : `mirza-row=${String(d.mirzaRow)}`,
          d.customerId === null ? null : `customer=${d.customerId}`,
          d.resellerId === null ? null : `reseller=${d.resellerId}`,
          d.mirzaMinor === null ? null : `mirza=${d.mirzaMinor.toString()}`,
          d.nexaMinor === null ? null : `nexa=${d.nexaMinor.toString()}`,
        ]
          .filter((p): p is string => p !== null)
          .join(' '),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** JSON with bigint as decimal text; `differences` only when asked. */
export function cutoverReportJson(
  r: CutoverReconciliation,
  options: { readonly listDifferences: boolean },
): string {
  const body = options.listDifferences ? r : { ...r, differences: undefined };
  return `${JSON.stringify(
    body,
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  )}\n`;
}
