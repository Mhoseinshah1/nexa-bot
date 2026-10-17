import type { DiscountsRepository } from './catalog-ports.js';
import { allocateCode, planDiscount, type PlannedDiscount } from './catalog-records.js';
import {
  bump,
  inCatalogTransaction,
  outcome,
  type CatalogStepDeps,
  type CatalogStepOutcome,
} from './catalog-step-support.js';
import type { ExactMatchRow, MaterializeContext, MaterializeStep } from './ports.js';

export const DISCOUNTS_STEP_NAME = 'catalog-discount-codes';

/** The label an imported code carries on the discounts page and in a quote trace. */
const LABEL_PREFIX = 'Mirza ';

/**
 * Mirza discount codes (`Discount`, `DiscountSell` and the fork's `discount_sell`) → NEXA
 * `discounts`, `source = 'MIRZA'`, ALWAYS `INACTIVE`.
 *
 * A code Mirza issued is a bearer secret that was already in circulation. NEXA never switches
 * one on by itself: the owner reads the list and activates what they want. Nothing here
 * redeems, quotes or prices anything; the step writes the rule and returns.
 *
 * CODE TEXT. The code is what the converter exported as `code_text`. One that does not fit
 * `^[A-Z0-9_-]{3,40}$` is normalised (upper case, invalid characters dropped, 40 long at most);
 * on a collision with another code a deterministic suffix drawn from the record's own
 * reference is added; a record with no usable text at all gets a code derived from its
 * reference. The ORIGINAL text is kept in `source_detail.codeOriginal`, so nothing is lost.
 *
 * KINDS. A percent code is a PERCENTAGE rule. A wallet "gift" code has no NEXA equivalent (a
 * rule that credits a wallet does not exist, and must not): it is imported as an INACTIVE
 * FIXED_AMOUNT shell whose `source_detail.mirzaKind` says what it was. A record with no
 * readable percent/amount, or of an unknown fork kind, is a counted gap and stays in the
 * archive.
 *
 * LIMITS. `limit_total` becomes the total-redemptions limit as Mirza had it; how many Mirza
 * uses were spent is kept in `source_detail` (NEXA counts live redemptions itself).
 */
export class DiscountsMaterializeStep implements MaterializeStep {
  readonly name = DISCOUNTS_STEP_NAME;

  constructor(
    private readonly repository: DiscountsRepository,
    private readonly deps: CatalogStepDeps,
  ) {}

  async apply(ctx: MaterializeContext): Promise<CatalogStepOutcome> {
    return inCatalogTransaction(this.deps, ctx, async (tx) => {
      const records = await this.repository.rows(ctx.scope, ctx.packageImportId, 'discount', tx);
      const skipped: Record<string, number> = {};
      const notes: Record<string, number> = {};
      const planned: PlannedDiscount[] = [];
      for (const r of records) {
        const p = planDiscount(r);
        if (p.kind === 'gap') bump(skipped, p.reason);
        else planned.push(p);
      }
      const existing = await this.repository.discountsBySourceRef(
        ctx.scope,
        planned.map((p) => p.sourceRef),
        tx,
      );
      let alreadyPresent = 0;
      let diverged = 0;
      const fresh: PlannedDiscount[] = [];
      for (const p of planned) {
        const there = existing.get(p.sourceRef);
        if (there === undefined) fresh.push(p);
        else if (there.type === p.type && there.value === p.value) alreadyPresent += 1;
        else diverged += 1;
      }

      // Records arrive in key order, so a collision is resolved the same way on every run.
      const taken = await this.repository.takenCodes(ctx.scope, tx);
      const rows = fresh.map((p) => {
        const code = allocateCode(p.baseCode, p.sourceRef, (c) => taken.has(c));
        taken.add(code);
        if (code !== p.baseCode) bump(notes, 'CODE_SUFFIXED');
        if (p.detail['codeNormalised'] === true) bump(notes, 'CODE_NORMALISED');
        if (p.detail['codeDerived'] === true) bump(notes, 'CODE_DERIVED');
        if (p.mirzaKind === 'GIFT_BALANCE_CODE') bump(notes, 'GIFT_CODE_NO_NEXA_EQUIVALENT');
        return {
          id: this.deps.ids.uuid(),
          sourceRef: p.sourceRef,
          code,
          label: `${LABEL_PREFIX}${code}`,
          type: p.type,
          value: p.value,
          currency: p.currency,
          appliesTo: p.appliesTo,
          firstPurchaseOnly: p.firstPurchaseOnly,
          totalLimit: p.totalLimit,
          perCustomerLimit: p.perCustomerLimit,
          endsAt: p.endsAt,
          detail: { ...p.detail, codeStored: code },
        };
      });
      const written = await this.repository.insertDiscounts(ctx.scope, rows, ctx.now, tx);
      for (const p of fresh) if (!written.has(p.sourceRef)) alreadyPresent += 1;
      return outcome(
        this.name,
        { written: written.size, alreadyPresent, diverged },
        skipped,
        notes,
      );
    });
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    const records = await this.repository.rows(ctx.scope, ctx.packageImportId, 'discount');
    const refs = await this.repository.mirzaDiscountRefs(ctx.scope);
    const gaps = new Map<string, number>();
    let carried = 0;
    for (const r of records) {
      const p = planDiscount(r);
      if (p.kind === 'gap') gaps.set(p.reason, (gaps.get(p.reason) ?? 0) + 1);
      else if (refs.has(p.sourceRef)) carried += 1;
      // a plannable record NEXA does not hold is explained by nothing, so the row will not hold
    }
    return [
      {
        mirzaTable: 'discount',
        nexaTable: 'discounts',
        mirzaRows: records.length,
        nexaRows: carried,
        mirzaSumMinor: null,
        nexaSumMinor: null,
        explained: [...gaps].map(([reason, rows]) => ({ reason, rows, sumMinor: null })),
      },
    ];
  }
}
