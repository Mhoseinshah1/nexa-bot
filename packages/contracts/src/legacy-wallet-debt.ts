import { z } from 'zod';

/**
 * Mirza migration PR4 — legacy wallet debts (owner decision 6, 2026-10-07;
 * `docs/migration-opening-balance.md` §Negative balances).
 *
 * A NEGATIVE legacy `user.Balance` is held for review. It is NOT a ledger entry: the
 * customer's NEXA balance starts at 0, and the amount the legacy system said they owed is
 * recorded here — exactly, with its currency, the legacy user id and the source it was read
 * from. The debt is NEVER collected: no top-up, purchase, refund, clawback or ledger path
 * reads it, and nothing nets it off. The owner decides per customer; every decision is a
 * label, and none of them moves money. Collecting a debt would need a new ledger reason
 * and an explicit owner instruction, and neither exists.
 *
 * Positive legacy balances keep the existing opening-balance path (a
 * `MIGRATION_OPENING_BALANCE` CREDIT).
 */

/** Every state a debt can be in. Each transition is a conditional UPDATE naming its `from` states. */
export const LEGACY_WALLET_DEBT_STATES = [
  /** Recorded by the importer; the owner has not decided. Every debt enters here. */
  'PENDING_REVIEW',
  /** The owner acknowledged the debt as recorded. It is still never collected. */
  'ACKNOWLEDGED',
  /** The owner waived the debt. Nothing is written to the wallet either way. */
  'WAIVED',
] as const;
export type LegacyWalletDebtState = (typeof LEGACY_WALLET_DEBT_STATES)[number];
export const legacyWalletDebtStateSchema = z.enum(LEGACY_WALLET_DEBT_STATES);

/** The decisions an owner can record FROM `PENDING_REVIEW`. */
export const LEGACY_WALLET_DEBT_DECISIONS = [
  'ACKNOWLEDGED',
  'WAIVED',
] as const satisfies readonly LegacyWalletDebtState[];
export type LegacyWalletDebtDecision = (typeof LEGACY_WALLET_DEBT_DECISIONS)[number];

/** The decided states: what a reopen moves back to `PENDING_REVIEW`. */
export const LEGACY_WALLET_DEBT_DECIDED_STATES = [
  'ACKNOWLEDGED',
  'WAIVED',
] as const satisfies readonly LegacyWalletDebtState[];

/**
 * The currency a legacy debt is recorded in: the legacy balance is Toman, and NEXA's IRT has
 * zero minor digits, so one Toman is one minor unit. The importer refuses any other selling
 * currency before it writes anything.
 */
export const LEGACY_WALLET_DEBT_CURRENCY = 'IRT' as const;

export const LEGACY_WALLET_DEBT_ERROR_CODES = {
  NOT_FOUND: 'legacy_wallet_debt.not_found',
  /** The debt is not in a state this command moves from. */
  NOT_IN_STATE: 'legacy_wallet_debt.not_in_state',
  /**
   * The debt is not at the version the operator saw (`expectedVersion`): another decision
   * or a reopen moved it since. Refused, never applied over the newer state.
   */
  VERSION_CONFLICT: 'legacy_wallet_debt.version_conflict',
  REQUEST_INVALID: 'legacy_wallet_debt.request_invalid',
  SCOPE_STOPPED: 'legacy_wallet_debt.scope_stopped',
} as const;

/** The audit actions debts write. */
export const LEGACY_WALLET_DEBT_AUDIT_ACTIONS = {
  /** The importer recorded a debt (`maintenance.run`, SYSTEM_JOB). */
  recorded: 'legacy.wallet_debt.recorded',
  /** The owner recorded ACKNOWLEDGED or WAIVED (`legacy.debts.decide`). */
  decide: 'legacy.wallet_debt.decide',
  /** A decided debt back to PENDING_REVIEW (`legacy.debts.decide`). */
  reopen: 'legacy.wallet_debt.reopen',
} as const;

export const LEGACY_WALLET_DEBT_REASON_MAX_LENGTH = 500;
export const LEGACY_WALLET_DEBT_PAGE_MAX = 200;

// --- the users and wallets reconciliation section (report) ---------------------------------

/**
 * The version of the `usersWallets` section the importer's `reconcile` and `report` print
 * (`docs/legacy-migration/reconciliation.md` §Users and wallets). Aggregates only: counts,
 * sums and opaque map refs — never a Telegram id, a username or a per-user amount. PR6
 * folds this section, unchanged, into the final report's schema version 2.
 */
export const LEGACY_USERS_WALLETS_SECTION_VERSION = 'nexa-legacy-users-wallets/v1' as const;

/**
 * Where every source user row ended, one class per row (the closure: Σ classes = source
 * rows). `IMPORTED_*` rows have a customer; every other class names why not.
 */
export const LEGACY_USER_OUTCOMES = [
  /** A customer this import created. */
  'IMPORTED_NEW',
  /** An existing NEXA customer with the same Telegram id, matched — never re-created. */
  'IMPORTED_EXISTING',
  /** `user.id` is not a Telegram id: no customer and no map key can exist. */
  'SKIPPED_INVALID_IDENTITY',
  /** The balance cell is not a whole number of Toman: held in the Manual Review Queue. */
  'SKIPPED_BALANCE_UNREADABLE',
  /** The balance is beyond the amount ceiling: held in the Manual Review Queue. */
  'SKIPPED_BALANCE_OUT_OF_RANGE',
  /** The id occurs on more than one source row: nothing is written for any of them. */
  'SKIPPED_DUPLICATE_SOURCE_ID',
  /** A person closed the user's review row; a rerun never acts on it. */
  'SKIPPED_REVIEW_CLOSED',
  /** Imported from an earlier snapshot, and this snapshot's row differs: reported, never re-applied. */
  'SOURCE_CHANGED',
  /** Importable, and no import has recorded it yet (the run is not finished, or it failed). */
  'NOT_YET_IMPORTED',
] as const;
export type LegacyUserOutcome = (typeof LEGACY_USER_OUTCOMES)[number];

/**
 * How a SOURCE_CHANGED user's balance differs from the figure NEXA recorded (the opening
 * CREDIT, the legacy debt, or nothing for a zero). Never applied: a changed balance is a
 * person's question, and the sign flips are the owner's.
 */
export const LEGACY_BALANCE_CHANGE_CLASSES = [
  /** The balance is the recorded one; another fact of the row changed (username, trial limit). */
  'PROFILE_ONLY',
  /** Still positive, a different figure. */
  'POSITIVE_CHANGED',
  /** Still negative, a different figure. */
  'NEGATIVE_CHANGED',
  /** Was positive (a CREDIT opening), now negative. Owner review. */
  'POSITIVE_TO_NEGATIVE',
  /** Was negative (a legacy debt), now positive. Owner review. */
  'NEGATIVE_TO_POSITIVE',
  /** Was non-zero, now zero. */
  'TO_ZERO',
  /** Was zero (nothing recorded), now non-zero. */
  'FROM_ZERO',
  /** The new balance cell is not a readable whole number of Toman. */
  'UNREADABLE_NOW',
] as const;
export type LegacyBalanceChangeClass = (typeof LEGACY_BALANCE_CHANGE_CLASSES)[number];

/** The change classes listed (by opaque map ref) for the owner's review. */
export const LEGACY_BALANCE_CHANGE_OWNER_REVIEW = [
  'POSITIVE_TO_NEGATIVE',
  'NEGATIVE_TO_POSITIVE',
] as const satisfies readonly LegacyBalanceChangeClass[];

// --- HTTP ---------------------------------------------------------------------------------

export const LEGACY_WALLET_DEBT_ROUTES = {
  list: '/legacy-debts',
  summary: '/legacy-debts/summary',
  detail: (id: string) => `/legacy-debts/${encodeURIComponent(id)}`,
  decide: (id: string) => `/legacy-debts/${encodeURIComponent(id)}/decide`,
  reopen: (id: string) => `/legacy-debts/${encodeURIComponent(id)}/reopen`,
} as const;

const idempotencyKey = z.string().min(8).max(255);
/** The debt's `version` as the operator saw it: every decision and every reopen binds to it. */
const expectedVersion = z.number().int().min(1);
const reason = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_WALLET_DEBT_REASON_MAX_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });

/**
 * One debt, as the Web Admin renders it. Money is a decimal string of minor units; the
 * amount is the MAGNITUDE owed (always positive).
 */
export const legacyWalletDebtViewSchema = z.object({
  id: z.string(),
  customerId: z.string(),
  /** The legacy `user.id` — the customer's Telegram id. */
  legacyUserId: z.string(),
  amountMinor: z.string(),
  currency: z.literal(LEGACY_WALLET_DEBT_CURRENCY),
  state: legacyWalletDebtStateSchema,
  /** The v1 source fingerprint of the snapshot the debt was read from. */
  sourceFingerprint: z.string(),
  /** The legacy user row's checksum (`user:v1`) in that snapshot. */
  rowChecksum: z.string(),
  /** The import run that recorded it. */
  runId: z.string(),
  decisionReason: z.string().nullable(),
  decidedByAdminId: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  recordedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LegacyWalletDebtView = z.infer<typeof legacyWalletDebtViewSchema>;

export const legacyWalletDebtListQuerySchema = z.object({
  state: legacyWalletDebtStateSchema.optional(),
  /** The legacy user id (a Telegram id), exactly. */
  legacyUserId: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .optional(),
  limit: z.coerce.number().int().positive().max(LEGACY_WALLET_DEBT_PAGE_MAX).optional(),
  /** The last `id` of the page before (uuid v7, so id order is record order). */
  after: z.uuid().optional(),
});
export type LegacyWalletDebtListQuery = z.infer<typeof legacyWalletDebtListQuerySchema>;

export const legacyWalletDebtListResponseSchema = z.object({
  debts: z.array(legacyWalletDebtViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyWalletDebtListResponse = z.infer<typeof legacyWalletDebtListResponseSchema>;

/** Count and Σ owed, per state and in total. Aggregates only. */
export const legacyWalletDebtSummaryResponseSchema = z.object({
  currency: z.literal(LEGACY_WALLET_DEBT_CURRENCY),
  total: z.object({ count: z.number().int().nonnegative(), sumMinor: z.string() }),
  byState: z.record(
    legacyWalletDebtStateSchema,
    z.object({ count: z.number().int().nonnegative(), sumMinor: z.string() }),
  ),
});
export type LegacyWalletDebtSummaryResponse = z.infer<typeof legacyWalletDebtSummaryResponseSchema>;

export const legacyWalletDebtResponseSchema = z.object({ debt: legacyWalletDebtViewSchema });
export type LegacyWalletDebtResponse = z.infer<typeof legacyWalletDebtResponseSchema>;

/** Record the owner's decision on a PENDING_REVIEW debt. It moves no money. */
export const legacyWalletDebtDecideRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion,
    decision: z.enum(LEGACY_WALLET_DEBT_DECISIONS),
    reason,
  })
  .strict();
export type LegacyWalletDebtDecideRequest = z.infer<typeof legacyWalletDebtDecideRequestSchema>;

export const legacyWalletDebtReopenRequestSchema = z
  .object({ idempotencyKey, expectedVersion, reason })
  .strict();
export type LegacyWalletDebtReopenRequest = z.infer<typeof legacyWalletDebtReopenRequestSchema>;
