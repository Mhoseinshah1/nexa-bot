import { and, eq } from 'drizzle-orm';
import type { CustomerNotificationKind, TenantContext } from '@nexa/contracts';
import {
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  SERVICE_UNRESOLVED_PROVISION_STATES,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  serviceOwnershipTransfers,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type { NotificationSubjectReader } from '../application/customer-notification.service.js';

/** The kinds this reader has a branch for. Naming them is the second guard below. */
const ANSWERABLE_KINDS: readonly CustomerNotificationKind[] = [
  'SERVICE_PROVISION_DELAYED',
  'SERVICE_TRANSFER_RECEIVED',
];

/**
 * Whether a kind's fact is still true, read from the subject.
 *
 * TWO guards, and they close opposite directions of the same hole.
 *
 * Only the kinds `CUSTOMER_NOTIFICATION_PRECONDITIONS` marks `true` are ever asked, and
 * this asserts that rather than trusting it: a kind reaching here that the table says
 * needs no precondition is a caller bug, and answering `true` would hide it.
 *
 * The second is `ANSWERABLE_KINDS`, and it exists because the first one alone made a
 * false promise. This reader interrogates the `services` table and nothing else, so
 * before the list existed, marking a PAYMENT or ORDER kind `true` did not fail loudly:
 * it read `services` with a payment id, found no row, and returned `false` — and the
 * customer's message was SUPERSEDED and never sent, silently, which is the outcome this
 * whole lane exists to prevent. Naming the kinds this reader can actually answer makes
 * that a refusal instead, and `tests/integration/customer-notifications.test.ts`
 * requires every kind declaring a precondition to appear here.
 *
 * Today that is two kinds. `SERVICE_TRANSFER_RECEIVED` (Package F) has its own branch
 * below, over the transfer row. `SERVICE_PROVISION_DELAYED` says "your service is taking
 * longer than expected", which stops being true the moment the service is `ACTIVE` —
 * and arriving a second after the subscription link would be worse than not arriving at
 * all. It is equally untrue once the service is `TERMINATED`, `EXPIRED` or `SUSPENDED`,
 * which is why the test is against `SERVICE_UNRESOLVED_PROVISION_STATES` rather than
 * against `!== 'ACTIVE'`. Every other kind is a terminal fact that an hour's delay does
 * not make false.
 */
export class DrizzleNotificationSubjectReader implements NotificationSubjectReader {
  constructor(private readonly db: Database) {}

  async stillHolds(
    scope: TenantContext,
    kind: CustomerNotificationKind,
    subjectId: string,
  ): Promise<boolean> {
    if (!CUSTOMER_NOTIFICATION_PRECONDITIONS[kind]) {
      throw new Error(
        `stillHolds asked about ${kind}, which declares no precondition. The dispatcher must not ask.`,
      );
    }
    if (!ANSWERABLE_KINDS.includes(kind)) {
      throw new Error(
        `stillHolds asked about ${kind}, which declares a precondition this reader cannot answer. ` +
          'Give it a branch, or declare no precondition.',
      );
    }

    const tenantId = requireTenantId(scope);

    /*
     * Package F: "a service was given to you" holds while the transfer's recipient still
     * owns the service. Its subject is the TRANSFER row, so this branch reads that row and
     * the service it names — never `services` by the subject id, which would find nothing
     * and supersede every such message. A service passed on again, or a transfer row that
     * is not there, is SUPERSEDED: nothing is announced that the recipient does not have.
     */
    if (kind === 'SERVICE_TRANSFER_RECEIVED') {
      const [held] = await this.db
        .select({ id: serviceOwnershipTransfers.id })
        .from(serviceOwnershipTransfers)
        .innerJoin(
          services,
          and(
            eq(services.tenantId, serviceOwnershipTransfers.tenantId),
            eq(services.id, serviceOwnershipTransfers.serviceId),
            eq(services.customerId, serviceOwnershipTransfers.toCustomerId),
          ),
        )
        .where(
          and(
            eq(serviceOwnershipTransfers.tenantId, tenantId),
            eq(serviceOwnershipTransfers.id, subjectId),
          ),
        )
        .limit(1);
      return held !== undefined;
    }

    const [row] = await this.db
      .select({ state: services.state })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, subjectId)))
      .limit(1);

    /*
     * A service that is gone is not delayed either.
     *
     * `false` rather than `true`, so the row is SUPERSEDED rather than sent. Telling a
     * customer their provisioning is slow for a service no longer in the table is the
     * fabricated claim this codebase refuses, and the absence is the evidence.
     */
    if (row === undefined) return false;
    /*
     * The states that ARE unresolved provisioning, not "everything except ACTIVE".
     *
     * `TERMINATE` is legal from `PENDING_PROVISION` and from `UNRECONCILED`, so a
     * queued delay notice can be claimed after the customer ended the service — and a
     * not-ACTIVE test would then tell them their provisioning was taking longer than
     * expected for a service they had already terminated. `EXPIRED` and `SUSPENDED`
     * are the same mistake one state over. Found by the Codex review of PR #30.
     */
    return (SERVICE_UNRESOLVED_PROVISION_STATES as readonly string[]).includes(row.state);
  }
}
