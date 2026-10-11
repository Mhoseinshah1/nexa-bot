import { createHash, randomBytes } from 'node:crypto';
import { copyFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import {
  EMPTY_PRODUCT_DISPLAY,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  money,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type {
  ApplyPhase,
  LegacyImporterService,
} from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import type { LegacyFixtureDataset } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import type {
  BackupPort,
  HistoryIngestPort,
  MigrationRunner,
} from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { SYNTHETIC_SCHEMA, SYNTHETIC_TABLE_OPTIONS } from '../fixtures/legacy/synthetic-legacy';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from '../integration/harness';
import { startFakeRickpanel, type FakeRickpanel } from './fake-rickpanel';
import { canonicalJson } from '../../apps/api/src/infrastructure/nxpkg/canonical-json';
import { deriveDecisionsKey } from '../../apps/api/src/infrastructure/nxpkg/decisions';
import {
  newRawKey,
  signDecisionsExport,
  writeNxpkg,
  type FileSource,
  type WriteNxpkgOptions,
} from './nxpkg/writer';
import {
  READY_MANIFEST,
  snapshotOfDataset,
  snapshotPackageFiles,
  type SnapshotParts,
} from './nxpkg-legacy-package';

/**
 * TEST-ONLY — a rig for driving the Mirza `.nxpkg` Fresh Migration through the operator's
 * service and the `migration` role's executor against PostgreSQL and fake RickPanels, at any
 * size. Shared by the `legacy-migration-*` integration files and the opt-in scale test
 * (`tests/perf/`). SYNTHETIC data only; nothing here is evidence about a real Mirza backup.
 *
 * The dataset generator is deliberately free of edge cases (every Telegram id valid, every
 * balance an integer within bounds, every live invoice a plain productless 30 GB / 30 d
 * shape on a mapped RickPanel whose account exists), so a test can recompute every expected
 * total from the package's own snapshot cells without the importer's code.
 */

export const TENANT = SEED_IDS.tenantA as unknown as string;
export const PANEL_CODES = ['rp1', 'rp2'] as const;
export type PanelCode = (typeof PANEL_CODES)[number];

type Row = Record<string, string | null>;
type Rec = Record<string, unknown>;

export interface GeneratedInvoice {
  readonly id: string;
  readonly idUser: string;
  readonly username: string;
  readonly codePanel: PanelCode;
  readonly live: boolean;
}

export interface GeneratedDataset {
  readonly dataset: LegacyFixtureDataset;
  readonly users: readonly Row[];
  readonly invoices: readonly GeneratedInvoice[];
  /** The panel accounts the live invoices name, per legacy panel code. */
  readonly liveAccounts: Readonly<Record<PanelCode, readonly string[]>>;
}

/** Telegram id of generated user `i`. */
export const userId = (i: number): string => String(300_000_000 + i);
/** Invoice key of generated invoice `j` (the evidenced 8-hex shape). */
export const invoiceId = (j: number): string => (0xd0000000 + j).toString(16);

/**
 * `users` users and `invoices` invoices. Balances: every 10th user from 3 a debt, from 7 a
 * zero, the rest positive. Invoices: `liveEvery` of every 5 live ('active'), the rest
 * 'removed'; owner `(13·j) mod users`; panel alternating rp1 / rp2; username `svc_<j>`.
 */
export function generateDataset(options: {
  readonly users: number;
  readonly invoices: number;
  readonly liveEvery?: number;
}): GeneratedDataset {
  const liveOfFive = options.liveEvery ?? 2;
  const users: Row[] = [];
  for (let i = 0; i < options.users; i += 1) {
    const balance =
      i % 10 === 3
        ? `-${String(((i * 31) % 50_000) + 1)}`
        : i % 10 === 7
          ? '0'
          : String(((i * 7919) % 100_000) + 1);
    users.push({
      id: userId(i),
      limit_usertest: '1',
      Balance: balance,
      number: 'none',
      User_Status: 'Active',
      agent: 'f',
      affiliates: '0',
      username: 'none',
    });
  }
  const invoices: GeneratedInvoice[] = [];
  const rows: Row[] = [];
  const liveAccounts: Record<PanelCode, string[]> = { rp1: [], rp2: [] };
  for (let j = 0; j < options.invoices; j += 1) {
    const live = j % 5 < liveOfFive;
    const codePanel: PanelCode = j % 2 === 0 ? 'rp1' : 'rp2';
    const inv: GeneratedInvoice = {
      id: invoiceId(j),
      idUser: userId((j * 13) % options.users),
      username: `svc_${String(j)}`,
      codePanel,
      live,
    };
    invoices.push(inv);
    if (live) liveAccounts[codePanel].push(inv.username);
    rows.push({
      id_invoice: inv.id,
      id_user: inv.idUser,
      username: inv.username,
      Service_location: 'synthetic',
      time_sell: String(1_700_000_000 + j),
      name_product: 'synthetic',
      price_product: '150000',
      Volume: '30',
      Service_time: '30',
      Status: live ? 'active' : 'removed',
      code_panel: codePanel,
      code_product: null,
      is_test: '0',
      is_custom: '0',
      time_unit: '',
    });
  }
  const label = 'SYNTHETIC migration rig dataset (not evidence)';
  const described: readonly (readonly [string, readonly { name: string; dataType: string }[]])[] = [
    ['user', SYNTHETIC_SCHEMA.user],
    ['invoice', SYNTHETIC_SCHEMA.invoice],
    ['product', SYNTHETIC_SCHEMA.product],
    ['nexa_synthetic_fixture', [{ name: 'label', dataType: 'varchar' }]],
  ];
  const dataset = {
    synthetic: true as const,
    label,
    ...SYNTHETIC_TABLE_OPTIONS,
    schema: described.flatMap(([table, columns]) =>
      columns.map((c, index) => ({
        table,
        column: c.name,
        dataType: c.dataType,
        ordinal: index + 1,
      })),
    ),
    tables: {
      user: users,
      invoice: rows,
      product: [
        {
          id: '1',
          code_product: 'p1',
          name_product: 'synthetic 30GB',
          price_product: '150000',
          Volume_constraint: '30',
          Service_time: '30',
          agent: 'f',
        },
      ],
      nexa_synthetic_fixture: [{ label }],
    },
  } as unknown as LegacyFixtureDataset;
  return { dataset, users, invoices, liveAccounts };
}

// --- records --------------------------------------------------------------------------------

export const ownershipRecord = (
  invoice: { readonly id: string; readonly idUser: string | null },
  decision = 'CONFIRMED_CURRENT_OWNER',
  finalOwner: string | null = invoice.idUser,
): Rec => ({
  record_type: 'legacy_service_ownership',
  schema: 'mirza.service_ownership.v1',
  idempotency_key: `legacy:service-ownership:${invoice.id}`,
  invoice_key: invoice.id,
  ownership_decision: decision,
  final_owner_telegram_user_id: finalOwner,
  provision: false,
  applies_to_live_state: false,
  affects_wallet: false,
  creates_payment: false,
});

export const panelTargetRecord = (
  code: string,
  selected: boolean,
  providerType = 'rickpanel',
): Rec => ({
  record_type: 'legacy_panel_target',
  schema: 'm2n.legacy_panel_target.v1',
  idempotency_key: `legacy:panel-target:${code}`,
  code_panel: code,
  target: selected
    ? {
        provider_type: providerType,
        provider_display_name: providerType === 'rickpanel' ? 'RickPanel' : providerType,
        provider_version_declared: '1.0.0',
        nexa_panel_id: null,
        binding: 'CREATE_IN_NEXA_THEN_CONNECT',
        decided_by: 'operator',
        evidence: [],
      }
    : null,
  mapping_state: selected ? 'TARGET_SELECTED' : 'OPERATOR_MUST_MAP',
  nexa_panel_map_entry: null,
  credentials_in_package: false,
  services_reprovisioned: false,
  provision: false,
  applies_to_live_state: false,
});

/** One synthetic payment history record per `every`-th user (archive only, never money). */
export function* paymentRecords(users: readonly Row[], every = 2): Generator<Rec> {
  for (let i = 0; i < users.length; i += every) {
    const tg = users[i]?.['id'] ?? null;
    yield {
      record_type: 'legacy_payment_history',
      schema: 'mirza.payment_report.v1',
      idempotency_key: `legacy:payment:${String(i)}`,
      customer: { telegram_user_id: tg, source_user_id: tg, relation: 'CUSTOMER_IMPORTED' },
      amount: { amount_minor: String(1000 + i), currency: 'IRT', raw: String(1000 + i) },
      status: { outcome: 'SUCCEEDED', raw: 'paid' },
      method: { normalized: 'CARD_TO_CARD', raw: 'cart to cart' },
      times: { created: { local: '2025-01-01T08:02:17', unix: 1_735_700_000 + i } },
      provenance: { source_table: 'Payment_report', source_pk: String(i) },
      affects_wallet: false,
      applies_to_live_state: false,
      creates_payment: false,
      counts_as_revenue: false,
    };
  }
}

/** Counts `records` while yielding them, so a caller knows how many lines it packaged. */
export function counted<T>(records: Iterable<T>, into: { n: number }): Iterable<T> {
  return {
    *[Symbol.iterator]() {
      for (const r of records) {
        into.n += 1;
        yield r;
      }
    },
  };
}

export interface MigrationPackage {
  readonly path: string;
  readonly keyFileText: string;
  readonly rawKey: Buffer;
  readonly parts: SnapshotParts;
  /** Lines in every `records/*` history file the package carries (what the archive must hold). */
  readonly historyLines: number;
  readonly headerSha256: string;
  readonly manifest: Record<string, unknown>;
  /** The ownership records exactly as packaged (what a decisions entry binds to). */
  readonly ownershipRecords: readonly Rec[];
}

/**
 * Writes a 1.4.0 package: the snapshot of `dataset`, the two selected RickPanel targets (plus
 * one unselected), one ownership record per live invoice (`ownership` overrides by invoice
 * key; `null` drops the record), and `history` files.
 */
export async function writeMigrationPackage(
  path: string,
  input: {
    readonly dataset: LegacyFixtureDataset;
    readonly invoices: readonly GeneratedInvoice[];
    readonly ownership?: Readonly<Record<string, Rec | null>>;
    readonly history?: Readonly<Record<string, Iterable<Rec>>>;
    readonly targetProviderType?: string;
    readonly manifest?: Record<string, unknown>;
    readonly secret?: WriteNxpkgOptions['secret'];
    readonly writer?: Partial<WriteNxpkgOptions>;
  },
): Promise<MigrationPackage> {
  const parts = snapshotOfDataset(input.dataset);
  const tally = { n: 0 };
  const overrides = input.ownership ?? {};
  const ownershipRecords: Rec[] = [];
  function* ownership(): Generator<Rec> {
    for (const record of ownershipOf()) {
      ownershipRecords.push(record);
      yield record;
    }
  }
  function* ownershipOf(): Generator<Rec> {
    for (const inv of input.invoices) {
      if (!inv.live) continue;
      if (Object.hasOwn(overrides, inv.id)) {
        const over = overrides[inv.id];
        if (over !== null && over !== undefined) yield over;
        continue;
      }
      yield ownershipRecord(inv);
    }
  }
  const history: Record<string, FileSource> = {};
  for (const [file, records] of Object.entries(input.history ?? {})) {
    history[file] = { records: counted(records, tally) };
  }
  const key = newRawKey();
  const written = await writeNxpkg(path, {
    files: snapshotPackageFiles(parts, {
      'records/panel_target_mapping.jsonl': {
        records: counted(
          [
            panelTargetRecord('rp1', true, input.targetProviderType),
            panelTargetRecord('rp2', true, input.targetProviderType),
            panelTargetRecord('zzz', false),
          ],
          tally,
        ),
      },
      'records/service_ownership.jsonl': { records: counted(ownership(), tally) },
      ...history,
    }),
    secret: input.secret ?? { rawKey: key.rawKey },
    manifest: {
      ...READY_MANIFEST,
      import_id: randomBytes(16).toString('hex'),
      ...(input.manifest ?? {}),
    },
    ...(input.writer ?? {}),
  });
  return {
    path: written.path,
    keyFileText: written.keyFileText ?? key.keyFileText,
    rawKey: key.rawKey,
    parts,
    historyLines: tally.n,
    headerSha256: written.headerSha256,
    manifest: written.manifest,
    ownershipRecords,
  };
}

/**
 * The money a package implies, recomputed from its OWN snapshot cells (`source/tables/
 * user.jsonl`), independently of the importer: a positive `Balance` is an opening credit, a
 * negative one a debt of its magnitude, a zero nothing. Only meaningful for the rig's edge-free
 * datasets (every id a Telegram id, every balance an integer within bounds).
 */
export function moneyOfSnapshot(parts: SnapshotParts): {
  readonly users: number;
  readonly positive: { readonly count: number; readonly sum: bigint; readonly ids: Set<string> };
  readonly negative: {
    readonly count: number;
    readonly sum: bigint;
    readonly byId: Map<string, bigint>;
  };
  readonly zero: number;
} {
  const [header, ...rows] = parts.tables.user;
  const columns = (header?.['columns'] ?? []) as string[];
  const idAt = columns.indexOf('id');
  const balanceAt = columns.indexOf('Balance');
  let positiveSum = 0n;
  let negativeSum = 0n;
  let zero = 0;
  const ids = new Set<string>();
  const byId = new Map<string, bigint>();
  for (const row of rows) {
    const cells = row['c'] as (string | null)[];
    const id = String(cells[idAt]);
    const raw = String(cells[balanceAt]);
    if (!/^-?[0-9]+$/u.test(raw)) throw new Error('the rig only generates integer balances');
    const value = BigInt(raw);
    if (value > 0n) {
      positiveSum += value;
      ids.add(id);
    } else if (value < 0n) {
      negativeSum += -value;
      byId.set(id, -value);
    } else zero += 1;
  }
  return {
    users: rows.length,
    positive: { count: ids.size, sum: positiveSum, ids },
    negative: { count: byId.size, sum: negativeSum, byId },
    zero,
  };
}

// --- the rig --------------------------------------------------------------------------------

export interface RigPanel {
  readonly fake: FakeRickpanel;
  readonly id: string;
}

export class MigrationRig {
  owner!: ActorContext;
  panels!: Record<PanelCode, RigPanel>;
  private keys = 0;

  constructor(
    readonly ctx: TestContext,
    readonly migrationRoot: string,
  ) {}

  key(): string {
    this.keys += 1;
    return `lmig-rig-${String(this.keys)}-${String(Date.now())}`;
  }

  /** An empty tenant with an owner and two ACTIVE RickPanels holding `accounts`. */
  async freshTenant(accounts: Readonly<Record<PanelCode, readonly string[]>>): Promise<void> {
    await this.closePanels();
    await this.ctx.reset();
    for (const entry of await readdir(this.migrationRoot)) {
      await rm(join(this.migrationRoot, entry), { recursive: true, force: true });
    }
    this.owner = adminActorFor(
      await createAdmin(this.ctx.container, tenantA, {
        username: 'owner-rig',
        roleKeys: ['owner'],
      }),
    );
    const make = async (code: PanelCode, host: string): Promise<RigPanel> => {
      const fake = await startFakeRickpanel({ host });
      for (const name of accounts[code]) {
        fake.seedUser(name, {
          expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
          dataLimit: 30 * 1024 ** 3,
          usedTraffic: 1024 ** 3,
        });
      }
      const created = await this.ctx.container.panels.create(tenantA, this.owner, {
        name: `Rick ${code}`,
        providerType: 'rickpanel',
        baseUrl: fake.baseUrl,
        credentials: { username: fake.username, password: fake.password },
        activation: {},
        idempotencyKey: `rig-panel-${code}`,
      });
      await validatePanelConnection(this.ctx.container, tenantA, created.view.panel.id);
      return { fake, id: created.view.panel.id };
    };
    this.panels = { rp1: await make('rp1', '127.0.0.2'), rp2: await make('rp2', '127.0.0.3') };
    // The current public tariff the packages' productless 30 GB / 30 d shapes resolve to (an
    // operator creates it before the migration; a product is not operational data, §6).
    const products = new DrizzleProductRepository(this.ctx.container.database.db);
    const now = this.ctx.container.clock.now();
    const product = await products.create(tenantA, {
      id: this.ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: this.panels.rp1.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * 1024n ** 3n, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', now);
  }

  async closePanels(): Promise<void> {
    if (this.panels === undefined) return;
    for (const panel of Object.values(this.panels)) await panel.fake.close();
  }

  get service() {
    return this.ctx.container.legacyMigration;
  }

  /** The operator's upload, as the controller does it: bytes into the service's own path. */
  async upload(path: string): Promise<string> {
    const pending = await this.service.beginUpload(tenantA, this.owner, {
      fileName: 'mirza.nxpkg',
    });
    await copyFile(path, pending.packagePath);
    const bytes = await readFile(path);
    const view = await this.service.completeUpload(tenantA, this.owner, pending, {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return view.id;
  }

  async uploadDecisions(id: string, body: Buffer): Promise<void> {
    const pending = await this.service.beginDecisionsUpload(tenantA, this.owner, id);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(pending.uploadPath, body, { mode: 0o600 });
    await this.service.completeDecisionsUpload(tenantA, this.owner, pending, {
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }

  detail(id: string) {
    return this.service.detail(tenantA, this.owner, id);
  }

  async row(id: string): Promise<Record<string, unknown> | undefined> {
    return (
      await this.ctx.container.database.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM legacy_nxpkg_imports WHERE id = ${id}`,
      )
    ).rows[0];
  }

  async setKey(id: string, secret: { keyFileText: string } | { passphrase: string }) {
    await this.service.setKey(tenantA, this.owner, id, { idempotencyKey: this.key(), ...secret });
  }

  async bind(id: string, bindings?: readonly { codePanel: string; panelId: string }[]) {
    await this.service.setPanelBindings(tenantA, this.owner, id, {
      idempotencyKey: this.key(),
      bindings: bindings ?? PANEL_CODES.map((c) => ({ codePanel: c, panelId: this.panels[c].id })),
    });
  }

  async requestDryRun(id: string) {
    await this.service.requestDryRun(tenantA, this.owner, id, { idempotencyKey: this.key() });
  }

  async approve(id: string) {
    const dry = await this.detail(id);
    await this.service.approve(tenantA, this.owner, id, {
      idempotencyKey: this.key(),
      dryRunSha256: dry.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
  }

  /** Upload, key, verify, bind, dry run, approve: the import waits in APPROVED. */
  async prepare(
    pkg: { readonly path: string; readonly keyFileText: string },
    executor: LegacyMigrationExecutor,
    options: {
      readonly decisions?: Buffer;
      readonly afterTick?: (id: string) => Promise<void>;
    } = {},
  ): Promise<string> {
    const id = await this.upload(pkg.path);
    if (options.decisions !== undefined) await this.uploadDecisions(id, options.decisions);
    await this.setKey(id, { keyFileText: pkg.keyFileText });
    await executor.tick();
    await options.afterTick?.(id);
    const verified = await this.detail(id);
    if (verified.status !== 'VERIFIED') {
      throw new Error(`verify: ${verified.status} ${String(verified.errorCode)}`);
    }
    await this.bind(id);
    await this.requestDryRun(id);
    await executor.tick();
    await options.afterTick?.(id);
    const dry = await this.detail(id);
    if (dry.status !== 'DRY_RUN_DONE') {
      throw new Error(`dry run: ${dry.status} ${String(dry.errorCode)}`);
    }
    await this.approve(id);
    return id;
  }

  async count(table: string, where = 'true'): Promise<number> {
    const result = await this.ctx.container.database.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${TENANT}' AND ${where}`),
    );
    return result.rows[0]?.n ?? 0;
  }

  async scalar(query: string): Promise<string | null> {
    const result = await this.ctx.container.database.db.execute<{ v: string | null }>(
      sql.raw(query),
    );
    return result.rows[0]?.v ?? null;
  }

  /** Every request a fake panel saw that is not a read or the token exchange. */
  providerWrites(): { method: string; path: string }[] {
    return Object.values(this.panels).flatMap((p) =>
      p.fake.requests
        .filter(
          (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
        )
        .map((r) => ({ method: r.method, path: r.path })),
    );
  }

  async stepDirectories(id: string): Promise<string[]> {
    try {
      return (await readdir(join(this.migrationRoot, id))).filter((n) => n.startsWith('step-'));
    } catch {
      return [];
    }
  }

  /**
   * The tenant's migrated state, keyed by LEGACY identity (never a generated id), so two runs
   * of one package into two fresh tenants compare equal exactly when they wrote the same
   * things: customers by Telegram id, openings by reference and amount, debts by legacy user,
   * services by panel account and owner, history by idempotency key, plus every count.
   */
  async migratedState(): Promise<Record<string, string | number | null>> {
    const t = `tenant_id = '${TENANT}'`;
    const digest = (expr: string, from: string, order: string) =>
      this.scalar(
        `SELECT md5(coalesce(string_agg(${expr}, '|' ORDER BY ${order}), '')) AS v FROM ${from}`,
      );
    return {
      customers: await this.count('customers'),
      customersDigest: await digest('telegram_user_id', `customers WHERE ${t}`, 'telegram_user_id'),
      walletEntries: await this.count('wallet_entries'),
      ledgerSum: await this.scalar(
        `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v FROM wallet_entries WHERE ${t}`,
      ),
      ledgerDigest: await digest(
        `reference || ':' || direction || ':' || reason || ':' || amount::text`,
        `wallet_entries WHERE ${t}`,
        'reference, direction, amount',
      ),
      debts: await this.count('legacy_wallet_debts'),
      debtDigest: await digest(
        `legacy_user_id || ':' || amount_minor::text || ':' || state`,
        `legacy_wallet_debts WHERE ${t}`,
        'legacy_user_id',
      ),
      services: await this.count('services'),
      servicesDigest: await digest(
        `s.provider_username || ':' || p.name || ':' || c.telegram_user_id || ':' || s.state`,
        `services s JOIN panels p ON p.id = s.panel_id JOIN customers c ON c.id = s.customer_id WHERE s.${t}`,
        's.provider_username, p.name',
      ),
      orders: await this.count('orders'),
      ordersNonLegacy: await this.count(
        'orders',
        "NOT (origin = 'LEGACY_ADOPTION' AND total_amount = 0 AND state = 'PAID')",
      ),
      payments: await this.count('payments'),
      provisioningOperations: await this.count('provisioning_operations'),
      history: await this.count('legacy_history_records'),
      historyDigest: await digest(
        `record_type || ':' || idempotency_key || ':' || coalesce(legacy_user_id, '-') || ':' || (customer_id IS NOT NULL)::text`,
        `legacy_history_records WHERE ${t}`,
        'idempotency_key',
      ),
      importMap: await this.count('legacy_import_map'),
      importMapDigest: await digest(
        `legacy_table || ':' || legacy_id || ':' || status || ':' || coalesce(reason_code, '-')`,
        `legacy_import_map WHERE ${t}`,
        'legacy_table, legacy_id',
      ),
      candidates: await this.count('legacy_service_candidates'),
      // ADOPTED and ALREADY_ADOPTED are one business fact here (the service exists, adopted
      // once): a resumed run reports the services its interrupted attempt adopted as
      // ALREADY_ADOPTED, which is a reporting difference, not a different state.
      candidatesDigest: await digest(
        `invoice_key || ':' || CASE outcome WHEN 'ALREADY_ADOPTED' THEN 'ADOPTED' ELSE outcome END`,
        `legacy_service_candidates WHERE ${t}`,
        'invoice_key',
      ),
      applyRuns: await this.count('legacy_import_runs', "mode = 'APPLY' AND status = 'COMPLETED'"),
    };
  }
}

// --- an executor with seams -----------------------------------------------------------------

export interface RigLogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly context: Record<string, unknown>;
  readonly message: string;
}

/**
 * The `migration` role's executor with its REAL ports (`NxpkgMigrationAdapters` over the
 * container's importer, history ingest and cutover service), built the way `container.ts`
 * builds it, with test seams: `importer` wraps each importer the adapters ask for (an
 * interruption is injected there), `runner` / `history` wrap the adapters' ports (a crash
 * between two executor phases), and every log line is kept.
 */
export function rigExecutor(
  ctx: TestContext,
  options: {
    readonly leaseOwner?: string;
    readonly leaseMs?: number;
    readonly importer?: (importer: LegacyImporterService) => LegacyImporterService;
    readonly runner?: (real: MigrationRunner) => MigrationRunner;
    readonly history?: (real: HistoryIngestPort) => HistoryIngestPort;
    readonly backup?: BackupPort;
    readonly lines?: RigLogLine[];
  } = {},
): LegacyMigrationExecutor {
  const container = ctx.container;
  const lines = options.lines ?? [];
  const keep =
    (level: RigLogLine['level']) => (context: Record<string, unknown>, message: string) => {
      lines.push({ level, context, message });
    };
  const adapters = new NxpkgMigrationAdapters({
    db: container.database.db,
    importer: () => {
      const importer = container.legacyImporter();
      return options.importer === undefined ? importer : options.importer(importer);
    },
    history: () => container.legacyHistoryIngest,
    cutover: () => container.legacyCutover,
    uow: container.uow,
    // A development database name: not production-like (the guard's own classification).
    target: { host: '127.0.0.1', port: '5432', database: 'nexa_test' },
    guardEnv: () => ({ NODE_ENV: 'development' }),
    logger: { warn: keep('warn'), error: keep('error') },
  });
  const runner = options.runner === undefined ? adapters : options.runner(adapters);
  const history = options.history === undefined ? adapters : options.history(adapters);
  return new LegacyMigrationExecutor({
    repository: container.legacyNxpkgImports,
    workspaces: container.migrationWorkspaces,
    cipher: container.cipher,
    verifier: adapters,
    runner,
    freshTarget: adapters,
    history,
    backup: options.backup ?? { runAfterImport: async () => ({ outcome: 'TAKEN', runId: null }) },
    clock: container.clock,
    correlation: () => `corr-rig-${String(Date.now())}` as CorrelationId,
    leaseOwner: options.leaseOwner ?? 'migration:rig',
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    tickIntervalMs: 1000,
    enabled: true,
    logger: { info: keep('info'), warn: keep('warn'), error: keep('error') },
  });
}

/** An importer whose `apply` runs `afterPhase` after each of its phases (the test seam). */
export function withAfterPhase(
  importer: LegacyImporterService,
  afterPhase: (phase: ApplyPhase) => Promise<void> | void,
): LegacyImporterService {
  const apply = importer.apply.bind(importer);
  importer.apply = ((input: Parameters<LegacyImporterService['apply']>[0]) =>
    apply({ ...input, afterPhase })) as LegacyImporterService['apply'];
  return importer;
}

// --- ownership decisions --------------------------------------------------------------------

export type DecisionClass =
  'PROVEN' | 'ADMIN_APPROVED_UNVERIFIED' | 'PENDING' | 'REJECTED' | 'QUARANTINED';

const BASIS: Record<DecisionClass, string> = {
  PROVEN: 'EVIDENCE',
  ADMIN_APPROVED_UNVERIFIED: 'ADMIN_ATTESTATION',
  PENDING: 'NONE',
  REJECTED: 'ADMIN_REJECTION',
  QUARANTINED: 'SYSTEM_QUARANTINE',
};
const REVIEW_STATE: Record<DecisionClass, string> = {
  PROVEN: 'PENDING',
  ADMIN_APPROVED_UNVERIFIED: 'ADMIN_APPROVED_UNVERIFIED',
  PENDING: 'PENDING',
  REJECTED: 'REJECTED',
  QUARANTINED: 'PENDING',
};

/**
 * The converter's signed `ownership-decisions.json` for `pkg`, one entry per packaged
 * ownership record (class from `classOf`, PROVEN by default; `stale` per key), signed with the
 * package's decisions key exactly as the Python `sign_export` does. `mutate` runs on the
 * signed document (a tamper the HMAC must catch).
 */
export async function signedDecisions(
  pkg: MigrationPackage,
  classOf: (invoiceKey: string) => DecisionClass = () => 'PROVEN',
  options: {
    readonly stale?: ReadonlySet<string>;
    readonly mutate?: (doc: Record<string, any>) => void;
  } = {},
): Promise<Buffer> {
  const entries = pkg.ownershipRecords
    .map((record) => {
      const invoiceKey = String(record['invoice_key']);
      const cls = classOf(invoiceKey);
      return {
        basis: BASIS[cls],
        batch_id: cls === 'ADMIN_APPROVED_UNVERIFIED' ? 'b-rig000000000001' : null,
        binding: createHash('sha256').update(canonicalJson(record)).digest('hex'),
        class: cls,
        invoice_key: invoiceKey,
        key: String(record['idempotency_key']),
        review_state: REVIEW_STATE[cls],
        stale: options.stale?.has(invoiceKey) ?? false,
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const digest = createHash('sha256').update(canonicalJson(entries)).digest('hex');
  const summary: Record<string, number> = {
    ADMIN_APPROVED_UNVERIFIED: 0,
    PENDING: 0,
    PROVEN: 0,
    QUARANTINED: 0,
    REJECTED: 0,
    items: entries.length,
  };
  for (const e of entries) summary[e.class] = (summary[e.class] ?? 0) + 1;
  const doc = {
    admin_attestation_is_proof: false,
    audit: { events: 1, head: 'a'.repeat(64), ok: true, reason: null },
    entries,
    entries_digest: digest,
    import_id: pkg.manifest['import_id'],
    matches_seal: true,
    package_header_sha256: pkg.headerSha256,
    review_version: '1.0.0',
    rules: { approve_target: 'invoice.id_user only', serious_reasons: [] },
    schema: 'm2n.ownership_decisions.v1',
    sealed: true,
    sealed_at: 1_791_663_970,
    sealed_digest: digest,
    sealed_divergence: 0,
    source_fingerprint: pkg.manifest['source_fingerprint'],
    summary,
  };
  const key = await deriveDecisionsKey(pkg.path, { keyFileText: pkg.keyFileText });
  const signed = signDecisionsExport(doc, key) as Record<string, any>;
  options.mutate?.(signed);
  return Buffer.from(JSON.stringify(signed), 'utf8');
}

/** `real` with some of its methods replaced (every other one still the real, bound). */
export function overriding<T extends object>(real: T, overrides: Partial<T>): T {
  return new Proxy(real, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return (overrides as Record<PropertyKey, unknown>)[property];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
