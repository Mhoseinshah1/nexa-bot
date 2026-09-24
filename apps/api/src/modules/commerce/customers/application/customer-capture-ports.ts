import type {
  BotInstanceId,
  CustomerCaptureCloseReason,
  CustomerCapturePurpose,
  CustomerCaptureState,
  Money,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/**
 * A customer's open plain-text window (customer UX completion §N).
 *
 * One table with a PURPOSE, following `admin_amount_captures`: what the customer's next
 * message is being read FOR is a fact on the row, checked before the message is
 * consumed. INCIDENT-FIN-001 is a prompt that had outlived its question reading a
 * navigation label as a setting; the deadline, the purpose and the one-open-row index
 * are the three things that stop it here.
 */
export interface CustomerCaptureRecord {
  readonly id: string;
  readonly botInstanceId: BotInstanceId;
  readonly customerId: UserId;
  readonly purpose: CustomerCapturePurpose;
  /** The service a note is for. Null for the other purposes, by CHECK. */
  readonly subjectId: string | null;
  readonly state: CustomerCaptureState;
  /** The typed and validated top-up amount, once recorded. Null until then. */
  readonly amount: Money | null;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly closedAt: Date | null;
  readonly closeReason: CustomerCaptureCloseReason | null;
}

export interface CustomerCaptureRepository {
  /**
   * Serialises every reader and writer of one customer's window on one bot, so two
   * messages arriving together are offered to one question once.
   */
  lockForCustomer(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx: unknown,
  ): Promise<void>;

  /** Closes any open window of the customer's (SUPERSEDED, or EXPIRED if past due) and opens this one. */
  open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly purpose: CustomerCapturePurpose;
      readonly subjectId: string | null;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<CustomerCaptureRecord>;

  /** The customer's open window on this bot, whatever its purpose or state. */
  findOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerCaptureRecord | null>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<CustomerCaptureRecord | null>;

  /** `AWAITING_TEXT → AMOUNT_RECORDED`, conditional. False when the window moved on. */
  recordAmount(scope: TenantContext, id: string, amount: Money, tx: unknown): Promise<boolean>;

  /** Conditional on still being open. False when something closed it first. */
  close(
    scope: TenantContext,
    id: string,
    reason: CustomerCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Closes the customer's open window, if any, as SUPERSEDED. For the ORDER windows
   * (username, discount code) to call when they open, so the most recent prompt is
   * the only reader across all three tables.
   */
  closeOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    at: Date,
    tx: unknown,
  ): Promise<void>;
}

/**
 * The other two customer windows — username and discount code — as one operation,
 * so opening a capture here supersedes them without this module depending on orders.
 */
export interface CustomerWindowSuperseder {
  closeOpenFor(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    at: Date,
    tx: unknown,
  ): Promise<void>;
}
