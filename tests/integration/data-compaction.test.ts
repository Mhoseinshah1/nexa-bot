import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_COMPACTION_CLASS_TABLES,
  DATA_COMPACTION_CLASSES,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type DataCompactionStopReason,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';
import { DrizzleUnitOfWork } from '../../apps/api/src/infrastructure/persistence/unit-of-work';
import {
  DataCompactionService,
  totalOf,
} from '../../apps/api/src/modules/platform/data-compaction/application/data-compaction.service';
import { DataCompactionLoop } from '../../apps/api/src/modules/platform/data-compaction/application/data-compaction-loop';
import { DrizzleDataCompactionRepository } from '../../apps/api/src/modules/platform/data-compaction/infrastructure/drizzle-data-compaction.repository';
import { DrizzleNightlyReportReader } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-nightly-report.reader';
import { nightlyReports } from '../../apps/api/src/modules/commerce/ops-log/application/nightly-report';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';

/**
 * Round 9 C3: the data compaction against a real PostgreSQL — the allow-list's predicates,
 * 0279's guard on the operator lane's evidence, the unit of work's quiesce gate and the
 * nightly line.
 *
 * Every case names what must SURVIVE, because that is the rule: a PENDING or UNCONFIRMED
 * notification, a money kind, an unannounced operation's notice, an open receipt window, a
 * window a provider receipt names, a row stamped exactly AT the cutoff, and every table that
 * is not on the allow-list.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const BOT = SEED_IDS.botA1;
/** The default retentions: 90 / 180 / 90 days. */
const OPS_CUTOFF = new Date(NOW.getTime() - 90 * DAY);
const CUSTOMER_CUTOFF = new Date(NOW.getTime() - 180 * DAY);
const RECEIPT_CUTOFF = new Date(NOW.getTime() - 90 * DAY);
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('data compaction (Round 9 C3)', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: ActorContext;
  let ownerId: string;
  let customer: string;
  let panel: string;

  const db = () => ctx.container.database.db;
  const job = (): ActorContext =>
    systemJobActor('data-compaction-test', randomUUID() as CorrelationId);

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(SEED_IDS.tenantA as never);
    const admin = await createAdmin(ctx.container, tenantA, {
      username: 'owner-compaction',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(admin);
    ownerId = admin.id;
    fx = new AudienceFixtures(ctx, SEED_IDS.tenantA);
    panel = await fx.panel('compaction');
    customer = await fx.customer({ telegramUserId: '7700001', botInstanceId: BOT });
  });

  /** A service on a fixed clock, so a row stamped AT the cutoff is decidable. */
  function service(
    options: {
      readonly batchSize?: number;
      readonly maxBatches?: number;
      readonly inFlight?: () => Promise<DataCompactionStopReason | null>;
      readonly uow?: DrizzleUnitOfWork;
      readonly scopeIsActive?: (scope: never, tx?: unknown) => Promise<boolean>;
    } = {},
  ): DataCompactionService {
    const c = ctx.container;
    return new DataCompactionService({
      repository: new DrizzleDataCompactionRepository(db()),
      uow: options.uow ?? c.uow,
      guard: c.guard,
      audit: c.audit,
      opsLog: c.opsLog,
      scopeActivity:
        options.scopeIsActive === undefined
          ? c.tenants
          : { scopeIsActive: options.scopeIsActive as never },
      settings: c.settingsResolver,
      clock: { now: () => NOW },
      ids: c.ids,
      inFlight: options.inFlight ?? (async () => null),
      batchSize: options.batchSize ?? 5000,
      maxBatchesPerPass: options.maxBatches ?? 200,
    });
  }

  async function setMode(mode: 'DRY_RUN' | 'APPLY'): Promise<void> {
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'retention.compaction_mode',
      value: mode,
      expectedVersion: null,
      idempotencyKey: `mode-${randomUUID()}`,
    } as never);
  }

  // --- fixtures ------------------------------------------------------------------------

  async function opsNotification(input: {
    readonly status: 'SENT' | 'FAILED' | 'PENDING';
    readonly completed: Date | null;
    readonly attempts?: number;
    readonly releases?: number;
  }): Promise<string> {
    const id = randomUUID();
    const attempts = input.attempts ?? 1;
    await db().execute(sql`
      INSERT INTO notifications
        (id, tenant_id, kind, dedupe_key, destination, payload, template_key, status,
         attempt_count, max_attempts, created_at, last_attempt_at, next_attempt_at, completed_at)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, 'OPERATIONAL_EVENT', ${`test:${id}`},
              '{"kind":"TELEGRAM_CHAT","chatId":"-100"}'::jsonb, '{}'::jsonb,
              'ops.log.storm_rollup', ${input.status}, ${attempts + (input.releases ?? 0)}, 5,
              ${ago(400)}, ${ago(400)}, ${ago(400)}, ${input.completed})`);
    for (let n = 1; n <= attempts; n += 1) {
      const last = n === attempts && input.status === 'SENT';
      await db().execute(sql`
        INSERT INTO notification_delivery_attempts
          (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at,
           finished_at, error_code)
        VALUES (${randomUUID()}::uuid, ${SEED_IDS.tenantA}::uuid, ${id}::uuid, ${n}, 'RECORDING',
                ${last ? 'SUCCEEDED' : 'FAILED_RETRYABLE'}, ${ago(400)}, ${ago(400)},
                ${last ? null : 'telegram.unreachable'})`);
    }
    for (let r = 1; r <= (input.releases ?? 0); r += 1) {
      await db().execute(sql`
        INSERT INTO notification_released_claims
          (tenant_id, notification_id, attempt_number, released_at, reason)
        VALUES (${SEED_IDS.tenantA}::uuid, ${id}::uuid, ${attempts + r}, ${ago(400)}, 'test.release')`);
    }
    return id;
  }

  async function customerNotice(input: {
    readonly kind: string;
    readonly state: 'DELIVERED' | 'FAILED' | 'SUPERSEDED' | 'UNCONFIRMED' | 'PENDING';
    readonly resolved: Date | null;
    readonly subjectId?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db().execute(sql`
      INSERT INTO customer_notifications
        (id, tenant_id, customer_id, bot_instance_id, kind, subject_id, state, attempts,
         resolved_at, created_at, updated_at)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, ${customer}::uuid, ${BOT}::uuid,
              ${input.kind}, ${input.subjectId ?? randomUUID()}::uuid, ${input.state}, 1,
              ${input.resolved}, ${ago(400)}, ${ago(400)})`);
    return id;
  }

  async function operation(announced: boolean): Promise<string> {
    const serviceId = await fx.service({ customerId: customer, panelId: panel });
    const id = randomUUID();
    const opId = randomUUID().replace(/-/g, '').slice(0, 16);
    await db().execute(sql`
      INSERT INTO provisioning_operations
        (id, tenant_id, operation_id, service_id, panel_id, type, state, attempts,
         completed_at, announced_at)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, ${opId}, ${serviceId}::uuid,
              ${panel}::uuid, 'PROVISION', 'SUCCEEDED', 1, ${ago(300)},
              ${announced ? ago(300) : null})`);
    return id;
  }

  async function payment(): Promise<string> {
    const id = randomUUID();
    await db().execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount,
          currency, reference, resolved_at, resolved_by_admin_id, gateway_provider)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, ${customer}::uuid, NULL, 'FAILED',
              'MANUAL_TRANSFER', 100000, 'IRT', ${`DC-${id.slice(0, 8)}`}, ${ago(300)},
              ${ownerId}::uuid, 'MANUAL_TRANSFER')`);
    return id;
  }

  async function receiptWindow(paymentId: string, closed: Date | null): Promise<string> {
    const id = randomUUID();
    await db().execute(sql`
      INSERT INTO receipt_captures
        (id, tenant_id, bot_instance_id, customer_id, payment_id, opened_at, expires_at,
         closed_at, close_reason)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, ${BOT}::uuid, ${customer}::uuid,
              ${paymentId}::uuid, ${ago(400)}, ${ago(399)}, ${closed},
              ${closed === null ? null : 'EXPIRED'})`);
    return id;
  }

  async function gatewayWindow(
    paymentId: string,
    closed: Date | null,
    withSubmission = false,
  ): Promise<string> {
    const id = randomUUID();
    await db().execute(sql`
      INSERT INTO gateway_receipt_captures
        (id, tenant_id, bot_instance_id, customer_id, payment_id, provider, provider_invoice_id,
         opened_at, expires_at, closed_at, close_reason)
      VALUES (${id}::uuid, ${SEED_IDS.tenantA}::uuid, ${BOT}::uuid, ${customer}::uuid,
              ${paymentId}::uuid, 'TONPAYS_TELEGRAM', ${`inv-${id.slice(0, 8)}`}, ${ago(400)},
              ${ago(399)}, ${closed}, ${closed === null ? null : 'RECEIVED'})`);
    if (withSubmission) {
      await db().execute(sql`
        INSERT INTO gateway_receipt_submissions
          (id, tenant_id, payment_id, provider_invoice_id, bot_instance_id, customer_id,
           capture_id, telegram_file_id, telegram_file_unique_id, state, decided_at,
           created_at, updated_at)
        VALUES (${randomUUID()}::uuid, ${SEED_IDS.tenantA}::uuid, ${paymentId}::uuid,
                ${`inv-${id.slice(0, 8)}`}, ${BOT}::uuid, ${customer}::uuid, ${id}::uuid,
                'file-id', ${`u-${id}`}, 'ACCEPTED', ${ago(399)}, ${ago(399)}, ${ago(399)})`);
    }
    return id;
  }

  /** The database's own refusal, under drizzle's "Failed query" wrapper. */
  async function refused(work: Promise<unknown>, pattern: RegExp): Promise<void> {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error, 'the statement was refused').not.toBeNull();
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    expect(cause ?? String(error)).toMatch(pattern);
  }

  async function exists(table: string, id: string): Promise<boolean> {
    const result = await db().execute(
      sql`SELECT 1 FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
    );
    return result.rows.length === 1;
  }

  /** One of everything: what goes, what stays, and the rows exactly AT each cutoff. */
  async function scenario() {
    const pay = await payment();
    const ids = {
      // operator lane
      opsSentOld: await opsNotification({ status: 'SENT', completed: ago(91), attempts: 2 }),
      opsFailedOld: await opsNotification({
        status: 'FAILED',
        completed: ago(200),
        attempts: 1,
        releases: 1,
      }),
      opsAtCutoff: await opsNotification({ status: 'SENT', completed: OPS_CUTOFF }),
      opsRecent: await opsNotification({ status: 'SENT', completed: ago(10) }),
      opsPendingOld: await opsNotification({ status: 'PENDING', completed: null }),
      // customer lane
      reminderOld: await customerNotice({
        kind: 'SERVICE_EXPIRY_FIRST',
        state: 'DELIVERED',
        resolved: ago(181),
      }),
      lowBalanceFailedOld: await customerNotice({
        kind: 'WALLET_LOW_BALANCE',
        state: 'FAILED',
        resolved: ago(365),
      }),
      reminderAtCutoff: await customerNotice({
        kind: 'SERVICE_EXPIRY_FIRST',
        state: 'DELIVERED',
        resolved: CUSTOMER_CUTOFF,
      }),
      reminderUnconfirmedOld: await customerNotice({
        kind: 'SERVICE_EXPIRY_SECOND',
        state: 'UNCONFIRMED',
        resolved: ago(365),
      }),
      reminderPending: await customerNotice({
        kind: 'SERVICE_USAGE_FIRST',
        state: 'PENDING',
        resolved: null,
      }),
      moneyKindOld: await customerNotice({
        kind: 'PAYMENT_REJECTED',
        state: 'DELIVERED',
        resolved: ago(365),
        subjectId: pay,
      }),
      ticketKindOld: await customerNotice({
        kind: 'TICKET_REPLY',
        state: 'DELIVERED',
        resolved: ago(365),
      }),
      announcedOld: await customerNotice({
        kind: 'SERVICE_ACTION_SUCCEEDED',
        state: 'DELIVERED',
        resolved: ago(200),
        subjectId: await operation(true),
      }),
      unannouncedOld: await customerNotice({
        kind: 'SERVICE_ACTION_SUCCEEDED',
        state: 'DELIVERED',
        resolved: ago(200),
        subjectId: await operation(false),
      }),
      // receipt windows
      windowClosedOld: await receiptWindow(pay, ago(91)),
      windowAtCutoff: await receiptWindow(pay, RECEIPT_CUTOFF),
      windowClosedRecent: await receiptWindow(pay, ago(5)),
      gatewayClosedOld: await gatewayWindow(pay, ago(120)),
      gatewayWithReceiptOld: await gatewayWindow(pay, ago(120), true),
    };
    // The one open window per customer and bot; it closed nothing, so it is never eligible.
    const windowOpen = await receiptWindow(pay, null);
    return { ...ids, windowOpen, payment: pay };
  }

  const REMOVED = [
    ['notifications', 'opsSentOld'],
    ['notifications', 'opsFailedOld'],
    ['customer_notifications', 'reminderOld'],
    ['customer_notifications', 'lowBalanceFailedOld'],
    ['customer_notifications', 'announcedOld'],
    ['receipt_captures', 'windowClosedOld'],
    ['gateway_receipt_captures', 'gatewayClosedOld'],
  ] as const;
  const KEPT = [
    ['notifications', 'opsAtCutoff'],
    ['notifications', 'opsRecent'],
    ['notifications', 'opsPendingOld'],
    ['customer_notifications', 'reminderAtCutoff'],
    ['customer_notifications', 'reminderUnconfirmedOld'],
    ['customer_notifications', 'reminderPending'],
    ['customer_notifications', 'moneyKindOld'],
    ['customer_notifications', 'ticketKindOld'],
    ['customer_notifications', 'unannouncedOld'],
    ['receipt_captures', 'windowAtCutoff'],
    ['receipt_captures', 'windowClosedRecent'],
    ['receipt_captures', 'windowOpen'],
    ['gateway_receipt_captures', 'gatewayWithReceiptOld'],
    ['payments', 'payment'],
  ] as const;

  /** Every table's row count, but for the allow-list's and the two the pass writes itself. */
  async function protectedCounts(): Promise<Record<string, number>> {
    const skip = new Set<string>([
      ...DATA_COMPACTION_CLASSES.flatMap((cls) => [...DATA_COMPACTION_CLASS_TABLES[cls]]),
      'data_compaction_runs',
      'audit_logs',
    ]);
    const tables = await db().execute<{ name: string }>(sql`
      SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    const out: Record<string, number> = {};
    for (const { name } of tables.rows) {
      if (skip.has(name)) continue;
      const counted = await db().execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM ${sql.identifier(name)}`,
      );
      out[name] = Number(counted.rows[0]?.n ?? 0);
    }
    return out;
  }

  // --- cases ---------------------------------------------------------------------------

  it('dry run is the default: counts per table, records the run, deletes nothing', async () => {
    const ids = await scenario();
    const outcome = await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    expect(outcome.kind).toBe('RAN');
    if (outcome.kind !== 'RAN') return;
    expect(outcome.run.mode).toBe('DRY_RUN');
    expect(outcome.run.state).toBe('COMPLETED');
    expect(outcome.run.counts).toEqual({
      notifications: 2,
      notification_delivery_attempts: 3,
      notification_released_claims: 1,
      customer_notifications: 3,
      receipt_captures: 1,
      gateway_receipt_captures: 1,
    });
    for (const [table, key] of [...REMOVED, ...KEPT]) {
      expect(await exists(table, ids[key]), `${table} ${key}`).toBe(true);
    }
    const audit = await db().execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'data.compaction.dry_run'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('APPLY removes exactly what the dry run counted, half-open at every cutoff, and nothing else', async () => {
    const ids = await scenario();
    const preview = await service().preview(tenantA, owner);
    const previewed = Object.assign({}, ...preview.classes.map((entry) => entry.counts)) as Record<
      string,
      number
    >;
    await setMode('APPLY');
    const before = await protectedCounts();
    const outcome = await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    if (outcome.kind !== 'RAN') throw new Error(outcome.kind);
    expect(outcome.run.mode).toBe('APPLY');
    expect(outcome.run.state).toBe('COMPLETED');
    expect(outcome.run.counts).toEqual(previewed);
    for (const [table, key] of REMOVED) {
      expect(await exists(table, ids[key]), `${table} ${key} removed`).toBe(false);
    }
    for (const [table, key] of KEPT) {
      expect(await exists(table, ids[key]), `${table} ${key} kept`).toBe(true);
    }
    // The removed intents took their evidence with them, and only theirs.
    const orphans = await db().execute(sql`
      SELECT
        (SELECT count(*) FROM notification_delivery_attempts a
          WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.id = a.notification_id))::int AS a,
        (SELECT count(*) FROM notification_released_claims r
          WHERE NOT EXISTS (SELECT 1 FROM notifications n WHERE n.id = r.notification_id))::int AS r`);
    expect(orphans.rows[0]).toEqual({ a: 0, r: 0 });
    // The dispatcher's invariant 3 holds for every intent that remains.
    const bare = await db().execute(sql`
      SELECT n.id FROM notifications n
       WHERE n.status <> 'PENDING'
         AND NOT EXISTS (SELECT 1 FROM notification_delivery_attempts a WHERE a.notification_id = n.id)`);
    expect(bare.rows).toHaveLength(0);
    // Every table that is not on the allow-list has exactly the rows it had.
    expect(await protectedCounts()).toEqual(before);
  });

  it('deletes in keyset batches, each its own transaction with one audit row', async () => {
    for (let n = 0; n < 5; n += 1) await opsNotification({ status: 'SENT', completed: ago(100) });
    await setMode('APPLY');
    const outcome = await service({ batchSize: 2 }).run(tenantA, job(), {
      trigger: 'WORKER',
      mode: 'SETTING',
    });
    if (outcome.kind !== 'RAN') throw new Error(outcome.kind);
    expect(outcome.run.counts['notifications']).toBe(5);
    const batches = await db().execute<{ rows: { notifications?: number } }>(sql`
      SELECT after -> 'rows' AS rows FROM audit_logs
       WHERE action = 'data.compaction.batch' ORDER BY occurred_at, id`);
    expect(batches.rows.map((row) => row.rows.notifications)).toEqual([2, 2, 1]);
  });

  it('is idempotent: a second pass removes nothing and changes nothing', async () => {
    await scenario();
    await setMode('APPLY');
    await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    const before = await protectedCounts();
    const again = await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    if (again.kind !== 'RAN') throw new Error(again.kind);
    expect(totalOf(again.run.counts)).toBe(0);
    expect(again.run.state).toBe('COMPLETED');
    expect(await protectedCounts()).toEqual(before);
  });

  it('stops at the batch ceiling and the next pass continues', async () => {
    for (let n = 0; n < 4; n += 1) await opsNotification({ status: 'SENT', completed: ago(100) });
    await setMode('APPLY');
    const first = await service({ batchSize: 1, maxBatches: 2 }).run(tenantA, job(), {
      trigger: 'WORKER',
      mode: 'SETTING',
    });
    if (first.kind !== 'RAN') throw new Error(first.kind);
    expect(first.run.state).toBe('STOPPED');
    expect(first.run.stopReason).toBe('BATCH_CEILING');
    expect(first.run.counts['notifications']).toBe(2);
    const second = await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    if (second.kind !== 'RAN') throw new Error(second.kind);
    expect(second.run.counts['notifications']).toBe(2);
  });

  it('respects the recovery quiesce through the unit of work, before and between batches', async () => {
    for (let n = 0; n < 3; n += 1) await opsNotification({ status: 'SENT', completed: ago(100) });
    await setMode('APPLY');
    // Quiesced from the start: the pass's own first transaction is refused.
    const shut = new DrizzleUnitOfWork(db(), { quiescedBy: async () => 'recovery-under-test' });
    expect(
      await service({ uow: shut }).run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' }),
    ).toEqual({ kind: 'BLOCKED', reason: 'RECOVERY_IN_FLIGHT' });
    const left = async () =>
      Number(
        (await db().execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM notifications`))
          .rows[0]?.n,
      );
    expect(await left()).toBe(3);

    // A quiesce that begins after the first batch: that batch stands, the rest is refused.
    let transactions = 0;
    const closing = new DrizzleUnitOfWork(db(), {
      quiescedBy: async () => {
        transactions += 1;
        // 1: begin, 2: the first batch. From the third on, the installation is shut.
        return transactions > 2 ? 'recovery-under-test' : null;
      },
    });
    const outcome = await service({ uow: closing, batchSize: 1 }).run(tenantA, job(), {
      trigger: 'WORKER',
      mode: 'SETTING',
    });
    expect(outcome.kind).toBe('RAN');
    expect(await left()).toBe(2);
  });

  it('reads scope activity inside its transactions: a stopped tenant stops the pass', async () => {
    for (let n = 0; n < 3; n += 1) await opsNotification({ status: 'SENT', completed: ago(100) });
    await setMode('APPLY');
    // Stopped before the pass: nothing starts.
    await db().execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}::uuid`,
    );
    expect(await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' })).toEqual({
      kind: 'BLOCKED',
      reason: 'SCOPE_INACTIVE',
    });
    await db().execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${SEED_IDS.tenantA}::uuid`,
    );
    // Stopped after the first batch committed: the next batch's own read refuses it.
    let reads = 0;
    const outcome = await service({
      batchSize: 1,
      scopeIsActive: async (scope, tx) => {
        reads += 1;
        return reads <= 2 && (await ctx.container.tenants.scopeIsActive(scope, tx));
      },
    }).run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    if (outcome.kind !== 'RAN') throw new Error(outcome.kind);
    expect(outcome.run.state).toBe('STOPPED');
    expect(outcome.run.stopReason).toBe('SCOPE_INACTIVE');
    expect(outcome.run.counts['notifications']).toBe(1);
  });

  it('starts nothing while a recovery holds the installation (the container probe)', async () => {
    await opsNotification({ status: 'SENT', completed: ago(3000) });
    await setMode('APPLY');
    await db().execute(sql`
      INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
      VALUES ('01900000-0000-7000-8000-00000000dc01', ${SEED_IDS.tenantA}::uuid, 'UPLOAD',
              'PRE_RESTORE_BACKUP', 'RECEIVE_UPLOAD', now(), now())`);
    const outcome = await ctx.container.dataCompaction.run(tenantA, job(), {
      trigger: 'WORKER',
      mode: 'SETTING',
    });
    expect(outcome).toEqual({ kind: 'BLOCKED', reason: 'RECOVERY_IN_FLIGHT' });
    const left = await db().execute(sql`SELECT 1 FROM notifications`);
    expect(left.rows).toHaveLength(1);
  });

  it("0279: the operator lane's evidence stays undeletable outside an APPLY pass", async () => {
    const id = await opsNotification({ status: 'SENT', completed: ago(400) });
    const pending = await opsNotification({ status: 'PENDING', completed: null });
    const deny = /append-only; DELETE is not permitted/;
    const attempt = (notification: string) =>
      db().execute(
        sql`DELETE FROM notification_delivery_attempts WHERE notification_id = ${notification}::uuid`,
      );
    await refused(attempt(id), deny);
    // A DRY_RUN pass named in the setting is not an APPLY pass.
    const dry = await service().run(tenantA, job(), { trigger: 'CLI', mode: 'DRY_RUN' });
    if (dry.kind !== 'RAN') throw new Error(dry.kind);
    await refused(
      db().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('nexa.data_compaction_run', ${dry.run.id}, true)`);
        await tx.execute(
          sql`DELETE FROM notification_delivery_attempts WHERE notification_id = ${id}::uuid`,
        );
      }),
      deny,
    );
    // A RUNNING APPLY pass still may not touch a PENDING intent's evidence.
    const runId = randomUUID();
    await db().execute(sql`
      INSERT INTO data_compaction_runs (id, tenant_id, trigger, mode, state, started_at,
                                        heartbeat_at, cutoffs)
      VALUES (${runId}::uuid, ${SEED_IDS.tenantA}::uuid, 'CLI', 'APPLY', 'RUNNING', now(), now(),
              '{}'::jsonb)`);
    await refused(
      db().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('nexa.data_compaction_run', ${runId}, true)`);
        await tx.execute(
          sql`DELETE FROM notification_delivery_attempts WHERE notification_id = ${pending}::uuid`,
        );
      }),
      deny,
    );
    // The same RUNNING APPLY pass MAY remove a finished intent's evidence: the one exception.
    await db().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('nexa.data_compaction_run', ${runId}, true)`);
      await tx.execute(
        sql`DELETE FROM notification_delivery_attempts WHERE notification_id = ${id}::uuid`,
      );
    });
    // And an UPDATE is refused whatever the setting says.
    await refused(
      db().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('nexa.data_compaction_run', ${runId}, true)`);
        await tx.execute(
          sql`UPDATE notification_delivery_attempts SET error_code = 'x' WHERE notification_id = ${pending}::uuid`,
        );
      }),
      /append-only; UPDATE is not permitted/,
    );
  });

  it('the CLI confirmation must match the eligible total, or nothing is removed', async () => {
    await scenario();
    const mismatch = await service().run(tenantA, job(), {
      trigger: 'CLI',
      mode: 'APPLY',
      expectRows: 1,
    });
    expect(mismatch.kind).toBe('COUNT_MISMATCH');
    if (mismatch.kind !== 'COUNT_MISMATCH') return;
    expect(mismatch.eligibleRows).toBe(11);
    const runs = await db().execute(sql`SELECT 1 FROM data_compaction_runs`);
    expect(runs.rows).toHaveLength(0);
    const applied = await service().run(tenantA, job(), {
      trigger: 'CLI',
      mode: 'APPLY',
      expectRows: mismatch.eligibleRows,
    });
    if (applied.kind !== 'RAN') throw new Error(applied.kind);
    expect(totalOf(applied.run.counts)).toBe(11);
  });

  it('denies an actor without maintenance.run, audited, and runs nothing', async () => {
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-dc', roleKeys: ['operator'] }),
    );
    await expect(service().preview(tenantA, operator)).rejects.toSatisfy(
      (error: unknown) => isNexaError(error) && error.kind === 'PERMISSION_DENIED',
    );
    const denied = await db().execute(
      sql`SELECT 1 FROM audit_logs WHERE action = 'data.compaction.preview' AND result = 'DENIED'`,
    );
    expect(denied.rows).toHaveLength(1);
  });

  it('a stale RUNNING pass is failed as abandoned, never adopted', async () => {
    const stale = randomUUID();
    await db().execute(sql`
      INSERT INTO data_compaction_runs (id, tenant_id, trigger, mode, state, started_at,
                                        heartbeat_at, cutoffs)
      VALUES (${stale}::uuid, ${SEED_IDS.tenantA}::uuid, 'WORKER', 'APPLY', 'RUNNING',
              ${ago(1)}, ${ago(1)}, '{}'::jsonb)`);
    const outcome = await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    expect(outcome.kind).toBe('RAN');
    const row = await db().execute<{ state: string; stop_reason: string }>(
      sql`SELECT state, stop_reason FROM data_compaction_runs WHERE id = ${stale}::uuid`,
    );
    expect(row.rows[0]).toEqual({ state: 'FAILED', stop_reason: 'ABANDONED' });
  });

  it('the worker loop runs once a day, as SYSTEM_JOB, in the configured mode', async () => {
    await opsNotification({ status: 'SENT', completed: ago(3000) });
    const loop = new DataCompactionLoop(service(), new DrizzleDataCompactionRepository(db()), {
      scope: () => tenantA,
      intervalMs: 3_600_000,
      initialDelayMs: 1,
      now: () => NOW.getTime(),
      correlationId: () => randomUUID(),
      logger: { info: () => undefined, error: () => undefined },
    });
    await loop.tick();
    await loop.tick();
    const runs = await db().execute<{ mode: string; trigger: string }>(
      sql`SELECT mode, trigger FROM data_compaction_runs`,
    );
    // The second wake-up is inside the day: one pass, a dry run, nothing removed.
    expect(runs.rows).toEqual([{ mode: 'DRY_RUN', trigger: 'WORKER' }]);
    expect((await db().execute(sql`SELECT 1 FROM notifications`)).rows).toHaveLength(1);
  });

  it('puts one compaction line into the nightly summary, for the passes of that day', async () => {
    await scenario();
    await setMode('APPLY');
    await service().run(tenantA, job(), { trigger: 'WORKER', mode: 'SETTING' });
    const reader = new DrizzleNightlyReportReader(db());
    const window = (start: Date, end: Date) => ({
      start,
      end,
      previousStart: new Date(start.getTime() - DAY),
      previousEnd: start,
      currency: 'IRT' as const,
      timezone: 'Asia/Tehran',
    });
    // The pass started AT `NOW`: in [NOW, NOW + 1d), not in [NOW − 1d, NOW).
    const inside = await ctx.container.uow.run(tenantA, (tx) =>
      reader.read(tenantA, window(NOW, new Date(NOW.getTime() + DAY)), tx),
    );
    expect(inside.compaction).toEqual({
      applied: true,
      classes: { OPS_NOTIFICATIONS: 6, CUSTOMER_NOTIFICATIONS: 3, RECEIPT_WINDOWS: 2 },
    });
    const before = await ctx.container.uow.run(tenantA, (tx) =>
      reader.read(tenantA, window(new Date(NOW.getTime() - DAY), NOW), tx),
    );
    expect(before.compaction).toBeNull();
    const [summary] = nightlyReports({ ...inside, day: NOW }, i18nOpsLogWords);
    expect(String(summary?.values['cleanup'])).toBe(
      '🗜 فشرده‌سازی داده — حذف شد: اعلان‌های عملیات ۶ · اعلان‌های کاربران ۳ · پنجره‌های رسید ۲',
    );
  });
});
