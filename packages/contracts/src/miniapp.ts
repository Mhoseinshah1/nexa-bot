import { z } from 'zod';
import { moneySchema } from './money.js';
import { ORDER_PURPOSES, ORDER_STATES } from './commerce.js';
import { SERVICE_STATES } from './provisioning.js';
import { PAYMENT_GATEWAY_PROVIDERS } from './payment-gateways.js';
import { PAYMENT_METHODS, PAYMENT_STATES } from './payment.js';
import { TICKET_MESSAGE_MAX_LENGTH, TICKET_STATUSES } from './tickets.js';
import { CLIENT_APP_PLATFORMS } from './client-apps.js';
import { LEDGER_DIRECTIONS, LEDGER_REASONS } from './ledger.js';
import { GIFT_CARD_CODE_INPUT_MAX_LENGTH } from './gift-cards.js';
import { QR_PAYLOAD_KINDS } from './panel-qr.js';

/**
 * The customer's Telegram Mini App (Round 9, C5): its paths, its wire shapes and its bounds.
 *
 * The mini app is a second way in to what the bot already offers, never a second set of
 * rules. Every endpoint below calls the application service the bot's flow calls, under the
 * same scope, the same `SYSTEM_JOB` actor with the same permissions, and the same gates
 * (blocked, required channels, terms). What this file fixes is only the shape on the wire:
 * money as `MoneyWire` (decimal-string minor units and a currency), byte counts as decimal
 * strings, instants as ISO-8601 UTC, and nothing an element of the design would need that
 * the API does not have — a field the server cannot fill is not declared.
 *
 * `apps/miniapp` imports this file; the API builds its responses to it.
 */

/** Where the mini app's document is served: `/miniapp/<botInstanceId>/`. */
export const MINIAPP_PATH = '/miniapp';

/** Every mini-app API route is under this prefix. Not `/api/admin/v1`: no admin session reaches it. */
export const MINIAPP_API_PREFIX = '/miniapp/api/v1';

/** The bearer scheme a session token is sent with (`Authorization: Bearer <token>`). */
export const MINIAPP_AUTH_SCHEME = 'Bearer';

/**
 * The header a state-changing request names its own key in. The server namespaces it
 * (`miniapp:<bot>:<customer>:<key>:<operation>`), so a key a client invents can only ever
 * replay that client's own customer's own operation.
 */
export const MINIAPP_IDEMPOTENCY_HEADER = 'idempotency-key';

/** A client key: a UUID-shaped token, nothing a log line or a SQL fragment could hide in. */
export const miniAppIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{16,64}$/u, 'An idempotency key is 16 to 64 letters, digits or dashes.');

/** `miniapp.init_data_max_age_seconds` bounds: a minute to a day. */
export const MINIAPP_INIT_DATA_MAX_AGE_SECONDS_MIN = 60;
export const MINIAPP_INIT_DATA_MAX_AGE_SECONDS_MAX = 86_400;
/** `miniapp.session_ttl_minutes` bounds. */
export const MINIAPP_SESSION_TTL_MINUTES_MIN = 5;
export const MINIAPP_SESSION_TTL_MINUTES_MAX = 240;
/**
 * How far in the FUTURE an `auth_date` may be and still be accepted, in seconds: Telegram's
 * clock and ours are not the same clock. Beyond this a launch is refused as expired.
 */
export const MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS = 60;
/** The longest `initData` accepted. Telegram's is well under 2 KB; this is a ceiling, not a size. */
export const MINIAPP_INIT_DATA_MAX_LENGTH = 8192;

/**
 * The request budget of one customer on one bot, per rolling window. A screen issues a
 * handful of reads; this is generous for a person and a floor for a script.
 */
export const MINIAPP_RATE_LIMIT_REQUESTS = 120;
export const MINIAPP_RATE_LIMIT_WINDOW_MS = 60_000;
/** The session endpoint's budget per client address, per window: minting is cheap to ask for. */
export const MINIAPP_SESSION_RATE_LIMIT_REQUESTS = 30;

/** The largest request body a mini-app route reads, in bytes. */
export const MINIAPP_BODY_LIMIT_BYTES = 16 * 1024;

/**
 * The largest receipt image the mini app accepts, in bytes (owner correction 2026-10-25:
 * receipts are uploaded in the mini app). Five megabytes: above any phone screenshot or
 * banking-app capture, half of Telegram's own 10 MB photo limit, and a quarter of
 * `PAYMENT_RECEIPT_MAX_BYTES`, the bound a reviewer's download is held to.
 */
export const MINIAPP_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
/** The receipt route's body limit: the image as base64 plus the JSON around it. */
export const MINIAPP_RECEIPT_BODY_LIMIT_BYTES =
  Math.ceil((MINIAPP_RECEIPT_MAX_BYTES * 4) / 3) + 4096;
/** The image types a receipt may be, decided from the bytes and matched against the declared type. */
export const MINIAPP_RECEIPT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Every route, relative to `MINIAPP_API_PREFIX`. */
export const MINIAPP_ROUTES = {
  session: '/bots/:botInstanceId/session',
  me: '/me',
  gateCheck: '/gate/check',
  termsAccept: '/terms/accept',
  categories: '/catalogue/categories',
  category: '/catalogue/categories/:categoryId',
  orders: '/orders',
  order: '/orders/:orderId',
  orderUsername: '/orders/:orderId/username',
  orderDiscount: '/orders/:orderId/discount',
  orderConfirm: '/orders/:orderId/confirm',
  orderCancel: '/orders/:orderId/cancel',
  orderRoutes: '/orders/:orderId/payment-routes',
  orderPayWallet: '/orders/:orderId/pay/wallet',
  orderPayGateway: '/orders/:orderId/pay/gateway',
  orderPayCard: '/orders/:orderId/pay/card',
  payment: '/payments/:paymentId',
  paymentTransferSent: '/payments/:paymentId/transfer-sent',
  paymentCheck: '/payments/:paymentId/check',
  paymentReceipt: '/payments/:paymentId/receipt',
  payments: '/payments',
  services: '/services',
  service: '/services/:serviceId',
  serviceQr: '/services/:serviceId/qr',
  // R11 A4: one named QR of a service (`SUB_LINK` or `SINGBOX`) on a panel that offers both.
  serviceQrKind: '/services/:serviceId/qr/:kind',
  serviceOffer: '/services/:serviceId/offers/:kind',
  serviceQuote: '/services/:serviceId/quotes',
  serviceLocations: '/services/:serviceId/locations',
  serviceLocation: '/services/:serviceId/location',
  // Round 10, D1: switch automatic renewal on or off for one service.
  serviceAutoRenew: '/services/:serviceId/auto-renew',
  wallet: '/wallet',
  walletEntries: '/wallet/entries',
  walletTopupQuote: '/wallet/topup/quote',
  walletTopup: '/wallet/topup',
  /** R10 D4: redeem a gift card into the wallet. */
  walletGiftCard: '/wallet/gift-card',
  referral: '/referral',
  trial: '/trial',
  ticketCategories: '/ticket-categories',
  tickets: '/tickets',
  ticket: '/tickets/:ticketId',
  ticketReplies: '/tickets/:ticketId/replies',
  support: '/support',
  guide: '/guide',
  guidePlatform: '/guide/:platform',
  /** Round 11, B1: the notification centre (feature `notification_centre`). */
  notifications: '/notifications',
  notificationRead: '/notifications/:notificationId/read',
  notificationsReadAll: '/notifications/read-all',
} as const;

/** A route with its parameters filled, URI-encoded. */
export function miniAppPath(route: string, params: Readonly<Record<string, string>> = {}): string {
  return route.replace(/:([A-Za-z]+)/gu, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing route parameter ${name}.`);
    return encodeURIComponent(value);
  });
}

const isoSchema = z.string();
/** A byte count, as a decimal string (a bigint on the server). */
const bytesSchema = z.string().regex(/^\d+$/u);
const idSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Session and identity
// ---------------------------------------------------------------------------

export const miniAppSessionRequestSchema = z.object({
  initData: z.string().min(1).max(MINIAPP_INIT_DATA_MAX_LENGTH),
});
export type MiniAppSessionRequest = z.infer<typeof miniAppSessionRequestSchema>;

export const miniAppSessionResponseSchema = z.object({
  token: z.string(),
  expiresAt: isoSchema,
});
export type MiniAppSessionResponse = z.infer<typeof miniAppSessionResponseSchema>;

/**
 * R10 D5: `CAPTCHA` is the bot's `/start` question for a customer who first arrived while
 * `start_captcha` was on and has not answered it yet. It is answered in the chat, never in
 * the mini app: the mini app only says so and links to the bot.
 */
export const MINIAPP_GATES = ['BLOCKED', 'CAPTCHA', 'CHANNELS', 'TERMS'] as const;
export type MiniAppGate = (typeof MINIAPP_GATES)[number];

const channelSchema = z.object({
  /** `@handle` of a public channel; null for a private one (numbered by the client). */
  handle: z.string().nullable(),
  joinUrl: z.string(),
});

const termsSchema = z.object({
  versionId: idSchema,
  title: z.string(),
  body: z.string(),
});

export const miniAppMeResponseSchema = z.object({
  customer: z.object({
    firstName: z.string().nullable(),
    username: z.string().nullable(),
  }),
  /** The bot's own `t.me` link, for the steps that continue in the chat. Null when unknown. */
  botLink: z.string().nullable(),
  /** The gate the customer is held at, or null. Every gated endpoint refuses while it is set. */
  gate: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('BLOCKED') }),
      z.object({ kind: z.literal('CAPTCHA') }),
      z.object({ kind: z.literal('CHANNELS'), channels: z.array(channelSchema) }),
      z.object({ kind: z.literal('TERMS'), terms: termsSchema }),
    ])
    .nullable(),
  /** Null while gated: nothing behind a gate is read for a customer held at one. */
  wallet: z.object({ balance: moneySchema }).nullable(),
  /** An ACTIVE reseller's standing; null for everybody else (SUSPENDED is an ordinary customer). */
  reseller: z.object({ tierName: z.string() }).nullable(),
  /**
   * Round 11, B1: the bell. Null while the feature `notification_centre` is off (no bell is
   * drawn) and while gated; otherwise how many delivered messages the customer has not read.
   * Defaulted so a client built before it still parses an older answer.
   */
  notifications: z.object({ unreadCount: z.number().int().nonnegative() }).nullable().default(null),
});
export type MiniAppMeResponse = z.infer<typeof miniAppMeResponseSchema>;

export const miniAppTermsAcceptRequestSchema = z.object({ termsVersionId: idSchema });

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export const miniAppPageQuerySchema = z.object({
  page: z.coerce.number().int().min(0).max(100).default(0),
});

export const miniAppCategoriesResponseSchema = z.object({
  items: z.array(z.object({ id: idSchema, name: z.string(), emoji: z.string().nullable() })),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type MiniAppCategoriesResponse = z.infer<typeof miniAppCategoriesResponseSchema>;

/**
 * R11 A9: the personal discount a listed line carries (R10 D3) — set only when the
 * customer's personal discount wins that line's quote at the pricing boundary, and then
 * `price` is the total the checkout quotes. The line's own `price` stays what the list
 * showed before (struck through beside this one). Null everywhere else: no percent, the
 * flag off, a purpose it does not apply to, or another single discount as large or larger.
 */
export const miniAppListedPersonalDiscountSchema = z.object({
  percent: z.number().int().min(1).max(100),
  price: moneySchema,
});
export type MiniAppListedPersonalDiscount = z.infer<typeof miniAppListedPersonalDiscountSchema>;

export const miniAppProductSchema = z.object({
  id: idSchema,
  title: z.string(),
  price: moneySchema,
  /** R11 A9. Defaulted so a client meeting an older server reads "none". */
  personalDiscount: miniAppListedPersonalDiscountSchema.nullable().default(null),
  trafficBytes: bytesSchema,
  durationDays: z.number().int(),
  /** The device limit the plan is sold with; null when the plan does not limit devices. */
  deviceLimit: z.number().int().nullable(),
  /** The operator's display text, verbatim; empty when the operator wrote none. */
  locations: z.array(z.string()),
  features: z.array(z.string()),
});
export type MiniAppProduct = z.infer<typeof miniAppProductSchema>;

export const miniAppCategoryResponseSchema = z.object({
  items: z.array(miniAppProductSchema),
  page: z.number().int(),
  hasMore: z.boolean(),
});
export type MiniAppCategoryResponse = z.infer<typeof miniAppCategoryResponseSchema>;

// ---------------------------------------------------------------------------
// Orders: the pre-invoice and its edits
// ---------------------------------------------------------------------------

export const miniAppCreateOrderRequestSchema = z.object({ productId: idSchema });

export const MINIAPP_USERNAME_MODES = ['CUSTOM', 'AUTOMATIC'] as const;

export const miniAppOrderSchema = z.object({
  id: idSchema,
  /** The public code the customer quotes and every log prints. */
  code: z.string(),
  state: z.enum(ORDER_STATES),
  purpose: z.enum(ORDER_PURPOSES),
  title: z.string(),
  /** The allowance bought: null where the purpose does not set it (an extra-traffic package sets traffic only). */
  trafficBytes: bytesSchema.nullable(),
  durationDays: z.number().int().nullable(),
  subtotal: moneySchema,
  discount: moneySchema,
  total: moneySchema,
  /** Whether a code is applied. The code itself is not echoed. */
  discountApplied: z.boolean(),
  /**
   * R10 D3: the customer's personal discount percent when the order's frozen quote was
   * priced with it (it won over every other discount); null otherwise. The invoice names
   * it on the discount line. Defaulted so a client meeting an older server reads "none".
   */
  personalDiscountPercent: z.number().int().min(1).max(100).nullable().default(null),
  /** Whether a code may be applied or removed now (a DRAFT purchase only). */
  discountEditable: z.boolean(),
  /** The cashback this order promises, earned at delivery; null when none. */
  cashback: moneySchema.nullable(),
  expiresAt: isoSchema.nullable(),
  /** The existing service a renewal or a package is for; null for a purchase. */
  serviceId: idSchema.nullable(),
  /** The service's username: reserved for a purchase, the service's own for an action. */
  username: z.string().nullable(),
  /** The ways a username may still be chosen; empty once one is reserved, or when none is asked. */
  usernameModes: z.array(z.enum(MINIAPP_USERNAME_MODES)),
  locations: z.array(z.string()),
  features: z.array(z.string()),
  description: z.string().nullable(),
});
export type MiniAppOrder = z.infer<typeof miniAppOrderSchema>;

export const miniAppUsernameRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('AUTOMATIC') }),
  z.object({ mode: z.literal('CUSTOM'), username: z.string().min(1).max(64) }),
]);

export const miniAppDiscountRequestSchema = z.object({
  /** Null removes the code. */
  code: z.string().min(1).max(64).nullable(),
});

// ---------------------------------------------------------------------------
// Payment routes and paying
// ---------------------------------------------------------------------------

export const MINIAPP_ROUTE_KINDS = ['GATEWAY', 'CARD_TO_CARD'] as const;

export const miniAppPaymentRoutesResponseSchema = z.object({
  wallet: z.object({
    balance: moneySchema,
    /** False when the balance does not cover the total (or is in another currency). */
    sufficient: z.boolean(),
    /** What a top-up would have to add; null when sufficient. */
    shortfall: moneySchema.nullable(),
  }),
  /** Exactly the routes the bot would draw for this order, in the same order. */
  routes: z.array(
    z.object({
      provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
      kind: z.enum(MINIAPP_ROUTE_KINDS),
      name: z.string(),
      /**
       * True for a route whose invoice is a message in the bot's chat (Stars, a Telegram-bound
       * gateway): the customer pays there, and the mini app says so.
       */
      paysInChat: z.boolean(),
    }),
  ),
});
export type MiniAppPaymentRoutesResponse = z.infer<typeof miniAppPaymentRoutesResponseSchema>;

export const miniAppGatewayPayRequestSchema = z.object({
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
});

export const miniAppWalletPayResponseSchema = z.object({
  order: miniAppOrderSchema,
  paymentId: idSchema,
});

/** A card-to-card instruction: where to send exactly how much, and until when. */
export const miniAppCardInstructionSchema = z.object({
  paymentId: idSchema,
  orderId: idSchema.nullable(),
  /** What must be TRANSFERRED: the payable, including any customer fee. */
  amount: moneySchema,
  /** That amount as the digits a banking app takes — rial, no separators — the bot's copy button. */
  copyAmount: z.string(),
  /**
   * v0.8.2 hotfix: that amount as the bot's card invoice shows it (R8 A2) — RIAL, Persian
   * digits grouped by thousands, no unit (`۲٬۵۰۰٬۰۰۰`) — and the same amount in Toman for the
   * bracket beside it (null when the rial figure is not a whole toman). Both null for an
   * amount in neither currency. Display only: what Nexa settles is the payment's principal.
   */
  amountRial: z.string().nullable(),
  amountToman: z.string().nullable(),
  /*
   * R10 B6: no principal and fee apart. The bot's card invoice (R8 A2) states ONE amount —
   * the one to transfer — and never a fee breakdown or the word «کارمزد»; the mini app's
   * card screen is that invoice, so the wire no longer carries the figures to break it down.
   */
  /** The tracking code the customer quotes. */
  reference: z.string(),
  expiresAt: isoSchema.nullable(),
  /** The destination snapshot the payment was issued against; null for a payment issued before one existed. */
  destination: z
    .object({
      cardNumber: z.string(),
      /** The sixteen digits without spaces: what the bot's copy-card button copies. */
      copyCardNumber: z.string(),
      holderName: z.string().nullable(),
      bankName: z.string().nullable(),
    })
    .nullable(),
});
export type MiniAppCardInstruction = z.infer<typeof miniAppCardInstructionSchema>;

export const miniAppTransferSentResponseSchema = z.object({
  /** Minutes a receipt may be sent in; null when no receipt is asked for (full, or under review). */
  receiptWindowMinutes: z.number().int().nullable(),
  reference: z.string(),
});

/** A receipt image: its declared type and its bytes, base64. The bytes decide the type. */
export const miniAppReceiptRequestSchema = z.object({
  mimeType: z.string().min(1).max(64),
  imageBase64: z
    .string()
    .min(1)
    .max(Math.ceil((MINIAPP_RECEIPT_MAX_BYTES * 4) / 3) + 4),
});
export const miniAppReceiptResponseSchema = z.object({
  paymentId: idSchema,
  /** False when this exact file was already on the payment. */
  filed: z.boolean(),
  /** True for the payment's first receipt. */
  first: z.boolean(),
});

export const miniAppGatewayAttemptSchema = z.object({
  paymentId: idSchema,
  orderId: idSchema.nullable(),
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
  /** Whether the provider's invoice exists yet; the link appears once it does. */
  invoiceReady: z.boolean(),
  /** Where the customer pays: the provider's page. Null until ready, or for an in-chat invoice. */
  payUrl: z.string().nullable(),
  paysInChat: z.boolean(),
  expiresAt: isoSchema.nullable(),
});
export type MiniAppGatewayAttempt = z.infer<typeof miniAppGatewayAttemptSchema>;

/**
 * What a customer may know about their own payment, from the reads the bot already has:
 * the gateway attempt, the pending transfer, whether a receipt was filed, and the order.
 * There is no timeline — the outcome reaches the customer through the bot's notifications.
 */
export const miniAppPaymentStatusSchema = z.object({
  paymentId: idSchema,
  method: z.enum(PAYMENT_METHODS),
  /** The payment's state when the read that knows it can say (a gateway attempt); else null. */
  state: z.enum(PAYMENT_STATES).nullable(),
  /** True while a card-to-card transfer is still open for this customer. */
  transferPending: z.boolean(),
  receiptFiled: z.boolean(),
  gateway: miniAppGatewayAttemptSchema.nullable(),
  order: z
    .object({ id: idSchema, code: z.string(), state: z.enum(ORDER_STATES), title: z.string() })
    .nullable(),
});
export type MiniAppPaymentStatus = z.infer<typeof miniAppPaymentStatusSchema>;

/** The customer's own payments, newest first (a keyset page). */
export const miniAppPaymentListSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      code: z.string().nullable(),
      method: z.enum(PAYMENT_METHODS),
      state: z.enum(PAYMENT_STATES),
      amount: moneySchema,
      /** The route a gateway or card-to-card payment took; null for a wallet settlement. */
      provider: z.enum(PAYMENT_GATEWAY_PROVIDERS).nullable(),
      /** True for a wallet top-up (no order). */
      topup: z.boolean(),
      createdAt: isoSchema,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type MiniAppPaymentList = z.infer<typeof miniAppPaymentListSchema>;

export const miniAppCursorQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export const MINIAPP_SERVICE_ACTIONS = ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME'] as const;
export type MiniAppServiceAction = (typeof MINIAPP_SERVICE_ACTIONS)[number];

export const miniAppServiceSummarySchema = z.object({
  id: idSchema,
  code: z.string().nullable(),
  title: z.string(),
  state: z.enum(SERVICE_STATES),
  username: z.string(),
  trafficUsedBytes: bytesSchema,
  trafficLimitBytes: bytesSchema,
  expiresAt: isoSchema.nullable(),
  /** When the usage figures were read from the panel; null until the first read. */
  usageSyncedAt: isoSchema.nullable(),
  deviceLimit: z.number().int().nullable(),
  locationLabel: z.string().nullable(),
  isTrial: z.boolean(),
});
export type MiniAppServiceSummary = z.infer<typeof miniAppServiceSummarySchema>;

export const miniAppServicesResponseSchema = z.object({
  items: z.array(miniAppServiceSummarySchema),
  page: z.number().int(),
  pages: z.number().int(),
  total: z.number().int(),
});
export type MiniAppServicesResponse = z.infer<typeof miniAppServicesResponseSchema>;

/**
 * Round 10, D1: automatic renewal of one service, as the customer may act on it now.
 *
 * - `offered` — the switch can be turned ON: the feature is on and this service can be renewed
 *   automatically (not imported, has a deadline, renewable now). A service already opted in is
 *   always shown, so it can be turned off whatever else changed.
 * - `enabled` — the customer's consent is recorded for this service.
 * - `price` — the renewal total quoted now when `offered` (what switching on agrees to), the
 *   consented total when `enabled`, else null. Never a client-supplied figure.
 * - `leadHours` — how long before the deadline the renewal runs.
 */
export const miniAppAutoRenewSchema = z.object({
  offered: z.boolean(),
  enabled: z.boolean(),
  price: moneySchema.nullable(),
  leadHours: z.number().int(),
});
export type MiniAppAutoRenew = z.infer<typeof miniAppAutoRenewSchema>;

/**
 * Switch it on (the server quotes and records that total as the consent) or off.
 *
 * `expected` — switching ON only: the renewal total the confirmation SHOWED (the `price` of the
 * state the customer confirmed). The server records its own fresh quote, and only when that
 * quote is at or below `expected` in the same currency; otherwise — or with no `expected` —
 * nothing is recorded and the answer is the state with the new price, to be confirmed again
 * (Codex review of PR 338: a price that rose between the screen and the tap must never become
 * the consent). A client that sends a figure it was not shown only raises its own ceiling, and
 * the consent is still the server's quote, never this figure. Ignored when switching off.
 */
export const miniAppAutoRenewRequestSchema = z.object({
  enabled: z.boolean(),
  expected: moneySchema.optional(),
});

export const miniAppServiceDetailSchema = miniAppServiceSummarySchema.extend({
  /** The subscription link, only while the service is deliverable. A secret: never logged. */
  subscriptionUrl: z.string().nullable(),
  /** Whether a change is still being applied; the actions wait until it has its answer. */
  working: z.boolean(),
  /** The actions offered now, re-decided by every quote. */
  actions: z.array(z.enum(MINIAPP_SERVICE_ACTIONS)),
  /** Whether a QR of the link can be fetched (`MINIAPP_ROUTES.serviceQr`). */
  qr: z.boolean(),
  /**
   * R11 A4: the QRs the sheet shows, in order — `SUB_LINK`, `SINGBOX`, both or none (none on a
   * files-only panel). Each is fetched from `MINIAPP_ROUTES.serviceQrKind`. `qr` above stays
   * true exactly when this is not empty.
   */
  qrKinds: z.array(z.enum(QR_PAYLOAD_KINDS)),
  /** Whether the location sheet has anything to offer now (`CHANGE_LOCATION` is available). */
  canChangeLocation: z.boolean(),
  /** Round 10, D1: «تمدید خودکار» for this service (`MINIAPP_ROUTES.serviceAutoRenew`). */
  autoRenew: miniAppAutoRenewSchema,
});
export type MiniAppServiceDetail = z.infer<typeof miniAppServiceDetailSchema>;

export const miniAppServiceOfferSchema = z.object({
  kind: z.enum(MINIAPP_SERVICE_ACTIONS),
  options: z.array(
    z.object({
      /** What a quote names: a package id, a panel plan id, or null for the service's own renewal. */
      addonId: idSchema.nullable(),
      planId: idSchema.nullable(),
      title: z.string(),
      price: moneySchema,
      /** R11 A9, as on a product. Defaulted so a client meeting an older server reads "none". */
      personalDiscount: miniAppListedPersonalDiscountSchema.nullable().default(null),
    }),
  ),
});
export type MiniAppServiceOffer = z.infer<typeof miniAppServiceOfferSchema>;

export const miniAppServiceQuoteRequestSchema = z.object({
  kind: z.enum(MINIAPP_SERVICE_ACTIONS),
  addonId: idSchema.nullable().default(null),
  planId: idSchema.nullable().default(null),
});

/**
 * The location sheet's read: where the service is and the configured targets it may be moved
 * to, each with its price (zero is free). The server's offer already leaves out every target
 * the cooldown and the rolling limit refuse; it exposes no remaining count, no
 * recommendation and no per-target capacity, and neither does this.
 */
export const miniAppServiceLocationsSchema = z.object({
  current: z.object({ label: z.string() }),
  targets: z.array(z.object({ id: idSchema, label: z.string(), price: moneySchema })),
});
export type MiniAppServiceLocations = z.infer<typeof miniAppServiceLocationsSchema>;

export const miniAppServiceLocationRequestSchema = z.object({ locationId: idSchema });

/**
 * A move asked for. A FREE target is requested at once (`REQUESTED`: the move is planned and
 * its outcome arrives through the bot's notification lane, as for the bot's confirm); a PRICED
 * target becomes the ordinary DRAFT order (`ORDER`) paid through the same checkout.
 */
export const miniAppServiceLocationResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('REQUESTED') }),
  z.object({ outcome: z.literal('ORDER'), order: miniAppOrderSchema }),
]);
export type MiniAppServiceLocationResult = z.infer<typeof miniAppServiceLocationResultSchema>;

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export const miniAppWalletResponseSchema = z.object({
  balance: moneySchema,
  presets: z.array(moneySchema),
  minimum: moneySchema.nullable(),
  maximum: moneySchema.nullable(),
  /** R10 D4: whether the gift-card field is drawn — the `gift_cards` flag, read per request. */
  giftCards: z.boolean(),
});
export type MiniAppWalletResponse = z.infer<typeof miniAppWalletResponseSchema>;

/** The customer's own ledger, newest first (a keyset page). Read-only. */
export const miniAppWalletEntriesSchema = z.object({
  items: z.array(
    z.object({
      id: idSchema,
      direction: z.enum(LEDGER_DIRECTIONS),
      reason: z.enum(LEDGER_REASONS),
      /** Positive; the sign is the direction. */
      amount: moneySchema,
      createdAt: isoSchema,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type MiniAppWalletEntries = z.infer<typeof miniAppWalletEntriesSchema>;

export const miniAppTopupQuoteRequestSchema = z.object({ amount: moneySchema });
export const miniAppTopupQuoteResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('BELOW_MINIMUM'), minimum: moneySchema }),
  z.object({ outcome: z.literal('ABOVE_MAXIMUM'), maximum: moneySchema }),
  z.object({
    outcome: z.literal('ROUTES'),
    amount: moneySchema,
    routes: z.array(
      z.object({
        provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
        kind: z.enum(MINIAPP_ROUTE_KINDS),
        name: z.string(),
        paysInChat: z.boolean(),
        /** The route's top-up gift, as a whole percent; 0 for none. */
        giftPercent: z.number().int(),
      }),
    ),
  }),
]);
export type MiniAppTopupQuoteResponse = z.infer<typeof miniAppTopupQuoteResponseSchema>;

export const miniAppTopupRequestSchema = z.object({
  amount: moneySchema,
  provider: z.enum(PAYMENT_GATEWAY_PROVIDERS),
});
export const miniAppTopupResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('CARD_TO_CARD'), instruction: miniAppCardInstructionSchema }),
  z.object({ kind: z.literal('GATEWAY'), attempt: miniAppGatewayAttemptSchema }),
]);

/**
 * R10 D4: a gift card typed into the wallet screen. The code is bounded before anything reads
 * it; the answer is one of three, and `REJECTED` is the same for an unknown, used, expired or
 * disabled code, a reached limit and a currency mismatch, so the endpoint is no oracle.
 */
export const miniAppGiftCardRequestSchema = z.object({
  code: z.string().min(1).max(GIFT_CARD_CODE_INPUT_MAX_LENGTH),
});
export const miniAppGiftCardResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('REDEEMED'), amount: moneySchema, balance: moneySchema }),
  z.object({ outcome: z.literal('REJECTED') }),
  z.object({ outcome: z.literal('RATE_LIMITED') }),
]);
export type MiniAppGiftCardResponse = z.infer<typeof miniAppGiftCardResponseSchema>;

// ---------------------------------------------------------------------------
// Referral, trial
// ---------------------------------------------------------------------------

export const miniAppReferralResponseSchema = z.discriminatedUnion('active', [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    commissionPercent: z.number(),
    inviteLink: z.string(),
    stats: z
      .object({
        referralCount: z.number().int(),
        referredPurchaseCount: z.number().int(),
        commissionReceivedTotal: moneySchema,
      })
      .nullable(),
  }),
]);
export type MiniAppReferralResponse = z.infer<typeof miniAppReferralResponseSchema>;

export const miniAppTrialResponseSchema = z.object({
  offers: z.array(
    z.object({
      panelId: idSchema,
      label: z.string(),
      trafficBytes: bytesSchema,
      durationHours: z.number().int(),
    }),
  ),
});
export type MiniAppTrialResponse = z.infer<typeof miniAppTrialResponseSchema>;

export const miniAppTrialClaimRequestSchema = z.object({ panelId: idSchema.nullable() });
export const miniAppTrialClaimResponseSchema = z.object({
  /** The trial service; its link arrives in the bot's chat, through the delivery lane. */
  serviceId: idSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Support and tickets
// ---------------------------------------------------------------------------

export const miniAppSupportResponseSchema = z.object({
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
  supportUrl: z.string().nullable(),
});

export const miniAppTicketCategoriesResponseSchema = z.object({
  items: z.array(z.object({ id: idSchema, title: z.string() })),
});

export const miniAppTicketSummarySchema = z.object({
  id: idSchema,
  code: z.string().nullable(),
  subject: z.string().nullable(),
  categoryTitle: z.string(),
  status: z.enum(TICKET_STATUSES),
  lastMessageAt: isoSchema,
});

export const miniAppTicketsResponseSchema = z.object({
  items: z.array(miniAppTicketSummarySchema),
});

export const miniAppTicketDetailSchema = miniAppTicketSummarySchema.extend({
  messages: z.array(
    z.object({
      /** Who wrote it: the customer, support, or (Phase 4 PR-4) the support assistant. */
      author: z.enum(['CUSTOMER', 'SUPPORT', 'AI']),
      text: z.string().nullable(),
      /** A Telegram file was attached; it is seen in the bot, not here. */
      hasAttachment: z.boolean(),
      createdAt: isoSchema,
    }),
  ),
});
export type MiniAppTicketDetail = z.infer<typeof miniAppTicketDetailSchema>;

/** A new ticket: a category and the first message. The subject is derived by the ticket service. */
export const miniAppTicketCreateRequestSchema = z.object({
  categoryId: idSchema,
  text: z.string().trim().min(1).max(TICKET_MESSAGE_MAX_LENGTH),
});
export const miniAppTicketReplyRequestSchema = z.object({
  text: z.string().trim().min(1).max(TICKET_MESSAGE_MAX_LENGTH),
});

// ---------------------------------------------------------------------------
// Connection guide
// ---------------------------------------------------------------------------

export const miniAppGuideResponseSchema = z.object({
  platforms: z.array(z.enum(CLIENT_APP_PLATFORMS)),
});

export const miniAppGuidePlatformResponseSchema = z.object({
  platform: z.enum(CLIENT_APP_PLATFORMS),
  apps: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      description: z.string().nullable(),
      officialUrl: z.string().nullable(),
      alternativeUrl: z.string().nullable(),
      helpUrl: z.string().nullable(),
      /** The operator's stored guide, verbatim; null when the operator wrote none. */
      guide: z.string().nullable(),
    }),
  ),
  /**
   * When the tenant configured no app this customer may see on this platform: the
   * platform's own guide text (`bot.tutorial.<platform>`, the tenant's template), exactly
   * what the bot shows then. Null when there are apps, and for `OTHER`, which has none.
   */
  fallbackGuide: z.string().nullable(),
});
export type MiniAppGuidePlatformResponse = z.infer<typeof miniAppGuidePlatformResponseSchema>;

// ---------------------------------------------------------------------------
// Notification centre (Round 11, B1)
// ---------------------------------------------------------------------------

/** How many messages one page of the centre holds. */
export const MINIAPP_NOTIFICATION_PAGE_SIZE = 20;
/**
 * How far back the centre reaches, in days, counted from the moment the message was
 * delivered. The list and the unread counter are bounded by it, so an old backlog is
 * neither paged through nor counted; the stored rows are kept as long as the lane keeps them.
 */
export const MINIAPP_NOTIFICATION_WINDOW_DAYS = 60;
/**
 * How long the lane keeps the WORDS of a delivered message, in days from delivery. A pruning
 * sweep then clears the stored text and the read mark (the row itself stays: its dedupe role
 * belongs to the lane). Longer than the window the centre shows, so a message never loses its
 * words while it can still be listed.
 */
export const MINIAPP_NOTIFICATION_TEXT_RETENTION_DAYS = 90;
/** The longest text one entry carries; a longer message is cut with a visible ellipsis. */
export const MINIAPP_NOTIFICATION_TEXT_MAX = 4096;

/**
 * One delivered bot message: the text exactly as it was rendered when it was sent (markup
 * removed), never re-rendered. There is no kind, subject id or value on the wire: the
 * centre shows what the customer was told, and nothing the message did not already say.
 */
export const miniAppNotificationSchema = z.object({
  id: idSchema,
  text: z.string(),
  /** When the bot delivered it. */
  createdAt: isoSchema,
  read: z.boolean(),
});
export type MiniAppNotification = z.infer<typeof miniAppNotificationSchema>;

export const miniAppNotificationsResponseSchema = z.object({
  items: z.array(miniAppNotificationSchema),
  nextCursor: z.string().nullable(),
  /** Unread within the window, whatever page was asked for. */
  unreadCount: z.number().int().nonnegative(),
});
export type MiniAppNotificationsResponse = z.infer<typeof miniAppNotificationsResponseSchema>;

/** What marking read answers: how many this call changed, and the count left unread. */
export const miniAppNotificationReadResponseSchema = z.object({
  marked: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});
export type MiniAppNotificationReadResponse = z.infer<typeof miniAppNotificationReadResponseSchema>;

/** The error body every refusal carries (the API's error filter shape). */
export const miniAppErrorSchema = z.object({
  error: z.object({
    kind: z.string(),
    code: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
