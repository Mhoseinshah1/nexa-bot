import { z } from 'zod';

/**
 * The customer-facing UX completion (docs/customer-ux-completion-audit.md): the
 * vocabularies its screens, captures and configuration are pinned by.
 *
 * Declared here rather than beside each feature because several are CHECK constraints
 * and every one is a customer-visible promise: a capture purpose is what stops a stale
 * prompt reading an unrelated message, a last-seen state is what stops "unsupported"
 * being shown as "never connected", and a display-list bound is what stops a product
 * form producing a message Telegram refuses to send.
 */

// --- Customer text captures --------------------------------------------------

/**
 * What a customer's next plain-text message is being read FOR.
 *
 * One table with a purpose column, following `admin_amount_captures`, rather than a
 * third, fourth and fifth capture table. The purpose is what a reader checks before it
 * consumes a message: a `TOPUP_AMOUNT` window never reads a search term, and a
 * `SERVICE_NOTE` window names the service it is for in `subject_id`. INCIDENT-FIN-001 is
 * a prompt that had outlived its question reading a navigation label as a setting.
 */
export const CUSTOMER_CAPTURE_PURPOSES = [
  'TOPUP_AMOUNT',
  'SERVICE_SEARCH',
  'SERVICE_NOTE',
  /**
   * WP19: the customer's reason for a refund request. `subject_id` names the SERVICE, like
   * `SERVICE_NOTE`, and the request is filed only when this window reads a valid reason.
   */
  'SERVICE_REFUND_REASON',
  /**
   * Package D: the volume of a custom service, in GB. `subject_id` names the PANEL the
   * customer chose, so the figure is read for that location and no other.
   */
  'CUSTOM_SERVICE_VOLUME',
  /**
   * Package D: the days of a custom service. `subject_id` names the panel and
   * `custom_volume_units` carries the volume the previous window read, so the draft is
   * made from what the customer typed and never from a callback.
   */
  'CUSTOM_SERVICE_DAYS',
  /**
   * Package F: the numeric Telegram id of the customer a service is to be handed to.
   * `subject_id` names the SERVICE, like `SERVICE_REFUND_REASON`; the window reads only
   * messages newer than the tap that opened it, and moves nothing — the typed id opens a
   * confirmation screen, and only its button transfers.
   */
  'SERVICE_TRANSFER_RECIPIENT',
  /**
   * WP-A7: the first message of a new ticket — text, or a photo or document with its caption.
   * `subject_id` names the CATEGORY the customer chose; the ticket is opened only when this
   * window reads a valid message.
   */
  'TICKET_NEW_MESSAGE',
  /** WP-A7: a reply to one of the customer's tickets. `subject_id` names the TICKET. */
  'TICKET_REPLY',
] as const;
export type CustomerCapturePurpose = (typeof CUSTOMER_CAPTURE_PURPOSES)[number];
export const customerCapturePurposeSchema = z.enum(CUSTOMER_CAPTURE_PURPOSES);

/**
 * Why a capture closed. `RECEIVED` is the one that read a message; `SUPERSEDED` is a
 * newer prompt taking over; `EXPIRED` is the deadline; `CANCELLED` is the customer
 * closing the list. Past `expires_at` a window answers NO_WINDOW and is closed EXPIRED
 * by whoever finds it — never "your window expired", which would tell a customer who
 * typed an unrelated sentence that something was waiting for it.
 */
export const CUSTOMER_CAPTURE_CLOSE_REASONS = [
  'RECEIVED',
  'SUPERSEDED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type CustomerCaptureCloseReason = (typeof CUSTOMER_CAPTURE_CLOSE_REASONS)[number];

/**
 * A top-up amount capture has TWO open phases: waiting for the figure, and holding the
 * figure while the customer picks a route. Once recorded the figure never changes under
 * its buttons; a different figure is a new capture.
 */
export const CUSTOMER_CAPTURE_STATES = ['AWAITING_TEXT', 'AMOUNT_RECORDED'] as const;
export type CustomerCaptureState = (typeof CUSTOMER_CAPTURE_STATES)[number];

/** Ten minutes, like the username and discount windows. */
export const CUSTOMER_TEXT_CAPTURE_TTL_MS = 10 * 60 * 1000;

/** A customer's own note on their service. Bounded in code points, control characters stripped. */
export const SERVICE_NOTE_MAX_LENGTH = 200;
/** A search term is a username prefix; usernames are short. */
export const SERVICE_SEARCH_MAX_LENGTH = 64;
/** A typed note of exactly this clears the note. Not a Persian string: punctuation. */
export const SERVICE_NOTE_CLEAR_TOKEN = '-';

// --- Service management --------------------------------------------------------

/**
 * The floor between two customer-requested usage reads of one service — a rail against
 * a tapped button dialling a panel in a loop, not a policy. One open `SYNC_USAGE`
 * operation per service is the primary dedupe; this covers the read that just landed.
 */
export const CUSTOMER_SYNC_MIN_INTERVAL_MS = 60 * 1000;

/** The services list page, and the bound a search answers with. */
export const SERVICES_LIST_PAGE_SIZE = 10;

/**
 * Last connection, as a provider can actually answer it.
 *
 * `AT` is a time the panel returned. `NEVER` is the panel saying the account has never
 * connected. `UNSUPPORTED` is the panel not saying: no such field on the record it
 * returned, or a value that is not a time. Marzban and RickPanel read `online_at` off the
 * user record, and only when the record actually carries the key (C1; Marzban v0.8.4's
 * source types it `Optional[datetime]`, written as naive UTC; neither is yet proven on a
 * real panel — `docs/real-panel-acceptance.md`). 3X-UI stays `UNSUPPORTED` until a real
 * v3.7.0 panel settles `lastOnline` (`docs/open-questions.md`, OQ-C1). The three are kept
 * apart because the customer-facing words differ — «متصل نشده» is a claim about the
 * account, and showing it for a panel that cannot say so is a lie. Nothing derives a
 * value from any other timestamp.
 */
export type ProviderLastSeen =
  | { readonly kind: 'AT'; readonly at: Date }
  | { readonly kind: 'NEVER' }
  | { readonly kind: 'UNSUPPORTED' };

/** What the service row stores of it; `UNSUPPORTED` is never stored (NULL is the absence). */
export const SERVICE_LAST_SEEN_STATES = ['AT', 'NEVER'] as const;
export type ServiceLastSeenState = (typeof SERVICE_LAST_SEEN_STATES)[number];

// --- Product display metadata --------------------------------------------------

/**
 * Marketing display data on a product: what the pre-invoice shows, and NOT how the
 * service is routed. The provisioner reads `panel_id` and nothing here; a location string
 * is a promise to a customer, never an instruction to a machine.
 *
 * Bounded because each list renders inside one Telegram message. Thirty lines of sixty
 * characters is above every catalogue in `docs/research/` and still leaves the
 * pre-invoice under the message cap without splitting in the common case.
 */
export const PRODUCT_DISPLAY_LIST_MAX_ITEMS = 30;
export const PRODUCT_DISPLAY_LOCATION_MAX_LENGTH = 60;
export const PRODUCT_DISPLAY_FEATURE_MAX_LENGTH = 200;
export const PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH = 60;

const displayLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/u.test(value), { message: 'one line, no line breaks' });

export const productDisplayLocationsSchema = z
  .array(displayLine(PRODUCT_DISPLAY_LOCATION_MAX_LENGTH))
  .max(PRODUCT_DISPLAY_LIST_MAX_ITEMS);
export const productDisplayFeaturesSchema = z
  .array(displayLine(PRODUCT_DISPLAY_FEATURE_MAX_LENGTH))
  .max(PRODUCT_DISPLAY_LIST_MAX_ITEMS);
export const productServiceLocationLabelSchema = displayLine(
  PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH,
).nullable();

export interface ProductDisplay {
  /** Ordered, as the operator wrote them. Rendered one per line; never parsed. */
  readonly displayLocations: readonly string[];
  /** Ordered, as the operator wrote them, bullets included if they typed them. */
  readonly displayFeatures: readonly string[];
  /** The one label the delivery card and the service card show as the service's location. */
  readonly serviceLocationLabel: string | null;
}

export const EMPTY_PRODUCT_DISPLAY: ProductDisplay = {
  displayLocations: [],
  displayFeatures: [],
  serviceLocationLabel: null,
};

// --- Payment purposes ----------------------------------------------------------

/**
 * What a payment route is being offered FOR. A route is configured per purpose because
 * an operator may take card-to-card for a top-up and not for a purchase, or the reverse;
 * folding the two into one switch is a route that is on for something it was never
 * meant for.
 */
export const PAYMENT_PURPOSES = ['SERVICE_PURCHASE', 'WALLET_TOPUP'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

// --- Connection guide ------------------------------------------------------------

/**
 * The platforms the connection guide has a guide of its own for: `bot.tutorial.<platform>`,
 * which a platform shows when no enabled client app is configured for it. WP-A10's
 * `CLIENT_APP_PLATFORMS` is this list plus `OTHER`, in the same order.
 */
export const CONNECTION_GUIDE_PLATFORMS = ['ANDROID', 'IOS', 'WINDOWS', 'MACOS', 'LINUX'] as const;
export type ConnectionGuidePlatform = (typeof CONNECTION_GUIDE_PLATFORMS)[number];
export const connectionGuidePlatformSchema = z.enum(CONNECTION_GUIDE_PLATFORMS);

// --- Support FAQ -----------------------------------------------------------------

export const SUPPORT_FAQ_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SupportFaqStatus = (typeof SUPPORT_FAQ_STATUSES)[number];
export const supportFaqStatusSchema = z.enum(SUPPORT_FAQ_STATUSES);

export const SUPPORT_FAQ_QUESTION_MAX_LENGTH = 300;
export const SUPPORT_FAQ_ANSWER_MAX_LENGTH = 2000;
export const SUPPORT_FAQ_SORT_MIN = 0;
export const SUPPORT_FAQ_SORT_MAX = 100_000;
/** Enough for any FAQ; the screen splits at item boundaries past one message anyway. */
export const SUPPORT_FAQ_MAX_ENTRIES = 100;

export const supportFaqInputSchema = z.object({
  question: z.string().trim().min(1).max(SUPPORT_FAQ_QUESTION_MAX_LENGTH),
  answer: z.string().trim().min(1).max(SUPPORT_FAQ_ANSWER_MAX_LENGTH),
  sortOrder: z.number().int().min(SUPPORT_FAQ_SORT_MIN).max(SUPPORT_FAQ_SORT_MAX),
});
export type SupportFaqInput = z.infer<typeof supportFaqInputSchema>;

/**
 * The position marker before an FAQ question: keycap digits for one to ten, then a plain
 * figure. Data, not copy — the same marker whatever language the question is in.
 */
export function faqNumberMarker(position: number): string {
  const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
  if (!Number.isInteger(position) || position < 1) {
    throw new Error('an FAQ position starts at 1');
  }
  return position <= KEYCAPS.length ? (KEYCAPS[position - 1] as string) : `${position}.`;
}

// --- Tenant media ----------------------------------------------------------------

/**
 * The media slots this release stores: the referral banner, and (Phase 2 item 4) the
 * background the subscription QR is drawn on (`delivery-qr.ts`). A row per (tenant,
 * purpose) holding the bytes, so nothing customer-facing ever carries a filesystem path
 * and a bot-scoped Telegram `file_id` is never the source of truth. Grows a member when a
 * screen needs one — never a generic CMS.
 */
export const TENANT_MEDIA_PURPOSES = ['REFERRAL_BANNER', 'QR_BACKGROUND'] as const;
export type TenantMediaPurpose = (typeof TENANT_MEDIA_PURPOSES)[number];
export const tenantMediaPurposeSchema = z.enum(TENANT_MEDIA_PURPOSES);

export const TENANT_MEDIA_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type TenantMediaMimeType = (typeof TENANT_MEDIA_MIME_TYPES)[number];
export const tenantMediaMimeTypeSchema = z.enum(TENANT_MEDIA_MIME_TYPES);

/** One mebibyte. Telegram accepts far more; a banner needs far less. */
export const TENANT_MEDIA_MAX_BYTES = 1024 * 1024;

/**
 * The types each slot accepts, a subset of `TENANT_MEDIA_MIME_TYPES`. The QR background is
 * PNG only: it is DECODED and composed with the code on the server, and this release ships
 * a PNG decoder and no JPEG one (no new dependency in a process that holds bot tokens).
 */
export const TENANT_MEDIA_PURPOSE_MIME_TYPES: Readonly<
  Record<TenantMediaPurpose, readonly TenantMediaMimeType[]>
> = {
  REFERRAL_BANNER: ['image/png', 'image/jpeg'],
  QR_BACKGROUND: ['image/png'],
};

// --- Referral signup gift --------------------------------------------------------

export const REFERRAL_SIGNUP_GIFT_SHARE_MIN = 0;
export const REFERRAL_SIGNUP_GIFT_SHARE_MAX = 100;
export const referralSignupGiftShareSchema = z
  .number()
  .int()
  .min(REFERRAL_SIGNUP_GIFT_SHARE_MIN)
  .max(REFERRAL_SIGNUP_GIFT_SHARE_MAX);

/** Which side of a referral a gift share is paid to. Both are `REFERRAL_SIGNUP_GIFT` entries. */
export const REFERRAL_SIGNUP_GIFT_SIDES = ['REFERRER', 'REFEREE'] as const;
export type ReferralSignupGiftSide = (typeof REFERRAL_SIGNUP_GIFT_SIDES)[number];

/**
 * A share of the gift, in minor units, rounded down. The referee's share is the
 * COMPLEMENT of the referrer's so the two always sum to the total whatever the rounding.
 */
export function referralSignupGiftShares(
  totalMinor: bigint,
  referrerPercent: number,
): { readonly referrer: bigint; readonly referee: bigint } {
  if (totalMinor < 0n) throw new Error('a gift total cannot be negative');
  if (
    !Number.isInteger(referrerPercent) ||
    referrerPercent < REFERRAL_SIGNUP_GIFT_SHARE_MIN ||
    referrerPercent > REFERRAL_SIGNUP_GIFT_SHARE_MAX
  ) {
    throw new Error('a gift share is a whole percent from 0 to 100');
  }
  const referrer = (totalMinor * BigInt(referrerPercent)) / 100n;
  return { referrer, referee: totalMinor - referrer };
}

/** The ledger reference of one share: one per (referral, side), by the unique index. */
export function referralSignupGiftReference(
  referralId: string,
  side: ReferralSignupGiftSide,
): string {
  return `${referralId}:signup-gift:${side}`;
}
