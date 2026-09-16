import { and, eq } from 'drizzle-orm';
import type { CustomerNotificationKind, TenantContext } from '@nexa/contracts';
import { CUSTOMER_NOTIFICATION_PRECONDITIONS } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { services } from '../../../../infrastructure/persistence/schema.js';
import type { NotificationSubjectReader } from '../application/customer-notification.service.js';

/**
 * Whether a kind's fact is still true, read from the subject.
 *
 * Only the kinds `CUSTOMER_NOTIFICATION_PRECONDITIONS` marks `true` are ever asked, and
 * this asserts that rather than trusting it: a kind reaching here that the table says
 * needs no precondition is a caller bug, and answering `true` would hide it.
 *
 * Today that is one kind. `SERVICE_PROVISION_DELAYED` says "your service is taking
 * longer than expected", which stops being true the moment the service is `ACTIVE` —
 * and arriving a second after the subscription link would be worse than not arriving at
 * all. Every other kind is a terminal fact that an hour's delay does not make false.
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

    const tenantId = requireTenantId(scope);
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
    return row.state !== 'ACTIVE';
  }
}
