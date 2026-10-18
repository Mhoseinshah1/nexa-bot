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
  SYNTHETIC_EXPECTED,
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
  tenantB,
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
          telegram_user_id: tg,
          amount_minor: d.balanceMinor.toString(),
          currency: 'IRT',
        });
      } else if (d.balanceMinor < 0n) {
        debts.push({
          record_type: 'legacy_debt',
          idempotency_key: `legacy:debt:${tg}`,
          legacy_user_id: tg,
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

  /**
   * Every service NEXA attached to a panel account: its panel, exact provider spelling and
   * owner's Telegram id. An ENDED service (TERMINATED: the one-time import's record of an
   * invoice whose account is not on the panel) is attached to no account, so it is not
   * listed — and every call checks that none of them names an account the panel holds.
   */
  async function services(): Promise<{ panel: string; username: string; owner: string }[]> {
    const read = (ended: boolean) =>
      ctx.container.database.db.execute<{
        panel: string;
        username: string;
        owner: string;
      }>(sql`
        SELECT CASE s.panel_id WHEN ${panelAId}::uuid THEN 'A' WHEN ${panelBId}::uuid THEN 'B'
               ELSE 'other' END AS panel,
               s.provider_username AS username, c.telegram_user_id AS owner
          FROM services s JOIN customers c ON c.id = s.customer_id
         WHERE s.tenant_id = ${TENANT} AND (s.state = 'TERMINATED') = ${ended}
         ORDER BY 1, 2`);
    for (const e of (await read(true)).rows) {
      const fake = e.panel === 'A' ? panelA : panelB;
      const spellings = [...fake.users.keys()].map((u) => u.toLowerCase());
      expect(spellings, `${e.panel}:${e.username} is ended, yet an account`).not.toContain(
        e.username.toLowerCase(),
      );
    }
    return (await read(false)).rows;
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

  /**
   * Every `GET /api/user/…` the panel received (an exact lookup or any per-user read), by
   * name. The targeted read decides from its walks alone and sends none.
   */
  const lookupsOf = (fake: FakeRickpanel, since = 0): string[] =>
    fake.requests
      .slice(since)
      .filter((r) => r.method === 'GET' && r.path.startsWith('/api/user/'))
      .map((r) => decodeURIComponent(r.path.slice('/api/user/'.length)));

  /**
   * `count` manual accounts at the FRONT of panel A's list (re-seeding the rest after them,
   * so every row keeps an oldest-first `created_at`), and a burst of `size` deletions of rows
   * the cursor already read before the 4th page of EVERY walk: no walk is gap-free.
   */
  function burstInEveryWalk(count: number, size = 2): void {
    const existing = [...panelA.users.values()];
    for (const u of existing) panelA.removeUser(u.username);
    for (let i = 0; i < count; i += 1) panelA.seedUser(`manual_${String(i).padStart(2, '0')}`);
    for (const u of existing) panelA.seedUser(u.username, { ...u });
    onWalkPages(panelA, (_walk, offset) => {
      if (offset !== 3) return;
      const front = [...panelA.users.keys()].filter((n) => n.startsWith('manual_'));
      for (const name of front.slice(0, size)) panelA.removeUser(name);
    });
  }

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
      materialize: ctx.container.legacyMaterializePort,
      botLink: ctx.container.legacyBotLinkPort,
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
   * The services the synthetic backup becomes on this target (owner rule 2026-10-18: a product
   * never blocks an account on a connected panel; an empty code is searched across them):
   * svc_a1, svc_a2 (a legacy product nobody mapped), svc_b1 on B (a custom shape with no
   * current tariff) and the panel-less svc_nullmatch, which only B holds — each on its one
   * account, its owner's. `gone` is unmapped here (no target selected).
   */
  const BASELINE_SERVICES = [
    { panel: 'A', username: 'svc_a1', owner: '100000001' },
    { panel: 'A', username: 'svc_a2', owner: '100000001' },
    { panel: 'B', username: 'svc_b1', owner: '100000009' },
    { panel: 'B', username: 'svc_nullmatch', owner: '100000002' },
  ];
  /** The baseline and `extra`, in the order `services()` reads them (panel, then name). */
  const withBaseline = (...extra: { panel: string; username: string; owner: string }[]) =>
    [...BASELINE_SERVICES, ...extra].sort((a, b) =>
      a.panel === b.panel
        ? a.username < b.username
          ? -1
          : a.username > b.username
            ? 1
            : 0
        : a.panel < b.panel
          ? -1
          : 1,
    );

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
    r.path === `/api/users?offset=${String(offset)}&limit=${String(PAGE_SIZE)}&sort=created_at`;

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
    // Decided from the gap-free last walk alone: no lookup, no canary.
    expect(w['PROVIDER_INVENTORY_LOOKUPS']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(Object.keys(w).filter((c) => c.startsWith('PROVIDER_INVENTORY_INCOMPLETE'))).toEqual([]);
    // The panel decided what a complete read decides: the missing account, the collision.
    // svc_missing and, matched like every invoice, the removed svc_old (owner decision 2026-10-17).
    // And the panel-less svc_nowhere, on no connected panel (owner rule 2026-10-18).
    expect(w['PROVIDER_MISSING']).toBe(3);
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    // A/B: no per-user request at all — never a manual account or a sale, nor the backup's
    // own names (svc_missing is absent because the gap-free last walk returned no spelling).
    expect(lookupsOf(panelA, before.a)).toEqual([]);
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
    // are candidates at all (21: the source's 19 live invoices and its two removed ones —
    // every invoice is matched, not only the live ones).
    const decided = await candidates();
    expect(Object.keys(decided)).toHaveLength(21);
    expect(decided['a0000001']).toEqual({
      outcome: 'ADOPTED',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    // Owner rule 2026-10-18: a legacy product nobody mapped never holds an account back.
    expect(decided['a000000f']).toEqual({
      outcome: 'ADOPTED',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    expect(decided['a0000008']).toEqual({
      outcome: 'USERNAME_CASE_COLLISION',
      holders: [{ panel: 'A', spellings: 2 }],
    });
    expect(decided['7c1f']).toEqual({ outcome: 'PROVIDER_MISSING', holders: [] });
    // A panel-less invoice is asked of every production panel; one holder (B) attaches it there
    // (owner rule 2026-10-18).
    expect(decided['1700001b2c3d4e5']).toEqual({
      outcome: 'ADOPTED',
      holders: [{ panel: 'B', spellings: 1 }],
    });
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

  it('D: a candidate account deleted mid-walk is absent from the gap-free last walk — PROVIDER_MISSING, never adopted, no lookup sent; the account after it is adopted', async () => {
    const page = productionLikePage();
    // A second eligible candidate: svc_a3, owned by user 9 (rp1, 30 GB / 30 d).
    const id = await page.toVerified(
      await writePackage({
        invoices: (rows) => [...rows, extraInvoice(rows, 'b0000003', '100000009', 'svc_a3')],
      }),
    );
    // During the first walk, after svc_a1 was served on page one, the operator deletes it:
    // every later row shifts up by one — which the page overlap absorbs.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.removeUser('svc_a1');
      // A sale in any third walk: the last two walks are never one complete snapshot, so the
      // per-name resolution is what decides.
      if (walk === 3 && offset === 2) panelA.seedUser('mirza_sale_d3', ACCOUNT);
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    // The second (last) walk is gap-free and returned no spelling of svc_a1 (deleted) or of
    // svc_missing (never there): both absent, decided from the walk alone — no lookup.
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect(w['PROVIDER_INVENTORY_LOOKUPS']).toBeUndefined();
    // And the panel-less svc_nowhere, on no connected panel (owner rule 2026-10-18).
    expect(w['PROVIDER_MISSING']).toBe(4);
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    expect((await detail(id)).status).toBe('COMPLETED');
    // The deleted account is not attached to anybody; the slipped-past one is, to its owner.
    const held = await services();
    // (svc_a1's account is the deleted one; the rest of the baseline is attached as ever.)
    expect(held).toEqual(
      withBaseline({ panel: 'A', username: 'svc_a3', owner: '100000009' }).filter(
        (x) => x.username !== 'svc_a1',
      ),
    );
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
    // svc_a1 is attached to nobody; the rest of the baseline is attached as ever (the
    // panel-less svc_shared invoice is held by both panels — AMBIGUOUS_PANEL, no claim).
    expect(held).toEqual(
      withBaseline({ panel: 'A', username: 'svc_shared', owner: '100000011' }).filter(
        (x) => x.username !== 'svc_a1',
      ),
    );
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

  it('F: no gap-free walk (a deletion burst behind the cursor in EVERY walk) — every needed name UNRESOLVED, never PROVIDER_MISSING: INVENTORY_INCOMPLETE, and the read decided nothing, so it is a failed read that blocks (review H P1), no per-user request', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    // A lookup route that would fail if it were asked: it is not.
    failOn(panelA, (r) => r.method === 'GET' && r.path.startsWith('/api/user/'), {
      status: 503,
      body: { detail: 'busy' },
    });
    burstInEveryWalk(8);
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    panelA.intercept = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED']).toBe(1);
    // svc_a1, svc_a2, svc_a4, svc_missing, and the three panel-less invoices' names (asked of
    // every production panel, for holder discovery); case_x is a collision whatever the walks
    // prove.
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(8);
    expect(w['INVENTORY_INCOMPLETE']).toBeGreaterThanOrEqual(4);
    expect(w['PROVIDER_MISSING']).toBeUndefined();
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    // Review H P1: no walk was gap-free, so the read decided nothing about panel A — a
    // whole-panel read failure, never a hold. (A read that HELD is the Q cases below.)
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED']).toBe(1);
    expect(w['PROVIDER_INVENTORY_QUARANTINED']).toBeUndefined();
    // Nothing held: a report holding nothing carries no hold or a hold of zero invoices.
    expect(dry.dryRunReport?.inventoryHold?.invoices ?? 0).toBe(0);
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
    });
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 600_000);

  it('F: a missing account (svc_missing) with no gap-free walk — UNRESOLVED, never PROVIDER_MISSING, even beside a route that answers 404 to everything (never asked); a failed read that blocks (review H P1), and nothing written by the dry run', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    failOn(panelA, (r) => r.method === 'GET' && r.path.startsWith('/api/user/'), {
      status: 404,
      body: { detail: 'Not Found' },
    });
    burstInEveryWalk(8);
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    panelA.intercept = null;
    expect(dry.status).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(lookupsOf(panelA, before)).toEqual([]);
    // Five mapped names (the removed svc_old is one: every invoice is matched) and the three
    // panel-less ones (see above).
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(8);
    expect(w['PROVIDER_MISSING']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED']).toBe(1);
    expect(w['PROVIDER_INVENTORY_QUARANTINED']).toBeUndefined();
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expect(await services()).toEqual([]);
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
    });
    expectReadsOnly(panelA);
  }, 600_000);

  // ── Q: the inventory hold beside decided names ─────────────────────────────────────────

  /**
   * svc_a3 (an extra eligible invoice, user 9) is DELETED and RE-CREATED on panel A between
   * the first and the second walk of every read: a name seen under two creation times is
   * another account, possibly another customer's — UNRESOLVED. Every other name is decided.
   */
  function recreateBetweenWalks(name: string): void {
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 0) {
        panelA.removeUser(name);
        panelA.seedUser(name, ACCOUNT);
      }
    });
  }
  const withSvcA3 = () =>
    writePackage({
      invoices: (rows) => [...rows, extraInvoice(rows, 'b0000003', '100000009', 'svc_a3')],
    });

  it('Q: one needed name unresolved beside decided ones — approvable; the apply writes customers and wallets (the negative balance a DEBIT opening), adopts ONLY the eligible invoice, and keeps the held one as an OPEN INVENTORY_INCOMPLETE candidate with no service', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await withSvcA3());
    panelA.seedUser('svc_a3', ACCOUNT);
    recreateBetweenWalks('svc_a3');
    const dry = await page.dryRun(id);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['INVENTORY_INCOMPLETE']).toBe(1);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(1);
    expect(w['PROVIDER_INVENTORY_QUARANTINED']).toBe(1);
    expect(Object.keys(w).filter((c) => c.startsWith('PROVIDER_INVENTORY_INCOMPLETE'))).toEqual([]);
    expect(dry.dryRunReport?.inventoryHold).toMatchObject({ version: 1, invoices: 1 });
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    expect((await page.approve(id)).status).toBe('APPROVED');

    // The apply's own read holds still (the hook fired in the dry run's second walk only), so
    // it RESOLVES svc_a3 — and the approved hold still quarantines it: the same plan.
    await page.executor.tick();
    panelA.beforeListPage = null;
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    // Money: every importable customer and every non-zero balance as ONE opening — the
    // positives as CREDITs, the negative one as a DEBIT of its magnitude — and no debt row.
    expect(await count('customers')).toBeGreaterThan(0);
    const openings = SYNTHETIC_EXPECTED.users.opening;
    expect(await count('wallet_entries')).toBe(openings.POSITIVE + openings.NEGATIVE);
    expect(await count('legacy_wallet_debts')).toBe(0);
    const ledger = (
      await ctx.container.database.db.execute<{
        tg: string;
        direction: string;
        reason: string;
        reference: string;
        amount: string;
      }>(
        sql`SELECT c.telegram_user_id AS tg, w.direction, w.reason, w.reference, w.amount::text AS amount
              FROM wallet_entries w JOIN customers c ON c.id = w.customer_id
             WHERE w.tenant_id = ${TENANT}`,
      )
    ).rows;
    expect(ledger.every((e) => e.reason === 'MIGRATION_OPENING_BALANCE')).toBe(true);
    expect(ledger.every((e) => e.reference === `legacy:opening:${e.tg}`)).toBe(true);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toEqual([
      expect.objectContaining({ tg: '100000003', amount: '20000' }),
    ]);
    // The wallets together are exactly the Mirza balances' signed sum.
    expect(
      ledger.reduce((a, e) => a + (e.direction === 'CREDIT' ? 1n : -1n) * BigInt(e.amount), 0n),
    ).toBe(SYNTHETIC_EXPECTED.users.legacyBalanceSumMinor);
    // Reconcile is decided under the same hold: the quarantine is no discrepancy.
    expect(done.progress.reconcileVerdict).toBe('RECONCILED');
    expect(
      { holds: done.applyReport?.reportHolds, failed: done.applyReport?.failedSections },
      JSON.stringify(done.applyReport?.failedInvariants),
    ).toEqual({ holds: true, failed: [] });
    // Only the decided, eligible invoice is a service; the held one is not.
    const held = await services();
    expect(held).toEqual(BASELINE_SERVICES);
    expectOneServicePerAccount(held);
    const decided = await candidates();
    expect(decided['a0000001']?.outcome).toBe('ADOPTED');
    // Its evidence shows the one account the apply's read found — for a person's review —
    // but the outcome is the quarantine, and no service names it.
    expect(decided['b0000003']).toEqual({
      outcome: 'INVENTORY_INCOMPLETE',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    const state = await ctx.container.database.db.execute<{ review_state: string }>(
      sql`SELECT review_state FROM legacy_service_candidates
           WHERE tenant_id = ${TENANT} AND invoice_key = 'b0000003'`,
    );
    expect(state.rows.map((r) => r.review_state)).toEqual(['OPEN']);
    // The approved hold is the one the apply run was started under.
    const inputs = await ctx.container.database.db.execute<{ digest: string; n: number }>(
      sql`SELECT i.inventory_hold_digest AS digest, jsonb_array_length(i.inventory_hold_keys) AS n
            FROM legacy_import_run_inputs i
           WHERE i.tenant_id = ${TENANT} AND i.run_id = ${done.applyLegacyRunId}`,
    );
    expect(inputs.rows).toEqual([{ digest: dry.dryRunReport?.inventoryHold?.digest, n: 1 }]);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 600_000);

  it('Q: a name ELIGIBLE at approval is unresolved at the apply — FAILED DRY_RUN_MISMATCH, nothing written', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await withSvcA3());
    panelA.seedUser('svc_a3', ACCOUNT);
    recreateBetweenWalks('svc_a3');
    const dry = await page.dryRun(id);
    expect(codes(dry.dryRunReport?.warnings)['PROVIDER_INVENTORY_QUARANTINED']).toBe(1);
    expect((await page.approve(id)).status).toBe('APPROVED');

    // At the apply, svc_a1 (eligible, adopted by the approved plan) is re-created between
    // walks too: unresolved now, and the approval never held it.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 0) {
        for (const name of ['svc_a3', 'svc_a1']) {
          panelA.removeUser(name);
          panelA.seedUser(name, ACCOUNT);
        }
      }
    });
    await page.executor.tick();
    panelA.beforeListPage = null;
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.applyLegacyRunId).toBeNull();
    const refusal = codes(failed.progress.refusalCounts);
    expect(refusal['apply:inventory_hold:unheld']).toBe(1);
    expect(refusal['dryrun:inventory_hold:unheld']).toBe(0);
    for (const table of [
      'customers',
      'wallet_entries',
      'legacy_wallet_debts',
      'services',
      'orders',
    ]) {
      expect(await count(table), table).toBe(0);
    }
    expectReadsOnly(panelA);
  }, 600_000);

  /**
   * The approved row's stored report, edited in place AFTER the approval (the executor binds
   * the approval to `dry_run_sha256`, not to a re-hash of the JSON): what an apply would meet
   * if a report reached it that carries no hold, or another one.
   */
  async function editApprovedReport(id: string, edit: string): Promise<void> {
    await ctx.container.database.db.execute(
      sql.raw(
        `UPDATE legacy_nxpkg_imports SET dry_run_report = ${edit} WHERE id = '${id}' AND tenant_id = '${TENANT}'`,
      ),
    );
  }

  it('Q: an apply handed NO hold that finds a name unresolved refuses DRY_RUN_MISMATCH — even where the plan digest would match — nothing written', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await withSvcA3());
    panelA.seedUser('svc_a3', ACCOUNT);
    recreateBetweenWalks('svc_a3');
    await page.dryRun(id);
    expect((await page.approve(id)).status).toBe('APPROVED');
    // The report as if it had held nothing and planned nothing undecided (so the TARGET
    // precheck lets it through): the importer's own gate is what is left.
    await editApprovedReport(
      id,
      `(dry_run_report - 'inventoryHold') || jsonb_build_object('warnings', COALESCE((SELECT jsonb_agg(w) FROM jsonb_array_elements(dry_run_report->'warnings') w WHERE w->>'code' NOT IN ('INVENTORY_INCOMPLETE', 'PROVIDER_INVENTORY_QUARANTINED')), '[]'::jsonb))`,
    );
    // The apply's read sees the same re-creation: svc_a3 unresolved again.
    recreateBetweenWalks('svc_a3');
    await page.executor.tick();
    panelA.beforeListPage = null;
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.applyLegacyRunId).toBeNull();
    for (const table of ['customers', 'wallet_entries', 'legacy_wallet_debts', 'services']) {
      expect(await count(table), table).toBe(0);
    }
  }, 600_000);

  it('Q: an apply handed a hold whose keys no dry run of this source recorded refuses DRY_RUN_MISMATCH — nothing written', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await withSvcA3());
    panelA.seedUser('svc_a3', ACCOUNT);
    recreateBetweenWalks('svc_a3');
    await page.dryRun(id);
    expect((await page.approve(id)).status).toBe('APPROVED');
    await editApprovedReport(
      id,
      `jsonb_set(dry_run_report, '{inventoryHold,digest}', to_jsonb('${'a'.repeat(64)}'::text))`,
    );
    panelA.beforeListPage = null;
    await page.executor.tick();
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.applyLegacyRunId).toBeNull();
    // Refused because the keys could not be read back under that digest — before any panel
    // read decided anything (not by the gate or the plan digest further on).
    expect(failed.progress.refusalCounts).toEqual([
      { code: 'dryrun:inventory_hold:verified', count: 1 },
      { code: 'apply:inventory_hold:verified', count: 0 },
    ]);
    for (const table of ['customers', 'wallet_entries', 'legacy_wallet_debts', 'services']) {
      expect(await count(table), table).toBe(0);
    }
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

  it('G: 401, 403, 429, 5xx and a timeout on a page of the FIRST or a LATER walk — bounded, fail-closed: not approvable, nothing written, nothing adopted', async () => {
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

      // ── on a page of the SECOND walk, after a first walk the panel moved under ──
      manualAccountMidWalk(`manual_${failure.name}`);
      let walkStarts = 0;
      panelA.intercept = (r) => {
        if (isListPage(0)(r)) walkStarts += 1;
        return walkStarts >= 2 && isListPage(2)(r) ? failure.answer : null;
      };
      before = panelA.requests.length;
      const later = await page.dryRun(id);
      panelA.intercept = null;
      panelA.beforeListPage = null;
      const laterSent = panelA.requests.slice(before);
      expect(later.status, failure.name).toBe('DRY_RUN_DONE');
      const lw = codes(later.dryRunReport?.warnings);
      expect(lw['PROVIDER_INVENTORY_INCOMPLETE'], failure.name).toBe(1);
      expect(lw['INVENTORY_INCOMPLETE'], failure.name).toBeGreaterThan(0);
      expect(lw['PROVIDER_MISSING'], failure.name).toBeUndefined();
      // Two walks started, the second stopped where it failed: bounded, no third walk.
      expect(laterSent.filter(isListPage(0)).length, failure.name).toBe(2);
      expect(laterSent.filter(isListPage(2)).length, failure.name).toBeLessThanOrEqual(
        failure.bound + 1,
      );
      expect(lookupsOf(panelA, before), failure.name).toEqual([]);
      await expect(page.approve(id), failure.name).rejects.toMatchObject({
        code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
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
    expect(refusal['dryrun:services:PROVIDER_MISSING']).toBe(3);
    expect(refusal['apply:services:PROVIDER_MISSING']).toBe(4);
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

  // ── §4b: the "adopt approved" lane ─────────────────────────────────────────────────────
  //
  // `docs/legacy-migration/service-review.md` §4b. After a COMPLETED import that quarantined a
  // name (the inventory hold), the operator approves the ADOPT and uploads the SAME package
  // again; instead of a dry run (refused FRESH_TARGET_NOT_EMPTY on an imported tenant) the
  // restore page asks the recovery role to execute the approvals. Only the approved candidates,
  // only the panels they name, every adoption check again, never a write to a panel.

  /** b0000003 (svc_a3, user 100000009) held INVENTORY_INCOMPLETE by a COMPLETED import. */
  async function importHoldingSvcA3(
    extra: (rows: Row[]) => Row[] = (rows) => rows,
    /** Further accounts the dry run must leave unresolved too (each re-created mid-read). */
    alsoHeld: readonly string[] = [],
  ): Promise<{
    page: ReturnType<typeof productionLikePage>;
    pkg: { path: string; keyFileText: string };
    applyRunId: string | null;
  }> {
    const page = productionLikePage();
    const pkg = await writePackage({
      invoices: (rows) => extra([...rows, extraInvoice(rows, 'b0000003', '100000009', 'svc_a3')]),
    });
    const id = await page.toVerified(pkg);
    const held = ['svc_a3', ...alsoHeld];
    for (const name of held) panelA.seedUser(name, ACCOUNT);
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 0) {
        for (const name of held) {
          panelA.removeUser(name);
          panelA.seedUser(name, ACCOUNT);
        }
      }
    });
    const dry = await page.dryRun(id);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    expect(codes(dry.dryRunReport?.warnings)['PROVIDER_INVENTORY_QUARANTINED']).toBeGreaterThan(0);
    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    panelA.beforeListPage = null;
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    expect((await candidates())['b0000003']?.outcome).toBe('INVENTORY_INCOMPLETE');
    return { page, pkg, applyRunId: done.applyLegacyRunId };
  }

  /** Every candidate row's review facts, by invoice key. */
  async function candidateRows(): Promise<Record<string, Record<string, unknown>>> {
    const result = await ctx.container.database.db.execute<Record<string, unknown>>(
      sql`SELECT invoice_key, id, outcome, review_state, version, last_approval_refusal,
                 service_id, approved_checksum, run_id, evidence_hash, updated_at::text AS updated_at
            FROM legacy_service_candidates WHERE tenant_id = ${TENANT} ORDER BY invoice_key`,
    );
    return Object.fromEntries(result.rows.map((r) => [String(r['invoice_key']), r]));
  }

  /** The operator's explicit ADOPT approval of one candidate (no panel: its code is mapped). */
  async function approveCandidate(invoiceKey: string): Promise<void> {
    const row = (await candidateRows())[invoiceKey];
    const approved = await ctx.container.legacyServiceReview.approveAdoption(
      tenantA,
      owner,
      String(row?.['id']),
      {
        idempotencyKey: key(),
        expectedVersion: Number(row?.['version']),
        reason: 'حساب در پنل پیدا شد',
      },
    );
    expect(approved.reviewState).toBe('ADOPT_APPROVED');
  }

  /** Customers, money (the ledger, openings included) and any debt row: what the lane must never touch. */
  async function moneyState(): Promise<Record<string, unknown>> {
    const one = async (q: ReturnType<typeof sql>) =>
      (await ctx.container.database.db.execute<Record<string, unknown>>(q)).rows[0];
    return {
      customers: await one(
        sql`SELECT count(*)::int AS n, md5(string_agg(id::text || status || updated_at::text, ',' ORDER BY id)) AS h
              FROM customers WHERE tenant_id = ${TENANT}`,
      ),
      wallet: await one(
        sql`SELECT count(*)::int AS n, md5(string_agg(id::text || direction || amount::text, ',' ORDER BY id)) AS h
              FROM wallet_entries WHERE tenant_id = ${TENANT}`,
      ),
      debts: await one(
        sql`SELECT count(*)::int AS n, md5(string_agg(id::text || state || version::text, ',' ORDER BY id)) AS h
              FROM legacy_wallet_debts WHERE tenant_id = ${TENANT}`,
      ),
      trials: await count('legacy_trial_eligibility'),
      shapes: await count('legacy_product_shapes'),
      userMap: await one(
        sql`SELECT count(*)::int AS n, md5(string_agg(legacy_id || status || run_id::text, ',' ORDER BY legacy_id)) AS h
              FROM legacy_import_map WHERE tenant_id = ${TENANT} AND legacy_table = 'user'`,
      ),
    };
  }

  /** The package uploaded again, verified, bound — and the lane requested and run once. */
  async function runLane(
    page: ReturnType<typeof productionLikePage>,
    pkg: { path: string; keyFileText: string },
  ): Promise<string> {
    const laneId = await page.toVerified(pkg);
    const requested = await ctx.container.legacyMigration.requestAdopt(tenantA, owner, laneId, {
      idempotencyKey: key(),
    });
    expect(requested.status).toBe('ADOPT_REQUESTED');
    await page.executor.tick();
    return laneId;
  }

  async function laneRuns(): Promise<{ mode: string; status: string }[]> {
    const result = await ctx.container.database.db.execute<{ mode: string; status: string }>(
      sql`SELECT mode, status FROM legacy_import_runs
           WHERE tenant_id = ${TENANT} AND mode = 'ADOPT_APPROVED' ORDER BY started_at`,
    );
    return result.rows;
  }

  it('§4b: a held invoice approved after the import is adopted by the lane once the targeted read resolves exactly one spelling — only it, only GETs of its one panel, no customer or money touched; the fresh-target guard still refuses another import', async () => {
    // b0000005: another held invoice (user 100000010, its own account), NOT approved. A still
    // panel read resolves it as well — and the lane must still leave it alone.
    const { page, pkg, applyRunId } = await importHoldingSvcA3(
      (rows) => [...rows, extraInvoice(rows, 'b0000005', '100000010', 'svc_held_2')],
      ['svc_held_2'],
    );
    expect((await candidates())['b0000005']?.outcome).toBe('INVENTORY_INCOMPLETE');
    await approveCandidate('b0000003');
    const before = await candidateRows();
    const money = await moneyState();
    const requestsB = panelB.requests.length;
    const listsA = panelA.listCalls();

    const laneId = await runLane(page, pkg);
    const lane = await detail(laneId);
    expect(lane.status, JSON.stringify([lane.errorCode, lane.progress])).toBe('ADOPT_DONE');
    expect(lane.adoptReport).toMatchObject({
      verdict: 'COMPLETED',
      importLegacyRunId: applyRunId,
      approvals: 1,
      adopted: 1,
      stillUnresolved: 0,
      refused: [],
      left: [],
      panelsRead: 1,
      providerWrites: 0,
    });
    expect(lane.adoptLegacyRunId).toBe(lane.adoptReport?.legacyRunId);
    expect(await laneRuns()).toEqual([{ mode: 'ADOPT_APPROVED', status: 'COMPLETED' }]);
    // The held invoice is now the service of exactly its one account, its owner's.
    const held = await services();
    expect(held).toEqual(withBaseline({ panel: 'A', username: 'svc_a3', owner: '100000009' }));
    expectOneServicePerAccount(held);
    const after = await candidateRows();
    expect(after['b0000003']).toMatchObject({
      outcome: 'ADOPTED',
      review_state: 'ADOPTED',
      last_approval_refusal: null,
      approved_checksum: null,
    });
    expect(after['b0000003']?.['service_id']).not.toBeNull();
    // Every other candidate exactly as the import left it.
    for (const [invoiceKey, row] of Object.entries(before)) {
      if (invoiceKey === 'b0000003') continue;
      expect(after[invoiceKey], invoiceKey).toEqual(row);
    }
    // No customer, wallet, debt, trial, shape or user map row changed.
    expect(await moneyState()).toEqual(money);
    // The targeted read: panel A (svc_a3's one panel) only, by its walks; nothing else asked.
    expect(panelA.listCalls()).toBeGreaterThan(listsA);
    expect(panelB.requests.length).toBe(requestsB);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
    // Audited: the execution, codes and ids only.
    const executed = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE tenant_id = ${TENANT} AND action = 'legacy.service_candidate.approval_executed'`,
    );
    expect(executed.rows[0]?.n).toBe(1);

    // The fresh-target guard is unchanged: the same package again is refused a dry run, and
    // the importer's own check says the tenant is not fresh.
    const again = await page.toVerified(pkg);
    const refused = await page.dryRun(again);
    expect(refused).toMatchObject({
      status: 'DRY_RUN_FAILED',
      errorCode: 'FRESH_TARGET_NOT_EMPTY',
    });
    const fresh = await ctx.container.legacyImporter().freshTarget(tenantA, null);
    expect(fresh.fresh).toBe(false);
  }, 900_000);

  // A real Mirza package (2026-10-16): ~N of ~M candidates on the real panel's code name a
  // legacy product nobody maps. Owner rule 2026-10-18: no /legacy-products decision, no ADOPT
  // approval, no second upload — the import itself attaches such an invoice, its order naming
  // the hidden product of its shape for navigation only.
  it('a NAMED legacy product nobody mapped is attached by the import itself — no product decision, no ADOPT approval, no lane', async () => {
    await importHoldingSvcA3();
    // a000000f: svc_a2 (user 100000001), legacy product p1, 30 GB / 30 d, on panel A.
    expect((await candidateRows())['a000000f']).toMatchObject({
      outcome: 'ADOPTED',
      review_state: 'ADOPTED',
    });
    expect(await services()).toEqual(BASELINE_SERVICES);
    const named = (
      await ctx.container.database.db.execute<{ shaped: boolean }>(
        sql`SELECT EXISTS (SELECT 1 FROM legacy_product_shapes sh
                            WHERE sh.tenant_id = s.tenant_id AND sh.product_id = s.product_id)
                     AS shaped
              FROM services s
             WHERE s.tenant_id = ${TENANT} AND s.provider_username = 'svc_a2'`,
      )
    ).rows;
    expect(named).toEqual([{ shaped: true }]);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 900_000);

  it('§4b: an approved name the targeted read still cannot decide is settled back to OPEN with INVENTORY_INCOMPLETE — nothing adopted, nothing else touched', async () => {
    const { page, pkg } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    const before = await candidateRows();
    const money = await moneyState();
    // svc_a3 is re-created between the lane's own two walks: still unresolved.
    recreateBetweenWalks('svc_a3');
    const laneId = await runLane(page, pkg);
    panelA.beforeListPage = null;
    const lane = await detail(laneId);
    expect(lane.status, JSON.stringify(lane.errorCode)).toBe('ADOPT_DONE');
    // Still unresolved is not done: the verdict says so (adopt-lane review P2-4).
    expect(lane.adoptReport).toMatchObject({
      verdict: 'COMPLETED_WITH_FAILURES',
      approvals: 1,
      adopted: 0,
      stillUnresolved: 1,
      refused: [{ code: 'INVENTORY_INCOMPLETE', count: 1 }],
    });
    const after = await candidateRows();
    expect(after['b0000003']).toMatchObject({
      outcome: 'INVENTORY_INCOMPLETE',
      review_state: 'OPEN',
      last_approval_refusal: 'INVENTORY_INCOMPLETE',
      service_id: null,
    });
    for (const [invoiceKey, row] of Object.entries(before)) {
      if (invoiceKey === 'b0000003') continue;
      expect(after[invoiceKey], invoiceKey).toEqual(row);
    }
    expect(await services()).toEqual(BASELINE_SERVICES);
    expect(await moneyState()).toEqual(money);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 900_000);

  it("§4b: another owner's invoice naming the same account makes the approved one AMBIGUOUS_OWNERSHIP — nothing adopted; the unapproved claim is untouched", async () => {
    // b0000004: user 100000010's invoice naming the same account, held by the same import.
    const { page, pkg } = await importHoldingSvcA3((rows) => [
      ...rows,
      extraInvoice(rows, 'b0000004', '100000010', 'svc_a3'),
    ]);
    expect((await candidates())['b0000004']?.outcome).toBe('INVENTORY_INCOMPLETE');
    await approveCandidate('b0000003');
    const before = await candidateRows();
    const money = await moneyState();
    const laneId = await runLane(page, pkg);
    const lane = await detail(laneId);
    expect(lane.status, JSON.stringify(lane.errorCode)).toBe('ADOPT_DONE');
    expect(lane.adoptReport).toMatchObject({
      approvals: 1,
      adopted: 0,
      stillUnresolved: 0,
      refused: [{ code: 'AMBIGUOUS_OWNERSHIP', count: 1 }],
    });
    const after = await candidateRows();
    expect(after['b0000003']).toMatchObject({
      review_state: 'OPEN',
      last_approval_refusal: 'AMBIGUOUS_OWNERSHIP',
      service_id: null,
    });
    // The other owner's (unapproved) candidate is exactly as it was.
    expect(after['b0000004']).toEqual(before['b0000004']);
    expect(await services()).toEqual(BASELINE_SERVICES);
    expect(await moneyState()).toEqual(money);
    expectReadsOnly(panelA);
  }, 900_000);

  it('§4b review P2-4: a lane run left RUNNING after its approvals settled (a crash before it finished) is resumed and finished by the next lane — never NOTHING_TO_ADOPT, never left RUNNING, nothing adopted twice', async () => {
    const { page, pkg } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    const firstId = await runLane(page, pkg);
    const first = await detail(firstId);
    expect(first.adoptReport).toMatchObject({ verdict: 'COMPLETED', adopted: 1 });
    const laneRunId = first.adoptReport?.legacyRunId;
    expect(laneRunId).toEqual(expect.any(String));
    // The crash: the approval settled ADOPTED, the run never reached COMPLETED.
    await ctx.container.database.db.execute(
      sql`UPDATE legacy_import_runs SET status = 'RUNNING', finished_at = NULL
           WHERE tenant_id = ${TENANT} AND id = ${laneRunId as string}`,
    );
    const held = await services();
    const money = await moneyState();

    const againId = await runLane(page, pkg);
    const again = await detail(againId);
    expect(again.status, JSON.stringify(again.errorCode)).toBe('ADOPT_DONE');
    expect(again.adoptReport).toMatchObject({
      verdict: 'COMPLETED',
      legacyRunId: laneRunId,
      approvals: 0,
      adopted: 0,
      providerWrites: 0,
    });
    expect(await laneRuns()).toEqual([{ mode: 'ADOPT_APPROVED', status: 'COMPLETED' }]);
    expect(await services()).toEqual(held);
    expect(await moneyState()).toEqual(money);
    expectReadsOnly(panelA);
  }, 900_000);

  it('§4b: the lane waits — cancellable, nothing read or adopted — while another run is RUNNING, and while any import holds the installation-wide write freeze; then it runs', async () => {
    const { page, pkg } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    // Prepared before the freeze below (which refuses every durable write but its own).
    const otherOwner = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-lane', roleKeys: ['owner'] }),
    );
    const laneId = await page.toVerified(pkg);
    await ctx.container.legacyMigration.requestAdopt(tenantA, owner, laneId, {
      idempotencyKey: key(),
    });
    const lists = panelA.listCalls();

    // 1. Another run RUNNING on the tenant (an operator's dry run, say).
    const runId = '01900000-0000-7000-8000-0000000ad001';
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint, started_at, last_progress_at)
      VALUES (${runId}, ${TENANT}, 'DRY_RUN', 'RUNNING', ${'e'.repeat(64)}, now(), now())`);
    await page.executor.tick();
    let waiting = await detail(laneId);
    expect(waiting.status).toBe('ADOPT_REQUESTED');
    expect(waiting.progress.adoptAttempts).toBe(0);
    expect((await candidateRows())['b0000003']?.['review_state']).toBe('ADOPT_APPROVED');
    expect(panelA.listCalls()).toBe(lists);
    expect(await laneRuns()).toEqual([]);
    await ctx.container.database.db.execute(
      sql`UPDATE legacy_import_runs SET status = 'ABORTED', finished_at = now() WHERE id = ${runId}`,
    );

    // 2. Another tenant's import APPLYING: the installation is frozen for every writer but it.
    const applyingId = '01900000-0000-7000-8000-0000000ad002';
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, progress,
         approved_dry_run_sha256, approved_by_admin_id, approved_at, pre_import_backup_run_id,
         requested_by_admin_id, created_at, updated_at)
      VALUES (${applyingId}, ${String(tenantB.tenantId)}, 'APPLYING', 'b.nxpkg', '/nowhere',
              ${'7'.repeat(64)}, 1, '{}'::jsonb, ${'7'.repeat(64)}, ${String(otherOwner.id)}, now(),
              '01900000-0000-7000-8000-0000000ad003', ${String(otherOwner.id)}, now(), now())`);
    await page.executor.tick();
    waiting = await detail(laneId);
    expect(waiting.status).toBe('ADOPT_REQUESTED');
    expect(waiting.progress.blocker).toBe('ANOTHER_IMPORT_APPLYING');
    expect((await candidateRows())['b0000003']?.['review_state']).toBe('ADOPT_APPROVED');
    expect(panelA.listCalls()).toBe(lists);
    expect(await laneRuns()).toEqual([]);
    // That import ends (rows are never deleted): the freeze lifts.
    await ctx.container.database.db.execute(
      sql`UPDATE legacy_nxpkg_imports
             SET status = 'FAILED', error_code = 'IMPORT_FAILED', finished_at = now(), updated_at = now()
           WHERE id = ${applyingId}`,
    );

    // 3. The tenant stopped accepting work: every write the lane would make is refused inside
    //    its transaction — no run, no claim, no adoption.
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${TENANT}`,
    );
    await page.executor.tick();
    expect((await candidateRows())['b0000003']?.['review_state']).toBe('ADOPT_APPROVED');
    expect(await laneRuns()).toEqual([]);
    expect(await services()).toEqual(BASELINE_SERVICES);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${TENANT}`,
    );

    // 4. Nothing in the way: the lane runs and adopts.
    await page.executor.tick();
    const done = await detail(laneId);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('ADOPT_DONE');
    expect(done.adoptReport).toMatchObject({ adopted: 1, approvals: 1 });
    expect(await services()).toEqual(
      withBaseline({ panel: 'A', username: 'svc_a3', owner: '100000009' }),
    );
    expectReadsOnly(panelA);
  }, 900_000);

  it('§4b: a re-upload bound to OTHER panels than its import is refused ADOPT_REFUSED — no panel read, no claim, nothing adopted', async () => {
    const { page, pkg } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    const service = ctx.container.legacyMigration;
    const laneId = await upload(pkg.path);
    await service.setKey(tenantA, owner, laneId, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await page.executor.tick();
    // The two codes bound the other way round: another panel map than the import's.
    await service.setPanelBindings(tenantA, owner, laneId, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelBId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelAId },
      ],
    });
    await service.requestAdopt(tenantA, owner, laneId, { idempotencyKey: key() });
    const lists = panelA.listCalls() + panelB.listCalls();
    await page.executor.tick();
    expect(await detail(laneId)).toMatchObject({ status: 'FAILED', errorCode: 'ADOPT_REFUSED' });
    expect(panelA.listCalls() + panelB.listCalls()).toBe(lists);
    expect((await candidateRows())['b0000003']?.['review_state']).toBe('ADOPT_APPROVED');
    expect(await laneRuns()).toEqual([]);
    expect(await services()).toEqual(BASELINE_SERVICES);
  }, 900_000);

  it('§4b: the lane is refused for a source no finished import came from, and asks nothing of a panel', async () => {
    const page = productionLikePage();
    const id = await page.toVerified(await writePackage());
    const before = panelA.requests.length + panelB.requests.length;
    await expect(
      ctx.container.legacyMigration.requestAdopt(tenantA, owner, id, { idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: LEGACY_MIGRATION_HTTP_ERROR_CODES.NO_COMPLETED_IMPORT });
    expect((await detail(id)).status).toBe('VERIFIED');
    expect(panelA.requests.length + panelB.requests.length).toBe(before);
    expect(await laneRuns()).toEqual([]);
  }, 600_000);

  // ── §4b review: the guards 65d238de added without a test ───────────────────────────────

  /** Nothing the lane must not do happened: no read, no run, no claim, no service. */
  async function expectLaneRefusedUntouched(
    laneId: string,
    lists: number,
    before: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    expect(await detail(laneId)).toMatchObject({ status: 'FAILED', errorCode: 'ADOPT_REFUSED' });
    expect(panelA.listCalls() + panelB.listCalls()).toBe(lists);
    expect(await laneRuns()).toEqual([]);
    expect(await candidateRows()).toEqual(before);
    expect(await services()).toEqual(BASELINE_SERVICES);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }

  it('§4b review: the lane is bound to the import the restore page names — an import row whose apply run is not the tenant’s latest APPLY run is refused ADOPT_REFUSED (expectedApplyRunId), nothing read or claimed', async () => {
    const { page, pkg, applyRunId } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    // The restore page's import row now names ANOTHER run of this tenant (its own dry run):
    // the importer's latest APPLY run is not the one the lane was asked to follow.
    const updated = await ctx.container.database.db.execute<{ id: string }>(
      sql`UPDATE legacy_nxpkg_imports SET apply_legacy_run_id = dry_run_legacy_run_id
           WHERE tenant_id = ${TENANT} AND status = 'COMPLETED' AND apply_legacy_run_id = ${applyRunId}
             AND dry_run_legacy_run_id IS NOT NULL
       RETURNING id`,
    );
    expect(updated.rows).toHaveLength(1);
    const before = await candidateRows();
    const lists = panelA.listCalls() + panelB.listCalls();
    const laneId = await page.toVerified(pkg);
    await ctx.container.legacyMigration.requestAdopt(tenantA, owner, laneId, {
      idempotencyKey: key(),
    });
    await page.executor.tick();
    await expectLaneRefusedUntouched(laneId, lists, before);
  }, 900_000);

  it('§4b review: the lane follows a .nxpkg import only — an APPLY run whose recorded inputs are not NXPKG is refused ADOPT_REFUSED, nothing read or claimed', async () => {
    const { page, pkg, applyRunId } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    const updated = await ctx.container.database.db.execute<{ run_id: string }>(
      sql`UPDATE legacy_import_run_inputs SET source_engine = 'MYSQL'
           WHERE tenant_id = ${TENANT} AND run_id = ${applyRunId} RETURNING run_id`,
    );
    expect(updated.rows).toHaveLength(1);
    const before = await candidateRows();
    const lists = panelA.listCalls() + panelB.listCalls();
    const laneId = await page.toVerified(pkg);
    await ctx.container.legacyMigration.requestAdopt(tenantA, owner, laneId, {
      idempotencyKey: key(),
    });
    await page.executor.tick();
    await expectLaneRefusedUntouched(laneId, lists, before);
  }, 900_000);

  it('§4b review (H P1): a targeted read with NO gap-free walk decides nothing in the lane — an approved name it saw under two spellings is INVENTORY_INCOMPLETE, never decided as a collision; nothing adopted', async () => {
    const { page, pkg } = await importHoldingSvcA3();
    await approveCandidate('b0000003');
    const money = await moneyState();
    // A case variant of the approved name, and a deletion burst behind the cursor in every
    // walk of the lane's read: two spellings were seen, but no walk was gap-free.
    panelA.seedUser('SVC_A3', ACCOUNT);
    burstInEveryWalk(8);
    const laneId = await runLane(page, pkg);
    panelA.beforeListPage = null;
    const lane = await detail(laneId);
    expect(lane.status, JSON.stringify(lane.errorCode)).toBe('ADOPT_DONE');
    expect(lane.adoptReport).toMatchObject({
      approvals: 1,
      adopted: 0,
      stillUnresolved: 1,
      refused: [{ code: 'INVENTORY_INCOMPLETE', count: 1 }],
      panelsRead: 1,
      providerWrites: 0,
    });
    expect((await candidateRows())['b0000003']).toMatchObject({
      review_state: 'OPEN',
      last_approval_refusal: 'INVENTORY_INCOMPLETE',
      service_id: null,
    });
    expect(await services()).toEqual(BASELINE_SERVICES);
    expect(await moneyState()).toEqual(money);
    expectReadsOnly(panelA);
    expectReadsOnly(panelB);
  }, 900_000);
});
