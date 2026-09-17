import type {
  BotInstanceId,
  PaymentId,
  PaymentReceiptId,
  PaymentReceiptKind,
  ReceiptCaptureCloseReason,
  ReceiptCaptureId,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** The window in which a file from this customer attaches to one payment. */
export interface ReceiptCaptureRecord {
  readonly id: ReceiptCaptureId;
  readonly botInstanceId: BotInstanceId;
  readonly customerId: UserId;
  readonly paymentId: PaymentId;
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

/** What Telegram told us about the file. Nothing here is trusted as a fact about money. */
export interface InboundReceiptFile {
  readonly kind: PaymentReceiptKind;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly fileName: string | null;
  readonly telegramMessageId: bigint | null;
}

export interface PaymentReceiptRecord {
  readonly id: PaymentReceiptId;
  readonly paymentId: PaymentId;
  /**
   * WHICH bot holds the file, and therefore whose token fetches it.
   *
   * A `file_id` is scoped to the bot that received it, so a tenant with two bots has
   * two token namespaces and fetching with the wrong one answers "file not found" — a
   * receipt that exists, reported as missing. The row has always had the column; this
   * is the read that needed it.
   */
  readonly botInstanceId: BotInstanceId;
  readonly customerId: UserId;
  readonly kind: PaymentReceiptKind;
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly mimeType: string | null;
  readonly fileSize: bigint | null;
  readonly fileName: string | null;
  readonly createdAt: Date;
}

export interface ReceiptCaptureRepository {
  /**
   * Serialises this CUSTOMER's receipt work on this bot, and nothing else.
   *
   * Taken by both writers before they read: the tap that opens a window, and the file
   * that fills one. Without it two things race, and both were real:
   *
   *   - two taps on two invoices from one customer each close what they can see and
   *     insert; neither sees the other's uncommitted row, so the second insert hits
   *     `receipt_captures_open_key` and the webhook swallows it — one tap gets no
   *     prompt at all, and the window that survives may name the other invoice;
   *   - two files arriving together each read the same count and each insert, so a
   *     payment can hold six receipts where the constant says five.
   *
   * The KEY is `(tenant, bot, customer)`, which is the partial unique index's key: the
   * lock protects exactly what the index constrains, so it serialises nothing wider.
   * Advisory rather than a row lock for `lockForCreate`'s reason — there is no row to
   * lock before the first window exists, and the tenant row is this installation's
   * busiest. Transaction-scoped, so the commit releases it.
   */
  lockForCustomer(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx: unknown,
  ): Promise<void>;

  /**
   * Opens a window, closing whatever this customer had open on this bot.
   *
   * Both halves in the caller's transaction, because the partial unique index refuses a
   * second open row: closing and opening cannot be two commits without a moment in which
   * the customer has none — and the tap that asked for one has already been answered.
   */
  open(
    scope: TenantContext,
    input: {
      readonly id: ReceiptCaptureId;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly paymentId: PaymentId;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<ReceiptCaptureRecord>;

  /**
   * The window this customer has open on this bot, or null.
   *
   * Keyed on the CUSTOMER and the BOT, never on a payment: what an inbound photo
   * identifies is who sent it and where, and the payment is what the window remembers.
   */
  findOpen(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx?: unknown,
  ): Promise<ReceiptCaptureRecord | null>;

  /**
   * A CONDITIONAL close naming the state it moves from.
   *
   * Returns false when the row was already closed, which is what makes two photos
   * arriving together produce one close rather than two.
   */
  close(
    scope: TenantContext,
    id: ReceiptCaptureId,
    reason: ReceiptCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
}

export interface PaymentReceiptRepository {
  /**
   * Files one receipt, or answers null when that exact file is already filed.
   *
   * Null rather than a throw, because a redelivered Telegram update is not an error and
   * the caller's answer to the customer is the same either way. The uniqueness is
   * `payment_receipts_file_key`, so two replicas racing the same redelivery produce one
   * row between them.
   */
  attach(
    scope: TenantContext,
    input: {
      readonly id: PaymentReceiptId;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly paymentId: PaymentId;
      readonly file: InboundReceiptFile;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentReceiptRecord | null>;

  /** How many this payment already holds, read inside the attaching transaction. */
  countForPayment(scope: TenantContext, paymentId: PaymentId, tx: unknown): Promise<number>;

  /** Everything filed against one payment, oldest first. The reviewer's read. */
  listForPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<readonly PaymentReceiptRecord[]>;

  /**
   * The manual transfers that hold at least one receipt and are still PENDING.
   *
   * The reviewer's QUEUE, and every predicate is in SQL on purpose: the limit has to
   * bound the MATCHING rows, or a page of ten is ten rows of which some number are
   * already decided. `docs/phase3d` records the same defect found in the management
   * scope, where a browser-side filter over a page showed nothing and paged past the
   * one row that mattered.
   *
   * Oldest FIRST, by the payment's own creation, because a queue is worked in the
   * order it arrived and the customer who has waited longest is the one to answer.
   */
  pendingForReview(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly { readonly paymentId: PaymentId; readonly held: number }[]>;

  /**
   * One receipt by id, scoped to its tenant.
   *
   * The only caller is the route that streams the bytes, and it needs `fileId` — which
   * is why that field is on the record here and absent from `PaymentReceiptView`, the
   * shape the browser receives.
   */
  findById(
    scope: TenantContext,
    id: PaymentReceiptId,
    tx?: unknown,
  ): Promise<PaymentReceiptRecord | null>;
}
