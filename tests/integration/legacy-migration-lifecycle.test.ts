import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@nexa/contracts';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  moneyOfSnapshot,
  paymentRecords,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { newRawKey } from '../support/nxpkg/writer';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * Mirza `.nxpkg` Fresh Migration — one whole lifecycle through the operator's service and the
 * container's OWN `migration` executor (real ports, the real post-import backup), checked from
 * outside the importer:
 *
 * - money, recomputed independently from the package's snapshot `Balance` cells: every
 *   positive balance is exactly one MIGRATION_OPENING_BALANCE credit referenced
 *   `legacy:opening:<tg>`, every negative one a legacy debt of its magnitude, a zero nothing;
 *   no payment, no revenue, and the only orders are the zero-total LEGACY_ADOPTION ones
 *   behind adopted services;
 * - the RickPanel binding leaves the panels exactly as they were (row and policy), and the
 *   panels saw reads only;
 * - the history archive holds every packaged history line and a customer's is readable
 *   through the Customer 360 read;
 * - secrets: the key file text, the raw key, the passphrase and any `nxkey1:` never appear in
 *   a log line (pino's own output, captured at the file descriptor), an audit row, a
 *   service response (detail / list, progress included), a column of `legacy_nxpkg_imports`
 *   other than the sealed key, or an error; no decrypted step directory survives a tick.
 *
 * SYNTHETIC data only. NOT EVIDENCE.
 */

const USERS = 120;

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const INVOICES = 80;

/** Everything pino (and anything else) writes to stdout/stderr while `fn` runs. */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const keep = (fd: unknown, data: unknown) => {
    if (fd === 1 || fd === 2 || fd === process.stdout.fd || fd === process.stderr.fd) {
      chunks.push(
        typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : '',
      );
    }
  };
  const writeSync = fs.writeSync;
  const write = fs.write;
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  (fs as { writeSync: unknown }).writeSync = (fd: number, data: unknown, ...rest: unknown[]) => {
    keep(fd, data);
    return (writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
  };
  (fs as { write: unknown }).write = (fd: number, data: unknown, ...rest: unknown[]) => {
    keep(fd, data);
    return (write as (...a: unknown[]) => void)(fd, data, ...rest);
  };
  process.stdout.write = ((data: unknown, ...rest: unknown[]) => {
    keep(1, data);
    return (stdout as (...a: unknown[]) => boolean)(data, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((data: unknown, ...rest: unknown[]) => {
    keep(2, data);
    return (stderr as (...a: unknown[]) => boolean)(data, ...rest);
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, output: chunks.join('') };
  } finally {
    (fs as { writeSync: unknown }).writeSync = writeSync;
    (fs as { write: unknown }).write = write;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

describe('legacy migration: one lifecycle, checked from outside the importer', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-life-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-life-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
      // Every line the process can write, so the secret check below sees all of them.
      LOG_LEVEL: 'trace',
    });
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // No decrypted content anywhere under the migration root once a test is done.
    for (const id of await readdir(migrationRoot)) {
      expect(await rig.stepDirectories(id)).toEqual([]);
    }
  });

  const db = () => ctx.container.database.db;

  async function rowsJson(query: ReturnType<typeof sql>): Promise<string> {
    return json((await db().execute(query)).rows);
  }

  async function panelRows(): Promise<string> {
    return rowsJson(sql`
      SELECT p.id, p.name, p.provider_type, p.base_url, p.status, p.archived_at, p.activation,
             p.max_services, p.allow_custom_username, p.username_template,
             p.allow_automatic_username, p.username_strategy, p.username_prefix, p.drained_at,
             p.drain_reason, p.balancing_group, p.created_at, p.updated_at,
             (SELECT json_agg(pp ORDER BY pp.revision) FROM panel_policies pp WHERE pp.panel_id = p.id) AS policies
      FROM panels p WHERE p.tenant_id = ${TENANT} ORDER BY p.name`);
  }

  /**
   * Upload → key → verify → bind → dry run → approve → apply, through the service and the
   * container's executor, collecting every response and checking after each tick that no
   * decrypted step directory survived it.
   */
  async function lifecycle(
    pkg: MigrationPackage,
    secret: { keyFileText: string } | { passphrase: string },
  ): Promise<{ id: string; responses: string[] }> {
    const executor = ctx.container.migrationExecutor;
    const responses: string[] = [];
    const seen = async (id: string) => {
      responses.push(json(await rig.detail(id)));
      responses.push(json(await rig.service.list(tenantA, rig.owner, {})));
    };
    const tick = async (id: string) => {
      await executor.tick();
      expect(await rig.stepDirectories(id)).toEqual([]);
      await seen(id);
    };
    const id = await rig.upload(pkg.path);
    await seen(id);
    responses.push(
      json(
        await rig.service.setKey(tenantA, rig.owner, id, { idempotencyKey: rig.key(), ...secret }),
      ),
    );
    await tick(id);
    await rig.bind(id);
    await rig.requestDryRun(id);
    await tick(id);
    await rig.approve(id);
    await tick(id);
    return { id, responses };
  }

  function expectNoSecret(haystacks: Record<string, string>, secrets: readonly string[]): void {
    for (const [where, text] of Object.entries(haystacks)) {
      for (const secret of secrets) {
        expect(text.includes(secret), `${where} carries a package secret`).toBe(false);
      }
      expect(text.includes('nxkey1:'), `${where} carries key file text`).toBe(false);
    }
  }

  async function everyStoredText(id: string): Promise<Record<string, string>> {
    return {
      auditLogs: await rowsJson(sql`SELECT * FROM audit_logs`),
      operationalEvents: await rowsJson(sql`SELECT * FROM operational_events`),
      outbox: await rowsJson(sql`SELECT * FROM outbox_messages`),
      idempotency: await rowsJson(sql`SELECT * FROM request_idempotency`),
      importRow: await rowsJson(
        sql`SELECT to_jsonb(i) - 'key_ciphertext' AS row FROM legacy_nxpkg_imports i WHERE id = ${id}`,
      ),
      legacyRuns: await rowsJson(sql`SELECT * FROM legacy_import_runs`),
      runInputs: await rowsJson(sql`SELECT * FROM legacy_import_run_inputs`),
    };
  }

  it('money, panels, history and secrets over a key-file package', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const pkg = await writeMigrationPackage(join(work, 'life.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: { 'records/payments.jsonl': paymentRecords(generated.users) },
    });
    const panelsBefore = await panelRows();

    const { result, output } = await captureOutput(() =>
      lifecycle(pkg, { keyFileText: pkg.keyFileText }),
    );
    const { id, responses } = result;
    const view = await rig.detail(id);

    // The importer's own verdicts.
    expect(view.progress.reconcileVerdict).toBe('RECONCILED');
    expect(view.applyReport?.reconcileVerdict).toBe('RECONCILED');
    expect(view.progress.backup).toBe('TAKEN');

    // --- money, independently -----------------------------------------------------------
    const money = moneyOfSnapshot(pkg.parts);
    expect(money.users).toBe(USERS);
    const ledger = (
      await db().execute<{
        reference: string;
        direction: string;
        reason: string;
        amount: string;
        currency: string;
        order_id: string | null;
        payment_id: string | null;
      }>(sql`SELECT reference, direction, reason, amount::text, currency, order_id, payment_id
             FROM wallet_entries WHERE tenant_id = ${TENANT}`)
    ).rows;
    expect(ledger.every((e) => e.reason === 'MIGRATION_OPENING_BALANCE')).toBe(true);
    expect(ledger.every((e) => e.direction === 'CREDIT' && e.currency === 'IRT')).toBe(true);
    expect(ledger.every((e) => e.order_id === null && e.payment_id === null)).toBe(true);
    expect(ledger.reduce((sum, e) => sum + BigInt(e.amount), 0n)).toBe(money.positive.sum);
    expect(ledger.map((e) => e.reference).sort()).toEqual(
      [...money.positive.ids].map((tg) => `legacy:opening:${tg}`).sort(),
    );
    const debts = (
      await db().execute<{ legacy_user_id: string; amount_minor: string; state: string }>(
        sql`SELECT legacy_user_id, amount_minor::text, state FROM legacy_wallet_debts WHERE tenant_id = ${TENANT}`,
      )
    ).rows;
    expect(new Map(debts.map((d) => [d.legacy_user_id, BigInt(d.amount_minor)]))).toEqual(
      money.negative.byId,
    );
    expect(debts.reduce((s, d) => s + BigInt(d.amount_minor), 0n)).toBe(money.negative.sum);
    expect(debts.every((d) => d.state === 'PENDING_REVIEW')).toBe(true);
    // Zero balances: neither an entry nor a debt, but still a customer.
    expect(await rig.count('customers')).toBe(USERS);
    expect(ledger.length + debts.length + money.zero).toBe(USERS);
    // What the owner approved is what was written.
    expect(view.dryRunReport?.wallets).toMatchObject({
      customers: money.positive.count,
      beforeTotalMinor: '0',
      afterTotalMinor: money.positive.sum.toString(),
    });
    expect(view.dryRunReport?.debts.count).toBe(money.negative.count);
    const debtTotal = BigInt(view.dryRunReport?.debts.totalMinor ?? '0');
    expect(debtTotal < 0n ? -debtTotal : debtTotal).toBe(money.negative.sum);
    // No money moved: no payment, no revenue; adoption orders are zero-total LEGACY_ADOPTION.
    const live = generated.invoices.filter((i) => i.live).length;
    expect(await rig.count('payments')).toBe(0);
    expect(await rig.count('services')).toBe(live);
    expect(await rig.count('orders')).toBe(live);
    expect(
      await rig.count(
        'orders',
        "origin = 'LEGACY_ADOPTION' AND total_amount = 0 AND subtotal_amount = 0 AND state = 'PAID'",
      ),
    ).toBe(live);
    expect(await rig.count('provisioning_operations')).toBe(0);

    // --- panels ---------------------------------------------------------------------------
    expect(await panelRows()).toBe(panelsBefore);
    expect(await rig.count('panels', "provider_type = 'rickpanel' AND status = 'ACTIVE'")).toBe(2);
    expect(rig.providerWrites()).toEqual([]);

    // --- history --------------------------------------------------------------------------
    expect(await rig.count('legacy_history_records')).toBe(pkg.historyLines);
    expect(view.progress.history.reduce((s, h) => s + h.count, 0)).toBe(pkg.historyLines);
    const first = (
      await db().execute<{ id: string }>(
        sql`SELECT id FROM customers WHERE tenant_id = ${TENANT} AND telegram_user_id = ${generated.users[0]?.['id'] ?? ''}`,
      )
    ).rows[0];
    if (first === undefined) throw new Error('no customer for user 0');
    const page = await ctx.container.legacyHistoryRead.forCustomer(
      tenantA,
      rig.owner,
      first.id as UserId,
      {},
    );
    expect(page.byType).toContainEqual({ recordType: 'payment', count: 1 });
    expect(page.items.some((item) => item.recordType === 'payment')).toBe(true);
    expect(page.walletDebts).toEqual({ debts: 0 });

    // --- secrets --------------------------------------------------------------------------
    // The capture is live: the executor's own lines are in it.
    expect(output).toContain('legacy migration advanced');
    const raw = pkg.rawKey;
    const secrets = [
      pkg.keyFileText,
      pkg.keyFileText.slice('nxkey1:'.length),
      raw.toString('base64'),
      raw.toString('base64url'),
      raw.toString('hex'),
    ];
    expectNoSecret(
      { logs: output, responses: responses.join('\n'), ...(await everyStoredText(id)) },
      secrets,
    );
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();

    // --- the verdict ----------------------------------------------------------------------
    // Reconciled, and the final report v2 holds: COMPLETED, not "with discrepancy".
    expect(view.applyReport?.failedInvariants).toEqual([]);
    expect(view.applyReport?.failedSections).toEqual([]);
    expect(view.applyReport?.reportHolds).toBe(true);
    expect(view.status).toBe('COMPLETED');
  }, 300_000);

  it('a passphrase package: the passphrase is never logged, stored, audited or returned — imported, or refused as wrong', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const passphrase = `synthetic passphrase ${newRawKey().keyFileText.slice(7, 27)}`;
    const wrong = `${passphrase} but wrong`;
    const pkg = await writeMigrationPackage(join(work, 'life-pass.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      secret: { passphrase, kdfN: 2 ** 10 },
    });

    // Wrong first: refused, the error is a code, and the passphrase is nowhere.
    const refused = await captureOutput(async () => {
      const id = await rig.upload(pkg.path);
      await rig.setKey(id, { passphrase: wrong });
      await ctx.container.migrationExecutor.tick();
      return id;
    });
    const failed = await rig.detail(refused.result);
    expect(failed).toMatchObject({ status: 'VERIFY_FAILED', errorCode: 'NXPKG_WRONG_KEY' });
    expectNoSecret(
      {
        logs: refused.output,
        response: json(failed),
        ...(await everyStoredText(refused.result)),
      },
      [wrong, passphrase],
    );

    const { result, output } = await captureOutput(() => lifecycle(pkg, { passphrase }));
    const view = await rig.detail(result.id);
    expect(view.progress.reconcileVerdict).toBe('RECONCILED');
    expect(await rig.count('customers')).toBe(USERS);
    expect(view.keyPresent).toBe(false);
    expect(view.keyKind).toBe('PASSPHRASE');
    expectNoSecret(
      {
        logs: output,
        responses: result.responses.join('\n'),
        ...(await everyStoredText(result.id)),
      },
      [passphrase, wrong],
    );
    expect(rig.providerWrites()).toEqual([]);
  }, 300_000);
});
