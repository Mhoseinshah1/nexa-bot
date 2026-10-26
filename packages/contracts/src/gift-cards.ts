import { z } from 'zod';
import { currencyCodeSchema, moneySchema } from './money.js';
import { PUBLIC_CODE_ALPHABET } from './public-code.js';

/**
 * R10 D4 — gift cards: wallet top-up codes.
 *
 * An operator mints a BATCH in the Web Admin — a face value, a count, an expiry and an
 * optional per-customer limit — and downloads its codes once as a CSV. A customer types a
 * code in the bot or the mini app and the face value is credited to their wallet through the
 * ledger (`GIFT_CARD_REDEMPTION`, reference `giftcard:<codeId>`). A gift card never touches
 * pricing, orders or the refund path.
 *
 * ## The code
 *
 * `GIFT_CARD_CODE_LENGTH` symbols of the public-code alphabet (Crockford base32 without 0
 * and 1: no symbol can be misread as another), drawn by rejection sampling from the CSPRNG:
 * 30^20 ≈ 2^98, so guessing one live code is out of reach whatever the batch size. Shown as
 * five groups of four. Stored ONLY as a tenant-salted SHA-256 (the `backup-codes.ts`
 * pattern); the plaintext exists once, inside the batch's sealed export, which expires.
 *
 * ## Max uses = 1 is the column, not a counter
 *
 * A code row carries `redeemed_at`; the redemption is a conditional UPDATE from "not
 * redeemed, ACTIVE, unexpired" and the ledger reference is unique per code, so a code pays at
 * most once even under concurrency.
 */

// --- The code ------------------------------------------------------------------------------

export const GIFT_CARD_CODE_ALPHABET = PUBLIC_CODE_ALPHABET;
export const GIFT_CARD_CODE_LENGTH = 20;
/** The display form groups the code in fours: `ABCD-EFGH-JKMN-PQRS-TVWX`. */
export const GIFT_CARD_CODE_GROUP_SIZE = 4;
/**
 * A typed code longer than this is refused unread. Generous — separators, spaces, a pasted
 * line break — but bounded, so a pasted paragraph is never normalised or hashed.
 */
export const GIFT_CARD_CODE_INPUT_MAX_LENGTH = 64;

// --- Batches -----------------------------------------------------------------------------

/** The most codes one batch may mint (a default pending the owner's review). */
export const GIFT_CARD_BATCH_MAX_CODES = 5000;
/** An operator's label for a batch, shown in the list and the operations log. */
export const GIFT_CARD_LABEL_MAX_LENGTH = 80;
/** The mandatory reason recorded with a batch's creation and its disabling. */
export const GIFT_CARD_REASON_MAX_LENGTH = 300;
/** The per-customer limit, when set: how many codes of ONE batch one customer may redeem. */
export const GIFT_CARD_PER_CUSTOMER_LIMIT_MAX = 1000;
/** An expiry must be at least this far in the future when the batch is created. */
export const GIFT_CARD_EXPIRY_MIN_LEAD_MS = 60 * 60 * 1000;
/** And at most this far: five years. */
export const GIFT_CARD_EXPIRY_MAX_LEAD_MS = 5 * 366 * 24 * 60 * 60 * 1000;
/**
 * How long a batch's codes can be downloaded after it was created. After this the sealed
 * export is purged and the codes cannot be recovered (they are stored hashed): a lost file
 * means disabling the batch and minting another. A default pending the owner's review.
 */
export const GIFT_CARD_EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

export const GIFT_CARD_BATCH_STATES = ['ACTIVE', 'DISABLED'] as const;
export type GiftCardBatchState = (typeof GIFT_CARD_BATCH_STATES)[number];

/** A code is ACTIVE until its batch is disabled while it is still unredeemed. */
export const GIFT_CARD_CODE_STATES = ['ACTIVE', 'DISABLED'] as const;
export type GiftCardCodeState = (typeof GIFT_CARD_CODE_STATES)[number];

// --- Redemption ----------------------------------------------------------------------------

/**
 * The failed-attempt limiter: a customer whose redemptions were refused this many times in
 * the last `GIFT_CARD_FAILED_WINDOW_MS` is refused unread until the oldest falls out of the
 * window. Counted in the DATABASE under the customer's wallet lock, so it holds without Redis
 * and two concurrent guesses cannot both slip under it.
 */
export const GIFT_CARD_MAX_FAILED_ATTEMPTS = 5;
export const GIFT_CARD_FAILED_WINDOW_MS = 60 * 60 * 1000;

/**
 * Why a redemption was refused, recorded per attempt for the limiter and the operator. The
 * CUSTOMER is told one sentence for all of them (`bot.wallet.gift_card_rejected`): naming
 * which one would turn the redeem endpoint into an oracle for which codes exist.
 */
export const GIFT_CARD_REJECTIONS = [
  /** Not 20 symbols of the alphabet after normalising. */
  'MALFORMED',
  /** No code with this hash in this tenant. */
  'UNKNOWN',
  /** Already redeemed (by anyone). */
  'USED',
  /** At or past the batch's expiry: the interval is half-open. */
  'EXPIRED',
  /** The batch (or the code) was disabled. */
  'DISABLED',
  /** The customer has redeemed the batch's per-customer limit already. */
  'LIMIT_REACHED',
  /** The batch's currency is not the wallet's: refused, never converted. */
  'CURRENCY_MISMATCH',
] as const;
export type GiftCardRejection = (typeof GIFT_CARD_REJECTIONS)[number];

export const GIFT_CARD_REDEEM_OUTCOMES = ['REDEEMED', 'REJECTED', 'RATE_LIMITED'] as const;
export type GiftCardRedeemOutcome = (typeof GIFT_CARD_REDEEM_OUTCOMES)[number];

// --- HTTP (Web Admin) --------------------------------------------------------------------

/** Literal paths; a controller declares the `:id` form, a client calls the builders. */
export const GIFT_CARD_ROUTES = {
  batches: '/gift-card-batches',
  batch: (id: string) => `/gift-card-batches/${encodeURIComponent(id)}`,
  exportCsv: (id: string) => `/gift-card-batches/${encodeURIComponent(id)}/export`,
  disablePreview: (id: string) =>
    `/gift-card-batches/${encodeURIComponent(id)}/disable-preview`,
  disable: (id: string) => `/gift-card-batches/${encodeURIComponent(id)}/disable`,
} as const;

const minorAmount = z.string().regex(/^[1-9][0-9]{0,17}$/u, 'must be positive whole minor units');

/**
 * Minting a batch. The confirmation binds to what the operator saw: the face total
 * (`amountMinor × count`) and the count typed back, as a wallet mass credit does — one
 * request creates a liability of the whole total.
 */
export const giftCardBatchCreateRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    label: z.string().trim().min(1).max(GIFT_CARD_LABEL_MAX_LENGTH),
    amountMinor: minorAmount,
    currency: currencyCodeSchema,
    count: z.number().int().min(1).max(GIFT_CARD_BATCH_MAX_CODES),
    expiresAt: z.iso.datetime({ offset: true }),
    perCustomerLimit: z.number().int().min(1).max(GIFT_CARD_PER_CUSTOMER_LIMIT_MAX).nullable(),
    reason: z.string().trim().min(1).max(GIFT_CARD_REASON_MAX_LENGTH),
    expectedTotalMinor: z.string().regex(/^[0-9]{1,24}$/u),
    typedCount: z.number().int().positive(),
  })
  .strict();
export type GiftCardBatchCreateRequest = z.input<typeof giftCardBatchCreateRequestSchema>;

export const giftCardBatchListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

export const giftCardBatchSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** The face value of ONE code. */
  amount: moneySchema,
  count: z.number().int().positive(),
  perCustomerLimit: z.number().int().positive().nullable(),
  expiresAt: z.iso.datetime(),
  state: z.enum(GIFT_CARD_BATCH_STATES),
  createdAt: z.iso.datetime(),
  createdByAdminId: z.string().nullable(),
  disabledAt: z.iso.datetime().nullable(),
  /** Server counts, never computed by a client. */
  redeemedCount: z.number().int().nonnegative(),
  disabledCount: z.number().int().nonnegative(),
  unredeemedCount: z.number().int().nonnegative(),
  /** The face value of every redeemed code: what the batch has credited so far. */
  redeemedTotal: moneySchema,
  /** Until when the codes can still be downloaded; null once the export is gone. */
  exportAvailableUntil: z.iso.datetime().nullable(),
});
export type GiftCardBatchWire = z.infer<typeof giftCardBatchSchema>;

export const giftCardBatchListResponseSchema = z.object({
  batches: z.array(giftCardBatchSchema),
  nextCursor: z.string().nullable(),
});
export type GiftCardBatchListResponse = z.infer<typeof giftCardBatchListResponseSchema>;

export const giftCardBatchResponseSchema = z.object({ batch: giftCardBatchSchema });
export type GiftCardBatchResponse = z.infer<typeof giftCardBatchResponseSchema>;

/** The dry run of a disable: how many codes it would stop, counted now. */
export const giftCardDisablePreviewResponseSchema = z.object({
  batchId: z.string(),
  state: z.enum(GIFT_CARD_BATCH_STATES),
  unredeemedCount: z.number().int().nonnegative(),
});
export type GiftCardDisablePreviewResponse = z.infer<typeof giftCardDisablePreviewResponseSchema>;

/** Disabling, confirmed against the count the operator was shown. */
export const giftCardDisableRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    reason: z.string().trim().min(1).max(GIFT_CARD_REASON_MAX_LENGTH),
    expectedUnredeemed: z.number().int().nonnegative(),
    confirmed: z.literal(true),
  })
  .strict();
export type GiftCardDisableRequest = z.input<typeof giftCardDisableRequestSchema>;

export const giftCardDisableResponseSchema = z.object({
  batch: giftCardBatchSchema,
  codesDisabled: z.number().int().nonnegative(),
  /** False when the batch was already disabled: nothing changed, and the answer says so. */
  changed: z.boolean(),
});
export type GiftCardDisableResponse = z.infer<typeof giftCardDisableResponseSchema>;

/** The CSV's header row. The values are machine values: codes, minor units, ISO-8601 UTC. */
export const GIFT_CARD_EXPORT_COLUMNS = [
  'code',
  'amount_minor',
  'currency',
  'expires_at_utc',
  'expires_at_jalali',
  'batch_label',
] as const;
