import type {
  PaymentAccountId,
  PaymentDestinationSnapshot,
  PaymentId,
  TenantContext,
} from '@nexa/contracts';

/**
 * One configured destination, as the application layer holds it.
 *
 * The record an operator edits. `PaymentDestinationSnapshot` is the other half — the
 * frozen copy a payment keeps — and it is deliberately a NARROWER shape: it has no id,
 * no `enabled`, no ordering and no `isDefault`, because those are the tenant's current
 * disposition and a snapshot that carried them would answer a question nobody asks and
 * change meaning the moment the configuration does.
 */
export interface PaymentAccountRecord {
  readonly id: PaymentAccountId;
  readonly label: string;
  readonly bankName: string;
  readonly holderName: string;
  readonly cardNumber: string;
  readonly iban: string | null;
  readonly enabled: boolean;
  readonly isDefault: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields an operator supplies. Normalised by `paymentAccountInputSchema` already. */
export interface PaymentAccountFields {
  readonly label: string;
  readonly bankName: string;
  readonly holderName: string;
  readonly cardNumber: string;
  readonly iban: string | null;
  readonly sortOrder: number;
}

export interface PaymentAccountRepository {
  /**
   * EVERY account this tenant has, in render order, with no cursor.
   *
   * The one repository list in this codebase that does not page, and
   * `PAYMENT_ACCOUNT_MAX_PER_TENANT` is what makes that honest: the create path refuses
   * past the bound, so the list is complete by construction. A paginated configuration
   * screen silently omits the row an operator is looking for.
   */
  list(scope: TenantContext, tx?: unknown): Promise<readonly PaymentAccountRecord[]>;

  findById(
    scope: TenantContext,
    id: PaymentAccountId,
    tx?: unknown,
  ): Promise<PaymentAccountRecord | null>;

  /**
   * Serialises this tenant's account CREATES against each other, and nothing else.
   *
   * `PAYMENT_ACCOUNT_MAX_PER_TENANT` is enforced by counting and then inserting, and
   * under READ COMMITTED two creates at the ceiling both read the same count and both
   * commit — the owner's decision on Codex C8 is that the invariant holds rather than
   * being documented as raceable.
   *
   * An ADVISORY lock rather than a row lock, and the choice is not a matter of taste:
   * `scopeIsActive` takes `FOR SHARE` on the tenant row inside every write transaction
   * this installation makes, and its own comment calls that "this installation's single
   * busiest row". A `FOR UPDATE` here would therefore serialise account creation behind
   * every scope-activity check in the product, and every one of those behind an
   * operator adding a bank card. The advisory lock touches no row and blocks nothing
   * but another call to this method.
   *
   * Transaction-scoped, so it is released by the commit or the rollback. There is no
   * unlock path to forget and no lock to leak on a crash, which is the property that
   * makes this safe to hold across the count and the insert.
   */
  lockForCreate(scope: TenantContext, tx: unknown): Promise<void>;

  /** How many this tenant holds, read inside the create transaction. */
  count(scope: TenantContext, tx: unknown): Promise<number>;

  create(
    scope: TenantContext,
    input: {
      readonly id: PaymentAccountId;
      readonly fields: PaymentAccountFields;
      readonly enabled: boolean;
      readonly isDefault: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentAccountRecord>;

  /**
   * The account's own fields, and NOTHING about its disposition.
   *
   * `enabled` and `is_default` are not in the UPDATE's column list, so there is no path
   * by which editing a card number also changes where money goes. Each has its own
   * command, and therefore its own audit row.
   */
  update(
    scope: TenantContext,
    id: PaymentAccountId,
    fields: PaymentAccountFields,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null>;

  /**
   * A CONDITIONAL enable/disable, naming the state it expects to move from.
   *
   * Returns null when the row is absent OR already in that state, which is what makes a
   * double-click and a replay produce one transition between them rather than two audit
   * rows describing the same change.
   */
  setEnabled(
    scope: TenantContext,
    id: PaymentAccountId,
    enabled: boolean,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null>;

  /** Clears whichever account currently holds the default. Returns its id, if any. */
  clearDefault(scope: TenantContext, now: Date, tx: unknown): Promise<PaymentAccountId | null>;

  /** Promotes one account. The partial unique index is what makes two racers safe. */
  setDefault(
    scope: TenantContext,
    id: PaymentAccountId,
    now: Date,
    tx: unknown,
  ): Promise<PaymentAccountRecord | null>;

  /**
   * The account a new manual transfer is issued against, or null.
   *
   * ONE query, so the rule has one statement: the enabled default, and failing that the
   * enabled account with the lowest `(sort_order, created_at, id)`. Written as a
   * repository method rather than a `list().find()` in the service, because the
   * ordering is an index's job and because a caller that sorted the list itself would be
   * a second definition of "the destination".
   */
  selectDestination(scope: TenantContext, tx: unknown): Promise<PaymentAccountRecord | null>;

  /**
   * Whether ANY enabled account exists.
   *
   * The read the Telegram surface needs in order not to draw a button that refuses. It
   * is deliberately not `selectDestination() !== null` at the call site: the surface has
   * no business holding a card number in order to decide whether to render a label.
   */
  hasEnabled(scope: TenantContext, tx?: unknown): Promise<boolean>;
}

/**
 * The frozen copy, written in the SAME transaction that creates the payment.
 *
 * There is no update and no delete, and not by omission: the table refuses both by
 * trigger. A destination that could be edited after issuance is the defect 5A exists to
 * remove, one layer down.
 */
/**
 * The frozen snapshot, plus the id of the account it was copied from.
 *
 * It EXTENDS `PaymentDestinationSnapshot` rather than wrapping it, so everything that
 * renders a destination keeps taking the contract's shape and this adds the one field
 * only the server needs. The customer's instructions are built from the snapshot half;
 * `accountId` reaches the reissue audit row and the operator's payment detail, and
 * neither could name the account without it.
 */
export interface PaymentDestinationRecord extends PaymentDestinationSnapshot {
  readonly accountId: PaymentAccountId;
}

export interface PaymentDestinationRepository {
  capture(
    scope: TenantContext,
    input: {
      readonly paymentId: PaymentId;
      readonly account: PaymentAccountRecord;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentDestinationRecord>;

  /**
   * What this payment's customer was told LAST, or null for one issued before 5A: the newest
   * «🔄 تغییر شماره کارت» switch (R4 A1) when there is one, else the destination it was issued
   * against. Every reader — the invoice, the receipt reviewer, the operator's payment detail —
   * therefore sees the card the customer was shown last, from one definition.
   */
  findByPayment(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<PaymentDestinationRecord | null>;

  /** How many switches this payment has had: 0 for none. The next one is `count + 1`. */
  switchCount(scope: TenantContext, paymentId: PaymentId, tx?: unknown): Promise<number>;

  /**
   * What the customer has been shown on this payment (R5C-1): the switches recorded, when the
   * last was, and every account shown — the first card included. Read under the payment's row
   * lock by the press, so the facts a limit is decided on cannot move.
   */
  switchHistory(
    scope: TenantContext,
    paymentId: PaymentId,
    tx?: unknown,
  ): Promise<PaymentSwitchHistory>;

  /**
   * Records one switch, as `sequence`, frozen from `account`. Null when that sequence is
   * already taken (`payment_destination_switches_sequence_key`): another tap won, and this
   * one switched nothing. Called under the payment's row lock.
   */
  recordSwitch(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly sequence: number;
      readonly fromAccountId: PaymentAccountId;
      readonly account: PaymentAccountRecord;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<PaymentDestinationRecord | null>;
}

/** What a payment's customer has been shown, for the card-switch limits (R5C-1). */
export interface PaymentSwitchHistory {
  /** Switches recorded: the greatest sequence, 0 for none. */
  readonly switchCount: number;
  readonly lastSwitchAt: Date | null;
  /** Every distinct account shown, the card first issued included. */
  readonly shownAccountIds: readonly string[];
}

/** One recorded switch, as the payment's history reads it (R4 A1). */
export interface PaymentDestinationSwitchRecord {
  readonly id: string;
  readonly sequence: number;
  readonly fromAccountId: PaymentAccountId;
  readonly accountId: PaymentAccountId;
  readonly cardLast4: string;
  readonly createdAt: Date;
}
