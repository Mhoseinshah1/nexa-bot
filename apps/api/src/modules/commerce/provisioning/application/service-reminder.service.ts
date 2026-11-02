import {
  COMMERCE_ERROR_CODES,
  errors,
  EXPIRY_REMINDER_KINDS,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  SERVICE_REMINDER_SWEEP_LIMIT,
  expiryReminderDue,
  usageRemindersReached,
  systemJobActor,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type FeatureFlagKey,
  type IdGenerator,
  type ScopeContext,
  type ServiceReminderKind,
  type ServiceReminderThresholds,
  type SettingKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { ServiceAlertHook } from '../../ops-log/application/service-alert-log.js';
import type {
  ServiceReminderCandidate,
  ServiceReminderRepository,
  ServiceReminderSnapshot,
} from './service-reminder.ports.js';

/**
 * The two readers this lane needs, narrowed to the one method each.
 *
 * Declared here rather than imported from `control`, so the sweep cannot WRITE a
 * setting or a flag from a background loop. The container binds them to
 * `SettingsResolver` and `FeatureFlagsService`, which is where the permission checks,
 * the audit and the validation live.
 */
export interface ReminderSettingsReader {
  valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
}
export interface ReminderFeatureReader {
  isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
}

const DAY_MS = 86_400_000;

/** Round 5A item 1: one reconcile batch, and how many a pass may run. */
const RECONCILE_BATCH_SIZE = 500;
const RECONCILE_MAX_BATCHES_PER_PASS = 40;

/** What one pass did, for the loop's log and for a test. */
export interface ServiceReminderReport {
  readonly expiry: number;
  readonly usage: number;
}

/**
 * What a burst seed decided (`seedPassedThresholds`).
 *
 * `passed` — every kind already behind the service against its current basis, least
 * urgent first within each family. `seeded` — the subset THIS call wrote; a rerun writes
 * nothing and returns `[]` here with the same `passed`.
 */
export interface ServiceReminderSeed {
  readonly passed: readonly ServiceReminderKind[];
  readonly seeded: readonly ServiceReminderKind[];
}

/**
 * The thresholds already behind a service NOW — the one decision the burst seed makes,
 * pure so a unit test can pin every branch.
 *
 * Built from the sweep's own two functions and its own prefix rule, so "passed" here and
 * "due" there cannot disagree: the expiry kinds are `EXPIRY_REMINDER_KINDS` up to and
 * including `expiryReminderDue`; the usage kinds are `usageRemindersReached`, and only
 * for a measured figure.
 */
export function passedReminderKinds(
  candidate: Pick<
    ServiceReminderCandidate,
    'expiresAt' | 'expiryDayStartsAt' | 'trafficLimitBytes' | 'trafficUsedBytes'
  > & { readonly usageMeasured: boolean },
  now: Date,
  thresholds: ServiceReminderThresholds,
): {
  readonly expiry: readonly ServiceReminderKind[];
  readonly usage: readonly ServiceReminderKind[];
} {
  const due = expiryReminderDue(candidate.expiresAt, now, thresholds, candidate.expiryDayStartsAt);
  const expiry =
    due === null ? [] : EXPIRY_REMINDER_KINDS.slice(0, EXPIRY_REMINDER_KINDS.indexOf(due) + 1);
  const usage = candidate.usageMeasured
    ? [
        ...usageRemindersReached(
          candidate.trafficUsedBytes,
          candidate.trafficLimitBytes,
          thresholds,
        ),
      ].reverse()
    : [];
  return { expiry, usage };
}

/**
 * Round 4 PR-H (post-import safety): the kinds that were ALREADY behind an imported service
 * when the import created it — judged under the thresholds in force NOW — for its current
 * period. Pure, so a unit test pins every branch.
 *
 * The burst seed records what was behind the service under the thresholds of the moment it
 * ran. This is the same question asked again at every pass, of the baseline the seed left,
 * so a threshold an operator moves after the import (a week to ten days, eighty percent to
 * seventy) cannot turn a period the previous bot already handled into a crossing: "already
 * behind at the import, under today's thresholds" is `passedReminderKinds` evaluated at the
 * import's moment, with the figure the import read. A kind in the answer is recorded and
 * never sent; a kind first reached after the import is a genuine change and is sent as
 * usual. A native service, or an imported one whose period has moved since, has no
 * baseline and the answer is empty.
 */
export function importedReminderKinds(
  candidate: Pick<
    ServiceReminderCandidate,
    'expiresAt' | 'expiryDayStartsAt' | 'trafficLimitBytes' | 'importBaseline'
  >,
  thresholds: ServiceReminderThresholds,
): {
  readonly expiry: readonly ServiceReminderKind[];
  readonly usage: readonly ServiceReminderKind[];
} {
  const baseline = candidate.importBaseline ?? null;
  if (baseline === null) return { expiry: [], usage: [] };
  return passedReminderKinds(
    {
      expiresAt: candidate.expiresAt,
      expiryDayStartsAt: candidate.expiryDayStartsAt,
      trafficLimitBytes: candidate.trafficLimitBytes,
      trafficUsedBytes: baseline.usedBytes ?? 0n,
      usageMeasured: baseline.usedBytes !== null,
    },
    baseline.at,
    thresholds,
  );
}

export interface ServiceReminderServiceDeps {
  readonly reminders: ServiceReminderRepository;
  readonly settings: ReminderSettingsReader;
  readonly features: ReminderFeatureReader;
  readonly notifier: CustomerNotifier;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Round 5A item 1: the audit row each reconcile batch writes. Without it the reconcile of
   * notices an earlier release queued does not run (a batch with no record is not allowed).
   */
  readonly audit?: AuditWriter;
  /**
   * Round 4 PR-D (log L21): told once per service and kind when the CUSTOMER was told, so the
   * operations log group gets one message per service. A savepoint of its own: a log that
   * cannot be written never costs a reminder.
   */
  readonly opsLog?: ServiceAlertHook;
  /** Where a log that could not be written is reported; never rethrown. */
  readonly opsLogFailed?: (error: unknown, serviceId: string) => void;
}

/**
 * The lane that tells a customer their service is running out — of days, or of traffic.
 *
 * ## Why it dials nothing
 *
 * Both halves read columns this installation already maintains. `expires_at` is written
 * by the create and by every commercial action; `traffic_used_bytes` is written by
 * `SYNC_USAGE`, which is the operation that already talks to panels on a cadence. A
 * reminder sweep that asked a panel would be a second usage-read lane with its own
 * budget, its own failure modes and its own opinion of the figure — and the figure it
 * disagreed with would be the one the customer is shown on their service page.
 *
 * So this runs in the WORKER, beside the payment expiry sweep, for the reason that
 * sweep gives: nothing here needs a panel, and a wedged panel must not delay work that
 * does not.
 *
 * ## One reminder per pass per service, most urgent first
 *
 * A service that crossed two thresholds since the last pass is told about the more
 * urgent one and the other is RECORDED as raised without being sent. Two messages an
 * hour apart, the second less alarming than the first, is a lane contradicting itself;
 * recording the skipped kind is what stops it firing afterwards and doing exactly that.
 *
 * ## What is NOT here
 *
 * **No audit row.** `docs/conventions.md` keeps audit for a mutation with a before and
 * an after of a domain entity, and raising a reminder changes no entity. The durable
 * record is the pair this transaction writes: the `service_reminders` row says what was
 * decided and against which period, and the `customer_notifications` row carries the
 * delivery through to a recorded outcome. An audit entry would be a third copy of a
 * fact two tables already hold.
 *
 * **No operational event.** A service reaching the end of what somebody bought is the
 * product working, not a condition an operator must act on. That is the distinction
 * that keeps the operations log from becoming `/admin/logs`.
 *
 * **Thresholds are the tenant's settings** (the owner's correction to Phase 6C), read
 * per pass. A row is keyed on the PERIOD, not on the number that produced it, so moving a
 * threshold never re-sends a reminder already raised for the period.
 *
 * ## WP-A9
 *
 * Five expiry slots (7, 3 and 1 days before, the day itself, and after), three usage
 * slots at 20%, 10% and 5% remaining by default. "The day itself" is the expiry's
 * calendar day in the TENANT'S display timezone, derived by the candidate query from
 * `tenants.display_timezone` and handed to `expiryReminderDue` with the row, so the
 * filter and the decision use one boundary. And every reminder is re-checked at SEND
 * time by the notification lane's subject reader: a renewal, a traffic top-up or a
 * termination between the raise and the send supersedes the message.
 */
export class ServiceReminderService {
  constructor(private readonly deps: ServiceReminderServiceDeps) {}

  /**
   * One pass.
   *
   * ONE transaction for both halves, and every write in it: the reminder row and the
   * notification that names it commit together or not at all. A reminder row without
   * its notification is a customer who will never be told and a lane that believes it
   * already has; a notification without its row is a message with a subject that does
   * not exist.
   *
   * The scope-activity check is inside the transaction and before either half, for the
   * reason `CLAUDE.md` gives: a surface checks on arrival and a stop can commit in
   * between. A stopped tenant is a pass that did nothing, NOT a failed one — the same
   * answer `PaymentExpiryService` gives, and for the same reason, which is that
   * `LoopProgress` records no progress for a pass that threw and an operator who
   * stopped a tenant would otherwise make the worker report itself unhealthy.
   */
  async runOnce(scope: TenantContext): Promise<ServiceReminderReport> {
    await this.reconcileImportedNotices(scope);
    const now = this.deps.clock.now();

    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        return { expiry: 0, usage: 0 };
      }
      const thresholds = await this.thresholds(scope, tx);
      /*
       * Round 11, B6: whether a customer's stored reminder opt-out is in force. Read in the
       * pass's own transaction, with the other switches, so a flag turned off mid-pass cannot
       * leave a pass honouring what the installation no longer offers. Off: every customer is
       * reminded exactly as before the feature existed.
       */
      const optOutHonoured = await this.deps.features.isEnabled(
        scope,
        'customer_reminder_opt_out',
        tx,
      );
      const expiry = await this.sweepExpiry(scope, now, thresholds, optOutHonoured, tx);
      const usage = await this.sweepUsage(scope, now, thresholds, optOutHonoured, tx);
      return { expiry, usage };
    });
  }

  /**
   * Round 5A-2 items 1 and 3 — the one reconcile of what an import left behind, run at the
   * worker's start and at the start of EVERY pass (the sweep must never see an imported
   * service without a baseline, so this precedes it).
   *
   *   1. the usage notices of the earlier 5A rule (unchanged, and first, so its audit rows
   *      keep their meaning);
   *   2. a baseline for every imported service that lacks one (`reconcileImportedBaselines`);
   *   3. every queued service-reminder notice the shared guard refuses is `SUPERSEDED`
   *      (`supersedeImportedServiceNotices`) — AFTER 2, because the guard asks for a
   *      baseline and the ones just written are what refuse the notices queued before them.
   *
   * `unbounded` is the worker start, which walks the whole backlog; a pass is capped so a
   * huge installation catches up over several passes without holding the sweep back. Never a
   * message, never a panel call, nothing deleted.
   */
  async reconcileImportedNotices(
    scope: TenantContext,
    options: { readonly unbounded?: boolean; readonly shouldStop?: () => boolean } = {},
  ): Promise<{ readonly baselines: number; readonly superseded: number }> {
    await this.reconcileImportedUsageNotices(scope);
    const baselines = await this.reconcileImportedBaselines(scope, options);
    const superseded = await this.supersedeImportedServiceNotices(scope, options);
    return { baselines, superseded };
  }

  /**
   * Round 5A-2 item 1 — gives every imported service lacking a baseline the baseline it
   * would have got at import: every expiry and usage threshold its CURRENT state has already
   * reached is recorded as already passed (`passedReminderKinds`, the seed's own rule), the
   * baseline row is written at this moment WITHOUT a figure (the first panel read after the
   * takeover is the baseline; round 5C-2), and nothing is announced.
   *
   * Idempotent (`ON CONFLICT DO NOTHING` on both writes), resumable (keyset by id, rows that
   * have a baseline never come back), and bounded per batch: each batch is its own
   * transaction with its own scope-activity check and ONE audit row (counts, never a
   * customer). A row another transaction holds is skipped, not waited for.
   */
  async reconcileImportedBaselines(
    scope: TenantContext,
    options: { readonly unbounded?: boolean; readonly shouldStop?: () => boolean } = {},
  ): Promise<number> {
    const audit = this.deps.audit;
    if (audit === undefined) return 0;
    const maxBatches =
      options.unbounded === true ? Number.MAX_SAFE_INTEGER : RECONCILE_MAX_BATCHES_PER_PASS;
    let total = 0;
    let after: string | null = null;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Shutdown (round 5A-2): stop after the batch in hand, never mid-batch.
      if (options.shouldStop?.() === true) break;
      const done: { readonly count: number; readonly last: string | null; readonly size: number } =
        await this.deps.uow.run(scope, async (tx) => {
          if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
            return { count: 0, last: null, size: 0 };
          }
          const now = this.deps.clock.now();
          const rows = await this.deps.reminders.listUnbaselinedImported(
            scope,
            after,
            RECONCILE_BATCH_SIZE,
            tx,
          );
          if (rows.length === 0) return { count: 0, last: null, size: 0 };
          const thresholds = await this.thresholds(scope, tx);
          let written = 0;
          let recorded = 0;
          for (const candidate of rows) {
            const passed = passedReminderKinds(candidate, now, thresholds);
            const snapshot = this.snapshot(candidate, now);
            for (const kind of [...passed.expiry, ...passed.usage]) {
              const raised = await this.deps.reminders.raise(
                scope,
                {
                  id: this.deps.ids.uuid(),
                  serviceId: candidate.serviceId,
                  kind,
                  basis: candidate.basis,
                  snapshot,
                },
                now,
                tx,
              );
              if (raised) recorded += 1;
            }
            const baseline = await this.deps.reminders.recordBaseline(
              scope,
              {
                serviceId: candidate.serviceId,
                at: now,
                basis: candidate.basis,
                /*
                 * Round 5C-2: NEVER the figure on the row. A backfill is the lane taking an
                 * installation over, and the figure the row holds is the import's (or an earlier
                 * release's) — weeks old by now. Recording it as the baseline made the first
                 * panel read after the takeover look like a crossing and announced it (38
                 * notices in 20 minutes on the test server). With NULL the first figure
                 * `recordUsage` records is the baseline: silent, every threshold it has already
                 * reached marked as passed; only a LATER crossing is told. The thresholds the
                 * stale figure reached are still recorded above, silently.
                 */
                usedBytes: null,
              },
              tx,
            );
            if (baseline) written += 1;
          }
          await audit.record(
            scope,
            systemJobActor('service-reminders', this.deps.ids.uuid() as CorrelationId),
            {
              action: 'service_reminder.imported_baselines_backfilled',
              entityType: 'Service',
              entityId: null,
              before: { baselines: 0 },
              after: {
                baselines: written,
                remindersRecordedSilently: recorded,
                services: rows.length,
              },
              reason:
                'imported service without a baseline: what it had already reached is history, nothing announced',
              result: 'SUCCESS',
            },
            tx,
          );
          return {
            count: written,
            last: rows[rows.length - 1]?.serviceId ?? null,
            size: rows.length,
          };
        });
      total += done.count;
      if (done.size < RECONCILE_BATCH_SIZE || done.last === null) break;
      after = done.last;
    }
    return total;
  }

  /**
   * Round 5A-2 item 3 — `PENDING -> SUPERSEDED` for every queued service-reminder notice the
   * shared guard (`importedServiceNoticeRefused`) refuses. The lane's own unsent transition:
   * no row deleted, `FAILED` and `DELIVERED` untouched, claimed rows left to the dispatcher.
   * One audit row per batch (counts by kind, never a customer). Idempotent.
   */
  async supersedeImportedServiceNotices(
    scope: TenantContext,
    options: { readonly unbounded?: boolean; readonly shouldStop?: () => boolean } = {},
  ): Promise<number> {
    const audit = this.deps.audit;
    if (audit === undefined) return 0;
    const maxBatches =
      options.unbounded === true ? Number.MAX_SAFE_INTEGER : RECONCILE_MAX_BATCHES_PER_PASS;
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      // Shutdown (round 5A-2): stop after the batch in hand, never mid-batch.
      if (options.shouldStop?.() === true) break;
      const moved = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
        const now = this.deps.clock.now();
        const rows = await this.deps.reminders.supersedeImportedServiceNotices(
          scope,
          RECONCILE_BATCH_SIZE,
          now,
          tx,
        );
        if (rows.length === 0) return 0;
        const byKind: Record<string, number> = {};
        for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
        await audit.record(
          scope,
          systemJobActor('service-reminders', this.deps.ids.uuid() as CorrelationId),
          {
            action: 'service_reminder.imported_notices_superseded',
            entityType: 'CustomerNotification',
            entityId: null,
            before: { state: 'PENDING' },
            after: {
              state: 'SUPERSEDED',
              count: rows.length,
              customers: new Set(rows.map((row) => row.customerId)).size,
              byKind,
            },
            reason:
              'notice for an imported service not backed by a transition seen after the import',
            result: 'SUCCESS',
          },
          tx,
        );
        return rows.length;
      });
      total += moved;
      if (moved < RECONCILE_BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Round 5A item 1 — notices an earlier release queued for imported services.
   *
   * Before the first usage figure after an import became the service's silent baseline, the
   * first `SYNC_USAGE` read was announced: «اولین استفاده از سرویس» to customers whose usage
   * the previous bot had long ago handled. Those notices are still `PENDING`, and the
   * send-time precondition (`importedUnmeasuredUsageNotice`) would stop each at its own
   * claim; this moves them to `SUPERSEDED` ahead of it, in bounded batches, each with ONE
   * audit row (counts by kind, never a customer). The lane's own `PENDING -> SUPERSEDED`
   * transition and nothing else: no row is deleted, no `announced_at` is touched, nothing
   * is sent. Idempotent — a pass that finds none writes nothing.
   *
   * Bounded per pass so a huge queue cannot hold the worker, and every batch is its own
   * transaction with its own scope-activity check.
   */
  async reconcileImportedUsageNotices(scope: TenantContext): Promise<number> {
    const audit = this.deps.audit;
    if (audit === undefined) return 0;
    let total = 0;
    for (let batch = 0; batch < RECONCILE_MAX_BATCHES_PER_PASS; batch += 1) {
      const moved = await this.deps.uow.run(scope, async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
        const now = this.deps.clock.now();
        const rows = await this.deps.reminders.supersedeImportedUsageNotices(
          scope,
          RECONCILE_BATCH_SIZE,
          now,
          tx,
        );
        if (rows.length === 0) return 0;
        const byKind: Record<string, number> = {};
        for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
        await audit.record(
          scope,
          systemJobActor('service-reminders', this.deps.ids.uuid() as CorrelationId),
          {
            action: 'service_reminder.imported_usage_notices_superseded',
            entityType: 'CustomerNotification',
            entityId: null,
            before: { state: 'PENDING' },
            after: {
              state: 'SUPERSEDED',
              count: rows.length,
              customers: new Set(rows.map((row) => row.customerId)).size,
              byKind,
            },
            reason: 'usage notice for a state that already existed when the service was imported',
            result: 'SUCCESS',
          },
          tx,
        );
        return rows.length;
      });
      total += moved;
      if (moved < RECONCILE_BATCH_SIZE) break;
    }
    return total;
  }

  /**
   * Migration P6, Item 8 — burst protection for a service that arrives mid-period.
   *
   * An adopted legacy service is born already near its expiry, past several usage
   * thresholds, or expired. To the sweep it would look like a service whose thresholds
   * were all crossed since its last pass, and every adopted service would be told
   * something on the first pass after the import — thousands of "your service expired"
   * and "95% used" messages about periods the legacy bot already handled. This records
   * every threshold that is ALREADY behind the service as raised, against its CURRENT
   * basis, with no notification — exactly what the sweep does for the kinds below the one
   * it announces, so it is the existing lane's own record, not a second reminder system.
   *
   * - Expiry: the whole prefix of `EXPIRY_REMINDER_KINDS` up to the kind
   *   `expiryReminderDue` returns now (the sweep's `upTo`).
   * - Usage: every kind `usageRemindersReached` returns, when the figure was measured
   *   (`usage_synced_at`), as the usage query requires.
   *
   * Thresholds are the tenant's settings, read in THIS transaction. Flags are NOT
   * consulted: a family switched off today and on tomorrow must not then announce a
   * crossing that happened before the service was adopted — the reason the sweep records
   * a switched-off expiry kind instead of skipping it.
   *
   * What still fires: every threshold not yet behind the service, against this basis, and
   * everything in a new period (a renewal or added traffic moves the basis, and the rows
   * written here no longer match it).
   *
   * Runs inside the CALLER's transaction (the adoption's), which has already read scope
   * activity; it reads it again, because a step that writes must not rely on its caller
   * having remembered. Idempotent: every write is the sweep's own `ON CONFLICT DO NOTHING`
   * on the period key, so a rerun, or two adoptions racing, write each row once.
   * `seeded` lists the kinds THIS call wrote.
   */
  async seedPassedThresholds(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<ServiceReminderSeed> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
    const candidate = await this.deps.reminders.seedCandidate(scope, serviceId, tx);
    if (candidate === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    const now = this.deps.clock.now();
    const thresholds = await this.thresholds(scope, tx);
    const passed = passedReminderKinds(candidate, now, thresholds);
    const snapshot = this.snapshot(candidate, now);
    const seeded: ServiceReminderKind[] = [];
    for (const kind of [...passed.expiry, ...passed.usage]) {
      const written = await this.deps.reminders.raise(
        scope,
        {
          id: this.deps.ids.uuid(),
          serviceId: candidate.serviceId,
          kind,
          basis: candidate.basis,
          snapshot,
        },
        now,
        tx,
      );
      if (written) seeded.push(kind);
    }
    /*
     * Round 4 PR-H: and the baseline those kinds were decided from, so the sweep can ask the
     * same question again under thresholds an operator changes after the import
     * (`importedReminderKinds`). Once per service: a rerun keeps the import's row.
     */
    await this.deps.reminders.recordBaseline(
      scope,
      {
        serviceId: candidate.serviceId,
        at: now,
        basis: candidate.basis,
        usedBytes: candidate.usageMeasured ? candidate.trafficUsedBytes : null,
      },
      tx,
    );
    return { passed: [...passed.expiry, ...passed.usage], seeded };
  }

  /**
   * The tenant's own thresholds, read fresh on every pass.
   *
   * Never cached across passes, and that is what `RUNTIME` mutability means: an
   * operator who changes three days to five must not have to wait for a deploy, and a
   * cache here would be a second copy of a value the registry already owns.
   *
   * The flags come from the SAME transaction as the settings and as the writes below,
   * for the reason every read in this codebase shares its transaction with the write it
   * informs: a flag turned off while a pass was mid-flight would otherwise send the
   * messages it was turned off to stop.
   */
  private async thresholds(
    scope: TenantContext,
    tx: TransactionScope,
  ): Promise<ServiceReminderThresholds> {
    // One after another, never `Promise.all`: every read shares ONE transaction's client,
    // and concurrent queries on one pg client are queued in an order nobody chose
    // (deprecated in pg 8, an error in pg 9). The flags first, then the settings.
    const { features, settings } = this.deps;
    const expiryEnabled = await features.isEnabled(scope, 'service_expiry_reminders', tx);
    const expiredNoticeEnabled = await features.isEnabled(scope, 'service_expired_notice', tx);
    const expiryDayEnabled = await features.isEnabled(scope, 'service_expiry_day_reminder', tx);
    const usageEnabled = await features.isEnabled(scope, 'service_usage_reminders', tx);
    const expiryEarlyDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_early_days',
      tx,
    );
    const expiryFirstDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_first_days',
      tx,
    );
    const expirySecondDays = await settings.valueOf<number>(
      scope,
      'reminders.expiry_second_days',
      tx,
    );
    const usageFirstPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_first_percent',
      tx,
    );
    const usageSecondPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_second_percent',
      tx,
    );
    const usageFinalPercent = await settings.valueOf<number>(
      scope,
      'reminders.usage_final_percent',
      tx,
    );
    return {
      expiryEnabled,
      expiredNoticeEnabled,
      expiryDayEnabled,
      usageEnabled,
      expiryEarlyDays,
      expiryFirstDays,
      expirySecondDays,
      usageFirstPercent,
      usageSecondPercent,
      usageFinalPercent,
    };
  }

  /**
   * The three that are about the clock.
   *
   * The boundaries handed to the repository are derived HERE from
   * `EXPIRY_REMINDER_DAYS`, so the numbers live in the contract and the query has only
   * timestamps. Each row that comes back is then re-decided by `expiryReminderDue`: the
   * query is a filter that makes the pass finite, and the function is the authority.
   * They agree today, and the day somebody changes one of them the disagreement is a
   * skipped reminder rather than a wrong one.
   */
  private async sweepExpiry(
    scope: TenantContext,
    now: Date,
    thresholds: ServiceReminderThresholds,
    optOutHonoured: boolean,
    tx: TransactionScope,
  ): Promise<number> {
    /* Every switch off: no query, no candidates, nothing to be made stale. */
    if (
      !thresholds.expiryEnabled &&
      !thresholds.expiredNoticeEnabled &&
      !thresholds.expiryDayEnabled
    ) {
      return 0;
    }
    /*
     * The window NARROWS when advance warnings are off.
     *
     * With `service_expiry_reminders` off and only the expired notice on, a service
     * three days out is not a candidate for anything, and asking for it would hand the
     * pass two hundred rows it must then skip — every fifteen minutes, in front of the
     * services that do need something. `now` is the whole window in that case.
     *
     * WP-A9: the window is the furthest ENABLED moment. With advance warnings on it is the
     * week-out slot when that one is live (non-zero and further out than FIRST), else
     * FIRST. With them off but "expires today" on, it is the second threshold — at least a
     * day, which contains every expiry whose calendar day has begun.
     */
    const earlyLive =
      thresholds.expiryEarlyDays > 0 && thresholds.expiryEarlyDays > thresholds.expiryFirstDays;
    const windowDays = thresholds.expiryEnabled
      ? earlyLive
        ? thresholds.expiryEarlyDays
        : thresholds.expiryFirstDays
      : thresholds.expiryDayEnabled
        ? thresholds.expirySecondDays
        : 0;
    const candidates = await this.deps.reminders.listExpiryCandidates(
      scope,
      {
        now,
        secondAt: new Date(now.getTime() + thresholds.expirySecondDays * DAY_MS),
        firstAt: new Date(now.getTime() + thresholds.expiryFirstDays * DAY_MS),
        windowAt: new Date(now.getTime() + windowDays * DAY_MS),
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      const due = expiryReminderDue(
        candidate.expiresAt,
        now,
        thresholds,
        candidate.expiryDayStartsAt,
      );
      if (due === null) continue;
      /*
       * Everything from the least urgent up to and including the due kind.
       *
       * `EXPIRY_REMINDER_KINDS` is declared least-urgent-first, so the slice up to the
       * due kind is exactly the set that is no longer in the future. Writing the whole
       * prefix is what stops a lane that was down for two days sending "three days
       * left" after "expires tomorrow".
       */
      const upTo = EXPIRY_REMINDER_KINDS.slice(0, EXPIRY_REMINDER_KINDS.indexOf(due) + 1);
      /*
       * A kind whose switch is off is RECORDED and not sent, rather than skipped.
       *
       * Skipping would leave the service a candidate for ever: it would come back on
       * every pass, occupy a slot in a bounded sweep, and starve the services behind it.
       * Recording also settles what happens on a later re-enable, and settles it the
       * way an operator would want: turning the expired notice back on does not
       * suddenly post "your service expired" to everyone whose service lapsed while it
       * was off.
       */
      const enabled =
        due === 'EXPIRED'
          ? thresholds.expiredNoticeEnabled
          : due === 'EXPIRY_DAY'
            ? thresholds.expiryDayEnabled
            : thresholds.expiryEnabled;
      /*
       * Round 4 PR-H: a kind that was already behind the service when an import created it
       * is history — recorded with the rest of the prefix, never announced. Every less urgent
       * kind was behind it too (the prefix is in time order), so nothing in `upTo` is sent.
       */
      const historical =
        candidate.importUnproven === true ||
        importedReminderKinds(candidate, thresholds).expiry.includes(due);
      /*
       * Round 11, B6: a customer who turned expiry reminders off (and the installation honours
       * it) is RECORDED and not told — the same treatment a switched-off kind gets, and for
       * the same reason: skipping would leave the service a candidate for ever, and recording
       * settles a later opt-in the way the customer would want (no burst of reminders for
       * thresholds that passed while they had asked for silence). The sweep is the one place
       * recipients are decided; the notification lane re-checks at send time for a message
       * already queued.
       */
      const optedOut = optOutHonoured && candidate.remindersOptedOut === true;
      const announce = enabled && !historical && !optedOut;
      if (await this.raise(scope, candidate, upTo, announce ? due : null, now, tx)) sent += 1;
    }
    return sent;
  }

  /** The three that are about the allowance. Same shape, same reasoning. */
  private async sweepUsage(
    scope: TenantContext,
    now: Date,
    thresholds: ServiceReminderThresholds,
    optOutHonoured: boolean,
    tx: TransactionScope,
  ): Promise<number> {
    /* Off means no query at all, for the reason the expiry half gives. */
    if (!thresholds.usageEnabled) return 0;
    const candidates = await this.deps.reminders.listUsageCandidates(
      scope,
      {
        lowest: thresholds.usageFirstPercent,
        high: thresholds.usageSecondPercent,
        full: thresholds.usageFinalPercent,
      },
      SERVICE_REMINDER_SWEEP_LIMIT,
      tx,
    );

    let sent = 0;
    for (const candidate of candidates) {
      /* Highest first, so `[0]` is the one the customer hears about. */
      const reached = usageRemindersReached(
        candidate.trafficUsedBytes,
        candidate.trafficLimitBytes,
        thresholds,
      );
      const due = reached[0];
      if (due === undefined) continue;
      /*
       * Round 4 PR-H: the figure the import read had already reached `due` (under today's
       * thresholds): the crossing happened under the previous bot, so it is recorded and not
       * announced. A kind first reached by a figure measured after the import is sent.
       */
      /*
       * Round 5A item 1: and an imported service whose baseline has NO figure for this period
       * has not had its first post-import usage read recorded as the baseline yet
       * (`DrizzleServiceRepository.recordUsage` writes it on the first sync). Whatever the
       * figure on the row says is then a state the import already held, or one this lane cannot
       * tell from it — a service synced before the baseline was written by the sync — so it
       * is recorded and not announced; the next sync sets the figure and every later crossing
       * is told as for a service Nexa sold.
       */
      const unmeasuredImport =
        candidate.importBaseline != null && candidate.importBaseline.usedBytes === null;
      const historical =
        candidate.importUnproven === true ||
        unmeasuredImport ||
        importedReminderKinds(candidate, thresholds).usage.includes(due);
      /* Round 11, B6: recorded and not told for an opted-out customer; see `sweepExpiry`. */
      const optedOut = optOutHonoured && candidate.remindersOptedOut === true;
      if (
        await this.raise(scope, candidate, reached, historical || optedOut ? null : due, now, tx)
      ) {
        sent += 1;
      }
    }
    return sent;
  }

  /**
   * Writes every kind in `kinds` and enqueues a notification for `announce` alone.
   *
   * Returns whether the customer was told. `false` covers both losers: another replica
   * wrote the `announce` row first, or the customer has no durable bot link and there
   * is nobody to send to — and neither is an error, so neither aborts the pass.
   *
   * The reminder row is written BEFORE the notification and the notification names its
   * id. That order is not cosmetic: the id must exist before it can be a subject, and
   * the pair must be in one transaction so that neither can exist alone.
   */
  private async raise(
    scope: TenantContext,
    candidate: ServiceReminderCandidate,
    kinds: readonly ServiceReminderKind[],
    /** The one kind to announce, or `null` when its switch is off and it is only recorded. */
    announce: ServiceReminderKind | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const snapshot = this.snapshot(candidate, now);
    let told = false;
    for (const kind of kinds) {
      const id = this.deps.ids.uuid();
      const written = await this.deps.reminders.raise(
        scope,
        {
          id,
          serviceId: candidate.serviceId,
          kind,
          basis: candidate.basis,
          snapshot,
        },
        now,
        tx,
      );
      if (!written || kind !== announce) continue;
      told = await this.deps.notifier.notify(
        scope,
        candidate.customerId,
        SERVICE_REMINDER_NOTIFICATION_KINDS[kind],
        id,
        now,
        tx,
      );
      if (told && this.deps.opsLog !== undefined) {
        const hook = this.deps.opsLog;
        try {
          await this.deps.uow.runNested(scope, tx, (nested) =>
            hook.serviceAlerted(
              scope,
              {
                reminderId: id,
                serviceId: candidate.serviceId,
                kind,
                remainingDays: snapshot.remainingDays,
              },
              nested,
            ),
          );
        } catch (error) {
          this.deps.opsLogFailed?.(error, candidate.serviceId);
        }
      }
    }
    return told;
  }

  /**
   * What the message will say, frozen now.
   *
   * `remainingDays` rounds UP, so a service with eleven hours left is "one day" rather
   * than "zero days" — a sentence that says zero days and is not the expired notice is
   * a sentence a customer cannot act on. Past the deadline it is zero, and the expired
   * template does not render it.
   *
   * `usedBytes` is the figure that was on the row, which the usage query only accepts
   * from a service whose panel has actually answered. Nothing here substitutes a zero
   * for a figure nobody has read.
   */
  private snapshot(candidate: ServiceReminderCandidate, now: Date): ServiceReminderSnapshot {
    const msLeft =
      candidate.expiresAt === null ? null : candidate.expiresAt.getTime() - now.getTime();
    return {
      serviceLabel: candidate.providerUsername,
      remainingDays: msLeft === null ? null : Math.max(0, Math.ceil(msLeft / DAY_MS)),
      usedBytes: candidate.trafficUsedBytes,
    };
  }
}
