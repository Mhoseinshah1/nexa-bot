import { z } from 'zod';
import { moneySchema } from './money.js';
import { SERVICE_STATES } from './provisioning.js';
import { QR_PAYLOAD_KINDS } from './panel-qr.js';
import { TOTP_PARAMETERS, totpCodeSchema } from './admin-security.js';

/**
 * The reseller web panel (phase «پنل نماینده», PR-4): its paths, cookies, bounds, error
 * vocabulary, wire shapes and the bot copy that hands a reseller in.
 *
 * A second way in to what the bot already offers an ACTIVE reseller, never a second set of
 * rules: every route below calls the application service the bot's flow calls, as the same
 * `SYSTEM_JOB` actor the bot's turn acts as, in the scope of the bot the sign-in link came
 * from. What this file fixes is the shape on the wire (money as `MoneyWire`, byte counts as
 * decimal strings, instants as ISO-8601 UTC) and the session's own vocabulary.
 *
 * `apps/web` (`/r/…`) imports this file; the API builds its responses to it.
 */

/** The feature flag the whole panel sits behind (default OFF). */
export const RESELLER_WEB_PANEL_FEATURE = 'reseller_web_panel' as const;

/** Every reseller-panel API route is under this prefix. No admin session reaches it. */
export const RESELLER_API_PREFIX = '/api/reseller/v1';

/** The browser page a one-time link opens; the token rides in the FRAGMENT (never sent). */
export const RESELLER_WEB_LOGIN_PAGE_PATH = '/r/login';

/**
 * The reseller session cookie: its own name, never the Web Admin's. In production only the
 * `__Host-` spelling is read (the same shadowing reason as the admin cookie).
 */
export const RESELLER_SESSION_COOKIE_NAME = 'nexa_reseller_session';
export const RESELLER_SESSION_COOKIE_NAME_SECURE =
  `__Host-${RESELLER_SESSION_COOKIE_NAME}` as const;

/** A one-time sign-in link lives ten minutes and opens exactly one session. */
export const RESELLER_WEB_LINK_TTL_SECONDS = 600;
/** At most this many links per reseller per rolling hour. */
export const RESELLER_WEB_LINKS_PER_HOUR = 5;
/** A session ends after 30 days without a request… */
export const RESELLER_WEB_SESSION_IDLE_SECONDS = 30 * 24 * 3600;
/** …and 90 days after it was opened, whatever. */
export const RESELLER_WEB_SESSION_ABSOLUTE_SECONDS = 90 * 24 * 3600;
/** A session waiting for its second factor lives five minutes. */
export const RESELLER_WEB_SECOND_FACTOR_TTL_SECONDS = 300;
/** Wrong codes one pending session may present before it is ended. */
export const RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS = 5;
/** Sign-in attempts (link exchange and code step) per client address per minute. */
export const RESELLER_WEB_LOGIN_ATTEMPTS_PER_MINUTE = 20;
/** Connection-file fetches per service per reseller per rolling window. */
export const RESELLER_WEB_FILE_FETCHES_PER_WINDOW = 10;
export const RESELLER_WEB_FILE_FETCH_WINDOW_SECONDS = 600;
/** «رو به اتمام»: at most this many days left, or at most this share of traffic left. */
export const RESELLER_WEB_EXPIRING_DAYS = 7;
export const RESELLER_WEB_EXPIRING_TRAFFIC_PERCENT = 10;
/** Page sizes. */
export const RESELLER_WEB_SERVICES_PAGE_SIZE = 20;
export const RESELLER_WEB_ACTIVITY_PAGE_SIZE = 20;
export const RESELLER_WEB_WALLET_PAGE_SIZE = 20;
/** How many recent transactions and expiring services the dashboard shows. */
export const RESELLER_WEB_DASHBOARD_LIST_SIZE = 5;

/** A session row's states. `PENDING_SECOND_FACTOR` authorises the code step and nothing else. */
export const RESELLER_WEB_SESSION_STATES = ['PENDING_SECOND_FACTOR', 'ACTIVE'] as const;
export type ResellerWebSessionState = (typeof RESELLER_WEB_SESSION_STATES)[number];

/** Why a session ended. */
export const RESELLER_WEB_SESSION_END_REASONS = [
  'LOGOUT',
  'REVOKED',
  'REVOKED_ALL',
  'ADMIN_FORCE_LOGOUT',
  'SECOND_FACTOR_FAILED',
  'SECOND_FACTOR_ENABLED',
] as const;
export type ResellerWebSessionEndReason = (typeof RESELLER_WEB_SESSION_END_REASONS)[number];

/** A reseller's TOTP factor states (the Web Admin's own, `admin_totp_factors`). */
export const RESELLER_WEB_TOTP_STATES = ['PENDING', 'ACTIVE'] as const;
export type ResellerWebTotpState = (typeof RESELLER_WEB_TOTP_STATES)[number];

/** The audit actions this surface writes. Entity `Customer` (the reseller's customer id). */
export const RESELLER_WEB_AUDIT_ACTIONS = {
  LINK_ISSUED: 'reseller_web.link_issued',
  LOGIN: 'reseller_web.login',
  LOGIN_REFUSED: 'reseller_web.login_refused',
  SECOND_FACTOR: 'reseller_web.second_factor',
  LOGOUT: 'reseller_web.logout',
  SESSION_REVOKED: 'reseller_web.session_revoked',
  SESSIONS_REVOKED_ALL: 'reseller_web.sessions_revoked_all',
  FORCE_LOGOUT: 'reseller_web.force_logout',
  TOTP_ENROL: 'reseller_web.totp_enrol',
  TOTP_ENABLE: 'reseller_web.totp_enable',
  TOTP_DISABLE: 'reseller_web.totp_disable',
  PREFERENCES: 'reseller_web.preferences',
  FILES_FETCHED: 'reseller_web.files_fetched',
  FILES_SENT: 'reseller_web.files_sent',
  CONNECTION_SENT: 'reseller_web.connection_sent',
} as const;
export type ResellerWebAuditAction =
  (typeof RESELLER_WEB_AUDIT_ACTIONS)[keyof typeof RESELLER_WEB_AUDIT_ACTIONS];

/**
 * The audit actions shown to a reseller in «کارهای اخیر روی حساب»: their own sign-ins and
 * security changes, and the purchases, renewals and auto-renew changes made for their
 * customer id. Nothing an operator did is listed.
 */
export const RESELLER_WEB_ACTIVITY_ACTIONS = [
  RESELLER_WEB_AUDIT_ACTIONS.LOGIN,
  RESELLER_WEB_AUDIT_ACTIONS.LOGIN_REFUSED,
  RESELLER_WEB_AUDIT_ACTIONS.SECOND_FACTOR,
  RESELLER_WEB_AUDIT_ACTIONS.LOGOUT,
  RESELLER_WEB_AUDIT_ACTIONS.SESSION_REVOKED,
  RESELLER_WEB_AUDIT_ACTIONS.SESSIONS_REVOKED_ALL,
  RESELLER_WEB_AUDIT_ACTIONS.FORCE_LOGOUT,
  RESELLER_WEB_AUDIT_ACTIONS.TOTP_ENABLE,
  RESELLER_WEB_AUDIT_ACTIONS.TOTP_DISABLE,
  RESELLER_WEB_AUDIT_ACTIONS.PREFERENCES,
  RESELLER_WEB_AUDIT_ACTIONS.FILES_FETCHED,
  RESELLER_WEB_AUDIT_ACTIONS.FILES_SENT,
  RESELLER_WEB_AUDIT_ACTIONS.CONNECTION_SENT,
  // Purchases, renewals and add-ons (the order's confirmation and its wallet settlement).
  'order.confirm',
  'payment.wallet_settle',
  'payment.topup_request',
  // Auto-renew changes and the sweep's runs.
  'service.auto_renew_on',
  'service.auto_renew_off',
  'service.auto_renew_run',
  'service.customer_note',
] as const;

/** The routes, relative to `RESELLER_API_PREFIX`. Literal paths only. */
export const RESELLER_PANEL_ROUTES = {
  exchange: '/auth/exchange',
  secondFactor: '/auth/second-factor',
  logout: '/auth/logout',
  me: '/me',
  sessions: '/security/sessions',
  sessionRevoke: '/security/sessions/:sessionId/revoke',
  sessionsRevokeAll: '/security/sessions/revoke-all',
  activity: '/security/activity',
  totpEnrol: '/security/totp/enrol',
  totpActivate: '/security/totp/activate',
  totpDisable: '/security/totp/disable',
  preferences: '/settings/notifications',
  dashboard: '/dashboard',
  services: '/services',
  service: '/services/:serviceId',
  serviceNote: '/services/:serviceId/note',
  serviceQr: '/services/:serviceId/qr/:kind',
  serviceSendConnection: '/services/:serviceId/send-connection',
  serviceRotateLink: '/services/:serviceId/rotate-link',
  serviceFiles: '/services/:serviceId/files',
  serviceFile: '/services/:serviceId/files/:index',
  serviceFilesZip: '/services/:serviceId/files-zip',
  serviceFilesSend: '/services/:serviceId/files/send',
  serviceOffer: '/services/:serviceId/offer/:kind',
  serviceQuote: '/services/:serviceId/quote',
  orderPayWallet: '/orders/:orderId/pay-wallet',
  wallet: '/wallet',
  walletEntries: '/wallet/entries',
  walletTopupQuote: '/wallet/topup/quote',
  walletTopup: '/wallet/topup',
  /**
   * One of the reseller's own payments, as the mini app's `MINIAPP_ROUTES.payment` reads it
   * (`miniAppPaymentStatusSchema`): the screen re-reads a gateway attempt until the worker has
   * made its invoice, because the top-up answers before the payment link exists.
   */
  payment: '/payments/:paymentId',
  paymentTransferSent: '/payments/:paymentId/transfer-sent',
  paymentReceipt: '/payments/:paymentId/receipt',
  prices: '/prices',
  ticketCategories: '/ticket-categories',
  tickets: '/tickets',
  ticket: '/tickets/:ticketId',
  ticketReplies: '/tickets/:ticketId/replies',
  /** PR-6 «ربات اختصاصی»: the offer and the reseller's own requests (`reseller-hosted-bot.ts`). */
  ownBot: '/own-bot',
  ownBotRequests: '/own-bot/requests',
  ownBotCancel: '/own-bot/requests/:requestId/cancel',
  ownBotPay: '/own-bot/requests/:requestId/pay',
} as const;

/** `/api/admin/v1` routes of the reseller drawer (Web Admin). */
export const RESELLER_WEB_ADMIN_ROUTES = {
  summary: '/resellers/:customerId/web-panel',
  forceLogout: '/resellers/:customerId/web-panel/force-logout',
} as const;

/** The header a state-changing reseller-panel request names its own key in. */
export const RESELLER_IDEMPOTENCY_HEADER = 'idempotency-key';
export const resellerIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{16,64}$/u, 'An idempotency key is 16 to 64 letters, digits or dashes.');

const iso = z.string();
const bytes = z.string().regex(/^\d+$/u);

// --- Access -----------------------------------------------------------------------------

export const resellerExchangeRequestSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export type ResellerExchangeRequest = z.infer<typeof resellerExchangeRequestSchema>;

/** `SECOND_FACTOR_REQUIRED`: the cookie authorises only the code step until it is passed. */
export const resellerExchangeResponseSchema = z.object({
  state: z.enum(['ACTIVE', 'SECOND_FACTOR_REQUIRED']),
  expiresAt: iso,
});
export type ResellerExchangeResponse = z.infer<typeof resellerExchangeResponseSchema>;

export const resellerSecondFactorRequestSchema = z.object({ code: totpCodeSchema });

export const resellerMeResponseSchema = z.object({
  customer: z.object({
    firstName: z.string().nullable(),
    username: z.string().nullable(),
    telegramUserId: z.string(),
  }),
  reseller: z.object({ tierName: z.string(), since: iso }),
  balance: moneySchema,
  botUsername: z.string().nullable(),
  secondFactor: z.boolean(),
  session: z.object({ id: z.string(), expiresAt: iso }),
});
export type ResellerMeResponse = z.infer<typeof resellerMeResponseSchema>;

export const resellerSessionViewSchema = z.object({
  id: z.string(),
  current: z.boolean(),
  /** «Chrome on Android» style family, never the raw user agent. */
  device: z.string(),
  /** The /24 (or /48) network, e.g. `203.0.113.x`; never a full address. */
  network: z.string().nullable(),
  createdAt: iso,
  lastSeenAt: iso,
});
export const resellerSessionsResponseSchema = z.object({
  items: z.array(resellerSessionViewSchema),
});
export type ResellerSessionsResponse = z.infer<typeof resellerSessionsResponseSchema>;

export const resellerActivityQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
});
export const resellerActivityEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  result: z.string(),
  at: iso,
});
export const resellerActivityResponseSchema = z.object({
  items: z.array(resellerActivityEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ResellerActivityResponse = z.infer<typeof resellerActivityResponseSchema>;

export const resellerTotpEnrolResponseSchema = z.object({
  secret: z.string(),
  otpauthUri: z.string(),
  qrPngDataUrl: z.string().nullable(),
  expiresAt: iso,
  parameters: z.object({
    algorithm: z.literal(TOTP_PARAMETERS.algorithm),
    digits: z.literal(TOTP_PARAMETERS.digits),
    periodSeconds: z.literal(TOTP_PARAMETERS.periodSeconds),
  }),
});
export type ResellerTotpEnrolResponse = z.infer<typeof resellerTotpEnrolResponseSchema>;
export const resellerTotpCodeRequestSchema = z.object({ code: totpCodeSchema });

/** The reseller's own notification switches (real preferences, read by their lanes). */
export const resellerPreferencesSchema = z.object({
  newDeviceAlert: z.boolean(),
  expiringDigest: z.boolean(),
  dailySalesReport: z.boolean(),
  ticketReply: z.boolean(),
});
export type ResellerPreferences = z.infer<typeof resellerPreferencesSchema>;
export const RESELLER_PREFERENCE_DEFAULTS: ResellerPreferences = {
  newDeviceAlert: true,
  expiringDigest: true,
  dailySalesReport: false,
  ticketReply: true,
};
export const resellerPreferencesWriteSchema = resellerPreferencesSchema.partial();

// --- Admin drawer -----------------------------------------------------------------------

export const resellerWebPanelSummarySchema = z.object({
  lastLoginAt: iso.nullable(),
  activeSessions: z.number().int(),
  secondFactor: z.boolean(),
});
export type ResellerWebPanelSummary = z.infer<typeof resellerWebPanelSummarySchema>;
export const resellerWebForceLogoutRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().min(8).max(200),
});
export const resellerWebForceLogoutResponseSchema = z.object({ ended: z.number().int() });

// --- Services ---------------------------------------------------------------------------

/** The chips of «سرویس‌های من». `EXPIRING` is «رو به اتمام» (see the two bounds above). */
export const RESELLER_SERVICE_FILTERS = [
  'ALL',
  'ACTIVE',
  'EXPIRING',
  'EXPIRED',
  'SUSPENDED',
  'OTHER',
] as const;
export type ResellerServiceFilter = (typeof RESELLER_SERVICE_FILTERS)[number];

export const resellerServicesQuerySchema = z.object({
  filter: z.enum(RESELLER_SERVICE_FILTERS).default('ALL'),
  q: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(0).max(10_000).default(0),
});

export const resellerServiceRowSchema = z.object({
  id: z.string(),
  code: z.string().nullable(),
  username: z.string(),
  /** PR-5 fills this from the clients book; always null until then. */
  client: z.string().nullable(),
  note: z.string().nullable(),
  product: z.string().nullable(),
  location: z.string().nullable(),
  state: z.enum(SERVICE_STATES),
  trafficUsedBytes: bytes,
  trafficLimitBytes: bytes,
  expiresAt: iso.nullable(),
  expiring: z.boolean(),
  isTrial: z.boolean(),
});
export type ResellerServiceRow = z.infer<typeof resellerServiceRowSchema>;

export const resellerServicesResponseSchema = z.object({
  items: z.array(resellerServiceRowSchema),
  counts: z.record(z.enum(RESELLER_SERVICE_FILTERS), z.number().int()),
  page: z.number().int(),
  pages: z.number().int(),
  total: z.number().int(),
});
export type ResellerServicesResponse = z.infer<typeof resellerServicesResponseSchema>;

export const resellerServiceDetailSchema = resellerServiceRowSchema.extend({
  /** Null on a files-only panel, or while the service is not deliverable. */
  subscriptionUrl: z.string().nullable(),
  qrKinds: z.array(z.enum(QR_PAYLOAD_KINDS)),
  /** The sing-box profile name the panel sets (shown beside the sing-box QR). */
  singboxProfileName: z.string().nullable(),
  filesOnly: z.boolean(),
  filesOffered: z.boolean(),
  canRotateLink: z.boolean(),
  actions: z.array(z.enum(['RENEW', 'ADD_TRAFFIC', 'ADD_TIME'])),
  working: z.boolean(),
});
export type ResellerServiceDetail = z.infer<typeof resellerServiceDetailSchema>;

export const resellerServiceNoteRequestSchema = z.object({
  note: z.string().max(500).nullable(),
});

export const resellerConnectionFileSchema = z.object({
  index: z.number().int(),
  fileName: z.string(),
  sizeBytes: z.number().int(),
});
export const resellerConnectionFilesResponseSchema = z.object({
  files: z.array(resellerConnectionFileSchema),
});
export type ResellerConnectionFilesResponse = z.infer<typeof resellerConnectionFilesResponseSchema>;

/** What a Telegram send answered: how many messages / files went, or a Persian refusal code. */
export const resellerSendResultSchema = z.object({
  outcome: z.enum(['SENT', 'STOPPED']),
  sent: z.number().int(),
});

// --- Dashboard --------------------------------------------------------------------------

export const resellerDashboardSchema = z.object({
  balance: moneySchema,
  activeServices: z.number().int(),
  monthSales: z.object({ count: z.number().int(), amount: z.array(moneySchema) }),
  expiringCount: z.number().int(),
  expiring: z.array(resellerServiceRowSchema),
  tier: z.object({
    name: z.string(),
    pricingMode: z.string(),
    discountPercent: z.number().nullable(),
  }),
  recentTransactions: z.array(
    z.object({
      id: z.string(),
      direction: z.enum(['CREDIT', 'DEBIT']),
      reason: z.string(),
      amount: moneySchema,
      at: iso,
    }),
  ),
});
export type ResellerDashboard = z.infer<typeof resellerDashboardSchema>;

// --- Wallet -----------------------------------------------------------------------------

export const RESELLER_WALLET_FILTERS = ['ALL', 'CREDIT', 'DEBIT'] as const;
export const resellerWalletEntriesQuerySchema = z.object({
  direction: z.enum(RESELLER_WALLET_FILTERS).default('ALL'),
  cursor: z.string().max(200).optional(),
});

// --- Prices -----------------------------------------------------------------------------

export const resellerPriceRowSchema = z.object({
  productId: z.string(),
  title: z.string(),
  trafficBytes: bytes.nullable(),
  durationDays: z.number().int().nullable(),
  listPrice: moneySchema,
  yourPrice: moneySchema,
  discountPercent: z.number(),
});
export const resellerPricesResponseSchema = z.object({
  groups: z.array(
    z.object({
      categoryId: z.string().nullable(),
      title: z.string().nullable(),
      items: z.array(resellerPriceRowSchema),
    }),
  ),
});
export type ResellerPricesResponse = z.infer<typeof resellerPricesResponseSchema>;
