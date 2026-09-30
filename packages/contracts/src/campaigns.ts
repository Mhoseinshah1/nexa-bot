import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';
import { uuidV7Schema } from './ids.js';
import { audienceFingerprintSchema, audiencePreviewSchema } from './audience.js';
import {
  BROADCAST_BUTTONS_MAX,
  BROADCAST_TEXT_MAX_LENGTH,
  broadcastButtonSchema,
  broadcastCountsSchema,
} from './broadcasts.js';
import { BULK_DURATION_MAX_DAYS, bulkCountsSchema } from './bulk-operations.js';
import { TRAFFIC_GB_PATTERN } from './traffic-input.js';
import { CURRENCY_CODES, MAX_MONEY_AMOUNT_MINOR, moneySchema } from './money.js';
import {
  CASHBACK_PERCENT_MAX,
  CASHBACK_PERCENT_MIN,
  DISCOUNTABLE_PURPOSES,
  DISCOUNT_CODE_MAX_LENGTH,
  DISCOUNT_CODE_MIN_LENGTH,
  DISCOUNT_KINDS,
  DISCOUNT_PERCENTAGE_MAX,
  DISCOUNT_PERCENTAGE_MIN,
  DISCOUNT_PRIORITY_MAX,
  DISCOUNT_PRIORITY_MIN,
  DISCOUNT_TYPES,
} from './promotions.js';

/**
 * Round N, C1 — Campaigns (`docs/round-n-campaigns-audit.md`).
 *
 * A campaign is a record that COMPOSES engines that already exist — the discount and
 * cashback rules of the single pricing boundary, the shared audience, Broadcast and the
 * safe mass actions — and owns none of their decisions. What it owns is declared here:
 * its states, the kinds of action it can compose, and its bounds.
 *
 * NOT Mirza parity: the research has no campaign entity at all (NOT_EXPOSED, zero corpus
 * hits). Everything in this file is a Nexa decision.
 */

export const CAMPAIGN_STATES = [
  'DRAFT',
  'SCHEDULED',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];
export const campaignStateSchema = z.enum(CAMPAIGN_STATES);

export const CAMPAIGN_TERMINAL_STATES = ['COMPLETED', 'CANCELLED'] as const;

/** The states a campaign may be cancelled from: every state that is not terminal. */
export const CAMPAIGN_CANCELLABLE_STATES = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED'] as const;

/** The states in which the campaign's window is still running, for completion. */
export const CAMPAIGN_RUNNING_STATES = ['ACTIVE', 'PAUSED'] as const;

/**
 * - `SCHEDULE` — the operator confirms a draft after its preview.
 * - `START` — the worker, once `starts_at` has passed.
 * - `PAUSE` / `RESUME` — the operator.
 * - `COMPLETE` — the worker, once `ends_at` has passed.
 * - `CANCEL` — the operator, from any state that is not terminal.
 */
export type CampaignEvent = 'SCHEDULE' | 'START' | 'PAUSE' | 'RESUME' | 'COMPLETE' | 'CANCEL';

/**
 * Every edge, and nothing else. Every state write is a conditional UPDATE naming the
 * states it moves FROM — there is no `setState` — so a replay, a double click and two
 * worker replicas each either win their edge or are told the campaign moved.
 */
export const CAMPAIGN_MACHINE: StateMachineDefinition<CampaignState, CampaignEvent> = {
  name: 'Campaign',
  initial: 'DRAFT',
  states: CAMPAIGN_STATES,
  terminal: CAMPAIGN_TERMINAL_STATES,
  transitions: [
    { from: 'DRAFT', to: 'SCHEDULED', on: 'SCHEDULE', guard: 'previewedWindowNotOver' },
    { from: 'SCHEDULED', to: 'ACTIVE', on: 'START', guard: 'startsAtPassed' },
    { from: 'ACTIVE', to: 'PAUSED', on: 'PAUSE' },
    { from: 'PAUSED', to: 'ACTIVE', on: 'RESUME', guard: 'endsAtNotPassed' },
    { from: 'ACTIVE', to: 'COMPLETED', on: 'COMPLETE', guard: 'endsAtPassed' },
    { from: 'PAUSED', to: 'COMPLETED', on: 'COMPLETE', guard: 'endsAtPassed' },
    { from: 'DRAFT', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'SCHEDULED', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'ACTIVE', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'PAUSED', to: 'CANCELLED', on: 'CANCEL' },
  ],
};

/**
 * What a campaign can do, each through the engine that already does it:
 *
 * - `DISCOUNT` — one rule in `discounts` (the pricing engine applies it);
 * - `CASHBACK` — one rule in `cashback_rules` (the cashback earner pays it);
 * - `WALLET_GIFT` — one bulk wallet credit (the shared mass-credit engine);
 * - `TRAFFIC_GIFT` / `TIME_GIFT` — one bulk service operation (the shared bulk engine);
 * - `ANNOUNCEMENT` — one broadcast (Broadcast's durable delivery lane).
 *
 * A referral incentive is deliberately absent: the audit's D8 records why it cannot be
 * expressed through the existing referral terms without a tenant-wide, lost-update write.
 */
export const CAMPAIGN_ACTION_KINDS = [
  'DISCOUNT',
  'CASHBACK',
  'WALLET_GIFT',
  'TRAFFIC_GIFT',
  'TIME_GIFT',
  'ANNOUNCEMENT',
] as const;
export type CampaignActionKind = (typeof CAMPAIGN_ACTION_KINDS)[number];
export const campaignActionKindSchema = z.enum(CAMPAIGN_ACTION_KINDS);

/**
 * The actions the campaign PERFORMS once, at start, against the frozen audience. The
 * other two (`DISCOUNT`, `CASHBACK`) are standing rules whose own window the pricing
 * engine enforces, so starting the campaign writes nothing for them.
 */
export const CAMPAIGN_LAUNCHED_ACTION_KINDS = [
  'WALLET_GIFT',
  'TRAFFIC_GIFT',
  'TIME_GIFT',
  'ANNOUNCEMENT',
] as const satisfies readonly CampaignActionKind[];

/**
 * Where a launched action stands, from the campaign's side only.
 *
 * `PENDING` until the campaign starts; `LAUNCHED` once the engine it composes holds the
 * work (its own row then says how far it got); `CANCELLED` when the campaign was cancelled
 * before it launched; `FAILED` when the engine refused to take it, with the reason code.
 * A standing rule's action is `LAUNCHED` from the moment its rule exists.
 */
export const CAMPAIGN_ACTION_STATES = ['PENDING', 'LAUNCHED', 'CANCELLED', 'FAILED'] as const;
export type CampaignActionState = (typeof CAMPAIGN_ACTION_STATES)[number];

/**
 * The campaign's name is also the label of the discount and cashback rules it creates, so
 * it is bounded by `DISCOUNT_LABEL_MAX_LENGTH`: one name, whole, wherever it is read.
 */
export const CAMPAIGN_NAME_MAX_LENGTH = 80;
export const CAMPAIGN_DESCRIPTION_MAX_LENGTH = 2000;
export const CAMPAIGN_PAGE_DEFAULT = 25;
export const CAMPAIGN_PAGE_MAX = 100;

/**
 * How many due campaigns one worker tick moves. Bounded so one tick is one short
 * transaction per campaign; the next tick takes the rest.
 */
export const CAMPAIGN_SCHEDULE_BATCH = 50;

/** How often the campaign lane wakes: a minute, the resolution the operator schedules in. */
export const CAMPAIGN_SCHEDULE_INTERVAL_MS = 60_000;

/**
 * Campaign error codes. One remedy each; a campaign of another tenant and one that does
 * not exist are both `CAMPAIGN_NOT_FOUND`.
 */
export const CAMPAIGN_ERROR_CODES = {
  CAMPAIGN_NOT_FOUND: 'campaign.not_found',
  /** The body does not match its contract, or a field is out of bounds. */
  CAMPAIGN_REQUEST_INVALID: 'campaign.request_invalid',
  /** The requested change has no edge from where the campaign stands (`CAMPAIGN_MACHINE`). */
  CAMPAIGN_TRANSITION_INVALID: 'campaign.transition_invalid',
  /** Only a DRAFT is edited; a scheduled campaign is cancelled and made again. */
  CAMPAIGN_NOT_EDITABLE: 'campaign.not_editable',
  /** The window is unreadable, ends before it starts, or is already over. */
  CAMPAIGN_WINDOW_INVALID: 'campaign.window_invalid',
  /** A campaign with no action does nothing; one is required before it is scheduled. */
  CAMPAIGN_NO_ACTION: 'campaign.no_action',
  /**
   * The confirmation did not type the count back although an engine the campaign launches
   * asks for it (a wallet credit always; a large grant or broadcast), or typed it wrong.
   */
  CAMPAIGN_CONFIRMATION_REQUIRED: 'campaign.confirmation_required',
  /** A launched action's binding (count, set or liability) is missing or does not match. */
  CAMPAIGN_BINDING_INVALID: 'campaign.binding_invalid',
} as const;
export type CampaignErrorCode = (typeof CAMPAIGN_ERROR_CODES)[keyof typeof CAMPAIGN_ERROR_CODES];

// ---------------------------------------------------------------------------------------
// HTTP shapes
// ---------------------------------------------------------------------------------------

const minorAmountWire = z.string().regex(/^\d{1,19}$/u);
const localDateWire = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const localTimeWire = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);

/**
 * A campaign's discount: the terms of ONE rule in the existing discount engine. The
 * label is the campaign's name and the window is the campaign's window, so neither is
 * written here; a campaign discount is never scoped to one customer (the audience is who
 * is told, not who is eligible — audit D4). Every refinement `discountWriteSchema` makes
 * is made here too, so an operator is told which field is wrong.
 */
export const campaignDiscountTermsSchema = z
  .object({
    kind: z.enum(DISCOUNT_KINDS),
    code: z
      .string()
      .trim()
      .min(DISCOUNT_CODE_MIN_LENGTH)
      .max(DISCOUNT_CODE_MAX_LENGTH)
      .regex(/^[A-Za-z0-9_-]+$/u, 'a discount code is ASCII letters, digits, hyphen or underscore')
      .nullable(),
    type: z.enum(DISCOUNT_TYPES),
    value: minorAmountWire,
    currency: z.enum(CURRENCY_CODES).nullable(),
    appliesTo: z.array(z.enum(DISCOUNTABLE_PURPOSES)).min(1),
    productId: uuidV7Schema.nullable(),
    categoryId: uuidV7Schema.nullable(),
    firstPurchaseOnly: z.boolean(),
    minimumSubtotalAmount: minorAmountWire.nullable(),
    totalRedemptionsLimit: z.number().int().positive().max(1_000_000_000).nullable(),
    perCustomerLimit: z.number().int().positive().max(1_000_000_000).nullable(),
    priority: z.number().int().min(DISCOUNT_PRIORITY_MIN).max(DISCOUNT_PRIORITY_MAX),
    stackable: z.boolean(),
  })
  .refine((d) => (d.kind === 'CODE') === (d.code !== null), {
    message: 'A code rule carries a code; an automatic rule carries none.',
    path: ['code'],
  })
  .refine(
    (d) =>
      d.type !== 'PERCENTAGE' ||
      (d.currency === null &&
        BigInt(d.value) >= BigInt(DISCOUNT_PERCENTAGE_MIN) &&
        BigInt(d.value) <= BigInt(DISCOUNT_PERCENTAGE_MAX)),
    {
      message: 'A percentage is a whole number from 1 to 100 and has no currency.',
      path: ['value'],
    },
  )
  .refine(
    (d) =>
      d.type !== 'FIXED_AMOUNT' ||
      (d.currency !== null && BigInt(d.value) > 0n && BigInt(d.value) <= MAX_MONEY_AMOUNT_MINOR),
    { message: 'A fixed amount is greater than zero and has a currency.', path: ['value'] },
  )
  .refine((d) => d.productId === null || d.categoryId === null, {
    message: 'A rule is scoped to a product or to a category, not both.',
    path: ['categoryId'],
  })
  .refine((d) => new Set(d.appliesTo).size === d.appliesTo.length, {
    message: 'Each purpose is listed once.',
    path: ['appliesTo'],
  })
  .refine(
    (d) => !d.firstPurchaseOnly || (d.appliesTo.length === 1 && d.appliesTo[0] === 'NEW_SERVICE'),
    {
      message: 'A first-purchase rule applies to new purchases only.',
      path: ['firstPurchaseOnly'],
    },
  )
  .refine(
    (d) =>
      d.minimumSubtotalAmount === null || BigInt(d.minimumSubtotalAmount) <= MAX_MONEY_AMOUNT_MINOR,
    {
      message: 'That minimum is past the largest amount this system stores.',
      path: ['minimumSubtotalAmount'],
    },
  );
export type CampaignDiscountTermsWire = z.infer<typeof campaignDiscountTermsSchema>;

/** A campaign's cashback: the terms of ONE rule in the existing cashback engine. */
export const campaignCashbackTermsSchema = z
  .object({
    percent: z.number().int().min(CASHBACK_PERCENT_MIN).max(CASHBACK_PERCENT_MAX),
    appliesTo: z.array(z.enum(DISCOUNTABLE_PURPOSES)).min(1),
    productId: uuidV7Schema.nullable(),
    categoryId: uuidV7Schema.nullable(),
  })
  .refine((d) => d.productId === null || d.categoryId === null, {
    message: 'A rule is scoped to a product or to a category, not both.',
    path: ['categoryId'],
  })
  .refine((d) => new Set(d.appliesTo).size === d.appliesTo.length, {
    message: 'Each purpose is listed once.',
    path: ['appliesTo'],
  });
export type CampaignCashbackTermsWire = z.infer<typeof campaignCashbackTermsSchema>;

/** A wall-clock moment in the TENANT's calendar and zone: `1405-07-10` and `14:00`. */
export const campaignLocalMomentSchema = z.object({
  date: localDateWire,
  time: localTimeWire,
});
export type CampaignLocalMoment = z.infer<typeof campaignLocalMomentSchema>;

/** The zone and calendar every local moment in a response is written in. */
export const campaignPresentationSchema = z.object({
  timezone: z.string(),
  calendar: z.enum(['jalali', 'gregorian']),
});

export const campaignSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  state: campaignStateSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  startLocal: campaignLocalMomentSchema,
  endLocal: campaignLocalMomentSchema,
  audienceConfirmedCount: z.number().int().nullable(),
  actionKinds: z.array(campaignActionKindSchema),
  scheduledAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CampaignSummary = z.infer<typeof campaignSummarySchema>;

export const campaignListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(CAMPAIGN_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  state: campaignStateSchema.optional(),
});
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

export const campaignListResponseSchema = z.object({
  campaigns: z.array(campaignSummarySchema),
  nextCursor: z.string().nullable(),
  presentation: campaignPresentationSchema,
});
export type CampaignListResponse = z.infer<typeof campaignListResponseSchema>;

/** A pause, a resume or a cancel carries an idempotency key and nothing else. */
export const campaignCommandRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type CampaignCommandRequest = z.infer<typeof campaignCommandRequestSchema>;

/**
 * One figure the campaign's results report, always from persisted rows: a count and the
 * money it carries, grouped by the state the row is in NOW.
 */
export const campaignTallySchema = z.object({
  state: z.string(),
  count: z.number().int(),
  amount: moneySchema.nullable(),
});
export type CampaignTally = z.infer<typeof campaignTallySchema>;

/**
 * A wallet gift: ONE mass wallet credit of the shared engine (`bulk-operations.ts`), to the
 * campaign's frozen audience, in the tenant's selling currency. Its exact total liability
 * (amount × confirmed count) is shown before the confirmation and bound by it.
 */
export const campaignWalletGiftTermsSchema = z
  .object({
    amountMinor: z.string().regex(/^[1-9][0-9]{0,17}$/u, 'must be positive whole minor units'),
    currency: z.enum(CURRENCY_CODES),
    /** Whether each credited customer is told, through the notification lane. */
    notify: z.boolean(),
  })
  .strict();
export type CampaignWalletGiftTerms = z.infer<typeof campaignWalletGiftTermsSchema>;

/** A traffic gift: ONE mass traffic grant of the shared engine, on eligible services. */
export const campaignTrafficGiftTermsSchema = z
  .object({ trafficGb: z.string().regex(TRAFFIC_GB_PATTERN), notify: z.boolean() })
  .strict();
export type CampaignTrafficGiftTerms = z.infer<typeof campaignTrafficGiftTermsSchema>;

/** A time gift: ONE mass time grant of the shared engine, on eligible services. */
export const campaignTimeGiftTermsSchema = z
  .object({
    durationDays: z.number().int().min(1).max(BULK_DURATION_MAX_DAYS),
    notify: z.boolean(),
  })
  .strict();
export type CampaignTimeGiftTerms = z.infer<typeof campaignTimeGiftTermsSchema>;

/**
 * The announcement: ONE broadcast of the shared Broadcast lane, text with optional link
 * buttons, sent to the campaign's audience at the campaign's start. The body is RAW and
 * validated against the broadcast placeholder catalogue by Broadcast itself.
 */
export const campaignAnnouncementTermsSchema = z
  .object({
    body: z.string().trim().min(1).max(BROADCAST_TEXT_MAX_LENGTH),
    buttons: z.array(broadcastButtonSchema).max(BROADCAST_BUTTONS_MAX).default([]),
  })
  .strict();
export type CampaignAnnouncementTerms = z.infer<typeof campaignAnnouncementTermsSchema>;

/** Every action a campaign composes; `null` means the campaign does not have it. */
export const campaignActionsSchema = z
  .object({
    discount: campaignDiscountTermsSchema.nullable().default(null),
    cashback: campaignCashbackTermsSchema.nullable().default(null),
    walletGift: campaignWalletGiftTermsSchema.nullable().default(null),
    trafficGift: campaignTrafficGiftTermsSchema.nullable().default(null),
    timeGift: campaignTimeGiftTermsSchema.nullable().default(null),
    announcement: campaignAnnouncementTermsSchema.nullable().default(null),
  })
  .strict();
export type CampaignActions = z.output<typeof campaignActionsSchema>;
export type CampaignActionsInput = z.input<typeof campaignActionsSchema>;

const campaignDraftFields = {
  name: z.string().trim().min(1).max(CAMPAIGN_NAME_MAX_LENGTH),
  description: z.string().trim().max(CAMPAIGN_DESCRIPTION_MAX_LENGTH).default(''),
  /** The window, in the tenant's calendar and zone; resolved by the server. */
  start: campaignLocalMomentSchema,
  end: campaignLocalMomentSchema,
  /** The shared audience definition (`audience.ts`), parsed by the audience engine. */
  audience: z.unknown(),
  actions: campaignActionsSchema,
};

export const campaignCreateRequestSchema = z
  .object({ idempotencyKey: z.string().min(8).max(255), ...campaignDraftFields })
  .strict();
export type CampaignCreateRequest = z.input<typeof campaignCreateRequestSchema>;

export const campaignUpdateRequestSchema = campaignCreateRequestSchema;
export type CampaignUpdateRequest = z.input<typeof campaignUpdateRequestSchema>;

/**
 * One launched action's binding: what the preview showed for THAT engine — its count (of
 * customers, or of eligible services for a service gift) and the fingerprint of that set.
 */
export const campaignLaunchBindingSchema = z
  .object({
    count: z.number().int().nonnegative(),
    fingerprint: audienceFingerprintSchema,
    /** The count typed back, where the engine asks for it (`typedCountRequired`). */
    typedCount: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type CampaignLaunchBinding = z.output<typeof campaignLaunchBindingSchema>;

/**
 * The confirmation. It binds to what the preview showed: the audience's definition hash,
 * count and set, and each launched action's own count and set. A wallet gift ALSO binds its
 * total liability. The count is typed back (`typedCount`) whenever any engine the campaign
 * launches would ask for it (a wallet credit always; a large grant or broadcast).
 */
export const campaignScheduleRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    expectedDefinitionHash: z.string().regex(/^[0-9a-f]{64}$/u),
    expectedRecipients: z.number().int().nonnegative(),
    expectedFingerprint: audienceFingerprintSchema,
    walletGift: campaignLaunchBindingSchema
      .extend({ totalMinor: z.string().regex(/^[0-9]{1,24}$/u) })
      .nullable()
      .default(null),
    trafficGift: campaignLaunchBindingSchema.nullable().default(null),
    timeGift: campaignLaunchBindingSchema.nullable().default(null),
    confirmed: z.literal(true),
    /** The audience count typed back, where the announcement's size asks for it. */
    typedCount: z.number().int().nonnegative().nullable().default(null),
  })
  .strict();
export type CampaignScheduleRequest = z.input<typeof campaignScheduleRequestSchema>;

export const campaignActionViewSchema = z.object({
  kind: campaignActionKindSchema,
  state: z.enum(CAMPAIGN_ACTION_STATES),
  /**
   * The action's terms. For a discount or a cashback action that has made its rule, these
   * are the LIVE rule's terms (the rule may have been edited on the discounts page — one
   * rule, one truth); before that, and for every other kind, the terms as confirmed.
   */
  terms: z.unknown(),
  /** The linked rule's status now (`ACTIVE` / `INACTIVE`); null when there is no rule. */
  ruleStatus: z.string().nullable(),
  discountId: z.string().nullable(),
  cashbackRuleId: z.string().nullable(),
  /** The shared engine's own record: a broadcast id, or a bulk operation id. */
  broadcastId: z.string().nullable(),
  bulkOperationId: z.string().nullable(),
  failureCode: z.string().nullable(),
  launchedAt: z.iso.datetime().nullable(),
});
export type CampaignActionView = z.infer<typeof campaignActionViewSchema>;

export const campaignDetailSchema = campaignSummarySchema.extend({
  audience: z.unknown(),
  audienceHash: z.string(),
  audienceFingerprint: z.string().nullable(),
  actions: z.array(campaignActionViewSchema),
});
export type CampaignDetail = z.infer<typeof campaignDetailSchema>;

export const campaignResponseSchema = z.object({
  campaign: campaignDetailSchema,
  presentation: campaignPresentationSchema,
});
export type CampaignResponse = z.infer<typeof campaignResponseSchema>;

/** One mass action's preview, from the shared engine, for the confirmation to bind. */
const campaignGiftPreviewSchema = z.object({
  count: z.number().int().nonnegative(),
  customers: z.number().int().nonnegative(),
  fingerprint: audienceFingerprintSchema,
  totalLiability: moneySchema.nullable(),
});

/**
 * The preview (audit D7). Liability is given where it is DETERMINABLE: a wallet gift's exact
 * total; a fixed-amount discount's ceiling (value × total limit). A percentage discount and
 * cashback depend on orders nobody has placed, and are null rather than invented.
 */
export const campaignPreviewResponseSchema = z.object({
  audience: audiencePreviewSchema,
  discountMaxLiability: moneySchema.nullable(),
  walletGift: campaignGiftPreviewSchema.nullable(),
  trafficGift: campaignGiftPreviewSchema.nullable(),
  timeGift: campaignGiftPreviewSchema.nullable(),
  /** Which counts the confirmation must type back: the audience's, and each gift's. */
  typedCountRequired: z.object({
    audience: z.boolean(),
    walletGift: z.boolean(),
    trafficGift: z.boolean(),
    timeGift: z.boolean(),
  }),
});
export type CampaignPreviewResponse = z.infer<typeof campaignPreviewResponseSchema>;

/**
 * The results (audit D9): counts of PERSISTED rows that name the campaign's own records, and
 * nothing else — no revenue "caused", no conversion rate.
 */
export const campaignResultsResponseSchema = z.object({
  /** The audience the operator confirmed, and when. */
  targeted: z.number().int().nonnegative().nullable(),
  /** Redemptions of the campaign's discount rule, by the state their order is in now. */
  discountRedemptions: z.array(campaignTallySchema).nullable(),
  /** Cashback promises under the campaign's rule, by state, and what reversals took back. */
  cashback: z
    .object({
      byState: z.array(campaignTallySchema),
      /**
       * Per currency, never summed across currencies: what was credited, and what refunds
       * took back or could not recover.
       */
      totals: z.array(
        z.object({
          currency: z.enum(CURRENCY_CODES),
          earned: moneySchema,
          reversedRecovered: moneySchema,
          reversedUnrecovered: moneySchema,
        }),
      ),
    })
    .nullable(),
  /** The shared engines' own counts, read through. */
  announcement: broadcastCountsSchema.nullable(),
  walletGift: z
    .object({ counts: bulkCountsSchema, creditedTotal: moneySchema.nullable() })
    .nullable(),
  trafficGift: z.object({ counts: bulkCountsSchema }).nullable(),
  timeGift: z.object({ counts: bulkCountsSchema }).nullable(),
});
export type CampaignResultsResponse = z.infer<typeof campaignResultsResponseSchema>;

/** Paths under `API_PREFIX`. */
export const CAMPAIGN_ROUTES = {
  list: '/campaigns',
  create: '/campaigns',
  one: (id: string) => `/campaigns/${id}`,
  update: (id: string) => `/campaigns/${id}/draft`,
  preview: (id: string) => `/campaigns/${id}/preview`,
  schedule: (id: string) => `/campaigns/${id}/schedule`,
  pause: (id: string) => `/campaigns/${id}/pause`,
  resume: (id: string) => `/campaigns/${id}/resume`,
  cancel: (id: string) => `/campaigns/${id}/cancel`,
  results: (id: string) => `/campaigns/${id}/results`,
  /** Re-hands a confirmed action to its engine after an interrupted launch, by the same key. */
  launch: (id: string) => `/campaigns/${id}/launch`,
} as const;
