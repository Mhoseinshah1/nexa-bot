// The ports the bot runtime is built from.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type {
  ActorContext,
  BotInstanceId,
  Clock,
  CorrelationId,
  CustomerNotificationKind,
  Money,
  OrderId,
  PaymentPurpose,
  PermissionKey,
  ProductId,
  ServiceReminderThresholds,
  SettingKey,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { AntiSpamService } from '../../../modules/commerce/customers/application/anti-spam.service.js';
import type { ChannelMembershipService } from '../../../modules/commerce/customers/application/channel-membership.service.js';
import type { StartCaptchaService } from '../../../modules/commerce/customers/application/start-captcha.service.js';
import type { TermsAcceptanceService } from '../../../modules/control/terms/application/terms-acceptance.service.js';
import type { CustomerService } from '../../../modules/commerce/customers/application/customer.service.js';
import type { PaymentDestinationRenderer } from '../../../modules/commerce/payments/infrastructure/destination-renderer.js';
import type { CardSwitchService } from '../../../modules/commerce/payments/application/card-switch.service.js';
import type { ReceiptService } from '../../../modules/commerce/payments/application/receipt.service.js';
import type { ReceiptCreditCaptureService } from '../../../modules/commerce/payments/application/receipt-credit-capture.service.js';
import type { ServiceRefundDecisionService } from '../../../modules/commerce/payments/application/service-refund-decision.service.js';
import type { ServiceRefundRequestService } from '../../../modules/commerce/payments/application/service-refund-request.service.js';
import type {
  ReceiptBlockCaptureService,
  ReceiptRejectCaptureService,
} from '../../../modules/commerce/payments/application/receipt-reason-policies.js';
import type { CustomerBlockCaptureService } from '../../../modules/commerce/customers/application/customer-block-capture.js';
import type { CustomerMessenger } from '../../../modules/commerce/messaging/application/ports.js';
import type { ProductService } from '../../../modules/commerce/catalog/application/product.service.js';
import type { ProductCategoryService } from '../../../modules/commerce/catalog/application/product-category.service.js';
import type { CommercialActionService } from '../../../modules/commerce/commercial/application/commercial-action.service.js';
import type { CheckoutService } from '../../../modules/commerce/checkout/application/checkout.service.js';
import type { GiftCardRedemptionService } from '../../../modules/commerce/gift-cards/application/gift-card-redemption.service.js';
import type { LocationChangeService } from '../../../modules/commerce/locations/application/location-change.service.js';
import type { TrialService } from '../../../modules/commerce/trials/application/trial.service.js';
import type { OrderService } from '../../../modules/commerce/orders/application/order.service.js';
import type { OrderRecord } from '../../../modules/commerce/orders/application/ports.js';
import type { PaymentService } from '../../../modules/commerce/payments/application/payment.service.js';
import type { GatewayPaymentService } from '../../../modules/commerce/payments/application/gateway-payment.service.js';
import type { GatewayReceiptCaptureService } from '../../../modules/commerce/payments/application/gateway-receipt-capture.service.js';
import type { WalletService } from '../../../modules/commerce/wallet/application/wallet.service.js';
import type { ProvisioningService } from '../../../modules/commerce/provisioning/application/provisioning.service.js';
import type { DeliveryService } from '../../../modules/commerce/provisioning/application/delivery.service.js';
import type { CustomerCaptureService } from '../../../modules/commerce/customers/application/customer-capture.service.js';
import type { CustomerCaptureRecord } from '../../../modules/commerce/customers/application/customer-capture-ports.js';
import type { SubscriptionFileService } from '../../../modules/commerce/provisioning/application/subscription-file.service.js';
import type { ServiceRefreshService } from '../../../modules/commerce/provisioning/application/service-refresh.service.js';
import type { ServiceTransferService } from '../../../modules/commerce/provisioning/application/service-transfer.service.js';
import type { ServiceAutoRenewService } from '../../../modules/commerce/provisioning/application/service-auto-renew.service.js';
import type { CustomerCountersReader } from '../../../modules/commerce/customers/application/customer-counters-ports.js';
import type {
  TopupRoute,
  WalletTopupFlowService,
} from '../../../modules/commerce/payments/application/wallet-topup-flow.service.js';
import type { CustomerScreenComposer } from '../../../modules/commerce/messaging/application/customer-screens.js';
import type { ResellerService } from '../../../modules/commerce/resellers/application/reseller.service.js';
import type { ServiceAdminService } from '../../../modules/commerce/provisioning/application/service-admin.service.js';
import type { InvoiceScreensPort, MessageStatePort } from '../wizard-state.js';
import type { PanelService } from '../../../modules/platform/panels/application/panel.service.js';
import type { ReferralProgram } from '../../../modules/commerce/referrals/application/referral-program.js';
import type { TicketService } from '../../../modules/commerce/tickets/application/ticket.service.js';
import type { TicketCategoryService } from '../../../modules/commerce/tickets/application/ticket-category.service.js';
import type { TicketScreenComposer } from '../../../modules/commerce/tickets/application/ticket-screens.js';
import type { ClientAppCatalog } from '../../../modules/control/client-apps/application/client-app-catalog.js';
import type { ClientAppVideoService } from '../../../modules/control/client-apps/application/client-app-video.service.js';
import type { CustomMenuTap } from '../../../modules/control/bot-menu-builder/application/custom-menu-button-runtime.js';
import type { MainMenuRoutes } from './intent-of.js';

/** What the runtime needs of the custom-service flow (Package D). */
export interface CustomServiceSurface {
  offeredLocations(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<readonly { readonly panelId: string; readonly label: string }[]>;
  begin(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly customerId: UserId;
      readonly panelId: string;
    },
  ): Promise<
    | {
        readonly outcome: 'ASK_VOLUME';
        readonly location: { readonly label: string };
        readonly range: { readonly min: bigint; readonly max: bigint };
      }
    | { readonly outcome: 'UNAVAILABLE' }
  >;
  recordVolume(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly capture: CustomerCaptureRecord;
      readonly text: string;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<
    | {
        readonly outcome: 'INVALID';
        readonly range: { readonly min: bigint; readonly max: bigint } | null;
      }
    | { readonly outcome: 'UNPRICED' }
    | { readonly outcome: 'UNAVAILABLE' }
    | {
        readonly outcome: 'ASK_DAYS';
        readonly volumeBytes: bigint;
        readonly range: { readonly min: bigint; readonly max: bigint };
      }
  >;
  recordDays(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly capture: CustomerCaptureRecord; readonly text: string },
  ): Promise<
    | {
        readonly outcome: 'INVALID';
        readonly range: { readonly min: bigint; readonly max: bigint } | null;
      }
    | { readonly outcome: 'UNPRICED' }
    | { readonly outcome: 'UNAVAILABLE' }
    | { readonly outcome: 'DRAFTED'; readonly order: OrderRecord }
  >;
  termsFor(
    scope: TenantContext,
    orderId: string,
  ): Promise<{
    readonly locationLabel: string;
    readonly trafficBytes: bigint;
    readonly pricePerGb: Money;
    readonly volumePrice: Money;
    readonly durationDays: number;
    readonly pricePerDay: Money;
    readonly timePrice: Money;
  } | null>;
}

export interface BotRuntimeDeps {
  /**
   * Where a BEST-EFFORT step that failed is reported without costing the customer what it
   * was helping: the live read a service card makes on open (pre-support A2), and the
   * receipt's invoice finalisation (A10), which must never cost the customer the one new
   * message their filed receipt is owed. Optional for the fixtures that build a runtime
   * without it; the composition root always supplies the process logger.
   */
  readonly logger?: {
    readonly error: (context: Record<string, unknown>, message: string) => void;
  };
  readonly customers: CustomerService;
  readonly messenger: CustomerMessenger;
  readonly products: ProductService;
  readonly commercial: CommercialActionService;
  /**
   * WP-A6 — a customer's FREE location change. Optional for the fixtures that build a
   * runtime without it: then a free target's confirmation answers the unavailable
   * sentence rather than being requested.
   */
  readonly locationChanges?: Pick<LocationChangeService, 'requestFree'> &
    Partial<Pick<LocationChangeService, 'freeRequestRecorded'>>;
  /**
   * The free trial (WP6-A). Optional only so the customer-side unit fixtures need not
   * build it; the composition root always supplies it, and without it every trial tap is
   * answered unavailable. Only the claim is asked: since F5 no purchase screen offers a
   * trial, so nothing here reads availability ahead of a tap.
   */
  readonly trials?: Pick<TrialService, 'claim'>;
  /**
   * Package D — the custom-service flow. Optional for the fixtures that build a runtime
   * without it: then no button is drawn and a stale tap answers the unavailable sentence.
   */
  readonly customService?: CustomServiceSurface;
  /**
   * Package E — a panel's ready-made connection files. Optional for the fixtures that
   * build a runtime without it: then no button is drawn and a stale tap is answered
   * as an unknown service.
   */
  readonly subscriptionFiles?: Pick<SubscriptionFileService, 'offered' | 'send'>;
  /**
   * R3 item 7 — «♻️ بروزرسانی اطلاعات» as one bounded panel read that redraws the SAME
   * card. Optional for the fixtures that build a runtime without it: then the tap queues
   * the `SYNC_USAGE` operation it always did.
   */
  readonly serviceRefresh?: Pick<ServiceRefreshService, 'refresh' | 'liveCheck'>;
  /**
   * WP-A10 — the tenant's client apps, read for this customer's services. Optional for the
   * fixtures that build a runtime without it: then the guide is the five
   * `bot.tutorial.<platform>` texts it was before, and a stale `ca:` answers not-found.
   */
  readonly clientApps?: Pick<ClientAppCatalog, 'platformsFor' | 'appsFor' | 'appFor'>;
  /**
   * Spec §7: the tutorial video — the management panel's «تنظیم ویدیو» wizard, and the
   * video an app's screen sends first. Absent: no section, and app screens as before.
   */
  readonly clientAppVideos?: Pick<
    ClientAppVideoService,
    | 'listForAdmin'
    | 'detailForAdmin'
    | 'beginCapture'
    | 'cancelCapture'
    | 'receiveVideo'
    | 'remove'
    | 'videoFor'
  >;
  /** The referral program (WP9): its terms and the invite, for the referral screen. */
  readonly referrals?: Pick<ReferralProgram, 'terms' | 'invite'>;
  readonly orders: OrderService;
  readonly payments: PaymentService;
  /**
   * R10 B1: the checkout both customer surfaces share — the confirm lane, the routes an order
   * offers, the wallet pre-check and which gateway a tap may start. The SAME instance the mini
   * app is handed; the bot keeps only how each answer is drawn.
   */
  readonly checkout: CheckoutService;
  /**
   * Composes the destination block for a manual-transfer instruction.
   *
   * Injected rather than imported, for the reason `MainMenuRoutes` is: the four line
   * templates are catalogue text, `check-boundaries.sh` refuses an `@nexa/i18n` import
   * in a surface, and resolving a tenant override is the application layer's job. What
   * this surface holds is a function from a frozen snapshot to a string.
   */
  readonly destinations: PaymentDestinationRenderer;
  /**
   * R4 A1: «🔄 تغییر شماره کارت» — whether the card-to-card invoice draws it, and the press.
   * Absent (a test double, an older wiring): the button is never drawn.
   */
  readonly cardSwitch?: Pick<CardSwitchService, 'offer' | 'switchCard'>;
  /**
   * Files the receipt a customer sends, and refuses the file nobody asked for.
   *
   * A separate service from `payments` on purpose: it holds the payment READ alone, so
   * the path a customer's photo travels cannot confirm, reject or settle anything. The
   * addendum's own words — *"settlement still requires the existing authorized operator
   * confirmation"* — are a dependency here rather than only a permission.
   */
  readonly receipts: Pick<
    ReceiptService,
    | 'submit'
    | 'reviewQueue'
    | 'reviewItem'
    | 'dispositionOf'
    | 'finalRecord'
    | 'filedForCustomer'
    | 'trackingCodeForCustomer'
  >;
  /**
   * The reviewer's amount capture for the credit-to-wallet disposition (Payment File 02
   * §12). Optional only so the customer-side unit fixtures need not build it; without it
   * the credit button is not drawn and its callbacks answer as any unknown admin tap. It
   * reaches money only through `ReceiptDispositionService.creditToWallet`.
   */
  readonly receiptCredits?: Pick<
    ReceiptCreditCaptureService,
    'open' | 'submitAmount' | 'confirm' | 'cancel'
  >;
  /**
   * WP19: a customer's service refund request — whether it is offered, and the filing.
   * Without it no service shows the button and a crafted `fa:`/`fb:` answers unavailable.
   */
  readonly serviceRefunds?: Pick<
    ServiceRefundRequestService,
    'customerOffer' | 'offeredFor' | 'file'
  >;
  /**
   * Package F: a customer's service transfer. Without it no service shows the button, and a
   * crafted `ta:`/`tc:` answers that the service cannot be transferred.
   */
  readonly serviceTransfers?: Pick<
    ServiceTransferService,
    'offered' | 'begin' | 'preview' | 'transfer'
  >;
  /**
   * Round 10, D1: «تمدید خودکار». Without it no service shows the switch, and a crafted
   * `ar:`/`ay:`/`an:` answers that automatic renewal is not available.
   */
  readonly autoRenew?: Pick<ServiceAutoRenewService, 'switchFor' | 'stateFor' | 'set'>;
  /**
   * WP19: an administrator's decision prompts behind the review card. Without it the card's
   * approve and reject answer as any unknown admin tap.
   */
  readonly serviceRefundDecisions?: Pick<
    ServiceRefundDecisionService,
    'openApprove' | 'openReject' | 'submitText' | 'confirmApprove' | 'cancel'
  >;
  /**
   * Anti-spam (WP20, brief §3.4–§3.5). Optional so the unit fixtures that build a runtime
   * need not bring a counter; absent, nobody is counted and nobody is blocked for it.
   */
  readonly antiSpam?: Pick<AntiSpamService, 'observe'>;
  /**
   * Mandatory channel membership (Package B). Optional so the unit fixtures that build a
   * runtime need not model Telegram; absent, no channel is enforced — which is also what a
   * tenant with no REQUIRED channel sees.
   */
  readonly membership?: Pick<ChannelMembershipService, 'missingRequired'>;
  /**
   * R10 D5 (a): the optional `/start` captcha for NEW customers, the first check of the gate
   * chain. Optional for the reason `membership` is; absent, nobody is ever asked — which is
   * also what every customer sees while `start_captcha` is off.
   */
  readonly captcha?: Pick<StartCaptchaService, 'present' | 'answer'>;
  /**
   * The terms and rules (program §6). Optional for the reason `membership` is; absent, no
   * customer is asked to accept anything — which is also what a tenant with enforcement off,
   * or with nothing published, sees.
   */
  readonly terms?: Pick<TermsAcceptanceService, 'requirement' | 'accept'>;
  /**
   * Block User from the receipt message (WP10 follow-up §4). Optional for the reason
   * `receiptCredits` is; without it the block button is not drawn. It blocks only through
   * `CustomerService` and holds nothing that decides a payment.
   */
  readonly receiptBlocks?: Pick<
    ReceiptBlockCaptureService,
    'ask' | 'open' | 'submitReason' | 'confirm' | 'cancel'
  >;
  /**
   * The rejection's mandatory reason (File 01 §7). The reject button opens its capture; there
   * is no one-tap rejection. Without it the reject button answers as any unknown admin tap.
   */
  readonly receiptRejects?: Pick<
    ReceiptRejectCaptureService,
    'open' | 'submitReason' | 'confirm' | 'cancel'
  >;
  /**
   * The customers section's block (WP10G, closing OQ-WP10F-03): the same capture mechanics as
   * the receipt's Block User, naming a customer. Optional for the reason `receiptBlocks` is;
   * without it the section's block button answers as any unknown admin tap, so no path can
   * block without a reason.
   */
  readonly customerBlocks?: Pick<
    CustomerBlockCaptureService,
    'ask' | 'open' | 'submitReason' | 'confirm' | 'cancel'
  >;
  readonly wallet: WalletService;
  readonly services: ProvisioningService;
  /**
   * The operator's READ of a service, for the admin panel's section.
   *
   * A `Pick` rather than the class, so this surface can list, read one with its action
   * verdicts, and read its history — and cannot reach anything that acts. What acts is
   * `services` and `delivery`, and both charge their own permissions.
   */
  readonly serviceAdmin: Pick<ServiceAdminService, 'list' | 'detail' | 'operations'>;
  /**
   * The operator's panel operations, for the panels section.
   *
   * A `Pick` of FOUR, and what is absent is the point: `setCredentials` is not here, so
   * no code path in this surface can write a credential even by mistake. Credential
   * creation and rotation are the Web Admin's, behind `panels.credentials.rotate`, and
   * the owner's instruction for this phase says so in as many words.
   *
   * `create` is absent for the same reason — a panel needs credentials, so creating one
   * here would either be a panel that cannot be operated or a credential typed into a
   * chat.
   */
  readonly panelAdmin: Pick<
    PanelService,
    'list' | 'get' | 'testConnection' | 'setStatus' | 'update'
  >;
  /**
   * The categories section's one service — the SAME instance the Web Admin's
   * `/product-categories` controller holds, so there is one set of rules for both
   * surfaces. Optional only so the customer-side unit fixtures need not build it; the
   * composition root always supplies it, and without it the section is not drawn.
   */
  readonly productCategories?: Pick<
    ProductCategoryService,
    | 'list'
    | 'create'
    | 'update'
    | 'activate'
    | 'deactivate'
    | 'show'
    | 'hide'
    | 'reorder'
    | 'reassignProduct'
    | 'remove'
  >;
  /**
   * The clock, for the ONE thing this surface decides about time.
   *
   * `readHealth` needs "now" to say whether a probe is stale, and `CLAUDE.md` is
   * explicit that every timestamp comes from the `Clock` port — a `new Date()` here
   * would be the one unfakeable value in a runtime whose whole test suite depends on
   * being able to fix the clock. Nothing else on this surface reads it: every other
   * timestamp in a reply is a stored value rendered by the template layer.
   */
  readonly clock: Clock;
  readonly delivery: DeliveryService;
  /**
   * Puts a rate-limited FACT on the customer notification lane.
   *
   * A narrow function and not the notifier itself, because `CustomerNotifier.notify`
   * takes a transaction and a SURFACE must not open one — `CLAUDE.md`: "Surfaces
   * call application services and never touch the database." The container owns
   * the unit of work and the clock; this hands over the two values only the turn
   * knows.
   *
   * Returns nothing. The turn's own outcome is already `RATE_LIMITED` and stays
   * that way: the operational log records what happened to the REPLY, and
   * reporting a successful enqueue as a successful send is the kind of
   * cheerfulness this codebase removes.
   */
  /**
   * The persistent main menu's label-to-command map.
   *
   * Supplied by the composition root, which is the only place allowed to read the
   * catalogue on this path — see `MainMenuRoutes`. An empty map is a bot with no
   * keyboard and unchanged slash commands, which is what every test that does not care
   * about the menu gets.
   */
  /**
   * The reminder configuration, read and written through the ONE application path.
   *
   * A narrow port rather than `SettingsService` and `FeatureFlagsService`, for the
   * reason every other port on this interface gives: handing a Telegram surface the
   * settings service would hand it every key in the registry, including the operations
   * chat id and the sales currency. This one can read the eight reminder values and
   * write the five numbers, and nothing else.
   *
   * Neither method is authorized by HAVING the port. `read` charges `settings.view` and
   * `settings.view`, `write` charges `settings.edit`, and both go through the same
   * guard, the same audit row and the same combination validation the Web Admin does —
   * which is the "one application service and one authorization/audit path" the surface
   * is required to share with it.
   */
  readonly reminderConfig: {
    read: (scope: TenantContext, actor: ActorContext) => Promise<ServiceReminderThresholds>;
    /**
     * Writes one threshold, or reports why the combination was refused.
     *
     * A refusal is a VALUE and not an exception, because it is an ordinary answer an
     * operator caused and must read: `ReminderThresholdsGuard` returns Persian prose
     * naming which of the five is wrong. An exception here would be caught by the
     * generic handler and rendered as "something went wrong", which is Mirza's
     * `⭕️ ورودی نا معتبر` with extra steps.
     */
    write: (
      scope: TenantContext,
      actor: ActorContext,
      key: SettingKey,
      value: number,
      idempotencyKey: string,
    ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  };
  readonly mainMenu: MainMenuRoutes;
  /**
   * R5C-1 item 4: whether the renewal menu also lists the extra-time packages (the feature flag
   * `addon_time_in_renew_menu`, default ON). A DISPLAY choice only: the time packages stay
   * purchasable from their own «⏳ خرید زمان اضافه» button either way, and every purchase
   * re-decides its own eligibility. Absent means on, which is how the menu always was.
   */
  readonly renewMenuShowsTime?: (scope: TenantContext) => Promise<boolean>;
  /**
   * R8-C3: the tenant's `bot.service_card_layout`, the order, rows and switches of the
   * service screen's buttons. Optional so a stand-in without it draws the screen as always.
   */
  readonly serviceCardLayout?: (scope: TenantContext) => Promise<unknown>;
  /**
   * R1: this tenant's CURRENT main-menu labels and their commands (`MainMenuLayout`), the
   * same object the messenger draws the keyboard from. Matched over `mainMenu`'s shared
   * defaults, so a renamed button routes under its new name and a keyboard drawn before
   * the rename still routes under the old one. Optional so a stand-in without it routes
   * exactly as before.
   */
  readonly menuRoutes?: { routesFor(scope: TenantContext): Promise<ReadonlyMap<string, string>> };
  readonly queueRateLimitedFact: (
    scope: TenantContext,
    customerId: UserId,
    kind: CustomerNotificationKind,
    subjectId: string,
    /**
     * Telegram's own `retry_after`, when it supplied one.
     *
     * Passed through rather than dropped, because it is the one thing this path
     * knows and the lane does not. Without it the row is due immediately and the
     * next sweep walks into the same refusal — a request Telegram already
     * declined, and a longer throttle for every other message to that chat.
     */
    retryAfterMs: number | undefined,
  ) => Promise<void>;
  /**
   * The plan a service was SOLD as, from the order's frozen snapshot.
   *
   * A narrow port rather than `OrderService`, for the reason the provisioner's
   * `PurchaseSnapshotReader` gives one: handing this surface the order service would
   * also hand a customer-facing runtime the ability to confirm and cancel orders.
   *
   * From the ORDER and never from the product. `nexa_orders_snapshot_guard` froze the
   * title at confirmation, so it is the only copy that still says what the customer
   * agreed to — a product renamed since would otherwise rewrite what somebody was
   * told they bought, which is the legacy defect where renaming a product rewrote
   * past reports, applied to something the customer can read back.
   */
  readonly purchaseTitle: (scope: TenantContext, orderId: OrderId) => Promise<string | null>;
  /**
   * The management panel's seam (Phase 5T).
   *
   * A narrow port rather than the service, so this surface can resolve a binding, read
   * who holds one, and ask for a binding or a role change — and cannot reach anything
   * else about identity. Every method behind it charges its own permission through the
   * same guard the Web Admin uses; nothing here is authorized by having the port.
   */
  readonly telegramAdmins?: TelegramAdminPort;
  /*
   * The customer UX completion (docs/customer-ux-completion-audit.md). Each is an
   * application service; the surface renders nothing itself.
   */
  readonly captures: CustomerCaptureService;
  readonly topup: WalletTopupFlowService;
  /**
   * The external-gateway lane's customer reads (WP11A): an attempt that is this
   * customer's own, and the check tap that brings its next inquiry forward. No provider
   * call happens through either.
   */
  readonly gateway: Pick<GatewayPaymentService, 'attemptFor' | 'requestCheck' | 'cardFactsFor'>;
  /**
   * TonPays Telegram (§8.2, §8.3): the customer's card-change and receipt commands. Absent,
   * the card screen draws neither button and a photo goes to the manual flow as before.
   */
  readonly gatewayReceipts?: Pick<
    GatewayReceiptCaptureService,
    | 'openReceiptCapture'
    | 'requestCardChange'
    | 'receivePhoto'
    | 'openCaptureFor'
    | 'requestCancel'
    | 'cancelOffered'
    | 'refundCardOffered'
    | 'requestRefund'
  >;
  readonly screens: CustomerScreenComposer;
  readonly counters: CustomerCountersReader;
  /** The payment routes per purpose; the external chooser is drawn only from a real route. */
  readonly routes: PaymentRouteSource;
  readonly support: SupportScreenSource;
  readonly productDisplay: ProductDisplaySource;
  /**
   * Pre-support A6: the operator's label for a panel's INITIAL location — where the card
   * says a never-moved service is. Absent, the card falls back to the product's label.
   */
  readonly panelLocations?: PanelLocationLabelSource;
  readonly resellers?: Pick<ResellerService, 'standing'>;
  readonly referralGifts?: ReferralGiftSource;
  /** R10 D4: gift card redemption. Absent, the wallet draws no gift-card button. */
  readonly giftCards?: Pick<GiftCardRedemptionService, 'isEnabled' | 'redeem'>;
  readonly media?: TenantMediaSource;
  /**
   * R10 D2: the answer to a tap on an owner-defined main-menu button, decided from state for
   * the sending bot. Absent, every such tap is answered as unavailable.
   */
  readonly customMenuButtons?: {
    forTap(scope: TenantContext, id: string, botInstanceId: string): Promise<CustomMenuTap>;
  };
  /** WP-A7: the customer's support tickets. Absent, the desk is not offered. */
  readonly tickets?: TicketDeskPort;
  /**
   * R2 (items 3–5): which Telegram message shows a wizard or a receipt review, and whether a
   * tap still belongs to the screen it shows. Absent, every reply is a new message, as before.
   */
  readonly messageState?: Pick<
    MessageStatePort,
    | 'claim'
    | 'claimLatest'
    | 'land'
    | 'release'
    | 'move'
    | 'register'
    | 'moveAll'
    | 'moveBack'
    | 'recordReview'
    | 'findReview'
    | 'reviewTapIsRetired'
    | 'finaliseReviews'
    | 'unfinaliseReview'
  >;
  /** R2 (item 4): the invoice screens the gateway worker edits too. */
  readonly invoiceScreens?: InvoiceScreensPort;
  /**
   * R11 A11 (Codex, #354): how long the order's payment message must be left alone before this
   * turn edits it into an ended screen — the lane's own settle window
   * (`orderScreenSettleMs` of the messenger's request timeout), so a cancellation never lands
   * under another writer's edit still in flight. Absent (a stand-in): the margin alone.
   */
  readonly orderScreenSettleMs?: number;
  /**
   * R2: the order a customer's open typed-answer window names — a username or a discount
   * code — or null. Read AFTER a typed answer was refused (the refusal rolled back its own
   * transaction and left the window open), so the refusal is shown on THAT order's wizard
   * rather than on the chat's most recently touched one, which may be another order's.
   * Presentation only: it decides which message is edited, never anything about the order.
   */
  readonly answerWindowOrder?: (
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    window: 'USERNAME' | 'DISCOUNT',
  ) => Promise<string | null>;
}

/**
 * What the bot needs of the ticket module (WP-A7): the customer's own writes and reads, the
 * active categories, the conversation composer, and one question about windows.
 */
export interface TicketDeskPort {
  readonly service: Pick<
    TicketService,
    'openByCustomer' | 'replyByCustomer' | 'closeByCustomer' | 'customerTickets' | 'customerTicket'
  >;
  readonly categories: Pick<TicketCategoryService, 'activeForCustomer'>;
  readonly screens: Pick<TicketScreenComposer, 'statusLabel' | 'conversation'>;
  /**
   * The customer's open, unexpired receipt window's `openedAt`, or null — read UNDER the
   * receipt window's own lock, in the transaction the ticket window is read in. A file
   * answers whichever of the two prompts the customer saw last; asking this inside the
   * read, after the ticket window's lock, is what makes that choice and the consumption
   * one decision (Codex review of #96: two unlocked reads before the transaction let a
   * receipt window open between the choice and the read).
   */
  receiptWindowOpenedAt(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    customerId: UserId,
    tx: CaptureReadTransaction,
  ): Promise<Date | null>;
}

/** The transaction a capture read hands its `yieldTo` reader. */
export type CaptureReadTransaction = Parameters<
  NonNullable<Parameters<CustomerCaptureService['readText']>[2]['yieldTo']>
>[0];

export interface PaymentRouteSource {
  routesFor(
    scope: TenantContext,
    customerId: UserId,
    purpose: PaymentPurpose,
    amount: Money | null,
  ): Promise<readonly TopupRoute[]>;
}

/** The FAQ/support screen, already rendered into message parts (application code renders). */
export interface SupportScreenSource {
  partsFor(
    scope: TenantContext,
  ): Promise<{ readonly parts: readonly string[]; readonly supportUrl: string | null }>;
}

export interface ProductDisplaySource {
  displayFor(
    scope: TenantContext,
    /** Null for a custom service (Package D), which answers null. */
    productId: ProductId | null,
  ): Promise<{
    readonly displayLocations: readonly string[];
    readonly displayFeatures: readonly string[];
    readonly serviceLocationLabel: string | null;
    /** B1: the product's customer-facing description, shown on the pre-invoice. */
    readonly description?: string | null;
  } | null>;
}

/** Pre-support A6: a panel's initial-location label, operator display text only. */
export interface PanelLocationLabelSource {
  initialLabelFor(scope: TenantContext, panelId: string): Promise<string | null>;
}

export interface ReferralGiftSource {
  terms(scope: TenantContext): Promise<{
    readonly active: boolean;
    readonly total: Money;
    readonly referrerPercent: number;
    readonly referredPercent: number;
    /** R10 D5 (b): the guard holds the gift for the referee's first paid purchase. */
    readonly requiresPurchase?: boolean;
  }>;
  stats(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<{
    readonly referralCount: number;
    readonly referredPurchaseCount: number;
    readonly referredPurchaseTotal: Money;
    readonly commissionReceivedTotal: Money;
  }>;
  claim(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: { readonly idempotencyKey: string },
  ): Promise<{
    readonly credited: Money;
    readonly claimedCount: number;
    /** R10 D5 (b): referrer shares the daily cap left for a later day. */
    readonly cappedCount?: number;
  }>;
  /**
   * R1: what this customer could be paid now — the claim button is drawn only when there
   * is something. Optional so a stand-in without it keeps the older rule (drawn while the
   * gift is on); the shipped service always has it.
   */
  claimableFor?(scope: TenantContext, customerId: UserId): Promise<readonly unknown[]>;
}

export interface TenantMediaSource {
  bytesFor(
    scope: TenantContext,
    purpose: 'REFERRAL_BANNER',
  ): Promise<{ readonly bytes: Uint8Array; readonly mimeType: 'image/png' | 'image/jpeg' } | null>;
}

/**
 * What the surface may ask about Telegram administrators.
 *
 * Structural rather than the class, which is what keeps `bot-runtime.test.ts` able to
 * stand one up without an identity module — and what stops this file from acquiring the
 * ability to create an administrator, change a password or read a hash.
 */
export interface TelegramAdminPort {
  resolve(
    scope: TenantContext,
    telegramUserId: string,
    correlationId: CorrelationId,
  ): Promise<{
    readonly admin: {
      readonly id: string;
      readonly username: string;
      readonly telegramUserId: string | null;
    };
    readonly actor: ActorContext;
    readonly permissions: ReadonlySet<PermissionKey>;
  } | null>;
  listBound(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<
    readonly {
      readonly id: string;
      readonly username: string;
      readonly telegramUserId: string | null;
    }[]
  >;
  link(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly username: string; readonly telegramUserId: string; readonly reason: string },
  ): Promise<{ readonly username: string }>;
  revoke(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
    reason: string,
  ): Promise<{ readonly username: string }>;
  setRoles(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly username: string;
      readonly roleKeys: readonly string[];
      readonly reason: string;
      /** The update's key, so a redelivered command is replayed rather than run twice. */
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly admin: { readonly username: string }; readonly roleKeys: string[] }>;
  /**
   * The roster: every administrator on this tenant, with their role keys.
   *
   * `listBound` is NOT this and is not being replaced — it answers "who can be reached
   * in Telegram", which is what the receipt lane needs. This answers "who exists",
   * which is what a section that can disable somebody needs.
   */
  listAll(scope: TenantContext, actor: ActorContext): Promise<readonly AdminRosterEntry[]>;
  /** ACTIVE or DISABLED, through the same service and the same guard the Web Admin uses. */
  setStatus(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
    status: 'ACTIVE' | 'DISABLED',
    reason: string,
    /** The update's key. A Telegram callback is redelivered, so it is replayed, not re-run. */
    idempotencyKey: string,
  ): Promise<AdminRosterEntry>;
}

/**
 * One administrator, as the roster and the detail screen need them.
 *
 * Structural, like every other shape on this port: the surface declares what it reads
 * and the identity module's projection satisfies it. What is NOT here is the point —
 * no password hash, no session, no `lastLoginAt`, no IP. A detail message is
 * forwardable for ever and a credential must never cross this surface at all.
 */
export interface AdminRosterEntry {
  readonly admin: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
    readonly telegramUserId: string | null;
  };
  readonly roleKeys: readonly string[];
}
