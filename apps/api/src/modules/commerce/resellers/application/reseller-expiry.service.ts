import {
  systemJobActor,
  type AuditWriter,
  type Clock,
  type CorrelationId,
  type IdGenerator,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type { ResellerRepository } from './ports.js';

/** How many resellers one transaction suspends; a bigger backlog takes more passes. */
export const RESELLER_EXPIRY_BATCH = 100;
/** Batches one pass runs at most, so a pass stays bounded whatever the backlog. */
export const RESELLER_EXPIRY_BATCHES_PER_PASS = 10;

export interface ResellerExpiryServiceDeps {
  readonly resellers: Pick<ResellerRepository, 'suspendExpired' | 'findTier'>;
  readonly notifier: CustomerNotifier;
  readonly audit: AuditWriter;
  readonly outbox: OutboxWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Overridable in tests only. */
  readonly batch?: number;
}

/**
 * Round 11, C2: the reseller expiry sweep.
 *
 * A reseller whose `expires_at` has passed and who is still ACTIVE becomes SUSPENDED — an
 * ordinary customer (no discount, no reseller-only product), which is the pricing
 * boundary's existing reading of `SUSPENDED`. NOTHING ELSE MOVES: no ledger entry, no
 * refund, no tier change, no order touched.
 *
 * - Acts as `SYSTEM_JOB`; reads `ScopeActivityReader` INSIDE each transaction and does
 *   nothing for a tenant that has stopped accepting work.
 * - The suspension is ONE conditional statement (`ResellerRepository.suspendExpired`:
 *   `status = 'ACTIVE' AND expires_at <= now`), skipping rows an administrator's
 *   transaction holds: an extension that commits first wins, and a re-run — or a second
 *   replica — finds nothing left to suspend, so the audit row, the ops-log event and the
 *   notice are written once per suspension, by the writer that won, in that transaction.
 * - Rows with no expiry date are never read: empty means none, and that is the whole
 *   opt-in. There is no flag.
 */
export class ResellerExpiryService {
  constructor(private readonly deps: ResellerExpiryServiceDeps) {}

  /** Returns how many resellers this pass suspended. */
  async runOnce(scope: TenantContext): Promise<number> {
    const size = this.deps.batch ?? RESELLER_EXPIRY_BATCH;
    let total = 0;
    for (let pass = 0; pass < RESELLER_EXPIRY_BATCHES_PER_PASS; pass += 1) {
      const suspended = await this.suspendBatch(scope, size);
      total += suspended;
      if (suspended < size) break;
    }
    return total;
  }

  private async suspendBatch(scope: TenantContext, size: number): Promise<number> {
    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 0;
      const rows = await this.deps.resellers.suspendExpired(scope, now, size, tx);
      if (rows.length === 0) return 0;
      const actor = systemJobActor('reseller-expiry', this.deps.ids.uuid() as CorrelationId);
      for (const row of rows) {
        const tier = await this.deps.resellers.findTier(scope, row.tierId, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'reseller.expired',
            entityType: 'Customer',
            entityId: row.customerId,
            before: { status: 'ACTIVE', expiresAt: row.expiresAt.toISOString() },
            after: { status: 'SUSPENDED', suspendedByExpiry: true },
            reason: 'the reseller expiry date passed',
            result: 'SUCCESS',
          },
          tx,
        );
        // The operations log reads this event (`ops-log.customers`): a standing change with
        // no administrator behind it is the system's.
        await this.deps.outbox.write(tx, actor, {
          eventType: 'ResellerStandingChanged',
          aggregateType: 'Customer',
          aggregateId: row.customerId,
          payload: {
            customerId: row.customerId,
            change: 'SUSPENDED',
            fromStatus: 'ACTIVE',
            toStatus: 'SUSPENDED',
            fromTierName: tier?.name ?? null,
            toTierName: tier?.name ?? '',
          },
        });
        // A fresh subject per suspension: expire, extend, expire again is told twice.
        // `notify` answers false for a reseller with no bot link; the suspension stands.
        await this.deps.notifier.notify(
          scope,
          row.customerId as UserId,
          'RESELLER_EXPIRED',
          this.deps.ids.uuid(),
          now,
          tx,
        );
      }
      return rows.length;
    });
  }
}
