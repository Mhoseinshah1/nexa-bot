import { createHash } from 'node:crypto';
import {
  LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY,
  MAX_DURATION_DAYS,
  MAX_MONEY_AMOUNT_MINOR,
  MAX_TRAFFIC_BYTES,
  parseTrafficGb,
  type LegacyProductParseNote,
  type LegacyProductParsedField,
  type LegacyProductSourceConflict,
} from '@nexa/contracts';

/**
 * Mirza migration PR2 — what one legacy product code IS, as the review keeps it
 * (`docs/legacy-product-review-design.md` §4). Pure: no clock, no database, no I/O.
 *
 * - The FACTS are the legacy cells verbatim, one object per legacy row naming the code
 *   (normally one), keyed by the source's own column names. Nothing is trimmed, recoded or
 *   dropped. The checksum is over their canonical JSON, and an approval binds to it.
 * - The PARSED fields are a proposal the operator sees and may edit when creating a draft.
 *   Each comes from one named legacy column by one deterministic grammar — the same ones
 *   NEXA already applies to legacy invoices (`legacyShapeKey`: decimal GB, whole days) — or
 *   is null with a closed parse note. `0` is never read as "unlimited" (OQ-LPR-02).
 * - The historical price is METADATA. The owner stated Mirza prices are Toman (decision 7,
 *   2026-10-07): IRT, minor exponent 0, so a whole number of Toman is that many minor units.
 *   The raw cell is kept verbatim beside it. Nothing here produces a selling price, and this
 *   module imports nothing from pricing (`tests/unit/legacy-products-boundary.test.ts`).
 */

/** One legacy row: column name to the cell as read (`CAST(… AS CHAR)`), null for SQL NULL. */
export type LegacyProductFactRow = Readonly<Record<string, string | null>>;

/** The legacy columns each parsed field is read from. A column absent from the source is `ABSENT`. */
export const LEGACY_PRODUCT_FIELD_COLUMNS: Readonly<Record<LegacyProductParsedField, string>> = {
  title: 'name_product',
  trafficBytes: 'Volume_constraint',
  durationDays: 'Service_time',
  historicalPrice: 'price_product',
};

export const LEGACY_PRODUCT_CODE_MAX_LENGTH = 200;

/**
 * The review key of a legacy `code_product`: trimmed exactly as the importer matches an
 * invoice's code (`decideServiceCandidate`), and admissible to the panel map's `products`
 * section (trimmed, 1-200 characters, no control character). Anything else names no
 * reviewable product: an empty code takes the importer's hidden-shape path, and an invalid
 * one could never be written into the map.
 */
export function legacyProductCode(
  raw: string | null,
):
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: 'CODE_EMPTY' | 'CODE_INVALID' } {
  const code = (raw ?? '').trim();
  if (code === '') return { ok: false, reason: 'CODE_EMPTY' };
  if ([...code].length > LEGACY_PRODUCT_CODE_MAX_LENGTH) {
    return { ok: false, reason: 'CODE_INVALID' };
  }
  if (/\p{Cc}/u.test(code)) return { ok: false, reason: 'CODE_INVALID' };
  return { ok: true, code };
}

/** Canonical JSON of one row: keys in code-unit order, values as read. */
function canonicalRow(row: LegacyProductFactRow): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of Object.keys(row).sort()) out[key] = row[key] ?? null;
  return out;
}

/** The facts of one code, rows in the order given (the read set's primary-key byte order). */
export function canonicalFacts(
  rows: readonly LegacyProductFactRow[],
): Record<string, string | null>[] {
  if (rows.length === 0) throw new Error('a legacy product code has at least one row');
  return rows.map(canonicalRow);
}

/** SHA-256 over the canonical facts. Versioned, so a change of canonicalisation is a new value. */
export function legacyProductFactsChecksum(rows: readonly LegacyProductFactRow[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: 'legacy-product-facts:v1', rows: canonicalFacts(rows) }))
    .digest('hex');
}

export interface ParsedLegacyProduct {
  readonly sourceConflict: LegacyProductSourceConflict | null;
  readonly title: string | null;
  readonly trafficBytes: bigint | null;
  readonly durationDays: number | null;
  /** The `price_product` cell verbatim; null when absent, NULL, or the code is conflicted. */
  readonly historicalPriceRaw: string | null;
  /** Metadata only. Whole Toman as IRT minor units, or null with a note. */
  readonly historicalPrice: {
    readonly amountMinor: bigint;
    readonly currency: typeof LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY;
  } | null;
  readonly parseNotes: Partial<Record<LegacyProductParsedField, LegacyProductParseNote>>;
}

type Parsed<T> = { readonly value: T } | { readonly note: LegacyProductParseNote };

function cellOf(row: LegacyProductFactRow, column: string): Parsed<string> {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return { note: 'ABSENT' };
  const value = row[column] ?? null;
  if (value === null || value.trim() === '') return { note: 'EMPTY' };
  return { value };
}

function parseTitle(row: LegacyProductFactRow): Parsed<string> {
  const cell = cellOf(row, LEGACY_PRODUCT_FIELD_COLUMNS.title);
  return 'note' in cell ? cell : { value: cell.value.trim() };
}

/** Decimal GB (at most two places), 1 GB = 1 GiB — the grammar `legacyShapeKey` reads `Volume` by. */
function parseTraffic(row: LegacyProductFactRow): Parsed<bigint> {
  const cell = cellOf(row, LEGACY_PRODUCT_FIELD_COLUMNS.trafficBytes);
  if ('note' in cell) return cell;
  const bytes = parseTrafficGb(cell.value.trim());
  if (bytes === null) return { note: 'NOT_A_NUMBER' };
  if (bytes > MAX_TRAFFIC_BYTES) return { note: 'OUT_OF_RANGE' };
  if (bytes === 0n) return { note: 'ZERO_MEANING_UNKNOWN' };
  return { value: bytes };
}

/** Whole days, as `legacyShapeKey` reads `Service_time` (with no unit column on a product). */
function parseDuration(row: LegacyProductFactRow): Parsed<number> {
  const cell = cellOf(row, LEGACY_PRODUCT_FIELD_COLUMNS.durationDays);
  if ('note' in cell) return cell;
  const text = cell.value.trim();
  if (!/^[0-9]{1,6}$/u.test(text)) return { note: 'NOT_A_NUMBER' };
  const days = Number(text);
  if (days === 0) return { note: 'ZERO_MEANING_UNKNOWN' };
  if (days > MAX_DURATION_DAYS) return { note: 'OUT_OF_RANGE' };
  return { value: days };
}

/**
 * A whole, non-negative number of Toman in ASCII digits. `150000.5`, `150,000`, `۱۵۰۰۰۰`,
 * `-1` and `1e5` are NOT_A_NUMBER: each needs a person to say what it meant. A zero is a
 * stated price of zero and is kept as such (it is never a tariff either way).
 */
function parsePrice(row: LegacyProductFactRow): Parsed<bigint> {
  const cell = cellOf(row, LEGACY_PRODUCT_FIELD_COLUMNS.historicalPrice);
  if ('note' in cell) return cell;
  const text = cell.value.trim();
  if (!/^[0-9]{1,19}$/u.test(text)) return { note: 'NOT_A_NUMBER' };
  const amount = BigInt(text);
  if (amount > MAX_MONEY_AMOUNT_MINOR) return { note: 'OUT_OF_RANGE' };
  return { value: amount };
}

/** Parses one code's facts. A duplicated code parses nothing: the rows disagree or may. */
export function parseLegacyProduct(rows: readonly LegacyProductFactRow[]): ParsedLegacyProduct {
  if (rows.length === 0) throw new Error('a legacy product code has at least one row');
  if (rows.length > 1) {
    return {
      sourceConflict: 'CODE_DUPLICATED',
      title: null,
      trafficBytes: null,
      durationDays: null,
      historicalPriceRaw: null,
      historicalPrice: null,
      parseNotes: {
        title: 'SOURCE_CONFLICT',
        trafficBytes: 'SOURCE_CONFLICT',
        durationDays: 'SOURCE_CONFLICT',
        historicalPrice: 'SOURCE_CONFLICT',
      },
    };
  }
  const row = rows[0] as LegacyProductFactRow;
  const notes: Partial<Record<LegacyProductParsedField, LegacyProductParseNote>> = {};
  const take = <T>(field: LegacyProductParsedField, parsed: Parsed<T>): T | null => {
    if ('note' in parsed) {
      notes[field] = parsed.note;
      return null;
    }
    return parsed.value;
  };
  const title = take('title', parseTitle(row));
  const trafficBytes = take('trafficBytes', parseTraffic(row));
  const durationDays = take('durationDays', parseDuration(row));
  const price = take('historicalPrice', parsePrice(row));
  const priceColumn = LEGACY_PRODUCT_FIELD_COLUMNS.historicalPrice;
  return {
    sourceConflict: null,
    title,
    trafficBytes,
    durationDays,
    historicalPriceRaw: Object.prototype.hasOwnProperty.call(row, priceColumn)
      ? (row[priceColumn] ?? null)
      : null,
    historicalPrice:
      price === null
        ? null
        : { amountMinor: price, currency: LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY },
    parseNotes: notes,
  };
}
