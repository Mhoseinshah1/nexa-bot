import { and, asc, eq, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import type { CustomerNotificationKind, ServiceReminderKind, TenantContext } from '@nexa/contracts';
import {
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  DIRECT_MESSAGE_STALE_AFTER_MS,
  INCIDENT_NOTICE_STALE_AFTER_MS,
  EXPIRY_REMINDER_KINDS,
  EXPIRY_REMINDER_STATES,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  SERVICE_UNRESOLVED_PROVISION_STATES,
  USAGE_REMINDER_KINDS,
  USAGE_REMINDER_STATES,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customerDirectMessages,
  customerNotifications,
  serviceOwnershipTransfers,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type { NotificationSubjectReader } from '../application/customer-notification.service.js';
import { resellerMinimumReminderHolds } from '../../resellers/infrastructure/drizzle-reseller-minimum-facts.js';

/**
 * WP-A9: which service reminder a notification kind carries, inverted from the contract's
 * own map so a kind added there is answerable here the moment it is.
 */
const REMINDER_KIND_OF: ReadonlyMap<CustomerNotificationKind, ServiceReminderKind> = new Map(
  (
    Object.entries(SERVICE_REMINDER_NOTIFICATION_KINDS) as [
      ServiceReminderKind,
      CustomerNotificationKind,
    ][]
  ).map(([reminder, notification]) => [notification, reminder]),
);

/**
 * The instant a direct message written at or before is stale: `stillHolds` keeps a message
 * created AFTER it, and `lapsedSubjects` names one created AT or BEFORE it — one boundary.
 */
function directMessageStaleBefore(now: Date): Date {
  return new Date(now.getTime() - DIRECT_MESSAGE_STALE_AFTER_MS);
}

/** The kinds this reader has a branch for. Naming them is the second guard below. */
const ANSWERABLE_KINDS: readonly CustomerNotificationKind[] = [
  'SERVICE_PROVISION_DELAYED',
  'SERVICE_TRANSFER_RECEIVED',
  // WP-A9: every service reminder, the wallet alert and the two pending reminders.
  ...REMINDER_KIND_OF.keys(),
  'WALLET_LOW_BALANCE',
  'PAYMENT_PENDING_REMINDER',
  'ORDER_PENDING_REMINDER',
  // Round N R2: answered from the notice row, the reseller and the month's sales.
  'RESELLER_MINIMUM_REMINDER',
  // Phase A2: answered from the direct message's own row.
  'DIRECT_MESSAGE',
  'DIRECT_MESSAGE_MEDIA',
  // Phase E3: answered from the notice row and its incident.
  'INCIDENT_NOTICE',
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
 * WP-A9 added the eight service reminder kinds, the wallet low-balance alert and the two
 * pending-payment reminders, each with its own branch over its own subject table (below).
 * Before it there were two. `SERVICE_TRANSFER_RECEIVED` (Package F) has its own branch
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
    now: Date,
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

    const reminder = REMINDER_KIND_OF.get(kind);
    if (reminder !== undefined) return this.reminderHolds(tenantId, reminder, subjectId, now);
    if (kind === 'WALLET_LOW_BALANCE') return this.walletStillLow(tenantId, subjectId, now);
    if (kind === 'PAYMENT_PENDING_REMINDER')
      return this.paymentStillPending(tenantId, subjectId, now);
    if (kind === 'ORDER_PENDING_REMINDER') return this.orderStillPending(tenantId, subjectId, now);
    if (kind === 'RESELLER_MINIMUM_REMINDER') {
      return resellerMinimumReminderHolds(this.db, tenantId, subjectId, now);
    }
    if (kind === 'DIRECT_MESSAGE' || kind === 'DIRECT_MESSAGE_MEDIA') {
      return this.directMessageFresh(tenantId, kind, subjectId, now);
    }
    /*
     * Phase E3: a notice holds while its incident is still SCHEDULED or ACTIVE and the
     * notice is younger than `INCIDENT_NOTICE_STALE_AFTER_MS` by the dispatcher's clock.
     * A cancelled or resolved window, or a notice held back a day, is superseded unsent.
     */
    if (kind === 'INCIDENT_NOTICE') {
      const result = await this.db.execute(sql`
        SELECT 1
          FROM incident_notices n
          JOIN incidents i ON i.tenant_id = n.tenant_id AND i.id = n.incident_id
         WHERE n.tenant_id = ${tenantId}
           AND n.id = ${subjectId}
           AND i.status IN ('SCHEDULED', 'ACTIVE')
           AND n.created_at > ${new Date(now.getTime() - INCIDENT_NOTICE_STALE_AFTER_MS)}
         LIMIT 1`);
      return result.rows.length > 0;
    }

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

  /**
   * WP-A9: a service reminder holds while the service still has the PERIOD it was raised
   * against, in a state its family speaks about.
   *
   * Read by the REMINDER's id and joined to the service it names — never `services` by the
   * subject id, which would find nothing and supersede every reminder in silence. The
   * period comparison is `IS NOT DISTINCT FROM` in SQL, for the microsecond reason
   * `ServiceReminderBasis` gives: a deadline read into a `Date` and compared in JavaScript
   * would differ from the column it came from, and every reminder would be superseded.
   *
   *   - Every kind: the deadline is the one the reminder was raised against. A RENEW or an
   *     ADD_TIME moves it, and "expires in one day" about the old deadline is superseded.
   *   - The usage kinds: the allowance too — an ADD_TRAFFIC re-arms them — and the service
   *     still ACTIVE or SUSPENDED.
   *   - The expiry kinds: the service still in `EXPIRY_REMINDER_STATES`, so a terminated
   *     service is told nothing; and every ADVANCE warning needs its deadline still ahead,
   *     because "one day left" delivered after the deadline is false. `EXPIRED` needs no
   *     such test: its basis IS a deadline in the past.
   *   - HF-A9: no MORE URGENT slot of the same family has been raised for the same period
   *     since. The sweep already refuses to raise a less urgent slot after a more urgent one
   *     (it records the prefix); this is the same rule for a message still QUEUED when the
   *     more urgent one was raised. Quiet hours make that the ordinary case — "expires
   *     tomorrow" raised at 23:30 and held, then "expires today" raised at local midnight
   *     and held — and releasing both at the window's end would tell the customer something
   *     already false beside something true. The older one is superseded; the more urgent
   *     one is what they are told. "Raised" by the dispatcher's own clock: `raised_at` is
   *     the sweep's `Clock`, so only news that exists at the moment of sending counts.
   *
   * A reminder row that is gone is `false`: nothing is announced about a subject that does
   * not exist.
   */
  private async reminderHolds(
    tenantId: string,
    reminder: ServiceReminderKind,
    subjectId: string,
    now: Date,
  ): Promise<boolean> {
    const expiry = (EXPIRY_REMINDER_KINDS as readonly string[]).includes(reminder);
    const states = expiry ? EXPIRY_REMINDER_STATES : USAGE_REMINDER_STATES;
    const advance = expiry && reminder !== 'EXPIRED';
    // Both families are listed least urgent first; the slots after this one are the later news.
    const family: readonly string[] = expiry ? EXPIRY_REMINDER_KINDS : USAGE_REMINDER_KINDS;
    const moreUrgent = family.slice(family.indexOf(reminder) + 1);
    const result = await this.db.execute(sql`
      SELECT 1
      FROM service_reminders r
      JOIN services s ON s.tenant_id = r.tenant_id AND s.id = r.service_id
      WHERE r.tenant_id = ${tenantId}
        AND r.id = ${subjectId}
        AND r.basis_expires_at IS NOT DISTINCT FROM s.expires_at
        AND s.state = ANY(${sql.param([...states])}::text[])
        ${expiry ? sql`` : sql`AND r.basis_traffic_limit_bytes = s.traffic_limit_bytes`}
        ${advance ? sql`AND s.expires_at > ${now}` : sql``}
        ${
          moreUrgent.length === 0
            ? sql``
            : sql`AND NOT EXISTS (
                SELECT 1 FROM service_reminders later
                WHERE later.tenant_id = r.tenant_id
                  AND later.service_id = r.service_id
                  AND later.kind = ANY(${sql.param(moreUrgent)}::text[])
                  AND later.basis_expires_at IS NOT DISTINCT FROM r.basis_expires_at
                  AND later.raised_at <= ${now}
                  ${expiry ? sql`` : sql`AND later.basis_traffic_limit_bytes = r.basis_traffic_limit_bytes`}
              )`
        }
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * WP-A9: "your balance is low" holds while the ledger still says so.
   *
   * The balance is DERIVED, here as everywhere — the sum of the wallet's entries in the
   * alert's currency — and compared with the threshold the alert recorded rather than
   * today's setting, so an operator moving the threshold afterwards changes nothing about
   * a message already owed. A top-up that landed before the send supersedes it.
   *
   * HF-A9: so does a LATER crossing of the same wallet raised by now. A wallet that
   * recovered and fell again while the first alert was held by quiet hours has two alerts
   * queued, and releasing both at the window's end would tell the customer the same thing
   * twice; the later one is the one that describes the wallet now.
   */
  private async walletStillLow(tenantId: string, subjectId: string, now: Date): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM wallet_threshold_alerts a
      WHERE a.tenant_id = ${tenantId}
        AND a.id = ${subjectId}
        AND (
          SELECT COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)
          FROM wallet_entries e
          WHERE e.tenant_id = a.tenant_id
            AND e.customer_id = a.customer_id
            AND e.currency = a.currency
        ) < a.threshold_amount
        AND NOT EXISTS (
          SELECT 1 FROM wallet_threshold_alerts later
          WHERE later.tenant_id = a.tenant_id
            AND later.customer_id = a.customer_id
            AND later.currency = a.currency
            AND (later.crossed_at, later.crossing_entry_id) > (a.crossed_at, a.crossing_entry_id)
            AND later.raised_at <= ${now}
        )
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * See the port. The direct-message kinds and the incident notice — the preconditions that
   * lapse by the clock or by another record's end — read against the SAME instant `directMessageFresh` compares with, so
   * the two can only agree: a row named here is one `stillHolds` would answer `false`.
   * Whatever the customer's status; that is the point.
   */
  async lapsedSubjects(
    scope: TenantContext,
    now: Date,
    limit: number,
  ): Promise<readonly { readonly kind: CustomerNotificationKind; readonly subjectId: string }[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ kind: customerNotifications.kind, subjectId: customerNotifications.subjectId })
      .from(customerNotifications)
      .innerJoin(
        customerDirectMessages,
        and(
          eq(customerDirectMessages.tenantId, customerNotifications.tenantId),
          eq(customerDirectMessages.id, customerNotifications.subjectId),
        ),
      )
      .where(
        and(
          eq(customerNotifications.tenantId, tenantId),
          inArray(customerNotifications.kind, ['DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA']),
          eq(customerNotifications.state, 'PENDING'),
          isNull(customerNotifications.sendStartedAt),
          lte(customerDirectMessages.createdAt, directMessageStaleBefore(now)),
        ),
      )
      .orderBy(asc(customerDirectMessages.createdAt), asc(customerDirectMessages.id))
      .limit(limit);
    /*
     * Phase E3: an incident notice lapses the same way — when its incident is no longer
     * SCHEDULED or ACTIVE, or it is older than `INCIDENT_NOTICE_STALE_AFTER_MS` — and a
     * customer who stays blocked would otherwise hold it QUEUED for ever (Codex, #162).
     * The exact negation of the `INCIDENT_NOTICE` branch of `stillHolds`, same instant.
     */
    const notices = await this.db.execute(sql`
      SELECT cn.kind, cn.subject_id
        FROM customer_notifications cn
        JOIN incident_notices n ON n.tenant_id = cn.tenant_id AND n.id = cn.subject_id
        JOIN incidents i ON i.tenant_id = n.tenant_id AND i.id = n.incident_id
       WHERE cn.tenant_id = ${tenantId}
         AND cn.kind = 'INCIDENT_NOTICE'
         AND cn.state = 'PENDING'
         AND cn.send_started_at IS NULL
         AND (i.status NOT IN ('SCHEDULED', 'ACTIVE')
              OR n.created_at <= ${new Date(now.getTime() - INCIDENT_NOTICE_STALE_AFTER_MS)})
       ORDER BY n.created_at, n.id
       LIMIT ${Math.max(0, limit - rows.length)}`);
    return [
      ...rows.map((row) => ({
        kind: row.kind as CustomerNotificationKind,
        subjectId: row.subjectId,
      })),
      ...(notices.rows as { kind: string; subject_id: string }[]).map((row) => ({
        kind: row.kind as CustomerNotificationKind,
        subjectId: row.subject_id,
      })),
    ];
  }

  /**
   * Phase A2: what an operator wrote holds while it is younger than
   * `DIRECT_MESSAGE_STALE_AFTER_MS` — by the dispatcher's clock, half-open — and is the
   * kind its row says it is. Read by the MESSAGE's id from its own table, never another
   * table by the subject id. A row that is not there is `false`: nothing is sent about it.
   */
  private async directMessageFresh(
    tenantId: string,
    kind: 'DIRECT_MESSAGE' | 'DIRECT_MESSAGE_MEDIA',
    subjectId: string,
    now: Date,
  ): Promise<boolean> {
    const since = directMessageStaleBefore(now);
    const [row] = await this.db
      .select({ id: customerDirectMessages.id })
      .from(customerDirectMessages)
      .where(
        and(
          eq(customerDirectMessages.tenantId, tenantId),
          eq(customerDirectMessages.id, subjectId),
          kind === 'DIRECT_MESSAGE'
            ? eq(customerDirectMessages.contentKind, 'TEXT')
            : ne(customerDirectMessages.contentKind, 'TEXT'),
          gt(customerDirectMessages.createdAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * WP-A9: a pending-payment reminder holds while the payment can still be completed and
   * the customer has not already acted on it.
   *
   * PENDING, a manual transfer, before its deadline, with no "I have paid" signal and no
   * receipt filed. Anything else — confirmed, rejected, cancelled, expired, a receipt
   * under review — and a reminder to pay would be wrong, so it is SUPERSEDED.
   */
  private async paymentStillPending(
    tenantId: string,
    subjectId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM payments p
      WHERE p.tenant_id = ${tenantId}
        AND p.id = ${subjectId}
        AND p.state = 'PENDING'
        AND p.method = 'MANUAL_TRANSFER'
        AND p.expires_at IS NOT NULL
        AND p.expires_at > ${now}
        AND p.customer_signalled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_receipts pr
          WHERE pr.tenant_id = p.tenant_id AND pr.payment_id = p.id
        )
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  /**
   * WP-A9: an unpaid-order reminder holds while the order is still awaiting payment before
   * its deadline and no payment for it is under way or unresolved — a PENDING transfer has
   * its own reminder, and one whose outcome is UNKNOWN must never be chased.
   */
  private async orderStillPending(
    tenantId: string,
    subjectId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.db.execute(sql`
      SELECT 1
      FROM orders o
      WHERE o.tenant_id = ${tenantId}
        AND o.id = ${subjectId}
        AND o.state = 'AWAITING_PAYMENT'
        AND o.expires_at IS NOT NULL
        AND o.expires_at > ${now}
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.tenant_id = o.tenant_id
            AND p.order_id = o.id
            AND p.state IN ('PENDING', 'CONFIRMED', 'UNKNOWN')
        )
      LIMIT 1
    `);
    return result.rows.length > 0;
  }
}
