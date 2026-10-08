import {
  defineLegacyReadSet,
  readLegacyReadSet,
  type LegacyReadSetBatch,
  type LegacyReadSetResult,
} from './read-set.js';
import type { LegacySourceSession } from './source-port.js';

/**
 * Mirza migration PR3 — the `invoice-archive` read set (`legacy-read-set:invoice-archive:v1`):
 * EVERY legacy `invoice` row, whatever its status, read for the append-only legacy invoice
 * archive. A SEPARATE read set, so the frozen v1 import read set and the fingerprint the
 * owner approved do not move (`tests/unit/legacy-import-read-set-v1.test.ts`).
 *
 * ## The `invoice` column allowlist, and the evidence for each name
 *
 * Required — exactly the v1 import read set's `invoice` columns, which the bound v1 identity
 * already refuses a source without (`IMPORT_READ_SET_V1.requiredColumns.invoice`):
 * `id_invoice`, `id_user`, `username`, `Status`, `is_test`, `code_panel`, `code_product`,
 * `Volume`, `Service_time`, `time_unit`, `is_custom`, `price_product`.
 *
 * Optional — read when the source has them, absent otherwise (the absence is part of the
 * schema hash, as every column of the table is). Named by the two public MirzaBot sources:
 * `mahdiMGF2/botmirzapanel` @ 92c0ed06 `table.php` and `mahdiMGF2/mirza_pro` @ 8e551ecf
 * `db/tables/invoice.php`:
 *
 * - `Service_location` (the panel's name), `time_sell` (the sale time: `time()`),
 *   `name_product` — both sources;
 * - `note` (the fork's config name, typed by the customer: PII, redacted without
 *   `legacy.invoices.pii.view`), `refral` (the referrer's Telegram id: PII), `time_cron`
 *   (the fork's notification cron stamp), `notifctions` (the fork's `{"volume","time"}`
 *   flags) — the fork.
 *
 * ## Deliberately NOT read (and why)
 *
 * - `user_info` — the fork writes the panel's `subscription_url` into it
 *   (`index.php`: `update("invoice", "user_info", $dataoutput['subscription_url'], …)`);
 *   botmirzapanel declares it too. A subscription link is a credential.
 * - `uuid` — the fork's account UUID: a credential for the account it names.
 * - `bottype` — the fork stores a reseller sub-bot's Telegram BOT TOKEN in it
 *   (`vpnbot/Default/index.php`: `bindParam(':bottype', $ApiToken)`).
 * - Any other column, whatever its name: an unknown column may hold anything
 *   (OQ-MZ-INV-02). A later version adds one only in a reviewed commit with evidence.
 *
 * ## The other two tables: the source-derived context, nothing else
 *
 * - `user` — `id` only: whether an invoice's owner exists in the SAME snapshot (ORPHAN_OWNER).
 *   No balance, phone or username.
 * - `product` — `id` and `code_product` only: whether an invoice's code names a legacy product.
 *
 * Every value is kept verbatim; no meaning is guessed (OQ-LIA).
 */
export const INVOICE_ARCHIVE_READ_SET_NAME = 'invoice-archive' as const;
export const INVOICE_ARCHIVE_READ_SET_VERSION = 1;

export const INVOICE_ARCHIVE_EXCLUDED_COLUMNS = Object.freeze([
  'user_info',
  'uuid',
  'bottype',
] as const);

export const INVOICE_ARCHIVE_READ_SET = defineLegacyReadSet({
  name: INVOICE_ARCHIVE_READ_SET_NAME,
  version: INVOICE_ARCHIVE_READ_SET_VERSION,
  tables: [
    {
      table: 'invoice',
      primaryKey: 'id_invoice',
      columns: [
        'id_invoice',
        'id_user',
        'username',
        'Status',
        'is_test',
        'code_panel',
        'code_product',
        'Volume',
        'Service_time',
        'time_unit',
        'is_custom',
        'price_product',
      ],
      optionalColumns: [
        'Service_location',
        'time_sell',
        'name_product',
        'note',
        'refral',
        'time_cron',
        'notifctions',
      ],
    },
    { table: 'user', primaryKey: 'id', columns: ['id'] },
    { table: 'product', primaryKey: 'id', columns: ['id', 'code_product'] },
  ],
});

/**
 * The read set, digest only: its fingerprint and nothing else. What `invoices-read` prints
 * for the owner to approve, writing nothing.
 */
export function digestInvoiceArchiveReadSet(
  session: LegacySourceSession,
): Promise<LegacyReadSetResult> {
  return readLegacyReadSet(session, INVOICE_ARCHIVE_READ_SET);
}

/**
 * The read set, delivered ONLY when it is the approved one: a digest-only pass compared with
 * `expectedFingerprint` (`READ_SET_FINGERPRINT_MISMATCH` before `onBatch` ever runs), then
 * the delivering pass, which must reproduce it (`READ_SET_SNAPSHOT_DIVERGED` otherwise).
 */
export function readApprovedInvoiceArchiveReadSet(
  session: LegacySourceSession,
  expectedFingerprint: string,
  options: {
    readonly batchSize: number;
    readonly onBatch: (batch: LegacyReadSetBatch) => Promise<void> | void;
  },
): Promise<LegacyReadSetResult> {
  return readLegacyReadSet(session, INVOICE_ARCHIVE_READ_SET, { ...options, expectedFingerprint });
}
