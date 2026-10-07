/**
 * Mirza migration PR1 — what NEXA knows about each table of the legacy MirzaBot database
 * (`docs/legacy-migration/table-inventory.md`).
 *
 * The importer reads three tables. The legacy database has more, and before a later read
 * set touches any of them each needs a reviewed answer to one question: what may NEXA do
 * with this table? The answer is a CLASS:
 *
 * - `SUPPORTED` — a NEXA read set reads rows of it, column by column from an allowlist, and
 *   decides from them (today: the v1 import read set).
 * - `ARCHIVE` — kept as read-only history (an explicit column allowlist, never a decision),
 *   once a reviewed commit says which columns are safe to keep.
 * - `SECRETS_MANUAL` — holds, or may hold, a credential (panel passwords, a bot token, card
 *   numbers, gateway keys, subscription links). Never read beyond its name, its column
 *   names and its row count; anything in it is carried over by a person, by hand.
 * - `OWNER_DECISION` — its meaning or its fate is the owner's call, recorded in
 *   `docs/open-questions.md`; nothing reads it until that call is made.
 * - `UNCLASSIFIED` — nobody has decided. The DEFAULT for every table not in the catalogue
 *   below, and it FAILS CLOSED: an inventory with one is not complete, and no read set may
 *   read its rows.
 *
 * The catalogue classifies only what the repository PROVES. The table names other Mirza
 * revisions are known to have (`setting`, `marzban_panel`, `Payment_report`, …) are NOT
 * classified here, deliberately: their columns, and which of them hold secrets, are UNKNOWN
 * (`docs/open-questions.md` OQ-MZ-INV). A table joins the catalogue in its own reviewed
 * commit, with the evidence named in `evidence`.
 */

export const LEGACY_TABLE_CLASSES = [
  'SUPPORTED',
  'ARCHIVE',
  'SECRETS_MANUAL',
  'OWNER_DECISION',
  'UNCLASSIFIED',
] as const;
export type LegacyTableClass = (typeof LEGACY_TABLE_CLASSES)[number];

/** The classes whose rows a read set may read. Every other class: names and counts only. */
export const LEGACY_ROW_READABLE_TABLE_CLASSES = [
  'SUPPORTED',
  'ARCHIVE',
] as const satisfies readonly LegacyTableClass[];

export interface LegacyTableClassification {
  readonly class: LegacyTableClass;
  /** Why, in one sentence a reviewer can check against `evidence`. */
  readonly reason: string;
  /** Where the repository proves it: a path, a migration, a query id. */
  readonly evidence: string;
}

/**
 * The frozen catalogue: legacy table name (exact, case-sensitive — MySQL on Linux compares
 * table names by bytes) to its class. `UNCLASSIFIED` never appears as an entry: it is what
 * an absent entry means.
 */
export const LEGACY_TABLE_CLASSIFICATION: Readonly<
  Record<string, Readonly<LegacyTableClassification>>
> = Object.freeze({
  user: Object.freeze({
    class: 'SUPPORTED',
    reason:
      'Read by the v1 import read set (id, Balance, limit_usertest; agent, number, username when present).',
    evidence:
      'IMPORT_READ_SET_V1 (legacy-importer/application/source-port.ts); sql-evidence.md Q1–Q7',
  }),
  invoice: Object.freeze({
    class: 'SUPPORTED',
    reason: 'Read by the v1 import read set: the service candidates and the trial evidence.',
    evidence:
      'IMPORT_READ_SET_V1 (legacy-importer/application/source-port.ts); sql-evidence.md Q1–Q7',
  }),
  product: Object.freeze({
    class: 'SUPPORTED',
    reason:
      'Read by the v1 import read set (id, code_product; agent when present) and by the products read set (an explicit column allowlist, for the legacy product review).',
    evidence:
      'IMPORT_READ_SET_V1 (legacy-importer/application/source-port.ts); PRODUCTS_READ_SET (legacy-importer/application/products-read-set.ts)',
  }),
  nexa_synthetic_fixture: Object.freeze({
    class: 'SUPPORTED',
    reason:
      "NEXA's own SYNTHETIC marker: read by the importer to force the synthetic evidence class. A real archive never has it.",
    evidence: 'LEGACY_SYNTHETIC_MARKER_TABLE; tests/fixtures/legacy/synthetic-legacy.ts',
  }),
});

const UNCLASSIFIED: Readonly<LegacyTableClassification> = Object.freeze({
  class: 'UNCLASSIFIED',
  reason: 'Not in the reviewed catalogue: nothing may read its rows until a commit classifies it.',
  evidence: 'none',
});

/** A table's class: the catalogue's entry, or `UNCLASSIFIED`. Own entries only. */
export function classifyLegacyTable(name: string): Readonly<LegacyTableClassification> {
  return Object.prototype.hasOwnProperty.call(LEGACY_TABLE_CLASSIFICATION, name)
    ? (LEGACY_TABLE_CLASSIFICATION[name] as Readonly<LegacyTableClassification>)
    : UNCLASSIFIED;
}

/** Whether a read set may read this table's ROWS (names and counts are always allowed). */
export function isLegacyTableRowReadable(name: string): boolean {
  return (LEGACY_ROW_READABLE_TABLE_CLASSES as readonly string[]).includes(
    classifyLegacyTable(name).class,
  );
}

/**
 * The read sets whose fingerprints NEXA records (`legacy_read_set_runs.read_set`, pinned by
 * a CHECK). Each is a separate, versioned read of the legacy source with its own allowlist
 * and its own fingerprint, `legacy-read-set:<name>:v<version>` — never a widening of the
 * frozen v1 import read set. A name joins this set with the read set that uses it.
 *
 * - `inventory` — every table's name, class-free shape (column names and types), exact
 *   `COUNT(*)`, charset and collation. No row values.
 * - `products` — the legacy `product` table's rows, from an explicit column allowlist, read
 *   into the legacy product review (`legacy_product_reviews`, Mirza PR2,
 *   `docs/legacy-product-review-design.md`). Never a price, a panel or a sale in NEXA.
 */
export const LEGACY_READ_SET_NAMES = ['inventory', 'products'] as const;
export type LegacyReadSetName = (typeof LEGACY_READ_SET_NAMES)[number];

/** `legacy-read-set:<name>:v<version>`: a read set fingerprint's version string. */
export const LEGACY_READ_SET_VERSION_PATTERN =
  /^legacy-read-set:[a-z][a-z0-9-]{0,31}:v[1-9][0-9]{0,3}$/;

export function legacyReadSetFingerprintVersion(name: string, version: number): string {
  const value = `legacy-read-set:${name}:v${String(version)}`;
  if (!Number.isInteger(version) || !LEGACY_READ_SET_VERSION_PATTERN.test(value)) {
    throw new Error('not a read set name and version');
  }
  return value;
}
