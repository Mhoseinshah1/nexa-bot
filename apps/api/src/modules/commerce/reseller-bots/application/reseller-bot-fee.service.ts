import {
  errors,
  HOSTED_BOT_TENANT_STATUS,
  RESELLER_BOT_ERROR_CODES,
  RESELLER_BOT_GRACE_DAYS_SETTING_KEY,
  RESELLER_BOT_OPS_CODES,
  systemContext,
  systemJobActor,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type {
  HostedBotRow,
  HostedTenantSystemPath,
  HostingRepository,
} from '../../../platform/hosting/application/ports.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import { noticeDay, renewalDue, shortWalletAction } from '../domain/fee-period.js';
import { chargePeriod } from './fee-charge.js';
import type { ResellerBotRepository, ResellerBotRequestRecord } from './ports.js';

/**
 * Subscriptions read per page. A pass pages through the WHOLE due set (keyset on
 * `(paidThrough, id)`): a subscription it leaves as it was — short and waiting, or a bot it may
 * not touch — must not hold the page newer due ones are on.
 */
export const RESELLER_BOT_RENEWAL_BATCH = 100;

/** The audit actions a stop and a resume are recorded under (the timeline reads them). */
export const RESELLER_BOT_STOP_AUDIT_ACTION = 'hosting.reseller_bot.stop';
export const RESELLER_BOT_RESUME_AUDIT_ACTION = 'hosting.reseller_bot.resume';
export const RESELLER_BOT_CHARGE_AUDIT_ACTION = 'hosting.reseller_bot.charge';

export interface ResellerBotFeeDeps {
  readonly repository: ResellerBotRepository;
  readonly hosting: Pick<HostingRepository, 'findHosted' | 'transition' | 'replaceInProgress'>;
  readonly system: Pick<HostedTenantSystemPath, 'setTenantStatus'>;
  readonly wallet: Pick<WalletRepository, 'lockCustomer' | 'balanceOf' | 'append'>;
  readonly notifier: Pick<CustomerNotifier, 'notify'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly outbox: OutboxWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly batch?: number;
}

/** What one subscription's turn did. */
export type RenewalOutcome =
  'NOT_DUE' | 'SKIPPED' | 'CHARGED' | 'CHARGED_RESUMED' | 'NOTICED' | 'STOPPED' | 'WAITING';

export interface RenewalReport {
  readonly charged: number;
  readonly noticed: number;
  readonly stopped: number;
  readonly resumed: number;
}

/**
 * Reseller-phase PR-6 — the dedicated bot's monthly fee after the first month.
 *
 * Runs in the worker's installation-scoped sweep loop as `SYSTEM_JOB`. Each due subscription is
 * its own transaction: the request row locked, the installation's `ScopeActivityReader` read
 * inside it, then one decision —
 *
 *   - the wallet covers the fee: ONE debit for the period (`chargePeriod`; the derived reference
 *     and the `(request, period)` key make a second run, a second replica or the reseller's own
 *     pay a re-read, never a second debit), and a bot the job had stopped is resumed through
 *     the same lifecycle step the expiry sweep's stop is undone by (EXPIRED → ACTIVE, the hosted
 *     tenant back to ACTIVE);
 *   - short, inside the grace days: one `HOSTED_BOT_FEE_SHORT` notice per UTC day
 *     (`reseller_bot_fee_notices`' key);
 *   - short, the grace days over: the hosted bot is STOPPED through the expiry sweep's own stop
 *     (ACTIVE → EXPIRED, the tenant STOPPED — data kept, never deleted), marked `fee_stopped_at`.
 *
 * A bot the OWNER suspended or deleted, or the expiry sweep stopped, is neither charged nor
 * touched: the job only bills a running bot or one it stopped itself. Every debit, stop and
 * resume is an audit row and an operations message on the installation tenant.
 */
export class ResellerBotFeeService {
  constructor(private readonly deps: ResellerBotFeeDeps) {}

  async runOnce(installation: TenantContext): Promise<RenewalReport> {
    const now = this.deps.clock.now();
    const batch = this.deps.batch ?? RESELLER_BOT_RENEWAL_BATCH;
    const report = { charged: 0, noticed: 0, stopped: 0, resumed: 0 };
    let page = await this.deps.repository.dueAfter(installation, now, batch, null);
    if (page.length === 0) return report;
    const graceDays = await this.graceDays(installation);
    const actor = systemJobActor('reseller-bot-renewal', this.deps.ids.uuid() as CorrelationId);
    // Each id once per pass, whatever a page boundary does.
    const seen = new Set<string>();
    while (page.length > 0) {
      const fresh = page.filter((due) => !seen.has(due.id));
      if (fresh.length === 0) break;
      for (const due of fresh) {
        seen.add(due.id);
        await this.renewOne(installation, actor, due.id, graceDays, report);
      }
      if (page.length < batch) break;
      const last = page[page.length - 1];
      if (last === undefined) break;
      page = await this.deps.repository.dueAfter(installation, now, batch, last);
    }
    return report;
  }

  private async renewOne(
    installation: TenantContext,
    actor: ActorContext,
    id: string,
    graceDays: number,
    report: { -readonly [K in keyof RenewalReport]: number },
  ): Promise<void> {
    const outcome = await this.deps.uow.run(installation, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) return 'SKIPPED';
      const request = await this.deps.repository.find(installation, id, tx, true);
      if (request === null) return 'SKIPPED';
      return this.renew(installation, actor, request, graceDays, this.deps.clock.now(), tx, {
        kind: 'JOB',
      });
    });
    if (outcome === 'CHARGED' || outcome === 'CHARGED_RESUMED') report.charged += 1;
    if (outcome === 'CHARGED_RESUMED') report.resumed += 1;
    if (outcome === 'NOTICED') report.noticed += 1;
    if (outcome === 'STOPPED') report.stopped += 1;
  }

  /**
   * «پرداخت و فعال‌سازی دوباره»: the reseller pays the due period now and, when the job had
   * stopped the bot, it runs again at once. Inside the caller's transaction, which holds the
   * request row's lock. Refuses NOTHING_DUE when the current period is paid and
   * INSUFFICIENT_FUNDS when the wallet is short — nothing is charged either way.
   */
  async payNow(
    installation: TenantContext,
    actor: ActorContext,
    request: ResellerBotRequestRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<RenewalOutcome> {
    const graceDays = await this.graceDays(installation, tx);
    return this.renew(installation, actor, request, graceDays, now, tx, { kind: 'RESELLER' });
  }

  async graceDays(installation: TenantContext, tx?: unknown): Promise<number> {
    return this.deps.settings.valueOf<number>(
      installation,
      RESELLER_BOT_GRACE_DAYS_SETTING_KEY,
      tx,
    );
  }

  private async renew(
    installation: TenantContext,
    actor: ActorContext,
    request: ResellerBotRequestRecord,
    graceDays: number,
    now: Date,
    tx: TransactionScope,
    caller: { readonly kind: 'JOB' | 'RESELLER' },
  ): Promise<RenewalOutcome> {
    if (
      request.status !== 'APPROVED' ||
      request.hostedTenantId === null ||
      request.paidThrough === null
    ) {
      if (caller.kind === 'RESELLER' && request.status === 'APPROVED') {
        throw errors.conflict(RESELLER_BOT_ERROR_CODES.NOT_LINKED, 'No hosted bot yet.');
      }
      if (caller.kind === 'RESELLER') {
        throw errors.conflict(
          RESELLER_BOT_ERROR_CODES.STATE_CONFLICT,
          'This request has no running subscription.',
        );
      }
      return 'SKIPPED';
    }
    const hosted = await this.deps.hosting.findHosted(
      installation,
      request.hostedTenantId,
      tx,
      true,
    );
    if (hosted === null || !this.billable(request, hosted, now)) {
      if (caller.kind === 'RESELLER') {
        throw errors.conflict(
          RESELLER_BOT_ERROR_CODES.STATE_CONFLICT,
          'The dedicated bot is stopped by the owner; it is not billed.',
        );
      }
      return 'SKIPPED';
    }
    const due = renewalDue(
      {
        paidThrough: request.paidThrough,
        lastPeriod: request.lastPeriod,
        feeStoppedAt: request.feeStoppedAt,
      },
      now,
      graceDays,
    );
    if (due.kind === 'NOT_DUE') {
      if (caller.kind === 'RESELLER') {
        throw errors.conflict(RESELLER_BOT_ERROR_CODES.NOTHING_DUE, 'The current period is paid.');
      }
      return 'NOT_DUE';
    }
    const stopped = request.feeStoppedAt !== null;
    const charged = await chargePeriod(
      {
        wallet: this.deps.wallet,
        repository: this.deps.repository,
        outbox: this.deps.outbox,
        ids: this.deps.ids,
      },
      installation,
      actor,
      {
        request,
        period: due.period,
        start: due.start,
        end: due.end,
        kind: caller.kind === 'RESELLER' && stopped ? 'REACTIVATION' : 'RENEWAL',
        now,
      },
      tx,
    );
    if (charged.kind === 'NO_CUSTOMER') return 'SKIPPED';
    if (charged.kind === 'SHORT') {
      if (caller.kind === 'RESELLER') {
        throw errors.conflict(
          RESELLER_BOT_ERROR_CODES.INSUFFICIENT_FUNDS,
          'The wallet does not hold the monthly fee.',
          {
            shortfallMinor: charged.shortfallMinor.toString(),
            currency: request.feeCurrency,
          },
        );
      }
      return this.short(installation, actor, request, hosted, due, now, tx);
    }
    await this.deps.repository.advance(
      installation,
      request.id,
      { fromPeriod: request.lastPeriod, period: due.period, paidThrough: due.end, now },
      tx,
    );
    await this.deps.audit.record(
      installation,
      actor,
      {
        action: RESELLER_BOT_CHARGE_AUDIT_ACTION,
        entityType: 'ResellerBotRequest',
        entityId: request.id,
        before: { lastPeriod: request.lastPeriod, paidThrough: request.paidThrough.toISOString() },
        after: {
          period: due.period,
          paidThrough: due.end.toISOString(),
          amountMinor: request.feeAmountMinor.toString(),
          currency: request.feeCurrency,
          reference: charged.reference,
          walletEntryId: charged.entryId,
          by: caller.kind,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    await this.deps.opsLog.record(
      installation,
      {
        code: RESELLER_BOT_OPS_CODES.FEE_CHARGED,
        severity: 'INFO',
        message: `هزینهٔ ماهانهٔ ربات اختصاصی @${request.botUsername} (دورهٔ ${String(due.period)}) از کیف پول نماینده کسر شد: ${request.feeAmountMinor.toString()} ${request.feeCurrency}.`,
        dedupeKey: `${RESELLER_BOT_OPS_CODES.FEE_CHARGED}:${request.id}:${String(due.period)}`,
        context: {
          requestId: request.id,
          hostedTenantId: request.hostedTenantId,
          period: due.period,
          amountMinor: request.feeAmountMinor.toString(),
          currency: request.feeCurrency,
        },
        correlationId: actor.correlationId,
      },
      tx,
    );
    if (stopped) {
      await this.resume(installation, actor, request, hosted, now, tx);
      return 'CHARGED_RESUMED';
    }
    return 'CHARGED';
  }

  /**
   * Whether the job may bill this bot: running, or stopped by the job itself (EXPIRED with
   * `fee_stopped_at`) and resumable (no expiry date that has passed). A bot the owner
   * suspended or deleted, or the expiry sweep stopped, is not billed.
   */
  private billable(request: ResellerBotRequestRecord, hosted: HostedBotRow, now: Date): boolean {
    if (hosted.state === 'ACTIVE') return true;
    if (hosted.state !== 'EXPIRED' || request.feeStoppedAt === null) return false;
    return hosted.expiresAt === null || hosted.expiresAt.getTime() > now.getTime();
  }

  private async short(
    installation: TenantContext,
    actor: ActorContext,
    request: ResellerBotRequestRecord,
    hosted: HostedBotRow,
    due: { readonly period: number; readonly graceEndsAt: Date },
    now: Date,
    tx: TransactionScope,
  ): Promise<RenewalOutcome> {
    const action = shortWalletAction(now, due.graceEndsAt, request.feeStoppedAt !== null);
    if (action === 'WAIT') return 'WAITING';
    if (action === 'NOTICE') {
      const notice = await this.deps.repository.insertNotice(
        installation,
        {
          id: this.deps.ids.uuid(),
          requestId: request.id,
          period: due.period,
          noticeDay: noticeDay(now),
          deadline: due.graceEndsAt,
          now,
        },
        tx,
      );
      if (notice === null) return 'WAITING';
      await this.deps.notifier.notify(
        installation,
        request.customerId as UserId,
        'HOSTED_BOT_FEE_SHORT',
        notice.id,
        now,
        tx,
      );
      await this.deps.opsLog.record(
        installation,
        {
          code: RESELLER_BOT_OPS_CODES.FEE_SHORT,
          severity: 'WARN',
          message: `موجودی نماینده برای هزینهٔ ماهانهٔ ربات اختصاصی @${request.botUsername} کافی نیست؛ اگر تا پایان مهلت پرداخت نشود، ربات متوقف می‌شود.`,
          // One message per unpaid period, however many daily notices the reseller gets.
          dedupeKey: `${RESELLER_BOT_OPS_CODES.FEE_SHORT}:${request.id}:${String(due.period)}`,
          context: {
            requestId: request.id,
            hostedTenantId: request.hostedTenantId,
            period: due.period,
            deadline: due.graceEndsAt.toISOString(),
          },
          correlationId: actor.correlationId,
        },
        tx,
      );
      return 'NOTICED';
    }
    // STOP: the grace days ended unpaid.
    if (hosted.state !== 'ACTIVE') return 'WAITING';
    if (await this.deps.hosting.replaceInProgress(installation, hosted.hostedTenantId, tx)) {
      return 'WAITING';
    }
    const moved = await this.deps.hosting.transition(
      installation,
      hosted.hostedTenantId,
      ['ACTIVE'],
      'EXPIRED',
      now,
      tx,
    );
    if (moved === null) return 'WAITING';
    const from = HOSTED_BOT_TENANT_STATUS.ACTIVE;
    const to = HOSTED_BOT_TENANT_STATUS.EXPIRED;
    await this.deps.system.setTenantStatus(
      systemContext('hosting.reseller_bot_fee'),
      hosted.hostedTenantId,
      from,
      to,
      now,
      tx,
    );
    await this.deps.repository.setFeeStopped(installation, request.id, now, now, tx);
    await this.stateAudit(installation, actor, request, 'STOP', now, tx);
    await this.deps.outbox.write(tx, actor, {
      eventType: 'HostedBotStateChanged',
      aggregateType: 'Tenant',
      aggregateId: hosted.hostedTenantId,
      payload: {
        hostedTenantId: hosted.hostedTenantId,
        action: 'EXPIRE',
        from: 'ACTIVE',
        to: 'EXPIRED',
        tenantStatusFrom: from,
        tenantStatusTo: to,
      },
    });
    await this.deps.opsLog.record(
      installation,
      {
        code: RESELLER_BOT_OPS_CODES.STOPPED,
        severity: 'WARN',
        message: `هزینهٔ ماهانهٔ ربات اختصاصی @${request.botUsername} تا پایان مهلت پرداخت نشد و ربات متوقف شد. داده‌ها حفظ شده است و با پرداخت دوباره فعال می‌شود.`,
        dedupeKey: `${RESELLER_BOT_OPS_CODES.STOPPED}:${request.id}:${String(due.period)}`,
        context: {
          requestId: request.id,
          hostedTenantId: hosted.hostedTenantId,
          period: due.period,
        },
        correlationId: actor.correlationId,
      },
      tx,
    );
    return 'STOPPED';
  }

  private async resume(
    installation: TenantContext,
    actor: ActorContext,
    request: ResellerBotRequestRecord,
    hosted: HostedBotRow,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.repository.setFeeStopped(installation, request.id, null, now, tx);
    if (hosted.state !== 'EXPIRED') return;
    const moved = await this.deps.hosting.transition(
      installation,
      hosted.hostedTenantId,
      ['EXPIRED'],
      'ACTIVE',
      now,
      tx,
    );
    if (moved === null) return;
    const from = HOSTED_BOT_TENANT_STATUS.EXPIRED;
    const to = HOSTED_BOT_TENANT_STATUS.ACTIVE;
    await this.deps.system.setTenantStatus(
      systemContext('hosting.reseller_bot_fee'),
      hosted.hostedTenantId,
      from,
      to,
      now,
      tx,
    );
    await this.stateAudit(installation, actor, request, 'RESUME', now, tx);
    await this.deps.outbox.write(tx, actor, {
      eventType: 'HostedBotStateChanged',
      aggregateType: 'Tenant',
      aggregateId: hosted.hostedTenantId,
      payload: {
        hostedTenantId: hosted.hostedTenantId,
        action: 'ACTIVATE',
        from: 'EXPIRED',
        to: 'ACTIVE',
        tenantStatusFrom: from,
        tenantStatusTo: to,
      },
    });
    await this.deps.opsLog.record(
      installation,
      {
        code: RESELLER_BOT_OPS_CODES.RESUMED,
        severity: 'INFO',
        message: `هزینهٔ ربات اختصاصی @${request.botUsername} پرداخت شد و ربات دوباره فعال شد.`,
        dedupeKey: `${RESELLER_BOT_OPS_CODES.RESUMED}:${request.id}:${now.toISOString()}`,
        context: { requestId: request.id, hostedTenantId: hosted.hostedTenantId },
        correlationId: actor.correlationId,
      },
      tx,
    );
  }

  private stateAudit(
    installation: TenantContext,
    actor: ActorContext,
    request: ResellerBotRequestRecord,
    action: 'STOP' | 'RESUME',
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    return this.deps.audit.record(
      installation,
      actor,
      {
        action:
          action === 'STOP' ? RESELLER_BOT_STOP_AUDIT_ACTION : RESELLER_BOT_RESUME_AUDIT_ACTION,
        entityType: 'ResellerBotRequest',
        entityId: request.id,
        before: { hostedState: action === 'STOP' ? 'ACTIVE' : 'EXPIRED' },
        after: {
          hostedState: action === 'STOP' ? 'EXPIRED' : 'ACTIVE',
          hostedTenantId: request.hostedTenantId,
          at: now.toISOString(),
        },
        reason:
          action === 'STOP'
            ? 'the dedicated bot’s monthly fee stayed unpaid after the grace days'
            : 'the dedicated bot’s monthly fee was paid',
        result: 'SUCCESS',
      },
      tx,
    );
  }
}
