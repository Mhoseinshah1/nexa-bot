import type {
  AdminAmountCaptureCloseReason,
  AdminCapturePurpose,
  BotInstanceId,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';

/**
 * One administrator's amount capture for one receipt (`admin_amount_captures`, 0115).
 *
 * `amountMinor` is null until the administrator has typed an amount, and is set once. The
 * CURRENCY is deliberately absent: it is the payment's, read from the payment whenever the
 * amount is used, so there is no second copy to disagree with it.
 */
export interface AdminAmountCaptureRecord {
  readonly id: string;
  readonly botInstanceId: BotInstanceId;
  readonly adminId: string;
  readonly paymentId: PaymentId;
  /** What the capture reads: the credit's amount, or a block's or rejection's reason. */
  readonly purpose: AdminCapturePurpose;
  readonly amountMinor: bigint | null;
  /** The block's or rejection's reason, trimmed, once typed. Null for a credit capture. */
  readonly reason: string | null;
  readonly openedAt: Date;
  readonly expiresAt: Date;
  readonly closedAt: Date | null;
  readonly closeReason: AdminAmountCaptureCloseReason | null;
}

export interface AdminAmountCaptureRepository {
  /**
   * Serialises one administrator's capture work on one bot, for the transaction.
   *
   * The partial unique index already refuses two open rows; the lock is what turns two
   * messages arriving together into one reading and one "no capture", instead of a
   * unique-violation surfaced as a 500.
   */
  lockForAdmin(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    tx: unknown,
  ): Promise<void>;

  /** Closes this administrator's open capture on this bot as SUPERSEDED, then opens one. */
  open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: BotInstanceId;
      readonly adminId: string;
      readonly paymentId: PaymentId;
      /** Defaults to the credit's amount, the purpose every existing caller opens. */
      readonly purpose?: AdminCapturePurpose;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<AdminAmountCaptureRecord>;

  /**
   * This administrator's open reason capture OF THIS PURPOSE on this bot that has not read its
   * reason yet. Keyed by purpose, as `findAwaitingAmount` is: a message is offered to exactly
   * the prompt that asked for it.
   */
  findAwaitingReason(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    purpose: 'RECEIPT_BLOCK_REASON' | 'RECEIPT_REJECT_REASON',
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null>;

  /** Sets the reason ONCE, on an open reason capture that has none. */
  recordReason(scope: TenantContext, id: string, reason: string, tx: unknown): Promise<boolean>;

  /**
   * The open capture still WAITING for an amount, for this administrator on this bot.
   *
   * A capture that already holds an amount is not returned: it reads one message, and a
   * second number typed after the confirmation was drawn must not change what the confirm
   * button confirms.
   */
  findAwaitingAmount(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    adminId: string,
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null>;

  findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<AdminAmountCaptureRecord | null>;

  /** Sets the amount of an OPEN capture that has none. False when it no longer qualifies. */
  recordAmount(
    scope: TenantContext,
    id: string,
    amountMinor: bigint,
    tx: unknown,
  ): Promise<boolean>;

  /** Closes an OPEN capture. False when it was already closed — by another tap, say. */
  close(
    scope: TenantContext,
    id: string,
    reason: AdminAmountCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
}
