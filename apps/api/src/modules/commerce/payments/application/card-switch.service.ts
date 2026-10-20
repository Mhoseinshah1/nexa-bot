import {
  COMMERCE_ERROR_CODES,
  errors,
  paymentIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PaymentId,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  PaymentAccountRecord,
  PaymentDestinationRecord,
  PaymentDestinationRepository,
} from './account-ports.js';
import type { PaymentReceiptRepository } from './receipt-ports.js';
import type { ManualTransferInstruction } from './payment.service.js';
import type { PaymentRecord, PaymentRepository } from './ports.js';

/**
 * R4 A1 — «🔄 تغییر شماره کارت» on the card-to-card invoice.
 *
 * Pressing it shows the customer ANOTHER enabled receiving card on the same invoice. The
 * payment, its amount, its tracking code and its deadline are untouched: nothing here moves
 * money or changes a payment's state. What it does change is WHERE the customer was told to
 * send the money, so the card shown is frozen on the payment (`payment_destination_switches`,
 * append-only) and every reader of the payment's destination — the invoice, the receipt
 * reviewer, the operator's payment detail — reads the card shown LAST.
 *
 * The permission is the customer's own payment key (`maintenance.run`, `PAYMENT_PLACE`): the
 * Telegram surface acts as `SYSTEM_JOB`, and the payment is re-read by id AND owner.
 */
export const CARD_SWITCH_PERMISSION = 'maintenance.run' satisfies PermissionKey;
export const CARD_SWITCH_LIMIT_SETTING = 'payments.card_switch_limit' as const;

/** The surface a customer's tap arrives through. */
const CUSTOMER_NAMESPACE = 'TELEGRAM' as const;

/**
 * The card a press shows, decided from the tenant's ENABLED accounts in their render order
 * `(sort_order, created_at, id)` — the order `PaymentAccountRepository.list` returns.
 *
 * Pure. The next card after the one shown now, wrapping round to the first, and never the
 * one shown now: two enabled cards alternate, three rotate A → B → C → A. A card shown now
 * that has since been DISABLED is no longer in the list, so the rotation starts again from
 * the first enabled card. Null when no other enabled card exists — the button is not drawn.
 */
export function nextReceivingCard(
  enabled: readonly PaymentAccountRecord[],
  currentAccountId: string | null,
): PaymentAccountRecord | null {
  const others = enabled.filter((account) => account.id !== currentAccountId);
  if (others.length === 0) return null;
  const at = enabled.findIndex((account) => account.id === currentAccountId);
  if (at === -1) return others[0] ?? null;
  return enabled[(at + 1) % enabled.length] ?? null;
}

/**
 * Whether the button may be drawn on this payment's invoice, decided from the same facts the
 * press re-decides under the lock. A courtesy; never trusted.
 */
export interface CardSwitchOffer {
  readonly offered: boolean;
  /** The switches already recorded: the tap carries it, so a second tap of the same keyboard switches nothing. */
  readonly sequence: number;
}

export type CardSwitchResult =
  /** A new card was recorded and is the one to show. */
  | {
      readonly outcome: 'SWITCHED';
      readonly instruction: ManualTransferInstruction;
      readonly sequence: number;
    }
  /**
   * Nothing was switched, and the invoice is redrawn as it stands: a second tap of the same
   * keyboard or a redelivered update (`STALE`), the press limit reached (`LIMIT`), no other
   * enabled card (`NO_OTHER_CARD`).
   */
  | {
      readonly outcome: 'UNCHANGED';
      readonly reason: 'STALE' | 'LIMIT' | 'NO_OTHER_CARD';
      readonly instruction: ManualTransferInstruction;
      readonly sequence: number;
    }
  /**
   * The payment is no longer an open card-to-card invoice — ended, past its window, claimed
   * as sent, or with a receipt filed: nothing is switched. `instruction` is the invoice as it
   * stands for a payment still PENDING (so it can be redrawn without the button), else null.
   */
  | {
      readonly outcome: 'NOT_SWITCHABLE';
      readonly payment: PaymentRecord;
      readonly instruction: ManualTransferInstruction | null;
    };

export interface CardSwitchServiceDeps {
  readonly payments: Pick<PaymentRepository, 'findById' | 'findByIdForUpdate'>;
  readonly accounts: {
    list(scope: TenantContext, tx?: unknown): Promise<readonly PaymentAccountRecord[]>;
  };
  readonly destinations: Pick<
    PaymentDestinationRepository,
    'findByPayment' | 'switchCount' | 'recordSwitch'
  >;
  readonly receipts: Pick<PaymentReceiptRepository, 'countForPayment'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class CardSwitchService {
  constructor(private readonly deps: CardSwitchServiceDeps) {}

  /**
   * Whether the invoice of this payment draws the button, and the sequence its tap carries.
   * Read-only; the press decides everything again under the payment's lock.
   */
  async offer(scope: TenantContext, payment: PaymentRecord): Promise<CardSwitchOffer> {
    const sequence = await this.deps.destinations.switchCount(scope, payment.id);
    if (!this.switchable(payment, this.deps.clock.now())) return { offered: false, sequence };
    const current = await this.deps.destinations.findByPayment(scope, payment.id);
    if (current === null) return { offered: false, sequence };
    const limit = await this.limit(scope);
    if (limit > 0 && sequence >= limit) return { offered: false, sequence };
    const enabled = (await this.deps.accounts.list(scope)).filter((account) => account.enabled);
    const next = nextReceivingCard(enabled, current.accountId);
    if (next === null) return { offered: false, sequence };
    if ((await this.deps.receipts.countForPayment(scope, payment.id, undefined)) > 0) {
      return { offered: false, sequence };
    }
    return { offered: true, sequence };
  }

  /**
   * One press. `expectedSequence` is the sequence the tapped keyboard was drawn at; the switch
   * is recorded as `expectedSequence + 1` only while that is still the payment's count, under
   * the payment's row lock — so two taps of one keyboard record ONE switch, and the card
   * recorded is exactly the card the answer shows.
   */
  async switchCard(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly idempotencyKey: string;
      readonly paymentId: string;
      readonly expectedSequence: number;
    },
  ): Promise<CardSwitchResult> {
    const paymentId = this.paymentId(input.paymentId);
    const denial = {
      action: 'payment.destination_switch',
      entityType: 'Payment',
      entityId: paymentId as string,
    };
    await this.deps.guard.check(scope, actor, CARD_SWITCH_PERMISSION);

    const requestHash = hashRequest({
      paymentId,
      customerId,
      expectedSequence: input.expectedSequence,
    });
    const replay = await this.deps.idempotency.find<{ sequence: number }>(
      scope,
      CUSTOMER_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      /*
       * One Telegram update delivered twice: answer with what is shown now, write nothing.
       * The invoice is judged again by the SAME rule the locked path applies — a redelivery
       * after the window closed, the payment ended or a receipt was filed is NOT_SWITCHABLE,
       * so the redrawn invoice never offers the button again.
       */
      const payment = await this.deps.payments.findById(scope, paymentId);
      if (payment === null || payment.customerId !== customerId) throw this.notFound();
      const destination = await this.deps.destinations.findByPayment(scope, paymentId);
      const closed = await this.closedInvoice(scope, payment, destination, this.deps.clock.now());
      if (closed !== null) return closed;
      return {
        outcome: 'UNCHANGED',
        reason: 'STALE',
        instruction: { payment, destination },
        sequence: await this.deps.destinations.switchCount(scope, paymentId),
      };
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      CARD_SWITCH_PERMISSION,
      denial,
      async (tx): Promise<CardSwitchResult> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        /*
         * The payment's row lock FIRST — the lock a receipt, a withdrawal and a confirmation
         * take — so a switch cannot interleave with a receipt filed against the old card, and
         * two presses are serialised before either counts.
         */
        const payment = await this.deps.payments.findByIdForUpdate(scope, paymentId, tx);
        if (payment === null || payment.customerId !== customerId) throw this.notFound();
        const remember = async (sequence: number): Promise<void> =>
          rememberOnce(
            this.deps.idempotency,
            scope,
            CUSTOMER_NAMESPACE,
            input.idempotencyKey,
            requestHash,
            { sequence },
            tx,
          );
        const current = await this.deps.destinations.findByPayment(scope, paymentId, tx);
        const sequence = await this.deps.destinations.switchCount(scope, paymentId, tx);
        const closed = await this.closedInvoice(scope, payment, current, now, tx);
        if (closed !== null || current === null) {
          await remember(sequence);
          return closed ?? this.notSwitchable(payment, current);
        }
        const unchanged = async (
          reason: 'STALE' | 'LIMIT' | 'NO_OTHER_CARD',
        ): Promise<CardSwitchResult> => {
          await remember(sequence);
          return {
            outcome: 'UNCHANGED',
            reason,
            instruction: { payment, destination: current },
            sequence,
          };
        };
        // A second tap of a keyboard drawn before the last switch: the customer is shown the
        // card recorded now, and nothing is switched twice.
        if (sequence !== input.expectedSequence) return unchanged('STALE');
        const limit = await this.limit(scope, tx);
        if (limit > 0 && sequence >= limit) return unchanged('LIMIT');
        const enabled = (await this.deps.accounts.list(scope, tx)).filter(
          (account) => account.enabled,
        );
        const next = nextReceivingCard(enabled, current.accountId);
        if (next === null) return unchanged('NO_OTHER_CARD');

        const recorded = await this.deps.destinations.recordSwitch(
          scope,
          {
            id: this.deps.ids.uuid(),
            paymentId,
            sequence: sequence + 1,
            fromAccountId: current.accountId,
            account: next,
            now,
          },
          tx,
        );
        // Under the lock the count cannot have moved; the unique key is the backstop.
        if (recorded === null) return unchanged('STALE');

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'payment.destination_switch',
            entityType: 'Payment',
            entityId: paymentId,
            before: { accountId: current.accountId, sequence },
            after: {
              accountId: recorded.accountId,
              sequence: sequence + 1,
              cardLast4: recorded.cardNumber.slice(-4),
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await remember(sequence + 1);
        return {
          outcome: 'SWITCHED',
          instruction: { payment, destination: recorded },
          sequence: sequence + 1,
        };
      },
    );
  }

  /**
   * The one rule both the locked press and a replayed one apply: NOT_SWITCHABLE when no card
   * was recorded, the invoice is no longer open, or a receipt has been filed; else null.
   */
  private async closedInvoice(
    scope: TenantContext,
    payment: PaymentRecord,
    current: PaymentDestinationRecord | null,
    now: Date,
    tx?: TransactionScope,
  ): Promise<CardSwitchResult | null> {
    if (
      current === null ||
      !this.switchable(payment, now) ||
      (await this.deps.receipts.countForPayment(scope, payment.id, tx)) > 0
    ) {
      return this.notSwitchable(payment, current);
    }
    return null;
  }

  private notSwitchable(
    payment: PaymentRecord,
    current: PaymentDestinationRecord | null,
  ): CardSwitchResult {
    return {
      outcome: 'NOT_SWITCHABLE',
      payment,
      instruction:
        payment.state === 'PENDING' && payment.method === 'MANUAL_TRANSFER'
          ? { payment, destination: current }
          : null,
    };
  }

  /**
   * An open card-to-card invoice: PENDING, a manual transfer, inside its own window, and not
   * yet claimed as sent. A payment the customer has said they paid is past the invoice — the
   * money went to the card they were shown, and changing it now would make the reviewer
   * compare the statement against the wrong card.
   */
  private switchable(payment: PaymentRecord, now: Date): boolean {
    return (
      payment.state === 'PENDING' &&
      payment.method === 'MANUAL_TRANSFER' &&
      payment.customerSignalledAt === null &&
      payment.expiresAt !== null &&
      payment.expiresAt.getTime() > now.getTime()
    );
  }

  private async limit(scope: TenantContext, tx?: TransactionScope): Promise<number> {
    return this.deps.settings.valueOf<number>(scope, CARD_SWITCH_LIMIT_SETTING, tx);
  }

  private paymentId(raw: string): PaymentId {
    const parsed = paymentIdSchema.safeParse(raw);
    if (!parsed.success) throw this.notFound();
    return parsed.data;
  }

  private notFound(): Error {
    return errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
  }
}
