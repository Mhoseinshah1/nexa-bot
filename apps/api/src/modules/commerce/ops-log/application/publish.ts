import type { DomainEvent, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { Built } from './presenters.js';
import type { OpsLogLane } from './ports.js';

/** An administrator acting through the Web Admin or the Telegram admin menu. */
export function isAdminActor(type: string): boolean {
  return type === 'WEB_ADMIN' || type === 'TELEGRAM_ADMIN';
}

/** The tenant a domain event belongs to, or null for a platform-level event (nothing to log). */
export function scopeOf(event: DomainEvent): TenantContext | null {
  if (event.tenantId === null) return null;
  return { tenantId: event.tenantId as never, botInstanceId: null };
}

/**
 * Queues one built message for the operations log group.
 *
 * The dedupe key is the EVENT's, plus a suffix when one event stands for several messages, so
 * a replay of the event past a lost relay claim writes nothing new. Whether the type is
 * switched on, which topic it goes to and whether the lane is enabled at all are the lane's
 * to decide (`NotificationService.queue`), not this function's.
 */
export async function publish(
  lane: OpsLogLane,
  scope: TenantContext,
  tx: TransactionScope,
  built: Built,
  options: {
    readonly dedupeKey: string;
    readonly correlationId?: string;
    readonly storm?: Parameters<OpsLogLane['queue']>[1]['storm'];
  },
): Promise<void> {
  await lane.queue(
    scope,
    {
      kind: 'OPERATIONAL_EVENT',
      dedupeKey: options.dedupeKey,
      templateKey: built.templateKey,
      values: built.values,
      logType: built.logType,
      ...(built.buttons.length === 0 ? {} : { buttons: built.buttons }),
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...(options.storm === undefined ? {} : { storm: options.storm }),
    },
    tx,
  );
}
