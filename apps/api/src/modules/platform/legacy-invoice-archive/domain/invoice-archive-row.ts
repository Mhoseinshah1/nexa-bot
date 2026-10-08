import { createHash } from 'node:crypto';
import {
  LEGACY_INVOICE_PRICE_CURRENCY,
  isLegacyImportKey,
  type LegacyInvoiceArchiveClass,
  type LegacyInvoiceParseNote,
  type LegacyInvoiceProductRef,
  type LegacyInvoiceRevisionReason,
} from '@nexa/contracts';
import { parseLegacyTomanMinor } from '../../../commerce/legacy-product-review/domain/legacy-product-facts.js';
import { legacyCodePanel } from '../../legacy-importer/application/decisions.js';
import { LEGACY_LIVE_STATUSES } from '../../legacy-importer/application/source-port.js';

/**
 * Mirza migration PR3 — what ONE archived legacy invoice is (`docs/legacy-migration/
 * importer.md` §Invoice archive). Pure: no clock, no database, no I/O.
 *
 * - The RAW row is the cells verbatim, keyed by the source's own column names; nothing is
 *   trimmed, recoded or dropped. `rowChecksum` is over its canonical JSON.
 * - The NORMALISED fields each come from one named column by one deterministic rule — the
 *   importer's own where it has one (`legacyCodePanel`, the live statuses, the evidenced key
 *   shape, the trimmed product code) — or are NULL with a closed note. The historical price
 *   is METADATA: whole Toman as IRT minor units (owner decision 7), by the ONE legacy price
 *   grammar the product review reads it with. `time_sell` is read only as unix seconds.
 * - The CLASS is source-derived only (`classifyLegacyInvoice`), from the row and the `user`
 *   and `product` tables of the SAME snapshot (`InvoiceSourceContext`). Never from a panel
 *   map, a live inventory or NEXA's own data: those are the importer's adoption decision.
 *
 * Nothing here can create an order, a payment, a wallet entry, a service or revenue, and
 * this module imports nothing that could (`tests/unit/legacy-invoice-archive-boundary.test.ts`).
 */

/** Stored on every revision: the rules below. A change of rule is a new version. */
export const INVOICE_ARCHIVE_NORMALIZATION_VERSION = 'legacy-invoice-archive:v1';

/** One legacy `invoice` row: column name to the cell as read (`CAST(… AS CHAR)`), null for NULL. */
export type LegacyInvoiceRawRow = Readonly<Record<string, string | null>>;

/**
 * The longest key or indexed cell the archive stores. The legacy columns are varchar(200)
 * to varchar(300) in every public source; a longer value could not be held in a btree index
 * entry, so the run fails closed (`CELL_UNREPRESENTABLE`) rather than truncating it.
 */
export const INVOICE_ARCHIVE_MAX_INDEXED_LENGTH = 1000;

/** The columns whose cells become indexed fields (bounded by `INVOICE_ARCHIVE_MAX_INDEXED_LENGTH`). */
const INDEXED_COLUMNS = [
  'id_invoice',
  'id_user',
  'username',
  'Status',
  'code_panel',
  'code_product',
] as const;

const LIVE: ReadonlySet<string> = new Set(LEGACY_LIVE_STATUSES);

/**
 * Why a row cannot be held verbatim: a NUL character (PostgreSQL text and jsonb refuse it)
 * anywhere, or an indexed cell beyond the bound. Null when it can. Never a value: the
 * caller reports the column name only.
 */
export function unrepresentableColumn(row: LegacyInvoiceRawRow): string | null {
  for (const [column, cell] of Object.entries(row)) {
    if (cell !== null && cell.includes('\u0000')) return column;
  }
  for (const column of INDEXED_COLUMNS) {
    const cell = row[column];
    if (
      cell !== undefined &&
      cell !== null &&
      [...cell].length > INVOICE_ARCHIVE_MAX_INDEXED_LENGTH
    ) {
      return column;
    }
  }
  return null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Canonical JSON of the row: keys in code-unit order, values as read. */
export function canonicalInvoiceRow(row: LegacyInvoiceRawRow): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(row).sort()) out[key] = row[key] ?? null;
  return out;
}

/** SHA-256 over the canonical cells. Versioned: a change of canonicalisation is a new value. */
export function invoiceRowChecksum(row: LegacyInvoiceRawRow): string {
  return sha256(JSON.stringify({ v: 'legacy-invoice-row:v1', row: canonicalInvoiceRow(row) }));
}

/**
 * What the row's own snapshot says about the rows it names: whether `id_user` is a row of
 * the legacy `user` table (exact), and whether the trimmed `code_product` is a code of the
 * legacy `product` table (trimmed, as the importer's `productCodes`).
 */
export interface InvoiceSourceContext {
  readonly ownerPresent: boolean;
  readonly productInTable: boolean;
}

/**
 * The checksum a REVISION compares: the cells AND their source-derived context. An
 * unchanged invoice whose owner appeared in (or vanished from) the `user` table is a new
 * revision (`CONTEXT_CHANGED`): its class changed, and the archive keeps that history.
 */
export function invoiceArchiveChecksum(
  rowChecksum: string,
  context: InvoiceSourceContext,
  productRef: LegacyInvoiceProductRef,
): string {
  return sha256(
    JSON.stringify({
      v: 'legacy-invoice-archive-facts:v1',
      row: rowChecksum,
      ownerPresent: context.ownerPresent,
      productRef,
    }),
  );
}

function cell(row: LegacyInvoiceRawRow, column: string): string | null | undefined {
  return Object.prototype.hasOwnProperty.call(row, column) ? (row[column] ?? null) : undefined;
}

type Parsed<T> =
  | { readonly value: T; readonly note: null }
  | { readonly value: null; readonly note: LegacyInvoiceParseNote };

const noted = (note: LegacyInvoiceParseNote) => ({ value: null, note }) as const;

/** `price_product` as whole Toman → IRT minor units (`parseLegacyTomanMinor`). Metadata only. */
export function parseLegacyInvoicePrice(raw: string | null | undefined): Parsed<bigint> {
  if (raw === undefined) return noted('ABSENT');
  if (raw === null || raw.trim() === '') return noted('EMPTY');
  const parsed = parseLegacyTomanMinor(raw);
  return 'note' in parsed ? noted(parsed.note) : { value: parsed.value, note: null };
}

/**
 * The earliest and latest instants a `time_sell` is read as: 2015-01-01 and 2100-01-01
 * (UTC). A digit string outside them is OUT_OF_RANGE — a Jalali date written as digits
 * (`14030101`) or milliseconds must never become a wrong instant.
 */
export const TIME_SELL_EARLIEST_SECONDS = 1_420_070_400;
export const TIME_SELL_LATEST_SECONDS = 4_102_444_800;

/**
 * `time_sell` as an instant, in unix seconds (the repository stores it as `timestamptz`).
 * The ONE evidenced format: unix seconds, which both public
 * MirzaBot sources write (`$date = time()` before every `INSERT … time_sell`, and the
 * `ctype_digit($invoice['time_sell'])` check before subtracting it from `time()`). The
 * deployed fork is unproven (OQ-LIA-03): a `DATETIME`-style or any other text is
 * FORMAT_UNKNOWN and stays raw — never read in a guessed time zone.
 */
export function parseLegacyTimeSell(raw: string | null | undefined): Parsed<number> {
  if (raw === undefined) return noted('ABSENT');
  if (raw === null || raw.trim() === '') return noted('EMPTY');
  const text = raw.trim();
  if (!/^[0-9]{1,15}$/u.test(text)) return noted('FORMAT_UNKNOWN');
  const seconds = Number(text);
  if (seconds < TIME_SELL_EARLIEST_SECONDS || seconds >= TIME_SELL_LATEST_SECONDS) {
    return noted('OUT_OF_RANGE');
  }
  return { value: seconds, note: null };
}

/** `is_test` as the importer reads it: trimmed `1` / `0`; anything else is NULL (invalid). */
export function legacyTestFlag(raw: string | null | undefined): boolean | null {
  const text = raw?.trim() ?? null;
  return text === '1' ? true : text === '0' ? false : null;
}

/** `code_product` trimmed, as the importer matches it; NULL when NULL or blank. */
export function legacyInvoiceProductCode(raw: string | null | undefined): string | null {
  const text = raw?.trim() ?? '';
  return text === '' ? null : text;
}

export function legacyInvoiceProductRef(
  productCode: string | null,
  context: InvoiceSourceContext,
): LegacyInvoiceProductRef {
  if (productCode === null) return 'NONE';
  return context.productInTable ? 'NAMED' : 'NOT_IN_PRODUCT_TABLE';
}

/** The facts the class is decided from. */
export interface InvoiceClassFacts {
  readonly keyShapeEvidenced: boolean;
  readonly isTest: boolean | null;
  readonly ownerPresent: boolean;
  readonly live: boolean;
  readonly panelCode: string | null;
}

/**
 * The source-derived class, first match wins. For a LIVE invoice the first four steps are
 * exactly `decideServiceCandidate`'s source-only steps, in its order: the key shape
 * (INVOICE_KEY_INVALID), `is_test` = 1 (TEST_INVOICE_SKIPPED), `is_test` not 0/1
 * (INVALID_SOURCE_ROW), no such legacy user (ORPHAN) — pinned against it by
 * `tests/unit/legacy-invoice-archive-domain.test.ts`. Then a non-live invoice is history
 * the importer never decides, and an empty `code_panel` is owner decision 8: never adopted
 * automatically. Migration 0223's `legacy_invoice_archive_class_check` restates this order,
 * so a row whose class disagrees with its facts cannot be written.
 */
export function classifyLegacyInvoice(facts: InvoiceClassFacts): LegacyInvoiceArchiveClass {
  if (!facts.keyShapeEvidenced) return 'KEY_SHAPE_UNRECOGNISED';
  if (facts.isTest === true) return 'TEST';
  if (facts.isTest === null) return 'TEST_FLAG_INVALID';
  if (!facts.ownerPresent) return 'ORPHAN_OWNER';
  if (!facts.live) return 'NOT_LIVE';
  if (facts.panelCode === null) return 'NO_PANEL';
  return 'LIVE_CANDIDATE';
}

/**
 * The importer's own vocabulary for each class, for PR5's review workflows: the importer's
 * `ServiceCandidateCategory` a LIVE invoice of this class receives, or null where the
 * importer decides nothing yet (a non-live invoice), or decides more (a candidate: its
 * adoption outcome needs the panel map and the live inventory). `NO_PANEL` is null because
 * the importer today searches every production panel for an empty code — the conflict with
 * owner decision 8 that PR5 resolves.
 */
export const INVOICE_ARCHIVE_CLASS_IMPORTER_CATEGORY: Readonly<
  Record<LegacyInvoiceArchiveClass, string | null>
> = {
  KEY_SHAPE_UNRECOGNISED: 'INVOICE_KEY_INVALID',
  TEST: 'TEST_INVOICE_SKIPPED',
  TEST_FLAG_INVALID: 'INVALID_SOURCE_ROW',
  ORPHAN_OWNER: 'ORPHAN',
  NOT_LIVE: null,
  NO_PANEL: null,
  LIVE_CANDIDATE: null,
};

/** Every normalised field of one revision, as the archive stores it. */
export interface NormalisedLegacyInvoice {
  readonly invoiceKey: string;
  readonly keyShapeEvidenced: boolean;
  readonly rowChecksum: string;
  readonly archiveChecksum: string;
  readonly classification: LegacyInvoiceArchiveClass;
  readonly live: boolean;
  readonly status: string | null;
  readonly isTest: boolean | null;
  readonly legacyUserId: string | null;
  readonly ownerPresent: boolean;
  readonly username: string | null;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly productRef: LegacyInvoiceProductRef;
  readonly productName: string | null;
  readonly priceRaw: string | null;
  readonly priceMinor: bigint | null;
  readonly priceCurrency: typeof LEGACY_INVOICE_PRICE_CURRENCY | null;
  readonly priceNote: LegacyInvoiceParseNote | null;
  readonly soldAtRaw: string | null;
  /** Unix seconds (UTC by definition); NULL with `soldAtNote` when not read. */
  readonly soldAtEpochSeconds: number | null;
  readonly soldAtNote: LegacyInvoiceParseNote | null;
}

/** Normalises one staged row against its snapshot's context. Throws on a row without a key. */
export function normaliseLegacyInvoice(
  row: LegacyInvoiceRawRow,
  context: InvoiceSourceContext,
): NormalisedLegacyInvoice {
  const invoiceKey = row['id_invoice'];
  if (invoiceKey === undefined || invoiceKey === null) {
    throw new Error('a legacy invoice row has no id_invoice');
  }
  const status = cell(row, 'Status') ?? null;
  const live = status !== null && LIVE.has(status);
  const isTest = legacyTestFlag(cell(row, 'is_test'));
  const keyShapeEvidenced = isLegacyImportKey('invoice', invoiceKey);
  const panelCode = legacyCodePanel(cell(row, 'code_panel') ?? null);
  const productCode = legacyInvoiceProductCode(cell(row, 'code_product'));
  const productRef = legacyInvoiceProductRef(productCode, context);
  const rowChecksum = invoiceRowChecksum(row);
  const price = parseLegacyInvoicePrice(cell(row, 'price_product'));
  const sold = parseLegacyTimeSell(cell(row, 'time_sell'));
  return {
    invoiceKey,
    keyShapeEvidenced,
    rowChecksum,
    archiveChecksum: invoiceArchiveChecksum(rowChecksum, context, productRef),
    classification: classifyLegacyInvoice({
      keyShapeEvidenced,
      isTest,
      ownerPresent: context.ownerPresent,
      live,
      panelCode,
    }),
    live,
    status,
    isTest,
    legacyUserId: cell(row, 'id_user') ?? null,
    ownerPresent: context.ownerPresent,
    username: cell(row, 'username') ?? null,
    panelCode,
    productCode,
    productRef,
    productName: cell(row, 'name_product') ?? null,
    priceRaw: cell(row, 'price_product') ?? null,
    priceMinor: price.value,
    priceCurrency: price.value === null ? null : LEGACY_INVOICE_PRICE_CURRENCY,
    priceNote: price.note,
    soldAtRaw: cell(row, 'time_sell') ?? null,
    soldAtEpochSeconds: sold.value,
    soldAtNote: sold.note,
  };
}

/** The archive's latest revision of a key, as the revision decision needs it. */
export interface LatestRevision {
  readonly revision: number;
  readonly rowChecksum: string;
  readonly archiveChecksum: string;
}

export type RevisionDecision =
  | { readonly kind: 'UNCHANGED' }
  | {
      readonly kind: 'APPEND';
      readonly revision: number;
      readonly reason: LegacyInvoiceRevisionReason;
    };

/**
 * Whether a staged row appends a revision. Identical facts write nothing; anything else is
 * revision n+1 — never an UPDATE of revision n.
 */
export function decideRevision(
  latest: LatestRevision | null,
  staged: { readonly rowChecksum: string; readonly archiveChecksum: string },
): RevisionDecision {
  if (latest === null) return { kind: 'APPEND', revision: 1, reason: 'FIRST_SEEN' };
  if (latest.archiveChecksum === staged.archiveChecksum) return { kind: 'UNCHANGED' };
  return {
    kind: 'APPEND',
    revision: latest.revision + 1,
    reason: latest.rowChecksum === staged.rowChecksum ? 'CONTEXT_CHANGED' : 'ROW_CHANGED',
  };
}

/** The archive cells a reader without `legacy.invoices.pii.view` sees: PII columns nulled. */
export function redactInvoiceRow(
  row: LegacyInvoiceRawRow,
  piiColumns: readonly string[],
): { readonly raw: Record<string, string | null>; readonly redacted: readonly string[] } {
  const raw: Record<string, string | null> = {};
  const redacted: string[] = [];
  for (const [column, value] of Object.entries(row)) {
    if (piiColumns.includes(column)) {
      raw[column] = null;
      redacted.push(column);
    } else {
      raw[column] = value ?? null;
    }
  }
  return { raw, redacted: redacted.sort() };
}
