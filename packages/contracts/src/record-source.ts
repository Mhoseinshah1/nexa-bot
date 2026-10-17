import { z } from 'zod';

/**
 * Where a row of a NORMAL table came from (the one-time Mirza import, owner decision
 * 2026-10-17, `docs/migration/mirza-import-plan-fa.md` §2).
 *
 * `NEXA` is every row this installation wrote itself; it is the column default, so every
 * existing row and writer is `NEXA` without being touched. `MIRZA` is a row the one-time
 * import wrote from a Mirza backup, and it carries `source_ref` — the row's id in Mirza —
 * which is unique per tenant and table, so a rerun finds it instead of writing a second one.
 * The pairing (`source = 'NEXA'` exactly when `source_ref IS NULL`) is a CHECK on each table.
 *
 * A source is provenance, never behaviour: a `MIRZA` row is shown with a «از میرزا» badge
 * and can be filtered on, and is otherwise an ordinary row.
 */
export const RECORD_SOURCES = ['NEXA', 'MIRZA'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];
export const recordSourceSchema = z.enum(RECORD_SOURCES);
export const DEFAULT_RECORD_SOURCE: RecordSource = 'NEXA';

/** The longest `source_ref` a Mirza id is stored as. */
export const RECORD_SOURCE_REF_MAX_LENGTH = 128;
