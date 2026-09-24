import type {
  AdminAmountCaptureCloseReason,
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
  readonly amountMinor: bigint | null;
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
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<AdminAmountCaptureRecord>;

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
