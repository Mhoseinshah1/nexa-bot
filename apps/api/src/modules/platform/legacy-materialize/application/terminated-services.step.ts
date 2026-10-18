import {
  COMMERCE_ERROR_CODES,
  SUBSCRIPTION_REF_BYTES,
  errors,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { ServiceSecretSource } from '../../../commerce/provisioning/application/ports.js';
import {
  NEVER_PAID_AMOUNT_BUCKET,
  endedServiceUsername,
  fateOfInvoice,
  invoiceSourceRef,
  neverPaidSourceRef,
  shapeKeyOfCells,
  type EndedServiceGapReason,
  type NeverPaidOrderGapReason,
  type NeverPaidOrderState,
} from './ended-services.rules.js';
import type {
  ArchivedInvoiceRow,
  CarriedInvoice,
  EndedInvoiceInsert,
  EndedServicesRepository,
  NeverPaidOrderInsert,
  ShapeProductRow,
} from './ended-services.ports.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';

/**
 * The one-time Mirza import, services: every archived invoice whose account is NOT on the
 * panel (after a complete read-only inventory) becomes an ENDED service — a NEXA service in
 * state `TERMINATED`, linked to its customer and to a `LEGACY_HISTORY` order that carries the
 * invoice's own amount and date. A Mirza test invoice becomes one too, marked `is_test`
 * (`docs/migration/mirza-import-plan-fa.md` §6).
 *
 * What an ended service is NOT, and what makes each of those true:
 *
 * - Never provisioned. No `provisioning_operations` row, no `service_username_reservations`
 *   row, no provider call: this module holds no provider client, adapter or transport, and the
 *   only tables it writes are `orders` and `services`.
 * - Never a sale. The order's origin is `LEGACY_HISTORY` (not in `SALE_ORDER_ORIGINS`), so no
 *   revenue report counts it; it is PAID (or, never paid, EXPIRED or CANCELLED), never
 *   AWAITING_PAYMENT, so no expiry, payment or settlement lane picks it up, and the 0253
 *   trigger freezes its state and amounts; and the service is TERMINATED, which no operation
 *   is legal from.
 * - Never money. Nothing here writes a ledger entry or changes a balance.
 * - Nothing triggered. No outbox event, notification, reminder or audit of a customer-visible
 *   fact: one audit row per `apply` records the counts, and that is all.
 * - Never rewritten. A row already present is compared and counted; a different one is
 *   `diverged` and left exactly as it is.
 *
 * A NEVER-PAID invoice (`unpaid`, `Unsuccessful`, no status) is carried too (owner
 * instruction 2026-10-18), as an ORDER and nothing else: `LEGACY_HISTORY`, EXPIRED or
 * CANCELLED (`neverPaidOrderState` holds the mapping and its evidence), at its own amount and
 * date, under `invoice-never-paid:<id>` — no service, payment, ledger entry, event or notice.
 * Its amount is not a payment, so the exact-match orders row never adds it to the paid money
 * (`NEVER_PAID_AMOUNT_BUCKET`). One that cannot be an order honestly (no key, owner, panel or
 * product) is a counted `NEVER_PAID_ORDER_GAP_REASONS` gap. It lives in this step, not one of
 * its own, because the `invoice` rows of the exact-match report are this step's: one step
 * decides every invoice's one fate, so no invoice can be counted by two steps or by none.
 *
 * The fate of each invoice comes from the importer's own map (`fateOfInvoice`); this step never
 * asks the panel anything.
 */
export const ENDED_SERVICES_STEP_NAME = 'ended-services';

/** What the step charges: the importer's own key (`SYSTEM_JOB_PERMISSIONS` is `maintenance.run`). */
export const ENDED_SERVICES_PERMISSION: PermissionKey = 'maintenance.run';

const PAGE_SIZE = 500;
const WRITE_BATCH = 100;
const AUDIT_ACTION = 'legacy.materialize.ended_services';

export interface TerminatedServicesStepDeps {
  readonly repository: EndedServicesRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly scopeActivity: ScopeActivityReader;
  readonly secrets: ServiceSecretSource;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Invoices read per page; the default is the production page. A test shrinks it. */
  readonly pageSize?: number;
}

/** An ended invoice with everything the write needs resolved. */
interface WritableEnded {
  readonly kind: 'WRITE';
  readonly row: ArchivedInvoiceRow;
  readonly test: boolean;
  readonly customerId: string;
  readonly panelId: string;
  readonly product: ShapeProductRow;
}

/** A never-paid invoice with everything its order needs resolved. */
interface WritableNeverPaid {
  readonly kind: 'NEVER_PAID_WRITE';
  readonly row: ArchivedInvoiceRow;
  readonly state: NeverPaidOrderState;
  readonly customerId: string;
  readonly panelId: string;
  readonly product: ShapeProductRow;
}

type Writable = WritableEnded | WritableNeverPaid;

type Decided =
  | Writable
  | {
      readonly kind: 'NEVER_PAID_GAP';
      readonly row: ArchivedInvoiceRow;
      readonly reason: NeverPaidOrderGapReason;
    }
  | { readonly kind: 'ADOPTED'; readonly row: ArchivedInvoiceRow }
  | {
      readonly kind: 'GAP';
      readonly row: ArchivedInvoiceRow;
      readonly reason: EndedServiceGapReason;
    }
  | { readonly kind: 'UNEXPLAINED'; readonly row: ArchivedInvoiceRow; readonly why: string };

export class TerminatedServicesStep implements MaterializeStep {
  readonly name = ENDED_SERVICES_STEP_NAME;

  constructor(private readonly deps: TerminatedServicesStepDeps) {}

  async apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    await this.deps.guard.check(ctx.scope, ctx.actor, ENDED_SERVICES_PERMISSION);
    let written = 0;
    let alreadyPresent = 0;
    let diverged = 0;
    const skipped: Record<string, number> = {};
    const bump = (reason: string): void => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };

    for await (const page of this.decidedPages(ctx)) {
      const writable: Writable[] = [];
      for (const decided of page) {
        if (decided.kind === 'WRITE' || decided.kind === 'NEVER_PAID_WRITE') writable.push(decided);
        else if (decided.kind === 'NEVER_PAID_GAP') bump(decided.reason);
        else if (decided.kind === 'ADOPTED') bump('ADOPTED_BY_IMPORTER');
        else if (decided.kind === 'GAP') bump(decided.reason);
        else bump(`UNEXPLAINED:${decided.why}`);
      }
      for (let i = 0; i < writable.length; i += WRITE_BATCH) {
        const outcome = await this.writeBatch(ctx, writable.slice(i, i + WRITE_BATCH));
        written += outcome.written;
        alreadyPresent += outcome.alreadyPresent;
        diverged += outcome.diverged;
      }
    }

    await this.deps.uow.run(ctx.scope, async (tx) => {
      await this.requireActive(ctx.scope, tx);
      await this.deps.audit.record(
        ctx.scope,
        ctx.actor,
        {
          action: AUDIT_ACTION,
          entityType: 'LegacyMaterializeStep',
          entityId: null,
          before: null,
          after: { step: this.name, written, alreadyPresent, diverged, skipped },
          result: 'SUCCESS',
        },
        tx,
      );
    });
    return { step: this.name, written, alreadyPresent, diverged, skipped };
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    let mirzaRows = 0;
    let mirzaSum = 0n;
    // The services row and the orders row explain different things: a never-paid invoice is
    // never a service (NEVER_PAID there, whatever became of its order), and an adopted one is
    // a service whose order does not carry the amount (a gap of the orders row only).
    const servicesGaps = new Map<string, number>();
    const ordersGaps = new Map<string, { rows: number; sum: bigint }>();
    const serviceGap = (reason: string): void => {
      servicesGaps.set(reason, (servicesGaps.get(reason) ?? 0) + 1);
    };
    const orderGap = (reason: string, rows: number, price: bigint): void => {
      const gap = ordersGaps.get(reason) ?? { rows: 0, sum: 0n };
      ordersGaps.set(reason, { rows: gap.rows + rows, sum: gap.sum + price });
    };
    for await (const page of this.decidedPages(ctx)) {
      for (const decided of page) {
        const price = decided.row.priceMinor ?? 0n;
        mirzaRows += 1;
        mirzaSum += price;
        if (decided.kind === 'ADOPTED') {
          orderGap('ADOPTED_AMOUNT_NOT_CARRIED', 1, price);
        } else if (decided.kind === 'GAP') {
          serviceGap(decided.reason);
          orderGap(decided.reason, 1, price);
        } else if (decided.kind === 'NEVER_PAID_GAP') {
          serviceGap('NEVER_PAID');
          orderGap(decided.reason, 1, price);
        } else if (decided.kind === 'NEVER_PAID_WRITE') {
          // The ORDER is NEXA's row (the counts below verify it); its amount was never paid,
          // so it is named here and never in the paid money NEXA's side sums.
          serviceGap('NEVER_PAID');
          orderGap(NEVER_PAID_AMOUNT_BUCKET, 0, price);
        }
        // WRITE: NEXA must hold it — the counts below verify that. UNEXPLAINED: left out of
        // the explained gaps on purpose, so the report shows the difference.
      }
    }
    const counts = await this.deps.repository.counts(ctx.scope);
    const sorted = <T>(m: Map<string, T>): [string, T][] =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return [
      {
        // The services table carries no amount: rows only. Adopted and ended services alike.
        mirzaTable: 'invoice',
        nexaTable: 'services',
        mirzaRows,
        nexaRows: counts.services,
        mirzaSumMinor: null,
        nexaSumMinor: null,
        explained: sorted(servicesGaps).map(([reason, rows]) => ({
          reason,
          rows,
          sumMinor: null,
        })),
      },
      {
        // The orders table carries the money. An adopted service's order is the free
        // LEGACY_ADOPTION one, so it is a gap here — in rows and in money. A never-paid
        // invoice's order IS a row here, but NEXA's money is the PAID history orders' only:
        // the never-paid amounts are the NEVER_PAID_AMOUNT_BUCKET, so "NEXA + explained =
        // Mirza" holds without ever adding an unpaid amount to a paid one (and a never-paid
        // order written PAID, or a paid one written unpaid, breaks the money and fails).
        mirzaTable: 'invoice',
        nexaTable: 'orders',
        mirzaRows,
        nexaRows: counts.historyOrders,
        mirzaSumMinor: mirzaSum,
        nexaSumMinor: counts.paidHistoryOrdersTotalMinor,
        explained: sorted(ordersGaps).map(([reason, gap]) => ({
          reason,
          rows: gap.rows,
          sumMinor: gap.sum,
        })),
      },
    ];
  }

  // --- the decision, shared by apply and match ------------------------------------------

  private async *decidedPages(ctx: MaterializeContext): AsyncGenerator<readonly Decided[]> {
    const repo = this.deps.repository;
    const bindings = await repo.panelBindings(ctx.scope, ctx.packageImportId);
    let after: string | null = null;
    for (;;) {
      const page = await repo.archivePage(
        ctx.scope,
        ctx.sourceFingerprint,
        after,
        this.deps.pageSize ?? PAGE_SIZE,
      );
      if (page.length === 0) return;
      const last = page[page.length - 1];
      after = last === undefined ? null : last.invoiceKey;
      const maps = await repo.mapFacts(
        ctx.scope,
        page.map((r) => r.invoiceKey),
      );
      const customers = await repo.importedCustomers(
        ctx.scope,
        page.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
      );
      const shapeKeys = new Set<string>();
      for (const row of page) {
        const shape = shapeKeyOfCells(row);
        if (shape.ok) shapeKeys.add(shape.key);
      }
      const products = await repo.shapeProducts(ctx.scope, [...shapeKeys]);
      /**
       * A never-paid invoice's order needs what any order needs — a key to be found by, a
       * customer, a panel, a product — and the first one missing is its gap. Same order of
       * questions as an ended invoice's, so one archive fact is one reason in both.
       */
      const neverPaid = (row: ArchivedInvoiceRow, state: NeverPaidOrderState): Decided => {
        const gap = (reason: NeverPaidOrderGapReason): Decided => ({
          kind: 'NEVER_PAID_GAP',
          row,
          reason,
        });
        if (!row.keyShapeEvidenced) return gap('NEVER_PAID_KEY_INVALID');
        const customerId = row.legacyUserId === null ? undefined : customers.get(row.legacyUserId);
        if (customerId === undefined) return gap('NEVER_PAID_OWNER_NOT_IMPORTED');
        if (row.panelCode === null) return gap('NEVER_PAID_NO_PANEL');
        const panelId = bindings.get(row.panelCode);
        if (panelId === undefined) return gap('NEVER_PAID_PANEL_NOT_MAPPED');
        const shape = shapeKeyOfCells(row);
        if (!shape.ok) return gap('NEVER_PAID_SHAPE_UNMAPPABLE');
        const product = products.get(shape.key);
        if (product === undefined) return gap('NEVER_PAID_PRODUCT_NOT_RESOLVED');
        return { kind: 'NEVER_PAID_WRITE', row, state, customerId, panelId, product };
      };
      yield page.map((row): Decided => {
        const fate = fateOfInvoice(row, maps.get(row.invoiceKey));
        if (fate.kind === 'NEVER_PAID') return neverPaid(row, fate.state);
        if (fate.kind === 'ADOPTED') return { kind: 'ADOPTED', row };
        if (fate.kind === 'GAP') return { kind: 'GAP', row, reason: fate.reason };
        if (fate.kind === 'UNEXPLAINED') return { kind: 'UNEXPLAINED', row, why: fate.why };

        const gap = (reason: EndedServiceGapReason): Decided => ({ kind: 'GAP', row, reason });
        const customerId = row.legacyUserId === null ? undefined : customers.get(row.legacyUserId);
        if (customerId === undefined) return gap('OWNER_NOT_IMPORTED');
        if (row.panelCode === null) return gap('NO_PANEL');
        const panelId = bindings.get(row.panelCode);
        if (panelId === undefined) return gap('PANEL_NOT_MAPPED');
        const shape = shapeKeyOfCells(row);
        if (!shape.ok) return gap('SHAPE_UNMAPPABLE');
        const product = products.get(shape.key);
        if (product === undefined) return gap('PRODUCT_NOT_RESOLVED');
        return { kind: 'WRITE', row, test: fate.test, customerId, panelId, product };
      });
    }
  }

  // --- the write ------------------------------------------------------------------------

  private async writeBatch(
    ctx: MaterializeContext,
    batch: readonly Writable[],
  ): Promise<{ written: number; alreadyPresent: number; diverged: number }> {
    const repo = this.deps.repository;
    const refOf = (item: Writable): string =>
      item.kind === 'WRITE'
        ? invoiceSourceRef(item.row.invoiceKey)
        : neverPaidSourceRef(item.row.invoiceKey);
    return this.deps.uow.run(ctx.scope, async (tx) => {
      await this.requireActive(ctx.scope, tx);
      await repo.lock(ctx.scope, tx);
      const carried = await repo.carried(ctx.scope, batch.map(refOf), tx);
      let written = 0;
      let alreadyPresent = 0;
      let diverged = 0;
      for (const item of batch) {
        const sourceRef = refOf(item);
        const existing = carried.get(sourceRef);
        if (item.kind === 'WRITE') {
          const insert = this.insertFor(ctx, item, sourceRef);
          if (existing === undefined) {
            await repo.insertEnded(ctx.scope, insert, tx);
            written += 1;
          } else if (sameAsCarried(existing, insert)) {
            alreadyPresent += 1;
          } else {
            diverged += 1;
          }
        } else {
          const insert = this.neverPaidInsertFor(ctx, item, sourceRef);
          if (existing === undefined) {
            await repo.insertNeverPaid(ctx.scope, insert, tx);
            written += 1;
          } else if (sameAsCarriedNeverPaid(existing, insert)) {
            alreadyPresent += 1;
          } else {
            diverged += 1;
          }
        }
      }
      return { written, alreadyPresent, diverged };
    });
  }

  private insertFor(
    ctx: MaterializeContext,
    item: WritableEnded,
    sourceRef: string,
  ): EndedInvoiceInsert {
    const { row } = item;
    return {
      orderId: this.deps.ids.uuid(),
      serviceId: this.deps.ids.uuid(),
      sourceRef,
      customerId: item.customerId,
      panelId: item.panelId,
      product: item.product,
      lineTitle: lineTitleOf(row.productName, item.product.title),
      providerUsername: endedServiceUsername(row.username, row.invoiceKey),
      subscriptionRef: this.deps.secrets.hex(SUBSCRIPTION_REF_BYTES),
      amountMinor: row.priceMinor ?? 0n,
      currency: 'IRT',
      purchasedAt: originalDate(row, ctx),
      isTest: item.test,
      now: ctx.now,
    };
  }

  private neverPaidInsertFor(
    ctx: MaterializeContext,
    item: WritableNeverPaid,
    sourceRef: string,
  ): NeverPaidOrderInsert {
    const { row } = item;
    return {
      orderId: this.deps.ids.uuid(),
      sourceRef,
      state: item.state,
      customerId: item.customerId,
      panelId: item.panelId,
      product: item.product,
      lineTitle: lineTitleOf(row.productName, item.product.title),
      // The invoice's own amount, 0 when it did not read — exactly as an ended order's.
      amountMinor: row.priceMinor ?? 0n,
      currency: 'IRT',
      createdAt: originalDate(row, ctx),
      now: ctx.now,
    };
  }

  private async requireActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}

/** The original creation date; an unreadable (or future) one is the import's, never a guess. */
function originalDate(row: ArchivedInvoiceRow, ctx: MaterializeContext): Date {
  return row.soldAt !== null && row.soldAt.getTime() <= ctx.now.getTime() ? row.soldAt : ctx.now;
}

/** The order line's title: the Mirza product's own name when the archive has one. */
export function lineTitleOf(productName: string | null, productTitle: string): string {
  const name = productName?.trim() ?? '';
  return [...(name === '' ? productTitle : name)].slice(0, 200).join('');
}

/**
 * Whether what NEXA already holds under an invoice's ref is exactly what this step would
 * write: the same customer, panel and amount, a PAID order of origin `LEGACY_HISTORY`, a
 * TERMINATED service with the same test mark. Anything else — an adopted live service, an
 * order of another customer — is a divergence the step reports and never rewrites.
 */
export function sameAsCarried(existing: CarriedInvoice, insert: EndedInvoiceInsert): boolean {
  return (
    existing.orderId !== null &&
    existing.serviceId !== null &&
    existing.orderOrigin === 'LEGACY_HISTORY' &&
    existing.orderState === 'PAID' &&
    existing.orderCustomerId === insert.customerId &&
    existing.orderPanelId === insert.panelId &&
    existing.orderTotal === insert.amountMinor &&
    existing.serviceState === 'TERMINATED' &&
    existing.serviceCustomerId === insert.customerId &&
    existing.serviceIsTest === insert.isTest
  );
}

/**
 * Whether what NEXA holds under a never-paid invoice's ref is exactly its order: a
 * `LEGACY_HISTORY` order in the mapped state, for the same customer, panel and amount, and NO
 * service beside it. Anything else is a divergence, reported and never rewritten.
 */
export function sameAsCarriedNeverPaid(
  existing: CarriedInvoice,
  insert: NeverPaidOrderInsert,
): boolean {
  return (
    existing.orderId !== null &&
    existing.serviceId === null &&
    existing.orderOrigin === 'LEGACY_HISTORY' &&
    existing.orderState === insert.state &&
    existing.orderCustomerId === insert.customerId &&
    existing.orderPanelId === insert.panelId &&
    existing.orderTotal === insert.amountMinor
  );
}
