import type { TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  applyPlanned,
  customerOf,
  gap,
  matchPlanned,
  mirzaIdOf,
  mirzaInstant,
  parseMinor,
  sourceRefOf,
  text,
  write,
  type HistoryRecord,
  type MaterializeDeps,
  type Planned,
  type PlannedRepository,
  type PlannedStep,
  type PlannedWrite,
} from './materialize-support.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';

/**
 * Mirza discount usage into `discount_redemptions` (plan §3), ONLY where the discount, the
 * order and the amount it took off are all known. Everything else is counted, with the first
 * thing that was missing:
 *
 * - `DISCOUNT_UNKNOWN`: the record does not name a code NEXA holds. The documented
 *   `Giftcodeconsumed.code` is a bearer secret the converter drops, so its usage carries
 *   `code_ref: null`; only a fork table's usage carries a digest that can match a code.
 * - `ORDER_UNKNOWN`: no invoice the record names exists as an imported order
 *   (`orders.source_ref = 'invoice:<id>'`), or it belongs to another customer.
 * - `AMOUNT_UNKNOWN`: the record states no positive amount (a redemption snapshots one).
 *
 * A redemption written here is HISTORY and can never consume a limit: a limit counts live
 * redemptions — orders `AWAITING_PAYMENT` or `PAID` — and `DrizzleDiscountRepository.usage`
 * (and the campaign outcome) skip every order whose origin is `LEGACY_HISTORY`. The imported
 * codes are INACTIVE as well, so nothing could redeem them; the skip is what stays true the
 * day an operator activates one.
 */

export const DISCOUNT_USAGE_HISTORY_STEP = 'discount-usage-history';
export const DISCOUNT_USAGE_REF_PREFIX = 'discount-usage';
/** The `source_ref` an imported invoice order has: `invoice:<id_invoice>`. */
export const invoiceOrderSourceRef = (id: string): string => `invoice:${id}`;

const INVOICE_COLUMNS = ['id_invoice', 'invoice', 'invoice_id', 'order_id', 'id_order'] as const;
const AMOUNT_COLUMNS = ['price', 'amount', 'discount_amount', 'value'] as const;

export interface RedemptionWrite extends PlannedWrite {
  readonly discountId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}

export const redemptionFingerprint = (r: {
  readonly discountId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
}): string =>
  [
    r.discountId,
    r.orderId,
    r.customerId,
    r.amountMinor.toString(),
    r.currency,
    r.createdAt.toISOString(),
  ].join('|');

export interface ImportedOrderFact {
  readonly id: string;
  readonly customerId: string;
  readonly currency: string;
  /** The order's own date, which a redemption without a time of its own is dated by. */
  readonly at: Date;
}

export interface DiscountUsageLookups {
  /** `code_ref` -> the id of the NEXA discount imported from the code with that digest. */
  discountsByCodeRef(
    scope: TenantContext,
    nxpkgImportId: string,
    codeRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  /** `orders.source_ref` -> the order. */
  ordersBySourceRef(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, ImportedOrderFact>>;
}

export type DiscountUsageHistoryRepository = PlannedRepository<RedemptionWrite> &
  DiscountUsageLookups;

function column(record: HistoryRecord, names: readonly string[]): unknown {
  const fields = record.payload['fields_raw'];
  if (fields === null || typeof fields !== 'object') return undefined;
  const map = fields as Record<string, unknown>;
  const key = names.find((name) => Object.hasOwn(map, name));
  return key === undefined ? undefined : map[key];
}

export function planRedemption(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
  discounts: ReadonlyMap<string, string>,
  orders: ReadonlyMap<string, ImportedOrderFact>,
  seenPairs: Set<string>,
): Planned<RedemptionWrite> {
  const id = mirzaIdOf(record);
  const sourceRef = id === null ? null : sourceRefOf(DISCOUNT_USAGE_REF_PREFIX, id);
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE');
  const customerId = customerOf(record, customers);
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED');
  const codeRef = text(record.payload['code_ref']);
  const discountId = codeRef === null ? null : (discounts.get(codeRef) ?? null);
  if (discountId === null) return gap('DISCOUNT_UNKNOWN');
  const invoice = text(column(record, INVOICE_COLUMNS));
  const order = invoice === null ? undefined : orders.get(invoiceOrderSourceRef(invoice));
  if (order === undefined || order.customerId !== customerId) return gap('ORDER_UNKNOWN');
  const amount = parseMinor(column(record, AMOUNT_COLUMNS));
  if (amount === null || amount <= 0n) return gap('AMOUNT_UNKNOWN');
  const pair = `${order.id}|${discountId}`;
  if (seenPairs.has(pair)) return gap('DUPLICATE_REDEMPTION');
  seenPairs.add(pair);
  const createdAt = mirzaInstant(column(record, ['time', 'created_at', 'used_at'])) ?? order.at;
  const fields = {
    discountId,
    orderId: order.id,
    customerId,
    amountMinor: amount,
    currency: order.currency,
    createdAt,
  };
  return write<RedemptionWrite>(
    { sourceRef, fingerprint: redemptionFingerprint(fields), ...fields },
    amount,
  );
}

export class DiscountUsageHistoryStep implements MaterializeStep {
  readonly name = DISCOUNT_USAGE_HISTORY_STEP;
  private readonly step: PlannedStep<RedemptionWrite>;
  private readonly pairsSeen = new WeakMap<MaterializeContext, Set<string>>();

  constructor(
    private readonly deps: MaterializeDeps,
    repository: DiscountUsageHistoryRepository,
  ) {
    this.step = {
      name: DISCOUNT_USAGE_HISTORY_STEP,
      recordType: 'discount_usage',
      repository,
      plan: async (records, ctx, tx) => {
        const customers = await deps.records.customersByLegacyUser(
          ctx.scope,
          records.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
          tx,
        );
        const codeRefs = records.flatMap((r) => {
          const c = text(r.payload['code_ref']);
          return c === null ? [] : [c];
        });
        const invoices = records.flatMap((r) => {
          const v = text(column(r, INVOICE_COLUMNS));
          return v === null ? [] : [invoiceOrderSourceRef(v)];
        });
        const discounts = await repository.discountsByCodeRef(
          ctx.scope,
          ctx.packageImportId,
          codeRefs,
          tx,
        );
        const orders = await repository.ordersBySourceRef(ctx.scope, invoices, tx);
        let seen = this.pairsSeen.get(ctx);
        if (seen === undefined) {
          seen = new Set();
          this.pairsSeen.set(ctx, seen);
        }
        return records.map((r) =>
          planRedemption(r, customers, discounts, orders, seen as Set<string>),
        );
      },
    };
  }

  apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    return applyPlanned(this.deps, this.step, ctx);
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    // The usage rows carry no amount in the documented table, so the report compares rows;
    // the redemption's own amount is checked by the rows it explains.
    return [
      await matchPlanned(this.deps, this.step, ctx, {
        mirzaTable: 'Giftcodeconsumed',
        nexaTable: 'discount_redemptions',
        hasAmount: false,
      }),
    ];
  }
}
