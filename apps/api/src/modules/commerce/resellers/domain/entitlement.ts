import type {
  DiscountablePurpose,
  ResellerEntitlementDimension,
  ResellerGrantKind,
} from '@nexa/contracts';

/** One grant as the evaluator reads it: a kind and a subject, `null` for "every one". */
export interface EntitlementGrant {
  readonly kind: ResellerGrantKind;
  readonly subject: string | null;
}

/** What a commercial action is asking to do, in the four dimensions a tier constrains. */
export interface EntitlementSubject {
  readonly operation: DiscountablePurpose;
  readonly productId: string;
  readonly categoryId: string | null;
  readonly panelId: string;
  /** The bot the request arrived through, or null when it arrived through no bot. */
  readonly botInstanceId: string | null;
}

export type EntitlementDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly dimension: ResellerEntitlementDimension };

function grants(
  all: readonly EntitlementGrant[],
  kind: ResellerGrantKind,
  subject: string | null,
): boolean {
  return all.some((g) => g.kind === kind && (g.subject === null || g.subject === subject));
}

/**
 * Whether a tier's grants allow one commercial action (`docs/wp9-reseller-audit.md` R5).
 *
 * DENY BY DEFAULT, per dimension: a dimension with no grant row allows nothing, and a grant
 * with a null subject allows every subject of its kind. Pure, so the one rule is stated once
 * and every caller — the catalogue, the draft, the confirmation, a commercial action —
 * asks it the same way.
 *
 * The dimensions are checked in a fixed order, so the refusal names the same dimension for
 * the same request every time: operation, catalogue, panel, bot. A null subject id (no
 * category, no bot) can only be allowed by a grant of every subject of that kind.
 */
export function decideEntitlement(
  all: readonly EntitlementGrant[],
  subject: EntitlementSubject,
): EntitlementDecision {
  if (!grants(all, 'OPERATION', subject.operation)) {
    return { allowed: false, dimension: 'OPERATION' };
  }
  const catalogue =
    grants(all, 'PRODUCT', subject.productId) ||
    (subject.categoryId !== null && grants(all, 'CATEGORY', subject.categoryId)) ||
    all.some((g) => g.kind === 'CATEGORY' && g.subject === null);
  if (!catalogue) return { allowed: false, dimension: 'CATALOGUE' };
  if (!grants(all, 'PANEL', subject.panelId)) return { allowed: false, dimension: 'PANEL' };
  const bot =
    subject.botInstanceId === null
      ? all.some((g) => g.kind === 'BOT' && g.subject === null)
      : grants(all, 'BOT', subject.botInstanceId);
  if (!bot) return { allowed: false, dimension: 'BOT' };
  return { allowed: true };
}

/**
 * What a reseller's catalogue may show, as sets the catalogue query can apply in SQL ahead
 * of its LIMIT (`docs/wp9-reseller-audit.md` R6: the catalogue is the courtesy caller).
 *
 * The same grants `decideEntitlement` reads, translated rather than re-decided: the
 * operation is `NEW_SERVICE` (browsing is buying something new) and the bot is the one the
 * customer is browsing through. `'ALL'` is a grant of every subject; an empty list is none.
 * A unit test holds this translation to `decideEntitlement` over a matrix of grants, so the
 * courtesy and the rule cannot drift apart silently.
 */
export interface CatalogueScope {
  /** False when the tier grants no new purchase through this bot: nothing is shown. */
  readonly shows: boolean;
  readonly productIds: readonly string[] | 'ALL';
  readonly categoryIds: readonly string[] | 'ALL';
  readonly panelIds: readonly string[] | 'ALL';
}

function subjects(
  all: readonly EntitlementGrant[],
  kind: ResellerGrantKind,
): readonly string[] | 'ALL' {
  if (all.some((g) => g.kind === kind && g.subject === null)) return 'ALL';
  return all.filter((g) => g.kind === kind && g.subject !== null).map((g) => g.subject as string);
}

export function catalogueScope(
  all: readonly EntitlementGrant[],
  botInstanceId: string | null,
): CatalogueScope {
  const operation = grants(all, 'OPERATION', 'NEW_SERVICE');
  const bot =
    botInstanceId === null
      ? all.some((g) => g.kind === 'BOT' && g.subject === null)
      : grants(all, 'BOT', botInstanceId);
  return {
    shows: operation && bot,
    productIds: subjects(all, 'PRODUCT'),
    categoryIds: subjects(all, 'CATEGORY'),
    panelIds: subjects(all, 'PANEL'),
  };
}
