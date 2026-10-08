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

/**
 * Mirza migration PR2 — the legacy product review's view of the `product` table: the public
 * columns the default dataset leaves out (`Location`, `Category`) and three the public
 * `mirza_pro` fork adds (`note`, `one_buy_status`, `hide_panel`), so the `products` read
 * set has optional columns to read and a review has "status" cells to keep verbatim.
 *
 * Used ONLY by `buildSyntheticLegacyDataset({ productReview })`. The default dataset keeps
 * its product table exactly as it was, because every column of `product` — read or not —
 * is an input of the v1 schema hash, and the SYNTHETIC v1 fingerprint is pinned literally
 * (`tests/unit/legacy-import-read-set-v1.test.ts`). The review variant is a different
 * synthetic source with its own v1 fingerprint, which is the point: the v1 fingerprint of a
 * source is unchanged by READING its products, never by changing them.
 */
export const SYNTHETIC_PRODUCT_REVIEW_COLUMNS: readonly SyntheticColumn[] = [
  ...SYNTHETIC_SCHEMA.product,
  { name: 'Location', ddl: 'varchar(1000) NULL', dataType: 'varchar' },
  { name: 'Category', ddl: 'varchar(600) NULL', dataType: 'varchar' },
  { name: 'note', ddl: 'text NULL', dataType: 'text' },
  { name: 'one_buy_status', ddl: 'varchar(20) NULL', dataType: 'varchar' },
  { name: 'hide_panel', ddl: 'text NULL', dataType: 'text' },
];

/**
 * The review variant's product rows, one per branch the review must keep apart. Snapshot
 * `A` is the first read; `B` is a NEWER snapshot of the same source: `p1`'s price changed,
 * `p5` is gone and `p20` is new — everything else is byte-identical. `C` is newer still: as
 * `B`, with `p20`'s price changed — `p5` is STILL gone (a code absent from two reads in a row).
 */
function productReviewRows(snapshot: 'A' | 'B' | 'C'): SyntheticRow[] {
  const product = (
    id: string,
    code: string | null,
    name: string | null,
    price: string | null,
    volume: string | null,
    days: string | null,
    extra: Partial<
      Record<
        'agent' | 'Location' | 'Category' | 'note' | 'one_buy_status' | 'hide_panel',
        string | null
      >
    > = {},
  ): SyntheticRow => ({
    id,
    code_product: code,
    name_product: name,
    price_product: price,
    Volume_constraint: volume,
    Service_time: days,
    agent: extra.agent ?? 'f',
    Location: extra.Location ?? 'rp1',
    Category: extra.Category ?? 'monthly',
    note: extra.note ?? '',
    one_buy_status: extra.one_buy_status ?? '0',
    hide_panel: extra.hide_panel ?? '{}',
  });
  const rows: SyntheticRow[] = [
    // regular, single location; the live invoice in the dataset names it
    product('1', 'p1', 'synthetic 30GB', snapshot === 'A' ? '150000' : '160000', '30', '30'),
    // a reseller (agent) product
    product('2', 'p2', 'synthetic agent plan', '120000', '50', '30', { agent: 'n' }),
    // the SAME duration and volume as p1, a different product: never collapsed into p1
    product('3', 'p3', 'synthetic 30GB twin', '175000', '30', '30'),
    // labelled unlimited, volume 0: ZERO_MEANING_UNKNOWN, never "unlimited"
    product('4', 'p4', 'نامحدود ۳۰ روزه', '300000', '0', '30'),
    // a gift volume at price 0 (gone in snapshot B)
    product('5', 'p5', 'هدیه ۵ گیگ', '0', '5', '7'),
    // disabled: hidden on every panel (the fork's hide_panel), kept verbatim
    product('6', 'p6', 'disabled plan', '90000', '20', '30', {
      hide_panel: '{"rp1":"rp1","rp2":"rp2"}',
    }),
    // a test product, one purchase only
    product('7', 'p7', 'تست', '0', '1', '1', { note: 'test product', one_buy_status: '1' }),
    // multi-location, second reseller tier
    product('8', 'p8', 'multi location', '200000', '40', '60', {
      agent: 'n2',
      Location: 'rp1,rp2',
    }),
    // a price in Persian digits: NOT_A_NUMBER, kept raw
    product('9', 'p9', 'persian price', '۱۵۰۰۰۰', '30', '30'),
    // one code on two rows: CODE_DUPLICATED, nothing parsed
    product('10', 'dup', 'dup one', '100', '10', '10'),
    product('11', 'dup', 'dup two', '200', '10', '10'),
    // no code: not reviewable
    product('12', '', 'no code', '1000', '10', '10'),
    // a padded code: reviewed as `p13`; a decimal volume
    product('13', ' p13 ', 'padded code', '50000', '10.5', '15'),
    product('14', null, 'null code', '1000', '10', '10'),
  ];
  if (snapshot !== 'A') {
    rows.push(product('20', 'p20', 'new plan', snapshot === 'B' ? '250000' : '260000', '60', '30'));
    return rows.filter((row) => row['code_product'] !== 'p5');
  }
  return rows;
}

/**
 * Mirza migration PR3 — the invoice ARCHIVE variant of the `invoice` table: the default
 * columns plus every column the public `mirza_pro` fork adds (`db/tables/invoice.php`),
 * INCLUDING the three the `invoice-archive` read set must never read — `user_info` (a
 * subscription link), `uuid` (an account UUID) and `bottype` (a sub-bot's token). Their
 * synthetic values are recognisable markers, so a test can prove no byte of them reaches
 * PostgreSQL, a report or an audit row.
 *
 * Used ONLY by `buildSyntheticLegacyDataset({ invoiceArchive })`. The default dataset keeps
 * its invoice table exactly as it was: every `invoice` column is an input of the v1 schema
 * hash, and the SYNTHETIC v1 fingerprint is pinned literally.
 */
export const SYNTHETIC_INVOICE_ARCHIVE_COLUMNS: readonly SyntheticColumn[] = [
  ...SYNTHETIC_SCHEMA.invoice,
  { name: 'user_info', ddl: 'text NULL', dataType: 'text' },
  { name: 'uuid', ddl: 'text NULL', dataType: 'text' },
  { name: 'note', ddl: 'varchar(500) NULL', dataType: 'varchar' },
  { name: 'bottype', ddl: 'varchar(200) NULL', dataType: 'varchar' },
  { name: 'refral', ddl: 'varchar(100) NULL', dataType: 'varchar' },
  { name: 'time_cron', ddl: 'varchar(100) NULL', dataType: 'varchar' },
  { name: 'notifctions', ddl: 'text NULL', dataType: 'text' },
];

/** Markers the archive variant puts in the columns the archive must never read. */
export const SYNTHETIC_ARCHIVE_SECRETS = {
  userInfo: 'https://sub.synthetic.invalid/SECRET-SUBSCRIPTION-LINK',
  uuid: '00000000-5ec2-4e70-0000-5ec2e7000000',
  bottype: '123456789:SYNTHETIC-SECRET-BOT-TOKEN',
} as const;

/**
 * The archive variant's extra invoices, one per branch the archive must keep apart. Each
 * names its own id, so the default invoices keep theirs. Snapshot `B` is a NEWER snapshot:
 * `ab000001` changed status, `ab000002` is gone, `ab000099` is new, and user `999999998`
 * (the owner of orphan `ab000003`) now exists — everything else is byte-identical.
 */
function invoiceArchiveRows(snapshot: 'A' | 'B'): SyntheticRow[] {
  const C = SYNTHETIC_PANEL_CODES;
  const archived = (
    id: string,
    fields: Partial<Record<string, string | null>> = {},
  ): SyntheticRow => ({
    id_invoice: id,
    id_user: '100000001',
    username: 'svc_archive',
    Service_location: 'synthetic panel',
    time_sell: '1700000000',
    name_product: 'synthetic',
    price_product: '150000',
    Volume: '30',
    Service_time: '30',
    Status: 'active',
    code_panel: C.mappedA,
    code_product: null,
    is_test: '0',
    is_custom: '0',
    time_unit: '',
    user_info: SYNTHETIC_ARCHIVE_SECRETS.userInfo,
    uuid: SYNTHETIC_ARCHIVE_SECRETS.uuid,
    note: 'my config',
    bottype: SYNTHETIC_ARCHIVE_SECRETS.bottype,
    refral: '100000002',
    time_cron: null,
    notifctions: '{"volume":false,"time":false}',
    ...fields,
  });
  const rows: SyntheticRow[] = [
    // changes status in snapshot B: one ROW_CHANGED revision
    archived('ab000001', { Status: snapshot === 'A' ? 'active' : 'disabled' }),
    // gone in snapshot B: kept, counted missing
    archived('ab000002', { Status: 'end_of_time' }),
    // an orphan whose owner appears in snapshot B: CONTEXT_CHANGED
    archived('ab000003', { id_user: '999999998' }),
    // more orphans: no id_user, an empty one
    archived('ab000004', { id_user: null }),
    archived('ab000005', { id_user: '' }),
    // a code the legacy product table does not have; a named one
    archived('ab000006', { code_product: 'p404' }),
    archived('ab000007', { code_product: ' p1 ' }),
    // a panel code nobody mapped (the importer's PANEL_UNMAPPED is PR5's)
    archived('ab000008', { code_panel: C.unmapped }),
    // empty and blank panel codes: NO_PANEL (owner decision 8)
    archived('ab000009', { code_panel: '' }),
    archived('ab00000a', { code_panel: '   ' }),
    // a removed legacy trial: TEST; an expired service: NOT_LIVE
    archived('ab00000b', { is_test: '1', Status: 'removed' }),
    archived('ab00000c', { Status: 'end_of_time' }),
    // odd key shapes, archived all the same
    archived('INV/2024/001'),
    archived('ABCD'),
    archived('فاکتور-۱'),
    archived(' padded '),
    archived('0000'),
    // timestamps: no zone, Jalali digits, empty, milliseconds
    archived('ab00000d', { time_sell: '2024-01-02 03:04:05' }),
    archived('ab00000e', { time_sell: '14030101' }),
    archived('ab00000f', { time_sell: '' }),
    archived('ab000010', { time_sell: '1700000000000' }),
    // prices: grouped, Persian digits, negative, empty
    archived('ab000011', { price_product: '150,000' }),
    archived('ab000012', { price_product: '۱۵۰۰۰۰' }),
    archived('ab000013', { price_product: '-5' }),
    archived('ab000014', { price_product: null }),
  ];
  if (snapshot === 'B') {
    rows.push(archived('ab000099', { Status: 'active' }));
    return rows.filter((row) => row['id_invoice'] !== 'ab000002');
  }
  return rows;
}

/**
 * Tables beside the three the importer reads, so the table INVENTORY has more than the
 * import read set to see (Mirza migration PR1):
 *
 * - `nexa_synthetic_fixture` — the marker every synthetic load carries (its single-line
 *   DDL is written by `syntheticLegacySql` below, unchanged); described here so the
 *   fixture source reports its columns like an engine does;
 * - `nexa_synthetic_unclassified` — a table NO catalogue entry names, standing in for every
 *   Mirza table nobody has classified yet. Its presence makes the synthetic inventory's
 *   verdict `UNCLASSIFIED_TABLES`, which is the fail-closed path the CI matrix proves on
 *   both engines. It holds no value of any meaning.
 *
 * Neither is part of the v1 import read set, so neither changes the v1 fingerprint
 * (`tests/unit/legacy-import-read-set-v1.test.ts` pins it).
 */
export const SYNTHETIC_MARKER_COLUMNS: readonly SyntheticColumn[] = [
  { name: 'label', ddl: 'varchar(200) NOT NULL', dataType: 'varchar' },
];
export const SYNTHETIC_UNCLASSIFIED_TABLE = 'nexa_synthetic_unclassified';
export const SYNTHETIC_UNCLASSIFIED_COLUMNS: readonly SyntheticColumn[] = [
  { name: 'id', ddl: 'int(10) unsigned NOT NULL PRIMARY KEY', dataType: 'int' },
  { name: 'note', ddl: 'varchar(200) NULL', dataType: 'varchar' },
];
/** What `syntheticLegacySql` declares for every table. */
export const SYNTHETIC_TABLE_OPTIONS = {
  storageEngine: 'InnoDB',
  tableCharset: 'utf8mb4',
  tableCollation: 'utf8mb4_bin',
} as const;

export type SyntheticRow = Readonly<Record<string, string | null>>;

export interface SyntheticLegacyDataset {
  readonly synthetic: true;
  readonly label: string;
  readonly storageEngine: string;
  readonly tableCharset: string;
  readonly tableCollation: string;
  readonly schema: readonly {
    readonly table: string;
    readonly column: string;
    readonly dataType: string;
    readonly ordinal: number;
  }[];
  readonly tables: Readonly<
    Record<
      'user' | 'invoice' | 'product' | 'nexa_synthetic_fixture' | 'nexa_synthetic_unclassified',
      readonly SyntheticRow[]
    >
  >;
  /** The review variant's product columns (PR2); absent on the default dataset. */
  readonly productColumns?: readonly SyntheticColumn[];
  /** The archive variant's invoice columns (PR3); absent on the default dataset. */
  readonly invoiceColumns?: readonly SyntheticColumn[];
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
    /**
     * Mirza PR4 (owner decision 6): only the positive balances become ledger openings; the
     * one negative balance is a legacy debt of its magnitude, beside the ledger.
     */
    positiveBalanceSumMinor: 50_000n + 30_000n + 1_000n + 7_000n + 12_345n,
    debtSumMinor: 20_000n,
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
      /**
       * Mirza PR5 (owner decision 8): the three empty/NULL `code_panel` invoices. Before PR5
       * they were searched across every production panel — one ELIGIBLE, one
       * AMBIGUOUS_PANEL, one PROVIDER_MISSING. Changed deliberately; the dataset is not.
       */
      NO_PANEL: 3,
      PROVIDER_MISSING: 1,
      AMBIGUOUS_PANEL: 0,
      PANEL_UNMAPPED: 1,
      USERNAME_CASE_COLLISION: 1,
      AMBIGUOUS_OWNERSHIP: 0,
      UNSUPPORTED_SHAPE: 2,
      PRODUCT_UNRESOLVED: 1,
      ADOPTION_ELIGIBLE: 3,
    },
  },
} as const;

/**
 * Builds the dataset. `extraUsers` appends that many plain users (positive balances,
 * `limit_usertest = 1`, no invoices) for volume rehearsals; they do not change the
 * branch coverage above and are excluded from `SYNTHETIC_EXPECTED`.
 */
export function buildSyntheticLegacyDataset(
  options: {
    extraUsers?: number;
    /** Mirza PR2: the product review variant, as snapshot A or the newer snapshots B and C. */
    productReview?: 'A' | 'B' | 'C';
    /** Mirza PR3: the invoice archive variant, as snapshot A or the newer snapshot B. */
    invoiceArchive?: 'A' | 'B';
    /** Mirza PR3: that many more plain archived invoices (volume rehearsals of the archive). */
    extraInvoices?: number;
  } = {},
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
    // NULL code_panel, exactly one holder (B). Before Mirza PR5 this was searched and ELIGIBLE;
    // owner decision 8: NO_PANEL, never adopted automatically (a key with the 7-digit prefix)
    invoice({
      id: '1700001b2c3d4e5',
      idUser: '100000002',
      username: 'svc_nullmatch',
      codePanel: null,
    }),
    // NULL code_panel, two holders: was AMBIGUOUS_PANEL; NO_PANEL since owner decision 8
    invoice({ idUser: '100000003', username: 'svc_shared', codePanel: null }),
    // empty code_panel, no holder: was PROVIDER_MISSING; NO_PANEL since owner decision 8
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

  const products: SyntheticRow[] =
    options.productReview !== undefined
      ? productReviewRows(options.productReview)
      : [
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

  if (options.invoiceArchive !== undefined) {
    // Every default invoice gains the fork's columns (the secrets among them), as a real
    // fork's table would hold them for every row.
    for (let i = 0; i < invoices.length; i += 1) {
      invoices[i] = {
        user_info: SYNTHETIC_ARCHIVE_SECRETS.userInfo,
        uuid: SYNTHETIC_ARCHIVE_SECRETS.uuid,
        note: null,
        bottype: SYNTHETIC_ARCHIVE_SECRETS.bottype,
        refral: null,
        time_cron: null,
        notifctions: '{"volume":false,"time":false}',
        ...(invoices[i] as SyntheticRow),
      };
    }
    invoices.push(...invoiceArchiveRows(options.invoiceArchive));
    if (options.invoiceArchive === 'B') users.push(user('999999998', '0', '1'));
    for (let i = 0; i < (options.extraInvoices ?? 0); i += 1) {
      invoices.push({
        id_invoice: (0xc0000000 + i).toString(16),
        id_user: '100000001',
        username: `svc_bulk_${String(i)}`,
        Service_location: 'synthetic panel',
        time_sell: String(1_700_000_000 + i),
        name_product: 'synthetic',
        price_product: '150000',
        Volume: '30',
        Service_time: '30',
        Status: i % 3 === 0 ? 'removed' : 'active',
        code_panel: SYNTHETIC_PANEL_CODES.mappedA,
        code_product: i % 2 === 0 ? 'p1' : null,
        is_test: '0',
        is_custom: '0',
        time_unit: '',
        user_info: SYNTHETIC_ARCHIVE_SECRETS.userInfo,
        uuid: SYNTHETIC_ARCHIVE_SECRETS.uuid,
        note: null,
        bottype: SYNTHETIC_ARCHIVE_SECRETS.bottype,
        refral: null,
        time_cron: null,
        notifctions: '{"volume":false,"time":false}',
      });
    }
  }

  const extra = options.extraUsers ?? 0;
  for (let i = 0; i < extra; i += 1) {
    users.push(user(String(200_000_000 + i), String(((i * 7919) % 100_000) + 1), '1'));
  }

  const described: readonly (readonly [string, readonly SyntheticColumn[]])[] = [
    ['user', SYNTHETIC_SCHEMA.user],
    [
      'invoice',
      options.invoiceArchive === undefined
        ? SYNTHETIC_SCHEMA.invoice
        : SYNTHETIC_INVOICE_ARCHIVE_COLUMNS,
    ],
    [
      'product',
      options.productReview === undefined
        ? SYNTHETIC_SCHEMA.product
        : SYNTHETIC_PRODUCT_REVIEW_COLUMNS,
    ],
    [SYNTHETIC_UNCLASSIFIED_TABLE, SYNTHETIC_UNCLASSIFIED_COLUMNS],
    ['nexa_synthetic_fixture', SYNTHETIC_MARKER_COLUMNS],
  ];
  const schema = described.flatMap(([table, columns]) =>
    columns.map((c, index) => ({
      table,
      column: c.name,
      dataType: c.dataType,
      ordinal: index + 1,
    })),
  );
  return {
    synthetic: true,
    label: SYNTHETIC_LABEL,
    ...SYNTHETIC_TABLE_OPTIONS,
    schema,
    tables: {
      user: users,
      invoice: invoices,
      product: products,
      nexa_synthetic_unclassified: [
        { id: '1', note: 'synthetic' },
        { id: '2', note: null },
        { id: '10', note: 'synthetic' },
      ],
      nexa_synthetic_fixture: [{ label: SYNTHETIC_LABEL }],
    },
    ...(options.productReview === undefined
      ? {}
      : { productColumns: SYNTHETIC_PRODUCT_REVIEW_COLUMNS }),
    ...(options.invoiceArchive === undefined
      ? {}
      : { invoiceColumns: SYNTHETIC_INVOICE_ARCHIVE_COLUMNS }),
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
    const described =
      table === 'product'
        ? (dataset.productColumns ?? SYNTHETIC_SCHEMA.product)
        : table === 'invoice'
          ? (dataset.invoiceColumns ?? SYNTHETIC_SCHEMA.invoice)
          : SYNTHETIC_SCHEMA[table];
    out.push(`DROP TABLE IF EXISTS \`${table}\`;`);
    out.push(
      `CREATE TABLE \`${table}\` (\n  ${described
        .map((c) => `\`${c.name}\` ${c.ddl}`)
        .join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`,
    );
    const columns = described.map((c) => c.name);
    for (const row of dataset.tables[table]) {
      out.push(
        `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns
          .map((c) => sqlLiteral(row[c] ?? null))
          .join(', ')});`,
      );
    }
  }
  // A table no catalogue entry names: the inventory must report it UNCLASSIFIED.
  out.push(`DROP TABLE IF EXISTS \`${SYNTHETIC_UNCLASSIFIED_TABLE}\`;`);
  out.push(
    `CREATE TABLE \`${SYNTHETIC_UNCLASSIFIED_TABLE}\` (\n  ${SYNTHETIC_UNCLASSIFIED_COLUMNS.map(
      (c) => `\`${c.name}\` ${c.ddl}`,
    ).join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;`,
  );
  for (const row of dataset.tables[SYNTHETIC_UNCLASSIFIED_TABLE]) {
    const columns = SYNTHETIC_UNCLASSIFIED_COLUMNS.map((c) => c.name);
    out.push(
      `INSERT INTO \`${SYNTHETIC_UNCLASSIFIED_TABLE}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns
        .map((c) => sqlLiteral(row[c] ?? null))
        .join(', ')});`,
    );
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
