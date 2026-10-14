import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  money,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { runAsLegacyMigration } from '../../apps/api/src/infrastructure/persistence/write-gate';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { INVENTORY_READ_ATTEMPTS } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { PipelineBackupPort } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/migration-adapters';
import { LegacyMigrationService } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration.service';
import { decideLegacyUser } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { classifyLegacyUserStatus } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { targetAcknowledgement } from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import {
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_PANEL_CODES,
  buildSyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import {
  startFakeRickpanel,
  type FakeRickpanel,
  type FakeRickpanelInterception,
  type FakeRickpanelRequest,
} from '../support/fake-rickpanel';
import { newRawKey, writeNxpkg } from '../support/nxpkg/writer';
import {
  READY_MANIFEST,
  snapshotOfDataset,
  snapshotPackageFiles,
} from '../support/nxpkg-legacy-package';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Per-name RickPanel inventory resolution, end to end through the Web Admin's `.nxpkg`
 * restore page on a PRODUCTION-LIKE target (`docs/rickpanel-inventory.md` §Per-name
 * resolution): the owner keeps Mirza selling while the dry run reads the live panel, so the
 * panel changes under the walk (`TOTAL_CHANGED`, `WALKS_DIFFER`).
 *
 * The rule under test: eligible = backup-owned valid services ∩ verifiably existing RickPanel
 * accounts on correctly mapped panels. A panel account the backup does not name (a manual
 * account, a sale Mirza made after the backup) is ignored entirely — never looked up, never a
 * customer, never a service. A needed name the read could not decide stays
 * `INVENTORY_INCOMPLETE`, and a production-like approval refuses the dry run. The plan digest
 * (v2) binds every live invoice's decision: a candidate that moved between the dry run and the
 * apply is `DRY_RUN_MISMATCH`, nothing written; an account nobody needs does not move it.
 *
 * The importer is the container's own, built exactly as the Web Admin's (`inventoryTargeted:
 * true`, `INVENTORY_READ_ATTEMPTS`), with a page size of 2 so each walk of the seven-account
 * synthetic panel takes four pages and a change between two pages is `TOTAL_CHANGED`.
 *
 * SYNTHETIC data only, fake RickPanels on loopback sockets. NOT EVIDENCE about a real panel.
 */

const TENANT = SEED_IDS.tenantA as unknown as string;
/** Small enough that the seven-account panel takes four pages a walk. */
const PAGE_SIZE = 2;
const LIVE = new Set(['active', 'disabled', 'disabledn', 'disablebyadmin', 'end_of_volume']);

type Dataset = ReturnType<typeof buildSyntheticLegacyDataset>;
type Row = Record<string, string | null>;

describe('Web Admin .nxpkg over a live RickPanel that keeps selling (per-name inventory)', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let backupRoot: string;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let panelAId: string;
  let panelBId: string;
  let owner: ActorContext;
  let keys = 0;
  const key = () => `live-inv-${String((keys += 1))}-${String(Date.now())}`;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'live-inv-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'live-inv-root-'));
    backupRoot = await mkdtemp(join(tmpdir(), 'live-inv-backup-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: backupRoot,
      // The schema's floor: a panel that never answers costs one second a request (G).
      PANEL_HTTP_TIMEOUT_MS: '1000',
    });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    for (const dir of [work, migrationRoot, backupRoot]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await panelA?.close();
    await panelB?.close();
  });

  const ACCOUNT = {
    expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
    dataLimit: 30 * 1024 ** 3,
    usedTraffic: 1024 ** 3,
  };

  async function rickpanel(host: string, names: readonly string[], name: string) {
    const fake = await startFakeRickpanel({ host });
    for (const user of names) fake.seedUser(user, ACCOUNT);
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: `Rick ${name}`,
      providerType: 'rickpanel',
      baseUrl: fake.baseUrl,
      credentials: { username: fake.username, password: fake.password },
      activation: {},
      idempotencyKey: `live-inv-panel-${name}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    for (const entry of await readdir(migrationRoot)) {
      await rm(join(migrationRoot, entry), { recursive: true, force: true });
    }
    owner = {
      ...adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'owner-live', roleKeys: ['owner'] }),
      ),
    };
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
    // The current public tariff the 30 GB / 30 d hidden shapes resolve to, so that a matched
    // invoice of that shape is ADOPTION_ELIGIBLE and the apply really adopts it.
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 1,
        panelId: panelAId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 30n * 1024n ** 3n, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
  }, 120_000);

  // ── the package ────────────────────────────────────────────────────────────────────────

  /** The converter's operational records for these users (the importer's own rules). */
  function converterFiles(dataset: Dataset) {
    const users = (dataset.tables['user'] ?? []) as Row[];
    const customers: Record<string, unknown>[] = [];
    const openings: Record<string, unknown>[] = [];
    const debts: Record<string, unknown>[] = [];
    for (const u of users) {
      const d = decideLegacyUser(
        {
          id: String(u['id']),
          balance: u['Balance'] ?? null,
          status: classifyLegacyUserStatus(u['User_Status'] ?? null),
        },
        false,
      );
      if (d.kind !== 'IMPORT') continue;
      const tg = d.telegramUserId;
      customers.push({ record_type: 'customer', idempotency_key: `legacy:customer:${tg}` });
      if (d.balanceMinor > 0n) {
        openings.push({
          record_type: 'wallet_opening_balance',
          idempotency_key: `legacy:opening:${tg}`,
          amount_minor: d.balanceMinor.toString(),
          currency: 'IRT',
        });
      } else if (d.balanceMinor < 0n) {
        debts.push({
          record_type: 'legacy_debt',
          idempotency_key: `legacy:debt:${tg}`,
          amount_minor: (-d.balanceMinor).toString(),
          currency: 'IRT',
        });
      }
    }
    return {
      'records/customers.jsonl': { records: customers },
      'records/wallet_opening_balances.jsonl': { records: openings },
      'records/legacy_debts.jsonl': { records: debts },
    };
  }

  /**
   * The synthetic dataset as a REAL-looking package (no synthetic marker, every table
   * classified, only Telegram ids) with panels rp1 → A and rp2 → B selected. `invoices`
   * edits the live invoices. `records/service_ownership.jsonl` holds one record per live
   * invoice, as a converter writes it: `ownership` decides each (default: the converter
   * proved the invoice's own `id_user` is the current owner). Without such a record every
   * invoice is held from adoption (`NO_OWNERSHIP_RECORD`), so nothing could be adopted.
   */
  async function writePackage(
    options: {
      readonly invoices?: (rows: Row[]) => Row[];
      readonly ownership?: (invoice: Row) => {
        readonly decision: string;
        readonly finalOwner: string | null;
      };
    } = {},
  ): Promise<{ path: string; keyFileText: string }> {
    const built = buildSyntheticLegacyDataset();
    const users = (built.tables['user'] ?? []).filter(
      (u) =>
        decideLegacyUser(
          {
            id: String(u['id']),
            balance: (u['Balance'] as string | null | undefined) ?? null,
            status: 'ACTIVE',
          },
          false,
        ).kind !== 'INVALID_IDENTITY',
    );
    const invoices = (built.tables['invoice'] ?? []) as Row[];
    const dataset = {
      ...built,
      schema: built.schema.filter((c) => !c.table.startsWith('nexa_synthetic')),
      tables: {
        ...built.tables,
        user: users,
        invoice: options.invoices === undefined ? invoices : options.invoices([...invoices]),
      },
    } as Dataset;
    const parts = snapshotOfDataset(dataset as never);
    const C = SYNTHETIC_PANEL_CODES;
    const target = (code: string, selected: boolean) => ({
      record_type: 'legacy_panel_target',
      schema: 'm2n.legacy_panel_target.v1',
      idempotency_key: `legacy:panel-target:${code}`,
      code_panel: code,
      target: selected
        ? {
            provider_type: 'rickpanel',
            provider_display_name: 'RickPanel',
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
    const decide =
      options.ownership ??
      ((invoice: Row) => ({
        decision: 'CONFIRMED_CURRENT_OWNER',
        finalOwner: invoice['id_user'] ?? null,
      }));
    const ownership = {
      'records/service_ownership.jsonl': {
        records: (dataset.tables['invoice'] as Row[])
          .filter((i) => LIVE.has(i['Status'] ?? ''))
          .map((i) => {
            const decided = decide(i);
            return {
              record_type: 'legacy_service_ownership',
              schema: 'mirza.service_ownership.v1',
              idempotency_key: `legacy:service-ownership:${i['id_invoice'] ?? ''}`,
              invoice_key: i['id_invoice'],
              ownership_decision: decided.decision,
              final_owner_telegram_user_id: decided.finalOwner,
              provision: false,
              applies_to_live_state: false,
              affects_wallet: false,
              creates_payment: false,
            };
          }),
      },
    };
    const raw = newRawKey();
    const written = await writeNxpkg(join(work, `p-${ctx.container.ids.uuid()}.nxpkg`), {
      files: snapshotPackageFiles(parts, {
        'records/panel_target_mapping.jsonl': {
          records: [
            target(C.mappedA, true),
            target(C.mappedB, true),
            target(C.test, false),
            target(C.declaredMissing, false),
            target(C.unmapped, false),
            target('(no code_panel)', false),
          ],
        },
        ...converterFiles(dataset),
        ...ownership,
      }),
      secret: { rawKey: raw.rawKey },
      manifest: { ...READY_MANIFEST, import_id: 'abcdefabcdefabcdefabcdefabcdefab' },
    });
    return { path: written.path, keyFileText: raw.keyFileText };
  }

  async function upload(path: string): Promise<string> {
    const service = ctx.container.legacyMigration;
    const pending = await service.beginUpload(tenantA, owner, { fileName: 'mirza.nxpkg' });
    await copyFile(path, pending.packagePath);
    const bytes = await readFile(path);
    const view = await service.completeUpload(tenantA, owner, pending, {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return view.id;
  }

  // ── what the database and the panels hold ──────────────────────────────────────────────

  async function count(table: string): Promise<number> {
    const result = await ctx.container.database.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${TENANT}'`),
    );
    return result.rows[0]?.n ?? 0;
  }

  /** Every table a dry run must leave untouched (business state and the read sets). */
  const BUSINESS_TABLES = [
    'customers',
    'wallet_entries',
    'services',
    'orders',
    'legacy_read_set_runs',
    'legacy_product_reviews',
    'legacy_invoice_archive',
    'legacy_invoice_archive_runs',
    'legacy_cutover_approvals',
  ] as const;
  async function businessCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of BUSINESS_TABLES) out[table] = await count(table);
    return out;
  }
  const NOTHING_WRITTEN = Object.fromEntries(BUSINESS_TABLES.map((t) => [t, 0]));

  /** Every service NEXA holds: its panel, exact provider spelling and owner's Telegram id. */
  async function services(): Promise<{ panel: string; username: string; owner: string }[]> {
    const result = await ctx.container.database.db.execute<{
      panel: string;
      username: string;
      owner: string;
    }>(sql`
      SELECT CASE s.panel_id WHEN ${panelAId}::uuid THEN 'A' WHEN ${panelBId}::uuid THEN 'B'
             ELSE 'other' END AS panel,
             s.provider_username AS username, c.telegram_user_id AS owner
        FROM services s JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id = ${TENANT}
       ORDER BY 1, 2`);
    return result.rows;
  }

  async function customerTelegramIds(): Promise<string[]> {
    const result = await ctx.container.database.db.execute<{ tg: string }>(
      sql`SELECT telegram_user_id AS tg FROM customers WHERE tenant_id = ${TENANT} ORDER BY 1`,
    );
    return result.rows.map((r) => r.tg);
  }

  /** Only reads ever reached the panel: GETs and the token exchange. */
  function expectReadsOnly(fake: FakeRickpanel): void {
    expect(
      fake.requests.filter(
        (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
      ),
    ).toEqual([]);
  }

  /** The exact lookups (`GET /api/user/{name}`) the panel received, by name. */
  const lookupsOf = (fake: FakeRickpanel, since = 0): string[] =>
    fake.requests
      .slice(since)
      .filter((r) => r.method === 'GET' && /^\/api\/user\/[^/?]+$/u.test(r.path))
      .map((r) => decodeURIComponent(r.path.slice('/api/user/'.length)));

  /**
   * `fn(walk, offset)` before every list page: `walk` counts walks of this panel since the
   * hook was set (a page at offset 0 starts one).
   */
  function onWalkPages(fake: FakeRickpanel, fn: (walk: number, offset: number) => void): void {
    let walk = 0;
    fake.beforeListPage = (offset) => {
      if (offset === 0) walk += 1;
      fn(walk, offset);
    };
  }

  // ── the restore page, production-like, with the Web Admin's importer ───────────────────

  const detail = (id: string) => ctx.container.legacyMigration.detail(tenantA, owner, id);
  const codes = (rows: readonly { code: string; count: number }[] | undefined) =>
    Object.fromEntries((rows ?? []).map((w) => [w.code, w.count]));

  function productionLikePage() {
    const target = { host: 'db.internal', port: '5432', database: 'nexa' };
    const ack = targetAcknowledgement(target, TENANT);
    const container = ctx.container;
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const pageService = new LegacyMigrationService({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      guard: container.guard,
      uow: container.uow,
      audit: container.audit,
      opsLog: container.opsLog,
      sessions: container.sessions,
      idempotency: container.idempotency,
      scopeActivity: container.tenants,
      clock: container.clock,
      ids: container.ids,
      enabled: true,
      maxUploadBytes: 1024 * 1024 * 1024,
      productionLikeTarget: true,
      targetAcknowledgement: (tenantId) => targetAcknowledgement(target, tenantId),
      cutover: () => container.legacyCutover,
      recoveryActive: async (tx) =>
        (await container.recoveryRequests.installationLock(tx)) !== null,
      logger: quiet,
    });
    // The Web Admin's importer (container.ts, NxpkgMigrationAdapters): attempts and the
    // per-name resolution, with no real pause and the small page.
    const adapters = new NxpkgMigrationAdapters({
      db: container.database.db,
      importer: (signal) =>
        container.legacyImporter({
          inventoryPageSize: PAGE_SIZE,
          inventoryAttempts: INVENTORY_READ_ATTEMPTS,
          inventoryTargeted: true,
          inventorySleep: async () => undefined,
          ...(signal === undefined ? {} : { inventorySignal: signal }),
        }),
      history: () => container.legacyHistoryIngest,
      cutover: () => container.legacyCutover,
      uow: container.uow,
      target,
      guardEnv: () => ({ NODE_ENV: 'production' }),
      logger: { warn: () => undefined, error: () => undefined },
    });
    const executor = new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: adapters,
      runner: adapters,
      freshTarget: adapters,
      history: adapters,
      backup: new PipelineBackupPort(container.backup, container.recoveryQuiesced),
      recoveryActive: async () => (await container.recoveryRequests.installationLock()) !== null,
      latestCutoverAt: () => container.recoveryRequests.latestCutoverAt(),
      asImportWriter: runAsLegacyMigration,
      clock: container.clock,
      correlation: () => 'corr-live-inventory' as CorrelationId,
      leaseOwner: 'recovery:live-inventory',
      tickIntervalMs: 1000,
      enabled: true,
      logger: quiet,
    });
    const service = container.legacyMigration;
    /** Upload, key, verify and bind: everything before the first dry run. */
    const toVerified = async (pkg: { path: string; keyFileText: string }) => {
      const id = await upload(pkg.path);
      await service.setKey(tenantA, owner, id, {
        idempotencyKey: key(),
        keyFileText: pkg.keyFileText,
      });
      await executor.tick();
      await service.setPanelBindings(tenantA, owner, id, {
        idempotencyKey: key(),
        bindings: [
          { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
          { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
        ],
      });
      return id;
    };
    /** One dry run of an import already verified (the page's "dry run again" too). */
    const dryRun = async (id: string) => {
      await service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });
      await executor.tick();
      return detail(id);
    };
    const approve = async (id: string) =>
      pageService.approve(tenantA, owner, id, {
        idempotencyKey: key(),
        dryRunSha256: (await detail(id)).dryRunSha256,
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
        targetAcknowledgement: ack,
      });
    return { executor, toVerified, dryRun, approve };
  }

  // ── helpers over the scenarios ─────────────────────────────────────────────────────────

  /**
   * The services the synthetic backup becomes on this target: its one ADOPTION_ELIGIBLE
   * invoice (svc_a1, the 30 GB / 30 d hidden shape) on its one account. svc_a2 names a legacy
   * product nobody mapped (PRODUCT_UNRESOLVED); `gone` is unmapped here (no target selected).
   */
  const BASELINE_SERVICES = [{ panel: 'A', username: 'svc_a1', owner: '100000001' }];

  /** A live 30 GB / 30 d invoice on rp1 (panel A) for `idUser`, named `username`. */
  const extraInvoice = (rows: Row[], id: string, idUser: string, username: string): Row => ({
    ...(rows.find((r) => r['username'] === 'svc_a1' && r['id_user'] === '100000001') as Row),
    id_invoice: id,
    id_user: idUser,
    username,
  });

  /**
   * Each backup invoice's candidate after the apply: outcome and, per holder, the panel and
   * how many exact spellings were seen (`legacy_service_candidates.evidence`).
   */
  async function candidates(): Promise<
    Record<string, { outcome: string; holders: { panel: string; spellings: number }[] }>
  > {
    const result = await ctx.container.database.db.execute<{
      invoice_key: string;
      outcome: string;
      evidence: { holders?: { panelId: string; spellings: number }[] };
    }>(
      sql`SELECT invoice_key, outcome, evidence FROM legacy_service_candidates
           WHERE tenant_id = ${TENANT} ORDER BY invoice_key`,
    );
    return Object.fromEntries(
      result.rows.map((r) => [
        r.invoice_key,
        {
          outcome: r.outcome,
          holders: (r.evidence.holders ?? []).map((h) => ({
            panel: h.panelId === panelAId ? 'A' : h.panelId === panelBId ? 'B' : 'other',
            spellings: h.spellings,
          })),
        },
      ]),
    );
  }

  /** The Telegram ids the backup holds (any customer NEXA has must be one of them). */
  const BACKUP_USERS = new Set(
    ((buildSyntheticLegacyDataset().tables['user'] ?? []) as Row[]).map((u) => String(u['id'])),
  );

  /**
   * The canary every per-name resolution of panel A asks first: the lexically first NEEDED
   * name both walks saw (never an account the backup does not name; Case_X is a collision,
   * so not a candidate canary).
   */
  const CANARY = 'svc_a1';

  /** Names no backup row holds: a manual account, or a sale Mirza made after the backup. */
  const NOT_IN_BACKUP = /^(manual_|mirza_sale_)/u;

  /** No adopted service shares an account, and each is the panel's own exact spelling. */
  function expectOneServicePerAccount(
    held: readonly { panel: string; username: string; owner: string }[],
  ): void {
    const accounts = held.map((s) => `${s.panel}:${s.username.toLowerCase()}`);
    expect(new Set(accounts).size).toBe(accounts.length);
    for (const s of held) {
      const fake = s.panel === 'A' ? panelA : panelB;
      expect(fake.users.has(s.username), `${s.panel}:${s.username} is an account`).toBe(true);
      expect(s.username).not.toMatch(NOT_IN_BACKUP);
    }
  }

  /** Answers every request matching `match` in the panel's place. */
  function failOn(
    fake: FakeRickpanel,
    match: (request: FakeRickpanelRequest) => boolean,
    answer: FakeRickpanelInterception,
  ): void {
    fake.intercept = (request) => (match(request) ? answer : null);
  }
  const isListPage = (offset: number) => (r: FakeRickpanelRequest) =>
    r.method === 'GET' &&
    r.path === `/api/users?offset=${String(offset)}&limit=${String(PAGE_SIZE)}`;
  const isLookupOf = (name: string) => (r: FakeRickpanelRequest) =>
    r.method === 'GET' && r.path === `/api/user/${name}`;

  /** A manual account created on panel A by its operator before the first walk's 2nd page. */
  function manualAccountMidWalk(name = 'manual_op_1'): void {
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.seedUser(name, ACCOUNT);
    });
  }

  // ── A, B, C, F (all resolved), H ───────────────────────────────────────────────────────

  it('A/B/C/F/H: a manual account created mid-walk and Mirza sales made after the backup — TOTAL_CHANGED, every needed name decided, approvable; the apply adopts each candidate onto its one account and nothing else', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    // B: Mirza kept selling after the backup was taken — accounts the package never names.
    panelA.seedUser('mirza_sale_after_backup', ACCOUNT);
    panelB.seedUser('mirza_sale_b', ACCOUNT);
    // A: the operator creates accounts by hand while each walk is between two pages.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.seedUser('manual_op_1', ACCOUNT);
      if (walk === 2 && offset === 4) panelA.seedUser('manual_op_2', ACCOUNT);
    });
    const before = { a: panelA.requests.length, b: panelB.requests.length };

    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    // F: the churn is reported as information and blocks nothing.
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    // The canary and the one needed name: no 404 is trusted before the canary answers 200.
    expect(w['PROVIDER_INVENTORY_LOOKUPS']).toBe(2);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(Object.keys(w).filter((c) => c.startsWith('PROVIDER_INVENTORY_INCOMPLETE'))).toEqual([]);
    // The panel decided what a complete read decides: the missing account, the collision.
    expect(w['PROVIDER_MISSING']).toBe(1);
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    // A/B: the canary (the lexically first account both walks saw), then the one needed
    // name no walk saw — the backup's own; never a manual account or a sale. B held still.
    expect(lookupsOf(panelA, before.a)).toEqual([CANARY, 'svc_missing']);
    expect(lookupsOf(panelB, before.b)).toEqual([]);
    // H: the dry run wrote nothing and sent the panels nothing but reads.
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    // C: each eligible invoice on exactly its one account, its exact spelling, its owner —
    // and (A/B) no service for an account the backup does not name.
    const held = await services();
    expect(held).toEqual(BASELINE_SERVICES);
    expectOneServicePerAccount(held);
    // C: the matched candidates' evidence — one holder, on the mapped panel, one exact
    // spelling; the collision two spellings; the missing account none. Only backup invoices
    // are candidates at all (19, as the source has live invoices).
    const decided = await candidates();
    expect(Object.keys(decided)).toHaveLength(19);
    expect(decided['a0000001']).toEqual({
      outcome: 'ADOPTED',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    expect(decided['a000000f']).toEqual({
      outcome: 'PRODUCT_UNRESOLVED',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    expect(decided['a0000008']).toEqual({
      outcome: 'USERNAME_CASE_COLLISION',
      holders: [{ panel: 'A', spellings: 2 }],
    });
    expect(decided['7c1f']).toEqual({ outcome: 'PROVIDER_MISSING', holders: [] });
    // A/B: no customer that is not the backup's.
    for (const tg of await customerTelegramIds()) expect(BACKUP_USERS.has(tg), tg).toBe(true);
    // Neither the dry run nor the import ever asked a panel about a name nobody needs.
    for (const fake of [panelA, panelB]) {
      expect(lookupsOf(fake).filter((n) => NOT_IN_BACKUP.test(n))).toEqual([]);
      expectReadsOnly(fake);
    }
  }, 600_000);

  // ── H: idempotent ──────────────────────────────────────────────────────────────────────

  it('H: asked again — over other churn, and over a still panel — the dry run plans the same digest and still writes nothing', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    manualAccountMidWalk('manual_op_1');
    const first = await page.dryRun(id);
    expect(first.status).toBe('DRY_RUN_DONE');
    expect(codes(first.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBe(1);

    // Again, with a different account created mid-walk and the earlier one deleted.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 2) {
        panelA.removeUser('manual_op_1');
        panelA.seedUser('manual_op_2', ACCOUNT);
      }
    });
    const second = await page.dryRun(id);
    expect(second.status).toBe('DRY_RUN_DONE');
    expect(codes(second.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBe(1);

    // And once more over a panel that holds still: the ordinary complete read.
    panelA.beforeListPage = null;
    const third = await page.dryRun(id);
    expect(third.status).toBe('DRY_RUN_DONE');
    expect(codes(third.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBeUndefined();

    expect(first.dryRunReport?.planTalliesDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.dryRunReport?.planTalliesDigest).toBe(first.dryRunReport?.planTalliesDigest);
    expect(third.dryRunReport?.planTalliesDigest).toBe(first.dryRunReport?.planTalliesDigest);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 600_000);

  // ── D ──────────────────────────────────────────────────────────────────────────────────

  it('D: a candidate account deleted mid-walk is proven absent by its exact lookup — PROVIDER_MISSING, never adopted; the account the cursor slipped past is found by lookup and adopted', async () => {
    const page = productionLikePage();
    // A second eligible candidate: svc_a3, owned by user 9 (rp1, 30 GB / 30 d).
    const id = await page.toVerified(
      await writePackage({
        invoices: (rows) => [...rows, extraInvoice(rows, 'b0000003', '100000009', 'svc_a3')],
      }),
    );
    // During the first walk, after svc_a1 was served on page one, the operator deletes it:
    // every later row shifts up, so the first walk never sees svc_a3 either.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.removeUser('svc_a1');
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    // After the canary: svc_a1 (seen by the first walk only → 404), svc_a3 (seen by the
    // second only → found), svc_missing (seen by neither → 404), in name order.
    // svc_a1 is gone from the second walk, so the canary here is svc_a2.
    expect(lookupsOf(panelA, before)).toEqual(['svc_a2', 'svc_a1', 'svc_a3', 'svc_missing']);
    expect(w['PROVIDER_INVENTORY_LOOKUPS']).toBe(4);
    expect(w['PROVIDER_MISSING']).toBe(2);
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    expect((await detail(id)).status).toBe('COMPLETED');
    // The deleted account is not attached to anybody; the slipped-past one is, to its owner.
    const held = await services();
    expect(held).toEqual([{ panel: 'A', username: 'svc_a3', owner: '100000009' }]);
    expectOneServicePerAccount(held);
    const decided = await candidates();
    expect(decided['a0000001']).toEqual({ outcome: 'PROVIDER_MISSING', holders: [] });
    expectReadsOnly(panelA);
  }, 600_000);

  // ── E ──────────────────────────────────────────────────────────────────────────────────

  it('E: two owners of one account, ownership not proven, two spellings of one name — under churn none is attached to anybody; the proven one is attached to its own owner', async () => {
    const page = productionLikePage();
    const pkg = await writePackage({
      invoices: (rows) => [
        ...rows,
        // A second live owner of svc_a1 on the same panel (user 10 is importable).
        extraInvoice(rows, 'b0000001', '100000010', 'svc_a1'),
        // One owner, proven: svc_shared on rp1 for user 11.
        extraInvoice(rows, 'b0000002', '100000011', 'svc_shared'),
        // One owner the converter could NOT prove: svc_a3 for user 9.
        extraInvoice(rows, 'b0000003', '100000009', 'svc_a3'),
      ],
      ownership: (invoice) =>
        invoice['id_invoice'] === 'b0000003'
          ? { decision: 'AMBIGUOUS_OWNER', finalOwner: null }
          : { decision: 'CONFIRMED_CURRENT_OWNER', finalOwner: invoice['id_user'] ?? null },
    });
    const id = await page.toVerified(pkg);
    manualAccountMidWalk();
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    // Case_X / case_x: two accounts fold to one name — a guess, so manual review.
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    // svc_a1 twice (two owners) and svc_a3 (not proven): held from adoption.
    expect(w['AMBIGUOUS_OWNERSHIP']).toBe(3);

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    const held = await services();
    expect(held).toEqual([{ panel: 'A', username: 'svc_shared', owner: '100000011' }]);
    expectOneServicePerAccount(held);
    const decided = await candidates();
    for (const key of ['a0000001', 'b0000001', 'b0000003']) {
      expect(decided[key]?.outcome, key).toBe('AMBIGUOUS_OWNERSHIP');
    }
    expect(decided['a0000008']?.outcome).toBe('USERNAME_CASE_COLLISION');
  }, 600_000);

  it('E: an account renamed across case between the two walks is a collision, never adopted; the apply that then sees one spelling plans another plan — DRY_RUN_MISMATCH, nothing written', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 0) {
        panelA.removeUser('svc_a1');
        panelA.seedUser('SVC_A1', ACCOUNT);
      }
    });
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    // case_x as before, and svc_a1 now: svc_a1 by one walk, SVC_A1 by the other.
    expect(w['USERNAME_CASE_COLLISION']).toBe(2);
    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    expect(await detail(id)).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    for (const table of ['customers', 'wallet_entries', 'services', 'orders']) {
      expect(await count(table), table).toBe(0);
    }
    expectReadsOnly(panelA);
  }, 600_000);

  // ── F: unresolved ──────────────────────────────────────────────────────────────────────

  it('F: a needed name whose lookup fails (5xx past the budget) stays UNRESOLVED — INVENTORY_INCOMPLETE, approval refused, nothing written; over a recovered panel it is approvable', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    manualAccountMidWalk();
    failOn(panelA, isLookupOf('svc_missing'), { status: 503, body: { detail: 'busy' } });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    panelA.intercept = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(1);
    expect(w['INVENTORY_INCOMPLETE']).toBe(1);
    // A read that left a needed name unresolved is not a complete read of that panel.
    expect(w['PROVIDER_INVENTORY_INCOMPLETE']).toBe(1);
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED']).toBe(1);
    // Bounded: the canary once, then the first ask and the retry budget (4), no more.
    const asked = lookupsOf(panelA, before);
    expect(asked[0]).toBe(CANARY);
    expect(asked.filter((n) => n === CANARY)).toHaveLength(1);
    const failing = asked.filter((n) => n === 'svc_missing').length;
    expect(failing).toBeGreaterThanOrEqual(1);
    expect(failing).toBeLessThanOrEqual(5);
    expect(new Set(asked)).toEqual(new Set([CANARY, 'svc_missing']));
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
      details: expect.objectContaining({ reason: 'PROVIDER_INVENTORY_INCOMPLETE' }),
    });
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    // The panel answers again; the same import, dry-run again, is approvable.
    manualAccountMidWalk('manual_op_2');
    const again = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(codes(again.dryRunReport?.warnings)['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect((await page.approve(id)).status).toBe('APPROVED');
    expectReadsOnly(panelA);
  }, 600_000);

  it('F: a lookup route that answers 404 to everything (the canary not found) — no 404 is trusted: the needed name stays UNRESOLVED, never PROVIDER_MISSING, and approval is refused', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    manualAccountMidWalk();
    failOn(panelA, (r) => r.method === 'GET' && r.path.startsWith('/api/user/'), {
      status: 404,
      body: { detail: 'Not Found' },
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    panelA.intercept = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    // Only the canary was asked; its 404 stopped every other lookup.
    expect(lookupsOf(panelA, before)).toEqual([CANARY]);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(1);
    expect(w['INVENTORY_INCOMPLETE']).toBe(1);
    expect(w['PROVIDER_MISSING']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED']).toBe(1);
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
      details: expect.objectContaining({ reason: 'PROVIDER_INVENTORY_INCOMPLETE' }),
    });
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expectReadsOnly(panelA);
  }, 600_000);

  // ── G ──────────────────────────────────────────────────────────────────────────────────

  const FAILURES: readonly {
    readonly name: string;
    readonly answer: FakeRickpanelInterception;
    /** Most requests the failing route may receive in one read. */
    readonly bound: number;
  }[] = [
    // A 401 buys ONE fresh login; a second 401 ends the read.
    {
      name: '401',
      answer: { status: 401, body: { detail: 'Could not validate credentials' } },
      bound: 2,
    },
    // A 4xx is final.
    { name: '403', answer: { status: 403, body: { detail: 'Forbidden' } }, bound: 1 },
    // A 429 waits what it is told, within the read's one retry budget (4).
    {
      name: '429',
      answer: { status: 429, body: { detail: 'slow down' }, headers: { 'retry-after': '1' } },
      bound: 5,
    },
    { name: '5xx', answer: { status: 502, body: { detail: 'bad gateway' } }, bound: 5 },
    // No answer at all: the client's own timeout (1 s here), within the same budget.
    { name: 'timeout', answer: 'hang', bound: 5 },
  ];

  it('G: 401, 403, 429, 5xx and a timeout on a WALK page or on a LOOKUP — bounded, fail-closed: not approvable, nothing written, nothing adopted', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    for (const failure of FAILURES) {
      // ── on a walk page (every request for the second page of a walk) ──
      failOn(panelA, isListPage(2), failure.answer);
      let before = panelA.requests.length;
      const walked = await page.dryRun(id);
      panelA.intercept = null;
      const sent = panelA.requests.slice(before);
      expect(walked.status, failure.name).toBe('DRY_RUN_DONE');
      const ww = codes(walked.dryRunReport?.warnings);
      expect(ww['PROVIDER_INVENTORY_INCOMPLETE'], failure.name).toBe(1);
      expect(ww['INVENTORY_INCOMPLETE'], failure.name).toBeGreaterThan(0);
      expect(ww['PROVIDER_INVENTORY_CHURN'], failure.name).toBeUndefined();
      expect(sent.filter(isListPage(2)).length, failure.name).toBeGreaterThanOrEqual(1);
      expect(sent.filter(isListPage(2)).length, failure.name).toBeLessThanOrEqual(failure.bound);
      // The read stopped where it failed: no later page, no second walk, no lookup.
      expect(sent.filter(isListPage(4)), failure.name).toEqual([]);
      expect(sent.filter(isListPage(0)).length, failure.name).toBe(1);
      expect(lookupsOf(panelA, before), failure.name).toEqual([]);
      expect(sent.filter((r) => r.path === '/api/admin/token').length).toBeLessThanOrEqual(2);
      await expect(page.approve(id), failure.name).rejects.toMatchObject({
        code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
      });

      // ── on the exact lookup a churned read needs ──
      manualAccountMidWalk(`manual_${failure.name}`);
      failOn(panelA, isLookupOf('svc_missing'), failure.answer);
      before = panelA.requests.length;
      const looked = await page.dryRun(id);
      panelA.intercept = null;
      panelA.beforeListPage = null;
      expect(looked.status, failure.name).toBe('DRY_RUN_DONE');
      const lw = codes(looked.dryRunReport?.warnings);
      expect(lw['PROVIDER_INVENTORY_CHURN'], failure.name).toBe(1);
      expect(lw['PROVIDER_INVENTORY_UNRESOLVED'], failure.name).toBe(1);
      expect(lw['INVENTORY_INCOMPLETE'], failure.name).toBe(1);
      expect(lw['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED'], failure.name).toBe(1);
      const asked = lookupsOf(panelA, before);
      expect(asked[0], failure.name).toBe(CANARY);
      const failing = asked.filter((n) => n === 'svc_missing').length;
      expect(failing, failure.name).toBeGreaterThanOrEqual(1);
      expect(failing, failure.name).toBeLessThanOrEqual(failure.bound);
      await expect(page.approve(id), failure.name).rejects.toMatchObject({
        code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
        details: expect.objectContaining({ reason: 'PROVIDER_INVENTORY_INCOMPLETE' }),
      });
      expect(await businessCounts(), failure.name).toEqual(NOTHING_WRITTEN);
    }
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 600_000);

  // ── I ──────────────────────────────────────────────────────────────────────────────────

  it('I: a candidate account deleted between the dry run and the apply — FAILED DRY_RUN_MISMATCH, nothing written', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    manualAccountMidWalk();
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(codes(dry.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect((await page.approve(id)).status).toBe('APPROVED');

    // The eligible candidate's account is deleted on the panel before the apply reads it.
    panelA.removeUser('svc_a1');
    await page.executor.tick();
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.applyLegacyRunId).toBeNull();
    const refusal = codes(failed.progress.refusalCounts);
    expect(refusal['dryrun:services:PROVIDER_MISSING']).toBe(1);
    expect(refusal['apply:services:PROVIDER_MISSING']).toBe(2);
    for (const table of ['customers', 'wallet_entries', 'services', 'orders']) {
      expect(await count(table), table).toBe(0);
    }
    expectReadsOnly(panelA);
  }, 600_000);

  it("I: manual accounts and a Mirza sale created between the dry run and the apply, and churn during the apply's own walk — the digest holds and the apply COMPLETES as approved", async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    manualAccountMidWalk();
    const dry = await page.dryRun(id);
    expect(codes(dry.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect((await page.approve(id)).status).toBe('APPROVED');

    // Between approval and apply: more accounts no backup row names…
    panelA.seedUser('manual_between', ACCOUNT);
    panelA.seedUser('mirza_sale_between', ACCOUNT);
    panelB.seedUser('manual_between_b', ACCOUNT);
    // …and the apply's own read is moved under too.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 4) panelA.seedUser('manual_during_apply', ACCOUNT);
    });
    const listsBefore = panelA.listCalls();
    await page.executor.tick();
    panelA.beforeListPage = null;
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    // The apply read the live panel again (it does not trust the dry run's read).
    expect(panelA.listCalls()).toBeGreaterThan(listsBefore);
    const held = await services();
    expect(held).toEqual(BASELINE_SERVICES);
    expectOneServicePerAccount(held);
    for (const tg of await customerTelegramIds()) expect(BACKUP_USERS.has(tg), tg).toBe(true);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 600_000);
});
