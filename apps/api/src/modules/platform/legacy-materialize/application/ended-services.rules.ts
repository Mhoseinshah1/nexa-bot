import { legacyShapeKey } from '../../../commerce/catalog/application/legacy-shape.js';
import { LEGACY_NEVER_PAID_STATUSES } from '../../legacy-importer/application/source-port.js';

/**
 * The one-time Mirza import, services (owner decision 2026-10-17,
 * `docs/migration/mirza-import-plan-fa.md` §6): what becomes of each archived invoice once the
 * importer's own phases have run. Pure; no I/O.
 *
 * Four fates, and every invoice gets exactly one:
 *
 * - ADOPTED   the importer found the account on the read-only panel inventory and made it a
 *             live NEXA service (`legacy_import_map` IMPORTED / SERVICE). This step writes
 *             nothing for it.
 * - ENDED     the account is NOT on the panel after a complete inventory read (the importer
 *             recorded `PROVIDER_MISSING`), or the invoice is a Mirza test invoice
 *             (`HISTORY_NOT_IMPORTED`): a TERMINATED service and a `LEGACY_HISTORY` order.
 * - NEVER_PAID the invoice was never paid (`unpaid`, `Unsuccessful`, or no status at all):
 *             never a service, but still an ORDER — a `LEGACY_HISTORY` order in a terminal
 *             unpaid state (`neverPaidOrderState`), with no service, payment or money
 *             (owner instruction 2026-10-18: nothing is left only in the archive).
 * - GAP       neither, with a closed reason. A gap is a decision somebody still owes or a fact
 *             the importer could not read; it is counted in the exact-match report and never
 *             invented away.
 *
 * What is deliberately NOT here: a reason for a map row this module does not know. An
 * unknown reason, or no map row at all, is `UNEXPLAINED` — it is left out of the explained
 * gaps on purpose, so the exact-match report shows it as the unexplained difference it is.
 */

/** The reasons an invoice is not carried, as the exact-match report spells them. */
export const ENDED_SERVICE_GAP_REASONS = [
  /**
   * `unpaid` / `Unsuccessful`, or no status: the order never completed, so it was never a
   * service. A gap of the SERVICES row only: the invoice is an order (or one of the
   * `NEVER_PAID_ORDER_GAP_REASONS` when even the order cannot be written honestly).
   */
  'NEVER_PAID',
  /** The key is outside the evidenced shape: the import map cannot hold a decision for it. */
  'INVOICE_KEY_INVALID',
  /**
   * The invoice names no `code_panel`, and no connected panel holds its account (owner rule
   * 2026-10-18: one holder attaches it). Ended and archived exactly as an unmapped code is
   * (`PANEL_NOT_MAPPED`): the archive row, no service — an ended service names a panel.
   */
  'NO_PANEL',
  /** The `code_panel` has no NEXA panel bound to it (no panel to attach a service to). */
  'PANEL_NOT_MAPPED',
  /** On a panel the operator declared a test panel: not imported. */
  'TEST_PANEL',
  /** A panel's inventory is not complete: the account is neither present nor absent. */
  'INVENTORY_HELD',
  /** Several owners claim the account, or the ownership evidence is not proven. */
  'AMBIGUOUS_OWNERSHIP',
  /** The invoice's owner is not a NEXA customer (an orphan, or a user the import refused). */
  'OWNER_NOT_IMPORTED',
  /** The account is on the panel but could not be adopted: product, shape or subscription. */
  'ON_PANEL_NOT_ADOPTABLE',
  /** Two accounts on the panel, or two spellings of one: which one is the invoice's is a guess. */
  'PANEL_ACCOUNT_AMBIGUOUS',
  /** A value the importer will not compare (an unusable username, a bad test flag). */
  'INVALID_SOURCE_ROW',
  /** The provider record could not be read; a rerun with a fresh read decides again. */
  'PROVIDER_READ_FAILED',
  /** The shape (volume, duration) is not one the import can name: no product to attach. */
  'SHAPE_UNMAPPABLE',
  /** The shape is mappable, but no product stands for it (the products phase did not run). */
  'PRODUCT_NOT_RESOLVED',
  /**
   * The importer adopted the account as a live service. Its order is the free
   * `LEGACY_ADOPTION` one and deliberately does NOT carry the invoice's amount: a refund path
   * could compute from it. The row is in NEXA; the money is the gap.
   */
  'ADOPTED_AMOUNT_NOT_CARRIED',
] as const;
export type EndedServiceGapReason = (typeof ENDED_SERVICE_GAP_REASONS)[number];

/**
 * Why a never-paid invoice is not an order either: each is a fact the order cannot be written
 * without, and none is invented (an order names its customer, its panel and its product —
 * `orders_customer_fk`, `panel_id NOT NULL`, `orders_product_purpose_check`).
 */
export const NEVER_PAID_ORDER_GAP_REASONS = [
  /** The key is outside the evidenced shape: as for a paid invoice, nothing is keyed by it. */
  'NEVER_PAID_KEY_INVALID',
  /** The invoice's owner is not a NEXA customer: an order cannot name nobody. */
  'NEVER_PAID_OWNER_NOT_IMPORTED',
  /** The invoice names no `code_panel`. */
  'NEVER_PAID_NO_PANEL',
  /** The `code_panel` has no NEXA panel bound to it. */
  'NEVER_PAID_PANEL_NOT_MAPPED',
  /** The shape (volume, duration) is not one the import can name. */
  'NEVER_PAID_SHAPE_UNMAPPABLE',
  /**
   * The shape is mappable but no hidden product stands for it: the importer creates a shape
   * product for every invoice that was ever PAID, so a shape only a never-paid invoice had
   * has none, and an order cannot point at a product that does not exist.
   */
  'NEVER_PAID_PRODUCT_NOT_RESOLVED',
] as const;
export type NeverPaidOrderGapReason = (typeof NEVER_PAID_ORDER_GAP_REASONS)[number];

/**
 * The exact-match bucket for the AMOUNTS of the never-paid invoices that ARE orders. The row
 * is carried (it counts as a NEXA row), but its amount was never paid, so the orders row's
 * NEXA money is the PAID orders' only and this bucket names the rest: an EXPIRED or CANCELLED
 * order's amount is never added to what was paid. Rows 0: the rows are NEXA's.
 */
export const NEVER_PAID_AMOUNT_BUCKET = 'NEVER_PAID_AMOUNT_NOT_REVENUE';

/** The terminal state a never-paid invoice's order is recorded in. */
export type NeverPaidOrderState = 'EXPIRED' | 'CANCELLED';

/**
 * The state mapping for a never-paid invoice (owner instruction 2026-10-18), deterministic:
 *
 * - `unpaid` -> EXPIRED. Mirza's own label for an invoice issued and never paid; its
 *   retention deletes one after 5 days unpaid (`docs/research/
 *   mirzabottelegramloggroupinvestigationcomplete/telegram-log-group-rebuild-recommendation.md`,
 *   "unpaid invoice 5 days -> delete"). Nobody ended it; the time to pay ran out, which is
 *   exactly NEXA's EXPIRED ("the payment window closed with no payment").
 * - `Unsuccessful` -> CANCELLED. A failed attempt (`LEGACY_NEVER_PAID_STATUSES`: "an unpaid
 *   order and a failed one"): a verdict that ended the order, not a clock that ran out. NEXA
 *   has no FAILED order state, and CANCELLED is its one terminal unpaid state that is not the
 *   clock. What Mirza did to reach it (a gateway refusal, a rejected receipt) is not evidenced;
 *   the choice of CANCELLED over EXPIRED is a JUDGEMENT on the word, said here as one.
 * - no status (NULL) -> EXPIRED. A GUESS, stated as one: nothing evidences what a NULL status
 *   means. The importer already treats it as never paid (it is never a service candidate),
 *   and EXPIRED is the state that claims the least — no payment, and no actor who ended it.
 *
 * Anything else is not a never-paid status and returns null.
 */
export function neverPaidOrderState(status: string | null): NeverPaidOrderState | null {
  if (status === null) return 'EXPIRED';
  if (status === 'unpaid') return 'EXPIRED';
  if (status === 'Unsuccessful') return 'CANCELLED';
  return null;
}

/** What the importer's map says about one invoice (`legacy_import_map`, table `invoice`). */
export interface InvoiceMapFact {
  readonly status: string;
  readonly reasonCode: string | null;
  readonly entityType: string | null;
}

/** The archived facts a fate is decided from. */
export interface ArchivedInvoice {
  readonly invoiceKey: string;
  readonly keyShapeEvidenced: boolean;
  readonly status: string | null;
  readonly isTest: boolean | null;
  readonly panelCode: string | null;
}

export type InvoiceFate =
  | { readonly kind: 'ADOPTED' }
  | { readonly kind: 'ENDED'; readonly test: boolean }
  | { readonly kind: 'NEVER_PAID'; readonly state: NeverPaidOrderState }
  | { readonly kind: 'GAP'; readonly reason: EndedServiceGapReason }
  | { readonly kind: 'UNEXPLAINED'; readonly why: string };

const NEVER_PAID: ReadonlySet<string> = new Set(LEGACY_NEVER_PAID_STATUSES);

/** The map reasons that are an outcome the importer recorded as a closed gap. */
const MAP_REASON_GAP: Readonly<Record<string, EndedServiceGapReason>> = {
  TEST_PANEL: 'TEST_PANEL',
  INVENTORY_INCOMPLETE: 'INVENTORY_HELD',
  CONFLICTING_EXISTING_ENTITY: 'AMBIGUOUS_OWNERSHIP',
  CUSTOMER_MISSING: 'OWNER_NOT_IMPORTED',
  AMBIGUOUS_PANEL: 'PANEL_ACCOUNT_AMBIGUOUS',
  USERNAME_CASE_COLLISION: 'PANEL_ACCOUNT_AMBIGUOUS',
  PRODUCT_MAPPING_UNRESOLVED: 'ON_PANEL_NOT_ADOPTABLE',
  UNSUPPORTED_SHAPE: 'ON_PANEL_NOT_ADOPTABLE',
  SUBSCRIPTION_REF_BLOCKED: 'ON_PANEL_NOT_ADOPTABLE',
  INVALID_SOURCE_ROW: 'INVALID_SOURCE_ROW',
  PROVIDER_READ_FAILED: 'PROVIDER_READ_FAILED',
};

/**
 * The fate of one archived invoice, from the archive row and the importer's map row for it.
 *
 * Order matters and is the contract: an invoice that was never paid is never looked up in the
 * map (the importer did not consider it) and is never a service, whatever the map says — it is
 * NEVER_PAID, an order at most; a key outside the evidenced shape cannot have a map row; then
 * the map decides.
 */
export function fateOfInvoice(
  invoice: ArchivedInvoice,
  map: InvoiceMapFact | undefined,
): InvoiceFate {
  if (invoice.status === null || NEVER_PAID.has(invoice.status)) {
    const state = neverPaidOrderState(invoice.status);
    // `LEGACY_NEVER_PAID_STATUSES` and the mapping are one list: a status added to one and
    // not the other is refused here rather than given a state nobody chose.
    if (state === null)
      return { kind: 'UNEXPLAINED', why: `NEVER_PAID_UNMAPPED:${invoice.status}` };
    return { kind: 'NEVER_PAID', state };
  }
  if (!invoice.keyShapeEvidenced) return { kind: 'GAP', reason: 'INVOICE_KEY_INVALID' };
  if (map === undefined) return { kind: 'UNEXPLAINED', why: 'NO_MAP_ROW' };

  if (map.status === 'IMPORTED') {
    return map.entityType === 'SERVICE'
      ? { kind: 'ADOPTED' }
      : { kind: 'UNEXPLAINED', why: 'IMPORTED_AS_OTHER_ENTITY' };
  }
  const reason = map.reasonCode;
  if (map.status === 'SKIPPED') {
    if (reason === 'HISTORY_NOT_IMPORTED') return { kind: 'ENDED', test: true };
    if (reason === 'TEST_PANEL') return { kind: 'GAP', reason: 'TEST_PANEL' };
    return { kind: 'UNEXPLAINED', why: `SKIPPED:${reason ?? 'NONE'}` };
  }
  if (map.status === 'MANUAL_REVIEW' || map.status === 'FAILED') {
    if (reason === 'PROVIDER_MISSING') return { kind: 'ENDED', test: false };
    if (reason === 'PANEL_UNMAPPED') {
      // The matcher records an empty `code_panel` and an unmapped one the same way; the
      // archive tells them apart.
      return {
        kind: 'GAP',
        reason: invoice.panelCode === null ? 'NO_PANEL' : 'PANEL_NOT_MAPPED',
      };
    }
    const gap = reason === null ? undefined : MAP_REASON_GAP[reason];
    if (gap !== undefined) return { kind: 'GAP', reason: gap };
  }
  return { kind: 'UNEXPLAINED', why: `${map.status}:${reason ?? 'NONE'}` };
}

/** The archive's cells an ended service's shape is read from. */
export interface ShapeCells {
  readonly codePanel: string | null;
  readonly volume: string | null;
  readonly serviceTime: string | null;
  readonly timeUnit: string | null;
  readonly isCustom: string | null;
}

/**
 * The hidden shape product that stands for an ended invoice's tariff, as its key — or why none
 * can. Same canonicalisation the importer's products phase creates the shape under.
 */
export function shapeKeyOfCells(
  cells: ShapeCells,
): { readonly ok: true; readonly key: string } | { readonly ok: false } {
  const keyed = legacyShapeKey({
    codePanel: cells.codePanel,
    volume: cells.volume,
    serviceTime: cells.serviceTime,
    timeUnit: cells.timeUnit,
    isCustom: cells.isCustom,
  });
  return keyed.ok ? { ok: true, key: keyed.key } : { ok: false };
}

/** The `source_ref` both the order and the service of an invoice carry. */
export function invoiceSourceRef(invoiceKey: string): string {
  return `invoice:${invoiceKey}`;
}

/** The prefix of a never-paid invoice's order ref. */
export const NEVER_PAID_REF_PREFIX = 'invoice-never-paid:';

/**
 * The `source_ref` of a never-paid invoice's order: `invoice-never-paid:<id_invoice>`. Never
 * `invoice:<id>`, which is a PAID invoice's (an adopted or an ended service and its order), so
 * the two can never collide: should a later snapshot show the same invoice paid, its order and
 * service take `invoice:<id>` and this row is not in their way (the exact-match row then counts
 * both, and fails, which is the truth). It is also not matched by `LIKE 'invoice:%'`, so no
 * reader of paid invoice refs (adoption's `invoiceCarried`, the discount-usage step's order
 * lookup) ever mistakes an unpaid order for a paid one.
 */
export function neverPaidSourceRef(invoiceKey: string): string {
  return `${NEVER_PAID_REF_PREFIX}${invoiceKey}`;
}

/**
 * The name an ended service is recorded under: the invoice's own, verbatim and trimmed, or —
 * when the invoice carries none — a name that says so. Never an invented account: a TERMINATED
 * service has no account anywhere, and `services_panel_provider_username_key` ignores it.
 */
export function endedServiceUsername(raw: string | null, invoiceKey: string): string {
  const trimmed = raw?.trim() ?? '';
  const name = trimmed === '' ? `mirza-${invoiceKey}` : trimmed;
  return [...name].slice(0, 128).join('');
}
