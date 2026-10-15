/**
 * TEST-ONLY — a SYNTHETIC legacy `user` table with the MONEY SHAPE of the real Mirza package
 * the owner reported (its totals only; no row, id or amount of it is here): positive balances
 * summing to exactly 2,986,130,847 IRT across many customers, exactly 38 legacy debts summing
 * to 130,634,742 IRT, mixed `User_Status` values, zeros, and a few rows the importer must hold
 * for review (unreadable, out of range, an unknown status, a duplicated id, an invalid
 * identity). Pure and deterministic. NOT EVIDENCE about any backup.
 *
 * The amounts are spread by a fixed linear-congruential sequence and then corrected so each
 * class sums EXACTLY to its target: the totals, not the individual figures, are the shape.
 */

export const MONEY_SHAPE_POSITIVE_SUM = 2_986_130_847n;
export const MONEY_SHAPE_DEBTS = 38;
export const MONEY_SHAPE_DEBT_SUM = 130_634_742n;

type Row = Record<string, string | null>;

/** `n` positive amounts (each ≥ 1) summing exactly to `total`, deterministic in `seed`. */
export function spread(total: bigint, n: number, seed: number): bigint[] {
  if (n <= 0 || BigInt(n) > total) throw new Error('spread: impossible split');
  let x = seed >>> 0;
  const weights: bigint[] = [];
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    weights.push(BigInt((x % 9_973) + 1));
  }
  const w = weights.reduce((a, b) => a + b, 0n);
  const free = total - BigInt(n);
  const out = weights.map((wi) => 1n + (wi * free) / w);
  let rest = total - out.reduce((a, b) => a + b, 0n);
  for (let i = 0; rest > 0n; i = (i + 1) % n) {
    out[i] = (out[i] ?? 0n) + 1n;
    rest -= 1n;
  }
  return out;
}

export interface MoneyShapeOptions {
  /** How many customers share the positive total. */
  readonly positives: number;
  readonly zeros: number;
  /** Telegram id of generated user `i` is `idBase + i`. */
  readonly idBase: number;
  /** Include a row whose `user.id` is not a Telegram id (v1 C3 then fails by design). */
  readonly invalidIdentity: boolean;
  /**
   * Include two rows with one id (DUPLICATE_SOURCE_ID). A `.nxpkg` snapshot cannot carry them:
   * its `user` rows are strictly ascending by primary key, as the source table's are.
   */
  readonly duplicateId: boolean;
}

/** One row per class the importer HOLDS instead of applying, with its balance. */
export interface HeldRow {
  readonly id: string;
  readonly balance: string | null;
  readonly status: string | null;
  readonly why:
    | 'STATUS_UNKNOWN'
    | 'BALANCE_UNREADABLE'
    | 'BALANCE_OUT_OF_RANGE'
    | 'DUPLICATE_SOURCE_ID'
    | 'INVALID_IDENTITY';
}

export interface MoneyShape {
  /** The `user` rows, in the snapshot's column names. */
  readonly users: readonly Row[];
  /** Telegram id → positive balance (the openings). */
  readonly positives: ReadonlyMap<string, bigint>;
  /** Telegram id → debt magnitude. */
  readonly debts: ReadonlyMap<string, bigint>;
  readonly zeros: readonly string[];
  /** Telegram ids imported BLOCKED (their money recorded exactly like anybody's). */
  readonly blocked: ReadonlySet<string>;
  readonly held: readonly HeldRow[];
  /** Σ of the held rows' READABLE balances, by sign (magnitudes for negative). */
  readonly heldSums: { readonly positive: bigint; readonly negative: bigint };
  readonly unreadableRows: number;
}

export function moneyShapeUsers(options: MoneyShapeOptions): MoneyShape {
  const users: Row[] = [];
  const positives = new Map<string, bigint>();
  const debts = new Map<string, bigint>();
  const zeros: string[] = [];
  const blocked = new Set<string>();
  let next = 0;
  const id = () => String(options.idBase + next++);
  const row = (uid: string, balance: string | null, status: string | null): Row => ({
    id: uid,
    limit_usertest: '1',
    Balance: balance,
    number: 'none',
    User_Status: status,
    agent: 'f',
    affiliates: '0',
    username: 'none',
  });
  spread(MONEY_SHAPE_POSITIVE_SUM, options.positives, 7).forEach((amount, i) => {
    const uid = id();
    // Mixed statuses: every 7th is blocked in MirzaBot (imported BLOCKED, money recorded).
    const status = i % 7 === 3 ? 'block' : 'Active';
    if (status === 'block') blocked.add(uid);
    positives.set(uid, amount);
    users.push(row(uid, amount.toString(), status));
  });
  spread(MONEY_SHAPE_DEBT_SUM, MONEY_SHAPE_DEBTS, 11).forEach((amount, i) => {
    const uid = id();
    const status = i % 5 === 1 ? 'block' : 'Active';
    if (status === 'block') blocked.add(uid);
    debts.set(uid, amount);
    users.push(row(uid, `-${amount.toString()}`, status));
  });
  for (let i = 0; i < options.zeros; i += 1) {
    const uid = id();
    zeros.push(uid);
    users.push(row(uid, '0', i % 4 === 0 ? 'block' : 'Active'));
    if (i % 4 === 0) blocked.add(uid);
  }
  const duplicated = id();
  const held: HeldRow[] = [
    { id: id(), balance: '777000', status: 'Blocked', why: 'STATUS_UNKNOWN' },
    { id: id(), balance: '-12345', status: null, why: 'STATUS_UNKNOWN' },
    { id: id(), balance: '12.5', status: 'Active', why: 'BALANCE_UNREADABLE' },
    { id: id(), balance: 'abc', status: 'block', why: 'BALANCE_UNREADABLE' },
    { id: id(), balance: '1000000000001', status: 'Active', why: 'BALANCE_OUT_OF_RANGE' },
    { id: id(), balance: '-1000000000005', status: 'Active', why: 'BALANCE_OUT_OF_RANGE' },
    ...(options.duplicateId
      ? ([
          { id: duplicated, balance: '5000', status: 'Active', why: 'DUPLICATE_SOURCE_ID' },
          { id: duplicated, balance: '-7000', status: 'Active', why: 'DUPLICATE_SOURCE_ID' },
        ] as const)
      : []),
    ...(options.invalidIdentity
      ? [{ id: 'not-a-tg-id', balance: '9999', status: 'Active', why: 'INVALID_IDENTITY' } as const]
      : []),
  ];
  let heldPositive = 0n;
  let heldNegative = 0n;
  let unreadableRows = 0;
  for (const h of held) {
    users.push(row(h.id, h.balance, h.status));
    const text = h.balance ?? '';
    if (!/^-?[0-9]+$/u.test(text)) {
      unreadableRows += 1;
      continue;
    }
    const v = BigInt(text);
    if (v > 0n) heldPositive += v;
    else heldNegative += -v;
  }
  return {
    users,
    positives,
    debts,
    zeros,
    blocked,
    held,
    heldSums: { positive: heldPositive, negative: heldNegative },
    unreadableRows,
  };
}
