import {
  COMMERCE_ERROR_CODES,
  errors,
  isNexaError,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { recordMutationDenial } from '../../../platform/access/application/authorized-mutation.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import {
  MANUAL_ORDER_WALLET_SETTLEMENT,
  type PaymentService,
} from '../../payments/application/payment.service.js';
import type { PaymentRecord } from '../../payments/application/ports.js';
import { MANUAL_ORDER_AUTHORITY, type OrderService } from './order.service.js';
import type { OrderRecord } from './ports.js';

export const MANUAL_ORDER_PERMISSION: PermissionKey = 'orders.manual.create';
/** A manual order spends the customer's wallet, so it needs the key a direct debit needs. */
export const WALLET_DEBIT_PERMISSION: PermissionKey = 'users.wallet.debit';
const CUSTOMER_VIEW: PermissionKey = 'users.view';

export interface ManualOrderDeps {
  readonly orders: Pick<
    OrderService,
    'createDraft' | 'chooseUsername' | 'confirm' | 'cancelByCustomer'
  >;
  readonly payments: Pick<PaymentService, 'settleFromWallet'>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
}

/**
 * An operator placing an order for a customer (Customer 360, §11.6).
 *
 * Not a second order path: the customer's own four commands, run in sequence under
 * `MANUAL_ORDER_AUTHORITY` — `orders.manual.create` in the operator's `WEB` namespace —
 * so the draft is priced by `PricingService.price` with the customer's own rules and
 * reseller standing, the confirmation reserves the capacity slot and the username and
 * honours the quote, and the money is a `PURCHASE` debit of the customer's wallet through
 * `PaymentService.settleFromWallet`. The provisioner then creates the service exactly as
 * it does for any paid order.
 *
 * Resumable and idempotent: each step's key is derived from the operator's key, so a retry
 * after a timeout replays the steps already taken and carries on from the first that was
 * not. A wallet that cannot fund the order is refused, never put on credit nobody granted,
 * and the confirmed order is CANCELLED in the same command — releasing its slot and name —
 * so nothing is left awaiting a payment the customer never chose to make.
 */
export class ManualOrderService {
  constructor(private readonly deps: ManualOrderDeps) {}

  async place(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly productId: string;
      readonly username: string | null;
      readonly reason: string;
    },
  ): Promise<{ readonly order: OrderRecord; readonly payment: PaymentRecord }> {
    const parsed = userIdSchema.safeParse(input.customerId);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    const customerId = parsed.data;
    const denial = {
      action: 'customer.manual_order',
      entityType: 'Customer',
      entityId: customerId,
    };
    /*
     * `users.wallet.debit` as well (review of the Customer 360 branch): a manual order spends
     * the customer's wallet, and `orders.manual.create` alone — held by the seeded `sales`
     * role — must not be a way to debit a wallet that role could not debit directly. Checked
     * here, before any order exists, and again inside the settling transaction.
     */
    for (const permission of [CUSTOMER_VIEW, MANUAL_ORDER_PERMISSION, WALLET_DEBIT_PERMISSION]) {
      try {
        await this.deps.guard.check(scope, actor, permission);
      } catch (error) {
        await recordMutationDenial(
          { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
          scope,
          actor,
          permission,
          denial,
          error,
        );
        throw error;
      }
    }
    const reason = input.reason.trim();
    if (reason === '') {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A manual order needs a reason.',
      );
    }
    const username = input.username?.trim() ?? '';
    // One stem per command, bounded whatever the operator's key looked like.
    const stem = `manual:${hashRequest({ key: input.idempotencyKey }).slice(0, 40)}`;

    const draft = await this.deps.orders.createDraft(
      scope,
      actor,
      { idempotencyKey: `${stem}:draft`, customerId, productId: input.productId },
      MANUAL_ORDER_AUTHORITY,
    );
    if (username !== '') {
      await this.deps.orders.chooseUsername(
        scope,
        actor,
        {
          idempotencyKey: `${stem}:username`,
          customerId,
          orderId: draft.id,
          choice: { mode: 'CUSTOM', raw: username },
        },
        MANUAL_ORDER_AUTHORITY,
      );
    }
    const confirmed = await this.deps.orders.confirm(
      scope,
      actor,
      { idempotencyKey: `${stem}:confirm`, customerId, orderId: draft.id },
      MANUAL_ORDER_AUTHORITY,
    );

    let settled: { readonly payment: PaymentRecord; readonly order: OrderRecord };
    try {
      settled = await this.deps.payments.settleFromWallet(
        scope,
        actor,
        customerId,
        { idempotencyKey: `${stem}:settle`, orderId: confirmed.id },
        {
          ...MANUAL_ORDER_WALLET_SETTLEMENT,
          /*
           * In the settling transaction: the debit permission decided again where the money
           * moves, and the customer's own audit row committed with the settlement — so a
           * replay, which never reaches this transaction, adds no second row.
           */
          inTransaction: async (tx, done) => {
            await this.deps.guard.check(scope, actor, WALLET_DEBIT_PERMISSION, tx);
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: 'customer.manual_order',
                entityType: 'Customer',
                entityId: customerId,
                before: null,
                after: {
                  orderId: done.order.id,
                  paymentId: done.payment.id,
                  productId: input.productId,
                  totalMinor: done.order.totals.total.amountMinor.toString(),
                  currency: done.order.totals.currency,
                },
                result: 'SUCCESS',
                reason,
              },
              tx,
            );
          },
        },
      );
    } catch (error) {
      // A refusal (a 4xx) rolled back with nothing debited: withdraw the order it was for.
      // Anything else may have committed, so the order is left for the retry to replay.
      if (isRefusal(error)) {
        await this.deps.orders.cancelByCustomer(
          scope,
          actor,
          { idempotencyKey: `${stem}:cancel`, customerId, orderId: confirmed.id },
          MANUAL_ORDER_AUTHORITY,
        );
      }
      throw error;
    }
    return settled;
  }
}

/** A decided refusal: a 4xx the server chose, never a transport failure or a 5xx. */
function isRefusal(error: unknown): boolean {
  return isNexaError(error) && error.httpStatus >= 400 && error.httpStatus < 500;
}
