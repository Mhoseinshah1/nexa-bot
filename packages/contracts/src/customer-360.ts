import { z } from 'zod';
import { ACTOR_TYPES, SOURCE_SURFACES } from './actor.js';
import { CUSTOMER_STATUSES, telegramUserIdSchema } from './customer.js';
import { uuidV7Schema } from './ids.js';
import { LEDGER_DIRECTIONS, LEDGER_REASONS } from './ledger.js';
import { CURRENCY_CODES } from './money.js';
import { AUDIT_RESULTS } from './ports.js';
import {
  SERVICE_LOCATION_COOLDOWN_HOURS_MAX,
  SERVICE_LOCATION_MAX_CHANGES_MAX,
  SERVICE_LOCATION_PERIOD_DAYS_MAX,
} from './service-location.js';

/**
 * Customer 360 — the operator's controls on one customer, and the reads the redesigned
 * customer page is built from (spec §11, `docs/customer-account-transfer-audit.md`).
 *
 * Kept OUT of `customerSummarySchema`, deliberately: that shape is the row every customer
 * LIST returns, and a list that carried a phone number, an exemption and an override per
 * row would hand them to a reader who only asked for a page of names. These are read from
 * ONE customer's page, through `/users/:id/overview`.
 */

/** A reason an operator gives for a control. Optional where the action is reversible. */
export const CUSTOMER_CONTROL_REASON_MAX_LENGTH = 500;

const idempotencyKeySchema = z.string().min(8).max(255);
const reasonSchema = z.string().trim().max(CUSTOMER_CONTROL_REASON_MAX_LENGTH);

/**
 * A phone number as this installation stores one: `+` and 8 to 15 digits (E.164's bound).
 *
 * Persian `۰-۹` and Arabic-Indic `٠-٩` digits are read as ASCII, spaces, dashes and
 * parentheses are dropped, and a leading `00` is read as `+`. A number with no country
 * code is refused rather than guessed: `0912…` is Iranian to an Iranian operator and
 * ambiguous to the database, and a verification records a fact, not a guess.
 */
export function normalisePhoneNumber(raw: string): string | null {
  const ascii = raw
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\s\-().]/gu, '');
  const plus = ascii.startsWith('00') ? `+${ascii.slice(2)}` : ascii;
  return /^\+[1-9][0-9]{7,14}$/u.test(plus) ? plus : null;
}

/**
 * A Telegram numeric id as an operator TYPES it: Persian `۰-۹` and Arabic-Indic `٠-٩` digits
 * read as ASCII and surrounding space dropped, THEN held to `telegramUserIdSchema`. At the
 * boundary, so an id copied onto a Persian keyboard is not refused before any code that
 * would have normalised it runs (Codex review of #146).
 */
export function typedDigitsAsAscii(text: string): string {
  return text
    .trim()
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

export const typedTelegramUserIdSchema = z
  .string()
  .max(40)
  .transform(typedDigitsAsAscii)
  .pipe(telegramUserIdSchema);

// --- The overview -------------------------------------------------------------------

export const customerLocationOverrideSchema = z.object({
  /** Null: no cooldown for this customer's services. */
  cooldownHours: z.number().int().nullable(),
  /** Null with `periodDays`: no rolling limit. They come as a pair or not at all. */
  maxChanges: z.number().int().nullable(),
  periodDays: z.number().int().nullable(),
  setAt: z.iso.datetime(),
});
export type CustomerLocationOverrideResponse = z.infer<typeof customerLocationOverrideSchema>;

/**
 * The per-customer controls, as stored. Every field is a stored fact or null; nothing here
 * is derived, so the page cannot disagree with the gate that reads the same column.
 */
export const customerOverviewSchema = z.object({
  customerId: z.string(),
  /** When an operator exempted this customer from mandatory channel membership; null: not exempt. */
  channelMembershipExemptAt: z.iso.datetime().nullable(),
  /** The number an operator verified out of band, or null. Customers are never asked for one. */
  phone: z
    .object({
      number: z.string(),
      verifiedAt: z.iso.datetime(),
    })
    .nullable(),
  locationOverride: customerLocationOverrideSchema.nullable(),
  marketingOptOutAt: z.iso.datetime().nullable(),
  /**
   * Terms and rules acceptance (§11.3). There is no terms domain in this installation yet,
   * so the honest answer is "not available" — never "not accepted", which would be a claim
   * about a customer the data cannot support. When the domain lands, this widens to a
   * union whose other branch carries the accepted version and time.
   */
  terms: z.object({ available: z.literal(false) }),
});
export type CustomerOverviewResponse = z.infer<typeof customerOverviewSchema>;

export const customerOverviewResponseSchema = z.object({ overview: customerOverviewSchema });

/** What every control answers: the controls as they now are, and whether THIS call changed them. */
export const customerControlResponseSchema = z.object({
  overview: customerOverviewSchema,
  changed: z.boolean(),
});
export type CustomerControlResponse = z.infer<typeof customerControlResponseSchema>;

// --- The controls -------------------------------------------------------------------

export const customerChannelExemptionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  exempt: z.boolean(),
  reason: reasonSchema.min(1),
});
export type CustomerChannelExemptionRequest = z.infer<typeof customerChannelExemptionRequestSchema>;

/** `phoneNumber: null` revokes the verification and forgets the number. */
export const customerPhoneVerificationRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  phoneNumber: z.string().max(40).nullable(),
  reason: reasonSchema.min(1),
});
export type CustomerPhoneVerificationRequest = z.infer<
  typeof customerPhoneVerificationRequestSchema
>;

/** `limits: null` removes the override, and the configured location limits apply again. */
export const customerLocationOverrideRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  limits: z
    .object({
      cooldownHours: z.number().int().min(1).max(SERVICE_LOCATION_COOLDOWN_HOURS_MAX).nullable(),
      maxChanges: z.number().int().min(1).max(SERVICE_LOCATION_MAX_CHANGES_MAX).nullable(),
      periodDays: z.number().int().min(1).max(SERVICE_LOCATION_PERIOD_DAYS_MAX).nullable(),
    })
    .refine((limits) => (limits.maxChanges === null) === (limits.periodDays === null), {
      message: 'A rolling limit is a count and a period, or neither.',
      path: ['maxChanges'],
    })
    .nullable(),
  reason: reasonSchema.min(1),
});
export type CustomerLocationOverrideRequest = z.infer<typeof customerLocationOverrideRequestSchema>;

export const customerNotificationsRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  /** True: promotional broadcasts stop for this customer. Transactional messages never do. */
  marketingOptedOut: z.boolean(),
  reason: reasonSchema.min(1),
});
export type CustomerNotificationsRequest = z.infer<typeof customerNotificationsRequestSchema>;

export const CUSTOMER_SERVICES_TOGGLE_ACTIONS = ['SUSPEND', 'RESUME'] as const;
export type CustomerServicesToggleAction = (typeof CUSTOMER_SERVICES_TOGGLE_ACTIONS)[number];

export const customerServicesToggleRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  action: z.enum(CUSTOMER_SERVICES_TOGGLE_ACTIONS),
});
export type CustomerServicesToggleRequest = z.infer<typeof customerServicesToggleRequestSchema>;

/**
 * What one service's request came to. `PLANNED` is an operation written for the
 * provisioner — not yet a fact on the panel; `REFUSED` names the existing error code.
 */
export const customerServicesToggleResponseSchema = z.object({
  action: z.enum(CUSTOMER_SERVICES_TOGGLE_ACTIONS),
  results: z.array(
    z.object({
      serviceId: z.string(),
      providerUsername: z.string(),
      outcome: z.enum(['PLANNED', 'REFUSED']),
      code: z.string().nullable(),
    }),
  ),
});
export type CustomerServicesToggleResponse = z.infer<typeof customerServicesToggleResponseSchema>;

// --- Account transfer ---------------------------------------------------------------

/**
 * Why an account transfer cannot run now. Each is a state of the SOURCE (or the pair) that
 * an automatic move would get wrong; `docs/customer-account-transfer-audit.md` §3 gives the
 * reason for every one.
 */
export const CUSTOMER_TRANSFER_BLOCKERS = [
  'SAME_CUSTOMER',
  'DESTINATION_UNKNOWN',
  'DESTINATION_BLOCKED',
  'SOURCE_IS_RESELLER',
  'SOURCE_BALANCE_NEGATIVE',
  'ORDER_IN_PROGRESS',
  'PAYMENT_PENDING',
  'SERVICE_UNSETTLED',
  'REWARD_PENDING',
  'BULK_OPERATION_PENDING',
  'NOTHING_TO_MOVE',
] as const;
export type CustomerTransferBlocker = (typeof CUSTOMER_TRANSFER_BLOCKERS)[number];

/** Facts the operator is shown and that do not stop the transfer. */
export const CUSTOMER_TRANSFER_WARNINGS = [
  'DESTINATION_IS_RESELLER',
  'TRIAL_SERVICES_STAY',
  'SOURCE_OVERRIDES_STAY',
  'OPEN_TICKETS_STAY',
  /** Commissions earned from customers the source referred keep landing on the source. */
  'REFERRAL_CREDITS_STAY',
  /** A later refund of one of the source's payments credits the SOURCE's wallet. */
  'REFUNDS_CREDIT_SOURCE',
] as const;
export type CustomerTransferWarning = (typeof CUSTOMER_TRANSFER_WARNINGS)[number];

export const customerTransferPreviewRequestSchema = z.object({
  destinationTelegramUserId: typedTelegramUserIdSchema,
});
export type CustomerTransferPreviewRequest = z.infer<typeof customerTransferPreviewRequestSchema>;

const transferPartySchema = z.object({
  id: z.string(),
  telegramUserId: z.string(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  status: z.enum(CUSTOMER_STATUSES),
});

export const customerTransferPreviewSchema = z.object({
  source: transferPartySchema,
  destination: transferPartySchema.nullable(),
  moves: z.object({
    services: z.array(
      z.object({
        id: z.string(),
        providerUsername: z.string(),
        state: z.string(),
        expiresAt: z.iso.datetime().nullable(),
      }),
    ),
    /** The source's whole derived balance, in minor units as text. "0" moves nothing. */
    walletAmount: z.string(),
    currency: z.enum(CURRENCY_CODES),
  }),
  /** What stays with the source — history and the source's own settings. Counts only. */
  stays: z.object({
    closedServices: z.number().int(),
    trialServices: z.number().int(),
    orders: z.number().int(),
    payments: z.number().int(),
    referredCustomers: z.number().int(),
    referredBy: z.boolean(),
    openTickets: z.number().int(),
    trialOverride: z.boolean(),
    locationOverride: z.boolean(),
    channelExemption: z.boolean(),
    verifiedPhone: z.boolean(),
  }),
  blockers: z.array(z.enum(CUSTOMER_TRANSFER_BLOCKERS)),
  warnings: z.array(z.enum(CUSTOMER_TRANSFER_WARNINGS)),
  /**
   * What the confirmation binds to: the destination, the services that would move and the
   * amount. The transfer recomputes it under its locks and refuses a mismatch
   * (`CUSTOMER_TRANSFER_PREVIEW_STALE`), so it moves exactly what the operator was shown.
   */
  fingerprint: z.string(),
});
export type CustomerTransferPreviewResponse = z.infer<typeof customerTransferPreviewSchema>;

export const customerTransferPreviewResponseSchema = z.object({
  preview: customerTransferPreviewSchema,
});

export const customerTransferRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  destinationTelegramUserId: typedTelegramUserIdSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The destination's numeric id, typed again by the operator: the explicit confirmation. */
  confirmTelegramUserId: z.string().max(40),
  reason: reasonSchema.min(1),
});
export type CustomerTransferRequest = z.infer<typeof customerTransferRequestSchema>;

export const customerTransferResultSchema = z.object({
  transferId: z.string(),
  fromCustomerId: z.string(),
  toCustomerId: z.string(),
  servicesMoved: z.number().int(),
  walletMovedAmount: z.string(),
  currency: z.enum(CURRENCY_CODES),
  createdAt: z.iso.datetime(),
  /** True when this key had already transferred and nothing was written now. */
  replayed: z.boolean(),
});
export type CustomerTransferResultResponse = z.infer<typeof customerTransferResultSchema>;

export const customerTransferResponseSchema = z.object({
  transfer: customerTransferResultSchema,
});

// --- Manual order -------------------------------------------------------------------

/**
 * An operator placing an order for a customer (§11.6), through the SAME draft, pricing,
 * confirmation and wallet settlement a customer's own purchase uses. Paid from the
 * customer's wallet, never on credit nobody granted: an operator who means it as a gift
 * credits the wallet first, which is its own audited ledger entry.
 */
export const customerManualOrderRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  productId: uuidV7Schema,
  /**
   * A username for the service, for a panel that offers a typed one. Null lets the panel's
   * automatic naming decide — refused (`SERVICE_USERNAME_REQUIRED`) on a panel that only
   * accepts a typed name.
   */
  username: z.string().trim().max(64).nullable(),
  reason: reasonSchema.min(1),
});
export type CustomerManualOrderRequest = z.infer<typeof customerManualOrderRequestSchema>;

/**
 * The order an operator placed, settled from the customer's wallet. Settlement is all or
 * nothing: when the wallet cannot fund it, the order is cancelled in the same command (its
 * capacity slot and username released) and the settlement's own refusal is answered —
 * nothing is left awaiting a payment the customer never chose to make.
 */
export const customerManualOrderResponseSchema = z.object({
  orderId: z.string(),
  paymentId: z.string(),
  totalAmount: z.string(),
  currency: z.enum(CURRENCY_CODES),
});
export type CustomerManualOrderResponse = z.infer<typeof customerManualOrderResponseSchema>;

// --- Financial summary --------------------------------------------------------------

const perCurrencySchema = z.object({
  currency: z.enum(CURRENCY_CODES),
  count: z.number().int(),
  amount: z.string(),
});

/**
 * Only figures the stored rows sum to exactly (§11.7). Each section is null when the reader
 * may not see it, and the permission it needs is named in `denied`. No profit, no estimate.
 */
export const customerFinancialSummarySchema = z.object({
  orders: z
    .object({
      /** Orders that reached PAID and were not given back. Trials excluded (free by rule). */
      purchases: z.array(perCurrencySchema),
      /** The discount on those purchases, from each order's frozen snapshot. */
      discounts: z.array(perCurrencySchema),
      refunded: z.array(perCurrencySchema),
      awaitingPayment: z.number().int(),
      orderCount: z.number().int(),
    })
    .nullable(),
  payments: z
    .object({
      confirmed: z.array(perCurrencySchema),
      pending: z.number().int(),
      paymentCount: z.number().int(),
    })
    .nullable(),
  /** Ledger sums per reason and direction — cashback, gifts and commissions among them. */
  ledger: z
    .array(
      z.object({
        reason: z.enum(LEDGER_REASONS),
        direction: z.enum(LEDGER_DIRECTIONS),
        currency: z.enum(CURRENCY_CODES),
        count: z.number().int(),
        amount: z.string(),
      }),
    )
    .nullable(),
  services: z
    .object({
      byState: z.array(z.object({ state: z.string(), count: z.number().int() })),
      serviceCount: z.number().int(),
    })
    .nullable(),
  denied: z.array(z.string()),
});
export type CustomerFinancialSummaryResponse = z.infer<typeof customerFinancialSummarySchema>;

export const customerFinancialSummaryResponseSchema = z.object({
  summary: customerFinancialSummarySchema,
});

// --- Timeline -----------------------------------------------------------------------

export const CUSTOMER_TIMELINE_LIMIT = 50;

export const customerTimelineEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actorType: z.enum(ACTOR_TYPES),
  actorLabel: z.string().nullable(),
  surface: z.enum(SOURCE_SURFACES),
  result: z.enum(AUDIT_RESULTS),
  occurredAt: z.iso.datetime(),
  reason: z.string().nullable(),
  /** As stored — redacted when it was written. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type CustomerTimelineEntryResponse = z.infer<typeof customerTimelineEntrySchema>;

export const customerTimelineResponseSchema = z.object({
  entries: z.array(customerTimelineEntrySchema),
});
export type CustomerTimelineResponse = z.infer<typeof customerTimelineResponseSchema>;

export const CUSTOMER_360_ROUTES = {
  overview: (id: string) => `/users/${encodeURIComponent(id)}/overview`,
  channelExemption: (id: string) => `/users/${encodeURIComponent(id)}/channel-exemption`,
  phone: (id: string) => `/users/${encodeURIComponent(id)}/phone`,
  locationOverride: (id: string) => `/users/${encodeURIComponent(id)}/location-override`,
  notifications: (id: string) => `/users/${encodeURIComponent(id)}/notifications`,
  servicesToggle: (id: string) => `/users/${encodeURIComponent(id)}/services/toggle`,
  transferPreview: (id: string) => `/users/${encodeURIComponent(id)}/transfer/preview`,
  transfer: (id: string) => `/users/${encodeURIComponent(id)}/transfer`,
  manualOrder: (id: string) => `/users/${encodeURIComponent(id)}/manual-order`,
  financialSummary: (id: string) => `/users/${encodeURIComponent(id)}/financial-summary`,
  timeline: (id: string) => `/users/${encodeURIComponent(id)}/timeline`,
} as const;
