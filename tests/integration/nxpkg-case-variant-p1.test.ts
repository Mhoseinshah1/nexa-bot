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
  legacyMigrationDryRunInventoryIncomplete,
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
import {
  INVENTORY_READ_ATTEMPTS,
  walkOverlap,
} from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
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
  type FakeRickpanelRequest,
  type FakeRickpanelUser,
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
 * P1 (#283) regression: NO presence and NO absence without a GAP-FREE last walk, end to end
 * through the Web Admin's `.nxpkg` restore page on a PRODUCTION-LIKE target
 * (`docs/rickpanel-inventory.md` §Per-name resolution). The targeted read decides from its
 * walks alone (at most three; no exact lookup, no canary): it sends no `GET /api/user/…`.
 * Each case is one of the owner's requirements for the case-variant residual:
 *
 *   R1 a case variant on the panel, seen by a gap-free walk → USERNAME_CASE_COLLISION; one
 *      inserted behind the cursor DURING a walk (the Codex P1) → still a collision
 *   R2 every walk loses rows (bursts larger than the overlap) → UNRESOLVED, quarantined;
 *      over a quieter panel the same package is approvable and adopts onto its own owners
 *   R3 a missing account: gap-free → PROVIDER_MISSING; no gap-free walk → UNRESOLVED
 *   R4 an unstable list order while the panel changes → nothing PRESENT/ABSENT, quarantined
 *      (refused when the order depends on the offset: that read FAILED)
 *
 * An UNRESOLVED name is never attached to anyone. Since the inventory hold its invoice is
 * QUARANTINED (history and an open review candidate) instead of refusing the whole import: the
 * dry run is approvable, records the hold, and the apply adopts none of the held invoices
 * (`nxpkg-live-panel-inventory.test.ts` F and Q run those applies).
 *   R5 a case-insensitive lookup route → never asked; the complete read's decision
 *   R6 the APPLY's own read loses its gap-freeness → the apply refuses, nothing written
 *   R7 normal selling (appends + single deletions within the overlap, both walks) → approvable
 *
 * Every case asserts the owner of every service NEXA holds (never a wrong customer), and that
 * only reads (GETs and the token exchange) ever reached a panel.
 *
 * The page size is per case: 2 (overlap 1, `walkOverlap(2)`) on the seven-account synthetic
 * panel; 8 (overlap 2) where a SINGLE deletion behind the cursor must be absorbed — at overlap
 * 1 any deletion behind the cursor breaks the chain, which is the burst case, not selling.
 *
 * SYNTHETIC data only, fake RickPanels on loopback sockets. NOT EVIDENCE about a real panel.
 */

const TENANT = SEED_IDS.tenantA as unknown as string;
const LIVE = new Set(['active', 'disabled', 'disabledn', 'disablebyadmin', 'end_of_volume']);

type Dataset = ReturnType<typeof buildSyntheticLegacyDataset>;
type Row = Record<string, string | null>;
type Held = { panel: string; username: string; owner: string };

describe('P1: no presence and no absence without a gap-free walk (Web Admin .nxpkg, production-like)', () => {
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
  const key = () => `p1-gapfree-${String((keys += 1))}-${String(Date.now())}`;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'p1-gapfree-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'p1-gapfree-root-'));
    backupRoot = await mkdtemp(join(tmpdir(), 'p1-gapfree-backup-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: backupRoot,
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
      idempotencyKey: `p1-gapfree-panel-${name}`,
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
        await createAdmin(ctx.container, tenantA, { username: 'owner-p1', roleKeys: ['owner'] }),
      ),
    };
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
    // The current public tariff the 30 GB / 30 d hidden shapes resolve to (ADOPTION_ELIGIBLE).
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

  // ── the package (as tests/integration/nxpkg-live-panel-inventory.test.ts builds it) ────

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

  async function writePackage(
    options: { readonly invoices?: (rows: Row[]) => Row[] } = {},
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
    const ownership = {
      'records/service_ownership.jsonl': {
        records: (dataset.tables['invoice'] as Row[])
          .filter((i) => LIVE.has(i['Status'] ?? ''))
          .map((i) => ({
            record_type: 'legacy_service_ownership',
            schema: 'mirza.service_ownership.v1',
            idempotency_key: `legacy:service-ownership:${i['id_invoice'] ?? ''}`,
            invoice_key: i['id_invoice'],
            ownership_decision: 'CONFIRMED_CURRENT_OWNER',
            final_owner_telegram_user_id: i['id_user'] ?? null,
            provision: false,
            applies_to_live_state: false,
            affects_wallet: false,
            creates_payment: false,
          })),
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

  /** A live 30 GB / 30 d invoice on rp1 (panel A) for `idUser`, named `username`. */
  const extraInvoice = (rows: Row[], id: string, idUser: string, username: string): Row => ({
    ...(rows.find((r) => r['username'] === 'svc_a1' && r['id_user'] === '100000001') as Row),
    id_invoice: id,
    id_user: idUser,
    username,
  });

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
   * owner's Telegram id. An ENDED service (TERMINATED, the one-time import's record of an
   * invoice whose account is not on the panel) is attached to no account, so it is not here;
   * `endedServices` holds those.
   */
  async function services(ended = false): Promise<Held[]> {
    const result = await ctx.container.database.db.execute<Held>(sql`
      SELECT CASE s.panel_id WHEN ${panelAId}::uuid THEN 'A' WHEN ${panelBId}::uuid THEN 'B'
             ELSE 'other' END AS panel,
             s.provider_username AS username, c.telegram_user_id AS owner
        FROM services s JOIN customers c ON c.id = s.customer_id
       WHERE s.tenant_id = ${TENANT} AND (s.state = 'TERMINATED') = ${ended}
       ORDER BY 1, 2`);
    return result.rows;
  }

  /**
   * The owner of every account NEXA attached, checked against the backup's own invoice for
   * that account (`expected`: `panel:spelling` → Telegram id). A service on an account not in
   * `expected`, or held by anybody else, is a wrong attachment; one account is held once.
   */
  async function expectOwners(expected: Readonly<Record<string, string>>): Promise<void> {
    const held = await services();
    const accounts = held.map((s) => `${s.panel}:${s.username.toLowerCase()}`);
    expect(new Set(accounts).size, 'one service per account').toBe(accounts.length);
    const actual = Object.fromEntries(held.map((s) => [`${s.panel}:${s.username}`, s.owner]));
    expect(actual).toEqual(expected);
    // An ended service never stands for an account the panel holds (any spelling of it).
    for (const s of await services(true)) {
      const fake = s.panel === 'A' ? panelA : panelB;
      const spellings = [...fake.users.keys()].map((u) => u.toLowerCase());
      expect(spellings, `${s.panel}:${s.username} is ended, yet an account`).not.toContain(
        s.username.toLowerCase(),
      );
    }
    for (const s of held) {
      const fake = s.panel === 'A' ? panelA : panelB;
      expect(fake.users.has(s.username), `${s.panel}:${s.username} is an account`).toBe(true);
    }
  }

  /** Only reads ever reached the panel: GETs and the token exchange. */
  function expectReadsOnly(...fakes: FakeRickpanel[]): void {
    for (const fake of fakes) {
      expect(
        fake.requests.filter(
          (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
        ),
      ).toEqual([]);
    }
  }

  /**
   * Every `GET /api/user/…` the panel received (an exact lookup, or any per-user read). The
   * targeted read decides from its walks alone and sends none.
   */
  const lookupsOf = (fake: FakeRickpanel, since = 0): string[] =>
    fake.requests
      .slice(since)
      .filter((r) => r.method === 'GET' && r.path.startsWith('/api/user/'))
      .map((r) => decodeURIComponent(r.path.slice('/api/user/'.length)));

  /** How many walks of panel A started (a list page at offset 0) since `since`. */
  const walksOf = (fake: FakeRickpanel, since = 0): number =>
    fake.requests
      .slice(since)
      .filter((r) => r.method === 'GET' && /^\/api\/users\?offset=0&/u.test(r.path)).length;

  /** `fn(walk, offset)` before every list page; a page at offset 0 starts a walk. */
  function onWalkPages(fake: FakeRickpanel, fn: (walk: number, offset: number) => void): void {
    let walk = 0;
    fake.beforeListPage = (offset) => {
      if (offset === 0) walk += 1;
      fn(walk, offset);
    };
  }

  /** Rebuilds the panel's list in `order` (same accounts, same records, new list order). */
  function reorder(fake: FakeRickpanel, order: readonly string[]): void {
    const held = order.map((n) => fake.users.get(n) as FakeRickpanelUser);
    for (const name of [...fake.users.keys()]) fake.removeUser(name);
    for (const u of held) {
      fake.seedUser(u.username, {
        status: u.status,
        expire: u.expire,
        dataLimit: u.dataLimit,
        usedTraffic: u.usedTraffic,
        onlineAt: u.onlineAt,
        proxies: u.proxies,
        subToken: u.subToken,
      });
    }
  }

  /** `count` manual accounts (names no backup row holds) put at the FRONT of the list. */
  function manualFront(fake: FakeRickpanel, count: number): void {
    const existing = [...fake.users.keys()];
    for (let i = 0; i < count; i += 1)
      fake.seedUser(`manual_${String(i).padStart(2, '0')}`, ACCOUNT);
    reorder(fake, [...[...fake.users.keys()].filter((n) => !existing.includes(n)), ...existing]);
  }

  /** Deletes the first `n` manual accounts still on the panel (rows the cursor already read). */
  function deleteFrontManual(fake: FakeRickpanel, n: number): number {
    const victims = [...fake.users.keys()].filter((u) => u.startsWith('manual_')).slice(0, n);
    for (const v of victims) fake.removeUser(v);
    return victims.length;
  }

  // ── the restore page, production-like, with the Web Admin's importer ───────────────────

  const detail = (id: string) => ctx.container.legacyMigration.detail(tenantA, owner, id);
  const codes = (rows: readonly { code: string; count: number }[] | undefined) =>
    Object.fromEntries((rows ?? []).map((w) => [w.code, w.count]));

  function productionLikePage(pageSize: number) {
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
    const adapters = new NxpkgMigrationAdapters({
      db: container.database.db,
      importer: (signal) =>
        container.legacyImporter({
          inventoryPageSize: pageSize,
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
      correlation: () => 'corr-p1-gapfree' as CorrelationId,
      leaseOwner: 'recovery:p1-gapfree',
      tickIntervalMs: 1000,
      enabled: true,
      logger: quiet,
    });
    const service = container.legacyMigration;
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

  /** Each backup invoice's candidate after an apply: outcome and holders. */
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

  /**
   * An import whose dry run left needed names unresolved by a read that HELD: no whole-panel
   * failure, every `INVENTORY_INCOMPLETE` invoice in the recorded inventory hold
   * (quarantined), so the contract rule the approval applies does not refuse it. The approval
   * itself is not made here: these cases dry-run the same import again afterwards.
   */
  async function expectQuarantinedNotBlocking(id: string): Promise<void> {
    const report = (await detail(id)).dryRunReport;
    const w = codes(report?.warnings);
    expect(Object.keys(w).filter((c) => c.startsWith('PROVIDER_INVENTORY_INCOMPLETE'))).toEqual([]);
    expect(w['INVENTORY_INCOMPLETE']).toBeGreaterThan(0);
    expect(report?.inventoryHold?.invoices).toBe(w['INVENTORY_INCOMPLETE']);
    expect(w['PROVIDER_INVENTORY_QUARANTINED']).toBe(w['INVENTORY_INCOMPLETE']);
    expect(legacyMigrationDryRunInventoryIncomplete(report?.warnings, report?.inventoryHold)).toBe(
      0,
    );
    // The same report as a release before the hold stored it (no marker) is refused.
    expect(legacyMigrationDryRunInventoryIncomplete(report?.warnings)).toBe(1);
  }

  /**
   * Review H P1: a per-name read that found NO gap-free walk decided nothing about the panel, so
   * it is a whole-panel read failure — reported `PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED`, no
   * hold recorded anywhere, and the approval refused exactly as before the hold existed.
   */
  async function expectBlockedNoDecisionWalk(id: string): Promise<void> {
    const report = (await detail(id)).dryRunReport;
    const w = codes(report?.warnings);
    expect(w['PROVIDER_INVENTORY_INCOMPLETE']).toBe(1);
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:UNRESOLVED']).toBe(1);
    expect(w['INVENTORY_INCOMPLETE']).toBeGreaterThan(0);
    // Nothing held: a report holding nothing carries no hold or a hold of zero invoices.
    expect(report?.inventoryHold?.invoices ?? 0).toBe(0);
    expect(w['PROVIDER_INVENTORY_QUARANTINED']).toBeUndefined();
    expect(
      legacyMigrationDryRunInventoryIncomplete(report?.warnings, report?.inventoryHold),
    ).toBeGreaterThan(0);
  }

  /**
   * The names the backup needs on panel A (real, importable owner, rp1): svc_a1, svc_a2 (a
   * named product nobody mapped — attached all the same, owner rule 2026-10-18), svc_a4
   * (unsupported shape), case_x (Case_X and case_x on the panel: a collision whatever the walks
   * prove), svc_missing (no account) and, since every invoice is matched against the panel
   * (owner decision 2026-10-17), svc_old — the removed invoice, whose account is not there
   * either. The three panel-less invoices' names are asked of every connected panel too, and
   * since owner rule 2026-10-18 they are DECIDED by that search: without a gap-free walk of A
   * none of them can be (B alone is not every connected panel).
   *
   * So without a gap-free walk: every needed NAME but the collision is UNRESOLVED (five of A's
   * own, plus the three panel-less), and so is every one of those INVOICES.
   */
  const UNRESOLVED_WITHOUT_GAP_FREE = 8;
  const NAMES_UNRESOLVED_WITHOUT_GAP_FREE = 8;
  /**
   * The accounts a gap-free read finds absent: `svc_missing` (live) and `svc_old` (a removed
   * invoice, matched against the panel like any other — owner decision 2026-10-17). The
   * panel-less `svc_nowhere`, which no connected panel holds, is NO_PANEL (owner rule
   * 2026-10-18: archived exactly as an unmapped code is).
   */
  const PROVIDER_MISSING_INVOICES = 2;

  /**
   * What the synthetic backup attaches when panel A is read gap-free (owner rule 2026-10-18):
   * svc_a1, svc_a2 (its product unmapped), svc_b1 on B (a custom shape with no current
   * tariff), and the panel-less svc_nullmatch, which only B holds — each on its own owner.
   */
  const BASELINE = {
    'A:svc_a1': '100000001',
    'A:svc_a2': '100000001',
    'B:svc_b1': '100000009',
    'B:svc_nullmatch': '100000002',
  } as const;

  /** The most walks one targeted read of a panel makes (a non-gap-free last walk walks again). */
  const MAX_WALKS = 3;

  /**
   * Takes over panel A's list route: each page is served from the panel's CURRENT accounts in
   * the order `order(names, walk, offset)` gives, every row carrying the `created_at` the fake
   * stamped (read once, over the real route, before the take-over; an account seeded later is
   * stamped newer than all of them). Unlike `reorder`, nothing is re-created: only the ORDER of
   * the list changes — a panel listing with no ORDER BY. `before(walk, offset)` runs first,
   * like `beforeListPage`.
   */
  async function serveListInOrder(
    fake: FakeRickpanel,
    order: (names: string[], walk: number, offset: number) => string[],
    before: (walk: number, offset: number) => void = () => undefined,
  ): Promise<void> {
    const token = (await (
      await fetch(`${fake.baseUrl}/api/admin/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: fake.username, password: fake.password }).toString(),
      })
    ).json()) as { access_token: string };
    const listed = (await (
      await fetch(`${fake.baseUrl}/api/users?offset=0&limit=1000`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      })
    ).json()) as { users: { username: string; created_at: string }[] };
    const created = new Map(listed.users.map((u) => [u.username, u.created_at]));
    let later = 0;
    const stamp = (name: string): string => {
      let at = created.get(name);
      if (at === undefined) {
        later += 1;
        at = new Date(Date.UTC(2026, 6, 1) + later * 1000).toISOString().slice(0, 19);
        created.set(name, at);
      }
      return at;
    };
    let walk = 0;
    fake.intercept = (request) => {
      const [path, query] = request.path.split('?');
      if (request.method !== 'GET' || path !== '/api/users') return null;
      const params = new URLSearchParams(query ?? '');
      const offset = Number(params.get('offset') ?? '0');
      const limit = Number(params.get('limit') ?? '0');
      if (offset === 0) walk += 1;
      before(walk, offset);
      const names = order([...fake.users.keys()], walk, offset);
      const rows = names.map((n) => ({
        ...recordOf(fake.users.get(n) as FakeRickpanelUser),
        created_at: stamp(n),
      }));
      return {
        status: 200,
        body: { users: rows.slice(offset, offset + limit), total: rows.length },
      };
    };
  }

  /** A burst of `n` deletions behind the cursor before the 4th page of EVERY walk. */
  function burstEveryWalk(fake: FakeRickpanel, n: number): number[] {
    const bursts: number[] = [];
    onWalkPages(fake, (_walk, offset) => {
      if (offset === 3) bursts.push(deleteFrontManual(fake, n));
    });
    return bursts;
  }

  // ── R1 ─────────────────────────────────────────────────────────────────────────────────

  it('R1: a case variant on the panel (SVC_A2 beside the backup’s svc_a2), seen by a gap-free walk under churn — USERNAME_CASE_COLLISION, never attached to anyone, no per-user GET', async () => {
    const PAGE = 2;
    expect(walkOverlap(PAGE)).toBe(1);
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    panelA.seedUser('SVC_A2', ACCOUNT);
    // A sale appended (ahead of the cursor) during the first walk: TOTAL_CHANGED, gap-free.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 3) panelA.seedUser('mirza_sale_1', ACCOUNT);
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_LOOKUPS']).toBeUndefined();
    // case_x as before, and svc_a2 now: two spellings fold to one name.
    expect(w['USERNAME_CASE_COLLISION']).toBe(2);
    expect(w['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    const decided = await candidates();
    expect(decided['a000000f']).toEqual({
      outcome: 'USERNAME_CASE_COLLISION',
      holders: [{ panel: 'A', spellings: 2 }],
    });
    // Neither spelling of svc_a2 is anybody's service; the rest are their own owners' only.
    const { 'A:svc_a2': _collided, ...withoutA2 } = BASELINE;
    await expectOwners(withoutA2);
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  it('R1 (Codex P1): a case variant SVC_A1 created DURING the second walk — the list is oldest first, so it lands ahead of the cursor and the walk returns it: USERNAME_CASE_COLLISION, svc_a1 attached to nobody', async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 3) panelA.seedUser('mirza_sale_p1', ACCOUNT);
      if (walk === 2 && offset === 4) panelA.seedUser('SVC_A1', ACCOUNT);
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    // case_x, and svc_a1 now.
    expect(w['USERNAME_CASE_COLLISION']).toBe(2);
    expect(w['ADOPTION_ELIGIBLE']).toBeUndefined();
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect(walksOf(panelA, before)).toBeLessThanOrEqual(MAX_WALKS);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    // Approvable (a collision is decided), and the apply attaches nothing.
    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    expect((await candidates())['a0000001']).toEqual({
      outcome: 'USERNAME_CASE_COLLISION',
      holders: [{ panel: 'A', spellings: 2 }],
    });
    const { 'A:svc_a1': _collided, ...withoutA1 } = BASELINE;
    await expectOwners(withoutA1);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  it('R1 (Codex P1): a case variant SVC_A1 listed BEHIND the cursor from the middle of the second walk on (a list not in creation order) — no later walk is gap-free: svc_a1 is a collision from the union; with the last walk broken at the cap, no name is present on one spelling or absent (a row it skipped may exist) — every other needed name UNRESOLVED; quarantined (not a blocker), nothing attached', async () => {
    // Page 8 (overlap 2): the shifted page still holds fresh rows. At page 2 (overlap 1) the
    // same insertion leaves the next page with none, and the walk fails NO_PROGRESS — the
    // panel is then PROVIDER_INVENTORY_INCOMPLETE (read failed), also refused.
    const PAGE = 8;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    manualFront(panelA, 12);
    let variantAt: number | null = null;
    await serveListInOrder(
      panelA,
      (names) =>
        names.includes('SVC_A1') ? ['SVC_A1', ...names.filter((n) => n !== 'SVC_A1')] : names,
      (walk, offset) => {
        if (walk === 1 && offset === 6) panelA.seedUser('mirza_sale_p1b', ACCOUNT);
        if (walk === 2 && offset === 6 && variantAt === null) {
          variantAt = walk;
          panelA.seedUser('SVC_A1', ACCOUNT);
        }
      },
    );
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.intercept = null;
    expect(variantAt).toBe(2);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(walksOf(panelA, before)).toBe(MAX_WALKS);
    expect(w['USERNAME_CASE_COLLISION']).toBe(2);
    // svc_a2, svc_a4: never present on one spelling; svc_missing: absent (no walk returned it).
    // Every needed name but the collision: never present, never absent.
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(NAMES_UNRESOLVED_WITHOUT_GAP_FREE - 1);
    expect(w['PROVIDER_MISSING']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    await expectQuarantinedNotBlocking(id);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    await expectOwners({});
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R2 ─────────────────────────────────────────────────────────────────────────────────

  it('R2: every walk loses rows (a 2-row deletion burst behind the cursor, overlap 1, in EACH walk) — every needed name UNRESOLVED, no per-user GET, blocked as a failed read (review H P1), nothing written; over a quieter panel the same package is approvable and adopts each candidate onto its own owner only', async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(
      await writePackage({
        invoices: (rows) => [...rows, extraInvoice(rows, 'b0000003', '100000009', 'svc_a3')],
      }),
    );
    manualFront(panelA, 2 * MAX_WALKS + 2);
    const bursts = burstEveryWalk(panelA, 2);
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(bursts.length).toBeGreaterThanOrEqual(2);
    expect(bursts.every((n) => n === 2)).toBe(true);
    expect(bursts.length).toBe(walksOf(panelA, before));
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    // svc_a3 is needed too here: five names undecided, the collision decided by its spellings.
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBe(NAMES_UNRESOLVED_WITHOUT_GAP_FREE + 1);
    expect(w['INVENTORY_INCOMPLETE']).toBe(UNRESOLVED_WITHOUT_GAP_FREE + 1);
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    expect(w['PROVIDER_MISSING']).toBeUndefined();
    expect(w['ADOPTION_ELIGIBLE']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    await expectBlockedNoDecisionWalk(id);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    await expectOwners({});

    // Quieter: a single sale appended during the first walk — gap-free, decided, approvable.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.seedUser('mirza_sale_quiet', ACCOUNT);
    });
    const again = await page.dryRun(id);
    panelA.beforeListPage = null;
    const aw = codes(again.dryRunReport?.warnings);
    expect(aw['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(aw['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(aw['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(aw['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    await expectOwners({ ...BASELINE, 'A:svc_a3': '100000009' });
    const decided = await candidates();
    expect(decided['a0000001']?.outcome).toBe('ADOPTED');
    expect(decided['b0000003']?.outcome).toBe('ADOPTED');
    expect(decided['7c1f']?.outcome).toBe('PROVIDER_MISSING');
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R3 ─────────────────────────────────────────────────────────────────────────────────

  it('R3: a missing account (no spelling anywhere) — PROVIDER_MISSING with a gap-free last walk; the SAME account when no walk is gap-free is UNRESOLVED, never PROVIDER_MISSING', async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    expect([...panelA.users.keys()].some((n) => n.toLowerCase() === 'svc_missing')).toBe(false);

    // No gap-free walk: a burst in each.
    manualFront(panelA, 2 * MAX_WALKS + 2);
    burstEveryWalk(panelA, 2);
    let before = panelA.requests.length;
    const blind = await page.dryRun(id);
    panelA.beforeListPage = null;
    const bw = codes(blind.dryRunReport?.warnings);
    expect(bw['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(bw['PROVIDER_MISSING']).toBeUndefined();
    expect(bw['PROVIDER_INVENTORY_UNRESOLVED']).toBe(NAMES_UNRESOLVED_WITHOUT_GAP_FREE);
    expect(lookupsOf(panelA, before)).toEqual([]);
    await expectBlockedNoDecisionWalk(id);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    // A gap-free walk: one sale appended during the second walk.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 2 && offset === 4) panelA.seedUser('mirza_sale_r3', ACCOUNT);
    });
    before = panelA.requests.length;
    const seen = await page.dryRun(id);
    panelA.beforeListPage = null;
    const sw = codes(seen.dryRunReport?.warnings);
    expect(sw['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(sw['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    expect(sw['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    expect((await detail(id)).status).toBe('COMPLETED');
    expect((await candidates())['7c1f']).toEqual({ outcome: 'PROVIDER_MISSING', holders: [] });
    await expectOwners(BASELINE);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R4 ─────────────────────────────────────────────────────────────────────────────────

  it('R4: a list order that is not stable while the panel changes — nothing PRESENT or ABSENT, blocked when no walk is gap-free (review H P1), nothing written', async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());

    // (a) Every account deleted and re-created in the reverse order before each later walk
    // (every `created_at` new): no walk agrees with the one before it.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 2) panelA.seedUser('mirza_sale_r4', ACCOUNT);
      if (walk >= 2 && offset === 0) reorder(panelA, [...panelA.users.keys()].reverse());
    });
    let before = panelA.requests.length;
    const recreated = await page.dryRun(id);
    panelA.beforeListPage = null;
    const rw = codes(recreated.dryRunReport?.warnings);
    expect(rw['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(rw['PROVIDER_INVENTORY_UNRESOLVED']).toBe(NAMES_UNRESOLVED_WITHOUT_GAP_FREE);
    expect(rw['PROVIDER_MISSING']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    await expectBlockedNoDecisionWalk(id);

    // (b) Nothing re-created: the panel lists its last two accounts swapped from the second
    // walk on (an ORDER BY-less list), every row keeping its own `created_at`, while a sale is
    // appended. The rows are no longer oldest first, so no later walk is gap-free.
    await serveListInOrder(
      panelA,
      (names, walk) => {
        if (walk < 2) return names;
        const n = names.length;
        return [...names.slice(0, n - 2), names[n - 1] as string, names[n - 2] as string];
      },
      (walk, offset) => {
        if (walk === 1 && offset === 1) panelA.seedUser('mirza_sale_r4b', ACCOUNT);
        // A sale in the third walk too: the last two walks are never one complete snapshot.
        if (walk === 3 && offset === 1) panelA.seedUser('mirza_sale_r4b3', ACCOUNT);
      },
    );
    before = panelA.requests.length;
    const swapped = await page.dryRun(id);
    panelA.intercept = null;
    const tw = codes(swapped.dryRunReport?.warnings);
    expect(walksOf(panelA, before)).toBe(MAX_WALKS);
    expect(tw['PROVIDER_INVENTORY_UNRESOLVED']).toBe(NAMES_UNRESOLVED_WITHOUT_GAP_FREE);
    expect(tw['PROVIDER_MISSING']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    await expectBlockedNoDecisionWalk(id);

    // (c) An offset-dependent order: pages at an odd offset are cut from the list in reverse
    // (a different statement plan per offset), while a sale is appended.
    await serveListInOrder(
      panelA,
      (names, _walk, offset) => (offset % 2 === 1 ? [...names].reverse() : names),
      (walk, offset) => {
        if (walk === 1 && offset === 2) panelA.seedUser('mirza_sale_r4c', ACCOUNT);
      },
    );
    before = panelA.requests.length;
    const shifting = await page.dryRun(id);
    panelA.intercept = null;
    const sw = codes(shifting.dryRunReport?.warnings);
    expect(sw['PROVIDER_MISSING']).toBeUndefined();
    expect(sw['ADOPTION_ELIGIBLE']).toBeUndefined();
    expect(lookupsOf(panelA, before)).toEqual([]);
    // An order that depends on the offset is not a read that held: the panel's read FAILED,
    // nothing is quarantined, and the approval is refused as before.
    expect(sw['PROVIDER_INVENTORY_INCOMPLETE']).toBe(1);
    expect(shifting.dryRunReport?.inventoryHold?.invoices).toBe(0);
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
      details: expect.objectContaining({ reason: 'PROVIDER_INVENTORY_INCOMPLETE' }),
    });

    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);
    await expectOwners({});
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R5 ─────────────────────────────────────────────────────────────────────────────────

  /** The record `GET /api/user/{name}` answers for `user` (the fake's own shape). */
  const recordOf = (user: FakeRickpanelUser) => ({
    username: user.username,
    status: user.status,
    expire: user.expire,
    data_limit: user.dataLimit,
    data_limit_reset_strategy: 'no_reset',
    used_traffic: user.usedTraffic,
    online_at: user.onlineAt,
    proxies: user.proxies,
    subscription_url: `/sub/${user.username}/${user.subToken}`,
    sub_token: user.subToken,
  });

  /** A lookup route that matches a name case-insensitively and answers the STORED spelling. */
  function caseInsensitiveLookups(fake: FakeRickpanel): void {
    fake.intercept = (request: FakeRickpanelRequest) => {
      const m = /^\/api\/user\/([^/?]+)$/u.exec(request.path);
      if (request.method !== 'GET' || m === null) return null;
      const asked = decodeURIComponent(m[1] ?? '').toLowerCase();
      const held = [...fake.users.values()].filter((u) => u.username.toLowerCase() === asked);
      if (held.length === 0) return { status: 404, body: { detail: 'User not found' } };
      return { status: 200, body: recordOf(held[0] as FakeRickpanelUser) };
    };
  }

  it('R5: a case-insensitive lookup panel holding SVC_A5 for the backup’s svc_a5 — never asked; attached to its own owner under the panel’s spelling, exactly what a complete read decides; nothing else attached', async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(
      await writePackage({
        invoices: (rows) => [...rows, extraInvoice(rows, 'b0000005', '100000009', 'svc_a5')],
      }),
    );
    panelA.seedUser('SVC_A5', ACCOUNT);
    caseInsensitiveLookups(panelA);
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 3) panelA.seedUser('mirza_sale_r5', ACCOUNT);
    });
    const before = panelA.requests.length;
    const churned = await page.dryRun(id);
    panelA.beforeListPage = null;
    const cw = codes(churned.dryRunReport?.warnings);
    expect(cw['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(cw['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(cw['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(cw['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    // The case-folding route is never consulted: the walks decide.
    expect(lookupsOf(panelA, before)).toEqual([]);

    // The same import over the same panel, still: the complete read.
    const complete = await page.dryRun(id);
    expect(codes(complete.dryRunReport?.warnings)['PROVIDER_INVENTORY_CHURN']).toBeUndefined();
    expect(churned.dryRunReport?.planTalliesDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(churned.dryRunReport?.planTalliesDigest).toBe(complete.dryRunReport?.planTalliesDigest);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    await expectOwners({ ...BASELINE, 'A:SVC_A5': '100000009' });
    expect((await candidates())['b0000005']).toEqual({
      outcome: 'ADOPTED',
      holders: [{ panel: 'A', spellings: 1 }],
    });
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R6 ─────────────────────────────────────────────────────────────────────────────────

  it("R6: changes during the APPLY's own read that break gap-freeness (a burst in every walk) — the apply refuses, nothing written, nobody attached", async () => {
    const PAGE = 2;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    manualFront(panelA, 30);
    // The dry run: one sale appended — gap-free, decided, approvable.
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 3) panelA.seedUser('mirza_sale_r6', ACCOUNT);
    });
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect((await page.approve(id)).status).toBe('APPROVED');

    // The apply's every walk loses rows: a 2-row burst behind the cursor.
    const bursts = burstEveryWalk(panelA, 2);
    await page.executor.tick();
    panelA.beforeListPage = null;
    expect(bursts.length).toBeGreaterThanOrEqual(2);
    expect(bursts.every((n) => n === 2)).toBe(true);
    const failed = await detail(id);
    expect(failed.status).toBe('FAILED');
    expect(['DRY_RUN_MISMATCH', 'INVENTORY_INCOMPLETE', 'PROVIDER_INVENTORY_INCOMPLETE']).toContain(
      failed.errorCode,
    );
    expect(failed.applyLegacyRunId).toBeNull();
    for (const table of ['customers', 'wallet_entries', 'services', 'orders']) {
      expect(await count(table), table).toBe(0);
    }
    await expectOwners({});
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  // ── R7 ─────────────────────────────────────────────────────────────────────────────────

  it('R7: normal selling — sales appended and single deletions behind the cursor (within the overlap) during every walk of the dry run AND the apply — approvable, each candidate adopted onto its own owner only', async () => {
    const PAGE = 8;
    expect(walkOverlap(PAGE)).toBe(2);
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(
      await writePackage({
        invoices: (rows) => [
          ...rows,
          extraInvoice(rows, 'b0000003', '100000009', 'svc_a3'),
          extraInvoice(rows, 'b0000007', '100000011', 'svc_a7'),
        ],
      }),
    );
    panelA.seedUser('svc_a7', ACCOUNT);
    manualFront(panelA, 60);
    let sales = 0;
    let deletions = 0;
    let pages = 0;
    // Between two pages: a sale (appended), or a single deletion behind the cursor — never
    // both in one interval (that pair holds `total` still: see the R7b case below).
    onWalkPages(panelA, (_walk, offset) => {
      if (offset === 0) return;
      pages += 1;
      if (pages % 2 === 1) {
        sales += 1;
        panelA.seedUser(`mirza_sale_${String(sales)}`, ACCOUNT);
      } else {
        deletions += deleteFrontManual(panelA, 1);
      }
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    expect(deletions).toBeGreaterThanOrEqual(4);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_CHURN']).toBe(1);
    expect(w['PROVIDER_INVENTORY_UNRESOLVED']).toBeUndefined();
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(w['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    expect(w['USERNAME_CASE_COLLISION']).toBe(1);
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect(await businessCounts()).toEqual(NOTHING_WRITTEN);

    expect((await page.approve(id)).status).toBe('APPROVED');
    const deletedBeforeApply = deletions;
    await page.executor.tick();
    panelA.beforeListPage = null;
    expect(deletions).toBeGreaterThan(deletedBeforeApply);
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    await expectOwners({
      ...BASELINE,
      'A:svc_a3': '100000009',
      'A:svc_a7': '100000011',
    });
    const decided = await candidates();
    for (const k of ['a0000001', 'b0000003', 'b0000007']) {
      expect(decided[k], k).toEqual({
        outcome: 'ADOPTED',
        holders: [{ panel: 'A', spellings: 1 }],
      });
    }
    expect(decided['a0000008']?.outcome).toBe('USERNAME_CASE_COLLISION');
    expect(decided['7c1f']?.outcome).toBe('PROVIDER_MISSING');
    expect(lookupsOf(panelA)).toEqual([]);
    expectReadsOnly(panelA, panelB);
  }, 600_000);

  /**
   * PRODUCTION GAP (found by this suite on c4708677; fails there): ONE sale and ONE deletion
   * of an already-read account in the same interval between two pages keep every page's
   * `total` equal, so the walk is "consistent" yet saw total + 1 names (the deleted one before,
   * the sale after) — `COUNT_MISMATCH`, which `readTargeted` treats as a list withholding rows
   * and leaves the whole panel incomplete, so the dry run is refused while Mirza merely sells.
   * The second walk here is quiet and gap-free, and would decide every needed name.
   * See rickpanel-inventory.ts (`byName.size !== evidence.reportedTotal` → COUNT_MISMATCH) and
   * rickpanel-inventory-source.ts (`readTargeted`, the COUNT_MISMATCH early return).
   */
  it('R7b [PRODUCTION GAP]: one sale and one deletion in the SAME page interval of one walk (total held still) — the owner’s normal selling, so still approvable, each candidate onto its own owner only', async () => {
    const PAGE = 8;
    const page = productionLikePage(PAGE);
    const id = await page.toVerified(await writePackage());
    manualFront(panelA, 12);
    onWalkPages(panelA, (walk, offset) => {
      if (walk === 1 && offset === 6) {
        panelA.seedUser('mirza_sale_pair', ACCOUNT);
        deleteFrontManual(panelA, 1);
      }
    });
    const before = panelA.requests.length;
    const dry = await page.dryRun(id);
    panelA.beforeListPage = null;
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const w = codes(dry.dryRunReport?.warnings);
    expect(w['PROVIDER_INVENTORY_INCOMPLETE:COUNT_MISMATCH']).toBeUndefined();
    expect(w['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(w['PROVIDER_MISSING']).toBe(PROVIDER_MISSING_INVOICES);
    expect(lookupsOf(panelA, before)).toEqual([]);
    expect((await page.approve(id)).status).toBe('APPROVED');
    await page.executor.tick();
    expect((await detail(id)).status).toBe('COMPLETED');
    await expectOwners(BASELINE);
    expectReadsOnly(panelA, panelB);
  }, 600_000);
});
