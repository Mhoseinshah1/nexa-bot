import { z } from 'zod';

/**
 * Why a per-name RickPanel read decided what it decided — the closed vocabulary of its
 * DIAGNOSTICS (`docs/rickpanel-inventory.md` §Diagnostics).
 *
 * A live dry run once left every needed name of a panel UNRESOLVED and nobody could say why:
 * the report carried a `gapFree` boolean and a count. These are the reasons, per walk and per
 * name, as closed codes and numbers. Diagnostics only: nothing here decides anything, and no
 * value of it is a name, a row, a token, a link or an address.
 */

/**
 * Each condition a walk must meet to be GAP-FREE, named by how it failed. A walk is gap-free
 * exactly when none of these is reported.
 *
 * - `NO_OVERLAP` — the walk did not overlap its pages (a page too small to overlap).
 * - `NO_TOTAL` — the panel's pages carry no `total`.
 * - `CREATED_ORDER` — a row without a usable `created_at`, or one older than the row before
 *   it: the list is not provably in insertion order.
 * - `UNCHAINED` — a page boundary did not chain (see `RICKPANEL_CHAIN_BREAKS`).
 * - `SHORT_BEFORE_END` — a full page too small to overlap was followed by another.
 * - `NOT_ENDED_AT_TOTAL` — the final short page did not end exactly at its own `total`.
 */
export const RICKPANEL_GAP_FREE_FAILURES = [
  'NO_OVERLAP',
  'NO_TOTAL',
  'CREATED_ORDER',
  'UNCHAINED',
  'SHORT_BEFORE_END',
  'NOT_ENDED_AT_TOTAL',
] as const;
export type RickpanelGapFreeFailure = (typeof RICKPANEL_GAP_FREE_FAILURES)[number];

/**
 * How a page boundary of an overlapping walk failed to chain, counted per walk.
 *
 * - `NO_COMMON_ROW` — the page shares no row (name and `created_at`) with the previous one.
 * - `COMMON_ORDER_DIFFERS` — the shared rows come in another order.
 * - `INSERT_AHEAD_MISSED` — the first shared row moved further than the page's fresh rows
 *   explain: a row inserted ahead of the cursor was skipped.
 * - `DUPLICATE_IN_PAGE` — one row twice in one page.
 * - `REPEAT_OUTSIDE_OVERLAP` — a row already received, returned again outside the overlap
 *   (counted per row).
 * - `PAGE_LONGER_THAN_CAP` — a page longer than the cap the first page taught.
 */
export const RICKPANEL_CHAIN_BREAKS = [
  'NO_COMMON_ROW',
  'COMMON_ORDER_DIFFERS',
  'INSERT_AHEAD_MISSED',
  'DUPLICATE_IN_PAGE',
  'REPEAT_OUTSIDE_OVERLAP',
  'PAGE_LONGER_THAN_CAP',
] as const;
export type RickpanelChainBreak = (typeof RICKPANEL_CHAIN_BREAKS)[number];

/**
 * The shape of a row's `created_at`. `NAIVE`, `OFFSET`, `EPOCH_LIKE` and `OTHER` partition the
 * rows that carry a value; `FRACTIONAL` counts the ISO-like ones (naive or with an offset)
 * that also carry fractional seconds.
 *
 * - `NAIVE` — ISO-like date and time with no zone (`2024-01-02T03:04:05`): parsed as local time.
 * - `OFFSET` — ISO-like with `Z` or `±hh:mm`.
 * - `FRACTIONAL` — ISO-like with fractional seconds.
 * - `EPOCH_LIKE` — a JSON number, or a string of digits: never usable as a creation time here.
 * - `OTHER` — anything else.
 */
export const RICKPANEL_CREATED_AT_FORMATS = [
  'NAIVE',
  'OFFSET',
  'FRACTIONAL',
  'EPOCH_LIKE',
  'OTHER',
] as const;
export type RickpanelCreatedAtFormat = (typeof RICKPANEL_CREATED_AT_FORMATS)[number];

/**
 * Why one needed name stayed UNRESOLVED.
 *
 * - `NO_DECISION_WALK` — no walk was gap-free, in one order with a neighbour, and followed by
 *   another walk.
 * - `LAST_NOT_DECISIVE` — the name was decided, but the read reached its walk cap with the
 *   LAST walk not decisive, so the decision was withheld.
 * - `BACKUP_TWO_SPELLINGS` — the backup itself spells the name two ways.
 * - `MULTI_CREATED_AT` — a walk returned the spelling with another `created_at`, or none:
 *   possibly another account under the name.
 * - `UNCONFIRMED` — returned by the decision walk, not by a later one, and no later walk was
 *   decisive enough to call it gone.
 * - `REAPPEARED` — absent from the decision walk, returned by a later one.
 */
export const RICKPANEL_UNRESOLVED_CAUSES = [
  'NO_DECISION_WALK',
  'LAST_NOT_DECISIVE',
  'BACKUP_TWO_SPELLINGS',
  'MULTI_CREATED_AT',
  'UNCONFIRMED',
  'REAPPEARED',
] as const;
export type RickpanelUnresolvedCause = (typeof RICKPANEL_UNRESOLVED_CAUSES)[number];

const count = z.number().int().nonnegative();
const signed = z.number().int();

/** One walk of a per-name read, as diagnostics. Counts, milliseconds and closed codes only. */
export const legacyInventoryWalkDiagnosticsSchema = z.object({
  pages: count,
  rowsFetched: count,
  gapFree: z.boolean(),
  /** Gap-free, and in one relative order with a neighbouring walk. */
  decisive: z.boolean(),
  /** In one relative order with the walk before it; null for the first walk. */
  sameOrderAsPrevious: z.boolean().nullable(),
  failures: z.array(z.enum(RICKPANEL_GAP_FREE_FAILURES)),
  firstFailure: z
    .object({ kind: z.enum(RICKPANEL_GAP_FREE_FAILURES), pageIndex: count })
    .nullable(),
  overlapApplied: count,
  /** The page cap the first page taught; null when it taught none. */
  learnedLimit: count.nullable(),
  durationMs: count,
  reportedTotalFirst: count.nullable(),
  reportedTotalLast: count.nullable(),
  /** The largest |total − first page's total| over the walk's pages. */
  reportedTotalMaxChange: count,
  /** Where the walk ended, minus the total its last page reported; null without a total. */
  endedOffsetMinusTotal: signed.nullable(),
  createdAt: z.object({
    rowsWithout: count,
    rowsUnparsable: count,
    inversions: count,
    maxInversionMs: count,
    formats: z.array(z.object({ code: z.enum(RICKPANEL_CREATED_AT_FORMATS), count })),
  }),
  chainBreaks: z.array(z.object({ code: z.enum(RICKPANEL_CHAIN_BREAKS), count })),
});
export type LegacyInventoryWalkDiagnostics = z.infer<typeof legacyInventoryWalkDiagnosticsSchema>;

/**
 * One production panel's per-name read, as the dry run's report carries it
 * (`providerDiagnostics`). `panelId` is the NEXA panel's id — never its address.
 */
export const legacyInventoryPanelDiagnosticsSchema = z.object({
  panelId: z.string().regex(/^[0-9A-Za-z-]{1,64}$/u),
  /** The read's closed reason (`TOTAL_CHANGED`, `WALKS_DIFFER`, `NO_CREATION_TIME`, …). */
  reason: z.string().regex(/^[A-Z][A-Z_]{0,39}$/u),
  needed: count,
  unresolved: count,
  /** The decision walk's index (0-based), or null when no walk could be one. */
  decisionWalk: count.nullable(),
  unresolvedByCause: z.array(z.object({ code: z.enum(RICKPANEL_UNRESOLVED_CAUSES), count })),
  walks: z.array(legacyInventoryWalkDiagnosticsSchema),
});
export type LegacyInventoryPanelDiagnostics = z.infer<typeof legacyInventoryPanelDiagnosticsSchema>;
