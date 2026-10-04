/**
 * SYNTHETIC legacy MirzaBot dataset — NOT EVIDENCE.
 *
 * A small, deterministic stand-in for the legacy `oldbot` database, built only to prove
 * that the P7 importer's CODE takes every decision branch. Nothing produced from it is a
 * Q1–Q7 result, a C1/C3 result or a rehearsal on real data, and every artefact derived
 * from it carries `SYNTHETIC` in its label (`docs/legacy-migration/importer.md`).
 *
 * Where the shape comes from:
 *
 * - the public MirzaBot source, `mahdiMGF2/botmirzapanel` at revision
 *   92c0ed0676c1d0c9540bae257092104744bab1fd, `table.php` (read-only): table names, the
 *   `user` / `invoice` / `product` columns, the `varchar` PKs `user.id` and
 *   `invoice.id_invoice`, `number` defaulting to `none`;
 * - `docs/legacy-migration/sql-evidence.md` Q1–Q7: the columns the production archive has
 *   beyond the public source (`agent`, `code_panel`, `code_product`, `is_test`,
 *   `is_custom`, `time_unit`) and the live statuses;
 * - `docs/rickpanel-inventory.md` / `docs/legacy-migration/*.md`: the decision branches.
 *
 * Two deliberate departures from the public source, both so a branch can be reached:
 * `user.Balance` and `user.limit_usertest` are `varchar` here (the public source declares
 * `int`), because an `int` column cannot hold the `12.5` and `x` rows that exercise
 * BALANCE_UNREADABLE and LEGACY_LIMIT_UNREADABLE. A production `int` column simply never
 * reaches those branches.
 */

export const SYNTHETIC_LABEL = 'SYNTHETIC legacy fixture v1 (not evidence)';

export interface SyntheticColumn {
  readonly name: string;
  /** MariaDB DDL type. */
  readonly ddl: string;
  /** What `information_schema.COLUMNS.DATA_TYPE` reports for it. */
  readonly dataType: string;
}

export const SYNTHETIC_SCHEMA: Readonly<
  Record<'user' | 'invoice' | 'product', readonly SyntheticColumn[]>
> = {
  user: [
    { name: 'id', ddl: 'varchar(500) NOT NULL PRIMARY KEY', dataType: 'varchar' },
    { name: 'limit_usertest', ddl: 'varchar(32) NULL', dataType: 'varchar' },
    { name: 'Balance', ddl: 'varchar(64) NULL', dataType: 'varchar' },
    { name: 'number', ddl: 'varchar(2000) NULL', dataType: 'varchar' },
    { name: 'User_Status', ddl: 'varchar(500) NULL', dataType: 'varchar' },
    { name: 'agent', ddl: 'varchar(100) NULL', dataType: 'varchar' },
    { name: 'affiliates', ddl: 'varchar(100) NULL', dataType: 'varchar' },
    { name: 'username', ddl: 'varchar(1000) NULL', dataType: 'varchar' },
  ],
  invoice: [
    { name: 'id_invoice', ddl: 'varchar(200) NOT NULL PRIMARY KEY', dataType: 'varchar' },
    { name: 'id_user', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'username', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'Service_location', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'time_sell', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'name_product', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'price_product', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'Volume', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'Service_time', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'Status', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'code_panel', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'code_product', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'is_test', ddl: 'varchar(10) NULL', dataType: 'varchar' },
    { name: 'is_custom', ddl: 'varchar(10) NULL', dataType: 'varchar' },
    { name: 'time_unit', ddl: 'varchar(50) NULL', dataType: 'varchar' },
  ],
  product: [
    { name: 'id', ddl: 'int(6) unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY', dataType: 'int' },
    { name: 'code_product', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'name_product', ddl: 'varchar(2000) NULL', dataType: 'varchar' },
    { name: 'price_product', ddl: 'varchar(2000) NULL', dataType: 'varchar' },
    { name: 'Volume_constraint', ddl: 'varchar(2000) NULL', dataType: 'varchar' },
    { name: 'Service_time', ddl: 'varchar(200) NULL', dataType: 'varchar' },
    { name: 'agent', ddl: 'varchar(100) NULL', dataType: 'varchar' },
  ],
};

export type SyntheticRow = Readonly<Record<string, string | null>>;

export interface SyntheticLegacyDataset {
  readonly synthetic: true;
  readonly label: string;
  readonly schema: readonly {
    readonly table: string;
    readonly column: string;
    readonly dataType: string;
    readonly ordinal: number;
  }[];
  readonly tables: Readonly<Record<'user' | 'invoice' | 'product', readonly SyntheticRow[]>>;
}

/** The legacy panel codes the dataset uses, and what the example mapping says of each. */
export const SYNTHETIC_PANEL_CODES = {
  /** Mapped to RickPanel A. */
  mappedA: 'rp1',
  /** Mapped to RickPanel B. */
  mappedB: 'rp2',
  /** A declared test panel. */
  test: 'tst',
  /** A code the operator declared missing: searched by username across panels. */
  declaredMissing: 'gone',
  /** A code nobody mapped: PANEL_UNMAPPED. */
  unmapped: 'zzz',
} as const;

/** What each fake RickPanel holds (exact provider spellings). */
export const SYNTHETIC_PANEL_ACCOUNTS = {
  A: ['svc_a1', 'svc_a2', 'svc_a3', 'svc_a4', 'svc_shared', 'Case_X', 'case_x'],
  B: ['svc_b1', 'svc_b2', 'svc_shared', 'svc_nullmatch'],
} as const;

/** The Telegram id of the user an integration test pre-creates as an EXISTING NEXA customer. */
export const SYNTHETIC_EXISTING_CUSTOMER = '100000005';

const user = (
  id: string,
  balance: string | null,
  limit: string | null,
  extra: Partial<Record<'number' | 'agent' | 'username', string | null>> = {},
): SyntheticRow => ({
  id,
  limit_usertest: limit,
  Balance: balance,
  number: extra.number ?? 'none',
  User_Status: 'Active',
  agent: extra.agent ?? 'f',
  affiliates: '0',
  username: extra.username ?? 'none',
});

let invoiceSeq = 0;
const invoice = (fields: {
  id?: string;
  idUser: string | null;
  username: string;
  codePanel: string | null;
  status?: string;
  isTest?: string;
  isCustom?: string;
  codeProduct?: string | null;
  volume?: string;
  serviceTime?: string;
  timeUnit?: string | null;
  price?: string;
}): SyntheticRow => {
  invoiceSeq += 1;
  return {
    // The evidenced key shape (`LEGACY_ID_PATTERNS.invoice`): 8 lowercase hex by default.
    id_invoice: fields.id ?? (0xa0000000 + invoiceSeq).toString(16),
    id_user: fields.idUser,
    username: fields.username,
    Service_location: 'synthetic',
    time_sell: '1700000000',
    name_product: 'synthetic',
    price_product: fields.price ?? '150000',
    Volume: fields.volume ?? '30',
    Service_time: fields.serviceTime ?? '30',
    Status: fields.status ?? 'active',
    code_panel: fields.codePanel,
    code_product: fields.codeProduct ?? null,
    is_test: fields.isTest ?? '0',
    is_custom: fields.isCustom ?? '0',
    time_unit: fields.timeUnit ?? '',
  };
};

/**
 * The expected outcome of every row, by the importer's own vocabulary — what the tests
 * assert against. Kept beside the rows so a row and its expectation cannot drift apart.
 */
export const SYNTHETIC_EXPECTED = {
  users: {
    source: 11,
    invalidIdentity: 1,
    manualReview: { BALANCE_UNREADABLE: 1, BALANCE_OUT_OF_RANGE: 1 },
    imported: 8,
    existing: 1,
    newCustomers: 7,
    opening: { POSITIVE: 5, ZERO: 2, NEGATIVE: 1 },
    /** Σ legacy Balance over the eight importable users. */
    legacyBalanceSumMinor: 50_000n - 20_000n + 30_000n + 1_000n + 7_000n + 12_345n,
    /** Over every source row. */
    phone: { ABSENT: 8, VALID: 1, INVALID: 2 },
    agents: 2,
    trial: {
      INHERIT_NEXA_POLICY: 4,
      LEGACY_TRIAL_CONSUMED: 2,
      LEGACY_NO_TRIALS: 1,
      LEGACY_LIMIT_UNREADABLE: 1,
      /** The pre-created customer has no override, so it takes a branch too. */
      KEPT_EXISTING_OVERRIDE: 0,
    },
  },
  services: {
    candidates: 19,
    categories: {
      INVOICE_KEY_INVALID: 1,
      TEST_INVOICE_SKIPPED: 1,
      TEST_PANEL_SKIPPED: 1,
      INVALID_SOURCE_ROW: 1,
      ORPHAN: 1,
      CUSTOMER_NOT_IMPORTED: 1,
      INVALID_USERNAME: 1,
      INVENTORY_INCOMPLETE: 0,
      PROVIDER_MISSING: 2,
      AMBIGUOUS_PANEL: 1,
      PANEL_UNMAPPED: 1,
      USERNAME_CASE_COLLISION: 1,
      UNSUPPORTED_SHAPE: 2,
      PRODUCT_UNRESOLVED: 1,
      ADOPTION_ELIGIBLE: 4,
    },
  },
} as const;

/**
 * Builds the dataset. `extraUsers` appends that many plain users (positive balances,
 * `limit_usertest = 1`, no invoices) for volume rehearsals; they do not change the
 * branch coverage above and are excluded from `SYNTHETIC_EXPECTED`.
 */
export function buildSyntheticLegacyDataset(
  options: { extraUsers?: number } = {},
): SyntheticLegacyDataset {
  invoiceSeq = 0;
  const C = SYNTHETIC_PANEL_CODES;
  const users: SyntheticRow[] = [
    // new customer, positive, allowed and unused trial, a valid phone, a profile username
    user('100000001', '50000', '1', { number: '989121234567', username: 'alice_legacy' }),
    // zero balance, had a trial (live test invoice below)
    user('100000002', '0', '1'),
    // legacy debt; the legacy bot said no trials
    user('100000003', '-20000', '0'),
    // a balance that is not a whole number: manual review, nothing written
    user('100000004', '12.5', '1'),
    // already a NEXA customer (an integration test creates it first); an unusable phone
    user(SYNTHETIC_EXISTING_CUSTOMER, '30000', '1', { number: 'call me' }),
    // not a Telegram id: no customer, no key
    user('not-a-telegram-id', '100', '1'),
    // unreadable trial limit; an agent (reported only)
    user('100000007', '1000', 'x', { agent: 'n' }),
    // a balance beyond the payment bound: manual review
    user('100000008', '99999999999999', '1'),
    // odd legacy limit 9, zero balance; an agent; an unusable phone
    user('100000009', '0', '9', { agent: 'n2', number: '12' }),
    // a trial used long ago (a removed test invoice) — still consumed
    user('100000010', '7000', '1'),
    // a plain customer with no invoices
    user('100000011', '12345', '1'),
  ];

  const invoices: SyntheticRow[] = [
    // ELIGIBLE on mapped panel A, productless 30 GB / 30 d
    invoice({ idUser: '100000001', username: 'svc_a1', codePanel: C.mappedA }),
    // PROVIDER_MISSING on a mapped panel (a 4-hex key, the older MirzaBot shape)
    invoice({ id: '7c1f', idUser: '100000001', username: 'svc_missing', codePanel: C.mappedA }),
    // NULL code_panel, exactly one holder (B): ELIGIBLE (a key with the 7-digit prefix)
    invoice({
      id: '1700001b2c3d4e5',
      idUser: '100000002',
      username: 'svc_nullmatch',
      codePanel: null,
    }),
    // NULL code_panel, two holders: AMBIGUOUS_PANEL
    invoice({ idUser: '100000003', username: 'svc_shared', codePanel: null }),
    // empty code_panel, no holder: PROVIDER_MISSING
    invoice({ idUser: '100000003', username: 'svc_nowhere', codePanel: '' }),
    // a test panel: skipped whatever else holds
    invoice({ idUser: SYNTHETIC_EXISTING_CUSTOMER, username: 'whatever', codePanel: C.test }),
    // a code nobody mapped
    invoice({ idUser: SYNTHETIC_EXISTING_CUSTOMER, username: 'svc_a1', codePanel: C.unmapped }),
    // two spellings on panel A fold to the same name
    invoice({ idUser: '100000007', username: 'case_x', codePanel: C.mappedA }),
    // custom shape with no current tariff
    invoice({
      idUser: '100000009',
      username: 'svc_b1',
      codePanel: C.mappedB,
      isCustom: '1',
      volume: '15',
      serviceTime: '45',
    }),
    // an unknown time unit: unsupported shape
    invoice({ idUser: '100000009', username: 'svc_b2', codePanel: C.mappedB, timeUnit: 'month' }),
    // nobody owns it
    invoice({ idUser: '999999999', username: 'svc_a1', codePanel: C.mappedA }),
    // its owner went to manual review
    invoice({ idUser: '100000004', username: 'svc_a1', codePanel: C.mappedA }),
    // a live legacy trial: skipped, and trial evidence for user 2
    invoice({ idUser: '100000002', username: 'svc_test', codePanel: C.mappedA, isTest: '1' }),
    // is_test neither 0 nor 1
    invoice({ idUser: '100000001', username: 'svc_a1', codePanel: C.mappedA, isTest: 'x' }),
    // a named legacy product: ELIGIBLE, product resolved by P6
    invoice({ idUser: '100000001', username: 'svc_a2', codePanel: C.mappedA, codeProduct: 'p1' }),
    // a code the operator declared missing: searched, one holder (A)
    invoice({ idUser: '100000001', username: 'svc_a3', codePanel: C.declaredMissing }),
    // zero volume: unsupported shape
    invoice({ idUser: '100000001', username: 'svc_a4', codePanel: C.mappedA, volume: '0' }),
    // an unusable username on a mapped panel
    invoice({ idUser: '100000001', username: '', codePanel: C.mappedA }),
    // a key outside the evidenced shape: it cannot be recorded, so it is manual review
    invoice({ id: 'LEGACY-X1', idUser: '100000001', username: 'svc_a1', codePanel: C.mappedA }),
    // not live: not a candidate at all
    invoice({ idUser: '100000003', username: 'svc_old', codePanel: C.mappedA, status: 'removed' }),
    // a removed TEST invoice: user 10 consumed a trial
    invoice({
      idUser: '100000010',
      username: 'svc_oldtest',
      codePanel: C.mappedA,
      status: 'removed',
      isTest: '1',
    }),
  ];

  const products: SyntheticRow[] = [
    {
      id: '1',
      code_product: 'p1',
      name_product: 'synthetic 30GB',
      price_product: '150000',
      Volume_constraint: '30',
      Service_time: '30',
      agent: 'f',
    },
    {
      id: '2',
      code_product: 'p2',
      name_product: 'synthetic agent plan',
      price_product: '120000',
      Volume_constraint: '50',
      Service_time: '30',
      agent: 'n',
    },
  ];

  const extra = options.extraUsers ?? 0;
  for (let i = 0; i < extra; i += 1) {
    users.push(user(String(200_000_000 + i), String(((i * 7919) % 100_000) + 1), '1'));
  }

  const schema = (['user', 'invoice', 'product'] as const).flatMap((table) =>
    SYNTHETIC_SCHEMA[table].map((c, index) => ({
      table,
      column: c.name,
      dataType: c.dataType,
      ordinal: index + 1,
    })),
  );
  return {
    synthetic: true,
    label: SYNTHETIC_LABEL,
    schema,
    tables: { user: users, invoice: invoices, product: products },
  };
}

function sqlLiteral(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "''")}'`;
}

/** MariaDB DDL + INSERTs for the dataset, into the CURRENT database. */
export function syntheticLegacySql(dataset: SyntheticLegacyDataset): string {
  const out: string[] = [
    `-- ${dataset.label}`,
    '-- Generated by tests/fixtures/legacy/synthetic-legacy.ts. NOT EVIDENCE.',
  ];
  for (const table of ['user', 'invoice', 'product'] as const) {
    out.push(`DROP TABLE IF EXISTS \`${table}\`;`);
    out.push(
      `CREATE TABLE \`${table}\` (\n  ${SYNTHETIC_SCHEMA[table]
        .map((c) => `\`${c.name}\` ${c.ddl}`)
        .join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`,
    );
    const columns = SYNTHETIC_SCHEMA[table].map((c) => c.name);
    for (const row of dataset.tables[table]) {
      out.push(
        `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns
          .map((c) => sqlLiteral(row[c] ?? null))
          .join(', ')});`,
      );
    }
  }
  // The marker every synthetic load carries: the importer reads it, forces the evidence
  // class to `synthetic` and refuses a production-like target (`importer.md` §Evidence class).
  out.push('DROP TABLE IF EXISTS `nexa_synthetic_fixture`;');
  out.push(
    'CREATE TABLE `nexa_synthetic_fixture` (`label` varchar(200) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;',
  );
  out.push(
    `INSERT INTO \`nexa_synthetic_fixture\` (\`label\`) VALUES (${sqlLiteral(dataset.label)});`,
  );
  return `${out.join('\n')}\n`;
}
