import type { Money } from '@nexa/contracts';
import {
  CUSTOMER_NOTIFICATION_BACKOFF_MS,
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_MAX_ATTEMPTS,
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  CUSTOMER_NOTIFICATION_QUIET_HOURS,
  CUSTOMER_NOTIFICATION_TEMPLATES,
  SERVICE_REMINDER_NOTIFICATION_KINDS,
  type Clock,
  type CustomerNotificationKind,
  type TemplateValues,
  type TicketAttachmentKind,
  type TicketReplyFileMimeType,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerButton,
  CustomerMessenger,
  CustomerNotificationRecord,
  CustomerNotificationRepository,
} from './ports.js';
import type { ServiceReminderSnapshotReader } from '../../provisioning/application/service-reminder.ports.js';

/**
 * Whether a kind's fact is still true, asked of the subject itself.
 *
 * A NARROW port, for the reason `CustomerContactReader` gives: handing the dispatcher a
 * service repository would also hand a background loop everything else on it. This can
 * answer one question and take no action.
 *
 * Only the kinds with `CUSTOMER_NOTIFICATION_PRECONDITIONS[kind] === true` are ever
 * asked. A kind marked `false` is a terminal fact and asking would be a read that can
 * only agree.
 */
export interface NotificationSubjectReader {
  stillHolds(
    scope: TenantContext,
    kind: CustomerNotificationKind,
    subjectId: string,
    /**
     * The dispatcher's clock, for the kinds whose fact is about a deadline (WP-A9): "one
     * day left" stops holding once the deadline passes, and "pay within ten minutes" once
     * the payment window closes. From the `Clock` port, never the database's own `now()`.
     */
    now: Date,
  ): Promise<boolean>;
}

/**
 * A tenant's quiet window, resolved for one pass (HF-A9).
 *
 * `quietUntil` answers, for an instant, when the window holding it ends — or `null` when
 * the instant is not inside it. An OBJECT resolved once per pass and asked per row, so a
 * pass reads the flag, the two settings and the tenant's timezone once, and a pass that runs
 * across the window's edge still answers each row by the clock at that row.
 *
 * The wall-clock arithmetic is behind this port because it is ICU's and lives beside the
 * report calendar in infrastructure; the dispatcher only ever holds an instant.
 */
export interface QuietHoursSchedule {
  quietUntil(at: Date): Date | null;
}

/** Resolves the quiet window for a pass: `null` when quiet hours are off. */
export interface QuietHoursReader {
  scheduleFor(scope: TenantContext): Promise<QuietHoursSchedule | null>;
}

/** How long a claimed row is held before another pass may take it. */
export const NOTIFICATION_LEASE_MS =
  CUSTOMER_NOTIFICATION_BACKOFF_MS * CUSTOMER_NOTIFICATION_MAX_ATTEMPTS;

/** What one pass did. Counted rather than returned, so nothing downstream re-sends. */
export interface NotificationSweepReport {
  readonly claimed: number;
  readonly delivered: number;
  /** Refused, attempts not yet spent. Still queued. */
  readonly pending: number;
  /** Refused for the last time. Needs a person. */
  readonly failed: number;
  /** Telegram may have it. Never retried automatically. */
  readonly unconfirmed: number;
  /** The precondition said the fact had stopped being true. Nothing was sent. */
  readonly superseded: number;
  /** Telegram asked us to slow down. No attempt spent, back on the queue. */
  readonly rateLimited: number;
  /**
   * Claimed, and the kind is one THIS build cannot render. Deferred, never spent.
   *
   * A row a NEWER release produced. `customer_notifications.kind` is pinned by a CHECK
   * built from the contract, so widening it is write-compatible — and it is not READER
   * compatible: an older dispatcher indexing `CUSTOMER_NOTIFICATION_TEMPLATES` with a
   * kind it has never heard of gets `undefined`, and before this it had already stamped
   * `send_started_at`, so the throw left a row the reaper resolved `UNCONFIRMED` — lost
   * for ever, with no Telegram request ever made.
   *
   * That is the rolling-update and the ROLLBACK window, and rollback is the one that
   * matters: `botctl rollback` never restores the database, so rows a newer release
   * wrote outlive it. Deferring leaves the row exactly where a replica that DOES know
   * the kind will find it. Found by the Codex review of PR #32.
   */
  readonly unsupported: number;
  /**
   * Claimed, then found to belong to a customer an operator had just blocked.
   *
   * Back on the queue with no attempt spent, NOT failed: `claimDue` excludes a blocked
   * customer at the query, so a row that reached the send only because the block
   * committed mid-claim must end up where the query would have left it. A block may be
   * reversed, and a terminal `FAILED` could not be.
   */
  readonly blocked: number;
  /** Claimed, then found to belong to a customer with no reachable chat at all. */
  readonly unreachable: number;
  /**
   * HF-A9: a reminder claimed inside the tenant's quiet window, put back on the queue until
   * the window ends. No attempt spent, nothing sent, no row written — the same row waits.
   */
  readonly quietHours: number;
  /**
   * HF-A9: reminders an earlier pass held that the CURRENT schedule releases sooner — the
   * window was shortened or quiet hours were switched off. Brought forward before the claim.
   */
  readonly quietReleased: number;
  /** The send threw. The lease stands and the row comes back later. */
  readonly errored: number;
  /**
   * Sent, and the outcome could not be recorded because the row had moved.
   *
   * Its own count rather than part of `delivered`, because the two are different facts
   * and only this one can produce a second message to the same customer.
   */
  readonly lost: number;
}

/** A file a notification carries (HF-A7): support's, sent by bytes. */
export interface NotificationFile {
  readonly kind: TicketAttachmentKind;
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: TicketReplyFileMimeType;
}

/** The ledger reasons a payment's credit sentence can name. */
export type PaymentCreditReason =
  'TOPUP_RECEIPT' | 'TOPUP_GATEWAY' | 'CASHBACK_TOPUP' | 'RECEIPT_CREDIT';

/**
 * The three kinds whose subject is a PAYMENT and whose sentence names what it credited
 * (Payment File 02 §18), and the ledger entry each one reads. A kind is here or it
 * renders with no figure, and each maps to exactly one reason: a top-up's sentence must
 * never be able to read its gift, nor a receipt credit a top-up's principal.
 */
export const PAYMENT_CREDIT_FIGURES: Readonly<
  Partial<Record<CustomerNotificationKind, readonly PaymentCreditReason[]>>
> = {
  /*
   * A top-up's principal, whichever rail funded it: a reviewed transfer credits
   * `TOPUP_RECEIPT` and an external gateway `TOPUP_GATEWAY` (WP11A). A payment has one
   * method, so exactly one of the two exists for it — never its gift, never a receipt credit.
   */
  WALLET_TOPUP_CREDITED: ['TOPUP_RECEIPT', 'TOPUP_GATEWAY'],
  WALLET_TOPUP_GIFT_CREDITED: ['CASHBACK_TOPUP'],
  RECEIPT_CREDITED_TO_WALLET: ['RECEIPT_CREDIT'],
};

/**
 * The six kinds whose message carries figures, as a set, derived from the contract.
 *
 * Derived rather than listed, so a seventh reminder kind is covered the moment it is
 * added to `SERVICE_REMINDER_NOTIFICATION_KINDS` — and a kind removed from there stops
 * asking for a snapshot that no longer exists, instead of failing every send.
 */
const REMINDER_NOTIFICATION_KINDS = new Set<string>(
  Object.values(SERVICE_REMINDER_NOTIFICATION_KINDS),
);

/** HF-A9: the kinds quiet hours hold, from the contract's own table. */
const QUIET_KINDS: readonly CustomerNotificationKind[] = CUSTOMER_NOTIFICATION_KINDS.filter(
  (kind) => CUSTOMER_NOTIFICATION_QUIET_HOURS[kind],
);

/** WP-A9: the reminders whose values come from `reminderFacts` rather than a snapshot. */
const ACCOUNT_REMINDER_KINDS = new Set<string>([
  'WALLET_LOW_BALANCE',
  'PAYMENT_PENDING_REMINDER',
  'ORDER_PENDING_REMINDER',
]);

export interface CustomerNotificationDeps {
  readonly notifications: CustomerNotificationRepository;
  readonly contacts: {
    contactFor(
      scope: TenantContext,
      customerId: CustomerNotificationRecord['customerId'],
      tx?: unknown,
    ): Promise<
      | { readonly kind: 'CONTACT'; readonly contact: { readonly chatId: string } }
      | { readonly kind: 'BLOCKED' }
      | { readonly kind: 'NONE' }
    >;
  };
  readonly subjects: NotificationSubjectReader;
  readonly messenger: CustomerMessenger;
  /**
   * The frozen figures a reminder renders, read back by id.
   *
   * The only kinds that use it are the six reminders, and they are also the only kinds
   * whose message carries numbers. Everything else in this lane is a fact with no
   * parameters, which is why `values` was an empty object until now.
   */
  readonly reminderSnapshots: ServiceReminderSnapshotReader;
  /**
   * What an order's automatic refund actually put back, read off the ledger.
   *
   * A READER, not a payload. ADR 0030 §1 refuses a producer-supplied payload and
   * this is not one: the producer passed a kind and an order id, and both figures
   * are derived from the append-only entries that id names — exactly as
   * `reminderSnapshots` above derives its figures from the row its subject id
   * names.
   */
  readonly refundFigures: {
    refundedForOrder: (
      scope: TenantContext,
      orderId: string,
    ) => Promise<{ readonly amount: Money; readonly balanceAfter: Money } | null>;
  };
  /**
   * WP19: the values a service refund request's notification renders — the credited amount
   * and the removed service, or the rejection's reason — read from the request row the
   * notification names. `null` when the row does not (yet) state the fact.
   */
  readonly serviceRefunds?: {
    notificationValues(
      scope: TenantContext,
      kind: string,
      requestId: string,
    ): Promise<Record<string, unknown> | null>;
  };
  /**
   * What one payment's credit put on the wallet, read off the ledger (Payment File 02
   * §18). `refundFigures`' shape for the three kinds whose subject is a PAYMENT: the
   * principal of a top-up, its gift, and a reviewer's receipt credit. A reader, not a
   * payload (ADR 0030 §1).
   */
  /**
   * Why an administrator rejected a transfer, read from the payment the notification names
   * (File 01 §7). A reader, not a payload — ADR 0030 §1 — the same shape as the refund and
   * credit figures. Null for a rejection recorded before the reason was mandatory.
   */
  readonly rejectionReasons: {
    rejectionReasonFor: (scope: TenantContext, paymentId: string) => Promise<string | null>;
  };
  readonly paymentCredits: {
    creditedForPayment: (
      scope: TenantContext,
      paymentId: string,
      reasons: readonly PaymentCreditReason[],
    ) => Promise<Money | null>;
  };
  /**
   * Package F: what `SERVICE_TRANSFER_RECEIVED` renders — the service's name, location and
   * what is left of it — read at send time from the transfer row the notification names,
   * and the service that transfer moved. A reader, not a payload (ADR 0030 §1). Null when
   * the row or the service cannot be read.
   */
  /**
   * WP-A9: what the wallet low-balance alert and the two pending-payment reminders render —
   * read at send time from the alert, the payment or the order the notification names. A
   * reader, not a payload (ADR 0030 §1). `null` means the subject is gone, and nothing is
   * sent. Absent, those three kinds render nothing and are not sent.
   */
  readonly reminderFacts?: {
    valuesFor(
      scope: TenantContext,
      kind: CustomerNotificationKind,
      subjectId: string,
      now: Date,
    ): Promise<TemplateValues | null>;
  };
  readonly serviceTransfers?: {
    notificationFacts(
      scope: TenantContext,
      transferId: string,
    ): Promise<{ readonly values: TemplateValues; readonly serviceId: string } | null>;
  };
  /**
   * The inline buttons a kind carries, derived from what its subject names — never stored,
   * so the lane still carries no payload. Supplied by the composition root, because the
   * callback vocabulary is the Telegram surface's and this application service must not
   * import it. Absent, or an empty list, means no keyboard.
   */
  readonly buttonsFor?: (
    kind: CustomerNotificationKind,
    subject: { readonly serviceId?: string; readonly ticketId?: string },
  ) => readonly CustomerButton[];
  /**
   * WP-A7: what `TICKET_REPLY` renders — the ticket's number and category and support's
   * reply, read at send time from the MESSAGE ROW the notification names, and the ticket
   * the one button opens. A reader, not a payload (ADR 0030 §1). Null when the row is not
   * a reply, which sends nothing.
   */
  readonly tickets?: {
    notificationFacts(
      scope: TenantContext,
      messageId: string,
    ): Promise<{ readonly values: TemplateValues; readonly ticketId: string } | null>;
    /**
     * HF-A7: what `TICKET_REPLY_ATTACHMENT` sends — support's file and its caption's values,
     * read at send time from the file row the MESSAGE id names. A reader, not a payload.
     * Null when there is nothing to send (no file, or its bytes already cleared).
     */
    attachmentFacts(
      scope: TenantContext,
      messageId: string,
    ): Promise<{
      readonly values: TemplateValues;
      readonly ticketId: string;
      readonly file: NotificationFile;
    } | null>;
    /**
     * HF-A7: Telegram accepted the file — stamp its handle and clear the staged bytes, in
     * the transaction that records the delivery.
     */
    attachmentDelivered(
      scope: TenantContext,
      messageId: string,
      file: { readonly fileId: string; readonly fileUniqueId: string },
      at: Date,
      tx: TransactionScope,
    ): Promise<boolean>;
  };
  /**
   * HF-A9: the tenant's quiet window. Asked once per pass; a reminder kind
   * (`CUSTOMER_NOTIFICATION_QUIET_HOURS`) claimed inside it is deferred to its end. Absent
   * means no quiet hours at all, which is what every kind had before.
   */
  readonly quietHours?: QuietHoursReader;
  /**
   * R2 (v0.3.5 real-test item 11): what `SERVICE_RENEWED` renders — the renewed account, the
   * duration bought, the new expiry and the payment's tracking code — read at send time from
   * the RENEW operation the notification names, and the service its one button opens. A
   * reader, not a payload (ADR 0030 §1). Null when the operation is not a succeeded renewal,
   * which sends nothing. Absent, the kind renders nothing and is not sent.
   */
  readonly renewals?: {
    notificationFacts(
      scope: TenantContext,
      operationId: string,
    ): Promise<{
      readonly values: TemplateValues;
      readonly serviceId: string;
      readonly orderId: string | null;
    } | null>;
  };
  /**
   * R2: closes the renewal's payment screens — the order's wizard messages lose their
   * buttons — immediately BEFORE the dedicated result is sent, so the result is a new message
   * after a closed one. Best effort: a screen that cannot be edited does not hold the result.
   */
  readonly orderScreens?: {
    close(scope: TenantContext, orderId: string): Promise<void>;
  };
  /**
   * Round N (B2): what `WALLET_MASS_CREDITED` and `SERVICE_GIFT_APPLIED` render, read at send
   * time from the bulk item the notification names — the credited ledger entry, or the grant
   * and the service. A reader, not a payload (ADR 0030 §1). Null when the item does not state
   * an effect that happened, which sends nothing. Absent, both kinds render nothing.
   */
  readonly massActions?: {
    notificationValues(
      scope: TenantContext,
      kind: 'WALLET_MASS_CREDITED' | 'SERVICE_GIFT_APPLIED',
      itemId: string,
    ): Promise<TemplateValues | null>;
  };
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly scopeIsActive: (scope: TenantContext) => Promise<boolean>;
  readonly logger: {
    info: (context: Record<string, unknown>, message: string) => void;
    error: (context: Record<string, unknown>, message: string) => void;
  };
}

/**
 * The dispatcher: claims what is due, sends it, records what happened.
 *
 * NOTHING here holds a transaction while it sends. The three durable writes — the
 * stamp, the outcome, the rate-limit hold — are each their own `uow.run`, and the send
 * sits between them. That is the repository's non-negotiable "no network call inside a
 * database transaction" seen from the side that would be tempted to break it.
 *
 * The executor still cannot call a messenger. Producers enqueue a row inside the
 * transaction that produced their fact and never touch this class, which keeps
 * `ProvisionerLoop`'s structural guarantee — a failed Telegram send cannot reach a
 * business transaction — true for every kind rather than only for the subscription link.
 */
export class CustomerNotificationService {
  constructor(private readonly deps: CustomerNotificationDeps) {}

  /**
   * One pass.
   *
   * A stopped tenant is a healthy pass that did nothing, NOT a throw. That distinction
   * is not cosmetic: 4G shipped the opposite for a week of branch life and the
   * self-review caught it — a loop that records no progress for a pass that threw makes
   * the worker unhealthy in three minutes, and `botctl update` then rolls the release
   * back AFTER its migration has run, naming the release rather than the operator's own
   * stop.
   */
  async deliverDue(scope: TenantContext, limit: number): Promise<NotificationSweepReport> {
    const empty: NotificationSweepReport = {
      claimed: 0,
      delivered: 0,
      pending: 0,
      failed: 0,
      unconfirmed: 0,
      superseded: 0,
      rateLimited: 0,
      unsupported: 0,
      blocked: 0,
      unreachable: 0,
      quietHours: 0,
      quietReleased: 0,
      errored: 0,
      lost: 0,
    };
    if (!(await this.deps.scopeIsActive(scope))) return empty;

    const now = this.deps.clock.now();

    /*
     * Stranded sends first, and in their own transaction.
     *
     * A row stamped by a process that died is not due — `claimDue` excludes it — so
     * without this it would sit `PENDING` behind a lease for ever. Resolving it to
     * `UNCONFIRMED` before claiming is what keeps the lane from silently shrinking.
     */
    await this.deps.uow.run(scope, async (tx) =>
      this.deps.notifications.reapStranded(scope, now, limit, tx),
    );

    /*
     * The quiet window, once per pass and BEFORE the claim (HF-A9). A read that throws
     * fails the pass before any row is leased, so nothing is held behind a lease for it.
     */
    const quiet =
      this.deps.quietHours === undefined ? null : await this.deps.quietHours.scheduleFor(scope);

    /*
     * Holds an earlier pass made, brought forward to what the schedule says NOW (Codex
     * review of PR #107). A hold stores the window's end as it was then; an operator who
     * shortens the window at 01:00, or switches quiet hours off, must not leave reminders
     * waiting for the old end. `null` — off, or now outside the window — makes them due at
     * once; inside a shorter window they are re-held to its end. Only rows `holdUntil`
     * marked are touched: a retry backoff, a 429's wait or a blocked customer's pause is
     * never pulled forward. Only when the lane knows quiet hours at all — a build without
     * the reader has nothing it could have held.
     */
    let quietReleased = 0;
    if (this.deps.quietHours !== undefined) {
      const releaseAt = quiet === null ? null : quiet.quietUntil(now);
      quietReleased = await this.deps.uow.run(scope, async (tx) =>
        this.deps.notifications.releaseQuietHolds(scope, QUIET_KINDS, releaseAt, now, tx),
      );
    }

    const leaseUntil = new Date(now.getTime() + NOTIFICATION_LEASE_MS);
    const claimed = await this.deps.notifications.claimDue(scope, now, leaseUntil, limit);

    const report = { ...empty, claimed: claimed.length, quietReleased };
    const counts: Record<string, number> = {};
    for (const row of claimed) {
      const outcome = await this.deliverOne(scope, row, quiet);
      counts[outcome] = (counts[outcome] ?? 0) + 1;
    }
    return {
      ...report,
      delivered: counts.delivered ?? 0,
      pending: counts.pending ?? 0,
      failed: counts.failed ?? 0,
      unconfirmed: counts.unconfirmed ?? 0,
      superseded: counts.superseded ?? 0,
      rateLimited: counts.rateLimited ?? 0,
      unsupported: counts.unsupported ?? 0,
      blocked: counts.blocked ?? 0,
      unreachable: counts.unreachable ?? 0,
      quietHours: counts.quietHours ?? 0,
      errored: counts.errored ?? 0,
      lost: counts.lost ?? 0,
    };
  }

  /**
   * The message's values and its inline buttons, or `null` when its subject cannot state the
   * fact. Only a transfer's notification carries a button (Package F); every other kind's
   * values are `reminderValues`'.
   */
  private async contentOf(
    scope: TenantContext,
    row: CustomerNotificationRecord,
  ): Promise<{
    readonly values: TemplateValues;
    readonly buttons: readonly CustomerButton[];
    /** HF-A7: a file to send, with the kind's template as its caption, instead of text. */
    readonly file?: NotificationFile;
    /** R2: the order whose payment screens are closed right before this is sent. */
    readonly closesOrder?: string;
  } | null> {
    if (row.kind === 'SERVICE_RENEWED') {
      if (this.deps.renewals === undefined) return null;
      const facts = await this.deps.renewals.notificationFacts(scope, row.subjectId);
      if (facts === null) return null;
      return {
        values: facts.values,
        buttons: this.deps.buttonsFor?.(row.kind, { serviceId: facts.serviceId }) ?? [],
        ...(facts.orderId === null ? {} : { closesOrder: facts.orderId }),
      };
    }
    if (row.kind === 'WALLET_MASS_CREDITED' || row.kind === 'SERVICE_GIFT_APPLIED') {
      if (this.deps.massActions === undefined) return null;
      const values = await this.deps.massActions.notificationValues(scope, row.kind, row.subjectId);
      return values === null ? null : { values, buttons: [] };
    }
    if (row.kind === 'TICKET_REPLY_ATTACHMENT') {
      if (this.deps.tickets === undefined) return null;
      const facts = await this.deps.tickets.attachmentFacts(scope, row.subjectId);
      if (facts === null) return null;
      return { values: facts.values, buttons: [], file: facts.file };
    }
    if (row.kind === 'SERVICE_TRANSFER_RECEIVED') {
      if (this.deps.serviceTransfers === undefined) return null;
      const facts = await this.deps.serviceTransfers.notificationFacts(scope, row.subjectId);
      if (facts === null) return null;
      return {
        values: facts.values,
        buttons: this.deps.buttonsFor?.(row.kind, { serviceId: facts.serviceId }) ?? [],
      };
    }
    if (row.kind === 'TICKET_REPLY') {
      if (this.deps.tickets === undefined) return null;
      const facts = await this.deps.tickets.notificationFacts(scope, row.subjectId);
      if (facts === null) return null;
      return {
        values: facts.values,
        buttons: this.deps.buttonsFor?.(row.kind, { ticketId: facts.ticketId }) ?? [],
      };
    }
    const values = await this.reminderValues(scope, row);
    return values === null ? null : { values, buttons: [] };
  }

  /**
   * The values a reminder's template needs, or `null` when its subject has vanished.
   *
   * `{}` for every other kind, which is what the whole lane used to pass: those
   * messages are facts with no parameters. ADR 0030 §1 refuses a producer-supplied
   * PAYLOAD, and this is not one — the producer passed a kind and an id, and these are
   * read from the row that id names.
   *
   * The values are the ones the sweep FROZE, not today's. A renewal between the
   * enqueue and the send must not turn "expires in one day" into a contradiction, and
   * a usage sync must not move the figure out from under the threshold that fired.
   *
   * `remainingDays` is omitted rather than sent as zero when it is null, so a template
   * that declares it optional and a body that drops it both behave; the three expiry
   * kinds always have one and `bot.service.expired` does not render it.
   */
  private async reminderValues(
    scope: TenantContext,
    row: CustomerNotificationRecord,
  ): Promise<TemplateValues | null> {
    /*
     * The refund sentence, and the ONE other kind in this lane that renders a
     * figure.
     *
     * `null` when the ledger holds no refund credit for this order — the same
     * "do not send this" the reminder branch returns, and for a stronger reason.
     * The old sentence said the money came back without saying how much, so it
     * was true whatever the ledger held; this one names an amount, and sending
     * «مبلغ ۰ تومان بازگردانده شد» because a read came back empty would be the
     * product stating a figure it has not got. Silence is better.
     */
    if (row.kind === 'ORDER_REFUNDED_TO_WALLET') {
      const refund = await this.deps.refundFigures.refundedForOrder(scope, row.subjectId);
      if (refund === null) return null;
      return { refundAmount: refund.amount, walletBalance: refund.balanceAfter };
    }
    // WP19: a service refund request's facts, from the request row the notification names.
    if (
      row.kind === 'SERVICE_REFUND_REQUEST_REGISTERED' ||
      row.kind === 'SERVICE_REFUND_REQUEST_APPROVED' ||
      row.kind === 'SERVICE_REFUND_REQUEST_REJECTED'
    ) {
      if (this.deps.serviceRefunds === undefined)
        return row.kind === 'SERVICE_REFUND_REQUEST_REGISTERED' ? {} : null;
      const values = await this.deps.serviceRefunds.notificationValues(
        scope,
        row.kind,
        row.subjectId,
      );
      return values as TemplateValues | null;
    }
    /*
     * The three payment credits (Payment File 02 §18): the principal, the gift, the
     * receipt credit — each from its OWN ledger entry for the payment the row names.
     * `null`, and so no message, when the ledger holds none, for the refund's reason
     * above: a sentence naming an amount must not be sent without one.
     */
    /*
     * The rejection's reason (File 01 §7): the customer is told WHY, from the payment's own
     * `resolution_note`. A dash — never an invented sentence — for a rejection recorded before
     * the reason was mandatory; the rejection itself is still a fact worth telling.
     */
    if (row.kind === 'PAYMENT_REJECTED') {
      const reason = await this.deps.rejectionReasons.rejectionReasonFor(scope, row.subjectId);
      return { reason: reason ?? '\u2014' };
    }
    const creditReason = PAYMENT_CREDIT_FIGURES[row.kind];
    if (creditReason !== undefined) {
      const amount = await this.deps.paymentCredits.creditedForPayment(
        scope,
        row.subjectId,
        creditReason,
      );
      return amount === null ? null : { amount };
    }
    if (ACCOUNT_REMINDER_KINDS.has(row.kind)) {
      if (this.deps.reminderFacts === undefined) return null;
      return this.deps.reminderFacts.valuesFor(
        scope,
        row.kind,
        row.subjectId,
        this.deps.clock.now(),
      );
    }
    if (!REMINDER_NOTIFICATION_KINDS.has(row.kind)) return {};
    const snapshot = await this.deps.reminderSnapshots.snapshotOf(scope, row.subjectId);
    if (snapshot === null) return null;
    const limit = snapshot.basisTrafficLimitBytes;
    return {
      service: snapshot.serviceLabel,
      ...(snapshot.remainingDays === null ? {} : { days: snapshot.remainingDays }),
      ...(snapshot.basisExpiresAt === null ? {} : { expiresAt: snapshot.basisExpiresAt }),
      usedTraffic: snapshot.usedBytes,
      totalTraffic: limit,
      /*
       * Integer arithmetic, and floored, for the reason `usageReached` gives: the
       * comparison that produced this reminder was exact at the boundary and the
       * figure beside it must not round the other way. An unlimited allowance cannot
       * reach a percentage and cannot be a usage reminder, so the zero guard is a
       * division guard and not a business rule.
       */
      usagePercent: limit <= 0n ? 0 : Number((snapshot.usedBytes * 100n) / limit),
      /*
       * WP-A9: the same figure from the other side, because the thresholds are now
       * presented as traffic REMAINING. Floored like the one above, and never below zero:
       * a panel that reports more than the allowance has left nothing, not a negative.
       */
      remainingPercent:
        limit <= 0n ? 0 : Math.max(0, Number(((limit - snapshot.usedBytes) * 100n) / limit)),
    };
  }

  private async deliverOne(
    scope: TenantContext,
    row: CustomerNotificationRecord,
    quiet: QuietHoursSchedule | null,
  ): Promise<string> {
    try {
      /*
       * A kind this build cannot render: put it back, spend nothing, stamp nothing.
       *
       * FIRST, before the precondition and long before `markSendStarted`, because the
       * damage this prevents is done by the stamp. See `unsupported` on the report for
       * the window it closes; the short version is that a newer release can write a kind
       * an older dispatcher has no template for, `botctl rollback` never restores the
       * database, and the old code stamped the row before discovering it could not
       * render it — leaving the reaper to resolve a message that was never sent.
       *
       * Deferred rather than failed, and by the ordinary backoff: nothing is wrong with
       * the row. A replica that knows the kind claims it on a later pass, and until one
       * exists the row waits instead of being spent.
       *
       * The `in` check is a RUNTIME one although `row.kind` is typed. The type says what
       * this build's contract declares; the row says what some build wrote.
       */
      if (!(row.kind in CUSTOMER_NOTIFICATION_TEMPLATES)) {
        const at = this.deps.clock.now();
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.deferUntil(
            scope,
            row.id,
            new Date(at.getTime() + CUSTOMER_NOTIFICATION_BACKOFF_MS),
            at,
            tx,
          ),
        );
        return 'unsupported';
      }

      /*
       * The precondition, re-checked AFTER the claim and before the send.
       *
       * ADR 0030 §3: staleness is per-kind, not a TTL column. Seven of the eight kinds
       * are terminal facts and are never asked; the eighth — "your service is taking
       * longer than expected" — is false the moment the service is ACTIVE, and arriving
       * a second after the subscription link would be worse than not arriving.
       *
       * `SUPERSEDED` rather than `DELIVERED` or `FAILED`, because it is neither: nothing
       * was sent and nothing went wrong.
       */
      if (CUSTOMER_NOTIFICATION_PRECONDITIONS[row.kind]) {
        const holds = await this.deps.subjects.stillHolds(
          scope,
          row.kind,
          row.subjectId,
          this.deps.clock.now(),
        );
        if (!holds) {
          const at = this.deps.clock.now();
          await this.deps.uow.run(scope, async (tx) =>
            this.deps.notifications.record(
              scope,
              row.id,
              'SUPERSEDED',
              { resolvedAt: at, nextAttemptAt: null },
              at,
              tx,
            ),
          );
          return 'superseded';
        }
      }

      /*
       * Quiet hours (HF-A9): a REMINDER claimed inside the tenant's window is held until the
       * window ends — never dropped, never duplicated, never sent at night.
       *
       * Here, at DISPATCH, rather than in each producer, because this is the one place every
       * reminder passes: the service sweep, the wallet sweep and the pending-payment sweep
       * all enqueue and never send, so one check covers all eleven kinds and any added later
       * that `CUSTOMER_NOTIFICATION_QUIET_HOURS` marks. It also covers a reminder queued
       * BEFORE the window that only becomes due inside it — held back by a rate limit, a
       * retry backoff or a stopped worker — which a producer-side check could not see.
       *
       * Held by `holdUntil` — the lane's own "back on the queue, no attempt spent", plus the
       * mark that lets a later pass release it early if the window is shortened or switched
       * off (`releaseQuietHolds`, above): the same row, still `PENDING`, with
       * `next_attempt_at` at the window's end. Nothing is
       * inserted, so `customer_notifications_subject_key` still names exactly one row per
       * fact; the producers' own keys (`service_reminders`, `wallet_threshold_alerts`, the
       * subject key on a payment or order) are untouched, so a later sweep inside the window
       * finds the fact already raised and raises nothing.
       *
       * AFTER the precondition, so a reminder that is already stale is resolved SUPERSEDED
       * now rather than held for hours first; and the precondition runs again when the held
       * row is claimed at the window's end — every kind held here declares one — so a
       * service renewed, a payment settled, an order cancelled or a wallet topped up while
       * it waited is superseded then, not sent. BEFORE the stamp, like every other
       * put-back, because the stamp is what makes an unsent message look sent.
       */
      if (quiet !== null && CUSTOMER_NOTIFICATION_QUIET_HOURS[row.kind]) {
        const at = this.deps.clock.now();
        const until = quiet.quietUntil(at);
        if (until !== null) {
          await this.deps.uow.run(scope, async (tx) =>
            this.deps.notifications.holdUntil(scope, row.id, until, tx),
          );
          return 'quietHours';
        }
      }

      const lookup = await this.deps.contacts.contactFor(scope, row.customerId);
      /*
       * A BLOCKED customer is a PAUSE, not a failure — and the two used to disagree.
       *
       * `claimDue` excludes a blocked customer AT THE QUERY, and its comment argues the
       * case at length: burning an attempt would punish a customer for a moderation
       * decision that may be reversed. A block that commits between that query and this
       * lookup is the SAME situation, and recording it `FAILED` made it permanent —
       * only `PENDING` rows are claimable, so unblocking could never resume delivery.
       * One rule decided by a race, which is what the Codex review of PR #30 found.
       *
       * Deferred by a backoff rather than released immediately, because the block is
       * very unlikely to be reversed within one tick and a row that returns every tick
       * crowds out messages that could be delivered.
       */
      if (lookup.kind === 'BLOCKED') {
        const at = this.deps.clock.now();
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.deferUntil(
            scope,
            row.id,
            new Date(at.getTime() + CUSTOMER_NOTIFICATION_BACKOFF_MS),
            at,
            tx,
          ),
        );
        return 'blocked';
      }
      if (lookup.kind !== 'CONTACT') {
        /*
         * No chat at all. Terminal, and it spends the row rather than looping.
         *
         * Distinct from the block above: there is no destination to reach rather than a
         * decision to reverse, and re-claiming such a row on every tick would crowd out
         * messages that could be delivered.
         */
        const at = this.deps.clock.now();
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.record(
            scope,
            row.id,
            'FAILED',
            { resolvedAt: at, nextAttemptAt: null },
            at,
            tx,
          ),
        );
        return 'unreachable';
      }

      /*
       * The figures, read BEFORE the stamp.
       *
       * Before, because a reminder whose subject cannot be read is a message this pass
       * must not send, and the stamp is the thing that makes an unsent message look
       * sent. The order is the same one the unsupported-kind check above is placed for,
       * and for the same reason.
       */
      const content = await this.contentOf(scope, row);
      if (content === null) {
        /*
         * A reminder naming a row that is not there.
         *
         * `service_reminders` is never deleted by the product, so this is either a
         * restore that landed between the enqueue and the send, or a bug. Either way
         * the sentence would have an empty service name in it, and an empty name is
         * worse than silence: the customer cannot tell which of their services it is
         * about. FAILED rather than deferred, because nothing will bring the row back.
         */
        const at = this.deps.clock.now();
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.record(
            scope,
            row.id,
            'FAILED',
            { resolvedAt: at, nextAttemptAt: null },
            at,
            tx,
          ),
        );
        return 'errored';
      }

      /*
       * The stamp, committed BEFORE the send and in a transaction holding nothing else.
       *
       * A crash must not roll it back: the crash is the case it records. `false` means
       * another pass moved the row first, and this caller must send nothing.
       */
      const started = await this.deps.uow.run(scope, async (tx) =>
        this.deps.notifications.markSendStarted(scope, row.id, this.deps.clock.now(), tx),
      );
      if (!started) return 'lost';

      /*
       * R2 (item 11): the renewal's payment message is closed FIRST, so the result that
       * follows is its own new message after a closed one — never an edit of the invoice, and
       * never a message beside a payment screen still offering to pay.
       */
      if (content.closesOrder !== undefined && this.deps.orderScreens !== undefined) {
        try {
          await this.deps.orderScreens.close(scope, content.closesOrder);
        } catch (error: unknown) {
          this.deps.logger.error(
            { err: error instanceof Error ? error.name : 'unknown', notificationId: row.id },
            'renewal payment screen could not be closed',
          );
        }
      }

      /*
       * HF-A7: a kind that carries a FILE goes up as one upload, its template the caption.
       * Still ONE Telegram request for one row, so the outcome below means exactly what it
       * means for text — including that an UNKNOWN upload is never sent again.
       */
      const result =
        content.file === undefined
          ? await this.deps.messenger.send(scope, {
              chatId: lookup.contact.chatId,
              botInstanceId: row.botInstanceId,
              templateKey: CUSTOMER_NOTIFICATION_TEMPLATES[row.kind],
              values: content.values,
              // Absent rather than empty: Telegram draws an empty keyboard as a blank attachment.
              ...(content.buttons.length === 0 ? {} : { buttons: content.buttons }),
            })
          : await this.deps.messenger.sendFile(scope, {
              chatId: lookup.contact.chatId,
              botInstanceId: row.botInstanceId,
              kind: content.file.kind,
              source: {
                kind: 'BYTES',
                bytes: content.file.bytes,
                fileName: content.file.fileName,
                mimeType: content.file.mimeType,
              },
              caption: {
                templateKey: CUSTOMER_NOTIFICATION_TEMPLATES[row.kind],
                values: content.values,
              },
              ...(content.buttons.length === 0 ? {} : { buttons: content.buttons }),
            });

      const at = this.deps.clock.now();

      /*
       * A rate limit: back on the queue, at Telegram's own time, with NO attempt spent.
       *
       * ADR 0030 §2. The attempt ceiling bounds definite refusals OF THIS MESSAGE, and
       * three bursts would otherwise fail a message Telegram never rejected on its
       * merits — in exactly the conditions that produce bursts.
       */
      if (result.outcome === 'RATE_LIMITED') {
        // The LATER of Telegram's retry_after and the lane's own back-off (WP20, brief
        // §3.1): never before Telegram asked, and never a zero-delay retry.
        const retryAt = new Date(
          at.getTime() + Math.max(result.retryAfterMs ?? 0, CUSTOMER_NOTIFICATION_BACKOFF_MS),
        );
        await this.deps.uow.run(scope, async (tx) =>
          this.deps.notifications.deferUntil(scope, row.id, retryAt, at, tx),
        );
        return 'rateLimited';
      }

      const attemptsAfter = row.attempts + 1;
      const to =
        result.outcome === 'DELIVERED'
          ? 'DELIVERED'
          : result.outcome === 'UNKNOWN'
            ? 'UNCONFIRMED'
            : attemptsAfter >= CUSTOMER_NOTIFICATION_MAX_ATTEMPTS
              ? 'FAILED'
              : 'PENDING';

      const recorded = await this.deps.uow.run(scope, async (tx) => {
        const moved = await this.deps.notifications.record(
          scope,
          row.id,
          to,
          {
            resolvedAt: to === 'PENDING' ? null : at,
            nextAttemptAt:
              to === 'PENDING' ? new Date(at.getTime() + CUSTOMER_NOTIFICATION_BACKOFF_MS) : null,
          },
          at,
          tx,
        );
        /*
         * HF-A7: a delivered file's handle is stamped and its staged bytes cleared in THIS
         * transaction, so "delivered" and "the bytes are gone" commit together. A delivery
         * whose answer carried no readable handle keeps the bytes until the retention sweep.
         */
        if (
          moved &&
          to === 'DELIVERED' &&
          content.file !== undefined &&
          result.file !== undefined &&
          this.deps.tickets !== undefined
        ) {
          await this.deps.tickets.attachmentDelivered(scope, row.subjectId, result.file, at, tx);
        }
        return moved;
      });
      if (!recorded) return 'lost';

      return to === 'DELIVERED'
        ? 'delivered'
        : to === 'UNCONFIRMED'
          ? 'unconfirmed'
          : to === 'FAILED'
            ? 'failed'
            : 'pending';
    } catch (error: unknown) {
      /*
       * The lease stands and the row comes back later.
       *
       * Deliberately NOT recorded as an attempt: nothing was observed about the message.
       * One bad row must not take the pass down either, which is why this is per-row.
       */
      this.deps.logger.error(
        { err: error, notificationId: row.id, kind: row.kind },
        'customer notification send failed',
      );
      return 'errored';
    }
  }
}
