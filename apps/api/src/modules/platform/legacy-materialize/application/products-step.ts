import type { ProductsRepository } from './catalog-ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  categoryKey,
  categoryNameOf,
  planProduct,
  productSourceRef,
  textOf,
  type PlannedProduct,
  type ProductGap,
} from './catalog-records.js';
import {
  bump,
  inCatalogTransaction,
  outcome,
  type CatalogStepDeps,
  type CatalogStepOutcome,
} from './catalog-step-support.js';
import type { ExactMatchRow, ExplainedGap, MaterializeContext, MaterializeStep } from './ports.js';

export const PRODUCTS_STEP_NAME = 'catalog-products';

/**
 * Mirza `product` (as the converter's `product_mapping_proposal` records carry it) → NEXA
 * `products`, and Mirza `category` → `product_categories`.
 *
 * The owner no longer reviews each product: a product is created straight away, `source =
 * 'MIRZA'`, and edited later on the ordinary products page. It is ACTIVE only when it can
 * actually be sold — its panel is bound to a NEXA panel, it has a price, a category, a
 * non-zero allowance and a known audience, and Mirza had not marked it sold out. Otherwise it
 * is INACTIVE with the reason counted. A Mirza price is the product's SELLING price here (the
 * owner asked for it); the adoption lane still prices renewals at the current tariff.
 *
 * A category is matched by name (case and surrounding space ignored) and created when missing;
 * `product_categories` gets no source columns, so an existing category is never claimed by the
 * import and never rewritten.
 */
export class ProductsMaterializeStep implements MaterializeStep {
  readonly name = PRODUCTS_STEP_NAME;

  constructor(
    private readonly repository: ProductsRepository,
    private readonly deps: CatalogStepDeps,
  ) {}

  private async plan(ctx: MaterializeContext, tx?: TransactionScope) {
    const proposals = await this.repository.rows(
      ctx.scope,
      ctx.packageImportId,
      'product_mapping_proposal',
      tx,
    );
    const catalogue = await this.repository.rows(
      ctx.scope,
      ctx.packageImportId,
      'category_catalogue',
      tx,
    );
    const bindings = await this.repository.panelBindings(ctx.scope, ctx.packageImportId, tx);
    const tenantPanels = await this.repository.panelIdsOf(ctx.scope, [...bindings.values()], tx);
    const planned = proposals.map((p) => planProduct(p.payload, bindings, tenantPanels));
    return { planned, catalogue };
  }

  async apply(ctx: MaterializeContext): Promise<CatalogStepOutcome> {
    return inCatalogTransaction(this.deps, ctx, async (tx) => {
      const { planned, catalogue } = await this.plan(ctx, tx);
      const skipped: Record<string, number> = {};
      const notes: Record<string, number> = {};
      const creates: PlannedProduct[] = [];
      for (const p of planned) {
        if (p.kind === 'gap') bump(skipped, p.reason);
        else creates.push(p);
      }

      const existing = await this.repository.productsBySourceRef(
        ctx.scope,
        creates.map((p) => p.sourceRef),
        tx,
      );
      let alreadyPresent = 0;
      let diverged = 0;
      const fresh: PlannedProduct[] = [];
      for (const p of creates) {
        const there = existing.get(p.sourceRef);
        if (there === undefined) fresh.push(p);
        else if (there.trafficBytes === p.trafficBytes && there.durationDays === p.durationDays) {
          alreadyPresent += 1;
        } else diverged += 1;
      }

      // Categories: every label Mirza's category table holds, and every one a new product names.
      const wanted = new Map<string, string>();
      for (const row of catalogue) {
        const name = categoryNameOf(row.payload['label']);
        if (name !== null && !wanted.has(categoryKey(name))) wanted.set(categoryKey(name), name);
      }
      for (const p of fresh) {
        if (p.categoryName !== null && !wanted.has(categoryKey(p.categoryName))) {
          wanted.set(categoryKey(p.categoryName), p.categoryName);
        }
      }
      const categoryIds = await this.repository.categoryIdsByKey(ctx.scope, tx);
      for (const [key, name] of wanted) {
        if (categoryIds.has(key)) continue;
        const id = this.deps.ids.uuid();
        await this.repository.insertCategory(ctx.scope, { id, name }, ctx.now, tx);
        categoryIds.set(key, id);
        bump(notes, 'CATEGORY_CREATED');
      }

      const written = await this.repository.insertProducts(
        ctx.scope,
        fresh.map((p) => ({
          id: this.deps.ids.uuid(),
          sourceRef: p.sourceRef,
          title: p.title,
          status: p.status,
          audience: p.audience,
          panelId: p.panelId,
          categoryId:
            p.categoryName === null ? null : (categoryIds.get(categoryKey(p.categoryName)) ?? null),
          durationDays: p.durationDays,
          trafficBytes: p.trafficBytes,
          priceMinor: p.priceMinor,
        })),
        ctx.now,
        tx,
      );
      for (const p of fresh) {
        if (!written.has(p.sourceRef)) alreadyPresent += 1;
        else bump(notes, p.status === 'ACTIVE' ? 'ACTIVE' : `INACTIVE:${p.inactiveReason}`);
      }
      return outcome(
        this.name,
        { written: written.size, alreadyPresent, diverged },
        skipped,
        notes,
      );
    });
  }

  /**
   * Mirza `code_product` → the NEXA product the import created for it. This is what the
   * adoption lane needs to give an adopted service its product (`mapping.products`), now that
   * no owner review approves each one. A code that two Mirza products share, or an empty one,
   * names no single product and is left out — the lane then takes its hidden-shape path, as
   * it does for a productless invoice. Read only.
   */
  async productIdsByCode(ctx: MaterializeContext): Promise<ReadonlyMap<string, string>> {
    const proposals = await this.repository.rows(
      ctx.scope,
      ctx.packageImportId,
      'product_mapping_proposal',
    );
    const byCode = new Map<string, string[]>();
    for (const p of proposals) {
      const code = textOf(p.payload['code_product'])?.trim() ?? '';
      const id = textOf(p.payload['legacy_product_id'])?.trim() ?? '';
      if (code === '' || id === '') continue;
      byCode.set(code, [...(byCode.get(code) ?? []), productSourceRef(id)]);
    }
    const ids = await this.repository.productIdsBySourceRef(ctx.scope, [...byCode.values()].flat());
    const out = new Map<string, string>();
    for (const [code, refs] of byCode) {
      const only = refs.length === 1 ? ids.get(refs[0] as string) : undefined;
      if (only !== undefined) out.set(code, only);
    }
    return out;
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    const { planned, catalogue } = await this.plan(ctx);
    const gaps = new Map<string, { rows: number; sum: bigint }>();
    let mirzaSum = 0n;
    for (const p of planned) {
      const price = (p as PlannedProduct | ProductGap).mirzaPriceMinor ?? 0n;
      mirzaSum += price;
      if (p.kind === 'gap') {
        const g = gaps.get(p.reason) ?? { rows: 0, sum: 0n };
        gaps.set(p.reason, { rows: g.rows + 1, sum: g.sum + price });
      }
    }
    const explained: ExplainedGap[] = [...gaps].map(([reason, g]) => ({
      reason,
      rows: g.rows,
      sumMinor: g.sum,
    }));
    const totals = await this.repository.mirzaProductTotals(ctx.scope);

    // Categories: Mirza rows against the distinct names NEXA now holds.
    const labels = catalogue.map((c) => categoryNameOf(c.payload['label']));
    const seen = new Set<string>();
    let empty = 0;
    let duplicate = 0;
    for (const label of labels) {
      if (label === null) empty += 1;
      else if (seen.has(categoryKey(label))) duplicate += 1;
      else seen.add(categoryKey(label));
    }
    const nexaKeys = await this.repository.categoryKeys(ctx.scope);
    const categoryGaps: ExplainedGap[] = [
      ...(empty > 0 ? [{ reason: 'LABEL_EMPTY', rows: empty, sumMinor: null }] : []),
      ...(duplicate > 0 ? [{ reason: 'LABEL_DUPLICATE', rows: duplicate, sumMinor: null }] : []),
    ];
    return [
      {
        mirzaTable: 'product',
        nexaTable: 'products',
        mirzaRows: planned.length,
        nexaRows: totals.rows,
        mirzaSumMinor: mirzaSum,
        nexaSumMinor: totals.sumMinor,
        explained,
      },
      {
        mirzaTable: 'category',
        nexaTable: 'product_categories',
        mirzaRows: catalogue.length,
        nexaRows: [...seen].filter((k) => nexaKeys.has(k)).length,
        mirzaSumMinor: null,
        nexaSumMinor: null,
        explained: categoryGaps,
      },
    ];
  }
}
