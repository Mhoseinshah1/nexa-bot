import {
  COMMERCE_ERROR_CODES,
  PAYMENT_TIMELINE_MAX_ENTRIES,
  errors,
  paymentIdSchema,
  type ActorContext,
  type PaymentTimelineSection,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { assemblePaymentTimeline, type AssembledTimeline } from '../domain/payment-timeline.js';
import { PAYMENT_VIEW_PERMISSION } from './payment.service.js';
import type { PaymentTimelineReader } from './timeline-ports.js';

/**
 * The permission that already guards each gated section's facts elsewhere. Not new keys:
 * the receipts card is `receipts.view`, the refunds card is `refunds.view`, and the
 * wallet ledger is `users.view` (`WALLET_VIEW_PERMISSION`).
 */
export const TIMELINE_SECTION_PERMISSIONS: Readonly<Record<PaymentTimelineSection, PermissionKey>> =
  {
    RECEIPTS: 'receipts.view' as PermissionKey,
    REFUNDS: 'refunds.view' as PermissionKey,
    WALLET: 'users.view' as PermissionKey,
  };

export interface PaymentTimelineServiceDeps {
  readonly guard: PermissionGuard;
  readonly reader: PaymentTimelineReader;
}

export interface PaymentTimelineView extends AssembledTimeline {
  readonly withheld: readonly PaymentTimelineSection[];
}

/**
 * One payment's history (WP17, `docs/wp17-payment-phase3-audit.md` D1). READ-ONLY: it
 * assembles facts other flows recorded, writes nothing, and decides no amount.
 *
 * The payment itself is charged `payments.view` through `check`, like the detail, so a
 * refusal is an operational event. Each gated section is then decided from the actor's
 * effective permissions WITHOUT recording a denial: not holding `refunds.view` while
 * reading a payment is not an attempted access, and an event for every finance-less
 * reviewer opening a payment would be noise that hides the real ones.
 */
export class PaymentTimelineService {
  constructor(private readonly deps: PaymentTimelineServiceDeps) {}

  async timeline(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<PaymentTimelineView> {
    await this.deps.guard.check(scope, actor, PAYMENT_VIEW_PERMISSION);
    const parsed = paymentIdSchema.safeParse(id);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a payment id.',
      );
    }
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const may = (section: PaymentTimelineSection) =>
      held.has(TIMELINE_SECTION_PERMISSIONS[section]);
    const include = { receipts: may('RECEIPTS'), refunds: may('REFUNDS'), wallet: may('WALLET') };

    const facts = await this.deps.reader.facts(
      scope,
      parsed.data,
      include,
      PAYMENT_TIMELINE_MAX_ENTRIES + 1,
    );
    if (facts === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND, 'Unknown payment.');
    }
    const assembled = assemblePaymentTimeline(facts);
    const withheld: PaymentTimelineSection[] = [];
    if (!include.receipts) withheld.push('RECEIPTS');
    if (!include.refunds) withheld.push('REFUNDS');
    if (!include.wallet) withheld.push('WALLET');
    return { ...assembled, withheld };
  }
}
