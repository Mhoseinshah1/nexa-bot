import {
  HOSTED_BOT_TENANT_STATUS,
  HOSTING_BOT_EXPIRED_CODE,
  systemContext,
  systemJobActor,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { HostedTenantSystemPath, HostingRepository } from './ports.js';

/** Hosted bots one transaction expires; a bigger backlog takes more batches. */
export const HOSTED_BOT_EXPIRY_BATCH = 50;
/** Batches one pass runs at most. */
export const HOSTED_BOT_EXPIRY_BATCHES_PER_PASS = 10;

export interface HostedBotExpiryDeps {
  readonly repository: Pick<HostingRepository, 'claimExpired' | 'transition'>;
  readonly system: Pick<HostedTenantSystemPath, 'setTenantStatus' | 'facts'>;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly batch?: number;
}

/**
 * Phase 6A PR-3 — the expiry sweep: an ACTIVE hosted bot whose expiry date has passed
 * becomes EXPIRED, and its tenant STOPPED, which is what stops it (every write path's
 * `ScopeActivityReader`, the webhook, Web Admin sign-in and sessions). The owner is told in
 * HIS operations group: `hosting.bot_expired` on the installation tenant, in the same
 * transaction, deduplicated per bot and expiry instant.
 *
 * Runs in the worker's installation-scoped sweep loop, as `SYSTEM_JOB`, every pass (an
 * expiry is a deadline). Idempotent by construction: rows are claimed FOR UPDATE SKIP
 * LOCKED and moved by ONE conditional UPDATE naming `ACTIVE` — an owner's suspend, delete
 * or new date that commits first wins, a second replica or a re-run finds nothing, and the
 * audit row, the event and the ops message are written once per expiry by the writer that
 * won. Reads `ScopeActivityReader` inside each transaction: a stopped installation expires
 * nothing. No customer of the hosted bot is told anything.
 */
export class HostedBotExpiryService {
  constructor(private readonly deps: HostedBotExpiryDeps) {}

  /** How many hosted bots this pass expired. */
  async runOnce(installation: TenantContext): Promise<number> {
    const size = this.deps.batch ?? HOSTED_BOT_EXPIRY_BATCH;
    let total = 0;
    for (let pass = 0; pass < HOSTED_BOT_EXPIRY_BATCHES_PER_PASS; pass += 1) {
      const expired = await this.batch(installation, size);
      total += expired;
      if (expired < size) break;
    }
    return total;
  }

  private async batch(installation: TenantContext, size: number): Promise<number> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(installation, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(installation, tx))) return 0;
      const due = await this.deps.repository.claimExpired(installation, now, size, tx);
      if (due.length === 0) return 0;
      const actor = systemJobActor('hosted-bot-expiry', this.deps.ids.uuid() as CorrelationId);
      const context = systemContext('hosting.expiry_sweep');
      const facts = await this.deps.system.facts(
        context,
        due.map((row) => ({ tenantId: row.hostedTenantId, ownerAdminId: row.ownerAdminId })),
      );
      let expired = 0;
      for (const row of due) {
        const moved = await this.deps.repository.transition(
          installation,
          row.hostedTenantId,
          ['ACTIVE'],
          'EXPIRED',
          now,
          tx,
        );
        if (moved === null) continue;
        const from = HOSTED_BOT_TENANT_STATUS.ACTIVE;
        const to = HOSTED_BOT_TENANT_STATUS.EXPIRED;
        await this.deps.system.setTenantStatus(context, row.hostedTenantId, from, to, now, tx);
        const expiresAt = row.expiresAt?.toISOString() ?? null;
        await this.deps.audit.record(
          installation,
          actor,
          {
            action: 'hosting.expire',
            entityType: 'Tenant',
            entityId: row.hostedTenantId,
            before: { state: 'ACTIVE', tenantStatus: from, expiresAt },
            after: { state: 'EXPIRED', tenantStatus: to },
            reason: 'the hosted bot’s expiry date passed',
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'HostedBotStateChanged',
          aggregateType: 'Tenant',
          aggregateId: row.hostedTenantId,
          payload: {
            hostedTenantId: row.hostedTenantId,
            action: 'EXPIRE',
            from: 'ACTIVE',
            to: 'EXPIRED',
            tenantStatusFrom: from,
            tenantStatusTo: to,
          },
        });
        const name = facts.get(row.hostedTenantId)?.displayName ?? row.hostedTenantId;
        await this.deps.opsLog.record(
          installation,
          {
            code: HOSTING_BOT_EXPIRED_CODE,
            severity: 'WARN',
            message: `تاریخ انقضای ربات میزبانی‌شدهٔ «${name}» گذشت و ربات متوقف شد. برای ادامه، در «میزبانی‌ها» تاریخ تازه بگذارید و فعالش کنید.`,
            dedupeKey: `${HOSTING_BOT_EXPIRED_CODE}:${row.hostedTenantId}:${expiresAt ?? 'none'}`,
            context: { hostedTenantId: row.hostedTenantId, expiresAt },
            correlationId: actor.correlationId,
          },
          tx,
        );
        expired += 1;
      }
      return expired;
    });
  }
}
