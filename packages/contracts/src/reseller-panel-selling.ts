import { z } from 'zod';
import { moneySchema } from './money.js';
import { miniAppProductSchema } from './miniapp.js';
import { resellerServiceRowSchema, resellerServicesResponseSchema } from './reseller-panel.js';

/**
 * The reseller web panel's selling half (phase «پنل نماینده», PR-5 §5.5–§5.8): buying one or
 * several services at once, the clients book, the auto-renew switch, reseller trials and the
 * tier-progress card. Paths are relative to `RESELLER_API_PREFIX`; wire conventions are the
 * panel's (money as `MoneyWire`, byte counts as decimal strings, instants ISO-8601 UTC).
 *
 * Nothing here is a second rule: every purchase is N ordinary orders through the bot's own
 * checkout (`PricingService`, `settleFromWallet`, `ResellerService.recordPurchase`); the
 * clients book is a label that never touches pricing or entitlement; auto-renew is Round 10
 * D1's consent; a reseller trial is the trial service's own claim.
 */

/** One purchase is at most this many services. */
export const RESELLER_PURCHASE_MAX_QUANTITY = 50;
/** The clients book's bounds (`reseller_clients`). */
export const RESELLER_CLIENT_NAME_MAX = 80;
export const RESELLER_CLIENT_CONTACT_MAX = 80;
export const RESELLER_CLIENT_NOTE_MAX = 500;
/** One catalogue page (servers, categories, plans). */
export const RESELLER_CATALOGUE_PAGE_SIZE = 20;

/** The audit actions the selling half writes. */
export const RESELLER_SELLING_AUDIT_ACTIONS = {
  PURCHASE_QUOTED: 'reseller_web.purchase_quoted',
  PURCHASE_CONFIRMED: 'reseller_web.purchase_confirmed',
  LINKS_SENT: 'reseller_web.purchase_links_sent',
  CLIENT_CREATED: 'reseller_web.client_created',
  CLIENT_UPDATED: 'reseller_web.client_updated',
  CLIENT_ARCHIVED: 'reseller_web.client_archived',
  CLIENT_SERVICE_ASSIGNED: 'reseller_web.client_service_assigned',
  CLIENT_SERVICE_UNASSIGNED: 'reseller_web.client_service_unassigned',
  CLIENT_RENEW_ALL: 'reseller_web.client_renew_all',
  TRIAL_ISSUED: 'reseller_web.trial_issued',
  /** Web Admin: the reseller's two-step sign-in removed by an operator (reason required). */
  TOTP_RESET: 'reseller_web.totp_reset',
  /** Web Admin: a tier's «هدف سطح بعد» set or cleared. */
  TIER_TARGET: 'reseller_web.tier_target',
} as const;
export type ResellerSellingAuditAction =
  (typeof RESELLER_SELLING_AUDIT_ACTIONS)[keyof typeof RESELLER_SELLING_AUDIT_ACTIONS];

/** The selling routes, relative to `RESELLER_API_PREFIX`. Literal paths only. */
export const RESELLER_SELLING_ROUTES = {
  catalogueServers: '/catalogue/servers',
  catalogueCategories: '/catalogue/categories',
  catalogueCategory: '/catalogue/categories/:categoryId',
  catalogueCustom: '/catalogue/custom',
  purchaseQuote: '/purchases/quote',
  purchase: '/purchases/:batchId',
  purchaseConfirm: '/purchases/:batchId/confirm',
  purchaseSendLinks: '/purchases/:batchId/send-links',
  clients: '/clients',
  client: '/clients/:clientId',
  clientArchive: '/clients/:clientId/archive',
  clientServices: '/clients/:clientId/services',
  clientRenewAll: '/clients/:clientId/renew-all',
  serviceClient: '/services/:serviceId/client',
  serviceAutoRenew: '/services/:serviceId/auto-renew',
  trial: '/trial',
  tierProgress: '/tier-progress',
} as const;

/** `/api/admin/v1` routes the selling half adds to the reseller drawer and the tier editor. */
export const RESELLER_SELLING_ADMIN_ROUTES = {
  totpReset: '/resellers/:customerId/web-panel/totp-reset',
  trials: '/resellers/:customerId/web-panel/trials',
  tierTarget: '/reseller-tiers/:tierId/next-target',
} as const;

const iso = z.string();
const uuid = z.string().uuid();

/** `reseller_web_daily_reports.kind`: the two daily reports a reseller may switch on. */
export const RESELLER_DAILY_REPORT_KINDS = ['EXPIRING_DIGEST', 'DAILY_SALES'] as const;
export type ResellerDailyReportKind = (typeof RESELLER_DAILY_REPORT_KINDS)[number];
/** `reseller_tier_targets.kind`: a monthly count of services, or a monthly sales amount. */
export const RESELLER_TIER_TARGET_KINDS = ['COUNT', 'AMOUNT'] as const;

// --- Catalogue (exactly the bot's reads) ------------------------------------------------

export const resellerCataloguePageQuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(1000).default(0),
  serverId: uuid.optional(),
});

/** `step` false: the server step is hidden (setting off, or one server can sell). */
export const resellerServersResponseSchema = z.object({
  enabled: z.boolean(),
  step: z.boolean(),
  items: z.array(z.object({ id: z.string(), name: z.string() })),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type ResellerServersResponse = z.infer<typeof resellerServersResponseSchema>;

export const resellerCategoriesResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), emoji: z.string().nullable() })),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type ResellerCategoriesResponse = z.infer<typeof resellerCategoriesResponseSchema>;

/** A plan card: `price` is the reseller's own price, `listPrice` the one struck through. */
export const resellerPlanSchema = miniAppProductSchema.extend({
  listPrice: moneySchema.nullable(),
});
export type ResellerPlan = z.infer<typeof resellerPlanSchema>;
export const resellerPlansResponseSchema = z.object({
  items: z.array(resellerPlanSchema),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type ResellerPlansResponse = z.infer<typeof resellerPlansResponseSchema>;

/**
 * «سرویس دلخواه»: offered exactly when the bot offers it to this reseller. Volume bounds are
 * in hundredths of a GB (the bot's units), days in days; both as decimal strings.
 */
export const resellerCustomOfferSchema = z.object({
  offered: z.boolean(),
  locations: z.array(
    z.object({
      panelId: z.string(),
      label: z.string(),
      volume: z.object({ min: z.string(), max: z.string() }),
      days: z.object({ min: z.string(), max: z.string() }),
    }),
  ),
});
export type ResellerCustomOffer = z.infer<typeof resellerCustomOfferSchema>;

// --- Buying -----------------------------------------------------------------------------

export const RESELLER_USERNAME_MODES = ['AUTOMATIC', 'CUSTOM'] as const;

export const resellerPurchaseQuoteRequestSchema = z.object({
  plan: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('PLAN'), productId: uuid }),
    z.object({
      kind: z.literal('CUSTOM'),
      panelId: uuid,
      /** As the bot reads it: GB, at most two decimals. */
      volume: z.string().trim().min(1).max(16),
      /** Whole days, as typed. */
      days: z.string().trim().min(1).max(8),
    }),
  ]),
  quantity: z.number().int().min(1).max(RESELLER_PURCHASE_MAX_QUANTITY),
  username: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('AUTOMATIC') }),
    z.object({ mode: z.literal('CUSTOM'), value: z.string().trim().min(1).max(64) }),
  ]),
  clientId: uuid.nullable().default(null),
  note: z.string().trim().max(RESELLER_CLIENT_NOTE_MAX).nullable().default(null),
});
export type ResellerPurchaseQuoteRequest = z.infer<typeof resellerPurchaseQuoteRequestSchema>;

/**
 * The quote: N drafts, each priced once by the pricing engine and honoured when paid.
 * `saving` («سود شما نسبت به قیمت عادی») is display only: list − your price, never below 0.
 * `sufficient` false: «خرید» becomes «شارژ کیف پول» — there is no credit.
 */
export const resellerPurchaseQuoteSchema = z.object({
  batchId: z.string(),
  title: z.string(),
  quantity: z.number().int(),
  unitPrice: moneySchema,
  listUnitPrice: moneySchema.nullable(),
  total: moneySchema,
  saving: moneySchema,
  balance: moneySchema,
  balanceAfter: moneySchema,
  sufficient: z.boolean(),
  shortfall: moneySchema.nullable(),
  usernameMode: z.enum(RESELLER_USERNAME_MODES),
  username: z.string().nullable(),
  clientId: z.string().nullable(),
  note: z.string().nullable(),
});
export type ResellerPurchaseQuote = z.infer<typeof resellerPurchaseQuoteSchema>;

/**
 * One service of a purchase. `QUOTED`: priced, not paid. `PAID`: paid, the service is being
 * made. `CREATED`: the service exists (its link once delivered). `FAILED`: nothing charged, or
 * whatever was charged went back to the wallet by the existing refund-on-undeliverable rule.
 */
export const RESELLER_PURCHASE_ITEM_STATUSES = ['QUOTED', 'PAID', 'CREATED', 'FAILED'] as const;
export type ResellerPurchaseItemStatus = (typeof RESELLER_PURCHASE_ITEM_STATUSES)[number];

export const resellerPurchaseItemSchema = z.object({
  index: z.number().int(),
  orderId: z.string(),
  orderCode: z.string().nullable(),
  status: z.enum(RESELLER_PURCHASE_ITEM_STATUSES),
  /** An error code (`commerce.*`, `reseller_web.*`) or the order's end state; null when fine. */
  reason: z.string().nullable(),
  total: moneySchema,
  serviceId: z.string().nullable(),
  username: z.string().nullable(),
  /** Null until delivered, and on a files-only panel. */
  subscriptionUrl: z.string().nullable(),
});
export const resellerPurchaseBatchSchema = z.object({
  batchId: z.string(),
  title: z.string(),
  quantity: z.number().int(),
  confirmed: z.boolean(),
  clientId: z.string().nullable(),
  clientName: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: iso,
  items: z.array(resellerPurchaseItemSchema),
});
export type ResellerPurchaseBatch = z.infer<typeof resellerPurchaseBatchSchema>;

export const resellerSendLinksResponseSchema = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
});

// --- Clients book («مشتری‌ها») ----------------------------------------------------------

export const resellerClientWriteSchema = z.object({
  name: z.string().trim().min(1).max(RESELLER_CLIENT_NAME_MAX),
  contact: z.string().trim().max(RESELLER_CLIENT_CONTACT_MAX).nullable().default(null),
  note: z.string().trim().max(RESELLER_CLIENT_NOTE_MAX).nullable().default(null),
});
export type ResellerClientWrite = z.infer<typeof resellerClientWriteSchema>;

export const resellerClientsQuerySchema = z.object({
  archived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  q: z.string().trim().max(64).optional(),
});

export const resellerClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  contact: z.string().nullable(),
  note: z.string().nullable(),
  serviceCount: z.number().int(),
  /** «رو به اتمام: …» when above 0, «همه فعال» otherwise. */
  expiringCount: z.number().int(),
  archived: z.boolean(),
  createdAt: iso,
});
export type ResellerClient = z.infer<typeof resellerClientSchema>;
export const resellerClientsResponseSchema = z.object({ items: z.array(resellerClientSchema) });
export type ResellerClientsResponse = z.infer<typeof resellerClientsResponseSchema>;

/** The auto-renew switch of one service (Round 10 D1), as the panel draws it. */
export const RESELLER_AUTO_RENEW_UNAVAILABLE = [
  'FEATURE_OFF',
  'NOT_AVAILABLE',
  /** «برای روشن کردن، پلن تمدید را انتخاب کنید»: an imported service with no plan chosen. */
  'PLAN_REQUIRED',
] as const;
export const resellerAutoRenewSchema = z.object({
  enabled: z.boolean(),
  /** Can be switched on now (with `price` as the figure to agree to). */
  offered: z.boolean(),
  /** The quote when offered, the consented ceiling when on; else null. */
  price: moneySchema.nullable(),
  leadHours: z.number().int(),
  imported: z.boolean(),
  /** The imported service's chosen plan, while on. */
  planId: z.string().nullable(),
  /** For an imported service: the plans the reseller may choose from (their entitlement's). */
  plans: z.array(z.object({ planId: z.string(), title: z.string(), price: moneySchema })),
  unavailable: z.enum(RESELLER_AUTO_RENEW_UNAVAILABLE).nullable(),
});
export type ResellerAutoRenew = z.infer<typeof resellerAutoRenewSchema>;
export const resellerAutoRenewWriteSchema = z.object({
  enabled: z.boolean(),
  /** Switching on: the figure the screen showed; the consent is recorded only at or below it. */
  expected: moneySchema.nullable().default(null),
  /** Switching on an imported service: the plan to renew into. */
  planId: uuid.nullable().default(null),
});

export const resellerClientServicesResponseSchema = z.object({
  items: z.array(resellerServiceRowSchema.extend({ autoRenew: resellerAutoRenewSchema })),
});
export type ResellerClientServicesResponse = z.infer<typeof resellerClientServicesResponseSchema>;

/**
 * PR-5: «سرویس‌های من» as the selling half answers it — each row with its auto-renew switch, so
 * the page reads no switch per row. A superset of PR-4's `resellerServicesResponseSchema`.
 */
export const resellerSellingServicesResponseSchema = resellerServicesResponseSchema.extend({
  items: z.array(resellerServiceRowSchema.extend({ autoRenew: resellerAutoRenewSchema })),
});
export type ResellerSellingServicesResponse = z.infer<typeof resellerSellingServicesResponseSchema>;

export const resellerServiceClientWriteSchema = z.object({ clientId: uuid.nullable() });

export const resellerRenewAllQuoteSchema = z.object({
  count: z.number().int(),
  total: moneySchema,
  balance: moneySchema,
  sufficient: z.boolean(),
  shortfall: moneySchema.nullable(),
  items: z.array(
    z.object({
      serviceId: z.string(),
      username: z.string(),
      price: moneySchema.nullable(),
      /** Why this ACTIVE service is not in the renewal (e.g. `PLAN_REQUIRED`); null when it is. */
      skipped: z.string().nullable(),
    }),
  ),
});
export type ResellerRenewAllQuote = z.infer<typeof resellerRenewAllQuoteSchema>;
/**
 * «تمدید همه», confirmed: the quote the reseller agreed to — each service renewed and the price
 * it was shown at. A quote is honoured, never re-priced: if the set of services or any price
 * differs when the renewals are drafted, nothing is paid (`commerce.reseller_terms_changed`).
 * At most the panel's services cap (`RESELLER_WEB_SERVICES_CAP`, 5000).
 */
export const resellerRenewAllRequestSchema = z.object({
  items: z.array(z.object({ serviceId: z.string().min(1), price: moneySchema })).max(5000),
});
export type ResellerRenewAllRequest = z.infer<typeof resellerRenewAllRequestSchema>;
export const RESELLER_RENEW_ITEM_STATUSES = ['RENEWED', 'FAILED', 'SKIPPED'] as const;
export const resellerRenewAllResultSchema = z.object({
  items: z.array(
    z.object({
      serviceId: z.string(),
      status: z.enum(RESELLER_RENEW_ITEM_STATUSES),
      reason: z.string().nullable(),
      orderId: z.string().nullable(),
    }),
  ),
});
export type ResellerRenewAllResult = z.infer<typeof resellerRenewAllResultSchema>;

// --- Trials («سرویس تست») ---------------------------------------------------------------

export const resellerTrialStatusSchema = z.object({
  /** Off when the quota is 0, no trial is chosen, or that trial is switched off. */
  enabled: z.boolean(),
  quota: z.number().int(),
  usedToday: z.number().int(),
});
export type ResellerTrialStatus = z.infer<typeof resellerTrialStatusSchema>;
export const resellerTrialIssuedSchema = z.object({
  serviceId: z.string(),
  orderId: z.string(),
  usedToday: z.number().int(),
  quota: z.number().int(),
});
export type ResellerTrialIssued = z.infer<typeof resellerTrialIssuedSchema>;
export const resellerAdminTrialsSchema = z.object({
  today: z.number().int(),
  quota: z.number().int(),
  total: z.number().int(),
});
export type ResellerAdminTrials = z.infer<typeof resellerAdminTrialsSchema>;

// --- Tier progress («پیشرفت تا سطح بعد») ------------------------------------------------

export const resellerTierTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('COUNT'), count: z.number().int().min(1).max(1_000_000) }),
  z.object({ kind: z.literal('AMOUNT'), amount: moneySchema }),
]);
export type ResellerTierTarget = z.infer<typeof resellerTierTargetSchema>;
export const resellerTierTargetWriteSchema = z.object({
  target: resellerTierTargetSchema.nullable(),
  idempotencyKey: z.string().min(8).max(200),
});
export const resellerTierTargetResponseSchema = z.object({
  target: resellerTierTargetSchema.nullable(),
});

/** Display only: no tier changes because of it. `shown` false hides the card. */
export const resellerTierProgressSchema = z.object({
  shown: z.boolean(),
  tierName: z.string().nullable(),
  target: resellerTierTargetSchema.nullable(),
  /** This calendar month's sales so far (the tenant's calendar). */
  count: z.number().int(),
  amount: moneySchema.nullable(),
  /** What is left to the target: services, or money in the target's currency; 0 when reached. */
  remainingCount: z.number().int().nullable(),
  remainingAmount: moneySchema.nullable(),
  /** The month's end (exclusive), for «… تا آخر <month>». */
  monthEnd: iso,
});
export type ResellerTierProgress = z.infer<typeof resellerTierProgressSchema>;

// --- Web Admin: reset of the reseller's two-step sign-in --------------------------------

export const resellerTotpResetRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().min(8).max(200),
});
export const resellerTotpResetResponseSchema = z.object({
  reset: z.boolean(),
  ended: z.number().int(),
});
