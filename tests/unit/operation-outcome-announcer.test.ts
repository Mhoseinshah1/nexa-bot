import { describe, expect, it } from 'vitest';
import type {
  OperationState,
  OperationType,
  TenantContext,
  UnitOfWork,
  UserId,
} from '@nexa/contracts';
import {
  ANNOUNCE_GRACE_MS,
  CUSTOMER_REQUESTABLE_OPERATIONS,
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
  const SERVICE = 'service-1';
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

  /*
   * The STATE comes from the reader now, not from the caller.
   *
   * `announce` used to take the outcome as a parameter and the loop supplied
   * `result.outcome`, which only an `ATTEMPTED` result has — so the refusal paths that
   * terminalise an operation announced nothing. The harness follows: each case says
   * what the ROW says, which is what the production reader answers from.
   */
  function announcerFor(
    type: OperationType,
    state: OperationState = 'SUCCEEDED',
    /*
     * Who asked, as the ROW records it — `null` meaning an operator or a background
     * lane did. Defaulted to the customer so the cases that are about STATE and TYPE
     * read as they did before this parameter existed; the cases about who asked pass
     * it explicitly.
     */
    requestedByCustomerId: UserId | null = CUSTOMER,
  ) {
    const queued: Queued[] = [];
    /*
     * Every `markAnnounced` call, in order.
     *
     * Recorded rather than counted, because the rule 4J-1 turns on is WHICH exits
     * stamp: four of the five, and the non-terminal one deliberately not. A count
     * alone would pass with the stamp on the wrong branch.
     */
    const stamped: string[] = [];
    const announcer = new OperationOutcomeAnnouncer({
      reader: {
        subjectFor: async () => ({
          type,
          state,
          serviceId: SERVICE,
          customerId: CUSTOMER,
          requestedByCustomerId,
        }),
        dueForAnnouncement: async () => [],
      },
      announcements: {
        markAnnounced: async (_scope, operationId) => void stamped.push(operationId),
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
    return { announcer, queued, stamped };
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
      const { announcer, queued } = announcerFor('RENEW', outcome);
      await announcer.announce(scope, 'operation-1');
      expect(
        queued.map((q) => q.kind),
        `${outcome} must be announced`,
      ).toEqual([kind]);
    }
  });

  it('says nothing about a FAILED operation', async () => {
    const silent: OperationState[] = ['FAILED', 'UNKNOWN', 'IN_FLIGHT', 'PLANNED'];
    for (const outcome of silent) {
      const { announcer, queued } = announcerFor('RENEW', outcome);
      await announcer.announce(scope, 'operation-1');
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
      const { announcer, queued } = announcerFor(type, 'SUCCEEDED');
      await announcer.announce(scope, 'operation-1');
      expect(queued, `${type} must not be announced`).toEqual([]);
    }
  });

  it('announces every operation a customer can start from My Services', async () => {
    for (const type of CUSTOMER_REQUESTABLE_OPERATIONS) {
      const { announcer, queued } = announcerFor(type, 'SUCCEEDED');
      await announcer.announce(scope, 'operation-1');
      expect(queued.length, `${type} must be announced`).toBe(1);
    }
  });

  it('says nothing about an operation an OPERATOR asked for, of any requestable type', async () => {
    /*
     * Phase 6A-5, and the defect Phase 6A-1 introduced.
     *
     * Before the operator action path these six types were reachable only from the
     * customer's own detail screen, so the TYPE was a sound proxy for who asked. It
     * stopped being one the moment an operator could plan a `SUSPEND`: the row is
     * identical, and this branch queued `SERVICE_ACTION_SUCCEEDED`, which renders as
     * «درخواست شما با موفقیت روی سرور اعمال شد» — YOUR request — to a customer who
     * made none. The failing direction is worse: `SERVICE_ACTION_FAILED` invites them
     * to try again, and an operator's terminate is not theirs to retry.
     *
     * Silence is the answer rather than a new sentence, because the lane is a closed
     * set of frozen kinds and none of them means "an operator changed your service";
     * ADR-0030 §1 refuses the parameterised payload one would need. Every other
     * operator action in this product — a block, a wallet adjustment, a refund — is
     * silent to the customer for the same reason.
     *
     * BOTH terminal outcomes, because a fix that quieted only the success would leave
     * the more misleading half in place.
     */
    for (const type of CUSTOMER_REQUESTABLE_OPERATIONS) {
      for (const outcome of ['SUCCEEDED', 'ABANDONED'] as OperationState[]) {
        const { announcer, queued, stamped } = announcerFor(type, outcome, null);
        await announcer.announce(scope, 'operation-1');
        expect(queued, `${type}/${outcome} asked for by an operator`).toEqual([]);
        /*
         * And it is ANSWERED. Nobody is owed a message, which is a decision — leaving
         * `announced_at` NULL would make the sweep re-read this row for ever.
         */
        expect(stamped, `${type}/${outcome} must still be stamped`).toEqual(['operation-1']);
      }
    }
  });

  it('still announces a PROVISION delay that no customer requested', async () => {
    /*
     * The narrowing above is scoped to the request branch, and this is the case that
     * proves it did not spread. `SERVICE_PROVISION_DELAYED` is deliberately about
     * something the customer did NOT ask for — they are waiting on a link they have
     * paid for — and `planReconciles` plans its `RECONCILE` with no requester at all.
     * A null check placed above that branch instead of inside the request one would
     * silence exactly the message 4H added.
     */
    const { announcer, queued } = announcerFor('RECONCILE', 'ABANDONED', null);
    await announcer.announce(scope, 'operation-1');
    expect(queued.map((q) => q.kind)).toEqual(['SERVICE_PROVISION_DELAYED']);
  });

  it('announces a delay when a PROVISION is abandoned', async () => {
    /*
     * `docs/phase4h-audit.md` §5. A customer who had paid saw nothing at all once
     * provisioning stopped finishing, for as long as it took.
     *
     * The subject is the SERVICE here and the operation everywhere else, and the
     * asymmetry is load-bearing rather than an inconsistency:
     * `CUSTOMER_NOTIFICATION_PRECONDITIONS` marks this kind as needing a re-check
     * before sending, and `DrizzleNotificationSubjectReader` performs it by reading
     * `services.state`. Keyed on the operation, that lookup finds nothing and answers
     * `false`, so every delay notification would be SUPERSEDED instead of sent.
     */
    const { announcer, queued } = announcerFor('PROVISION', 'ABANDONED');
    await announcer.announce(scope, 'operation-1');
    expect(queued).toEqual([
      { customerId: CUSTOMER, kind: 'SERVICE_PROVISION_DELAYED', subjectId: 'service-1' },
    ]);
  });

  it('announces a delay when a RECONCILE is abandoned', async () => {
    /*
     * A reconcile is this installation asking a panel what it did. One that is
     * abandoned leaves the service `UNRECONCILED` — a customer waiting on a link
     * nobody can produce, which is the same silence from their side.
     */
    const { announcer, queued } = announcerFor('RECONCILE', 'ABANDONED');
    await announcer.announce(scope, 'operation-1');
    expect(queued.map((q) => q.kind)).toEqual(['SERVICE_PROVISION_DELAYED']);
  });

  it('says nothing when a PROVISION succeeds', async () => {
    /*
     * The success already produces the subscription link through `DeliveryService`,
     * which is a better message than "your request was applied". Only the ABANDONMENT
     * of these two is announced.
     */
    const { announcer, queued } = announcerFor('PROVISION', 'SUCCEEDED');
    await announcer.announce(scope, 'operation-1');
    expect(queued).toEqual([]);
  });

  it('says nothing when a background read is abandoned', async () => {
    /*
     * `SYNC_USAGE` reads a number back from a panel. A customer waiting on nothing is
     * not delayed, and announcing it would be a message about our housekeeping.
     */
    const { announcer, queued } = announcerFor('SYNC_USAGE', 'ABANDONED');
    await announcer.announce(scope, 'operation-1');
    expect(queued).toEqual([]);
  });

  /*
   * The sweep that closes the crash window `docs/phase4j-audit.md` measures.
   *
   * `ProvisionerLoop` terminalises in one transaction and announces in the next,
   * and a process that dies between them leaves an operation nothing will ever
   * announce again. These assert the three properties that make the sweep a fix
   * rather than a second announcer racing the first.
   */
  describe('sweeping the operations a crash left unanswered', () => {
    function sweeperFor(due: readonly string[]) {
      const asked: { before: Date; limit: number }[] = [];
      const queued: Queued[] = [];
      const stamped: string[] = [];
      const announcer = new OperationOutcomeAnnouncer({
        reader: {
          subjectFor: async () => ({
            type: 'RENEW' as OperationType,
            state: 'SUCCEEDED' as OperationState,
            serviceId: SERVICE,
            customerId: CUSTOMER,
            requestedByCustomerId: CUSTOMER,
            nextAttemptAt: null,
          }),
          dueForAnnouncement: async (_scope, before, limit) => {
            asked.push({ before, limit });
            return due;
          },
        },
        announcements: {
          markAnnounced: async (_scope, operationId) => void stamped.push(operationId),
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
      return { announcer, asked, queued, stamped };
    }

    it('asks only for operations that finished before the grace cutoff', async () => {
      /*
       * Without the grace this fires for EVERY operation, and the loop's own
       * synchronous call becomes dead code — code nothing would notice breaking.
       * The cutoff is what makes this the crash path rather than a second
       * announcer.
       */
      const { announcer, asked } = sweeperFor([]);
      await announcer.announceDue(scope, 25);
      expect(asked).toHaveLength(1);
      expect(asked[0]?.before.getTime()).toBe(NOW.getTime() - ANNOUNCE_GRACE_MS);
      expect(asked[0]?.before.getTime()).toBeLessThan(NOW.getTime());
    });

    it('passes the bound it was given through rather than draining', async () => {
      const { announcer, asked } = sweeperFor([]);
      await announcer.announceDue(scope, 7);
      expect(asked[0]?.limit).toBe(7);
    });

    it('announces and stamps every operation it was handed', async () => {
      const { announcer, queued, stamped } = sweeperFor(['op-a', 'op-b']);
      const swept = await announcer.announceDue(scope, 25);
      expect(swept).toBe(2);
      expect(queued.map((q) => q.subjectId)).toEqual(['op-a', 'op-b']);
      expect(stamped).toEqual(['op-a', 'op-b']);
    });

    it('announces the rest of the batch when one operation throws', async () => {
      /*
       * `dueForAnnouncement` orders OLDEST FIRST, so an operation that throws is
       * first again on the next tick and on every tick after it. Without this,
       * one poisoned row stops the sweep for ever and everybody behind it is
       * never told — the head-of-line block the sweep exists to avoid, one level
       * up from the transaction boundary that avoids it.
       *
       * The error is re-thrown after the batch rather than swallowed: a broken
       * sweep must not look like an idle one, and `ProvisionerLoop.tick` logs it.
       */
      const { announcer, queued, stamped } = sweeperFor(['op-bad', 'op-good']);
      const reader = (
        announcer as unknown as {
          deps: { reader: { subjectFor: (...args: unknown[]) => Promise<unknown> } };
        }
      ).deps.reader;
      const real = reader.subjectFor.bind(reader);
      reader.subjectFor = async (...args: unknown[]) => {
        if (args[1] === 'op-bad') throw new Error('the subject read failed');
        return real(...args);
      };

      await expect(announcer.announceDue(scope, 25)).rejects.toThrow('the subject read failed');

      expect(
        queued.map((q) => q.subjectId),
        'the good operation was skipped',
      ).toEqual(['op-good']);
      expect(stamped).toEqual(['op-good']);
    });

    it('does nothing when no operation is stranded', async () => {
      const { announcer, queued, stamped } = sweeperFor([]);
      expect(await announcer.announceDue(scope, 25)).toBe(0);
      expect(queued).toEqual([]);
      expect(stamped).toEqual([]);
    });
  });

  it('keys the notification on the operation, not the service', async () => {
    /*
     * `customer_notifications_subject_key` is (tenant, kind, subject). Keying on the
     * service would tell a customer about their FIRST renewal and silently drop every
     * one after it, because the second enqueue would hit the unique index and no-op.
     */
    const { announcer, queued } = announcerFor('RENEW', 'SUCCEEDED');
    await announcer.announce(scope, 'operation-1');
    await announcer.announce(scope, 'operation-2');
    expect(queued.map((q) => q.subjectId)).toEqual(['operation-1', 'operation-2']);
  });

  it('says nothing when the operation or the service is gone', async () => {
    const queued: Queued[] = [];
    const stamped: string[] = [];
    const announcer = new OperationOutcomeAnnouncer({
      reader: { subjectFor: async () => null, dueForAnnouncement: async () => [] },
      announcements: {
        markAnnounced: async (_scope, operationId) => void stamped.push(operationId),
      },
      notifier: {
        notify: async () => {
          queued.push({ customerId: CUSTOMER, kind: 'x', subjectId: 'x' });
          return true;
        },
      } as unknown as CustomerNotifier,
      uow: passthroughUow,
      clock: { now: () => NOW },
    });
    await announcer.announce(scope, 'operation-1');
    expect(queued).toEqual([]);
    /*
     * And it IS answered, even though it said nothing.
     *
     * `announced_at` means "nobody has answered for this", not "a message went
     * out". A subject that cannot be found never will be, so leaving the row NULL
     * would make `announceDue` re-read it on every tick for the life of the
     * installation.
     */
    expect(stamped).toEqual(['operation-1']);
  });

  /*
   * The five ways out of `announce`, and which of them mark the operation answered.
   *
   * This is the rule 4J-1 turns on and it is silent in BOTH directions: a missing
   * stamp makes the sweep re-read a row for ever, and a stamp on the non-terminal
   * exit marks a `FAILED`-with-attempts-left as answered before it has reached the
   * state anyone would announce. Neither shows up as a failure anywhere else, so
   * each exit gets its own assertion.
   */
  describe('which exits mark the operation answered', () => {
    it('stamps a terminal operation it announced', async () => {
      const { announcer, queued, stamped } = announcerFor('RENEW', 'SUCCEEDED');
      await announcer.announce(scope, 'operation-1');
      expect(queued).toHaveLength(1);
      expect(stamped).toEqual(['operation-1']);
    });

    it('stamps a terminal operation nobody is owed a message about', async () => {
      // `SYNC_USAGE` is a background read the customer never asked for. It says
      // nothing — and saying nothing is an answer, so the sweep must not keep
      // asking.
      const { announcer, queued, stamped } = announcerFor('SYNC_USAGE', 'SUCCEEDED');
      await announcer.announce(scope, 'operation-1');
      expect(queued).toEqual([]);
      expect(stamped).toEqual(['operation-1']);
    });

    it('stamps an abandoned provision after queueing the delay notice', async () => {
      const { announcer, queued, stamped } = announcerFor('PROVISION', 'ABANDONED');
      await announcer.announce(scope, 'operation-1');
      expect(queued.map((q) => q.kind)).toEqual(['SERVICE_PROVISION_DELAYED']);
      expect(stamped).toEqual(['operation-1']);
    });

    it('does NOT stamp an operation that has not finished', async () => {
      /*
       * The one exit that must not stamp. A `FAILED` with attempts left goes back
       * to `PLANNED` and is tried again; marking it answered here would mean the
       * sweep skips it for ever once it DOES terminalise, and the customer who
       * paid for the renewal is never told how it went.
       */
      const { announcer, queued, stamped } = announcerFor('RENEW', 'FAILED');
      await announcer.announce(scope, 'operation-1');
      expect(queued).toEqual([]);
      expect(stamped).toEqual([]);
    });
  });

  /**
   * The refusal paths that terminalise, which announced nothing at all.
   *
   * `ProvisionerLoop` broke on `REFUSED` before calling the announcer, and three
   * refusals transition the operation to `ABANDONED` — a missing service, a capability
   * this release does not implement, and a service in a state the operation is not
   * legal from. A customer whose RENEW was refused because their panel type cannot be
   * renewed on was told nothing, deterministically. Found by the Codex review of PR #30.
   *
   * Asserted HERE as well as in the loop test because this is the half that makes it
   * safe: `announce` reads the state itself, so a caller cannot hand it the wrong one.
   */
  it('announces an operation abandoned by a refusal, not only an attempted one', async () => {
    const { announcer, queued } = announcerFor('RENEW', 'ABANDONED');
    await announcer.announce(scope, 'operation-1');
    expect(queued.map((q) => q.kind)).toEqual(['SERVICE_ACTION_FAILED']);
  });
});
