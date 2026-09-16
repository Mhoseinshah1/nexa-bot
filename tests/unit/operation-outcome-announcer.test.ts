import { describe, expect, it } from 'vitest';
import type {
  OperationState,
  OperationType,
  TenantContext,
  UnitOfWork,
  UserId,
} from '@nexa/contracts';
import {
  CUSTOMER_INITIATED_OPERATIONS,
  OperationOutcomeAnnouncer,
} from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';
import type { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';

/**
 * The three decisions the announcer makes, each of which is a way to tell a customer
 * something false.
 *
 * The lane underneath is exercised against a real database in
 * `tests/integration/customer-notifications.test.ts`. What is asserted here is which
 * outcomes reach it at all, which is pure policy and needs no rows.
 */
describe('announcing how an operation turned out', () => {
  const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
  const CUSTOMER = 'customer-1' as UserId;
  const NOW = new Date('2026-09-16T00:00:00.000Z');

  /*
   * The announcer only ever calls `run`. A full stub would have to implement
   * `runSnapshot` and `runNested` too, and a test that implemented them would be
   * claiming the announcer might use them.
   */
  const passthroughUow = {
    run: async <T>(_scope: TenantContext, fn: (tx: TransactionScope) => Promise<T>): Promise<T> =>
      fn({ tx: {}, scope } as unknown as TransactionScope),
  } as unknown as UnitOfWork<TransactionScope>;

  interface Queued {
    readonly customerId: UserId;
    readonly kind: string;
    readonly subjectId: string;
  }

  function announcerFor(type: OperationType) {
    const queued: Queued[] = [];
    const announcer = new OperationOutcomeAnnouncer({
      reader: {
        subjectFor: async () => ({ type, customerId: CUSTOMER }),
      },
      notifier: {
        notify: async (
          _scope: TenantContext,
          customerId: UserId,
          kind: string,
          subjectId: string,
        ) => {
          queued.push({ customerId, kind, subjectId });
          return true;
        },
      } as unknown as CustomerNotifier,
      uow: passthroughUow,
      clock: { now: () => NOW },
    });
    return { announcer, queued };
  }

  /*
   * A `FAILED` operation with attempts left goes back to PLANNED and is tried again.
   * Telling a customer their renewal failed while the provisioner is still retrying it
   * is a false statement that the retry then contradicts — so only the two terminal
   * outcomes are announced. `UNKNOWN` says nothing for the older reason: the request may
   * have taken effect, and this repository never claims to know what it does not.
   */
  /*
   * Only the two TERMINAL outcomes are announced.
   *
   * A `FAILED` with attempts left goes back to PLANNED and is tried again, so "your
   * renewal failed" would be a statement the next attempt contradicts. `UNKNOWN` says
   * nothing for the older reason: the request may have taken effect, and this
   * repository never claims to know what it does not.
   *
   * Written as two named cases rather than a loop with a computed title, because
   * `scripts/check-falsification-citations.mjs` reads test names statically: a rule
   * cited against a title it cannot find is a citation nobody can check.
   */
  it('announces a SUCCEEDED and an ABANDONED operation', async () => {
    const announced: [OperationState, string][] = [
      ['SUCCEEDED', 'SERVICE_ACTION_SUCCEEDED'],
      ['ABANDONED', 'SERVICE_ACTION_FAILED'],
    ];
    for (const [outcome, kind] of announced) {
      const { announcer, queued } = announcerFor('RENEW');
      await announcer.announce(scope, 'operation-1', 'service-1', outcome);
      expect(
        queued.map((q) => q.kind),
        `${outcome} must be announced`,
      ).toEqual([kind]);
    }
  });

  it('says nothing about a FAILED operation', async () => {
    const silent: OperationState[] = ['FAILED', 'UNKNOWN', 'IN_FLIGHT', 'PLANNED'];
    for (const outcome of silent) {
      const { announcer, queued } = announcerFor('RENEW');
      await announcer.announce(scope, 'operation-1', 'service-1', outcome);
      expect(queued, `${outcome} must say nothing`).toEqual([]);
    }
  });

  it('says nothing about an operation no customer asked for', async () => {
    /*
     * `PROVISION` already produces the subscription link through `DeliveryService`,
     * which is a better message than "your request was applied"; `RECONCILE` and
     * `SYNC_USAGE` are this installation asking a panel a question. A customer told
     * about either would be told about something they never did.
     */
    for (const type of ['PROVISION', 'RECONCILE', 'SYNC_USAGE'] as OperationType[]) {
      const { announcer, queued } = announcerFor(type);
      await announcer.announce(scope, 'operation-1', 'service-1', 'SUCCEEDED');
      expect(queued, `${type} must not be announced`).toEqual([]);
    }
  });

  it('announces every operation a customer can start from My Services', async () => {
    for (const type of CUSTOMER_INITIATED_OPERATIONS) {
      const { announcer, queued } = announcerFor(type);
      await announcer.announce(scope, 'operation-1', 'service-1', 'SUCCEEDED');
      expect(queued.length, `${type} must be announced`).toBe(1);
    }
  });

  it('keys the notification on the operation, not the service', async () => {
    /*
     * `customer_notifications_subject_key` is (tenant, kind, subject). Keying on the
     * service would tell a customer about their FIRST renewal and silently drop every
     * one after it, because the second enqueue would hit the unique index and no-op.
     */
    const { announcer, queued } = announcerFor('RENEW');
    await announcer.announce(scope, 'operation-1', 'service-1', 'SUCCEEDED');
    await announcer.announce(scope, 'operation-2', 'service-1', 'SUCCEEDED');
    expect(queued.map((q) => q.subjectId)).toEqual(['operation-1', 'operation-2']);
  });

  it('says nothing when the operation or the service is gone', async () => {
    const queued: Queued[] = [];
    const announcer = new OperationOutcomeAnnouncer({
      reader: { subjectFor: async () => null },
      notifier: {
        notify: async () => {
          queued.push({ customerId: CUSTOMER, kind: 'x', subjectId: 'x' });
          return true;
        },
      } as unknown as CustomerNotifier,
      uow: passthroughUow,
      clock: { now: () => NOW },
    });
    await announcer.announce(scope, 'operation-1', 'service-1', 'SUCCEEDED');
    expect(queued).toEqual([]);
  });
});
