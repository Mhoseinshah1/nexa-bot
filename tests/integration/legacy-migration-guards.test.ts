import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  ownershipRecord,
  rigExecutor,
  signedDecisions,
  writeMigrationPackage,
  type DecisionClass,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { flipByte, listChunks } from '../support/nxpkg/tamper';
import { SEED_IDS, createTestContext, tenantA, type TestContext } from './harness';

/**
 * Mirza `.nxpkg` Fresh Migration — what the `migration` role REFUSES, through the operator's
 * service and the executor with its real ports over PostgreSQL and two fake RickPanels:
 *
 * - a target that is not fresh (a pre-existing customer, before the dry run and between the
 *   approval and the apply): `FRESH_TARGET_NOT_EMPTY`, and nothing deleted or written;
 * - a RickPanel-only migration: a binding onto a Marzban panel, a package target whose
 *   provider is not RickPanel: `PANEL_TARGET_MISMATCH`;
 * - the converter's ownership decisions: verified ones hold QUARANTINED / REJECTED / PENDING
 *   / stale services out of adoption and report ADMIN_APPROVED_UNVERIFIED separately; a
 *   tampered or re-signed one is `DECISIONS_INVALID`;
 * - a package that must not be imported at all (corrupted, truncated, garbage, wrong key,
 *   contract 1.3.0 / 2.0.0, not ready, rial, a live-state flag): a terminal failure with the
 *   verifier's code, the key erased, no operational row, no decrypted directory.
 *
 * Every case also requires zero provider writes. SYNTHETIC data only. NOT EVIDENCE.
 */

const OPERATIONAL = [
  'customers',
  'orders',
  'services',
  'payments',
  'wallet_entries',
  'legacy_wallet_debts',
  'legacy_history_records',
  'legacy_service_candidates',
  'provisioning_operations',
  'trial_grants',
] as const;

describe('legacy migration: what the migration role refuses', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-guards-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-guards-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: 40, invoices: 30 });
    pkg = await writeMigrationPackage(join(work, 'guards.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
    });
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await rig.freshTenant(generated.liveAccounts);
  }, 120_000);

  async function counts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of OPERATIONAL) out[table] = await rig.count(table);
    return out;
  }

  const EMPTY = Object.fromEntries(OPERATIONAL.map((t) => [t, 0]));

  /** Every file the migration root holds, relative: the stored package and nothing decrypted. */
  async function filesUnder(id: string): Promise<string[]> {
    return (await readdir(join(migrationRoot, id), { recursive: true })).map(String).sort();
  }

  async function existingCustomer(telegramUserId: string): Promise<void> {
    await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemJobActor('telegram-update:test', `corr-${telegramUserId}` as CorrelationId),
      {
        idempotencyKey: `lmig-guards-existing-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'existing' },
        botInstanceId: SEED_IDS.botA1 as never,
      },
    );
  }

  // --- 4. the fresh target ----------------------------------------------------------------------

  it('a tenant with one pre-existing customer: the dry run is refused FRESH_TARGET_NOT_EMPTY, nothing deleted, nothing written', async () => {
    // A customer the package also carries — the case a "merge" would be tempted to touch.
    await existingCustomer(generated.users[0]?.['id'] ?? '');
    const before = await counts();
    expect(before.customers).toBe(1);
    const executor = rigExecutor(ctx);
    const id = await rig.upload(pkg.path);
    await rig.setKey(id, { keyFileText: pkg.keyFileText });
    await executor.tick();
    await rig.bind(id);
    await rig.requestDryRun(id);
    await executor.tick();
    const view = await rig.detail(id);
    expect(view).toMatchObject({ status: 'DRY_RUN_FAILED', errorCode: 'FRESH_TARGET_NOT_EMPTY' });
    expect(view.progress.refusalCounts).toContainEqual({ code: 'customers', count: 1 });
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
    expect(await counts()).toEqual(before);
    expect(await rig.count('legacy_import_runs')).toBe(0);
    expect(await rig.stepDirectories(id)).toEqual([]);
    expect(rig.providerWrites()).toEqual([]);
  }, 120_000);

  it('a customer that appears between the approval and the apply: the apply is FAILED before any write', async () => {
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(pkg, executor);
    await existingCustomer('999000111');
    const before = await counts();
    await executor.tick();
    const view = await rig.detail(id);
    expect(view).toMatchObject({ status: 'FAILED', errorCode: 'FRESH_TARGET_NOT_EMPTY' });
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
    expect(await counts()).toEqual(before);
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY'")).toBe(0);
    expect(rig.providerWrites()).toEqual([]);
  }, 120_000);

  // --- 7. RickPanel only ------------------------------------------------------------------------

  it('a binding onto a Marzban panel is refused PANEL_TARGET_MISMATCH at the dry run', async () => {
    const marzban = await ctx.container.panels.create(tenantA, rig.owner, {
      name: 'Marzban',
      providerType: 'marzban',
      baseUrl: 'https://marzban.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'lmig-guards-marzban',
    });
    const executor = rigExecutor(ctx);
    const id = await rig.upload(pkg.path);
    await rig.setKey(id, { keyFileText: pkg.keyFileText });
    await executor.tick();
    await rig.bind(id, [
      { codePanel: 'rp1', panelId: marzban.view.panel.id },
      { codePanel: 'rp2', panelId: rig.panels.rp2.id },
    ]);
    await rig.requestDryRun(id);
    await executor.tick();
    expect(await rig.detail(id)).toMatchObject({
      status: 'DRY_RUN_FAILED',
      errorCode: 'PANEL_TARGET_MISMATCH',
    });
    expect(await counts()).toEqual(EMPTY);
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
  }, 120_000);

  it('a package whose selected target is not RickPanel is refused PANEL_TARGET_MISMATCH at verification', async () => {
    const other = await writeMigrationPackage(join(work, 'marzban-target.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      targetProviderType: 'marzban',
    });
    const executor = rigExecutor(ctx);
    const id = await rig.upload(other.path);
    await rig.setKey(id, { keyFileText: other.keyFileText });
    await executor.tick();
    expect(await rig.detail(id)).toMatchObject({
      status: 'VERIFY_FAILED',
      errorCode: 'PANEL_TARGET_MISMATCH',
    });
    expect(await counts()).toEqual(EMPTY);
  }, 120_000);

  // --- 9. ownership decisions -------------------------------------------------------------------

  it('verified decisions: QUARANTINED, REJECTED, PENDING and stale are never adopted; ADMIN_APPROVED_UNVERIFIED is reported apart from PROVEN and never lifts a hold', async () => {
    const live = generated.invoices.filter((i) => i.live);
    const [quarantined, rejected, pending, attested, stale, attestedHeld] = live;
    if (attestedHeld === undefined) throw new Error('too few live invoices');
    // The converter itself could not decide `attestedHeld`; an admin attested it anyway.
    const decided = await writeMigrationPackage(join(work, 'decided.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      ownership: { [attestedHeld.id]: ownershipRecord(attestedHeld, 'AMBIGUOUS_OWNER', null) },
    });
    const classes: Record<string, DecisionClass> = {
      [quarantined?.id ?? '']: 'QUARANTINED',
      [rejected?.id ?? '']: 'REJECTED',
      [pending?.id ?? '']: 'PENDING',
      [attested?.id ?? '']: 'ADMIN_APPROVED_UNVERIFIED',
      [attestedHeld.id]: 'ADMIN_APPROVED_UNVERIFIED',
    };
    const decisions = await signedDecisions(decided, (k) => classes[k] ?? 'PROVEN', {
      stale: new Set([stale?.id ?? '']),
    });
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(decided, executor, { decisions });

    const view = await rig.detail(id);
    expect(view.verifyReport?.decisions).toMatchObject({
      items: live.length,
      proven: live.length - 5,
      adminApprovedUnverified: 2,
      pending: 1,
      rejected: 1,
      quarantined: 1,
      stale: 1,
    });
    expect(view.dryRunReport?.ownership).toMatchObject({
      decisionsProvided: true,
      quarantined: 1,
      rejected: 1,
      pending: 1,
      stale: 1,
    });
    // Attested is its own figure, never folded into proven; a stale PROVEN entry is held.
    expect(view.dryRunReport?.ownership.proven).toBe(live.length - 6);
    expect(view.dryRunReport?.ownership.adminApprovedUnverified).toBeGreaterThanOrEqual(1);

    await executor.tick();
    const adopted = new Set(
      (
        await ctx.container.database.db.execute<{ u: string }>(
          sql`SELECT provider_username AS u FROM services WHERE tenant_id = ${TENANT}`,
        )
      ).rows.map((r) => r.u),
    );
    for (const inv of [quarantined, rejected, pending, stale]) {
      expect(adopted.has(inv?.username ?? ''), inv?.id).toBe(false);
    }
    // An attestation is not proof: it neither promotes nor lifts the converter's own hold.
    expect(adopted.has(attestedHeld.username)).toBe(false);
    // Attested over a converter-confirmed record: NEXA's own rules adopt it onto id_user.
    expect(adopted.has(attested?.username ?? '')).toBe(true);
    expect(adopted.size).toBe(live.length - 5);
    expect(rig.providerWrites()).toEqual([]);
  }, 300_000);

  it.each([
    [
      'a summary edited after signing',
      (d: Record<string, any>) => {
        d['summary'].PROVEN += 1;
      },
    ],
    [
      'a class edited after signing',
      (d: Record<string, any>) => {
        d['entries'][0].class = 'PROVEN';
        d['entries'][0].basis = 'EVIDENCE';
      },
    ],
    [
      'another MAC',
      (d: Record<string, any>) => {
        d['authentication'].mac = randomBytes(32).toString('base64');
      },
    ],
  ])(
    'tampered decisions (%s) are refused DECISIONS_INVALID at verification, the key erased',
    async (_label, mutate) => {
      const decisions = await signedDecisions(pkg, () => 'QUARANTINED', { mutate });
      const executor = rigExecutor(ctx);
      const id = await rig.upload(pkg.path);
      await rig.uploadDecisions(id, decisions);
      await rig.setKey(id, { keyFileText: pkg.keyFileText });
      await executor.tick();
      expect(await rig.detail(id)).toMatchObject({
        status: 'VERIFY_FAILED',
        errorCode: 'DECISIONS_INVALID',
      });
      expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
      expect(await counts()).toEqual(EMPTY);
    },
    120_000,
  );

  it('decisions signed under another package key, given after verification, fail the dry run DECISIONS_INVALID', async () => {
    const other = await writeMigrationPackage(join(work, 'other-key.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
    });
    // Same records, another package (another key and header): never this package's decisions.
    const foreign = await signedDecisions(other, () => 'PROVEN');
    const executor = rigExecutor(ctx);
    const id = await rig.upload(pkg.path);
    await rig.setKey(id, { keyFileText: pkg.keyFileText });
    await executor.tick();
    expect((await rig.detail(id)).status).toBe('VERIFIED');
    await rig.uploadDecisions(id, foreign);
    await rig.bind(id);
    await rig.requestDryRun(id);
    await executor.tick();
    expect(await rig.detail(id)).toMatchObject({
      status: 'DRY_RUN_FAILED',
      errorCode: 'DECISIONS_INVALID',
    });
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
    expect(await counts()).toEqual(EMPTY);
  }, 120_000);

  // --- 10. fail closed --------------------------------------------------------------------------

  type Variant = () => Promise<{ path: string; keyFileText: string }>;
  const variant =
    (name: string, input: Partial<Parameters<typeof writeMigrationPackage>[1]>): Variant =>
    () =>
      writeMigrationPackage(join(work, `${name}.nxpkg`), {
        dataset: generated.dataset,
        invoices: generated.invoices,
        ...input,
      });
  const bytesOf =
    (name: string, edit: (bytes: Buffer) => Buffer): Variant =>
    async () => {
      const path = join(work, `${name}.nxpkg`);
      await writeFile(path, edit(await readFile(pkg.path)));
      return { path, keyFileText: pkg.keyFileText };
    };

  it.each<[string, string, Variant]>([
    [
      'a flipped ciphertext byte',
      'NXPKG_TAMPERED',
      bytesOf('flipped', (b) => {
        const chunk = listChunks(b)[0];
        if (chunk === undefined) throw new Error('no chunk');
        return flipByte(b, chunk.offset + 4 + 10);
      }),
    ],
    [
      'a truncated package (final chunk dropped)',
      'NXPKG_TAMPERED',
      bytesOf('truncated', (b) => b.subarray(0, listChunks(b).at(-1)?.offset ?? 0)),
    ],
    ['garbage bytes', 'NXPKG_CONTAINER_INVALID', bytesOf('garbage', () => randomBytes(4096))],
    [
      'the wrong key',
      'NXPKG_WRONG_KEY',
      async () => {
        const { newRawKey } = await import('../support/nxpkg/writer');
        return { path: pkg.path, keyFileText: newRawKey().keyFileText };
      },
    ],
    [
      'contract 1.3.0',
      'NXPKG_UNSUPPORTED_VERSION',
      variant('v130', { manifest: { package_schema_version: '1.3.0' } }),
    ],
    [
      'contract 2.0.0',
      'NXPKG_UNSUPPORTED_VERSION',
      variant('v200', { manifest: { package_schema_version: '2.0.0' } }),
    ],
    [
      'a package that is not ready',
      'NXPKG_NOT_READY',
      variant('blocked', { manifest: { readiness: 'blocked', blockers: ['LEDGER_MISMATCH'] } }),
    ],
    [
      'amounts in rial',
      'NXPKG_MONEY_UNIT',
      variant('rial', {
        manifest: { money: { declared_unit: 'rial', currency: 'IRR', rescaled: false } },
      }),
    ],
    [
      'a live-state flag set (provision: true)',
      'NXPKG_LIVE_FLAG',
      async () => {
        const first = generated.invoices.find((i) => i.live);
        if (first === undefined) throw new Error('no live invoice');
        return variant('live-flag', {
          ownership: { [first.id]: { ...ownershipRecord(first), provision: true } },
        })();
      },
    ],
  ])(
    '%s: VERIFY_FAILED %s, the key erased, nothing written, nothing decrypted left',
    async (_label, code, make) => {
      const bad = await make();
      const executor = rigExecutor(ctx);
      const id = await rig.upload(bad.path);
      await rig.setKey(id, { keyFileText: bad.keyFileText });
      await executor.tick();
      const view = await rig.detail(id);
      expect(view).toMatchObject({ status: 'VERIFY_FAILED', errorCode: code });
      expect(view.keyPresent).toBe(false);
      const stored = await rig.row(id);
      expect(stored?.['key_ciphertext']).toBeNull();
      expect(stored?.['key_key_id']).toBeNull();
      expect(await counts()).toEqual(EMPTY);
      expect(await rig.count('legacy_import_runs')).toBe(0);
      // Only the uploaded (encrypted) package remains: no step directory, no extracted file.
      expect(await filesUnder(id)).toEqual(['package.nxpkg']);
      // Terminal: the operator may upload the next package.
      const next = await rig.upload(pkg.path);
      expect((await rig.detail(next)).status).toBe('UPLOADED');
      expect(rig.providerWrites()).toEqual([]);
    },
    120_000,
  );
});
