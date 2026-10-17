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
  endedServiceUsername,
  fateOfInvoice,
  invoiceSourceRef,
  shapeKeyOfCells,
  type EndedServiceGapReason,
} from './ended-services.rules.js';
import type {
  ArchivedInvoiceRow,
  CarriedInvoice,
  EndedInvoiceInsert,
  EndedServicesRepository,
  ShapeProductRow,
} from './ended-services.ports.js';
import type {
  ExactMatchRow,
  ExplainedGap,
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
 *   revenue report counts it; it is PAID, so no expiry or settlement lane picks it up; and the
 *   service is TERMINATED, which no operation is legal from.
 * - Never money. Nothing here writes a ledger entry or changes a balance.
 * - Nothing triggered. No outbox event, notification, reminder or audit of a customer-visible
 *   fact: one audit row per `apply` records the counts, and that is all.
 * - Never rewritten. A row already present is compared and counted; a different one is
 *   `diverged` and left exactly as it is.
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

type Decided =
  | WritableEnded
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
      const writable: WritableEnded[] = [];
      for (const decided of page) {
        if (decided.kind === 'WRITE') writable.push(decided);
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
    const gaps = new Map<string, { rows: number; sum: bigint }>();
    const add = (reason: string, price: bigint): void => {
      const gap = gaps.get(reason) ?? { rows: 0, sum: 0n };
      gaps.set(reason, { rows: gap.rows + 1, sum: gap.sum + price });
    };
    for await (const page of this.decidedPages(ctx)) {
      for (const decided of page) {
        const price = decided.row.priceMinor ?? 0n;
        mirzaRows += 1;
        mirzaSum += price;
        if (decided.kind === 'ADOPTED') add('ADOPTED_AMOUNT_NOT_CARRIED', price);
        else if (decided.kind === 'GAP') add(decided.reason, price);
        // WRITE: NEXA must hold it — the counts below verify that. UNEXPLAINED: left out of
        // the explained gaps on purpose, so the report shows the difference.
      }
    }
    const counts = await this.deps.repository.counts(ctx.scope);
    const adopted = gaps.get('ADOPTED_AMOUNT_NOT_CARRIED') ?? { rows: 0, sum: 0n };
    const explained = (includeAdopted: boolean): ExplainedGap[] =>
      [...gaps.entries()]
        .filter(([reason]) => includeAdopted || reason !== 'ADOPTED_AMOUNT_NOT_CARRIED')
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([reason, gap]) => ({
          reason,
          rows: gap.rows,
          sumMinor: gap.sum,
        }));
    return [
      {
        // The services table carries no amount: rows only. Adopted and ended services alike.
        mirzaTable: 'invoice',
        nexaTable: 'services',
        mirzaRows,
        nexaRows: counts.services,
        mirzaSumMinor: null,
        nexaSumMinor: null,
        explained: explained(false).map((gap) => ({ ...gap, sumMinor: null })),
      },
      {
        // The orders table carries the money. An adopted service's order is the free
        // LEGACY_ADOPTION one, so it is a gap here — in rows and in money.
        mirzaTable: 'invoice',
        nexaTable: 'orders',
        mirzaRows,
        nexaRows: counts.historyOrders,
        mirzaSumMinor: mirzaSum,
        nexaSumMinor: counts.historyOrdersTotalMinor,
        explained: explained(true).map((gap) =>
          gap.reason === 'ADOPTED_AMOUNT_NOT_CARRIED'
            ? { ...gap, rows: adopted.rows, sumMinor: adopted.sum }
            : gap,
        ),
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
      yield page.map((row): Decided => {
        const fate = fateOfInvoice(row, maps.get(row.invoiceKey));
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
    batch: readonly WritableEnded[],
  ): Promise<{ written: number; alreadyPresent: number; diverged: number }> {
    const repo = this.deps.repository;
    return this.deps.uow.run(ctx.scope, async (tx) => {
      await this.requireActive(ctx.scope, tx);
      await repo.lock(ctx.scope, tx);
      const carried = await repo.carried(
        ctx.scope,
        batch.map((b) => invoiceSourceRef(b.row.invoiceKey)),
        tx,
      );
      let written = 0;
      let alreadyPresent = 0;
      let diverged = 0;
      for (const item of batch) {
        const sourceRef = invoiceSourceRef(item.row.invoiceKey);
        const insert = this.insertFor(ctx, item, sourceRef);
        const existing = carried.get(sourceRef);
        if (existing === undefined) {
          await repo.insertEnded(ctx.scope, insert, tx);
          written += 1;
        } else if (sameAsCarried(existing, insert)) {
          alreadyPresent += 1;
        } else {
          diverged += 1;
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
      // The original creation date; an unreadable one is the import's, never a guess.
      purchasedAt:
        row.soldAt !== null && row.soldAt.getTime() <= ctx.now.getTime() ? row.soldAt : ctx.now,
      isTest: item.test,
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

/** The order line's title: the Mirza product's own name when the archive has one. */
export function lineTitleOf(productName: string | null, productTitle: string): string {
  const name = productName?.trim() ?? '';
  return [...(name === '' ? productTitle : name)].slice(0, 200).join('');
}

/**
 * Whether what NEXA already holds under an invoice's ref is exactly what this step would
 * write: the same customer, panel and amount, an order of origin `LEGACY_HISTORY`, a
 * TERMINATED service with the same test mark. Anything else — an adopted live service, an
 * order of another customer — is a divergence the step reports and never rewrites.
 */
export function sameAsCarried(existing: CarriedInvoice, insert: EndedInvoiceInsert): boolean {
  return (
    existing.orderId !== null &&
    existing.serviceId !== null &&
    existing.orderOrigin === 'LEGACY_HISTORY' &&
    existing.orderCustomerId === insert.customerId &&
    existing.orderPanelId === insert.panelId &&
    existing.orderTotal === insert.amountMinor &&
    existing.serviceState === 'TERMINATED' &&
    existing.serviceCustomerId === insert.customerId &&
    existing.serviceIsTest === insert.isTest
  );
}
