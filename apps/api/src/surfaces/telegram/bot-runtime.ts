import { createHash } from 'node:crypto';
import {
  ANTI_SPAM_BLOCK_REASON,
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  SERVICE_REFUND_REASON_MAX_LENGTH,
  SERVICE_REFUND_REASON_MIN_LENGTH,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  providerDescriptor,
  isNexaError,
  currencyCodeSchema,
  money,
  normalizeReceiptCaption,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  plainAmount,
  providerUsernameLookupSchema,
  telegramUserIdSchema,
  serviceTransferRecipientRefusalSchema,
  uuidV7Schema,
  DEVICE_ADDON_MAX_QUANTITY,
  SERVICE_LOCATIONS_PER_PANEL_MAX,
  USAGE_REMINDER_PERCENT_MAX,
  USAGE_REMINDER_PERCENT_MIN,
  CONNECTION_GUIDE_PLATFORMS,
  SERVICE_NOTE_CLEAR_TOKEN,
  SERVICE_NOTE_MAX_LENGTH,
  SERVICE_SEARCH_MAX_LENGTH,
  clientAppPlatformSchema,
  paymentGatewayProviderSchema,
  telegramChannelJoinUrl,
  PAYMENT_GATEWAY_DESCRIPTORS,
  REFERRAL_MENU_COMMAND,
  TRIAL_MENU_COMMAND,
} from '@nexa/contracts';
import type { AntiSpamService } from '../../modules/commerce/customers/application/anti-spam.service.js';
import type { ChannelMembershipService } from '../../modules/commerce/customers/application/channel-membership.service.js';
import type { TermsAcceptanceService } from '../../modules/control/terms/application/terms-acceptance.service.js';
import type {
  ClientAppPlatform,
  ConnectionGuidePlatform,
  PaymentGatewayProvider,
  PaymentPurpose,
  ProviderLastSeen,
  ActorContext,
  BotInstanceId,
  Clock,
  CorrelationId,
  CustomerArrival,
  CustomerNotificationKind,
  Money,
  OrderId,
  OperationState,
  OrderPurpose,
  PaymentId,
  PermissionKey,
  ProductId,
  ServiceActionAvailability,
  ServiceOperatorAction,
  ServiceReminderThresholds,
  ServiceTransferRecipientRefusal,
  SettingKey,
  TemplateKey,
  TelegramChannel,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import {
  ADMIN_MENU_COMMAND,
  DEFAULT_USERNAME_PREFIX,
  previewUsername,
  validateUsernamePolicy,
} from '@nexa/contracts';
import type { PanelUsernamePolicy } from '../../modules/platform/panels/application/ports.js';
import {
  MARKETING_OPT_OUT_DISABLED_REASON,
  type CustomerService,
} from '../../modules/commerce/customers/application/customer.service.js';
import type { PaymentDestinationRenderer } from '../../modules/commerce/payments/infrastructure/destination-renderer.js';
import type { InboundReceiptFile } from '../../modules/commerce/payments/application/receipt-ports.js';
import type { PaymentRecord } from '../../modules/commerce/payments/application/ports.js';
import type { ReceiptService } from '../../modules/commerce/payments/application/receipt.service.js';
import type { ReceiptCreditCaptureService } from '../../modules/commerce/payments/application/receipt-credit-capture.service.js';
import type { ServiceRefundDecisionService } from '../../modules/commerce/payments/application/service-refund-decision.service.js';
import { mayBePushedRefundRequests } from '../../modules/commerce/payments/application/service-refund-push.consumer.js';
import {
  normaliseRefundReason,
  type ServiceRefundRequestService,
} from '../../modules/commerce/payments/application/service-refund-request.service.js';
import type {
  ReceiptBlockCaptureService,
  ReceiptRejectCaptureService,
} from '../../modules/commerce/payments/application/receipt-reason-policies.js';
import type { ReasonAskResult } from '../../modules/commerce/payments/application/receipt-reason-capture.service.js';
import type { CustomerBlockCaptureService } from '../../modules/commerce/customers/application/customer-block-capture.js';
import {
  RECEIPT_REVIEW_NOTE_MAX,
  reviewNoteOf,
} from '../../modules/commerce/payments/application/receipt-review-caption.js';
import { ADMIN_CAPTURE_REASON_MAX_LENGTH } from '@nexa/contracts';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerSendResult,
  CustomerMessenger,
  CustomerMessageRef,
  MainMenuVariant,
  CustomerEditMessage,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../modules/commerce/messaging/application/inline-buttons.js';
import type { InlineButtonKey } from '@nexa/contracts';
import type { ProductService } from '../../modules/commerce/catalog/application/product.service.js';
import {
  CATEGORY_SORT_ORDER_MAX,
  type ProductCategoryService,
} from '../../modules/commerce/catalog/application/product-category.service.js';
import type {
  ProductCategoryListing,
  ProductRecord,
} from '../../modules/commerce/catalog/application/ports.js';
import type { CommercialActionService } from '../../modules/commerce/commercial/application/commercial-action.service.js';
import type { LocationChangeService } from '../../modules/commerce/locations/application/location-change.service.js';
import type { TrialService } from '../../modules/commerce/trials/application/trial.service.js';
import type { OrderService } from '../../modules/commerce/orders/application/order.service.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import {
  FX_UNAVAILABLE_REASON,
  type GatewayAttempt,
  type ManualTransferInstruction,
  type PaymentService,
} from '../../modules/commerce/payments/application/payment.service.js';
import type {
  GatewayAttemptView,
  GatewayCardFacts,
  GatewayPaymentService,
} from '../../modules/commerce/payments/application/gateway-payment.service.js';
import type { GatewayInvoiceRecord } from '../../modules/commerce/payments/application/gateway-invoice-ports.js';
import type { GatewayReceiptCaptureService } from '../../modules/commerce/payments/application/gateway-receipt-capture.service.js';
import {
  cardChangeAvailable,
  receiptUploadAvailable,
} from '../../modules/commerce/payments/domain/tonpays-telegram.js';
import type { WalletService } from '../../modules/commerce/wallet/application/wallet.service.js';
import {
  ProvisioningService,
  operationHasEnded,
} from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { CustomerServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { DeliveryService } from '../../modules/commerce/provisioning/application/delivery.service.js';
import {
  CONNECTED_CALLBACK_PREFIX,
  SERVICE_CARD_CALLBACK_PREFIX,
  SUPPORT_CALLBACK_DATA,
  TUTORIAL_CALLBACK_DATA,
} from '../../modules/commerce/provisioning/application/delivery.service.js';
import type { CustomerCaptureService } from '../../modules/commerce/customers/application/customer-capture.service.js';
import type { CustomerCaptureRecord } from '../../modules/commerce/customers/application/customer-capture-ports.js';
import type { SubscriptionFileService } from '../../modules/commerce/provisioning/application/subscription-file.service.js';
import type { ServiceRefreshService } from '../../modules/commerce/provisioning/application/service-refresh.service.js';
import type { CardMessageRef } from '../../modules/commerce/provisioning/application/operation-card.js';
import type { ServiceTransferService } from '../../modules/commerce/provisioning/application/service-transfer.service.js';
import type { CustomerCountersReader } from '../../modules/commerce/customers/application/customer-counters-ports.js';
import type {
  TopupRoute,
  WalletTopupFlowService,
} from '../../modules/commerce/payments/application/wallet-topup-flow.service.js';
import type { CustomerScreenComposer } from '../../modules/commerce/messaging/application/customer-screens.js';
import type { ResellerService } from '../../modules/commerce/resellers/application/reseller.service.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';
import type { OperatorServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type {
  ServiceAdminService,
  ServiceOperationHistory,
} from '../../modules/commerce/provisioning/application/service-admin.service.js';
import { decodeKeysetToken, encodeKeysetToken, type KeysetToken } from './keyset-token.js';
import type { TelegramWizardRecord } from '../../modules/commerce/messaging/application/telegram-message-state.js';
import type { TelegramReviewOutcome } from '@nexa/contracts';
import {
  REVIEW_OUTCOME_KEYS,
  REVIEW_TAP_INTENTS,
  WIZARD_GATES,
  callbackOriginOf,
  typedMessageOf,
  type CallbackOrigin,
  type InvoiceScreensPort,
  type MessageStatePort,
  type ReviewDirective,
  type WizardDirective,
} from './wizard-state.js';
import type { PanelService } from '../../modules/platform/panels/application/panel.service.js';
import type { ReferralProgram } from '../../modules/commerce/referrals/application/referral-program.js';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ERROR_CODES,
  TICKET_MESSAGE_MAX_LENGTH,
  TICKET_OPEN_MAX_PER_CUSTOMER,
  TICKET_VIEW_MESSAGE_COUNT,
} from '@nexa/contracts';
import type {
  InboundTicketFile,
  TicketService,
} from '../../modules/commerce/tickets/application/ticket.service.js';
import type { TicketCategoryService } from '../../modules/commerce/tickets/application/ticket-category.service.js';
import type { TicketScreenComposer } from '../../modules/commerce/tickets/application/ticket-screens.js';
import type { ClientAppCatalog } from '../../modules/control/client-apps/application/client-app-catalog.js';
import { CLIENT_APP_VIEW_PERMISSION } from '../../modules/control/client-apps/application/client-app.service.js';
import type {
  ClientAppVideoService,
  InboundTutorialVideo,
} from '../../modules/control/client-apps/application/client-app-video.service.js';
import {
  ADMIN_TUTORIAL_INTENTS,
  adminTutorialCallback,
  adminTutorialTurn,
  maySeeTutorials,
  tutorialVideoOf,
  messageSentAt,
  tutorialsPanelButton,
} from './admin-tutorial-video.js';

import { readHealth } from '../../modules/platform/panels/application/panel-health-view.js';

/**
 * What the customer asked for.
 *
 * A tiny closed vocabulary rather than a parsed command string, decided at the
 * boundary and never passed onward as text. Phase 4A handles `/start` and answers
 * everything else with the unsupported-input fallback; later subphases add members.
 *
 * There is no FSM and no conversation state. The legacy system's prompt capture
 * swallowed an ordinary message and overwrote a production gateway setting
 * (INCIDENT-FIN-001), which is what a stateful prompt does when it outlives the
 * question it was asked for.
 */
export const BOT_INTENTS = [
  'START',
  'CATALOG',
  /*
   * The two levels of the categorised catalogue (WP5, OQ-4B-01).
   *
   * Their own intents rather than `CATALOG` with an optional payload, for the reason
   * `SERVICES_PAGE` states: `CATALOG` arrives from a command or the main-menu keyboard
   * carrying nothing, and these carry a PAGE NUMBER the boundary validates before any
   * handler sees it. `CATEGORY` also carries the category's id.
   */
  'CATALOG_PAGE',
  'CATEGORY',
  /*
   * Take a free trial (WP6-A; R1). Carries nothing: which panels offer one, the limit and
   * the panel are all decided on the server when the tap arrives — straight to the claim
   * when one panel offers a trial, to a choice when several do.
   */
  'TRIAL_CLAIM',
  /*
   * R1: the customer chose a panel on the trial choice. Carries the panel's id; whether
   * that panel still offers a trial is decided again under the customer's lock.
   */
  'TRIAL_PANEL',
  /*
   * Package D — the custom service. MENU carries nothing and lists the locations decided
   * on the server; LOCATION carries the panel's id and opens the volume window. The
   * figures themselves arrive as `USERNAME_TEXT` and are read by their capture windows.
   */
  'CUSTOM_SERVICE_MENU',
  'CUSTOM_SERVICE_LOCATION',
  'ORDER',
  'CONFIRM',
  'WALLET',
  'PAY_WALLET',
  'PAY_MANUAL',
  'PAY_GATEWAY',
  /*
   * «🧾 ثبت پرداخت» opens the route selector for an order, and «❌ بستن لیست» closes it.
   * Both name the order and write nothing; the route buttons inside are the taps that pay.
   */
  'PAY_METHODS',
  'PAY_METHODS_CLOSE',
  /* WP11A: the customer asks what became of an external-gateway attempt. Names the payment. */
  'GATEWAY_CHECK',
  /*
   * TonPays Telegram (§8.1): «📤 ارسال فیش واریزی» opens the payment-scoped receipt window,
   * «🔄 تعویض کارت» asks for another card. Each names the PAYMENT and nothing else.
   */
  'GATEWAY_RECEIPT',
  'GATEWAY_CARD_CHANGE',
  'PAY_CANCEL_ASK',
  'PAY_CANCEL',
  'PAY_SENT',
  'TOPUP_MENU',
  'TOPUP_PICK',
  /*
   * The customer's own referral link (WP9 F12). Carries nothing: whose link, and whether
   * the program is running at all, are decided on the server when the tap arrives.
   */
  'REFERRAL_INVITE',
  'ORDER_CANCEL_ASK',
  'ORDER_CANCEL',
  'SERVICES',
  /*
   * The NEXT page of a customer's own services.
   *
   * Phase 6A. Its own intent rather than `SERVICES` with an optional payload, because
   * the two are parsed differently: `SERVICES` comes from a command or the main-menu
   * keyboard and carries nothing, and this one carries an opaque cursor that the
   * boundary validates before any handler sees it.
   */
  'SERVICES_PAGE',
  'SERVICE',
  'SERVICE_RESEND',
  /** Package E: the panel's ready-made connection files, sent as documents. */
  'SERVICE_FILES',
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
  'SERVICE_TERMINATE_ASK',
  'SERVICE_TERMINATE',
  /* WP6-C: a customer's own link rotation, ask then confirm. */
  'SERVICE_ROTATE_ASK',
  'SERVICE_ROTATE',
  /*
   * WP19: a customer's refund request for a service. ASK shows what would happen and
   * writes nothing; CONFIRM opens the reason capture. The request is filed by the reason.
   */
  'SERVICE_REFUND_ASK',
  'SERVICE_REFUND_CONFIRM',
  /*
   * Package F: a customer hands a service to another customer. ASK opens the window that
   * reads the recipient's id and moves nothing; CONFIRM names the service AND the
   * recipient's id, both read again by the transfer, and is the only tap that moves one.
   */
  'SERVICE_TRANSFER_ASK',
  'SERVICE_TRANSFER_CONFIRM',
  'SERVICE_RENEW',
  'SERVICE_ADD_TRAFFIC',
  'SERVICE_ADD_TIME',
  'SERVICE_BUY_TRAFFIC',
  'SERVICE_BUY_TIME',
  /* WP-A5: open the extra-users offer (`dv:`), and buy a chosen quantity (`dq:`). */
  'SERVICE_ADD_DEVICES',
  'SERVICE_BUY_DEVICES',
  /*
   * WP-A6: open the location change (`lc:`), choose a target (`lt:`), and confirm a FREE
   * move (`lf:`). A priced target goes on to the ordinary pre-invoice and `q:`.
   */
  'SERVICE_CHANGE_LOCATION',
  'SERVICE_LOCATION_TARGET',
  'SERVICE_LOCATION_CONFIRM',
  'SERVICE_ACTION_CONFIRM',
  /*
   * The three the username step needs (Deliverable A).
   *
   * `USERNAME_TEXT` is the only intent in this vocabulary produced by an ORDINARY
   * message rather than a command or a button, and that is exactly the shape
   * INCIDENT-FIN-001 warns about. It is safe here because it decides nothing: the
   * handler asks the database whether a window is open, and `NO_WINDOW` — the answer
   * for almost every message — falls through to the same fallback as before.
   */
  'USERNAME_CUSTOM',
  'USERNAME_AUTOMATIC',
  'USERNAME_TEXT',
  /*
   * WP8 P11 — a discount code on a new-purchase draft. ENTER opens the window in which
   * the customer's next plain message is read as a code; REMOVE re-quotes the draft
   * without one. The typed code itself arrives as `USERNAME_TEXT` and is offered to the
   * code window only after the username window has said it is not open — at most one
   * of the two is ever open, because opening either closes the other.
   */
  'DISCOUNT_CODE_ENTER',
  'DISCOUNT_CODE_REMOVE',
  /*
   * The customer UX completion (docs/customer-ux-completion-audit.md). Every one is a
   * callback that names an id or nothing; the screens they open re-read every fact.
   */
  'MAIN_MENU',
  'TUTORIAL',
  'TUTORIAL_PLATFORM',
  /*
   * WP-A10: one of the tenant's client apps, opened from a platform's list. Carries the
   * entry's id; the screen re-reads the entry, and a disabled or removed one is "gone".
   * `TUTORIAL` itself is also what `/apps` and «📱 دانلود برنامه و آموزش اتصال» open.
   */
  'CLIENT_APP',
  'SERVICE_CONNECTED',
  'SUPPORT',
  'TOPUP_ROUTE',
  'TOPUP_CLOSE',
  'SERVICES_SEARCH',
  'SERVICE_REFRESH',
  /* R3: the service card again, drawn IN PLACE of the message tapped (the link-change ask's back). */
  'SERVICE_CARD',
  'SERVICE_NOTE',
  'SERVICE_RENEW_QUOTE',
  'REFERRAL_GIFT',
  'HELP',
  /*
   * Round N close (§D): the promotional opt-out. `/stop` and the support screen's button opt
   * the customer out of MARKETING broadcasts; the button on that reply, and on the support
   * screen afterwards, opts them back in. Neither touches a transactional notice. Both are
   * exempt from the membership guard: a customer who has not joined the channel must still
   * be able to say "stop", and the guard's own screen is not the place to be refused that.
   */
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
  'RECEIPT_UPLOAD',
  /*
   * Package B — the `✅ بررسی عضویت` button. Exempt from the membership guard, and it
   * never replays what the customer first asked for: a pass answers the main menu.
   */
  'MEMBERSHIP_CHECK',
  /*
   * Program §6 — the accept button under the terms and rules. Carries the VERSION the
   * customer was shown; only that version is recorded, and only while it is still the
   * current one. Exempt from the terms gate (it is the way through it), never from the
   * membership gate, and never replays what the customer first asked for.
   */
  'TERMS_ACCEPT',
  /*
   * WP-A7 — the customer's support tickets. `TICKETS` is the list (the menu entry, /tickets
   * and its callback), `TICKET_NEW` the category chooser, `TICKET_CATEGORY` opens the window
   * that reads the new ticket's first message, `TICKET_VIEW` shows one conversation,
   * `TICKET_REPLY` opens the reply window, and the close is ask-then-act. Every one names an
   * id or nothing; the service re-reads the ticket and its owner on every write.
   */
  'TICKETS',
  'TICKET_NEW',
  'TICKET_CATEGORY',
  'TICKET_VIEW',
  'TICKET_REPLY',
  'TICKET_CLOSE_ASK',
  'TICKET_CLOSE',
  /*
   * Phase 5T — the management panel.
   *
   * These are intents like any other, and that is the point: they are parsed from the
   * update with no knowledge of who sent it, and the HANDLER resolves the Telegram
   * account's binding and charges a permission. A customer who crafts one of these
   * callbacks reaches `adminTurn`, resolves to no administrator and is answered with
   * the ordinary unsupported-input fallback — the same reply they get for any other
   * string this bot does not understand.
   */
  'ADMIN_PANEL',
  'ADMIN_RECEIPTS',
  'ADMIN_RECEIPT',
  'ADMIN_APPROVE',
  'ADMIN_REJECT',
  /*
   * Payment File 02 §12 — the third disposition. `ADMIN_CREDIT` opens an amount capture
   * for one payment; the amount itself arrives as ordinary text and is offered to the
   * capture only when the sender is an administrator whose capture is waiting;
   * `ADMIN_CREDIT_CONFIRM` is the only callback that moves money, and it names the
   * CAPTURE, never an amount; `ADMIN_CREDIT_CANCEL` abandons it.
   */
  'ADMIN_CREDIT',
  'ADMIN_CREDIT_CONFIRM',
  'ADMIN_CREDIT_CANCEL',
  /*
   * WP10 follow-up — Block User from the receipt (File 01 §9). `ADMIN_BLOCK_ASK` writes
   * nothing; `ADMIN_BLOCK_OPEN` opens the reason capture; the reason arrives as ordinary text,
   * offered only to its own administrator's open capture; `ADMIN_BLOCK_CONFIRM` is the only
   * callback that blocks, and names the CAPTURE; `ADMIN_BLOCK_CANCEL` abandons it. None of
   * them decides anything about the payment.
   */
  'ADMIN_BLOCK_ASK',
  'ADMIN_BLOCK_OPEN',
  'ADMIN_BLOCK_CONFIRM',
  'ADMIN_BLOCK_CANCEL',
  /*
   * File 01 §7 — the rejection's mandatory reason. `ADMIN_REJECT` (the reject button) now
   * OPENS a reason capture and rejects nothing; `ADMIN_REJECT_CONFIRM` is the only callback
   * that rejects, and names the CAPTURE; `ADMIN_REJECT_CANCEL` abandons it.
   */
  'ADMIN_REJECT_CONFIRM',
  'ADMIN_REJECT_CANCEL',
  /*
   * WP19: a decision on a customer's service refund request. APPROVE opens the amount
   * capture and REJECT the reason capture — neither decides anything; CONFIRM names the
   * amount CAPTURE and is the only callback that approves; CANCEL abandons either prompt.
   */
  'ADMIN_REFUND_REQUEST_APPROVE',
  'ADMIN_REFUND_REQUEST_REJECT',
  'ADMIN_REFUND_REQUEST_CONFIRM',
  'ADMIN_REFUND_REQUEST_CANCEL',
  'ADMIN_SECTION',
  /*
   * WP1 — one administrator, and the one write this surface may make about them.
   *
   * `ADMIN_ADMIN_STATUS` carries the TARGET status rather than "flip it", the same
   * shape the username toggles use: a second tap on a slow connection then writes the
   * value already held instead of undoing the first.
   *
   * There is deliberately no `ADMIN_ADMIN_PASSWORD` and no session listing. A
   * credential must not cross Telegram at all, and a message naming the IP an
   * administrator signs in from is forwardable for ever — both stay in the Web Admin,
   * where the operator acting on them already is.
   */
  'ADMIN_ADMIN',
  'ADMIN_ADMIN_STATUS',
  'ADMIN_REVOKE',
  /*
   * Phase 6A — the services section.
   *
   * `ADMIN_SERVICE_TERMINATE_ASK` is the first ask-then-act pair on the ADMIN side.
   * Every admin action before it fired on one tap, which is right for approving a
   * receipt and wrong for deleting an account on a provider: the asking callback is
   * what a list or a detail screen carries, and the destructive one is produced in
   * exactly one place.
   */
  'ADMIN_SERVICES',
  /*
   * WP3 — the browsable half of the services section.
   *
   * `ADMIN_SERVICES` stays a QUEUE: the unreconciled and the undelivered, ten rows
   * that are ten decisions. These two are an INVENTORY, which is a different question
   * and needs a different list — "where is this one" rather than "what needs me".
   * Collapsing them would lose the first, because a queue that pages is no longer a
   * queue.
   *
   * Two intents rather than one with an optional payload, for the reason
   * `SERVICES_PAGE` gives: the first is a bare tap and the second carries an opaque
   * cursor the boundary validates before any handler sees it.
   */
  'ADMIN_SERVICES_BROWSE',
  'ADMIN_SERVICES_BROWSE_PAGE',
  'ADMIN_SERVICE',
  'ADMIN_SERVICE_SYNC',
  'ADMIN_SERVICE_RESEND',
  'ADMIN_SERVICE_RETRY',
  'ADMIN_SERVICE_RECONCILE',
  'ADMIN_SERVICE_SUSPEND',
  'ADMIN_SERVICE_RESUME',
  'ADMIN_SERVICE_TERMINATE_ASK',
  'ADMIN_SERVICE_TERMINATE',
  'ADMIN_SERVICE_ROTATE_ASK',
  'ADMIN_SERVICE_ROTATE',
  /*
   * Phase 6B — the panels section.
   *
   * `ADMIN_PANELS` is the section and `ADMIN_PANEL` is the management panel itself,
   * which already existed: the singular one is the whole screen and the plural one is
   * a fleet. `ADMIN_PANEL_DETAIL` is one panel, so no intent is named after two
   * different things.
   *
   * `ADMIN_PANEL_ARCHIVE_ASK` and `ADMIN_PANEL_ARCHIVE` are the ask-then-act pair, the
   * second on this surface. Archiving is reversible — it is the Web Admin's Restore
   * button — and still gets a confirmation, because it takes a panel out of the
   * catalogue and off the monitor's schedule on one tap from a phone.
   */
  'ADMIN_PANELS',
  'ADMIN_PANELS_PAGE',
  'ADMIN_PANEL_DETAIL',
  'ADMIN_PANEL_TEST',
  'ADMIN_PANEL_ENABLE',
  'ADMIN_PANEL_DISABLE',
  'ADMIN_PANEL_ARCHIVE_ASK',
  'ADMIN_PANEL_ARCHIVE',
  /*
   * Phase 6C — a panel's username policy, read back and edited.
   *
   * Five intents. Three are taps and carry only what was tapped; two are COMMANDS that
   * carry their argument in the same message, because a prefix and a template are text
   * an operator authors and this surface has no prompt that captures the next message.
   * INCIDENT-FIN-001 is what such a prompt does when it outlives its question.
   */
  'ADMIN_USERNAME',
  'ADMIN_USERNAME_TOGGLE',
  'ADMIN_USERNAME_STRATEGY',
  'ADMIN_USERNAME_PREFIX',
  'ADMIN_USERNAME_TEMPLATE',
  /*
   * Phase 6C — the reminder settings section.
   *
   * Three intents and no fourth, because there is no typed-value turn: `ADMIN_REMINDERS`
   * is the whole configuration printed at once, `ADMIN_REMINDER_EDIT` is one setting and
   * the values it may take, and `ADMIN_REMINDER_SET` is a tap on one of them. The value
   * travels in the callback data, so this section has no pending prompt and therefore no
   * way to swallow an unrelated message (INCIDENT-FIN-001).
   *
   * There is deliberately no intent for turning a reminder family off. All three flags
   * are TENANT_WIDE, and ADR-0010 asks for a typed confirmation and a recorded reason at
   * that blast radius — a button that supplied either would be the safeguard removed
   * rather than satisfied, so the section says where to do it instead.
   */
  'ADMIN_REMINDERS',
  'ADMIN_REMINDER_EDIT',
  'ADMIN_REMINDER_SET',
  /*
   * WP2 — the customers section.
   *
   * Six intents. `ADMIN_CUSTOMERS` and `ADMIN_CUSTOMERS_PAGE` are one paged list;
   * `ADMIN_CUSTOMER` is one person by their internal id, reached by tapping a row;
   * `ADMIN_CUSTOMER_FIND` is the same screen reached by the numeric Telegram id an
   * operator quotes from a support conversation, which is a DIFFERENT question and
   * charges `users.search` on top of `users.view` because the permission catalogue
   * already separates them. `ADMIN_CUSTOMER_BLOCK` and `ADMIN_CUSTOMER_UNBLOCK` are the
   * two writes, and there is no third because `CUSTOMER_STATUSES` has no third member.
   *
   * The lookup is a COMMAND carrying its argument, not a prompt that captures the next
   * message — the rule `/link`, `/role` and `/service` state, and INCIDENT-FIN-001 is
   * what the other kind does when it outlives its question.
   */
  'ADMIN_CUSTOMERS',
  'ADMIN_CUSTOMERS_PAGE',
  'ADMIN_CUSTOMER',
  'ADMIN_CUSTOMER_FIND',
  'ADMIN_CUSTOMER_BLOCK',
  'ADMIN_CUSTOMER_UNBLOCK',
  /*
   * WP10G — the two writes above are now ASKS (closing OQ-WP10F-03): `ADMIN_CUSTOMER_BLOCK`
   * draws a confirmation and `ADMIN_CUSTOMER_BLOCK_OPEN` opens the mandatory reason's capture;
   * the typed reason is restated and `ADMIN_CUSTOMER_BLOCK_CONFIRM` is the one tap that blocks.
   * `ADMIN_CUSTOMER_UNBLOCK` draws its confirmation and `ADMIN_CUSTOMER_UNBLOCK_CONFIRM` is the
   * one tap that unblocks. No one-tap write remains in the section.
   */
  'ADMIN_CUSTOMER_BLOCK_OPEN',
  'ADMIN_CUSTOMER_BLOCK_CONFIRM',
  'ADMIN_CUSTOMER_BLOCK_CANCEL',
  'ADMIN_CUSTOMER_UNBLOCK_CONFIRM',
  /*
   * WP5 — the categories section.
   *
   * Every write is `ProductCategoryService`, the one the Web Admin's `/product-categories`
   * routes call, so nothing here decides what a category may do. The taps carry a TARGET
   * (activate, hide) rather than "flip it", for the reason `ADMIN_ADMIN_STATUS` gives: a
   * double tap on a slow connection writes the state already held instead of undoing the
   * first. `ADMIN_CATEGORY_DELETE_ASK` and `ADMIN_CATEGORY_DELETE` are the ask-then-act
   * pair. The three that carry operator TEXT — a name, an emoji — are commands with their
   * argument in the same message, never a prompt that captures the next one
   * (INCIDENT-FIN-001).
   *
   * `ADMIN_CATEGORY_PRODUCTS`, `_PICK` and `_ASSIGN` are the reassignment: choose a
   * product, then the category it should move to. Chosen from a list of products rather
   * than from inside a category because the product that most needs a category is the one
   * that has NONE, and no category screen would ever list it.
   */
  'ADMIN_CATEGORIES',
  'ADMIN_CATEGORY',
  'ADMIN_CATEGORY_ACTIVATE',
  'ADMIN_CATEGORY_DEACTIVATE',
  'ADMIN_CATEGORY_SHOW',
  'ADMIN_CATEGORY_HIDE',
  'ADMIN_CATEGORY_UP',
  'ADMIN_CATEGORY_DOWN',
  'ADMIN_CATEGORY_DELETE_ASK',
  'ADMIN_CATEGORY_DELETE',
  'ADMIN_CATEGORY_NEW',
  'ADMIN_CATEGORY_RENAME',
  'ADMIN_CATEGORY_EMOJI',
  'ADMIN_CATEGORY_PRODUCTS',
  'ADMIN_CATEGORY_PICK',
  'ADMIN_CATEGORY_ASSIGN',
  'ADMIN_LINK',
  'ADMIN_ROLE',
  // Spec §7: the client apps section and its «تنظیم ویدیو» wizard (`admin-tutorial-video.ts`).
  ...ADMIN_TUTORIAL_INTENTS,
  'UNSUPPORTED',
] as const;
export type BotIntent = (typeof BOT_INTENTS)[number];

/**
 * The intent and the ONE id it refers to.
 *
 * `ORDER` and `CONFIRM` arrive as button taps and name a product or an order. The id is
 * carried as a separate, VALIDATED field rather than as the raw callback string, so
 * nothing downstream re-parses it — and it is checked as a UUID here, at the boundary,
 * because `callback_data` is client-supplied text and a customer can send any of it.
 *
 * This is not conversation state. There is still no FSM: everything the runtime needs is
 * in the update it is handling, which is what makes a redelivery a replay instead of a
 * step in a half-finished dialogue. INCIDENT-FIN-001 is what a stateful prompt does when
 * it outlives the question it was asked for.
 */
export interface BotCommand {
  readonly intent: BotIntent;
  readonly targetId: string | null;
  /**
   * A SECOND identifier, for the one callback that needs two.
   *
   * Buying a package names both the service it is for and the package itself, and
   * neither can be inferred from the other: the customer owns the service and CHOOSES
   * the package. With no conversation state there is nowhere else to keep the first
   * while they pick the second — that absence is deliberate, and `INCIDENT-FIN-001` is
   * what a stateful prompt does when it outlives its question.
   *
   * Still an identifier and never a quantity. `encodeIdPair` is what makes two of them
   * fit in Telegram's 64 bytes, and both come back through the same UUID validation the
   * single-id path uses.
   */
  readonly secondaryId?: string | null;
  /**
   * The service's ownership version a transfer confirmation (`tc:`) was drawn at (Package
   * F). Carried back so a confirmation older than the last change of owner is refused
   * rather than obeyed; absent on every other command.
   */
  readonly ownershipVersion?: number;
  /**
   * How many extra users / devices a `dq:` tap chose (WP-A5), 1 to
   * `DEVICE_ADDON_MAX_QUANTITY`; absent on every other command.
   *
   * The one callback that carries a number, and it is a CHOICE rather than an amount: the
   * customer is entitled to pick any count the rate allows, the server bounds it again
   * against the rate's maximum and what the service was already sold, and the price is
   * computed from the row — so a modified client can only choose a count it could have
   * tapped, and pays that count's price. Decoded at the boundary as a bounded integer.
   */
  readonly quantity?: number;
  /**
   * The words after a slash command, for the two the management panel accepts.
   *
   * `/link <telegram id> <username>` and `/role <username> <role key>` carry their
   * arguments in the SAME message as the verb, which is what makes them commands rather
   * than a prompt that captures the next message — the shape INCIDENT-FIN-001 is about.
   * Split on whitespace and otherwise untouched: every argument is validated by the
   * service that uses it (`telegramUserIdSchema`, the username lookup, the role key),
   * because the boundary cannot know which administrator a name refers to.
   */
  readonly args?: readonly string[];
  /**
   * A decoded LIST POSITION, for the two callbacks that page rather than act.
   *
   * Not `targetId`: a cursor is not an identifier, nothing is looked up by it, and a
   * field documented as an id would eventually be passed to a repository as one. It
   * arrives as an opaque token in `callback_data` and is decoded — and therefore
   * validated — at the boundary, so a handler either receives a well-formed position or
   * the update is UNSUPPORTED before it gets there.
   *
   * `KeysetToken` and not one module's cursor type: the customer's services list and
   * the administrator's panels list both page this way, and a `BotCommand` that named
   * the provisioning module's type to carry a panel's position would be a lie about
   * what the field holds. Both cursors ARE this shape, and the handler passes the value
   * to the repository that minted it.
   */
  readonly cursor?: KeysetToken | null;
  /**
   * A PAGE NUMBER, for the two catalogue callbacks.
   *
   * Offset paging, as the owner settled in `docs/wp5-categories-audit.md` §6.4 — and
   * carried as a page rather than a raw offset, so a modified client can ask for a page
   * and nothing else. Parsed and bounded at the boundary by `parseCatalogPage`; a value
   * that fails is UNSUPPORTED before a handler sees it.
   *
   * Not `cursor`, and deliberately: a keyset cursor names a row, and `sort_order` is
   * operator-mutable, so a cursor on it is not a stable position. §6.4 forbids exactly
   * that, and a page number makes no claim of stability it could break.
   */
  readonly page?: number;
  /** Telegram's id for the tapped button, so the spinner can be stopped. */
  readonly callbackQueryId: string | null;
  /**
   * The file a `RECEIPT_UPLOAD` carries, and nothing else ever carries one.
   *
   * It is not conversation state: everything here came out of the update being handled,
   * which is what keeps a redelivery a replay rather than a step in a half-finished
   * dialogue. What the file attaches TO is decided by the capture window in the
   * database, never by this field — so a client that invents one reaches a payment only
   * if a window for that customer on that bot is genuinely open.
   *
   * The CAPTION is deliberately absent. A Persian caption as an identifier is
   * `entities-states.md`'s worst finding, and nothing in this flow needs the text.
   */
  readonly file?: InboundReceiptFile | null;
  /** Spec §7: the video an `ADMIN_APP_VIDEO_UPLOAD` carries, and nothing else ever does. */
  readonly video?: InboundTutorialVideo | null;
}

/**
 * Two UUIDs in 45 bytes, because `callback_data` holds 64 and two of them spell 73.
 *
 * Raw base64url of the thirty-two bytes the pair actually is — not hex, which spells
 * sixty-six and still would not fit, and not a shortened id, which would stop being the
 * id. An encoding, not a token: it carries no authority, it is not signed, and nothing
 * downstream trusts it. Both halves are re-validated as UUIDs and then checked against
 * rows — the service against the customer who owns it, the package against the kind the
 * path is for.
 *
 * `callback_ref`, the registry table Phase 0 planned for exactly this, was dropped by
 * `0002_drop_callback_refs` for having no producer and no reader. This needs no row: the
 * two ids ARE the message, so there is nothing to look up.
 */
export function encodeIdPair(first: string, second: string): string {
  const bytes = Buffer.concat([uuidBytes(first), uuidBytes(second)]);
  return bytes.toString('base64url');
}

export function decodeIdPair(encoded: string): { first: string; second: string } | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return { first: uuidFrom(bytes.subarray(0, 16)), second: uuidFrom(bytes.subarray(16, 32)) };
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function uuidFrom(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The callback-data prefixes. One letter each, because Telegram caps `callback_data` at
 * 64 BYTES and a UUID is 36 of them.
 */
export const ORDER_CALLBACK_PREFIX = 'p:';
export const CONFIRM_CALLBACK_PREFIX = 'c:';
/**
 * The payment-method taps. Each names an ORDER and nothing else.
 *
 * That is the trust boundary, not an encoding detail: a callback is an INTENT and an
 * IDENTIFIER, never a quantity. There is no prefix here that could carry an amount, a
 * currency or a customer, so a modified client has nothing to tamper with beyond the
 * order id — and an id that is not theirs, or not awaiting payment, fails at MUTATION
 * time against the row rather than at render time against what the tap claimed.
 */
export const WALLET_PAY_CALLBACK_PREFIX = 'w:';
export const MANUAL_PAY_CALLBACK_PREFIX = 'm:';
/**
 * Paying an order through an external gateway (WP11A, TonPays). Carries the ORDER ID and
 * nothing else; the route is re-decided on the server when the tap arrives. Drawn only
 * when a real external route is offered for this order; a tap on a stale button when
 * none is answers `bot.payment.gateway_unavailable`.
 */
export const GATEWAY_PAY_CALLBACK_PREFIX = 'g:';

/**
 * "Check my payment" on an external-gateway attempt (WP11A). Names the PAYMENT. Reads the
 * stored state and brings the next server-to-server inquiry forward; it never calls the
 * gateway while Telegram waits, and never says paid until the payment is CONFIRMED.
 * `g` then a letter, so it cannot shadow `g:` nor be shadowed by it.
 */
export const GATEWAY_CHECK_CALLBACK_PREFIX = 'gc:';

/**
 * TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §8.1): «📤 ارسال فیش واریزی»
 * (`gr:`) and «🔄 تعویض کارت» (`gk:`). Each names the PAYMENT — an identifier, never an
 * amount or a card — and is re-decided against the row: the owner, a card-transfer route,
 * PENDING inside the CUSTOMER window (the review deadline never reopens either), no review
 * started, a created invoice, and the bot the invoice is bound to. 3 + 36 bytes, under 64.
 * `g` then a letter, so neither shadows `g:`/`gc:`/`gp:` nor is shadowed by them.
 */
export const GATEWAY_RECEIPT_CALLBACK_PREFIX = 'gr:';
export const GATEWAY_CARD_CHANGE_CALLBACK_PREFIX = 'gk:';

/**
 * Paying an order through ONE named external route (Package A): `gp:<order uuid>.<provider>`,
 * an order the customer owns and a member of a closed enum — the `tp:` shape. The
 * customer's choice of route travels; the amount never does. `g:` stays for messages
 * already sent, and picks the first route as it always did.
 */
export const GATEWAY_ROUTE_PAY_CALLBACK_PREFIX = 'gp:';

/*
 * WP-A7 — the ticket desk's callbacks: `tk` and one letter, so none shadows `t:` (terminate)
 * or is shadowed by it. Each names a ticket, a category, or nothing.
 */
export const TICKETS_CALLBACK_DATA = 'tkl:';
export const TICKET_NEW_CALLBACK_DATA = 'tkn:';
export const TICKET_CATEGORY_CALLBACK_PREFIX = 'tkc:';
export const TICKET_VIEW_CALLBACK_PREFIX = 'tkv:';
export const TICKET_REPLY_CALLBACK_PREFIX = 'tkr:';
export const TICKET_CLOSE_ASK_CALLBACK_PREFIX = 'tkq:';
export const TICKET_CLOSE_CALLBACK_PREFIX = 'tkx:';

/**
 * «🧾 ثبت پرداخت»: opens the payment-method selector for an order, `pm:<order uuid>`. It
 * pays nothing and starts nothing — the selector lists every route offered for the order,
 * and each of THOSE buttons carries the route's own tap (`m:` card-to-card, `gp:` an
 * external route). `px:<order uuid>` is the selector's «❌ بستن لیست», which writes nothing
 * and answers the screen the customer came from.
 */
export const PAY_METHODS_CALLBACK_PREFIX = 'pm:';
export const PAY_METHODS_CLOSE_CALLBACK_PREFIX = 'px:';

/**
 * Withdrawing a pending out-of-band payment. It names the PAYMENT, not the order.
 *
 * The only customer callback in this file that carries a payment id, and it has to: a
 * withdrawal names the thing being withdrawn, and an order can have had several
 * payments over its life. The id is still only an IDENTIFIER — the owner, the state and
 * the money are all re-read inside the transaction, which is what makes a guessed id
 * useless rather than dangerous.
 */
export const CANCEL_PAY_ASK_CALLBACK_PREFIX = 'x:';

/**
 * The second tap, and the only prefix that actually withdraws anything.
 *
 * TWO taps, because the first one sits on the message that told the customer to go and
 * transfer money and that message stays in their chat for ever. A customer who has
 * already paid and mis-touches it would otherwise have closed the payment their
 * transfer was against — permanently, since `PAYMENT_MACHINE` has no edge out of
 * `CANCELLED` and migration 0052 freezes the row — and nothing would tell the operator.
 *
 * `SERVICE_TERMINATE_ASK_CALLBACK_PREFIX` and its partner are the same pair for the
 * same reason, and that precedent is why this is not an invention: a destructive tap a
 * customer can reach by scrolling is asked about, not performed.
 */
export const CANCEL_PAY_CALLBACK_PREFIX = 'z:';

/**
 * The customer saying they have sent the transfer. The opposite of `x:`/`z:`.
 *
 * ONE tap, not two, and the asymmetry is deliberate: the withdrawal pair is asked about
 * because it closes a payment for ever, and this closes nothing. It stamps a claim that
 * an operator reads, and a claim made by accident is corrected by the operator finding
 * no transfer — which is the same thing they do for a claim made in good faith about a
 * transfer their bank later bounces.
 *
 * It names the PAYMENT, like the withdrawal pair and for the same reason: an order can
 * have had several payments over its life and this message is about one of them.
 */
export const PAY_SENT_CALLBACK_PREFIX = 'i:';

/**
 * Withdrawing the ORDER, not one payment. The second destructive pair in this file.
 *
 * `x:`/`z:` close one transfer instruction and leave the order open to be paid another
 * way. These close the order itself, which `ORDER_MACHINE` has no edge out of — so the
 * quoted price goes with it. Two taps, for the reason `CANCEL_PAY_CALLBACK_PREFIX`
 * gives at length: the message carrying the first button stays in the chat for ever.
 */
export const CANCEL_ORDER_ASK_CALLBACK_PREFIX = 'd:';
export const CANCEL_ORDER_CALLBACK_PREFIX = 'f:';
/**
 * A tap on one of the customer's own services, and a request to send its link again.
 *
 * Both name a SERVICE id and nothing else, which is the same trust boundary the payment
 * prefixes state: a callback is an intent and an identifier, never a quantity and never
 * a subscription. The link a resend produces is read from the row, so a modified client
 * has nothing to tamper with beyond the id — and an id that is not theirs fails at
 * `getForCustomer`, by id and owner in one query, with the same answer an id that does
 * not exist gets.
 */
/**
 * Starting a wallet top-up, and choosing one of the offered amounts.
 *
 * `o:` carries NOTHING — it is the button under the balance, and the amounts it shows are
 * read from `wallet.topup.presets` when the tap arrives rather than baked into the data.
 *
 * `y:` carries the chosen amount in MINOR UNITS, and it is the one callback in this file
 * that carries a figure. `WalletTopupIntent` states why at length: there is no order to
 * read an amount from, the service MATCHES this against the configured presets rather
 * than believing it, and an index into the list would be silently honoured as a different
 * amount when an operator edits the presets between the keyboard and the tap.
 */
export const TOPUP_MENU_CALLBACK_PREFIX = 'o:';
export const TOPUP_PICK_CALLBACK_PREFIX = 'y:';
/**
 * The wallet screen's invite button (WP9). Matched on the whole string, like the top-up menu.
 *
 * F5: the wallet no longer draws it — the wallet shows wallet operations only, and the
 * referral program is its own main-menu action. Still PARSED, so a wallet message drawn
 * before F5 opens the same referral screen the menu's button does.
 */
export const REFERRAL_INVITE_CALLBACK_PREFIX = 'rf:';

export const SERVICE_CALLBACK_PREFIX = 's:';
/**
 * The next page of the customer's own service list.
 *
 * `l:` because every other lowercase letter is taken; the table above is the registry.
 * What follows is `encodeKeysetToken`'s token, not a uuid, which is why this prefix is
 * routed separately from every other one here.
 */
export const SERVICES_PAGE_CALLBACK_PREFIX = 'l:';
export const SERVICE_RESEND_CALLBACK_PREFIX = 'r:';

/**
 * The three management actions, and the two halves of ending a service.
 *
 * Four prefixes, and since WP15 G1 only the first two plan anything. `t:` and `k:` were
 * a customer's TERMINATE, ask then confirm; the owner removed the capability, and the two
 * prefixes stay RESERVED and recognised so a message drawn before that release — or a
 * replayed callback — is answered with a refusal instead of falling through to whatever
 * a later prefix might mean. Neither plans an operation. Nothing
 * about which operation to perform is parsed out of the payload — the type is decided
 * by WHICH prefix matched, and each is a fixed two-character string. A modified client
 * can change the id after the colon and nothing else, and an id that is not theirs is
 * refused against the row.
 *
 * The letters are arbitrary, as `p:` for an order and `c:` for a confirmation already
 * are; what matters is that no prefix is a prefix of another, which `intentOf` relies
 * on and a unit test pins.
 */
export const SERVICE_SUSPEND_CALLBACK_PREFIX = 'u:';
export const SERVICE_RESUME_CALLBACK_PREFIX = 'e:';
export const SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 't:';
export const SERVICE_TERMINATE_CALLBACK_PREFIX = 'k:';
/**
 * A customer's own link rotation (WP6-C), ask then confirm.
 *
 * Two characters because every single letter is taken. Neither is a prefix of another
 * prefix here and none is a prefix of them: `r:` differs from both at the second
 * character, and the operator's `ra:`/`rb:` at the second as well. The confirmation
 * carries only the service id — no link stamp, unlike the operator's `rb:` — because a
 * stale confirmation lands on the cooldown, and one tapped after the cooldown has
 * passed is a real request from the person the service belongs to
 * (`docs/wp6c-audit.md` C4).
 */
export const SERVICE_ROTATE_ASK_CALLBACK_PREFIX = 'rc:';
export const SERVICE_ROTATE_CALLBACK_PREFIX = 'rd:';
/*
 * The five commercial prefixes.
 *
 * `n:`, `v:` and `h:` each open a QUOTE and buy nothing — they name a service. `a:` and
 * `b:` name a service AND a package, and they are TWO prefixes rather than one because
 * the KIND has to come from which button was pressed: with one shared prefix the kind
 * would have to be read off the package the customer chose, and then the check that an
 * `ADD_TIME` package cannot be bought through the extra-traffic path would be checking
 * a value against itself. `q:` names the order the quote produced and is the only one
 * that commits.
 *
 * None of them carries a price, a quantity or a duration, which is the rule the whole
 * prefix table exists to make structural: a callback is an intent and an identifier.
 * `v:` and `h:` are single letters for the reason the others are — `callback_data` is
 * capped at 64 bytes and a UUID is 36 of them.
 */
export const SERVICE_RENEW_CALLBACK_PREFIX = 'n:';
export const SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX = 'v:';
export const SERVICE_ADD_TIME_CALLBACK_PREFIX = 'h:';
export const SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX = 'a:';
export const SERVICE_BUY_TIME_CALLBACK_PREFIX = 'b:';
export const SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX = 'q:';
/**
 * Extra users / devices (WP-A5). `dv:<service id>` opens the offer and buys nothing;
 * `dq:<service id + rate id, as a pair>.<quantity>` quotes that many. Two characters, like
 * the other late prefixes, and neither begins nor is begun by `d:`, `dc:` or `dx:`.
 */
export const SERVICE_ADD_DEVICES_CALLBACK_PREFIX = 'dv:';
export const SERVICE_BUY_DEVICES_CALLBACK_PREFIX = 'dq:';

/** `dq:` data for one quantity button: the pair, a dot, then the count in decimal. */
export function encodeDeviceQuantity(serviceId: string, addonId: string, quantity: number): string {
  return `${SERVICE_BUY_DEVICES_CALLBACK_PREFIX}${encodeIdPair(serviceId, addonId)}.${String(quantity)}`;
}

/**
 * A `dq:` tap, decoded, or null. The pair through the same validation every id-carrying
 * callback uses, and the count as a bounded decimal with no sign, no leading zero and no
 * room for anything else — so a malformed tap is UNSUPPORTED rather than a draft.
 */
export function decodeDeviceQuantity(
  data: string,
): { readonly serviceId: string; readonly addonId: string; readonly quantity: number } | null {
  if (!data.startsWith(SERVICE_BUY_DEVICES_CALLBACK_PREFIX)) return null;
  const [pairPart, countPart, ...rest] = data
    .slice(SERVICE_BUY_DEVICES_CALLBACK_PREFIX.length)
    .split('.');
  if (rest.length > 0 || pairPart === undefined || countPart === undefined) return null;
  if (!/^[1-9][0-9]?$/.test(countPart)) return null;
  const quantity = Number.parseInt(countPart, 10);
  if (quantity > DEVICE_ADDON_MAX_QUANTITY) return null;
  const pair = decodeIdPair(pairPart);
  if (pair === null) return null;
  const service = uuidV7Schema.safeParse(pair.first);
  const addon = uuidV7Schema.safeParse(pair.second);
  if (!service.success || !addon.success) return null;
  return { serviceId: service.data, addonId: addon.data, quantity };
}

/**
 * Service location change (WP-A6). `lc:<service id>` opens the choice and buys nothing;
 * `lt:<service id + location id, as a pair>` chooses a target; `lf:<the same pair>`
 * confirms a FREE move. Two characters each, none begun by `l:` or another prefix.
 */
export const SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX = 'lc:';
export const SERVICE_LOCATION_TARGET_CALLBACK_PREFIX = 'lt:';
export const SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX = 'lf:';

/**
 * How many targets one choice screen draws: every one a panel may hold. The admin refuses a
 * panel's 21st location (`SERVICE_LOCATIONS_PER_PANEL_MAX`), so no configured target is
 * ever cut off this screen; the slice is the bound restated, not a second quota.
 */
export const LOCATION_TARGETS_SHOWN = SERVICE_LOCATIONS_PER_PANEL_MAX;

/**
 * The service and location of an `lt:` or `lf:` tap, or null. Both halves through the
 * validation every id-carrying callback uses, so a malformed tap is UNSUPPORTED.
 */
function decodeServiceLocationPair(
  encoded: string,
): { readonly serviceId: string; readonly locationId: string } | null {
  const pair = decodeIdPair(encoded);
  if (pair === null) return null;
  const service = uuidV7Schema.safeParse(pair.first);
  const location = uuidV7Schema.safeParse(pair.second);
  if (!service.success || !location.success) return null;
  return { serviceId: service.data, locationId: location.data };
}

/**
 * The two username-mode buttons.
 *
 * Both carry the ORDER, not the mode-plus-order: the mode is which button was tapped,
 * and a callback that carried it as data would be a mode a client could choose for
 * itself. The server re-checks the chosen mode against the panel's policy anyway —
 * a button drawn before an operator changed the policy is not authorisation.
 */
export const USERNAME_CUSTOM_CALLBACK_PREFIX = 'j:';
export const USERNAME_AUTOMATIC_CALLBACK_PREFIX = 'Z:';

/**
 * The two discount-code buttons on a new-purchase summary (WP8 P11).
 *
 * Both carry the ORDER and nothing else. The code is never callback data: it is typed,
 * into a window the server opened for this one draft, and re-decided by the engine when
 * it arrives.
 */
export const DISCOUNT_CODE_ENTER_CALLBACK_PREFIX = 'dc:';
export const DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX = 'dx:';
/*
 * The customer UX completion's callbacks. Two letters each so none is a prefix of an
 * existing one-letter route; the delivery card's three (`tu:`, `ok:`, `sp:`) are
 * declared beside the composer that draws them and imported here.
 */
export const MAIN_MENU_CALLBACK_DATA = 'mm:';
/** Round N close (§D): the promotional opt-out and opt-in buttons. No id: the tapper is the subject. */
export const MARKETING_OPT_OUT_CALLBACK_DATA = 'mk:out';
export const MARKETING_OPT_IN_CALLBACK_DATA = 'mk:in';
/** Package B: the membership check button's callback data. */
export const MEMBERSHIP_CHECK_CALLBACK_DATA = 'mc:';
/**
 * Program §6: `ac:<terms version uuid>` — accept THAT version of the terms and rules. Two
 * letters: `a:` is taken, and `ac:` differs from it at the second character. 39 bytes.
 */
export const TERMS_ACCEPT_CALLBACK_PREFIX = 'ac:';
export const TUTORIAL_PLATFORM_CALLBACK_PREFIX = 'to:';
/** WP-A10: `ca:<entry uuid>` — one of the tenant's client apps. Begins with `c` like `c:`, `cg:`, `ck:`. */
export const CLIENT_APP_CALLBACK_PREFIX = 'ca:';
/** `tp:<capture uuid>.<provider>` — a capture the customer owns and a member of a closed enum. */
export const TOPUP_ROUTE_CALLBACK_PREFIX = 'tp:';
export const TOPUP_CLOSE_CALLBACK_PREFIX = 'tx:';
/** `sl:<page number>` — a position, clamped server-side; never an identifier. */
export const SERVICES_LIST_PAGE_CALLBACK_PREFIX = 'sl:';
export const SERVICES_SEARCH_CALLBACK_DATA = 'ss:';
export const SERVICE_REFRESH_CALLBACK_PREFIX = 'rs:';
/** `sf:<service id>` — the panel's connection files for that service (Package E). */
export const SERVICE_FILES_CALLBACK_PREFIX = 'sf:';
/**
 * `sv:<service id>` — R3: the service card, edited into the message the tap came from.
 * Declared beside the delivery lane's buttons since round N (F4), which draws it too.
 */
export { SERVICE_CARD_CALLBACK_PREFIX };
export const SERVICE_NOTE_CALLBACK_PREFIX = 'nt:';
export const SERVICE_RENEW_QUOTE_CALLBACK_PREFIX = 'nr:';
export const REFERRAL_GIFT_CALLBACK_DATA = 'rg:';
/**
 * Owner spec §2.2: open the wallet screen, or the catalogue, as a NEW message — the two
 * buttons under a wallet-credit message, which must stay in the chat as the record of the
 * credit. No id and no state: a tap on one a year later opens today's wallet or catalogue,
 * which is exactly what it says. Neither is a wizard button, so neither edits the message.
 */
export const WALLET_OPEN_CALLBACK_DATA = 'wo:';
export const CATALOG_OPEN_CALLBACK_DATA = 'co:';

/**
 * The management panel's prefixes (Phase 5T), deliberately UPPERCASE.
 *
 * Every customer-facing prefix above is a lowercase letter, so no admin prefix can ever
 * become a prefix of one of those — the collision the resend/service pair states as a
 * silent failure, where every tap routes to whichever branch was tested first.
 *
 * `callback_data` is capped at 64 bytes, which is what decides the shape of these: a
 * prefix plus ONE uuid (38 bytes) fits and a prefix plus two does not. So the panel
 * carries a payment or an administrator and never a pair, and nothing here carries a
 * Telegram id — that arrives by command, where there is room for it.
 */
/**
 * How many queue rows one screen shows.
 *
 * A bound on a KEYBOARD, like `TOPUP_PRESETS_MAX`: Telegram refuses a reply_markup past
 * its own limits, and an unbounded queue is a panel that stops working exactly when an
 * installation is busiest. Ten is what the service asks for, applied in SQL against the
 * same predicate — so ten rows are ten decisions still to make.
 */
const ADMIN_QUEUE_LIMIT = 10;
/*
 * How many roster rows one keyboard carries.
 *
 * Larger than `ADMIN_QUEUE_LIMIT` because these are not work items to be
 * cleared — an operator is looking somebody up, and a roster is people created
 * by hand rather than a customer-sized set. Small enough that the keyboard is
 * well inside Telegram's limit whatever the usernames are. The header prints
 * `shown` against `total`, so reaching this bound is visible rather than silent.
 */
const ADMIN_ROSTER_LIMIT = 30;

/**
 * What `bot.admin.panel_detail` renders for a panel with no cap.
 *
 * A LITERAL rather than a template key, and that is a deliberate exception worth
 * stating: `cap` is a `STRING` placeholder inside a message the catalogue owns, and a
 * surface may not compose one template out of another. What it may do is pass a value,
 * and the honest value for "unlimited" is a dash — a figure would read as a cap and
 * `0` would read as a full panel, which is the exact inversion a null means.
 */
const UNCAPPED = '\u2014';

/**
 * The two marks `bot.admin.panel_detail` renders for a username mode.
 *
 * Symbols and not words, for exactly the reason `UNCAPPED` is an em dash: the copy
 * belongs to the catalogue and a surface may pass a VALUE into it but may not compose
 * one message out of another. `ON` is a tick and `OFF` is the same dash the cap uses
 * for "there is none", so the three lines of this block read consistently.
 */
const MODE_ON = '\u2713';
const MODE_OFF = UNCAPPED;

/**
 * The two permissions the panel's sections charge, named once.
 *
 * Read through the guard by the services behind each section; these constants only
 * decide which BUTTONS exist, which is not authorization — `docs/conventions.md`:
 * never by not drawing a button.
 */
const RECEIPTS_VIEW_PERMISSION: PermissionKey = 'receipts.view';
const ADMINS_VIEW_PERMISSION: PermissionKey = 'admins.view';
/*
 * What the roster's status buttons are DRAWN for, and nothing more.
 * `AdminManagementService.setStatus` charges it through the same guard the Web Admin
 * uses, and re-checks it inside the writing transaction, so a crafted `7:` callback
 * from an administrator who lacks it is refused there and leaves the denial record.
 */
const ADMINS_EDIT_PERMISSION: PermissionKey = 'admins.edit';
const RECEIPTS_REVIEW_PERMISSION: PermissionKey = 'receipts.review';
/*
 * The second key the credit-to-wallet disposition charges (Payment File 02 §12). Decides
 * whether its button is DRAWN; `creditToWallet` charges it through the guard.
 */
const WALLET_CREDIT_PERMISSION: PermissionKey = 'users.wallet.credit';
/*
 * The three the services section reads, and the same rule applies: these decide which
 * BUTTONS exist, which is not authorization. `ServiceAdminService`, `ProvisioningService`
 * and `DeliveryService` each charge their own key through the same guard the Web Admin
 * uses, so a crafted callback from an administrator who lacks one is refused there.
 */
const SERVICES_VIEW_PERMISSION: PermissionKey = 'services.view';
const SERVICES_EDIT_PERMISSION: PermissionKey = 'services.edit';
const SERVICES_TERMINATE_PERMISSION: PermissionKey = 'services.terminate';
/*
 * The two the panels section reads, and the same rule again: these decide which BUTTONS
 * exist, never what is allowed. `PanelService.list` and `.get` charge `panels.view`;
 * `.testConnection` and `.setStatus` charge `panels.edit`, through the same guard the
 * Web Admin uses. There is deliberately no third key here, because this surface never
 * touches a credential: `panels.credentials.rotate` has no button in Telegram at all.
 */
const PANELS_VIEW_PERMISSION: PermissionKey = 'panels.view';
/*
 * ONE key for both halves of the reminders section, because there is only one.
 *
 * The section prints five SETTINGS and three FLAGS, and this used to gate it on
 * `settings.view` AND `features.view` — a pair that reads sensibly and cannot be
 * satisfied: `features.view` is in no catalogue. `PERMISSIONS` does not define it, so
 * no role can be granted it, so the button was drawn for nobody, including the owner.
 *
 * The real answer is that flags are not separately permissioned in this product:
 * `FeatureFlagsService` charges `settings.view` for a read and `settings.edit` for a
 * write, deliberately and in terms. So does this.
 */
const SETTINGS_VIEW_PERMISSION: PermissionKey = 'settings.view';
const PANELS_EDIT_PERMISSION: PermissionKey = 'panels.edit';
/*
 * The two the customers section reads, and the same rule a fourth time: these decide
 * which BUTTONS exist, never what is allowed. `CustomerService.list` and `.get` charge
 * `users.view`; `.list` charges `users.search` ON TOP of it when the search names a
 * Telegram id, which is why the lookup command is a different question from the list;
 * `.block` and `.unblock` charge `users.block` and re-check it inside the writing
 * transaction. A crafted `9:` callback from an administrator holding none of them is
 * refused there and leaves the denial record.
 *
 * `users.edit` is deliberately absent. It is declared, it is seeded to `operator`, and
 * nothing charges it — see the comment above it in `packages/contracts/src/permissions.ts`
 * for why that is the product's answer rather than an unfinished feature. Drawing an
 * edit button here would be the first thing to make it a lie.
 */
const CUSTOMERS_VIEW_PERMISSION: PermissionKey = 'users.view';
const CUSTOMERS_BLOCK_PERMISSION: PermissionKey = 'users.block';
/*
 * The categories section's two, and the same rule a fifth time: they decide which
 * BUTTONS exist. `ProductCategoryService.list` charges `catalog.view`; every write charges
 * `catalog.edit` through the guard and again inside its transaction, so a crafted `kb:`
 * callback from an administrator who holds only the first is refused there and leaves the
 * denial record.
 */
const CATALOG_VIEW_PERMISSION: PermissionKey = 'catalog.view';
const CATALOG_EDIT_PERMISSION: PermissionKey = 'catalog.edit';

/**
 * The key each section of the management panel is ADVERTISED by, in one list.
 *
 * Two readers: `adminTurn`, which answers as a customer when an administrator holds
 * none of them, and `isAdmin`, which decides whether `/start` draws the panel row at
 * all. The comment on `isAdmin` already said these two must agree — "the keyboard must
 * not promise a panel the turn would refuse, and it must not withhold one from an
 * administrator who has a section" — and they had stopped agreeing: the reminders
 * section was added with `settings.view` and only one of the two lists learned about
 * it, so an administrator whose only section was the reminders got no panel row and no
 * way to reach one from the keyboard. That is precisely the "missing arm" the comment
 * names, hand-maintained in two places.
 *
 * So there is one list and both read it, the way `ADMIN_INTENTS` is derived rather than
 * listed. Adding a section means adding one entry here, and it cannot half-land.
 *
 * `users.block`, `panels.edit`, `services.edit` and the rest are deliberately absent:
 * this list is what OPENS a section, never what may be done inside one.
 */
const PANEL_SECTION_PERMISSIONS: readonly PermissionKey[] = [
  RECEIPTS_VIEW_PERMISSION,
  ADMINS_VIEW_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  PANELS_VIEW_PERMISSION,
  SETTINGS_VIEW_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
  CATALOG_VIEW_PERMISSION,
  // Spec §7: the client apps section («تنظیم ویدیو»).
  CLIENT_APP_VIEW_PERMISSION,
];

/** Whether these permissions open any section of the panel. */
function hasAnyPanelSection(permissions: ReadonlySet<PermissionKey>): boolean {
  return PANEL_SECTION_PERMISSIONS.some((key) => permissions.has(key));
}

/**
 * The intents `adminTurn` owns, so `act` has one branch rather than nineteen.
 *
 * DERIVED from the name rather than listed, and that is the fix for a defect rather
 * than a tidy-up: it was a hand-kept copy of a naming convention, and Phase 6A added
 * ten `ADMIN_*` intents to `BOT_INTENTS`, wired every one into `adminTurn`'s switch,
 * and did not add them here. `act` never routed them, so an administrator who pressed
 * the services buttons got the unknown-input reply — the exact answer a customer gets,
 * which is why nothing about it looked broken.
 *
 * The convention is total: every intent this runtime routes to the management panel is
 * named `ADMIN_…`, and nothing else is. A new section now reaches the panel by being
 * named, which is one fewer list to forget.
 */
const ADMIN_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>(
  BOT_INTENTS.filter((intent) => intent.startsWith('ADMIN_')),
);

/**
 * The intents the membership guard lets through (Package B, brief B3): support and help —
 * the minimal support path, which `/paysupport` opens too. The check button and the
 * management panel are let through by `guardedAct` itself.
 */
const MEMBERSHIP_EXEMPT_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'SUPPORT',
  'HELP',
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
]);

/**
 * The join screen (brief B4): one message, a URL button per missing REQUIRED channel, and
 * the check button. A public channel's button is its `@handle`; a private one is numbered.
 * A channel with no join link cannot be configured as required, so every one has a button.
 */
function membershipRequired(
  key: 'bot.channels.join_required' | 'bot.channels.still_missing',
  missing: readonly TelegramChannel[],
): PendingReply {
  const buttons: CustomerButton[] = [];
  missing.forEach((channel, index) => {
    const url = telegramChannelJoinUrl(channel);
    if (url === null) return;
    buttons.push({
      ...(channel.handle !== undefined
        ? inlineDataLabel('channels.join_public', { kind: 'TEXT', text: channel.handle })
        : inlineLabel('channels.join_private', { number: index + 1 })),
      url,
    });
  });
  buttons.push({
    ...inlineLabel('channels.check'),
    data: MEMBERSHIP_CHECK_CALLBACK_DATA,
  });
  return {
    key,
    values: {},
    buttons,
    orderId: null,
    /*
     * R2: a gate, not a step — its own message, so the screen the customer tapped stays
     * behind it and works again once they have joined.
     */
    wizard: { kind: 'ORDER', step: 'NOTICE', placement: 'NEW' },
  };
}

/**
 * The terms screen (program §6): the current version's title and text, as the operator
 * wrote them, and one accept button that names THAT version. A gate like the join screen —
 * its own message, so the screen the customer tapped stays behind it.
 */
function termsRequired(
  key: 'bot.terms.required' | 'bot.terms.updated',
  version: { readonly id: string; readonly title: string; readonly body: string },
): PendingReply {
  return {
    key,
    values: { title: version.title, body: version.body },
    buttons: [
      {
        ...inlineLabel('terms.accept'),
        data: `${TERMS_ACCEPT_CALLBACK_PREFIX}${version.id}`,
      },
    ],
    orderId: null,
    wizard: { kind: 'ORDER', step: 'NOTICE', placement: 'NEW' },
  };
}

export const ADMIN_PANEL_CALLBACK_PREFIX = 'A:';
export const ADMIN_RECEIPTS_CALLBACK_PREFIX = 'B:';
export const ADMIN_RECEIPT_CALLBACK_PREFIX = 'C:';
/**
 * WP19 — a customer's refund request for one service, and an administrator's decision on it
 * (`docs/wp19-service-refund-request-audit.md`). Two-letter prefixes, beside `f:` and `q:`
 * rather than inside them: the router matches on the whole prefix, colon included.
 *
 * Customer:
 * - `fa:<service uuid>` opens the request screen: what will happen, and one confirm button.
 *   Reads only. 39 bytes.
 * - `fb:<service uuid>` confirms, and opens the reason capture. The request is filed by the
 *   reason itself, so a confirm that is never followed by a reason files nothing.
 *
 * Administrator (the review card, and the two captures behind it):
 * - `qa:<request uuid>` approve: opens the amount capture.
 * - `qb:<request uuid>` reject: opens the reason capture. The typed reason rejects at once
 *   (brief §2.9): nothing is deleted or moved, so there is nothing to confirm twice.
 * - `qc:<capture uuid>` / `qd:<capture uuid>` confirm or cancel an approval. The callback
 *   names the CAPTURE, never the figure: the amount is on the capture row, so a stale or
 *   forged button cannot carry a different number. `qd:` also cancels a reason prompt.
 */
export const SERVICE_REFUND_ASK_CALLBACK_PREFIX = 'fa:';
export const SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX = 'fb:';
/**
 * Package F — a customer's service transfer (`docs/package-f-service-transfer-audit.md`).
 * Two letters, like `fa:`/`fb:`: every single letter is taken, and neither begins another
 * prefix or is begun by one — `t:`, `to:`, `tp:`, `tr:`, `tu:` and `tx:` all differ at the
 * second character.
 *
 * - `ta:<service uuid>` opens the window that reads the recipient's numeric id. Moves
 *   nothing. 39 bytes.
 * - `tc:<service uuid>.<recipient telegram id>` confirms. At most 3 + 36 + 1 + 19 = 59 bytes,
 *   inside Telegram's 64. Nothing on it is trusted: the transfer reads the owner, the
 *   recipient and the service again, under the service's locks.
 */
export const SERVICE_TRANSFER_ASK_CALLBACK_PREFIX = 'ta:';
export const SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX = 'tc:';
export const ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX = 'qa:';
export const ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX = 'qb:';
export const ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX = 'qc:';
export const ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX = 'qd:';

/**
 * The four administrator callbacks' intents: the buttons of a review card that is PUSHED,
 * to administrators chosen by `mayBePushedRefundRequests`, not reached through a panel
 * section. So `adminTurn` admits them on that same predicate rather than on
 * `hasAnyPanelSection` (Codex review of #83, round 9).
 */
const ADMIN_REFUND_REQUEST_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>([
  'ADMIN_REFUND_REQUEST_APPROVE',
  'ADMIN_REFUND_REQUEST_REJECT',
  'ADMIN_REFUND_REQUEST_CONFIRM',
  'ADMIN_REFUND_REQUEST_CANCEL',
]);

/** The four administrator callbacks, prefix to intent. Each carries one UUIDv7. */
const ADMIN_REFUND_REQUEST_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_APPROVE'],
  [ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_REJECT'],
  [ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_CONFIRM'],
  [ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX, 'ADMIN_REFUND_REQUEST_CANCEL'],
];

export const ADMIN_APPROVE_CALLBACK_PREFIX = 'D:';
export const ADMIN_REJECT_CALLBACK_PREFIX = 'E:';
export const ADMIN_SECTION_CALLBACK_PREFIX = 'F:';
/*
 * The credit-to-wallet disposition's three callbacks (Payment File 02 §12). Two
 * characters, because every single one is taken: `w` then a letter, so the customer's
 * `w:` (pay from the wallet) begins none of them and none begins it — the property
 * `bot-runtime.test.ts` checks over every prefix. `wa:` names a PAYMENT; `wb:` and `wc:`
 * name a CAPTURE. 3 + 36 = 39 bytes, inside Telegram's 64.
 */
export const ADMIN_CREDIT_CALLBACK_PREFIX = 'wa:';
/** The one credit-to-wallet callback that moves money. Produced by the confirmation alone. */
export const ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX = 'wb:';
export const ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX = 'wc:';
/*
 * Block User's four callbacks (WP10 follow-up §4). `x` then a letter, for the reason the
 * credit's are `w` then a letter: `x:` is taken, and `xa:` neither begins nor is begun by it.
 * `xa:` and `xb:` name a PAYMENT; `xc:` and `xd:` name a CAPTURE. 39 bytes at most.
 */
export const ADMIN_BLOCK_ASK_CALLBACK_PREFIX = 'xa:';
export const ADMIN_BLOCK_OPEN_CALLBACK_PREFIX = 'xb:';
/** The one Block User callback that blocks. Produced by the restating confirmation alone. */
export const ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX = 'xc:';
export const ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX = 'xd:';
/** The one rejecting callback. Produced by the confirmation that restates the reason alone. */
export const ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX = 'xe:';
export const ADMIN_REJECT_CANCEL_CALLBACK_PREFIX = 'xf:';
export const ADMIN_REVOKE_CALLBACK_PREFIX = 'G:';

/** Block User's prefixes, as a table so a prefix cannot point at the wrong intent. */
const ADMIN_BLOCK_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_BLOCK_ASK_CALLBACK_PREFIX, 'ADMIN_BLOCK_ASK'],
  [ADMIN_BLOCK_OPEN_CALLBACK_PREFIX, 'ADMIN_BLOCK_OPEN'],
  [ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX, 'ADMIN_BLOCK_CONFIRM'],
  [ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX, 'ADMIN_BLOCK_CANCEL'],
  [ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX, 'ADMIN_REJECT_CONFIRM'],
  [ADMIN_REJECT_CANCEL_CALLBACK_PREFIX, 'ADMIN_REJECT_CANCEL'],
];
/*
 * The services section, Phase 6A. One prefix per action, which is the pattern the
 * CUSTOMER half already uses for its own service actions and the reason the registry
 * above is readable: a prefix means one thing. Each carries one uuid, so `X:` plus a
 * service id is 38 bytes and the pair-carrying codec is not needed.
 */
export const ADMIN_SERVICES_CALLBACK_PREFIX = 'H:';

/**
 * The browsable list, under the services prefix rather than beside it.
 *
 * Every one of the fifty-two letters and all ten digits is already a section prefix,
 * so there is no fifty-third to take — and this does not need one. `H:` is the
 * services section; `H:b` and `H:b:<token>` are a screen INSIDE it, which is what a
 * sub-code is for. The structural rule still holds: no prefix may be a prefix of
 * another, and `H:` is matched by EQUALITY while these two are matched after it, so
 * the queue's own bare tap can never be read as a browse.
 *
 * The token is base-36 digits and hex, so it can contain no colon and the split below
 * is unambiguous. `H:b:` plus a 44-character token is 48 bytes, inside Telegram's
 * 64-byte `callback_data` cap with room to spare.
 */
export const ADMIN_SERVICES_BROWSE_CALLBACK_DATA = `${ADMIN_SERVICES_CALLBACK_PREFIX}b`;
export const ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX = `${ADMIN_SERVICES_BROWSE_CALLBACK_DATA}:`;
export const ADMIN_SERVICE_CALLBACK_PREFIX = 'I:';
export const ADMIN_SERVICE_SYNC_CALLBACK_PREFIX = 'J:';
export const ADMIN_SERVICE_RESEND_CALLBACK_PREFIX = 'K:';
export const ADMIN_SERVICE_RETRY_CALLBACK_PREFIX = 'L:';
export const ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX = 'M:';
export const ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX = 'N:';
export const ADMIN_SERVICE_RESUME_CALLBACK_PREFIX = 'O:';
export const ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 'P:';
/** The one destructive admin callback. Produced by the confirmation screen alone. */
export const ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX = 'Q:';
/*
 * A new subscription link, asked then confirmed. TWO characters, because every single
 * character is taken: `r` then a letter, so the customer's `r:` (resend) begins neither
 * and neither begins it. Asked first because the tap replaces the link the customer is
 * using, and a mis-tap on a phone is not a reason for them to lose it.
 */
export const ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX = 'ra:';
/**
 * The rotating callback. Produced by the confirmation screen alone, and bound to the
 * link that screen was asked about: `rb:<serviceId>.<stamp>`, where the stamp is
 * `rotationStamp` of the service's link at the time of asking. Once a rotation has
 * replaced that link the stamp no longer matches and the old button is refused, so a
 * confirmation is spent by the rotation it confirmed rather than living on in the chat.
 * 3 + 36 + 1 + 12 = 52 bytes, inside Telegram's 64.
 */
export const ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX = 'rb:';

/**
 * A short digest of a subscription link, for binding a confirmation to it.
 *
 * The first twelve hex characters of a SHA-256: enough that two links a rotation
 * produced do not collide by accident, and a one-way function of a high-entropy token,
 * so the chat carries nothing a link can be recovered from. The link itself never
 * reaches an admin message.
 */
export function rotationStamp(subscriptionUrl: string | null): string {
  return createHash('sha256')
    .update(subscriptionUrl ?? '')
    .digest('hex')
    .slice(0, ROTATION_STAMP_LENGTH);
}
const ROTATION_STAMP_LENGTH = 12;
const ROTATION_STAMP_PATTERN = /^[0-9a-f]{12}$/;
/*
 * The panels section, Phase 6B. `R:` and `S:` are the section and one panel; `Y:` is
 * the only one of the eight that carries a CURSOR rather than a uuid, which is why it
 * is decoded at the boundary like `l:` and not run through `callbackCommand`.
 */
export const ADMIN_PANELS_CALLBACK_PREFIX = 'R:';
export const ADMIN_PANEL_DETAIL_CALLBACK_PREFIX = 'S:';
export const ADMIN_PANEL_TEST_CALLBACK_PREFIX = 'T:';
export const ADMIN_PANEL_ENABLE_CALLBACK_PREFIX = 'U:';
export const ADMIN_PANEL_DISABLE_CALLBACK_PREFIX = 'V:';
export const ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX = 'W:';
/** The one archiving callback. Produced by the confirmation screen alone. */
export const ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX = 'X:';
export const ADMIN_PANELS_PAGE_CALLBACK_PREFIX = 'Y:';

/**
 * The reminder settings section.
 *
 * DIGITS, because every one of the fifty-two single letters is already a prefix. The
 * shape is unchanged — one character, a colon, then the payload — and a digit cannot
 * collide with a letter, so the dispatch order below stays unambiguous.
 */
export const ADMIN_REMINDERS_CALLBACK_PREFIX = '0:';
export const ADMIN_REMINDER_EDIT_CALLBACK_PREFIX = '1:';
export const ADMIN_REMINDER_SET_CALLBACK_PREFIX = '2:';

/**
 * The username-policy section's three tap prefixes.
 *
 * Digits, because every letter in both cases is already spoken for by the table above
 * — and a digit can never become a prefix of a lettered one, which is the collision
 * that whole table exists to prevent.
 *
 * `4:` and `5:` carry a code AND a uuid, separated by a colon, which fits inside the
 * 64-byte `callback_data` cap with room to spare (42 bytes at the longest). The code
 * in `4:` is the TARGET value rather than "flip it": a double tap then writes the same
 * value twice instead of toggling twice, which is the difference between an idempotent
 * button and one that undoes itself on a slow connection.
 */
/*
 * The administrator roster's two tap prefixes, WP1. Digits, for the reason the block
 * above gives: every letter is spoken for. `7:` carries a status CODE and a uuid the
 * way `4:` carries a field and one, which is 39 bytes at the longest.
 */
export const ADMIN_ADMIN_CALLBACK_PREFIX = '6:';
export const ADMIN_ADMIN_STATUS_CALLBACK_PREFIX = '7:';

/*
 * The customers section, WP2. The LAST two free prefixes on this surface.
 *
 * Fifty-two letters and eight digits were already spoken for, so these are `8:` and
 * `9:` and there is no `10:` — a two-character prefix would break the one property
 * `intentOf` relies on, that no prefix is a prefix of another. A seventh section will
 * need that registry reorganised rather than extended, and this comment is where the
 * next author finds that out before designing around a prefix that does not exist.
 *
 * So the two carry more than one meaning each, and both are disambiguated at the
 * boundary rather than downstream:
 *
 * - `8:` alone is the section; `8:<token>` is a page of it. One meaning — "show me a
 *   page of customers" — with the payload deciding which page, so there is no reading
 *   of this prefix that acts on anybody.
 * - `9:<code>:<uuid>` is one customer, where the code says which of the three things to
 *   do with them. A TABLE maps code to intent, for the reason `ADMIN_SERVICE_CALLBACKS`
 *   gives: three near-identical `if`s is three chances to point a code at the wrong
 *   intent, and the one that matters is the code that BLOCKS. 39 bytes at the longest,
 *   the same shape `7:` uses for an administrator's status.
 */
export const ADMIN_CUSTOMERS_CALLBACK_PREFIX = '8:';
export const ADMIN_CUSTOMER_CALLBACK_PREFIX = '9:';

/**
 * What a `9:` code means, as a table rather than a chain of comparisons.
 *
 * `v` reads. `b` ASKS to block and `u` ASKS to unblock (WP10G — neither writes). `o` opens the
 * block's reason capture for a customer, `c` confirms a block from a CAPTURE and `x` cancels it;
 * `n` confirms an unblock. `b`, `u`, `o` and `n` carry a customer id; `c` and `x` a capture id.
 * Validated at the boundary against this map, so an unknown code is UNSUPPORTED and never
 * becomes an intent — the same treatment the reminder codes, the username toggles and the
 * administrator statuses get. 40 bytes at the longest.
 */
const ADMIN_CUSTOMER_CODES = {
  v: 'ADMIN_CUSTOMER',
  b: 'ADMIN_CUSTOMER_BLOCK',
  u: 'ADMIN_CUSTOMER_UNBLOCK',
  o: 'ADMIN_CUSTOMER_BLOCK_OPEN',
  c: 'ADMIN_CUSTOMER_BLOCK_CONFIRM',
  x: 'ADMIN_CUSTOMER_BLOCK_CANCEL',
  n: 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM',
} as const;
type AdminCustomerCode = keyof typeof ADMIN_CUSTOMER_CODES;

function isAdminCustomerCode(value: string): value is AdminCustomerCode {
  return Object.hasOwn(ADMIN_CUSTOMER_CODES, value);
}

export const ADMIN_USERNAME_CALLBACK_PREFIX = '3:';

/*
 * The categories section, WP5 — and the first ADMIN section with two-character prefixes.
 *
 * The comment on `ADMIN_CUSTOMERS_CALLBACK_PREFIX` says a seventh section would need the
 * registry reorganised, because `10:` would break the rule that no prefix begins another.
 * The customer catalogue found the way out: a LETTER then a letter then a colon. `k:` is
 * `k` then a colon and these are `k` then a letter, so neither begins the other — which
 * `bot-runtime.test.ts` checks over every exported prefix rather than trusting.
 *
 * - `ka:<page>` is one page of the operator's category list. A PAGE, not a keyset cursor,
 *   for the reason §6.4 of the WP5 audit gives about the customer list: `sort_order` is
 *   operator-mutable, so a cursor on it is not a stable position.
 * - `kb:<code>:<uuid>` is one category and what to do with it; the code is looked up in
 *   `ADMIN_CATEGORY_CODES`, so an unknown one is UNSUPPORTED. 41 bytes at the longest.
 * - `kc:` is the product list for reassignment, and `kc:<token>` a later page of it —
 *   products ARE keyset-paged, by the immutable `(created_at, id)`.
 * - `kd:<product uuid>.<page>` is the destination picker for one product. 43 bytes.
 * - `ke:<pair>` moves a product: `encodeIdPair(product, category)`, 46 bytes.
 */
export const ADMIN_CATEGORIES_CALLBACK_PREFIX = 'ka:';
export const ADMIN_CATEGORY_CALLBACK_PREFIX = 'kb:';
export const ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX = 'kc:';
export const ADMIN_CATEGORY_PICK_CALLBACK_PREFIX = 'kd:';
export const ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX = 'ke:';

/** How many categories one page of the operator list — and of the picker — shows. */
const ADMIN_CATEGORY_PAGE_SIZE = 8;

/**
 * What a `kb:` code means. A table, for the reason `ADMIN_CUSTOMER_CODES` is one: the row
 * that matters is the LAST, where a transposition would make the asking tap the deleting
 * one. Lower-case `x` asks; upper-case `X` deletes, and only the ask screen draws it.
 */
const ADMIN_CATEGORY_CODES = {
  v: 'ADMIN_CATEGORY',
  a: 'ADMIN_CATEGORY_ACTIVATE',
  d: 'ADMIN_CATEGORY_DEACTIVATE',
  s: 'ADMIN_CATEGORY_SHOW',
  h: 'ADMIN_CATEGORY_HIDE',
  u: 'ADMIN_CATEGORY_UP',
  w: 'ADMIN_CATEGORY_DOWN',
  x: 'ADMIN_CATEGORY_DELETE_ASK',
  X: 'ADMIN_CATEGORY_DELETE',
} as const satisfies Record<string, BotIntent>;
type AdminCategoryCode = keyof typeof ADMIN_CATEGORY_CODES;

function isAdminCategoryCode(value: string): value is AdminCategoryCode {
  return Object.hasOwn(ADMIN_CATEGORY_CODES, value);
}
export const ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX = '4:';
export const ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX = '5:';

/**
 * The two statuses a roster tap can set, and the letter each travels as.
 *
 * There is no third letter because there is no third status: `audit_logs` references
 * administrators and refuses DELETE, so `DISABLED` is this product's answer to
 * removing one and a deletion button would have nothing behind it.
 */
const ADMIN_STATUS_CODES = { a: 'ACTIVE', d: 'DISABLED' } as const;
type AdminStatusCode = keyof typeof ADMIN_STATUS_CODES;
function isAdminStatusCode(value: string): value is AdminStatusCode {
  return Object.prototype.hasOwnProperty.call(ADMIN_STATUS_CODES, value);
}

/** Which of the two customer choices a `4:` tap is setting. */
const USERNAME_TOGGLE_FIELDS = { c: 'allowCustom', a: 'allowAutomatic' } as const;
type UsernameToggleField = keyof typeof USERNAME_TOGGLE_FIELDS;
function isUsernameToggleField(value: string): value is UsernameToggleField {
  return Object.prototype.hasOwnProperty.call(USERNAME_TOGGLE_FIELDS, value);
}

/**
 * The three presets a TAP can select, and the letter each travels as.
 *
 * `CUSTOM_TEMPLATE` is deliberately absent. The other three either take no
 * configuration or have a default prefix, so a tap is a complete instruction; a
 * template does not exist until somebody writes one, and the message that writes it —
 * `/panel_template` — is what selects the preset. A button that selected
 * `CUSTOM_TEMPLATE` with nothing behind it could only ever be refused.
 */
const USERNAME_STRATEGY_CODES = {
  r: 'RANDOM',
  p: 'PREFIX_RANDOM',
  t: 'TELEGRAM_ID_RANDOM',
} as const;
type UsernameStrategyCode = keyof typeof USERNAME_STRATEGY_CODES;
function isUsernameStrategyCode(value: string): value is UsernameStrategyCode {
  return Object.prototype.hasOwnProperty.call(USERNAME_STRATEGY_CODES, value);
}
const USERNAME_STRATEGY_BUTTONS: readonly (readonly [UsernameStrategyCode, TemplateKey])[] = [
  ['r', 'bot.admin.username_strategy_random'],
  ['p', 'bot.admin.username_strategy_prefix_random'],
  ['t', 'bot.admin.username_strategy_telegram_id_random'],
];

/**
 * The five editable thresholds, as the two-letter codes the callback data carries.
 *
 * A closed map rather than the registry key itself, because `callback_data` is capped
 * at 64 bytes and `reminders.usage_second_percent` is half of it before a value is
 * appended. It is also the VALIDATION: a code that is not in this map is refused at the
 * boundary, so no client-supplied string ever reaches the settings service as a key.
 */
export const REMINDER_SETTING_CODES = {
  ef: 'reminders.expiry_first_days',
  es: 'reminders.expiry_second_days',
  uf: 'reminders.usage_first_percent',
  us: 'reminders.usage_second_percent',
  un: 'reminders.usage_final_percent',
} as const satisfies Record<string, SettingKey>;
export type ReminderSettingCode = keyof typeof REMINDER_SETTING_CODES;

/** The button label for each code's chooser. One template per setting, so each names itself. */
const REMINDER_SETTING_BUTTONS = {
  ef: 'bot.admin.reminder_expiry_first_button',
  es: 'bot.admin.reminder_expiry_second_button',
  uf: 'bot.admin.reminder_usage_first_button',
  us: 'bot.admin.reminder_usage_second_button',
  un: 'bot.admin.reminder_usage_final_button',
} as const satisfies Record<ReminderSettingCode, TemplateKey>;

/**
 * The values a tap may choose, per family.
 *
 * A SMALL MENU OF SCALARS, which is CBR-011's shape (B) and the one Mirza uses for the
 * settings that are not free text. Every entry is inside the contract's own bounds, so
 * a tap cannot propose a value the schema would reject — the schema still checks, and
 * the combination guard still checks, but an operator never meets a refusal they could
 * not have avoided.
 */
const REMINDER_DAY_OPTIONS = [1, 2, 3, 5, 7, 10, 14, 30] as const;
const REMINDER_PERCENT_OPTIONS = [50, 60, 70, 75, 80, 85, 90, 95, 100] as const;

function reminderOptionsFor(code: ReminderSettingCode): readonly number[] {
  return code === 'ef' || code === 'es' ? REMINDER_DAY_OPTIONS : REMINDER_PERCENT_OPTIONS;
}

/** The order the section draws its five buttons in: expiry first, then usage. */
const REMINDER_SETTING_CODE_ORDER = [
  'ef',
  'es',
  'uf',
  'us',
  'un',
] as const satisfies readonly ReminderSettingCode[];

/** The value a code currently names, so the chooser can print it before replacing it. */
function reminderValueOf(config: ServiceReminderThresholds, code: ReminderSettingCode): number {
  switch (code) {
    case 'ef':
      return config.expiryFirstDays;
    case 'es':
      return config.expirySecondDays;
    case 'uf':
      return config.usageFirstPercent;
    case 'us':
      return config.usageSecondPercent;
    case 'un':
      return config.usageFinalPercent;
  }
}

/**
 * A switch, as the section prints it.
 *
 * A SYMBOL and not a word, and that is the whole reason this compiles: `check:i18n`
 * refuses hard-coded customer-facing strings in a surface, and «روشن»/«خاموش» here was
 * exactly that — a translatable sentence fragment living outside the catalogue. An
 * earlier revision of this function had them with a comment explaining why it was
 * acceptable; the comment was wrong and the check said so.
 *
 * The pair is also the vocabulary an operator already reads: Mirza's capability list
 * marks every toggle ✅ or ❌ (CBR-009), so this says the same thing the same way.
 */
function onOff(enabled: boolean): string {
  return enabled ? '\u2705' : '\u274c';
}

/** Unknown codes fail closed, which is what makes the map above a boundary check. */
function isReminderSettingCode(value: string): value is ReminderSettingCode {
  return Object.prototype.hasOwnProperty.call(REMINDER_SETTING_CODES, value);
}

/**
 * Each services-section prefix and the intent it parses to, in ONE place.
 *
 * Read by the boundary and by nothing else. Written as a table so the prefix and the
 * intent are chosen together: nine separate branches would be nine chances to point one
 * at the wrong intent, and the row that would matter is the last, where a mis-wiring
 * would turn the asking callback into the destructive one.
 */
/**
 * The operation each acting intent plans, and the button that offers it.
 *
 * `ADMIN_SERVICE_RESEND` and `ADMIN_SERVICE_RETRY` are absent from the operation map on
 * purpose: a resend plans none, and a retry goes through `retryProvisioning`, which has
 * its own refusal for the case that matters — an UNRECONCILED service is reconciled
 * rather than given a second provider account.
 */
const ADMIN_SERVICE_OPERATIONS: Readonly<Partial<Record<BotIntent, OperatorServiceOperation>>> = {
  ADMIN_SERVICE_SYNC: 'SYNC_USAGE',
  ADMIN_SERVICE_RECONCILE: 'RECONCILE',
  ADMIN_SERVICE_SUSPEND: 'SUSPEND',
  ADMIN_SERVICE_RESUME: 'RESUME',
  ADMIN_SERVICE_TERMINATE: 'TERMINATE',
  ADMIN_SERVICE_ROTATE: 'ROTATE_SUBSCRIPTION',
};

/**
 * Each action's button: which verdict offers it, which permission allows it, and where
 * it points.
 *
 * TERMINATE points at the ASKING prefix. That is the row this table exists to make
 * visible, because a destructive callback drawn on a detail screen is a one-tap
 * deletion, and the difference between the two prefixes is one letter.
 */
const ADMIN_SERVICE_BUTTONS: readonly {
  readonly action: ServiceOperatorAction;
  readonly key: TemplateKey;
  readonly prefix: string;
  readonly permission: PermissionKey;
}[] = [
  {
    action: 'SYNC_USAGE',
    key: 'bot.admin.service_sync_button',
    prefix: ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESEND_CONFIG',
    key: 'bot.admin.service_resend_button',
    prefix: ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RETRY_PROVISION',
    key: 'bot.admin.service_retry_button',
    prefix: ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RECONCILE',
    key: 'bot.admin.service_reconcile_button',
    prefix: ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'SUSPEND',
    key: 'bot.admin.service_suspend_button',
    prefix: ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESUME',
    key: 'bot.admin.service_resume_button',
    prefix: ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'TERMINATE',
    key: 'bot.admin.service_terminate_button',
    prefix: ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
    permission: SERVICES_TERMINATE_PERMISSION,
  },
  // The ASKING prefix, for the reason TERMINATE's row gives.
  {
    action: 'ROTATE_LINK',
    key: 'bot.admin.service_rotate_link_button',
    prefix: ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
];

/** What one ask-then-act screen needs: the verdict it re-reads and where it points. */
interface AdminServiceAsk {
  readonly action: ServiceOperatorAction;
  readonly permission: PermissionKey;
  readonly key: TemplateKey;
  readonly confirmKey: TemplateKey;
  /** The confirming callback for this service, as the confirmation screen draws it. */
  readonly confirmData: (service: {
    readonly id: string;
    readonly subscriptionUrl: string | null;
  }) => string;
}

const ADMIN_SERVICE_TERMINATE_ASK: AdminServiceAsk = {
  action: 'TERMINATE',
  permission: SERVICES_TERMINATE_PERMISSION,
  key: 'bot.admin.service_terminate_ask',
  confirmKey: 'bot.admin.service_terminate_confirm_button',
  confirmData: (service) => `${ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX}${service.id}`,
};

const ADMIN_SERVICE_ROTATE_ASK: AdminServiceAsk = {
  action: 'ROTATE_LINK',
  permission: SERVICES_EDIT_PERMISSION,
  key: 'bot.admin.service_rotate_link_ask',
  confirmKey: 'bot.admin.service_rotate_link_confirm_button',
  confirmData: (service) =>
    `${ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX}${service.id}.${rotationStamp(service.subscriptionUrl)}`,
};

/**
 * The buttons one service's detail draws, for one administrator.
 *
 * TWO conditions, and both are necessary. The VERDICT says the service allows the action
 * right now — the state, the provider's capabilities, the panel's configuration, and
 * whether one of that type is already open — and comes from the same evaluator the write
 * paths agree with. The PERMISSION says this administrator may ask for it. Drawing a
 * button that fails either is drawing a control whose every press records a denial,
 * which is the noise the alerts page exists to keep clear.
 *
 * Neither is authorization. Every action re-checks its permission and all its conditions
 * inside its own request; `docs/conventions.md` names the rule this must not be read as
 * satisfying — never by not drawing a button.
 */
function adminServiceButtons(
  serviceId: string,
  actions: readonly ServiceActionAvailability[],
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  const available = new Set(
    actions.filter((entry) => entry.available).map((entry) => entry.action),
  );
  return ADMIN_SERVICE_BUTTONS.filter(
    (button) => available.has(button.action) && permissions.has(button.permission),
  ).map((button) => ({
    label: { kind: 'TEMPLATE' as const, key: button.key },
    data: `${button.prefix}${serviceId}`,
  }));
}

/**
 * What a customer's row says, in the order an operator recognises them.
 *
 * `@username` when there is one, else the name Telegram reported, else the numeric id.
 * A customer may have none of the first two, so the id is the fallback rather than a
 * dash: a row reading `— ACTIVE` names nobody, and a keyboard of them is unusable.
 *
 * The numeric id is NOT withheld here the way an administrator's is. The reason that
 * roster withholds it is that a forwardable message naming where an administrator signs
 * in from is most of the way to finding them; a customer's Telegram id is the handle the
 * support conversation already quoted, it is on the Web Admin list, and this surface
 * exists so an operator can act on it from a phone.
 *
 * The status rides along, because the one thing an operator scanning this list is
 * looking for is who is blocked.
 */
/**
 * How many rows the name lookup reads before deciding the name is not unique.
 *
 * Small on purpose. The question the probe answers is "is this name unique HERE", not
 * "how many services carry it": one extra row settles it, and the rest of the bound is
 * headroom so the disambiguation screen can actually list what it found rather than
 * saying "more than one" and stopping. A name on more matches than this is not a
 * support lookup any more, and the browse list is where that conversation belongs.
 */
const AMBIGUOUS_MATCH_PROBE = 5;

/**
 * What the name lookup found, as four cases rather than a nullable row.
 *
 * `NONE` and `SYNTAX` are different sentences — "no such service" and "that is not a
 * service name" — and `MANY` is the one the Codex review of this branch added: a name
 * unique per PANEL is not unique per tenant, so answering with one arbitrary row is how
 * a terminate lands on the wrong customer's account.
 */
type AdminServiceLookup =
  | { readonly kind: 'SYNTAX' }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MANY'; readonly matches: readonly ServiceRecord[] }
  | { readonly kind: 'ONE'; readonly found: Awaited<ReturnType<ServiceAdminService['detail']>> };

/**
 * One ambiguous match, labelled by what tells it apart from the others.
 *
 * NOT the username: every match carries the same one, which is why this screen exists.
 * NOT the panel's name either, however useful that would be — reading a panel charges
 * `panels.view`, and an administrator holding `services.view` alone would get a denial
 * per match rather than a list.
 *
 * So: the lifecycle state and the day the service was created, both off the row already
 * in hand. Neither is a credential, and between them they separate "the one I sold last
 * week" from "the one that has been terminated since spring". The detail behind the
 * button is what confirms it, because that names the panel and the customer.
 */
function adminServiceMatchLabel(service: ServiceRecord): string {
  return `${service.state} — ${service.createdAt.toISOString().slice(0, 10)}`;
}

function adminCustomerLabel(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  const who =
    customer.username !== null
      ? `@${customer.username}`
      : name !== ''
        ? name
        : customer.telegramUserId;
  return `${who} — ${customer.status}`;
}

/**
 * The detail screen for one customer, shared by the read, the lookup and the write.
 *
 * ONE builder, so the buttons an operator sees after a change are the buttons the new
 * state actually offers — a second copy is how a block leaves a "block" button on the
 * screen, which is the defect `adminAdminReply` was written to avoid and the same one
 * applies here.
 *
 * The status button offered is the OPPOSITE of the status held, and neither is drawn
 * without `users.block`. That is a courtesy: `CustomerService.setStatus` charges the key
 * through the guard and re-checks it inside the writing transaction, so a crafted `9:b:`
 * callback from an administrator who lacks it is refused there and leaves the record.
 *
 * What this screen carries is a person and nothing they bought. No wallet balance, no
 * order, no service, no subscription reference: each is a different permission, and a
 * Telegram message is forwardable — which is the argument ADR-0023 makes about panel
 * credentials and `services.tsx` makes about subscription URLs.
 */
function adminCustomerReply(
  customer: CustomerRecord,
  permissions: ReadonlySet<PermissionKey>,
): PendingReply {
  const buttons: CustomerButton[] = [];
  if (permissions.has(CUSTOMERS_BLOCK_PERMISSION)) {
    const blocked = customer.status === 'BLOCKED';
    buttons.push({
      label: {
        kind: 'TEMPLATE',
        key: blocked ? 'bot.admin.customer_unblock_button' : 'bot.admin.customer_block_button',
      },
      /*
       * The TARGET status, not "flip it".
       *
       * A double tap then writes the same status twice — which `setStatus`'s conditional
       * UPDATE answers as a successful no-op — instead of toggling twice, which is the
       * difference between an idempotent button and one that undoes itself on a slow
       * connection. The same reasoning `4:` and `7:` record.
       */
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}${blocked ? 'u' : 'b'}:${customer.id}`,
    });
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.customers_back_button' },
    data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  });
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  return {
    key: 'bot.admin.customer_detail',
    values: {
      telegramId: customer.telegramUserId,
      username: customer.username === null ? '—' : `@${customer.username}`,
      name: name === '' ? '—' : name,
      status: customer.status,
      /*
       * The operator note, or a dash — never a stale one.
       *
       * `setStatus` clears it on an unblock precisely so a reason cannot outlive the
       * block it explains, and this renders whatever it finds rather than deciding by
       * status: two places deciding when a reason is current is how they disagree.
       */
      reason: customer.blockedReason ?? '—',
      firstSeen: customer.firstSeenAt,
      lastSeen: customer.lastSeenAt,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Whether a refusal is about the SERVICE rather than about the administrator.
 *
 * The four service refusals are things a person can act on — the state moved, the
 * provider cannot do it, the panel needs fixing, one of that type is already under way —
 * and they earn the sentence that says so. Everything else, a permission denial above
 * all, falls through to the panel's single refusal, which tells whoever holds that chat
 * nothing about what exists.
 */
function isServiceRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED ||
    code === COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE ||
    code === COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED ||
    code === COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE ||
    code === COMMERCE_ERROR_CODES.ORDER_STATE_INVALID
  );
}

/**
 * Whether a refusal means "no such customer" rather than "not you".
 *
 * The section's read paths catch NARROWLY, on these two codes alone, and rethrow
 * everything else — and that distinction is the whole point rather than tidiness. A
 * catch-all was the first version, and it answered an administrator who lacks
 * `users.view` with `bot.admin.customer_gone`: a sentence saying the person does not
 * exist, to somebody who was only refused permission to look. An operator acts on that
 * — they tell the customer there is no account — and the fact they were actually told
 * is about THEMSELVES, not about anybody's data, so there is nothing to protect by
 * blurring it.
 *
 * A denial therefore falls through to `adminTurn`'s single refusal, which is what every
 * other denial on this surface answers with, and `customer_gone` stays the one answer
 * for the four cases that genuinely mean "not here": unknown, malformed, another
 * tenant's, and a lookup that matched nobody.
 *
 * `COMMERCE_REQUEST_INVALID` is in the pair because `CustomerService.customerId`
 * raises it for an id that is not a UUIDv7 — which the callback boundary has already
 * refused, so it is reachable only from a typed command, and is still "no such
 * customer" from where an operator sits.
 */
function isCustomerMiss(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND ||
    code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID
  );
}

/**
 * The categories section's three fixed answers.
 *
 * `CATEGORY_GONE` and `PRODUCT_GONE` are the section's one answer for an id that is
 * unknown or another tenant's — the rule `bot.admin.panel_gone` states — and
 * `CATEGORY_USAGE` repeats the syntax of the three commands rather than opening a prompt
 * for what was missing.
 */
const CATEGORY_GONE: PendingReply = {
  key: 'bot.admin.category_gone',
  values: {},
  buttons: [],
  orderId: null,
};
const PRODUCT_GONE: PendingReply = {
  key: 'bot.admin.product_gone',
  values: {},
  buttons: [],
  orderId: null,
};
const CATEGORY_USAGE: PendingReply = {
  key: 'bot.admin.category_usage',
  values: {},
  buttons: [],
  orderId: null,
};

/**
 * Whether a refusal means "no such category" rather than "not you".
 *
 * NARROW, for the reason `isCustomerMiss` gives: a permission denial answered as
 * `category_gone` tells an operator the category does not exist when they were only
 * refused, and they act on it. `COMMERCE_REQUEST_INVALID` is deliberately NOT here —
 * the service also raises it for a name or emoji it will not store, and for a transition
 * that lost a race, neither of which means the category is gone. Every id that reaches
 * the service from a button has passed `uuidV7Schema` at the boundary already.
 */
function isCategoryMiss(error: unknown): boolean {
  return isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND;
}

/** As `isCategoryMiss`, for the product a reassignment names. */
function isProductMiss(error: unknown): boolean {
  return isNexaError(error) && error.code === COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND;
}

/**
 * A category as one button: its emoji and name, then the two flags that decide what a
 * customer sees, then how many products are filed under it.
 *
 * The flags are the frozen vocabulary rather than words, the way a customer's status is
 * on `adminCustomerLabel` — they are what the detail screen and the Web Admin show, so an
 * operator reads the same token in all three places.
 */
function adminCategoryLabel(category: ProductCategoryListing): string {
  const name = category.emoji === null ? category.name : `${category.emoji} ${category.name}`;
  return `${name} · ${category.status} · ${category.visibility} · ${category.productCount}`;
}

/**
 * The detail screen for one category, shared by the read and by every write.
 *
 * ONE builder, the rule `adminCustomerReply` states: the buttons an operator sees after a
 * change are the ones the new state offers. Each flag button carries the TARGET state —
 * the opposite of what the category holds — and up and down are drawn only where the
 * category can move. None of the write buttons is drawn without `catalog.edit`, and the
 * service charges it again whatever is drawn.
 */
function adminCategoryReply(
  category: ProductCategoryListing,
  index: number,
  count: number,
  mayEdit: boolean,
): PendingReply {
  const buttons: CustomerButton[] = [];
  const act = (code: AdminCategoryCode, key: TemplateKey): CustomerButton => ({
    label: { kind: 'TEMPLATE', key },
    data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}${code}:${category.id}`,
  });
  if (mayEdit) {
    buttons.push(
      category.status === 'ACTIVE'
        ? act('d', 'bot.admin.category_deactivate_button')
        : act('a', 'bot.admin.category_activate_button'),
      category.visibility === 'VISIBLE'
        ? act('h', 'bot.admin.category_hide_button')
        : act('s', 'bot.admin.category_show_button'),
    );
    if (index > 0) buttons.push(act('u', 'bot.admin.category_up_button'));
    if (index < count - 1) buttons.push(act('w', 'bot.admin.category_down_button'));
    buttons.push(act('x', 'bot.admin.category_delete_button'));
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
    data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${Math.floor(index / ADMIN_CATEGORY_PAGE_SIZE)}`,
  });
  return {
    key: 'bot.admin.category_detail',
    values: {
      id: category.id,
      name: category.name,
      emoji: category.emoji ?? '—',
      status: category.status,
      visibility: category.visibility,
      products: category.productCount,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Whether a refusal is about the PANEL rather than about the administrator.
 *
 * `PANEL_NOT_VALIDATED` earns its own answer, because it is the one refusal on this
 * screen an administrator can resolve without leaving it: the Test button is right
 * there. The rest — a status that moved, credentials that do not satisfy the
 * provider's shape, a spent probe budget, a lost race — are one sentence pointing at
 * the Web Admin, for the reason `isServiceRefusal` gives. A permission denial is in
 * neither set and falls through to the panel's single refusal, which tells whoever
 * holds that chat nothing about what exists.
 */
function isPanelRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === PANEL_ERROR_CODES.PANEL_ARCHIVED ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIALS_MISSING ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIAL_UNSUPPORTED ||
    code === PANEL_ERROR_CODES.PANEL_PROBE_LIMITED ||
    code === PANEL_ERROR_CODES.PANEL_CONFIGURATION_CHANGED ||
    code === PANEL_ERROR_CODES.PANEL_NAME_TAKEN
  );
}

const ADMIN_PANEL_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_PANEL_DETAIL_CALLBACK_PREFIX, 'ADMIN_PANEL_DETAIL'],
  [ADMIN_PANEL_TEST_CALLBACK_PREFIX, 'ADMIN_PANEL_TEST'],
  [ADMIN_PANEL_ENABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_ENABLE'],
  [ADMIN_PANEL_DISABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_DISABLE'],
  [ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE_ASK'],
  /*
   * LAST, and the row that makes this a table rather than seven `if`s: a mis-wiring
   * here would make the ASKING callback the one that archives, which is the same
   * one-character mistake `ADMIN_SERVICE_CALLBACKS` names in its own comment.
   */
  [ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE'],
  [ADMIN_USERNAME_CALLBACK_PREFIX, 'ADMIN_USERNAME'],
];

const ADMIN_SERVICE_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_SERVICE_CALLBACK_PREFIX, 'ADMIN_SERVICE'],
  [ADMIN_SERVICE_SYNC_CALLBACK_PREFIX, 'ADMIN_SERVICE_SYNC'],
  [ADMIN_SERVICE_RESEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESEND'],
  [ADMIN_SERVICE_RETRY_CALLBACK_PREFIX, 'ADMIN_SERVICE_RETRY'],
  [ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX, 'ADMIN_SERVICE_RECONCILE'],
  [ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_SUSPEND'],
  [ADMIN_SERVICE_RESUME_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESUME'],
  [ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE_ASK'],
  [ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE'],
  [ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX, 'ADMIN_SERVICE_ROTATE_ASK'],
  // `rb:` is not here: it carries a stamp as well as an id, so it is decoded before this
  // table is consulted — see `adminServiceRotateCommand`.
];

/**
 * The rotating callback, or null when `data` is not one.
 *
 * Validated here and nowhere later: the id as a UUIDv7, the stamp as twelve hex
 * characters. Anything else is UNSUPPORTED, including the bare `rb:<id>` an older
 * keyboard would have carried — a confirmation with no stamp confirms nothing.
 */
function adminServiceRotateCommand(data: string, id: string | null): BotCommand | null {
  if (!data.startsWith(ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX)) return null;
  const unsupported: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  const [rawId, stamp, ...rest] = data
    .slice(ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX.length)
    .split('.');
  const service = uuidV7Schema.safeParse(rawId);
  if (rest.length > 0 || stamp === undefined || !ROTATION_STAMP_PATTERN.test(stamp)) {
    return unsupported;
  }
  if (!service.success) return unsupported;
  return {
    intent: 'ADMIN_SERVICE_ROTATE',
    targetId: service.data,
    args: [stamp],
    callbackQueryId: id,
  };
}

/**
 * How many products one `/catalog` answer shows.
 *
 * A BOUND, not a page. `listCatalog` reports `hasMore` and this surface drops it on the
 * floor, so a tenant with more than twenty sellable products shows twenty and says
 * nothing about the rest. That is a real limit and it is stated here rather than left to
 * be discovered: how a customer reaches a long catalogue over Telegram — a next button,
 * categories, a search — is a product decision with no evidence behind it in
 * `docs/research/`, and `docs/open-questions.md` carries it rather than this file
 * guessing. Twenty is above any catalogue the research shows.
 */
export const CATALOG_PAGE_SIZE = 20;

/**
 * How many rows one page of the CATEGORISED catalogue shows, at either level.
 *
 * A page, not a bound — unlike `CATALOG_PAGE_SIZE` above, which this browse replaces for
 * customers. Eight because a Telegram inline keyboard is read on a phone: eight rows plus
 * a navigation row fits one screen, and a page the customer has to scroll to find the
 * Next button on is a page they give up on.
 */
export const CATALOG_BROWSE_PAGE_SIZE = 8;

/**
 * The highest page number a catalogue callback may name.
 *
 * A bound on what a MODIFIED client can ask the database to OFFSET past, not a limit on
 * a real catalogue: a thousand pages of eight is eight thousand categories. A value
 * above it is UNSUPPORTED at the boundary.
 */
export const CATALOG_BROWSE_MAX_PAGE = 999;

/**
 * The two catalogue callbacks. TWO characters, because every single character is taken.
 *
 * `cg:<page>` is a page of the category list; `ck:<categoryId>.<page>` is a page of one
 * category's products. Neither is shadowed by the single-letter `c:` (confirm): that
 * prefix is `c` then `:`, and these are `c` then a letter. The registry test in
 * `bot-runtime.test.ts` asserts it over every prefix this runtime knows.
 *
 * A category button carries the category's ID, and a product button its product's ID —
 * never a position in a list. §6.4: a stale callback must fail or recover truthfully and
 * never silently select a different product, and an index into a list that has since
 * been reordered is exactly how that happens.
 */
export const CATALOG_PAGE_CALLBACK_PREFIX = 'cg:';
export const CATEGORY_CALLBACK_PREFIX = 'ck:';
/**
 * The catalogue's trial button (WP6-A). The WHOLE data, not a prefix: it carries no
 * id and no figure, because nothing about a trial is the client's to say. Two letters
 * because every single-letter prefix is taken; `t:` is terminate's, and `tr:` does not
 * start with it.
 *
 * F5: the catalogue no longer draws it — a trial is its own main-menu action, not a step
 * of buying. It is still PARSED, so a catalogue message drawn before F5 and still sitting
 * in a chat answers its tap exactly as the menu's button does (the claim decides).
 */
export const TRIAL_CALLBACK_DATA = 'tr:';
/**
 * R1: one panel on the trial choice — the panel's id, validated at the boundary. `tp:` is
 * the top-up route's, so `tq:`; neither starts with the single-letter `t:`.
 */
export const TRIAL_PANEL_CALLBACK_PREFIX = 'tq:';
/**
 * Package D. The catalogue's custom-service button (the whole data: it carries nothing),
 * and a location's button (the panel's id). Two letters each, parsed before the one-letter
 * prefixes: `c:` is confirm's, and neither `cu:` nor `cv:` starts with it.
 */
export const CUSTOM_SERVICE_CALLBACK_DATA = 'cu:';
export const CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX = 'cv:';

/**
 * A page number out of callback data, or null.
 *
 * Digits only — no sign, no exponent, no leading zeros beyond a lone `0` — so `Number`'s
 * leniency (`' 1'`, `'1e2'`, `'0x10'`) cannot turn a crafted string into a page.
 */
export function parseCatalogPage(raw: string): number | null {
  if (!/^(0|[1-9][0-9]{0,3})$/.test(raw)) return null;
  const page = Number(raw);
  return page <= CATALOG_BROWSE_MAX_PAGE ? page : null;
}

/**
 * Reads the intent out of an update.
 *
 * Reads through passthrough fields rather than a modelled `message` shape, exactly as
 * `isPingCommand` already does: `telegramUpdateSchema` states what this installation
 * depends on and the rest of an update stays unmodelled on purpose. Anything unexpected
 * is `UNSUPPORTED`, which is a real answer and not an error.
 *
 * The command is matched on the FIRST token only, so `/start payload` is still `/start` —
 * Telegram's deep links put a payload there and 4F's referral codes arrive that way.
 * The payload itself is deliberately NOT returned here: nothing in 4A consumes it, and a
 * field nothing consumes is a field that gets logged.
 */
/**
 * What a tap on the persistent main menu sends, and the command it means.
 *
 * Telegram delivers a `ReplyKeyboardMarkup` tap as an ORDINARY TEXT MESSAGE whose body
 * is the button's label. There is no `callback_data`, no signature and no id — which is
 * why the menu carries no authority and every contextual action stays on the callback
 * architecture with its validated identifier and its ownership check.
 *
 * PASSED IN rather than read here, because a surface may not reach the catalogue: the
 * boundary check refuses `@nexa/i18n` in `surfaces/`, and its reason is this exact
 * shape — a surface that renders text itself is a second renderer beside the template
 * resolver. The composition root builds this map from the same catalogue the messenger
 * draws the keyboard from, so the string that is drawn and the string that is matched
 * come from one place and cannot disagree.
 *
 * Matched on the EXACT string. No case folding and no fuzzy match: an unknown text is
 * `UNSUPPORTED` exactly as it was before this existed.
 */
export type MainMenuRoutes = ReadonlyMap<string, string>;

/** No menu configured. The slash commands still answer; nothing else changes. */
const NO_MENU: MainMenuRoutes = new Map();

/**
 * The payload of a `/start`, or null when this update is not one or carries none.
 *
 * Read ONLY for the referral program, which reads it only on the update that creates the
 * customer (WP9 F2); `intentOf` still drops it, so nothing else can grow a dependency on
 * it. Bounded to Telegram's own limit — a start parameter is at most 64 characters of
 * `[A-Za-z0-9_-]` — so a hand-crafted message cannot carry anything larger or stranger
 * into a service.
 */
export function startPayloadOf(update: unknown): string | null {
  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return null;
  const match = /^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(text);
  return match?.[1] ?? null;
}

/**
 * The update's Telegram `update_id`, which increases per bot (WP19). A refund-request prompt
 * reads only messages newer than the tap that opened it, so a redelivered older message can
 * never become its amount or reason. Undefined when absent or not a non-negative integer.
 */
export function updateIdOf(update: unknown): bigint | undefined {
  const raw = (update as { update_id?: unknown } | null)?.update_id;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : undefined;
}

export function intentOf(update: unknown, menu: MainMenuRoutes = NO_MENU): BotCommand {
  const callback = (update as { callback_query?: { id?: unknown; data?: unknown } } | null)
    ?.callback_query;
  if (callback !== undefined && callback !== null) {
    const id = typeof callback.id === 'string' ? callback.id : null;
    const data = typeof callback.data === 'string' ? callback.data : '';
    /*
     * Validated here, not cast.
     *
     * `callback_data` is whatever the client sent. Telegram signs nothing about it, so a
     * modified client can put any string after the prefix — and the two services below
     * take an id. A malformed one is UNSUPPORTED, which answers the customer, rather
     * than a 500 at the `uuid` cast or a refusal that names the column.
     */
    /*
     * The two catalogue callbacks, before every single-letter prefix.
     *
     * Order does not matter today — no single-letter prefix is a prefix of `cg:` or
     * `ck:` — and they are placed first anyway, because if one ever were, the failure
     * would be silent: a tap routed to confirm an order instead of turning a page.
     */
    if (data === TRIAL_CALLBACK_DATA) {
      return { intent: 'TRIAL_CLAIM', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TRIAL_PANEL_CALLBACK_PREFIX)) {
      const panel = uuidV7Schema.safeParse(data.slice(TRIAL_PANEL_CALLBACK_PREFIX.length));
      if (!panel.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TRIAL_PANEL', targetId: panel.data, callbackQueryId: id };
    }
    if (data === CUSTOM_SERVICE_CALLBACK_DATA) {
      return { intent: 'CUSTOM_SERVICE_MENU', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX)) {
      const panel = uuidV7Schema.safeParse(
        data.slice(CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX.length),
      );
      if (!panel.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'CUSTOM_SERVICE_LOCATION', targetId: panel.data, callbackQueryId: id };
    }
    if (data.startsWith(CATALOG_PAGE_CALLBACK_PREFIX)) {
      const page = parseCatalogPage(data.slice(CATALOG_PAGE_CALLBACK_PREFIX.length));
      if (page === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'CATALOG_PAGE', targetId: null, page, callbackQueryId: id };
    }
    if (data.startsWith(CATEGORY_CALLBACK_PREFIX)) {
      const [rawId, rawPage, ...rest] = data.slice(CATEGORY_CALLBACK_PREFIX.length).split('.');
      const page = rawPage === undefined ? null : parseCatalogPage(rawPage);
      const category = uuidV7Schema.safeParse(rawId);
      if (rest.length > 0 || page === null || !category.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'CATEGORY', targetId: category.data, page, callbackQueryId: id };
    }
    /*
     * The customer UX completion's two-letter routes, before the one-letter ones for
     * the reason the catalogue's are: none shadows another today, and placing them
     * first keeps that true if a one-letter prefix is ever added that would.
     */
    if (data === MARKETING_OPT_OUT_CALLBACK_DATA) {
      return { intent: 'MARKETING_OPT_OUT', targetId: null, callbackQueryId: id };
    }
    if (data === MARKETING_OPT_IN_CALLBACK_DATA) {
      return { intent: 'MARKETING_OPT_IN', targetId: null, callbackQueryId: id };
    }
    if (data === MAIN_MENU_CALLBACK_DATA) {
      return { intent: 'MAIN_MENU', targetId: null, callbackQueryId: id };
    }
    // Owner spec §2.2: the wallet-credit message's two next actions.
    if (data === WALLET_OPEN_CALLBACK_DATA) {
      return { intent: 'WALLET', targetId: null, callbackQueryId: id };
    }
    if (data === CATALOG_OPEN_CALLBACK_DATA) {
      return { intent: 'CATALOG', targetId: null, callbackQueryId: id };
    }
    if (data === MEMBERSHIP_CHECK_CALLBACK_DATA) {
      return { intent: 'MEMBERSHIP_CHECK', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TERMS_ACCEPT_CALLBACK_PREFIX)) {
      const version = uuidV7Schema.safeParse(data.slice(TERMS_ACCEPT_CALLBACK_PREFIX.length));
      if (!version.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TERMS_ACCEPT', targetId: version.data, callbackQueryId: id };
    }
    if (data === TUTORIAL_CALLBACK_DATA) {
      return { intent: 'TUTORIAL', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TUTORIAL_PLATFORM_CALLBACK_PREFIX)) {
      // WP-A10 widened the vocabulary by `OTHER` and kept the first five in order, so a
      // `to:<platform>` already sitting in a customer's chat parses exactly as it did.
      const platform = clientAppPlatformSchema.safeParse(
        data.slice(TUTORIAL_PLATFORM_CALLBACK_PREFIX.length),
      );
      if (!platform.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'TUTORIAL_PLATFORM', targetId: platform.data, callbackQueryId: id };
    }
    if (data.startsWith(CLIENT_APP_CALLBACK_PREFIX)) {
      return callbackCommand('CLIENT_APP', data.slice(CLIENT_APP_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(CONNECTED_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_CONNECTED', data.slice(CONNECTED_CALLBACK_PREFIX.length), id);
    }
    // WP-A7: the ticket desk, before the one-letter prefixes.
    const ticket = ticketCallbackCommand(data, id);
    if (ticket !== null) return ticket;
    if (data === SUPPORT_CALLBACK_DATA) {
      return { intent: 'SUPPORT', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TOPUP_ROUTE_CALLBACK_PREFIX)) {
      const [rawId, rawProvider, ...rest] = data
        .slice(TOPUP_ROUTE_CALLBACK_PREFIX.length)
        .split('.');
      const capture = uuidV7Schema.safeParse(rawId);
      const provider = paymentGatewayProviderSchema.safeParse(rawProvider);
      if (rest.length > 0 || !capture.success || !provider.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'TOPUP_ROUTE',
        targetId: capture.data,
        secondaryId: provider.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(TOPUP_CLOSE_CALLBACK_PREFIX)) {
      return callbackCommand('TOPUP_CLOSE', data.slice(TOPUP_CLOSE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICES_LIST_PAGE_CALLBACK_PREFIX)) {
      const page = parseCatalogPage(data.slice(SERVICES_LIST_PAGE_CALLBACK_PREFIX.length));
      if (page === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'SERVICES_PAGE', targetId: null, page, callbackQueryId: id };
    }
    if (data === SERVICES_SEARCH_CALLBACK_DATA) {
      return { intent: 'SERVICES_SEARCH', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(SERVICE_REFRESH_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFRESH',
        data.slice(SERVICE_REFRESH_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_NOTE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_NOTE', data.slice(SERVICE_NOTE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_CARD_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_CARD', data.slice(SERVICE_CARD_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_RENEW_QUOTE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RENEW_QUOTE',
        data.slice(SERVICE_RENEW_QUOTE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data === REFERRAL_GIFT_CALLBACK_DATA) {
      return { intent: 'REFERRAL_GIFT', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER', data.slice(ORDER_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand('CONFIRM', data.slice(CONFIRM_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(WALLET_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_WALLET', data.slice(WALLET_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(MANUAL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_MANUAL', data.slice(MANUAL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_METHODS_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_METHODS', data.slice(PAY_METHODS_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_METHODS_CLOSE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'PAY_METHODS_CLOSE',
        data.slice(PAY_METHODS_CLOSE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_ROUTE_PAY_CALLBACK_PREFIX)) {
      const [rawId, rawProvider, ...rest] = data
        .slice(GATEWAY_ROUTE_PAY_CALLBACK_PREFIX.length)
        .split('.');
      const order = uuidV7Schema.safeParse(rawId);
      const provider = paymentGatewayProviderSchema.safeParse(rawProvider);
      if (rest.length > 0 || !order.success || !provider.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'PAY_GATEWAY',
        targetId: order.data,
        secondaryId: provider.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(GATEWAY_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_GATEWAY', data.slice(GATEWAY_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(GATEWAY_RECEIPT_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_RECEIPT',
        data.slice(GATEWAY_RECEIPT_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CARD_CHANGE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'GATEWAY_CARD_CHANGE',
        data.slice(GATEWAY_CARD_CHANGE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(GATEWAY_CHECK_CALLBACK_PREFIX)) {
      return callbackCommand('GATEWAY_CHECK', data.slice(GATEWAY_CHECK_CALLBACK_PREFIX.length), id);
    }
    /*
     * ASK before the destructive prefix, and they are different letters so the order
     * cannot matter today. Fixed anyway for the reason the resend/service pair states:
     * if one ever became a prefix of the other every tap would route to whichever
     * branch came first, and here that is the difference between showing a customer a
     * question and closing the payment their money is against.
     */
    if (data.startsWith(CANCEL_PAY_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'PAY_CANCEL_ASK',
        data.slice(CANCEL_PAY_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_CANCEL', data.slice(CANCEL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_SENT_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_SENT', data.slice(PAY_SENT_CALLBACK_PREFIX.length), id);
    }
    /*
     * The menu carries no target, so it is matched on the WHOLE string. `callbackCommand`
     * validates its slice as a uuid and would refuse an empty one, which is right for
     * every other prefix here and wrong for this: the tap means "show me the amounts".
     */
    if (data === TOPUP_MENU_CALLBACK_PREFIX) {
      return { intent: 'TOPUP_MENU', targetId: null, callbackQueryId: id };
    }
    if (data === REFERRAL_INVITE_CALLBACK_PREFIX) {
      return { intent: 'REFERRAL_INVITE', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TOPUP_PICK_CALLBACK_PREFIX)) {
      /*
       * DIGITS, and the shape is validated here rather than parsed in the handler: the
       * data is client-supplied, so anything that is not a plain positive integer is
       * UNSUPPORTED — which answers the customer — instead of reaching `BigInt()` and
       * throwing a SyntaxError inside a transaction. The length bound stops a
       * megabyte-long number being converted at all; `PAYMENT_AMOUNT_MAX_MINOR` is
       * thirteen digits, and the service refuses anything not on the preset list anyway.
       */
      const raw = data.slice(TOPUP_PICK_CALLBACK_PREFIX.length);
      if (!/^[1-9]\d{0,19}$/.test(raw)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'TOPUP_PICK', targetId: raw, callbackQueryId: id };
    }
    /* ASK before the destructive one, exactly as the payment pair above is ordered. */
    if (data.startsWith(CANCEL_ORDER_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ORDER_CANCEL_ASK',
        data.slice(CANCEL_ORDER_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER_CANCEL', data.slice(CANCEL_ORDER_CALLBACK_PREFIX.length), id);
    }
    /*
     * The resend prefix is tested BEFORE the service prefix.
     *
     * `'r:'` and `'s:'` share no first character, so today the order is irrelevant — it
     * is fixed anyway because the failure it prevents is silent: a prefix that is a
     * prefix of another routes every tap to whichever branch comes first, and the
     * customer gets the wrong screen with nothing anywhere saying so.
     */
    if (data.startsWith(SERVICE_FILES_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_FILES', data.slice(SERVICE_FILES_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_RESEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESEND',
        data.slice(SERVICE_RESEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_SUSPEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_SUSPEND',
        data.slice(SERVICE_SUSPEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RESUME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESUME',
        data.slice(SERVICE_RESUME_CALLBACK_PREFIX.length),
        id,
      );
    }
    /*
     * Retired, and still parsed (WP15 G1): a stale TERMINATE tap must reach the handler
     * that refuses it, not fall through to the unknown-callback path or to a prefix a
     * later release gives these letters.
     */
    if (data.startsWith(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE_ASK',
        data.slice(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_TERMINATE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE',
        data.slice(SERVICE_TERMINATE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_REFUND_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFUND_ASK',
        data.slice(SERVICE_REFUND_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_REFUND_CONFIRM',
        data.slice(SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    /* Ask before act, for the reason the terminate pair states. */
    if (data.startsWith(SERVICE_TRANSFER_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TRANSFER_ASK',
        data.slice(SERVICE_TRANSFER_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX)) {
      const pair = decodeTransferConfirm(data);
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: 'SERVICE_TRANSFER_CONFIRM',
        targetId: pair.serviceId,
        secondaryId: pair.recipientTelegramUserId,
        ownershipVersion: pair.ownershipVersion,
        callbackQueryId: id,
      };
    }
    /* Ask before act, for the reason the terminate pair above states. */
    if (data.startsWith(SERVICE_ROTATE_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ROTATE_ASK',
        data.slice(SERVICE_ROTATE_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ROTATE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ROTATE',
        data.slice(SERVICE_ROTATE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RENEW_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_RENEW', data.slice(SERVICE_RENEW_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TRAFFIC',
        data.slice(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ADD_TIME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TIME',
        data.slice(SERVICE_ADD_TIME_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ADD_DEVICES_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_DEVICES',
        data.slice(SERVICE_ADD_DEVICES_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_CHANGE_LOCATION',
        data.slice(SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (
      data.startsWith(SERVICE_LOCATION_TARGET_CALLBACK_PREFIX) ||
      data.startsWith(SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX)
    ) {
      const chosen = decodeServiceLocationPair(data.slice(3));
      if (chosen === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: data.startsWith(SERVICE_LOCATION_TARGET_CALLBACK_PREFIX)
          ? 'SERVICE_LOCATION_TARGET'
          : 'SERVICE_LOCATION_CONFIRM',
        targetId: chosen.serviceId,
        secondaryId: chosen.locationId,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(SERVICE_BUY_DEVICES_CALLBACK_PREFIX)) {
      const chosen = decodeDeviceQuantity(data);
      if (chosen === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return {
        intent: 'SERVICE_BUY_DEVICES',
        targetId: chosen.serviceId,
        secondaryId: chosen.addonId,
        quantity: chosen.quantity,
        callbackQueryId: id,
      };
    }
    if (
      data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX) ||
      data.startsWith(SERVICE_BUY_TIME_CALLBACK_PREFIX)
    ) {
      const buying = data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX)
        ? ('SERVICE_BUY_TRAFFIC' as const)
        : ('SERVICE_BUY_TIME' as const);
      /*
       * The one callback carrying two ids, and both go through the SAME validation the
       * single-id path uses. A malformed pair is `UNSUPPORTED`, not a 500 at a `uuid`
       * cast, and not a half-read that would buy a package for a service nobody named.
       */
      const pair = decodeIdPair(data.slice(2));
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      const service = uuidV7Schema.safeParse(pair.first);
      const addon = uuidV7Schema.safeParse(pair.second);
      if (!service.success || !addon.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: buying,
        targetId: service.data,
        secondaryId: addon.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(USERNAME_CUSTOM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_CUSTOM',
        data.slice(USERNAME_CUSTOM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(USERNAME_AUTOMATIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_AUTOMATIC',
        data.slice(USERNAME_AUTOMATIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(DISCOUNT_CODE_ENTER_CALLBACK_PREFIX)) {
      return callbackCommand(
        'DISCOUNT_CODE_ENTER',
        data.slice(DISCOUNT_CODE_ENTER_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'DISCOUNT_CODE_REMOVE',
        data.slice(DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ACTION_CONFIRM',
        data.slice(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICES_PAGE_CALLBACK_PREFIX)) {
      /*
       * The one callback that carries a POSITION rather than an identifier.
       *
       * Decoded here, which is the same place `callbackCommand` validates a uuid and
       * for the same reason: a crafted token must be UNSUPPORTED at the boundary rather
       * than an invalid cast inside a query. Nothing is authorized by it — the list is
       * scoped to the tenant and to the customer resolved from the update — so the
       * decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(SERVICES_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'SERVICES_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(SERVICE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE', data.slice(SERVICE_CALLBACK_PREFIX.length), id);
    }
    /*
     * The panel's three screens carry no target, so they match the WHOLE string — the
     * same rule the top-up menu states. The three that act carry one uuid and go
     * through `callbackCommand`, which validates it: a crafted id is UNSUPPORTED here
     * rather than a 500 at a cast, and an id belonging to another tenant finds nothing
     * because every repository read is tenant-scoped.
     */
    if (data === ADMIN_PANEL_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SERVICES_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SERVICES', targetId: null, callbackQueryId: id };
    }
    /*
     * The page branch FIRST, then the bare browse.
     *
     * `H:b` is a prefix of `H:b:<token>`, so the equality check below could not run
     * first without swallowing every paged tap. The queue's own `H:` is matched by
     * equality above and is unaffected by either.
     */
    if (data.startsWith(ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX)) {
      /*
       * Decoded HERE, for the reason `ADMIN_PANELS_PAGE_CALLBACK_PREFIX` states: a
       * crafted token must be UNSUPPORTED at the boundary rather than an invalid cast
       * inside a query. Nothing is authorized by it — the list is tenant-scoped and
       * `services.view` is charged in the handler — so the decode is about shape.
       */
      const cursor = decodeKeysetToken(
        data.slice(ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX.length),
      );
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_SERVICES_BROWSE_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data === ADMIN_SERVICES_BROWSE_CALLBACK_DATA) {
      return { intent: 'ADMIN_SERVICES_BROWSE', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_PANELS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANELS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_REMINDERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_REMINDERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX)) {
      /*
       * The setting code, validated HERE against the closed map.
       *
       * `callback_data` is client-supplied text, so an unknown code must be UNSUPPORTED
       * at the boundary rather than a settings key assembled from it downstream. The
       * same rule the UUID paths above follow, for the same reason.
       */
      const code = data.slice(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX.length);
      if (!isReminderSettingCode(code)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'ADMIN_REMINDER_EDIT', targetId: code, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_SET_CALLBACK_PREFIX)) {
      const [code, raw] = data.slice(ADMIN_REMINDER_SET_CALLBACK_PREFIX.length).split(':');
      /*
       * BOTH halves validated, and the value against the widest bound any of the five
       * keys declares rather than against the option list.
       *
       * The list is what a tap can produce; the bound is what the contract permits. A
       * value outside the bound is a crafted callback and is refused here; one inside
       * it but not on the list is still checked by the key's own schema and by the
       * combination guard, so nothing downstream trusts this number — it is only
       * stopped from being a string, a float or a megabyte of digits.
       */
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (
        code === undefined ||
        !isReminderSettingCode(code) ||
        !Number.isInteger(value) ||
        value < USAGE_REMINDER_PERCENT_MIN ||
        value > USAGE_REMINDER_PERCENT_MAX
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'ADMIN_REMINDER_SET',
        targetId: code,
        args: [String(value)],
        callbackQueryId: id,
      };
    }
    if (data.startsWith(ADMIN_PANELS_PAGE_CALLBACK_PREFIX)) {
      /*
       * The panels section's own page button, decoded HERE for the reason
       * `SERVICES_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED at
       * the boundary rather than an invalid cast inside a query. Nothing is authorized
       * by it — the list is tenant-scoped and `panels.view` is charged in the handler
       * — so the decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_PANELS_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_PANELS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX)) {
      /*
       * `<field>:<value>:<panelId>`, all three validated HERE.
       *
       * `callback_data` is client-supplied text. An unknown field, a value that is
       * not one of the two, or a panel id that is not a uuid must be UNSUPPORTED at
       * the boundary rather than something assembled downstream — the same rule the
       * reminder codes above follow. The panel id itself is checked by
       * `callbackCommand`, which is why it is passed through it.
       */
      const [field, value, panelId] = data
        .slice(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX.length)
        .split(':');
      if (
        field === undefined ||
        !isUsernameToggleField(field) ||
        (value !== '0' && value !== '1') ||
        panelId === undefined
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_TOGGLE', panelId, id);
      return command.targetId === null ? command : { ...command, args: [field, value] };
    }
    if (data.startsWith(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX)) {
      const [code, panelId] = data.slice(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isUsernameStrategyCode(code) || panelId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_STRATEGY', panelId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    for (const [prefix, intent] of ADMIN_PANEL_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    /*
     * The services section's id-carrying callbacks, all through `callbackCommand`.
     *
     * A table rather than nine `if`s, because nine near-identical branches is nine
     * chances to point a prefix at the wrong intent — and the one that matters is the
     * last row, where a mis-wiring would make the ASKING callback the destructive one.
     */
    const rotate = adminServiceRotateCommand(data, id);
    if (rotate !== null) return rotate;
    for (const [prefix, intent] of ADMIN_SERVICE_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data === ADMIN_RECEIPTS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_RECEIPTS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SECTION_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SECTION', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_RECEIPT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_RECEIPT', data.slice(ADMIN_RECEIPT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_CREDIT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_CREDIT', data.slice(ADMIN_CREDIT_CALLBACK_PREFIX.length), id);
    }
    for (const [prefix, intent] of ADMIN_REFUND_REQUEST_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data.startsWith(ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ADMIN_CREDIT_CONFIRM',
        data.slice(ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ADMIN_CREDIT_CANCEL',
        data.slice(ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX.length),
        id,
      );
    }
    for (const [prefix, intent] of ADMIN_BLOCK_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data.startsWith(ADMIN_APPROVE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_APPROVE', data.slice(ADMIN_APPROVE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REJECT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REJECT', data.slice(ADMIN_REJECT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REVOKE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REVOKE', data.slice(ADMIN_REVOKE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_ADMIN_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_ADMIN', data.slice(ADMIN_ADMIN_CALLBACK_PREFIX.length), id);
    }
    if (data === ADMIN_CUSTOMERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_CUSTOMERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMERS_CALLBACK_PREFIX)) {
      /*
       * The same prefix carrying a POSITION, decoded HERE for the reason
       * `ADMIN_PANELS_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED
       * at the boundary rather than an invalid cast inside a query. The bare-prefix
       * branch above runs FIRST, so `8:` alone is never offered to the decoder.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_CUSTOMERS_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_CUSTOMERS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMER_CALLBACK_PREFIX)) {
      const [code, customerId] = data.slice(ADMIN_CUSTOMER_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isAdminCustomerCode(code) || customerId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      /*
       * The TABLE picks the intent. A chain of comparisons here would be the place a
       * read and a block could be transposed, and the uuid still goes through
       * `callbackCommand` so a malformed one is refused before either is chosen.
       */
      return callbackCommand(ADMIN_CUSTOMER_CODES[code], customerId, id);
    }
    if (data.startsWith(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX)) {
      const [code, adminId] = data.slice(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX.length).split(':');
      /*
       * The code is validated HERE, at the boundary, exactly as the username toggles
       * are: an unreadable callback is UNSUPPORTED and never becomes an intent, so the
       * handler receives one of the two statuses or is not reached. A cast downstream
       * would be a third place the vocabulary is spelled out.
       */
      if (code === undefined || !isAdminStatusCode(code) || adminId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_ADMIN_STATUS', adminId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    const categories = adminCategoryCommand(data, id);
    if (categories !== null) return categories;
    // Spec §7: the client apps section's callbacks, validated in their own module.
    const tutorials = adminTutorialCallback(data);
    if (tutorials !== null) return { ...tutorials, callbackQueryId: id };
    return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  }

  /*
   * Spec §7: a VIDEO message. Offered only to an administrator's open «تنظیم ویدیو» prompt;
   * from anybody else it reaches `adminTurn`, resolves to no prompt or no administrator, and
   * is answered like any message this bot does not understand — which is what a video was.
   */
  const video = tutorialVideoOf((update as { message?: unknown } | null)?.message);
  if (video !== null) {
    return { intent: 'ADMIN_APP_VIDEO_UPLOAD', targetId: null, callbackQueryId: null, video };
  }
  /*
   * A FILE before the text, because a photo message has no `text` at all — Telegram
   * puts any accompanying words in `caption`, which this deliberately ignores.
   *
   * Reading through passthrough fields, as the rest of this function does: nothing about
   * the file is trusted as a fact about money, and an update whose file shape is not one
   * of the two this installation accepts falls through to the text path and then to
   * `UNSUPPORTED`, exactly as it did before this existed.
   */
  const file = receiptFileOf((update as { message?: unknown } | null)?.message);
  if (file !== null) {
    return { intent: 'RECEIPT_UPLOAD', targetId: null, callbackQueryId: null, file };
  }

  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return UNSUPPORTED;
  /*
   * A menu tap first, and it is matched on the WHOLE message rather than its first
   * word: the labels contain spaces, and `خرید اشتراک` split on whitespace is not a
   * command. Resolving to the slash command it stands for is what makes the button and
   * the command literally the same path rather than two that agree today.
   */
  const trimmed = text.trim();
  /*
   * A slash command is never a menu label (Codex, PR #111). Since R1 a tenant names its
   * buttons, and a button labelled `/start` would otherwise turn every `/start` — the
   * referral deep link's included — into whatever that button stands for.
   */
  const asCommand = trimmed.startsWith('/') ? trimmed : (menu.get(trimmed) ?? trimmed);
  const first = asCommand.split(/\s+/)[0]?.toLowerCase();
  // `/start@somebot` is what Telegram sends in a group. Stripped, because the bot it
  // names is the bot that received it.
  const command = first?.split('@')[0];
  if (command === '/start') return { intent: 'START', targetId: null, callbackQueryId: null };
  if (command === '/catalog') return { intent: 'CATALOG', targetId: null, callbackQueryId: null };
  if (command === '/wallet') return { intent: 'WALLET', targetId: null, callbackQueryId: null };
  if (command === '/services') {
    return { intent: 'SERVICES', targetId: null, callbackQueryId: null };
  }
  /*
   * The command that makes the other four findable.
   *
   * `docs/phase4h-audit.md` §9: the bot answered four commands, registered none with
   * Telegram, and `bot.start.welcome` named only `/catalog` — so `/wallet` and
   * `/services` were reachable only by guessing. `BOT_COMMANDS` is what both this and
   * `setMyCommands` render, so the menu and the help cannot disagree.
   */
  if (command === '/help') return { intent: 'HELP', targetId: null, callbackQueryId: null };
  /*
   * `/paysupport` (Package A): Telegram requires a bot that sells for Stars to answer it.
   * It opens the same support screen the menu's support entry does — no new ticketing.
   */
  if (command === '/paysupport') {
    return { intent: 'SUPPORT', targetId: null, callbackQueryId: null };
  }
  /*
   * Round N close (§D): `/stop`, the command Telegram users know for "stop messaging me".
   * It stops MARKETING broadcasts and nothing else; the reply says so and offers the way back.
   */
  if (command === '/stop') {
    return { intent: 'MARKETING_OPT_OUT', targetId: null, callbackQueryId: null };
  }
  // WP-A7: the customer's support tickets — the menu's ticket button routes here.
  if (command === '/tickets') {
    return { intent: 'TICKETS', targetId: null, callbackQueryId: null };
  }
  /*
   * `/apps` and «📱 دانلود برنامه و آموزش اتصال» (WP-A10) open the connection guide's
   * platform choice — the same `TUTORIAL` the delivery card's «📚 مشاهده آموزش استفاده»
   * (`tu:`) opens, so there is one guide and three ways into it.
   */
  if (command === '/apps') return { intent: 'TUTORIAL', targetId: null, callbackQueryId: null };
  /*
   * R1: «🧪 دریافت سرویس تست» and «👥 زیرمجموعه‌گیری». Not registered with
   * `setMyCommands` (see `TRIAL_MENU_COMMAND`); reachable by the button and by typing, and
   * each answers from its feature's own state — the same two paths the pre-F5 catalogue
   * trial button (`tr:`) and wallet referral button (`rf:`) still take from old messages.
   */
  if (command === `/${TRIAL_MENU_COMMAND}`) {
    return { intent: 'TRIAL_CLAIM', targetId: null, callbackQueryId: null };
  }
  if (command === `/${REFERRAL_MENU_COMMAND}`) {
    return { intent: 'REFERRAL_INVITE', targetId: null, callbackQueryId: null };
  }
  /*
   * The management panel's three text entries (Phase 5T).
   *
   * `/admin` is deliberately NOT registered with `setMyCommands` — Telegram's command
   * list is per bot, not per user, so registering it would advertise the panel to every
   * customer. It is reachable by the keyboard button an administrator gets and by
   * typing it; both answer the same way, and a customer who types it resolves to no
   * administrator and gets this function's fallback.
   *
   * The two that carry arguments split on whitespace and validate nothing here: what
   * makes `123456789` a Telegram account and `owner` an administrator is a question for
   * the services that look them up.
   */
  if (command === `/${ADMIN_MENU_COMMAND}`) {
    return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: null };
  }
  /*
   * Exact lookup, Phase 6A: `/service <id>`.
   *
   * A command carrying its argument rather than a prompt that captures the next
   * message, for the reason `/link` and `/role` state — INCIDENT-FIN-001 is what a
   * stateful prompt does when it outlives the question it was asked for. Not registered
   * with `setMyCommands` for the same reason `/admin` is not: the command list is per
   * bot rather than per user, so registering it would advertise the panel to every
   * customer.
   */
  if (command === '/service') {
    return {
      intent: 'ADMIN_SERVICE',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  /*
   * `/panel_prefix <panel id> <prefix>` and `/panel_template <panel id> <template>`.
   *
   * Commands rather than a prompt, for the reason `/link` and `/role` state. The
   * template argument is joined back with single spaces AFTER the split, so a
   * template is one token in practice — and a template containing a space is refused
   * by the grammar anyway, since a space is not in the permitted character class.
   * Nothing is validated here: what makes a string a legal prefix or template is the
   * shared evaluator's question, and answering it twice is how two answers diverge.
   */
  if (command === '/panel_prefix' || command === '/panel_template') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/panel_prefix' ? 'ADMIN_USERNAME_PREFIX' : 'ADMIN_USERNAME_TEMPLATE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Exact lookup, WP2: `/customer <telegram id>`.
   *
   * The numeric Telegram id, because that is what a support conversation quotes — not
   * the internal uuid, which nobody outside the Web Admin has ever seen. Nothing is
   * validated here: what makes a string a Telegram account is a question for the service
   * that looks it up, and the boundary splitting a command's words cannot know which of
   * them was meant to be an id.
   *
   * Not registered with `setMyCommands`, for the reason `/admin` and `/service` are not:
   * Telegram's command list is per bot rather than per user, so registering it would
   * advertise the management panel to every customer.
   */
  if (command === '/customer') {
    return {
      intent: 'ADMIN_CUSTOMER_FIND',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  /*
   * `/category_new <name>`, `/category_rename <id> <name>`, `/category_emoji <id> <emoji>`.
   *
   * Commands carrying their argument, for the reason `/panel_prefix` states. Nothing is
   * validated here: a name's length and an emoji's shape are `ProductCategoryService`'s
   * questions, answered once for both surfaces. Not registered with `setMyCommands`, for
   * the reason `/admin` is not.
   */
  if (
    command === '/category_new' ||
    command === '/category_rename' ||
    command === '/category_emoji'
  ) {
    return {
      intent:
        command === '/category_new'
          ? 'ADMIN_CATEGORY_NEW'
          : command === '/category_rename'
            ? 'ADMIN_CATEGORY_RENAME'
            : 'ADMIN_CATEGORY_EMOJI',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  if (command === '/link' || command === '/role') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/link' ? 'ADMIN_LINK' : 'ADMIN_ROLE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Anything else MIGHT be a username, and only the database knows.
   *
   * This is the last branch on purpose: every command above is matched first, so a
   * `/start` typed while a window is open is still `/start`. The text is carried
   * UNTOUCHED — not trimmed, not lowercased — because `isValidCustomUsername` is asked
   * of the raw input and a surface that tidied it first would be deciding what the
   * customer typed.
   *
   * It is `USERNAME_TEXT` rather than `UNSUPPORTED` only as a routing label. The
   * handler asks whether a window is open and, for almost every message, is told no
   * and answers exactly as `UNSUPPORTED` always did.
   */
  return { intent: 'USERNAME_TEXT', targetId: null, args: [text], callbackQueryId: null };
}

const UNSUPPORTED: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: null };

/**
 * The receipt inside a message, or null when there is not one.
 *
 * Two shapes and the list is closed, because `PAYMENT_RECEIPT_KINDS` is: a photo is
 * what most customers send and a document is what a banking app's PDF export produces.
 * Everything else a message can carry — a voice note, a location, a contact, a sticker,
 * a video — is NOT a receipt and is answered exactly as any other message this bot does
 * not understand.
 *
 * The photo arrives as an array of sizes. The LARGEST is chosen by `file_size`, and by
 * width where a size reports none: Telegram documents the array as ascending and
 * trusting that means trusting a client to order its own upload, which is the class of
 * assumption this file exists to avoid. A reviewer looking for a transfer reference
 * needs the biggest one there is.
 *
 * `file_size` is read as a NUMBER from the wire and carried as `bigint`, because it
 * reaches a `bigint` column and `payment_receipts_size_check` refuses a non-positive
 * one — so a zero or a negative becomes null here rather than a constraint violation
 * two layers down.
 */
function receiptFileOf(message: unknown): InboundReceiptFile | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const telegramMessageId =
    typeof record['message_id'] === 'number' && Number.isSafeInteger(record['message_id'])
      ? BigInt(record['message_id'])
      : null;

  const photo = record['photo'];
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = largestPhoto(photo);
    if (largest !== null) {
      return {
        kind: 'PHOTO',
        fileId: largest.fileId,
        fileUniqueId: largest.fileUniqueId,
        // A photo size carries neither, and Telegram re-encodes it: claiming a type
        // this installation did not observe would be a fabricated fact about a file.
        mimeType: null,
        fileName: null,
        fileSize: largest.fileSize,
        telegramMessageId,
        // The customer's own caption, stored for the reviewer (D3) and never logged.
        caption: normalizeReceiptCaption(record['caption']),
      };
    }
  }

  const document = record['document'];
  if (typeof document === 'object' && document !== null) {
    const fields = document as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId === 'string' && typeof fileUniqueId === 'string') {
      return {
        kind: 'DOCUMENT',
        fileId,
        fileUniqueId,
        mimeType: typeof fields['mime_type'] === 'string' ? fields['mime_type'] : null,
        fileName: typeof fields['file_name'] === 'string' ? fields['file_name'] : null,
        fileSize: positiveSize(fields['file_size']),
        telegramMessageId,
        caption: normalizeReceiptCaption(record['caption']),
      };
    }
  }
  return null;
}

/**
 * The biggest usable size in a `photo` array, ranked by PIXELS with bytes as the
 * tie-breaker.
 *
 * Two comparable numbers, never one of each. Ranking by `file_size` where it exists and
 * by width where it does not compares byte counts against pixel counts: a 5 KB thumbnail
 * ranks 5000 and a 1920-pixel original with no declared size ranks 1920, so the
 * thumbnail wins and the receipt an operator opens is unreadable. Telegram documents
 * `file_size` as optional on a `PhotoSize`, so that is not a hypothetical shape.
 *
 * Pixels first because they are what makes a receipt legible, and `width * height`
 * rather than width alone because a wide, short crop is not a bigger image. Bytes break
 * a tie only among equal dimensions, which is where they mean compression rather than
 * size.
 */
function largestPhoto(sizes: readonly unknown[]): {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileSize: bigint | null;
} | null {
  let best: {
    fileId: string;
    fileUniqueId: string;
    fileSize: bigint | null;
    pixels: number;
    bytes: number;
  } | null = null;
  for (const candidate of sizes) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const fields = candidate as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId !== 'string' || typeof fileUniqueId !== 'string') continue;
    const size = positiveSize(fields['file_size']);
    const width = dimension(fields['width']);
    const height = dimension(fields['height']);
    // A missing dimension is 1 rather than 0, so a size with no dimensions at all is
    // still comparable — ranked last among anything that declared them, not discarded.
    const pixels = Math.max(1, width) * Math.max(1, height);
    const bytes = size === null ? 0 : Number(size);
    if (best === null || pixels > best.pixels || (pixels === best.pixels && bytes > best.bytes)) {
      best = { fileId, fileUniqueId, fileSize: size, pixels, bytes };
    }
  }
  return best === null
    ? null
    : { fileId: best.fileId, fileUniqueId: best.fileUniqueId, fileSize: best.fileSize };
}

/** A declared pixel count, or 0. Non-integers and negatives are not dimensions. */
function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A declared byte count, or null. Zero and negatives are null: the CHECK refuses them. */
function positiveSize(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? BigInt(value)
    : null;
}

/** A tap on a button, with its id checked before anything is asked to look it up. */
function callbackCommand(
  intent: BotIntent,
  rawId: string,
  callbackQueryId: string | null,
): BotCommand {
  const parsed = uuidV7Schema.safeParse(rawId);
  if (!parsed.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId };
  return { intent, targetId: parsed.data, callbackQueryId };
}

/**
 * WP-A7 — the ticket desk's seven callbacks, or null when `data` is none of them. Every id is
 * validated here; anything malformed is UNSUPPORTED before a handler sees it.
 */
function ticketCallbackCommand(data: string, id: string | null): BotCommand | null {
  if (data === TICKETS_CALLBACK_DATA)
    return { intent: 'TICKETS', targetId: null, callbackQueryId: id };
  if (data === TICKET_NEW_CALLBACK_DATA) {
    return { intent: 'TICKET_NEW', targetId: null, callbackQueryId: id };
  }
  const routes: readonly (readonly [string, BotIntent])[] = [
    [TICKET_CATEGORY_CALLBACK_PREFIX, 'TICKET_CATEGORY'],
    [TICKET_VIEW_CALLBACK_PREFIX, 'TICKET_VIEW'],
    [TICKET_REPLY_CALLBACK_PREFIX, 'TICKET_REPLY'],
    [TICKET_CLOSE_ASK_CALLBACK_PREFIX, 'TICKET_CLOSE_ASK'],
    [TICKET_CLOSE_CALLBACK_PREFIX, 'TICKET_CLOSE'],
  ];
  for (const [prefix, intent] of routes) {
    if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
  }
  return null;
}

/**
 * The categories section's five callbacks, or null when `data` is none of them.
 *
 * Every payload is validated HERE and nowhere later: a page through `parseCatalogPage`,
 * an id through `uuidV7Schema`, a code through `ADMIN_CATEGORY_CODES`, a pair through
 * `decodeIdPair` and then both halves as UUIDv7s, a product-list position through
 * `decodeKeysetToken`. Anything that fails is UNSUPPORTED, so a handler receives a
 * well-formed command or is not reached — and none of this authorizes anything: the
 * service charges the permission.
 */
function adminCategoryCommand(data: string, id: string | null): BotCommand | null {
  const unsupported: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  if (data.startsWith(ADMIN_CATEGORIES_CALLBACK_PREFIX)) {
    const page = parseCatalogPage(data.slice(ADMIN_CATEGORIES_CALLBACK_PREFIX.length));
    return page === null
      ? unsupported
      : { intent: 'ADMIN_CATEGORIES', targetId: null, page, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_CALLBACK_PREFIX)) {
    const [code, categoryId, ...rest] = data
      .slice(ADMIN_CATEGORY_CALLBACK_PREFIX.length)
      .split(':');
    if (code === undefined || !isAdminCategoryCode(code) || categoryId === undefined) {
      return unsupported;
    }
    return rest.length > 0
      ? unsupported
      : callbackCommand(ADMIN_CATEGORY_CODES[code], categoryId, id);
  }
  if (data.startsWith(ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX)) {
    const raw = data.slice(ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX.length);
    if (raw === '') {
      return {
        intent: 'ADMIN_CATEGORY_PRODUCTS',
        targetId: null,
        cursor: null,
        callbackQueryId: id,
      };
    }
    const cursor = decodeKeysetToken(raw);
    return cursor === null
      ? unsupported
      : { intent: 'ADMIN_CATEGORY_PRODUCTS', targetId: null, cursor, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_PICK_CALLBACK_PREFIX)) {
    const [rawId, rawPage, ...rest] = data
      .slice(ADMIN_CATEGORY_PICK_CALLBACK_PREFIX.length)
      .split('.');
    const page = rawPage === undefined ? null : parseCatalogPage(rawPage);
    const product = uuidV7Schema.safeParse(rawId);
    if (rest.length > 0 || page === null || !product.success) return unsupported;
    return { intent: 'ADMIN_CATEGORY_PICK', targetId: product.data, page, callbackQueryId: id };
  }
  if (data.startsWith(ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX)) {
    const pair = decodeIdPair(data.slice(ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX.length));
    if (pair === null) return unsupported;
    const product = uuidV7Schema.safeParse(pair.first);
    const category = uuidV7Schema.safeParse(pair.second);
    if (!product.success || !category.success) return unsupported;
    return {
      intent: 'ADMIN_CATEGORY_ASSIGN',
      targetId: product.data,
      secondaryId: category.data,
      callbackQueryId: id,
    };
  }
  return null;
}

/**
 * The customer's chat id for a private conversation.
 *
 * Telegram's private chat id IS the user id, but the update carries both and they can
 * differ — in a group, `chat.id` is the group. A reply to a group chat would publish a
 * customer's balance to everyone in it, so this prefers the chat id only when the chat
 * is private and otherwise has no answer.
 */
export function privateChatIdOf(update: unknown): string | null {
  const shaped = update as {
    message?: { chat?: { id?: unknown; type?: unknown } };
    // A tapped button carries the message it was attached to, and that message carries
    // the chat. Read second, so a real `message` still wins for an ordinary command.
    callback_query?: { message?: { chat?: { id?: unknown; type?: unknown } } };
  } | null;
  const chat = shaped?.message?.chat ?? shaped?.callback_query?.message?.chat;
  if (chat === undefined || chat === null) return null;
  if (chat.type !== 'private') return null;
  return typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null;
}

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
    | { readonly outcome: 'ASK_VOLUME'; readonly location: { readonly label: string } }
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
    | { readonly outcome: 'INVALID' }
    | { readonly outcome: 'UNAVAILABLE' }
    | { readonly outcome: 'ASK_DAYS'; readonly volumeBytes: bigint }
  >;
  recordDays(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly capture: CustomerCaptureRecord; readonly text: string },
  ): Promise<
    { readonly outcome: 'INVALID' } | { readonly outcome: 'DRAFTED'; readonly order: OrderRecord }
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
  readonly customers: CustomerService;
  readonly messenger: CustomerMessenger;
  readonly products: ProductService;
  readonly commercial: CommercialActionService;
  /**
   * WP-A6 — a customer's FREE location change. Optional for the fixtures that build a
   * runtime without it: then a free target's confirmation answers the unavailable
   * sentence rather than being requested.
   */
  readonly locationChanges?: Pick<LocationChangeService, 'requestFree'>;
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
  readonly serviceRefresh?: Pick<ServiceRefreshService, 'refresh'>;
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
   * Composes the destination block for a manual-transfer instruction.
   *
   * Injected rather than imported, for the reason `MainMenuRoutes` is: the four line
   * templates are catalogue text, `check-boundaries.sh` refuses an `@nexa/i18n` import
   * in a surface, and resolving a tenant override is the application layer's job. What
   * this surface holds is a function from a frozen snapshot to a string.
   */
  readonly destinations: PaymentDestinationRenderer;
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
    'submit' | 'reviewQueue' | 'reviewItem' | 'dispositionOf' | 'finalRecord' | 'filedForCustomer'
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
    'openReceiptCapture' | 'requestCardChange' | 'receivePhoto'
  >;
  readonly screens: CustomerScreenComposer;
  readonly counters: CustomerCountersReader;
  /** The payment routes per purpose; the external chooser is drawn only from a real route. */
  readonly routes: PaymentRouteSource;
  readonly support: SupportScreenSource;
  readonly productDisplay: ProductDisplaySource;
  readonly resellers?: Pick<ResellerService, 'standing'>;
  readonly referralGifts?: ReferralGiftSource;
  readonly media?: TenantMediaSource;
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
    | 'recordReview'
    | 'findReview'
    | 'reviewTapIsRetired'
    | 'finaliseReviews'
    | 'unfinaliseReview'
  >;
  /** R2 (item 4): the invoice screens the gateway worker edits too. */
  readonly invoiceScreens?: InvoiceScreensPort;
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
  } | null>;
}

export interface ReferralGiftSource {
  terms(scope: TenantContext): Promise<{
    readonly active: boolean;
    readonly total: Money;
    readonly referrerPercent: number;
    readonly referredPercent: number;
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
  ): Promise<{ readonly credited: Money; readonly claimedCount: number }>;
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

/**
 * What a handled update produced.
 *
 * Returned rather than logged, so the webhook controller decides what to do with it and
 * the tests can assert it. `sent` is deliberately not a boolean: a reply that may or may
 * not have arrived is a third thing, and the messenger already distinguishes it.
 */
export interface BotTurnResult {
  readonly intent: BotIntent;
  readonly arrival: CustomerArrival | null;
  readonly customerId: string | null;
  readonly replyKey: TemplateKey | null;
  /** The order this turn created or confirmed, when it was one of those. */
  readonly orderId: string | null;
  readonly sent: CustomerSendOutcome | 'NOT_ATTEMPTED';
}

/**
 * A reply that has been decided and not yet sent.
 *
 * Assembled BEFORE any network call, so the whole turn is: commit, decide, send. A
 * branch that sent from inside its own decision would be a second send path, and the
 * `resolve -> commit -> reply` order is the one rule this surface exists to keep.
 */
export interface PendingReply {
  readonly key: TemplateKey | null;
  readonly values: TemplateValues;
  readonly buttons: readonly CustomerButton[];
  readonly orderId: string | null;
  /**
   * R2 (item 5): the wizard screen this reply shows. A reply answering a wizard tap is
   * EDITED into the tapped message; one answering a typed step is edited into the wizard
   * message that asked for it; one sent as a new message becomes that message's wizard.
   */
  readonly wizard?: WizardDirective;
  /** R2 (item 3): what this reply does to the receipt-review messages of one payment. */
  readonly review?: ReviewDirective;
  /**
   * A SECOND message, sent after the first, about a different fact.
   *
   * One handler, two sentences, because they are two facts and merging them would make
   * one of them false. Settlement is the case it exists for: `bot.order.settled` says
   * the money arrived and is complete on its own, and `bot.service.provisioning` says
   * something is now being made — which is not true of a renewal, so it cannot simply
   * be appended to the settled copy.
   *
   * Sent only if the FIRST one was, and its outcome is not the turn's. A follow-up that
   * failed leaves the customer with the message that mattered; a follow-up that arrived
   * without its subject would be a sentence about nothing.
   *
   * It carries no values and no buttons on purpose. A second message that needed either
   * would be a second reply, and this is deliberately not a general mechanism — the
   * turn still has ONE answer, with a note after it.
   */
  readonly followUpKey?: TemplateKey;
  /**
   * The lane kind this reply falls back to when Telegram rate-limits it.
   *
   * `OQ-4H-01`: the durable write commits, the synchronous reply gets a 429, and
   * the customer sees nothing — so they send the transfer twice, or conclude the
   * cancellation did not happen. The background lanes already handle a 429 by
   * requeueing at Telegram's own `retryAfterMs` with no attempt spent; the
   * interactive path had nowhere to put it.
   *
   * Set on exactly the replies that are a FACT about an entity the customer just
   * changed — a recorded transfer, a cancelled order. Those carry `values: {}`
   * and `buttons: []`, which is what makes them expressible as a lane kind at
   * all.
   *
   * DELIBERATELY absent on every reply that RENDERS state. A menu, a catalogue
   * and a service list have no subject and no fact; queueing one would deliver a
   * stale screen minutes later against state that has moved, and would need the
   * parameterised payload `ADR 0030` §1 refuses. The customer's next tap
   * reproduces those, which is why they need no fallback.
   */
  readonly fallback?: {
    readonly kind: CustomerNotificationKind;
    readonly subjectId: string;
  };
  /**
   * Attach the persistent main-menu keyboard to this reply.
   *
   * ONE reply sets it — the answer to `/start` — because Telegram keeps a
   * `ReplyKeyboardMarkup` shown until something replaces or removes it, and nothing in
   * this product removes it. Re-sending it on every reply would be a second copy of a
   * keyboard the customer already has, and would fight with the inline keyboards the
   * contextual flows attach.
   */
  readonly keyboard?: MainMenuVariant;
  /**
   * Send this reply AS a file, with `key`/`values` as its caption and `buttons` on it.
   *
   * Payment File 02 §10: a reviewer's receipt item is ONE message — the image, the
   * context and the decisions together. The file is re-sent by `file_id` from the bot that
   * RECEIVED it (a `file_id` is scoped to that bot), so this carries its own bot instance.
   *
   * When Telegram REFUSES the file — a file gone from Telegram, or a reviewer who never
   * opened that bot — the same key, values and buttons go out as an ordinary text
   * message from the bot the reviewer is talking to, so the facts and the decisions still
   * arrive. Not on UNKNOWN or RATE_LIMITED: the file may have arrived, or the text would be
   * refused the same way.
   */
  readonly media?: ReplyMedia;
  /**
   * Further files, sent bare after the reply: a payment's second and later receipts. Best
   * effort and not the turn's outcome, like `followUpKey`.
   */
  readonly attachments?: readonly ReplyMedia[];
  /**
   * Messages sent BEFORE the reply, in order, each without buttons: the referral
   * banner ahead of its text, the earlier pages of a long FAQ ahead of the last one
   * that carries the keyboard. A TEXT lead that does not deliver stops the turn there,
   * so the customer never sees a keyboard without the text it belongs to; a PHOTO lead
   * is decorative and its failure costs the customer nothing but the picture.
   */
  readonly lead?: readonly LeadMessage[];
  /**
   * R3: EDIT the message the tapped button is on into this reply, rather than sending a
   * new one — the service card redrawn after a refresh, the link-change question put in
   * the card's place and the card put back after it.
   *
   * Only a callback carries a message to edit; any other turn sends as usual. When
   * Telegram cannot edit it (deleted, too old, a photo with no text) the SAME reply is
   * sent once as a new message — the smallest fallback, and the only one.
   */
  readonly edit?: boolean;
  /**
   * R3: a short notice on the tapped button (`answerCallbackQuery` text), from a template.
   * Used with `key: null` where the answer must leave the card exactly as it is — a
   * refresh that could not read the panel, a switch that is not available.
   */
  readonly toast?: { readonly key: TemplateKey; readonly values: TemplateValues };
}

export type LeadMessage =
  | { readonly kind: 'TEXT'; readonly key: TemplateKey; readonly values: TemplateValues }
  | {
      readonly kind: 'PHOTO_BYTES';
      readonly bytes: Uint8Array;
      readonly mimeType: 'image/png' | 'image/jpeg';
      readonly fileName: string;
      /**
       * R1: the picture's CAPTION, when the photo is a message in its own right — the
       * referral invite, whose banner, introduction and link must be ONE message so that
       * forwarding it forwards all three. A captioned photo is not decorative: when
       * Telegram refuses it the caption goes out as text instead, and when that fails the
       * turn stops there, as a text lead's does.
       */
      readonly caption?: { readonly key: TemplateKey; readonly values: TemplateValues };
    }
  /**
   * Spec §7: a client app's tutorial video, by the `file_id` THIS bot received. Decorative,
   * like a bare photo: a refusal drops it and the reply goes on.
   */
  | { readonly kind: 'VIDEO_FILE'; readonly fileId: string };

/** One file this installation already holds, and the bot that holds it. */
interface ReplyMedia {
  readonly botInstanceId: BotInstanceId;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  readonly fileId: string;
}

/*
 * The reviewer's caption is built by ONE application function the pull item and the push
 * share (`receipt-review-caption.ts`); these are re-exported for the tests that pin them.
 */
export { RECEIPT_REVIEW_NOTE_MAX, reviewNoteOf };

/**
 * A refusal the customer can be told about.
 *
 * The three product codes collapse to ONE message, deliberately: the operational log and
 * the Web Admin name which of withdrawn, unpriced and unbound it was, and the customer
 * can act on none of them. "This plan has no panel" tells them about our configuration.
 *
 * Anything NOT in this map is re-thrown. That is the important half — a bug in the order
 * path must not be reported to a customer as "this is unavailable", which would make
 * every failure look like an ordinary product state and leave nothing in the operational
 * log. The webhook's catch records it and still answers 200.
 */
export const REFUSAL_REPLIES: Readonly<Record<string, TemplateKey>> = {
  /*
   * The five username refusals, and they are five sentences rather than one.
   *
   * `INVALID` and `TAKEN` answer a name the customer TYPED, so both end with "send
   * another one" and only those two do. `EXHAUSTED` and `UNGENERATABLE` answer a name
   * they never saw — there is nothing for them to choose differently, and telling them
   * to try a different name would be advice they cannot follow. `STALE` is the one
   * that asks them to choose again for a reason that is nobody's fault. All five are
   * raised before any debit and every body says so.
   */
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_INVALID]: 'bot.username.invalid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN]: 'bot.username.taken',
  /*
   * WP8. ONE sentence for every reason a code is refused — unknown, exhausted, out of
   * window, not for this plan — because a bot that told them apart would be an oracle
   * for guessing codes. The window stays open, so the customer can type another.
   */
  [COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED]: 'bot.discount.rejected',
  /*
   * At confirmation: a discount the summary included no longer holds. Nothing was
   * charged and the order was not re-priced — the customer starts again and sees the
   * quote as it now stands.
   */
  [COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID]: 'bot.discount.no_longer_valid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED]: 'bot.username.exhausted',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE]: 'bot.username.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE]: 'bot.username.mode_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE]: 'bot.username.stale',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE]: 'bot.order.unavailable',
  // The SAME sentence as the others, deliberately. A customer told "this is for
  // resellers" learns a tenant's pricing structure from a refusal.
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE]: 'bot.order.unavailable',
  /*
   * A reseller whose tier does not grant this purchase (`docs/wp9-reseller-audit.md` R6):
   * the SAME sentence as `PRODUCT_NOT_FOR_AUDIENCE`, so the bot does not enumerate a
   * tier's grants — which operation, product, panel or bot it lacked is in the refusal's
   * detail and the audit row. It was unmapped, so `refusal` rethrew it and a reseller
   * following a product button they were not entitled to was answered with silence.
   */
  [COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED]: 'bot.order.unavailable',
  /*
   * At confirmation: the reseller's price changed since the summary (R9). The reseller
   * counterpart of `DISCOUNT_NO_LONGER_VALID` — nothing was charged, the order was not
   * re-priced, and they start again. Unmapped until the PR #69 review, which is silence.
   */
  [COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED]: 'bot.order.terms_changed',
  /*
   * Package D. Off, not offered here, or not priced: one sentence, like
   * `bot.order.unavailable` — the audit row carries which. A changed rule at confirmation
   * and an extension of a custom service each have their own.
   */
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_DISABLED]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_UNAVAILABLE]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_TERMS_CHANGED]: 'bot.custom_service.terms_changed',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_NOT_EXTENDABLE]: 'bot.custom_service.not_extendable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE]: 'bot.order.unavailable',
  /*
   * The two category refusals, answered with the SAME sentence as the five above.
   *
   * `PRODUCT_NOT_CATEGORISED` is an operator's half-finished product and
   * `CATEGORY_NOT_PURCHASABLE` is a whole section they have switched off; a customer
   * holding a direct reference can reach either, because the confirmation transaction
   * re-decides under its own lock rather than trusting the list the message was drawn
   * from. Neither is something the buyer can act on, and naming which one it was would
   * tell them how the seller has arranged their shop. The reason is in the refusal's
   * detail and the audit row, which is where an operator looks.
   *
   * HIDDEN is deliberately absent: it is not a refusal at all. A hidden category is
   * left out of the lists and stays orderable through a reference the customer already
   * holds, which is exactly what distinguishes it from INACTIVE.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_CATEGORISED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.CATEGORY_NOT_PURCHASABLE]: 'bot.order.unavailable',
  /*
   * The panel is archived, disabled, confirmed down, or full — and the customer is
   * told none of that.
   *
   * The same sentence as the four above, for the reason `PRODUCT_NOT_FOR_AUDIENCE`
   * gets it: which of somebody's machines is full, or unreachable, is an operational
   * fact about the seller's infrastructure. What the buyer needs is that this plan
   * cannot be bought right now, which is what the template says. The REASON is in the
   * refusal's detail, the audit row and the operations log, where an operator looks.
   */
  [COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE]: 'bot.order.unavailable',
  // An order that is gone, or that belongs to somebody else — the service answers both
  // the same way on purpose, so this does too.
  [COMMERCE_ERROR_CODES.ORDER_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The ORDER, not the product. `bot.order.unavailable` says a PLAN cannot be bought,
   * and the ordinary way to reach this code is a customer tapping the pay button a
   * second time on the message they just paid from — the buttons stay in the chat
   * after settlement. Telling somebody who has just been debited that their service is
   * unavailable is the class of untruth 4C rewrote `bot.order.settled` to remove.
   */
  [COMMERCE_ERROR_CODES.ORDER_STATE_INVALID]: 'bot.order.not_awaiting_payment',
  [COMMERCE_ERROR_CODES.ORDER_EXPIRED]: 'bot.order.expired',
  // Reachable despite the surface's own check: an operator can block a customer between
  // the resolve and the order write, and the service refuses it inside the transaction.
  [COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED]: 'bot.blocked',
  /*
   * A rail this installation cannot perform. NAMED rather than hidden — the button is
   * not drawn, and a customer holding an older message still gets a sentence that says
   * what happened instead of "unknown command".
   */
  [COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE]: 'bot.payment.unconfigured',
  /*
   * The order is still live and this rail cannot be used inside what is left of it.
   *
   * Its own key rather than `bot.order.expired`, because the two say different things
   * to the same customer: that one means the window has closed, this one means it is
   * about to and a transfer started now could not be confirmed afterwards. The remedy
   * is the same — order again — and saying which is which is what stops a customer
   * transferring money against a reference that dies before it arrives.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_WINDOW_TOO_SHORT]: 'bot.payment.window_too_short',
  [COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The three top-up refusals. Every code a customer path can throw MUST be here: an
   * unmapped one makes `refusal` rethrow, the webhook swallows it by design, and the
   * customer is answered with silence while a durable write may have committed. That is
   * F5R-12 on this branch and it cost a whole debugging session.
   */
  [COMMERCE_ERROR_CODES.TOPUP_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.TOPUP_BELOW_MINIMUM]: 'bot.wallet.topup_refused',
  /*
   * The typed top-up's ceiling (`wallet.topup.maximum`, customer UX completion §F),
   * mapped to the same generic sentence for now so the code is never unanswered. The
   * typed-amount flow that renders `bot.wallet.topup_above_maximum` with the figure
   * reads the ceiling itself before the service is asked; this entry is the backstop
   * for the transaction refusing what the prompt admitted a moment earlier.
   */
  [COMMERCE_ERROR_CODES.TOPUP_ABOVE_MAXIMUM]: 'bot.wallet.topup_refused',
  /*
   * And the two the payment ROUTE can throw (Phase 5C), mapped to the same two
   * sentences rather than to new ones — because they are the same two facts.
   *
   * `PAYMENT_GATEWAY_UNAVAILABLE` means no route can carry this payment right now, for
   * any of four reasons the customer cannot act on and must not be told apart: three
   * are the operator's thresholds and naming which one refused would tell whoever holds
   * this chat how the installation's payment gating is configured. "This is not
   * available at the moment" is the whole of what the customer can use.
   *
   * `PAYMENT_GATEWAY_AMOUNT_REJECTED` means a preset falls outside what the route
   * accepts, which is a MISCONFIGURATION — the same class as `TOPUP_BELOW_MINIMUM`, and
   * it shares that key's copy for the reason that key exists: telling a customer an
   * amount is "unavailable" while the button sits on their screen sends them looking
   * for it again.
   *
   * Both are here rather than left unmapped, which is not a formality: an unmapped code
   * makes `refusal` RETHROW, the webhook swallows it by design, and the customer is
   * answered with silence. That is F5R-12, and it cost a whole debugging session.
   */
  /*
   * The three the 5F flow pass found reaching a customer with NO entry here, which
   * means `refusal` rethrew, the webhook swallowed it, and the customer was answered
   * with silence. All three are generic on purpose — see `bot.request_unavailable`.
   *
   * `PAYMENT_DESTINATION_UNCONFIGURED` is the one the code already predicted:
   * `requestManualTransfer` says in so many words that the surface draws the transfer
   * button from a read that can be a moment stale, so the last enabled account can be
   * disabled between the button and the tap, "and this is where that lands". It landed
   * nowhere. `bot.payment.unconfigured` is the truthful answer — from the customer's
   * side a method with nowhere to send money is a method that is not available.
   *
   * `COMMERCE_REQUEST_INVALID` is `assertScopeActive`: an installation that has stopped
   * accepting work, refusing a tap that was already on screen.
   *
   * `CUSTOMER_NOT_FOUND` is `settleFromWallet`'s `lockCustomer` — unreachable in
   * practice, because nothing deletes a customer, and mapped anyway: the cost of an
   * entry is one line and the cost of a missing one is a customer who taps pay and is
   * told nothing.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_DESTINATION_UNCONFIGURED]: 'bot.payment.unconfigured',
  [COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND]: 'bot.request_unavailable',
  /*
   * The FALL-THROUGH for insufficient funds, not its reply.
   *
   * `walletPurchase` catches this code and answers `bot.wallet.insufficient` with the
   * shortfall, which is the useful reply and stays the one a customer gets. But that
   * catch requires `shortfallOf(details)` to yield a figure, and when it does not it
   * falls through to `refusal` — onto this code, which had no entry. So the one case
   * the fall-through exists for was the one case that said nothing.
   */
  [COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED]: 'bot.wallet.topup_refused',
  /*
   * The four receipt refusals, and they are four SENTENCES because the remedy differs.
   *
   * Collapsing them into one would be the legacy system's "unknown command" for a
   * customer who did exactly what they were asked: nothing was expected, the window
   * closed, the payment is full, and the payment is no longer pending are four different
   * situations and three of them have an action the customer can take.
   */
  [COMMERCE_ERROR_CODES.RECEIPT_NOT_EXPECTED]: 'bot.payment.receipt_not_expected',
  [COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED]: 'bot.payment.receipt_expired',
  [COMMERCE_ERROR_CODES.RECEIPT_LIMIT_REACHED]: 'bot.payment.receipt_limit',
  /*
   * The payment, not the order. Its own key since 4G made the state reachable.
   *
   * A customer meets this by scrolling back to a message that was live when it was
   * sent and pressing the button on it — after the sweep expired the payment, after an
   * operator rejected it, or after they withdrew it themselves. Answering "this service
   * is not available" reads as a fault in the product; saying the payment is no longer
   * pending says what happened.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID]: 'bot.payment.not_pending',
  /*
   * The order is LIVE and the customer's own earlier claim is what stops them.
   *
   * Its own key rather than `bot.order.not_awaiting_payment`, which says the order can
   * no longer be acted on — the opposite of what is true here. A customer told the
   * wrong one of those two taps again, because the sentence they read describes a
   * situation they can see is false.
   */
  [COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW]: 'bot.order.transfer_under_review',
  // Package A, Codex review of #85: a Stars payment approved at checkout is on its way.
  [COMMERCE_ERROR_CODES.PAYMENT_CHECKOUT_IN_PROGRESS]: 'bot.payment.checkout_in_progress',
  /*
   * The guard refused. ONE sentence for every reason it gives, exactly as the product
   * refusals collapse: the customer can act on none of "the amount does not match", "the
   * currency does not match" and "another customer's payment", and each of them tells
   * them something about our data. The `reason` detail is in the audit row and the
   * operational log, which is where it is useful.
   */
  [COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED]: 'bot.order.unavailable',
  /*
   * This entry is for `WALLET_CURRENCY_UNSUPPORTED`, and the comment here used to
   * describe a DIFFERENT code — it explained a fallback for
   * `WALLET_INSUFFICIENT_FUNDS`, which is not the key below and is not in this map.
   *
   * What is actually true of each:
   *
   * - `WALLET_INSUFFICIENT_FUNDS` is answered inside `walletPayment`, because
   *   `bot.wallet.insufficient` renders the shortfall and this map carries no values.
   *   It has NO entry here, so if that handler could not read the shortfall the turn
   *   would reach `refusal`'s `throw` and the customer would get no reply. It cannot
   *   today: the service always attaches a positive `shortfallMinor` bounded by
   *   `PAYMENT_AMOUNT_MAX_MINOR` and a valid `currency`, which is exactly what
   *   `shortfallOf` parses. Left as is rather than given a key that would exist for an
   *   unreachable branch — but stated, because the previous comment implied a
   *   protection that is not here.
   * - `WALLET_CURRENCY_UNSUPPORTED` has no Telegram producer at all: only
   *   `WalletService.adjust` raises it and no customer path calls that. It stays
   *   listed because an unlisted code is the failure mode, not a tidy absence.
   */
  [COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED]: 'bot.order.unavailable',
  /*
   * The commercial refusals, split exactly where the CUSTOMER's next step differs.
   *
   * `SERVICE_ACTION_NOT_ALLOWED` is the service's own state — a terminated service
   * cannot be renewed, a suspended one cannot be topped up — and that is something the
   * customer can act on, so it says so.
   *
   * `SERVICE_ACTION_UNAVAILABLE` and the two add-on refusals are CONFIGURATION: nothing
   * is offered, the plan was withdrawn, the package was deactivated between the list
   * and the tap. One sentence for all three, because the customer's next step is the
   * same and naming which would describe an operator's configuration to them — the same
   * reasoning `PRODUCT_NOT_FOR_AUDIENCE` follows above. The operational log and the
   * audit row carry the distinction an operator needs.
   *
   * `PANEL_NOT_OPERABLE` used to be absent here, with a comment saying it "stays with
   * 4E's `bot.service.capability_unsupported`". That was FALSE, and the falsehood is
   * worth recording because it is the shape this map exists to prevent: 4E answers the
   * code inside `serviceAction`, which the commercial handlers never pass through. They
   * go to `refusal`, an unmapped code reaches its `throw`, and the customer who tapped
   * a renewal button drawn before the operator disabled the panel got no reply at all —
   * the exact "unknown code, no answer" failure the `WALLET_INSUFFICIENT_FUNDS` note
   * above spells out. It is the SAME sentence 4E uses, reached the ordinary way.
   *
   * `SERVICE_ACTION_IN_PROGRESS` is the one TRANSIENT refusal in this group and gets
   * its own sentence for that reason: every other answer here means "not for you" or
   * "not offered", and this one means "try again in a moment". Telling a customer whose
   * renewal is seconds from being applied that the action is unavailable would send
   * them to support over a wait.
   */
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED]: 'bot.service.action_not_allowed',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_FOUND]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE]: 'bot.service.capability_unsupported',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS]: 'bot.service.action_in_progress',
  /*
   * WP-A6: the three location-change refusals a customer can act on, each its own
   * sentence — already there, moved too recently, no changes left in the period.
   */
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION]: 'bot.service.location_same',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN]: 'bot.service.location_cooldown',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED]: 'bot.service.location_limit',
  /*
   * A renewal priced in a unit this store has stopped selling.
   *
   * Reachable from a callback drawn before `sales.currency` moved: `availableFor` and
   * `offer` both filter on it now, and neither un-draws a message already in the chat.
   * The configuration sentence, because that is what it is.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED]: 'bot.service.action_unavailable',
  // The customer UX completion's refusals. The ones that carry a figure (a bound, a
  // maximum) are answered by their handlers, which have the figure.
  [COMMERCE_ERROR_CODES.SERVICE_SYNC_TOO_SOON]: 'bot.service.refresh_too_soon',
  [COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED]: 'bot.referral.gift_disabled',
  [COMMERCE_ERROR_CODES.CAPTURE_NOT_OPEN]: 'bot.wallet.topup_expired',
};

/**
 * The refusal keys that need a VALUE, and the value each one needs.
 *
 * Almost every refusal is a bare sentence, which is why `refusal` supplied `{}` for all
 * of them. `bot.payment.receipt_limit` is not: it declares a required `{limit}` so that
 * `PAYMENT_RECEIPT_MAX_PER_PAYMENT` and the Persian text cannot disagree — and the
 * resolver VALIDATES values against the declaration, so the empty object refused the
 * whole render and the customer was told nothing at all.
 *
 * That is the second instance of one defect on this branch (the first was the receipt
 * prompt's `minutes`), which is why `bot-runtime.test.ts` now asserts the RULE rather
 * than this row: every key in `REFUSAL_REPLIES` must have every required token supplied
 * here. A key added with a placeholder and no entry fails that test instead of failing
 * silently in front of a customer.
 */
const REFUSAL_VALUES: Readonly<Partial<Record<TemplateKey, TemplateValues>>> = {
  'bot.payment.receipt_limit': { limit: PAYMENT_RECEIPT_MAX_PER_PAYMENT },
};

export function refusalValuesFor(key: TemplateKey): TemplateValues {
  return REFUSAL_VALUES[key] ?? {};
}

/** Whether `refusal` answers this error with a sentence, rather than rethrowing it. */
function hasRefusalReply(error: unknown): boolean {
  return isNexaError(error) && REFUSAL_REPLIES[error.code] !== undefined;
}

function refusal(error: unknown): PendingReply {
  const key = isNexaError(error) ? REFUSAL_REPLIES[error.code] : undefined;
  if (key === undefined) throw error;
  return { key, values: refusalValuesFor(key), buttons: [], orderId: null };
}

/** The external gateway cannot be used right now (WP11A): never the customer's failure. */
function gatewayUnavailable(): PendingReply {
  return {
    key: 'bot.payment.gateway_unavailable',
    values: {},
    buttons: [mainMenuButton()],
    orderId: null,
  };
}

/**
 * A refusal of an external-gateway request. The route being off, unconfigured or unable
 * to take this amount is "unavailable" (the shared table would answer a top-up sentence
 * for `PAYMENT_GATEWAY_UNAVAILABLE`); everything else goes through the shared table.
 */
function gatewayRefusal(error: unknown): PendingReply {
  if (!isNexaError(error)) return refusal(error);
  /*
   * Package FX: a route priced by the central exchange rate, with no usable rate right
   * now (every source down past the stale limit, or the feature off). Its own sentence,
   * because the remedy differs from a route that is off: try again shortly, or pay
   * another way. It names no source and no figure.
   */
  if (
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE &&
    typeof error.details === 'object' &&
    error.details !== null &&
    (error.details as { reason?: unknown }).reason === FX_UNAVAILABLE_REASON
  ) {
    return {
      key: 'bot.payment.fx_unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }
  if (
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE ||
    error.code === COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE ||
    error.code === COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED
  ) {
    return gatewayUnavailable();
  }
  return refusal(error);
}

/**
 * A customer's withdrawal of a transfer, refused (Payment File 02 §9, D1).
 *
 * `ORDER_TRANSFER_UNDER_REVIEW` from `withdrawPending` means a RECEIPT is filed against
 * the payment, and the shared table's sentence for that code is about cancelling an ORDER
 * — false for a wallet top-up, which has none. So this one refusal gets a sentence about
 * the payment; every other goes through the shared table unchanged.
 */
export function withdrawalRefusal(error: unknown): PendingReply {
  if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW) {
    return { key: 'bot.payment.withdraw_under_review', values: {}, buttons: [], orderId: null };
  }
  return refusal(error);
}

/**
 * The decisions a receipt's message carries, for ONE administrator — the builder the pull item
 * and the administrators' push both use, so the two messages cannot offer different buttons.
 *
 * Each button is drawn only for the key its path charges, and each key gates its own:
 *
 *   - approve and reject: `receipts.review` (`receipts.view` opens the item, and the seeded
 *     observer holds it without the review key);
 *   - credit to wallet: `receipts.review` AND `users.wallet.credit`, both of which the credit
 *     charges;
 *   - block the customer: `users.block`, INDEPENDENT of `receipts.review` — it is the customers
 *     section's permission, and a support administrator who may block but not decide money
 *     gets that one button and no other.
 *
 * Advertising only: every tap is charged again by the path behind it.
 */
export function receiptReviewButtons(
  paymentId: string,
  permissions: ReadonlySet<PermissionKey>,
  available: { readonly credit: boolean; readonly block: boolean },
): CustomerButton[] {
  const buttons: CustomerButton[] = [];
  if (permissions.has(RECEIPTS_REVIEW_PERMISSION)) {
    buttons.push(
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.approve_button' },
        data: `${ADMIN_APPROVE_CALLBACK_PREFIX}${paymentId}`,
        row: 0,
      },
      {
        label: { kind: 'TEMPLATE', key: 'bot.admin.reject_button' },
        data: `${ADMIN_REJECT_CALLBACK_PREFIX}${paymentId}`,
        row: 0,
      },
    );
    if (available.credit && permissions.has(WALLET_CREDIT_PERMISSION)) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.credit_button' },
        data: `${ADMIN_CREDIT_CALLBACK_PREFIX}${paymentId}`,
        row: 1,
      });
    }
  }
  if (available.block && permissions.has(CUSTOMERS_BLOCK_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.block_button' },
      data: `${ADMIN_BLOCK_ASK_CALLBACK_PREFIX}${paymentId}`,
      row: 1,
    });
  }
  return buttons;
}

/**
 * The four buttons of a refund request's review card (brief §2.5). Approve and reject are
 * decisions; "view user" and "view service" reuse the administrators' own navigation, so the
 * card adds no second way of showing either. Drawn only to an administrator the push lane
 * already found holding both decision keys, and every tap is charged again behind it.
 *
 * The two view buttons open panel sections, which `adminTurn` admits only for their own view
 * keys, so each is drawn only for a recipient holding it (Codex review of #83, round 10). A
 * reviewer with the two decision keys alone is sent the two buttons that work for them, not
 * two more that would answer as if they were a customer. `receiptReviewButtons` draws the
 * same way.
 */
export function refundRequestReviewButtons(
  request: {
    readonly id: string;
    readonly customerId: string;
    readonly serviceId: string;
  },
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  const buttons: CustomerButton[] = [
    {
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_approve_button' },
      data: `${ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX}${request.id}`,
      row: 0,
    },
    {
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_reject_button' },
      data: `${ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX}${request.id}`,
      row: 0,
    },
  ];
  if (permissions.has(CUSTOMERS_VIEW_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_user_button' },
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${request.customerId}`,
      row: 1,
    });
  }
  if (permissions.has(SERVICES_VIEW_PERMISSION)) {
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_service_button' },
      data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${request.serviceId}`,
      row: 1,
    });
  }
  return buttons;
}

/**
 * What a blocked customer is told (File 01 §9, the owner's correction to WP10): the account is
 * blocked, WHY — the reason stored on THIS customer's own row, and nothing else of the block's
 * record — and to contact support. A block with no reason keeps `bot.blocked`, a whole sentence
 * with no empty "reason" line in it.
 *
 * Only a reason written to be shown is shown (pre-release hardening V2): until WP10's follow-up
 * the Web Admin told the operator this note "is never shown to the customer", and a block
 * written then keeps `blockedReasonShown` FALSE and is answered with `bot.blocked`. The
 * customers section's old fixed English note ("Blocked from the Telegram management panel.")
 * is the same case: migration 0121 marks those rows not shown, so the flag alone decides and
 * no typed reason is reserved (Codex review of PR #74).
 */
export function blockedReply(
  customer: Pick<CustomerRecord, 'blockedReason' | 'blockedReasonShown'>,
): PendingReply {
  const reason = customer.blockedReason?.trim() ?? '';
  // Anti-spam's own block is answered in the owner's own sentence (WP20, brief §3.5).
  if (reason === ANTI_SPAM_BLOCK_REASON) {
    return { key: 'bot.blocked_spam', values: {}, buttons: [], orderId: null };
  }
  if (!customer.blockedReasonShown || reason === '') {
    return { key: 'bot.blocked', values: {}, buttons: [], orderId: null };
  }
  return { key: 'bot.blocked_with_reason', values: { reason }, buttons: [], orderId: null };
}

/**
 * R2: one message this bot sent, edited in place through R3's `edit` port — its text — or,
 * for a file whose caption carries the text (a reviewer's receipt), `editCaption`. A
 * messenger without the method answers REFUSED `NOT_EDITABLE`, which every caller already
 * treats as "send it instead" (R3's one fallback).
 */
export async function editSent(
  messenger: CustomerMessenger,
  scope: TenantContext,
  message: CustomerEditMessage,
  caption: boolean,
): Promise<CustomerSendResult> {
  if (caption) {
    return messenger.editCaption === undefined
      ? { outcome: 'REFUSED', reason: 'NOT_EDITABLE' }
      : messenger.editCaption(scope, message);
  }
  return messenger.edit === undefined
    ? { outcome: 'REFUSED', reason: 'NOT_EDITABLE' }
    : messenger.edit(scope, message);
}

/** R2: a reply, with what it does to the receipt-review messages of its payment. */
function withReview(review: ReviewDirective, reply: PendingReply): PendingReply {
  return { ...reply, review };
}

/** The rejection capture's cancel button. */
function rejectCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.reject_cancel_button' },
    data: `${ADMIN_REJECT_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/** The customers section's block cancel button (WP10G): `9:x:<captureId>`. */
function customerBlockCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
    data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}x:${captureId}`,
  };
}

/** Block User's cancel button. */
function blockCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
    data: `${ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/** The capture's cancel button. */
/** Abandons a refund request's amount or reason prompt (WP19). */
function refundRequestCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_cancel_button' },
    data: `${ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

function creditCancelButton(captureId: string): CustomerButton {
  return {
    label: { kind: 'TEMPLATE', key: 'bot.admin.credit_cancel_button' },
    data: `${ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX}${captureId}`,
  };
}

/**
 * What a reviewer is told when the credit path refuses (Payment File 02 §11–§12).
 *
 * Four refusals have a sentence, and each is a fact about the PAYMENT rather than about
 * other administrators: already decided (approve, reject or another credit won the
 * conditional UPDATE — the answer a stale approve button gets), no receipt, and a currency
 * the installation no longer sells in. Everything else — a permission denied above all —
 * is rethrown to `adminTurn`'s one refusal, `bot.admin.refused`, for the reason that
 * catch states.
 */
export function creditRefusal(error: unknown): PendingReply {
  if (isNexaError(error)) {
    if (error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID) {
      return error.details['reason'] === 'NO_RECEIPT'
        ? { key: 'bot.admin.credit_no_receipt', values: {}, buttons: [], orderId: null }
        : { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }
    if (error.code === COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND) {
      return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }
    if (error.code === COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED) {
      return { key: 'bot.admin.credit_currency', values: {}, buttons: [], orderId: null };
    }
  }
  throw error;
}

/**
 * One turn of the customer-facing bot.
 *
 * The ORDER is the contract, and it is the same order `CLAUDE.md` fixes for the backup
 * pipeline and ADR-0028 fixes for recovery:
 *
 *   1. resolve and commit the state change — the customer exists, their profile is
 *      fresh, `last_seen_at` has moved;
 *   2. THEN send, outside any transaction.
 *
 * Never the other way round and never in one transaction. A send inside the transaction
 * could be rolled back after Telegram had delivered it, and a failed send must not undo
 * the fact that the customer arrived. `telegramSend` asserts the second half of that by
 * refusing to run inside a transaction at all.
 *
 * Nothing here throws for a send failure. A throw becomes a non-2xx, a non-2xx makes
 * Telegram redeliver the update, and a redelivered update whose only problem was a
 * failed reply is an unbounded loop that bumps `last_seen_at` for ever.
 */
export class BotRuntime {
  constructor(private readonly deps: BotRuntimeDeps) {}

  /**
   * The route table for this update (R1): the shared defaults, then this tenant's current
   * labels over them. Read only for a TEXT message — a keyboard tap is text, and nothing
   * else consults the table, so a callback or a file pays for no template rendering.
   */
  private async menuFor(scope: TenantContext, update: unknown): Promise<MainMenuRoutes> {
    const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
    if (typeof text !== 'string' || this.deps.menuRoutes === undefined) return this.deps.mainMenu;
    return new Map([...this.deps.mainMenu, ...(await this.deps.menuRoutes.routesFor(scope))]);
  }

  async handle(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
      readonly from: unknown;
    },
  ): Promise<BotTurnResult> {
    const command = intentOf(input.update, await this.menuFor(scope, input.update));
    const { intent } = command;

    /*
     * 0. Anti-spam (WP20, brief §3.4), before any work.
     *
     * Every interaction is counted — text, commands (`/start` included), button presses,
     * media — once per `update_id`, so Telegram redelivering an update does not count it
     * twice. Counted whatever it claims to be: an intent is only what the update SAYS, and
     * exempting admin-shaped callbacks would let any customer flood with `C:<uuid>` taps
     * uncounted. Who is an administrator is decided below, by the binding, and only once
     * the limit is crossed — so the ordinary turn pays for no extra lookup.
     *
     * Fails open: when the counter cannot be read the verdict is ALLOWED.
     */
    // One reader of `update_id` for the runtime (shared with WP19's prompt ordering).
    const numericUpdateId = updateIdOf(input.update);
    const updateId = numericUpdateId === undefined ? null : String(numericUpdateId);
    const counted =
      this.deps.antiSpam === undefined || updateId === null
        ? null
        : await this.deps.antiSpam.observe(scope, {
            botInstanceId: input.botInstanceId,
            telegramUserId: input.telegramUserId,
            updateId,
          });

    /*
     * 1. The state change, committed.
     *
     * Runs for every intent this runtime SEES, not only `/start`. The customer's
     * existence and their `last_seen_at` are facts about any contact, and a "last seen"
     * that only moved on `/start` would be a column an operator reads as activity and
     * is not.
     *
     * One update never reaches here: `/ping`, which the webhook answers and returns
     * from. That is an idempotency-key collision rather than a product decision, and
     * `webhook.controller.ts` states it where the `return` is — named here too, because
     * "every intent" is the sentence a reader would otherwise take as complete.
     */
    const resolved = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      telegramUserId: input.telegramUserId,
      from: input.from,
      botInstanceId: input.botInstanceId,
      // A referral link's code, on the `/start` it opened (WP9 F2). Null on anything else.
      startPayload: intent === 'START' ? startPayloadOf(input.update) : null,
    });
    let { customer, arrival } = resolved;

    /*
     * A bound administrator is staff, not a customer, and anti-spam is a rule about
     * customers (brief §3.4). Asked of the binding — the one authority on who is an
     * administrator — and only when the count has crossed the limit.
     */
    const spam =
      counted !== null &&
      counted.verdict !== 'ALLOWED' &&
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
        ? null
        : counted;

    /*
     * The 21st interaction, or a later one whose block has not landed yet, blocks the
     * customer (brief §3.5) through the one block path there is, with the owner's reason,
     * as `SYSTEM_JOB`. Conditional on ACTIVE, so concurrent triggers change the row once
     * and an administrator's block that got there first keeps its own reason. The
     * triggering update then takes the BLOCKED branch below: it never reaches `act`, so it
     * cannot start any commercial work.
     */
    let blockedThisTurn = false;
    if (spam !== null && spam.verdict !== 'ALLOWED' && arrival !== 'BLOCKED') {
      const outcome = await this.deps.customers.blockForSpam(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:anti-spam`,
        customerId: customer.id,
        interactions: spam.count ?? 0,
      });
      customer = outcome.customer;
      arrival = 'BLOCKED';
      blockedThisTurn = outcome.changed;
    }

    /*
     * 2. The commercial work, still before any send.
     *
     * A BLOCKED customer never reaches it: `replyFor` answers `bot.blocked` whatever they
     * asked for, and this is gated on the same condition rather than on its own copy of
     * the rule. The order service refuses a blocked customer too — that is the
     * authoritative check, inside the transaction, and this one exists so the surface
     * does not ask for work it already knows will be refused.
     *
     * ADMIN INTENTS ARE EXEMPT, and the exemption is the identity model rather than a
     * convenience.
     *
     * A Telegram account that is bound as an administrator is ALSO resolved as a customer
     * here, because it is the same account. Customer standing and administrator standing
     * are independent in this product — `docs/research` records the legacy system
     * treating them as "mutually blind", and Phase 4A kept them separate deliberately. So
     * a blanket `bot.blocked` meant that blocking somebody's PURCHASES silently revoked
     * their management panel: the intent never reached `adminTurn`, and the only way back
     * was to unblock the customer, which is not what the operator who pressed Block
     * decided.
     *
     * Blocking is still enforced for everything a customer can do. This routes the admin
     * intents to the one door that resolves the binding, and `adminTurn` returning null —
     * a blocked customer who is NOT an administrator, including one crafting `D:<uuid>` —
     * falls back to the same `bot.blocked` as before. Authority is not granted here: every
     * admin action re-checks its own permission inside its own transaction.
     */
    // File 01 §9: the reason stored on THIS customer's own row, read as this turn resolved it.
    const blocked: PendingReply = blockedReply(customer);
    /*
     * A blocked customer's plain message still reaches their amount capture when they are
     * an administrator with one open — the same exemption the admin intents have, for the
     * same reason: blocking somebody's purchases is not revoking their panel.
     */
    const blockedAdminText =
      arrival === 'BLOCKED' && command.intent === 'USERNAME_TEXT' && command.args?.[0] !== undefined
        ? await this.adminCaptureText(scope, actor, command.args[0], input)
        : null;
    /*
     * R2 (items 3 and 5): the two gates a tap passes BEFORE any work runs.
     *
     * A receipt-review tap on a message already finalised into its decision is answered —
     * `answerCallbackQuery`, below — and nothing else: the decision is never asked for a
     * second time, and no message is sent or edited.
     *
     * A wizard tap claims its message: honoured only while the message still shows the
     * screen the button belongs to and no other turn holds it. A stale tap is answered the
     * same way, so a double tap or an old keyboard cannot move the wizard backward or repeat
     * a draft, a payment or an invoice. The services behind every step still re-decide their
     * own writes under their own locks; this only stops the surface asking twice.
     */
    const origin = callbackOriginOf(input.update);
    const state = this.deps.messageState;
    const reviewRecord =
      state !== undefined && origin !== null && REVIEW_TAP_INTENTS.has(command.intent)
        ? await state.findReview(scope, this.refOf(input.botInstanceId, origin))
        : null;
    /*
     * Retention (docs/telegram-retention.md): a review tap on a message with NO row, at or
     * below the chat's purge horizon, is a tap on a message whose row the sweep removed —
     * which it does only once the payment is terminal. Answered and nothing else, like a
     * finalised one: the decision is never asked for again.
     */
    const retiredReview =
      state !== undefined &&
      origin !== null &&
      reviewRecord === null &&
      REVIEW_TAP_INTENTS.has(command.intent) &&
      (await state.reviewTapIsRetired(scope, this.refOf(input.botInstanceId, origin)));
    const repeatedReview = (reviewRecord?.finalisedAt ?? null) !== null || retiredReview;
    const gate = WIZARD_GATES.get(command.intent);
    let claim: TelegramWizardRecord | null = null;
    let staleWizard = false;
    if (state !== undefined && gate !== undefined && origin !== null && arrival !== 'BLOCKED') {
      const claimed = await state.claim(scope, actor, {
        ref: this.refOf(input.botInstanceId, origin),
        kind: gate.kind,
        adoptAs: gate.adoptAs,
        from: gate.from,
        updateKey: input.idempotencyKey,
      });
      if (claimed.outcome === 'CLAIMED') claim = claimed.wizard;
      else if (claimed.outcome === 'STALE') staleWizard = true;
    }
    /*
     * F1 (round N): a repeated review tap is still answered and nothing else — but with the
     * truthful notice of what was decided (e.g. «این پرداخت قبلاً تأیید شده است.»).
     */
    const repeatToast =
      repeatedReview && reviewRecord !== null
        ? await this.repeatedReviewToast(scope, actor, input.telegramUserId, reviewRecord.paymentId)
        : {};
    let answered: PendingReply;
    try {
      answered =
        repeatedReview || staleWizard
          ? { key: null, values: {}, buttons: [], orderId: null, ...repeatToast }
          : arrival === 'BLOCKED'
            ? (blockedAdminText ??
              (ADMIN_INTENTS.has(command.intent)
                ? await this.adminTurn(scope, actor, command, input)
                : null) ??
              // Round N close (§D): a blocked customer's /stop is still their preference.
              // Blocking stops what they can BUY; it does not make a promotion welcome, and
              // a MARKETING send to an audience that admits blocked customers reads this row.
              (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN'
                ? await this.marketingPreference(
                    scope,
                    actor,
                    customer,
                    command.intent === 'MARKETING_OPT_OUT',
                    input.idempotencyKey,
                  )
                : null) ??
              blocked)
            : await this.guardedAct(scope, actor, command, customer, arrival, input);
    } catch (error) {
      // A turn that failed gives its claim back rather than freezing the message for its lease.
      if (state !== undefined && claim !== null) {
        await state.release(scope, actor, claim).catch(() => false);
      }
      throw error;
    }
    /*
     * A blocked customer who is still over the limit is not answered (brief §3.5: protect
     * the transport from outbound amplification). Only the interaction that TOOK the block
     * is told why; every other one past the limit sends nothing, so a flood cannot become
     * one reply per message. A button press is still answered below — `stopSpinner` — so
     * no spinner hangs. Once the customer slows down, each message is answered with the
     * stored reason again.
     *
     * The turn that took the block, whatever its verdict — not "the 21st". The 21st may be
     * a `/ping`, which the webhook answers without blocking, or a turn that failed before
     * its block committed, and the block then lands on a later one; silencing that one
     * blocked the customer without a word. And under concurrency the 21st can lose the
     * block to a later turn, so answering the 21st as well would tell them twice.
     */
    const reply: PendingReply =
      spam !== null &&
      spam.verdict !== 'ALLOWED' &&
      arrival === 'BLOCKED' &&
      answered === blocked &&
      !blockedThisTurn
        ? { key: null, values: {}, buttons: [], orderId: null }
        : answered;

    const chatId = privateChatIdOf(input.update);
    // R2: a reply that sends nothing gives its wizard claim back unchanged.
    if (state !== undefined && claim !== null && (reply.key === null || chatId === null)) {
      await state.release(scope, actor, claim);
    }

    /*
     * 3. The reply, after the commit, and only into a private chat.
     *
     * A REDELIVERED update replies AGAIN, and that is a decision rather than an
     * oversight. Every durable effect above is idempotent — the customer row, the
     * audit rows, the order, the `OrderConfirmed` event — so a replay repeats none of
     * them. The reply cannot join them: Telegram's `sendMessage` has no idempotency
     * key, so "exactly once" is not on offer and the choice is between a duplicate
     * message and a missing one.
     *
     * Telegram redelivers precisely when it did not see a 200, which includes the
     * case where the first turn committed and the send never happened. Suppressing
     * the reply on a replay would leave that customer staring at nothing, for ever,
     * with nothing anywhere saying so — the invisible failure this codebase exists
     * to remove. A second copy of the same summary is visible and self-correcting.
     *
     * What would change this is persisting the SEND OUTCOME and re-sending only when
     * the first one was not `DELIVERED`. That needs a second durable write after the
     * commit, which is a mechanism rather than a line. Nothing sent here costs money
     * to duplicate: the most a customer sees twice is one order summary naming the
     * SAME order, because the idempotency key is the update's.
     */
    if (reply.key === null || chatId === null) {
      await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);
      return {
        intent,
        arrival,
        customerId: customer.id,
        replyKey: reply.key,
        orderId: reply.orderId,
        sent: 'NOT_ATTEMPTED',
      };
    }

    /*
     * R2 (item 3): a receipt decision edits the ORIGINAL review message — and the prompts it
     * opened — in place. Null means there was nothing recorded to edit, and the reply goes
     * out as it always did.
     */
    if (state !== undefined && origin !== null && reply.review?.outcome !== undefined) {
      const reviewed = await this.finaliseReview(
        scope,
        actor,
        reply,
        origin,
        input.botInstanceId,
        input.telegramUserId,
      );
      if (reviewed !== null) {
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: reviewed,
        };
      }
    }

    /*
     * R2 (item 5): a wizard step is the SAME message, edited. Null means the reply is its own
     * message after all — a refusal the customer must be able to come back from, a typed
     * answer no wizard was waiting for — and it goes out as it always did.
     */
    if (state !== undefined && (claim !== null || reply.wizard?.anchor !== undefined)) {
      const edited = await this.editWizard(scope, actor, reply, claim, origin, chatId, input);
      if (edited !== null) {
        if (edited === 'DELIVERED' && reply.followUpKey !== undefined) {
          await this.deps.messenger.send(scope, {
            chatId,
            templateKey: reply.followUpKey,
            values: {},
            botInstanceId: input.botInstanceId,
          });
        }
        if (edited === 'RATE_LIMITED' && reply.fallback !== undefined) {
          await this.deps.queueRateLimitedFact(
            scope,
            customer.id,
            reply.fallback.kind,
            reply.fallback.subjectId,
            undefined,
          );
        }
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: edited,
        };
      }
    }
    // A reply that is its own message after all: a receipt prompt's origin is still recorded.
    if (
      state !== undefined &&
      origin !== null &&
      reply.review?.origin !== undefined &&
      reply.review.paymentId !== null
    ) {
      await state.recordReview(scope, actor, {
        ref: this.refOf(input.botInstanceId, origin),
        paymentId: reply.review.paymentId,
        role: reply.review.origin,
        hasMedia: origin.media,
      });
    }

    // R2: whether the reply went out as text, so a file's text fallback is recorded as text.
    let wentAsText = false;
    const asText = () => {
      wentAsText = true;
      return this.deps.messenger.send(scope, {
        chatId,
        templateKey: reply.key as TemplateKey,
        values: reply.values,
        botInstanceId: input.botInstanceId,
        ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
        ...(reply.keyboard === undefined ? {} : { keyboard: reply.keyboard }),
      });
    };
    /*
     * A reply that IS a file (§10's single review message) goes as the file with this
     * reply as its caption, and falls back to text only on a definite refusal — see
     * `PendingReply.media` for why not on the other two outcomes.
     */
    for (const lead of reply.lead ?? []) {
      let led =
        lead.kind === 'TEXT'
          ? await this.deps.messenger.send(scope, {
              chatId,
              templateKey: lead.key,
              values: lead.values,
              botInstanceId: input.botInstanceId,
            })
          : lead.kind === 'VIDEO_FILE'
            ? await this.deps.messenger.sendFile(scope, {
                chatId,
                botInstanceId: input.botInstanceId,
                kind: 'VIDEO',
                source: { kind: 'FILE_ID', fileId: lead.fileId },
              })
            : await this.deps.messenger.sendFile(scope, {
                chatId,
                botInstanceId: input.botInstanceId,
                kind: 'PHOTO',
                source: {
                  kind: 'BYTES',
                  bytes: lead.bytes,
                  fileName: lead.fileName,
                  mimeType: lead.mimeType,
                },
                ...(lead.kind === 'PHOTO_BYTES' && lead.caption !== undefined
                  ? {
                      caption: { templateKey: lead.caption.key, values: lead.caption.values },
                      // Whole or not at all: a cut invite loses the link at its end.
                      captionWhole: true as const,
                    }
                  : {}),
              });
      /*
       * R1: a CAPTIONED photo is a message, not a decoration (`LeadMessage.caption`).
       * Refused — a broken image, a caption over Telegram's bound — its words go out as
       * text, so the invite still arrives. UNKNOWN is not refused: it may have arrived,
       * and a second copy of the invite would be the duplicate the lane exists to avoid.
       */
      if (lead.kind === 'PHOTO_BYTES' && lead.caption !== undefined) {
        /*
         * Too long to be a caption (a tenant's longer invite; Codex, PR #111): the banner
         * goes bare and the invite follows as its own text, whole, link included. Two
         * messages rather than one cut one — the text is what a customer forwards, and a
         * forwarded invite without its link invites nobody. The bare banner is decorative
         * again, so its own failure is ignored.
         */
        if (led.outcome === 'REFUSED' && led.reason === 'CAPTION_OVER_BOUND') {
          await this.deps.messenger.sendFile(scope, {
            chatId,
            botInstanceId: input.botInstanceId,
            kind: 'PHOTO',
            source: {
              kind: 'BYTES',
              bytes: lead.bytes,
              fileName: lead.fileName,
              mimeType: lead.mimeType,
            },
          });
        }
        if (led.outcome === 'REFUSED') {
          led = await this.deps.messenger.send(scope, {
            chatId,
            templateKey: lead.caption.key,
            values: lead.caption.values,
            botInstanceId: input.botInstanceId,
          });
        }
        if (led.outcome === 'DELIVERED' || led.outcome === 'UNKNOWN') continue;
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: led.outcome,
        };
      }
      if (led.outcome !== 'DELIVERED') {
        /*
         * A photo lead is the referral banner or a client app's picture (HF-A10): an
         * image an operator uploaded, which a structurally broken file or a transient
         * refusal can keep from going out on every request. The screen behind it — the
         * link, the gift, the statistics; the app's links and guide — is what the
         * customer asked for, so a picture that fails is dropped and the reply goes on. A TEXT lead is an earlier part of the one message, and a
         * keyboard without the text it belongs to is worse than no reply.
         */
        if (lead.kind === 'PHOTO_BYTES' || lead.kind === 'VIDEO_FILE') continue;
        await this.stopSpinner(scope, command, input.botInstanceId);
        return {
          intent,
          arrival,
          customerId: customer.id,
          replyKey: reply.key,
          orderId: reply.orderId,
          sent: led.outcome,
        };
      }
    }
    /*
     * R3: a reply that edits the tapped message in place. The card-shaped replies only:
     * no lead and no media, which an `editMessageText` could not carry.
     */
    const editTarget =
      reply.edit === true && reply.media === undefined && (reply.lead ?? []).length === 0
        ? cardMessageOf(input.update, input.botInstanceId)
        : null;
    let sent =
      editTarget !== null
        ? await this.editOrSend(scope, editTarget, reply, asText)
        : reply.media === undefined
          ? await asText()
          : await this.deps.messenger.sendFile(scope, {
              chatId,
              botInstanceId: reply.media.botInstanceId,
              kind: reply.media.kind,
              source: { kind: 'FILE_ID', fileId: reply.media.fileId },
              caption: { templateKey: reply.key, values: reply.values },
              ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
            });
    if (reply.media !== undefined && sent.outcome === 'REFUSED') sent = await asText();
    /*
     * R2: a new message that IS a wizard screen or a review message is recorded against its
     * Telegram id, so the next tap on it — or the decision taken on it — edits it in place.
     */
    const sentAsFile = reply.media !== undefined && !wentAsText;
    if (state !== undefined && sent.outcome === 'DELIVERED' && sent.messageId !== undefined) {
      const ref = {
        // A receipt goes out from the bot that RECEIVED it, and its taps come back there.
        botInstanceId:
          sentAsFile && reply.media !== undefined ? reply.media.botInstanceId : input.botInstanceId,
        chatId,
        messageId: sent.messageId,
      };
      if (reply.wizard !== undefined && reply.wizard.placement !== 'NEW') {
        await state.register(scope, actor, {
          ref,
          landing: {
            kind: reply.wizard.kind,
            step: reply.wizard.step,
            subjectId: reply.wizard.subjectId ?? null,
            paymentId: reply.wizard.paymentId ?? null,
          },
        });
      }
      if (reply.review?.sent !== undefined && reply.review.paymentId !== null) {
        await state.recordReview(scope, actor, {
          ref,
          paymentId: reply.review.paymentId,
          role: reply.review.sent,
          hasMedia: sentAsFile,
        });
      }
    }
    for (const attachment of reply.attachments ?? []) {
      await this.deps.messenger.sendFile(scope, {
        chatId,
        botInstanceId: attachment.botInstanceId,
        kind: attachment.kind,
        source: { kind: 'FILE_ID', fileId: attachment.fileId },
      });
    }

    /*
     * The follow-up, after the answer and only if the answer went out.
     *
     * `docs/phase4h-audit.md` §5: a customer who had paid saw `bot.order.settled` and
     * then nothing at all until the subscription link arrived, however long that took.
     * This is the sentence for that window.
     *
     * Its outcome is NOT the turn's, and that asymmetry is the point. The turn reports
     * whether the customer was told the thing that mattered — that their money arrived
     * — and a failed note about provisioning must not make a successful settlement look
     * like a failed send in the operational log. The customer meets the same fact again
     * when the link arrives, or through `bot.service.provision_delayed` if it does not.
     */
    if (reply.followUpKey !== undefined && sent.outcome === 'DELIVERED') {
      await this.deps.messenger.send(scope, {
        chatId,
        templateKey: reply.followUpKey,
        values: {},
        botInstanceId: input.botInstanceId,
      });
    }

    /*
     * A rate-limited FACT goes on the lane rather than being lost.
     *
     * `OQ-4H-01`. The durable write has already committed by the time this runs —
     * the transfer claim is recorded, the order is cancelled — and Telegram
     * answered 429. Telegram does not redeliver the update and nothing here
     * rescheduled the reply, so the customer was left believing nothing happened.
     * For a transfer that means sending the money twice.
     *
     * ONLY on `RATE_LIMITED`, and the narrowness is the design:
     *
     * - `DELIVERED` needs nothing.
     * - `REFUSED` is Telegram saying it will never accept this — a blocked bot, a
     *   dead chat — and queueing a second copy would produce a row the dispatcher
     *   burns attempts on for a destination that is gone.
     * - `UNKNOWN` is the one this must not touch. The send may have arrived; the
     *   lane's own `UNCONFIRMED` state exists because a retried "your payment was
     *   rejected" is a customer wondering which message is true, and this would
     *   be that mistake one layer up.
     *
     * The enqueue is idempotent by `customer_notifications_subject_key`, so a
     * customer who taps twice and is limited twice still hears once. It is also
     * the only write here and it happens AFTER the business transaction closed,
     * so nothing is held open across a Telegram call.
     */
    if (sent.outcome === 'RATE_LIMITED' && reply.fallback !== undefined) {
      await this.deps.queueRateLimitedFact(
        scope,
        customer.id,
        reply.fallback.kind,
        reply.fallback.subjectId,
        sent.retryAfterMs,
      );
    }

    // After the real answer, not before it. The spinner is cosmetic and its failure is
    // silent; putting it first would let a slow acknowledgement delay the message the
    // customer is actually waiting for.
    await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);

    return {
      intent,
      arrival,
      customerId: customer.id,
      replyKey: reply.key,
      orderId: reply.orderId,
      sent: sent.outcome,
    };
  }

  /**
   * The management panel's turn (Phase 5T), or `null` when this is not an administrator.
   *
   * `null` rather than a refusal, because the caller then falls through to the ordinary
   * unsupported-input reply — the SAME answer any unrecognised string gets. That is the
   * whole of the "a customer cannot open the admin menu by crafting callback data"
   * property: the callback parses, this method resolves no administrator behind the
   * Telegram id that sent it, and the customer learns nothing about what exists.
   *
   * The administrator's OWN actor is what every call below carries — `TELEGRAM_ADMIN`
   * with their administrator id — so the audit row names the person and not the bot, and
   * the guard resolves their real permissions. The turn's `SYSTEM_JOB` actor stops here.
   */
  private async adminTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return null;

    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;

    const { actor: adminActor, permissions } = identity;
    // An administrator who holds neither of the panel's permissions has no panel, and
    // is answered exactly as a customer is. Nothing is hidden from them that they could
    // otherwise have done: both sections charge these keys server-side as well.
    const mayReview = permissions.has(RECEIPTS_VIEW_PERMISSION);
    const maySeeAdmins = permissions.has(ADMINS_VIEW_PERMISSION);
    const maySeeServices = permissions.has(SERVICES_VIEW_PERMISSION);
    const maySeePanels = permissions.has(PANELS_VIEW_PERMISSION);
    /*
     * The reminder section needs BOTH read permissions, because it prints both halves:
     * the five settings and the three switches. Drawing it for an administrator who
     * holds only one would produce a screen that denies itself on arrival.
     */
    const maySeeReminders = permissions.has(SETTINGS_VIEW_PERMISSION);
    const maySeeCustomers = permissions.has(CUSTOMERS_VIEW_PERMISSION);
    const maySeeCategories =
      permissions.has(CATALOG_VIEW_PERMISSION) && this.deps.productCategories !== undefined;
    /*
     * A refund request's card is pushed to whoever holds the two decision permissions,
     * panel or no panel (Codex review of #83, round 9). Its taps are admitted on the SAME
     * predicate the push chose them by: gated on a panel section, a reviewer holding only
     * `refunds.issue` and `services.terminate` was sent a card whose every button answered
     * as if they were a customer. The decision service checks both permissions again.
     */
    const mayDecideRefundRequest =
      ADMIN_REFUND_REQUEST_INTENTS.has(command.intent) && mayBePushedRefundRequests(permissions);
    if (!hasAnyPanelSection(permissions) && !mayDecideRefundRequest) return null;

    try {
      switch (command.intent) {
        case 'ADMIN_PANEL':
          return {
            key: 'bot.admin.panel',
            values: {},
            buttons: [
              ...(mayReview
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.receipts_button' as const,
                      },
                      data: ADMIN_RECEIPTS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeServices
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.services_button' as const,
                      },
                      data: ADMIN_SERVICES_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeePanels
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.panels_button' as const,
                      },
                      data: ADMIN_PANELS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeReminders
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.reminders_button' as const,
                      },
                      data: ADMIN_REMINDERS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeCustomers
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.customers_button' as const,
                      },
                      data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeCategories
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.categories_button' as const,
                      },
                      data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
                    },
                  ]
                : []),
              ...(maySeeAdmins
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.section_button' as const,
                      },
                      data: ADMIN_SECTION_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              // Spec §7: the client apps section, where a tutorial video is set.
              ...(this.deps.clientAppVideos !== undefined && maySeeTutorials(permissions)
                ? [tutorialsPanelButton()]
                : []),
            ],
            orderId: null,
          };
        case 'ADMIN_RECEIPTS':
          return await this.adminReceipts(scope, adminActor);
        case 'ADMIN_RECEIPT':
          return command.targetId === null
            ? null
            : await this.adminReceipt(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_APPROVE':
          return command.targetId === null
            ? null
            : await this.adminApprove(scope, adminActor, command.targetId, input.idempotencyKey);
        case 'ADMIN_REJECT':
        case 'ADMIN_REJECT_CONFIRM':
        case 'ADMIN_REJECT_CANCEL':
          return command.targetId === null
            ? null
            : await this.adminRejectTurn(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input,
                permissions,
              );
        case 'ADMIN_CREDIT':
          return command.targetId === null
            ? null
            : await this.adminCreditOpen(
                scope,
                adminActor,
                command.targetId,
                input.botInstanceId,
                input.idempotencyKey,
              );
        case 'ADMIN_REFUND_REQUEST_APPROVE':
        case 'ADMIN_REFUND_REQUEST_REJECT':
        case 'ADMIN_REFUND_REQUEST_CONFIRM':
        case 'ADMIN_REFUND_REQUEST_CANCEL':
          return command.targetId === null
            ? null
            : await this.adminRefundRequestTurn(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input.botInstanceId,
                updateIdOf(input.update),
              );
        case 'ADMIN_CREDIT_CONFIRM':
          return command.targetId === null
            ? null
            : await this.adminCreditConfirm(scope, adminActor, command.targetId);
        case 'ADMIN_CREDIT_CANCEL':
          return command.targetId === null
            ? null
            : await this.adminCreditCancel(
                scope,
                adminActor,
                command.targetId,
                input.idempotencyKey,
              );
        case 'ADMIN_BLOCK_ASK':
        case 'ADMIN_BLOCK_OPEN':
        case 'ADMIN_BLOCK_CONFIRM':
        case 'ADMIN_BLOCK_CANCEL':
          return command.targetId === null
            ? null
            : await this.adminBlockTurn(scope, adminActor, command.intent, command.targetId, input);
        case 'ADMIN_SERVICES':
          return await this.adminServices(scope, adminActor, permissions);
        case 'ADMIN_SERVICES_BROWSE':
          return await this.adminServicesBrowse(scope, adminActor, null);
        case 'ADMIN_SERVICES_BROWSE_PAGE':
          /*
           * The cursor is decoded at the boundary, so an unparseable one never reaches
           * here. `null` cannot happen and is handled anyway: the first page is the
           * safe reading of "no position", the same note `ADMIN_PANELS_PAGE` carries.
           */
          return await this.adminServicesBrowse(scope, adminActor, command.cursor ?? null);
        case 'ADMIN_SERVICE': {
          /*
           * Reached two ways: a queue button carrying a uuid the boundary validated, and
           * `/service <id>` typed by hand, which it did not — the boundary splits a
           * command's words and cannot know which of them is meant to be an id.
           *
           * Neither is re-validated HERE, and the empty string stands in for a bare
           * `/service`. That is the result of a mutation rather than an omission: this
           * handler validated the typed id and refused an absent one, and BOTH checks
           * survived being reverted, because `ServiceAdminService.get` runs every id
           * through `serviceIdOrNotFound` and `SERVICE_NOT_FOUND` is what the catch
           * below already renders as `bot.admin.service_gone`.
           *
           * A guard that survives its own mutation is a rule in name only, and the
           * danger is not the dead code — it is the next reader taking it for the one
           * holding the line and removing the one that is. So the answer has ONE place
           * it is decided, which is also where the permission is charged first, so an
           * administrator without `services.view` cannot learn whether an id is even
           * well-formed.
           *
           * WP3 gave the typed form a SECOND accepted shape — the name on the panel,
           * which is the only handle a customer's message ever contains — so the one
           * place is now `resolveAdminService`, and the syntax answer it produces is
           * still reached only after the permission.
           */
          const typed = command.targetId ?? (command.args ?? [])[0] ?? '';
          return await this.adminService(scope, adminActor, typed, permissions);
        }
        case 'ADMIN_SERVICE_TERMINATE_ASK':
          return command.targetId === null
            ? null
            : await this.adminServiceAsk(
                scope,
                adminActor,
                command.targetId,
                permissions,
                ADMIN_SERVICE_TERMINATE_ASK,
              );
        case 'ADMIN_SERVICE_ROTATE_ASK':
          return command.targetId === null
            ? null
            : await this.adminServiceAsk(
                scope,
                adminActor,
                command.targetId,
                permissions,
                ADMIN_SERVICE_ROTATE_ASK,
              );
        // Its own case, ABOVE the stacked ones below: a case placed inside that stack
        // would catch every intent stacked above it.
        case 'ADMIN_SERVICE_ROTATE':
          return command.targetId === null
            ? null
            : await this.adminServiceRotateConfirm(
                scope,
                adminActor,
                command.targetId,
                (command.args ?? [])[0] ?? '',
                input.idempotencyKey,
              );
        case 'ADMIN_SERVICE_SYNC':
        case 'ADMIN_SERVICE_RESEND':
        case 'ADMIN_SERVICE_RETRY':
        case 'ADMIN_SERVICE_RECONCILE':
        case 'ADMIN_SERVICE_SUSPEND':
        case 'ADMIN_SERVICE_RESUME':
        case 'ADMIN_SERVICE_TERMINATE':
          return command.targetId === null
            ? null
            : await this.adminServiceAct(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input.idempotencyKey,
              );
        case 'ADMIN_PANELS':
          return await this.adminPanels(scope, adminActor, null);
        case 'ADMIN_REMINDERS':
          return await this.adminReminders(scope, adminActor);
        case 'ADMIN_REMINDER_EDIT':
          /*
           * The cast is safe because the BOUNDARY validated it: `callbackCommand`
           * refuses any code not in `REMINDER_SETTING_CODES` before an intent is
           * produced, so `targetId` here is one of the five or the intent is
           * UNSUPPORTED. The same shape the UUID paths use.
           */
          return command.targetId === null
            ? null
            : await this.adminReminderEdit(
                scope,
                adminActor,
                command.targetId as ReminderSettingCode,
              );
        case 'ADMIN_REMINDER_SET': {
          const chosen = command.args?.[0];
          if (command.targetId === null || chosen === undefined) return null;
          return await this.adminReminderSet(
            scope,
            adminActor,
            command.targetId as ReminderSettingCode,
            Number(chosen),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_PANELS_PAGE':
          /*
           * The cursor is decoded at the boundary, so an unparseable one never reaches
           * here — it is UNSUPPORTED, the same answer every other unreadable callback
           * gets. `null` cannot happen and is handled anyway: the first page is the
           * safe reading of "no position", and throwing on a shape the boundary
           * guarantees would be a crash for a case that cannot occur.
           */
          return await this.adminPanels(scope, adminActor, command.cursor ?? null);
        case 'ADMIN_PANEL_DETAIL':
          return command.targetId === null
            ? null
            : await this.adminPanelDetail(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_PANEL_ARCHIVE_ASK':
          return command.targetId === null
            ? null
            : await this.adminPanelArchiveAsk(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_PANEL_TEST':
        case 'ADMIN_PANEL_ENABLE':
        case 'ADMIN_PANEL_DISABLE':
        case 'ADMIN_PANEL_ARCHIVE':
          return command.targetId === null
            ? null
            : await this.adminPanelAct(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input.idempotencyKey,
              );
        case 'ADMIN_USERNAME':
          return command.targetId === null
            ? null
            : await this.adminUsername(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_USERNAME_TOGGLE': {
          /*
           * The casts are safe because the BOUNDARY validated them: `callbackCommand`
           * refuses any field outside `USERNAME_TOGGLE_FIELDS` and any value that is
           * not `0` or `1` before an intent is produced. The same shape the reminder
           * codes use.
           */
          const field = command.args?.[0];
          const value = command.args?.[1];
          if (command.targetId === null || field === undefined || value === undefined) return null;
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            command.targetId,
            permissions,
            (policy) => ({
              ...policy,
              [USERNAME_TOGGLE_FIELDS[field as UsernameToggleField]]: value === '1',
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_USERNAME_STRATEGY': {
          const code = command.args?.[0];
          if (command.targetId === null || code === undefined) return null;
          const strategy = USERNAME_STRATEGY_CODES[code as UsernameStrategyCode];
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            command.targetId,
            permissions,
            (policy) => ({
              ...policy,
              strategy,
              /*
               * A preset that needs a prefix and has none gets the default one rather
               * than a refusal. `nx` is what an unconfigured panel already uses, so
               * the tap does exactly what the button says; the operator changes it
               * with `/panel_prefix` afterwards if they want a different one.
               */
              prefix:
                strategy === 'PREFIX_RANDOM' ? (policy.prefix ?? DEFAULT_USERNAME_PREFIX) : null,
              template: null,
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_USERNAME_PREFIX':
        case 'ADMIN_USERNAME_TEMPLATE': {
          const [panelId, ...rest] = command.args ?? [];
          const written = rest.join(' ');
          if (panelId === undefined || written === '') {
            return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
          }
          const wantsTemplate = command.intent === 'ADMIN_USERNAME_TEMPLATE';
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            panelId,
            permissions,
            (policy) => ({
              ...policy,
              /*
               * The command selects the preset as well as supplying its value, and it
               * has to: `panels_username_template_check` is a biconditional, so a
               * template without `CUSTOM_TEMPLATE` beside it is not a storable row.
               * Saying "use this template here" in one message is also what an
               * operator means by sending it.
               */
              strategy: wantsTemplate ? 'CUSTOM_TEMPLATE' : 'PREFIX_RANDOM',
              prefix: wantsTemplate ? null : written,
              template: wantsTemplate ? written : null,
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_CUSTOMERS':
          return await this.adminCustomers(scope, adminActor, null);
        case 'ADMIN_CUSTOMERS_PAGE':
          /*
           * The cursor is decoded at the boundary, so an unparseable one never reaches
           * here — the same shape `ADMIN_PANELS_PAGE` has.
           */
          return await this.adminCustomers(scope, adminActor, command.cursor ?? null);
        case 'ADMIN_CUSTOMER':
          return command.targetId === null
            ? null
            : await this.adminCustomer(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_CUSTOMER_FIND':
          return await this.adminCustomerFind(
            scope,
            adminActor,
            (command.args ?? [])[0] ?? '',
            permissions,
          );
        case 'ADMIN_CUSTOMER_BLOCK':
        case 'ADMIN_CUSTOMER_BLOCK_OPEN':
        case 'ADMIN_CUSTOMER_BLOCK_CONFIRM':
        case 'ADMIN_CUSTOMER_BLOCK_CANCEL':
        case 'ADMIN_CUSTOMER_UNBLOCK':
        case 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM':
          return command.targetId === null
            ? null
            : await this.adminCustomerStatusTurn(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                permissions,
                input,
              );
        case 'ADMIN_CATEGORIES':
        case 'ADMIN_CATEGORY':
        case 'ADMIN_CATEGORY_ACTIVATE':
        case 'ADMIN_CATEGORY_DEACTIVATE':
        case 'ADMIN_CATEGORY_SHOW':
        case 'ADMIN_CATEGORY_HIDE':
        case 'ADMIN_CATEGORY_UP':
        case 'ADMIN_CATEGORY_DOWN':
        case 'ADMIN_CATEGORY_DELETE_ASK':
        case 'ADMIN_CATEGORY_DELETE':
        case 'ADMIN_CATEGORY_NEW':
        case 'ADMIN_CATEGORY_RENAME':
        case 'ADMIN_CATEGORY_EMOJI':
        case 'ADMIN_CATEGORY_PRODUCTS':
        case 'ADMIN_CATEGORY_PICK':
        case 'ADMIN_CATEGORY_ASSIGN':
          return await this.adminCategoryTurn(
            scope,
            adminActor,
            command,
            permissions,
            input.idempotencyKey,
          );
        case 'ADMIN_APPS':
        case 'ADMIN_APP':
        case 'ADMIN_APP_VIDEO_SET':
        case 'ADMIN_APP_VIDEO_DELETE_ASK':
        case 'ADMIN_APP_VIDEO_DELETE':
        case 'ADMIN_APP_VIDEO_CANCEL':
        case 'ADMIN_APP_VIDEO_UPLOAD': {
          // Spec §7: the client apps section; the service charges every permission.
          const videos = this.deps.clientAppVideos;
          if (videos === undefined) return null;
          const numericUpdate = updateIdOf(input.update);
          return await adminTutorialTurn(
            videos,
            scope,
            adminActor,
            { intent: command.intent, targetId: command.targetId, video: command.video ?? null },
            {
              idempotencyKey: input.idempotencyKey,
              botInstanceId: input.botInstanceId,
              adminId: identity.admin.id,
              updateId: numericUpdate === undefined ? null : BigInt(numericUpdate),
              sentAt: messageSentAt((input.update as { message?: unknown } | null)?.message),
              permissions,
            },
          );
        }
        case 'ADMIN_SECTION':
          return await this.adminSection(scope, adminActor);
        case 'ADMIN_ADMIN':
          return command.targetId === null
            ? null
            : await this.adminAdmin(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_ADMIN_STATUS': {
          /*
           * The cast is safe because the BOUNDARY validated it: `callbackCommand` is
           * only reached for a code in `ADMIN_STATUS_CODES`, so this is one of the two
           * or the intent is UNSUPPORTED. The same shape the reminder codes use.
           */
          const code = command.args?.[0];
          if (command.targetId === null || code === undefined) return null;
          return await this.adminAdminStatus(
            scope,
            adminActor,
            command.targetId,
            ADMIN_STATUS_CODES[code as AdminStatusCode],
            permissions,
            input.idempotencyKey,
          );
        }
        case 'ADMIN_REVOKE':
          return command.targetId === null
            ? null
            : await this.adminRevokeAccess(scope, adminActor, command.targetId);
        case 'ADMIN_LINK':
          return await this.adminLink(scope, adminActor, command.args ?? []);
        case 'ADMIN_ROLE':
          return await this.adminRole(scope, adminActor, command.args ?? [], input.idempotencyKey);
        default:
          return null;
      }
    } catch {
      /*
       * ONE refusal for everything, and the distinctions are deliberately not rendered.
       *
       * A permission denial, an unknown administrator, a Telegram account already bound
       * and an attempted escalation are four different facts, all of them recorded — the
       * guard writes an operational event, the services write audit rows, and both carry
       * the error code. What a reply must not do is tell whoever holds that chat WHICH
       * of the four they hit, because the answer is a fact about other administrators.
       */
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * Whether this turn's Telegram account is an administrator with a panel.
   *
   * Used for ONE thing — whether `/start` draws the panel row — and it makes the same
   * resolution the actions make, so the keyboard cannot promise a section the guard
   * would refuse. It answers false for every case `adminTurn` treats as "not an
   * administrator", including an ACTIVE administrator holding neither panel permission.
   */
  private async isAdmin(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly telegramUserId: string },
  ): Promise<boolean> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return false;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return false;
    /*
     * The SAME list `adminTurn` gates on, and now literally the same one.
     *
     * The rule has always been that the keyboard must not promise a panel the turn
     * would refuse, and must not withhold one from an administrator who has a section.
     * It was two hand-kept copies, and they had already diverged over the reminders
     * section — see `PANEL_SECTION_PERMISSIONS` for what that cost.
     */
    return hasAnyPanelSection(identity.permissions);
  }

  /**
   * The queue: the manual transfers that hold a receipt and are still pending.
   *
   * Bounded by `ADMIN_QUEUE_LIMIT` and ordered oldest first by the service, so the
   * buttons are the work in the order it arrived. The rows carry the REFERENCE and the
   * amount rather than a payment id: the reference is what the customer quoted to their
   * bank and what a reviewer matches against a statement.
   */
  private async adminReceipts(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const items = await this.deps.receipts.reviewQueue(scope, actor, ADMIN_QUEUE_LIMIT);
    if (items.length === 0) {
      return { key: 'bot.admin.receipts_none', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.receipts_list',
      values: {},
      buttons: items.map((item) => ({
        label: { kind: 'TEXT' as const, text: item.payment.reference, amount: item.payment.amount },
        data: `${ADMIN_RECEIPT_CALLBACK_PREFIX}${item.payment.id}`,
      })),
      orderId: null,
    };
  }

  /**
   * One queue item, as ONE message (Payment File 02 §10): the first receipt, with the
   * facts as its caption and the decisions as its buttons. Further receipts follow as bare
   * files, and a reviewer who cannot be sent the file still gets the caption and the
   * buttons as text — see `PendingReply.media`.
   *
   * Nothing is sent from here. The reply is decided and `handle` sends it after every read
   * above has committed, which is the "decide then send" order this surface keeps.
   *
   * The customer's own caption is customer TEXT: it is rendered into the reviewer's
   * caption through the template (plain text, so no markup it contains is interpreted) and
   * is never logged.
   */
  private async adminReceipt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const item = await this.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
    if (item === null) return this.decidedReply(scope, actor, paymentId);

    const [first, ...rest] = item.receipts.map((receipt): ReplyMedia => ({
      // The bot that RECEIVED the upload, from the row. A `file_id` is scoped to that
      // bot, and the wrong token answers "file not found" for a receipt that exists —
      // which is why the column is on `payment_receipts` at all.
      botInstanceId: receipt.botInstanceId,
      kind: receipt.kind === 'PHOTO' ? 'PHOTO' : 'DOCUMENT',
      fileId: receipt.fileId,
    }));

    return {
      key: 'bot.admin.receipt',
      // The ONE caption builder the push shares (File 01 §4): what this reviewer may see.
      values: item.caption,
      buttons: this.receiptDecisionButtons(item.payment.id, permissions),
      orderId: null,
      ...(first === undefined ? {} : { media: first, attachments: rest }),
      // R2: recorded once sent, so the decision taken on it edits it in place.
      review: { paymentId: item.payment.id, sent: 'REVIEW' },
    };
  }

  /**
   * What a stale button is told when the payment is no longer pending (WP10 follow-up §5):
   * WHICH way the receipt was decided — a credited FAILED payment named as credited, with its
   * amount, and never read as a rejection. `receipt_gone` for everything that is not a
   * receipt disposition. Nothing moves here.
   */
  private async decidedReply(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    /**
     * R2 (item 3): the tap came from a message of this payment's review — the receipt, or a
     * prompt — and that message is edited into the decision already taken, once: a receipt
     * into the outcome's one line (`finaliseReview`), a prompt into this sentence. Absent,
     * a new message, as before.
     */
    tapped?: 'REVIEW' | 'PROMPT',
  ): Promise<PendingReply> {
    const found = await this.deps.receipts.dispositionOf(scope, actor, paymentId as PaymentId);
    const reply = (
      key: TemplateKey,
      outcome: TelegramReviewOutcome | 'GONE',
      values: TemplateValues = {},
    ): PendingReply => ({
      key,
      values,
      buttons: [],
      orderId: null,
      ...(tapped === undefined ? {} : { review: { paymentId, origin: tapped, outcome } }),
    });
    if (found === null) return reply('bot.admin.receipt_gone', 'GONE');
    switch (found.disposition) {
      case 'APPROVED':
        return reply('bot.admin.receipt_already_approved', 'APPROVED');
      case 'REJECTED':
        return reply('bot.admin.receipt_already_rejected', 'REJECTED');
      case 'CREDITED_TO_WALLET':
        return found.credit === null
          ? reply('bot.admin.receipt_gone', 'GONE')
          : reply('bot.admin.receipt_already_credited', 'CREDITED', {
              amount: found.credit.amount,
            });
    }
  }

  /** The decisions a receipt's message carries, for THIS administrator. */
  private receiptDecisionButtons(
    paymentId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): CustomerButton[] {
    return receiptReviewButtons(paymentId, permissions, {
      credit: this.deps.receiptCredits !== undefined,
      block: this.deps.receiptBlocks !== undefined,
    });
  }

  /**
   * The credit button: open this administrator's amount capture for this payment, and ask.
   *
   * Nothing moves here. The prompt states the payment and what it asked for, so the unit
   * the reviewer must type is on the screen; a cancel button beside it abandons the
   * capture rather than leaving it to expire.
   */
  private async adminCreditOpen(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply | null> {
    const credits = this.deps.receiptCredits;
    if (credits === undefined) return null;
    try {
      const opened = await credits.open(scope, actor, {
        idempotencyKey: `${idempotencyKey}:credit-open`,
        botInstanceId,
        paymentId,
      });
      if (opened.outcome === 'GONE') return this.decidedReply(scope, actor, paymentId, 'REVIEW');
      return {
        key: 'bot.admin.credit_amount_prompt',
        values: {
          reference: opened.payment.reference,
          total: opened.payment.amount,
          minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
        },
        buttons: [creditCancelButton(opened.capture.id)],
        orderId: null,
        review: { paymentId: opened.payment.id, origin: 'REVIEW', sent: 'PROMPT' },
      };
    } catch (error) {
      if (
        isNexaError(error) &&
        error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID &&
        error.details['reason'] !== 'NO_RECEIPT'
      ) {
        return this.decidedReply(scope, actor, paymentId, 'REVIEW');
      }
      return creditRefusal(error);
    }
  }

  /**
   * An administrator's plain message, offered to their amount capture FIRST.
   *
   * `null` — the answer for almost every message — when the sender is not an
   * administrator or has no capture waiting, and the message then takes exactly the path
   * it took before this existed. The lookup is by the SENDER's own administrator id, so
   * another administrator's message, and every customer's, cannot reach this capture.
   */
  private async adminCreditAmount(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const credits = this.deps.receiptCredits;
    const admins = this.deps.telegramAdmins;
    if (credits === undefined || admins === undefined) return null;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;
    try {
      const result = await credits.submitAmount(scope, identity.actor, {
        idempotencyKey: `${input.idempotencyKey}:credit-amount`,
        botInstanceId: input.botInstanceId,
        text,
      });
      switch (result.outcome) {
        case 'NO_CAPTURE':
          return null;
        case 'INVALID':
          /*
           * Answered, and the capture stays open. INCIDENT-FIN-001 is a message swallowed
           * without a word; an unreadable amount is told so and asked for again.
           */
          return {
            key: 'bot.admin.credit_amount_invalid',
            values: { total: result.payment.amount },
            buttons: [],
            orderId: null,
          };
        case 'EXPIRED':
          return { key: 'bot.admin.credit_expired', values: {}, buttons: [], orderId: null };
        case 'GONE':
          return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
        case 'ENTERED':
          return {
            key: 'bot.admin.credit_confirm',
            values: {
              amount: result.amount,
              reference: result.payment.reference,
              customer: result.customer?.telegramUserId ?? result.payment.customerId,
              total: result.payment.amount,
            },
            buttons: [
              {
                label: { kind: 'TEMPLATE', key: 'bot.admin.credit_confirm_button' },
                data: `${ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
                row: 0,
              },
              { ...creditCancelButton(result.capture.id), row: 0 },
            ],
            orderId: null,
            review: { paymentId: result.payment.id, sent: 'PROMPT' },
          };
      }
    } catch {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /** The confirm button: the stated amount, credited once, through the one credit path. */
  private async adminCreditConfirm(
    scope: TenantContext,
    actor: ActorContext,
    captureId: string,
  ): Promise<PendingReply | null> {
    const credits = this.deps.receiptCredits;
    if (credits === undefined) return null;
    try {
      const result = await credits.confirm(scope, actor, { captureId });
      if (result.outcome === 'CREDITED') {
        return {
          key: 'bot.admin.credited',
          values: { amount: result.amount, reference: result.result.payment.reference },
          buttons: [],
          orderId: null,
          // R2: this confirmation in place, and the receipt it came from into its one line.
          review: { paymentId: result.result.payment.id, origin: 'PROMPT', outcome: 'CREDITED' },
        };
      }
      if (result.outcome === 'CLOSED' && result.reason !== 'CANCELLED') {
        return { key: 'bot.admin.credit_expired', values: {}, buttons: [], orderId: null };
      }
      if (result.outcome === 'CLOSED') {
        return { key: 'bot.admin.credit_cancelled', values: {}, buttons: [], orderId: null };
      }
      return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return creditRefusal(error);
    }
  }

  /** The cancel button. A capture already confirmed is past cancelling, and says so. */
  private async adminCreditCancel(
    scope: TenantContext,
    actor: ActorContext,
    captureId: string,
    idempotencyKey: string,
  ): Promise<PendingReply | null> {
    const credits = this.deps.receiptCredits;
    if (credits === undefined) return null;
    const result = await credits.cancel(scope, actor, {
      idempotencyKey: `${idempotencyKey}:credit-cancel`,
      captureId,
    });
    return {
      key: result.outcome === 'CANCELLED' ? 'bot.admin.credit_cancelled' : 'bot.admin.receipt_gone',
      values: {},
      buttons: [],
      orderId: null,
    };
  }

  /**
   * Block User from the receipt (WP10 follow-up §4): ask → yes (open the reason capture) →
   * the reason, as text → a confirmation restating it → the block. Every step is
   * `ReceiptBlockCaptureService`, which charges `users.block` itself and blocks only through
   * `CustomerService`; a denial reaches `adminTurn`'s one refusal. Nothing here touches the
   * payment: the receipt stays in the queue for any reviewer to decide.
   */
  private async adminBlockTurn(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    targetId: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply | null> {
    const blocks = this.deps.receiptBlocks;
    if (blocks === undefined) return null;
    const reply = (
      key: TemplateKey,
      values: TemplateValues = {},
      buttons: CustomerButton[] = [],
    ): PendingReply => ({ key, values, buttons, orderId: null });
    const who = (customer: CustomerRecord | null, fallback: string): string =>
      customer?.telegramUserId ?? fallback;
    const askReply = (asked: ReasonAskResult, tapped: 'REVIEW' | 'PROMPT'): PendingReply => {
      if (asked.outcome === 'GONE') return reply('bot.admin.receipt_gone');
      return withReview(
        { paymentId: asked.payment.id, origin: tapped, sent: 'PROMPT' },
        reply('bot.admin.block_ask', { customer: who(asked.customer, asked.payment.customerId) }, [
          {
            label: { kind: 'TEMPLATE', key: 'bot.admin.block_yes_button' },
            data: `${ADMIN_BLOCK_OPEN_CALLBACK_PREFIX}${asked.payment.id}`,
            row: 0,
          },
          {
            label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
            // Nothing is open yet, so there is nothing to cancel: the receipt again.
            data: `${ADMIN_RECEIPT_CALLBACK_PREFIX}${asked.payment.id}`,
            row: 0,
          },
        ]),
      );
    };

    switch (intent) {
      case 'ADMIN_BLOCK_ASK':
        return askReply(await blocks.ask(scope, actor, targetId), 'REVIEW');
      case 'ADMIN_BLOCK_OPEN': {
        const opened = await blocks.open(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:block-open`,
          botInstanceId: input.botInstanceId,
          targetId,
        });
        if (opened.outcome === 'GONE') return reply('bot.admin.receipt_gone');
        return withReview(
          { paymentId: opened.payment.id, origin: 'PROMPT', sent: 'PROMPT' },
          reply(
            'bot.admin.block_reason_prompt',
            {
              customer: who(opened.customer, opened.payment.customerId),
              minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
            },
            [blockCancelButton(opened.capture.id)],
          ),
        );
      }
      case 'ADMIN_BLOCK_CONFIRM': {
        const done = await blocks.confirm(scope, actor, { captureId: targetId });
        if (done.outcome === 'DONE') {
          // R2: the payment is read from this confirmation's own record.
          return withReview(
            { paymentId: null, origin: 'PROMPT', outcome: 'BLOCKED' },
            reply(
              done.result.changed ? 'bot.admin.blocked_from_receipt' : 'bot.admin.block_already',
              { customer: done.result.customer.telegramUserId },
            ),
          );
        }
        if (done.outcome === 'CLOSED') {
          return reply(
            done.reason === 'CANCELLED' ? 'bot.admin.block_cancelled' : 'bot.admin.block_expired',
          );
        }
        return reply('bot.admin.receipt_gone');
      }
      case 'ADMIN_BLOCK_CANCEL': {
        const cancelled = await blocks.cancel(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:block-cancel`,
          captureId: targetId,
        });
        if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.block_cancelled');
        if (cancelled.outcome === 'GONE') return reply('bot.admin.receipt_gone');
        /*
         * A CONFIRMED reason is not a block: the block runs after the capture closes, and one
         * refused or interrupted leaves the capture confirmed and the customer untouched. So
         * the customer's own row answers — blocked, or the question again, never "blocked"
         * for a customer who is not.
         */
        const standing = await blocks.ask(scope, actor, cancelled.targetId);
        if (standing.outcome === 'ASK' && standing.customer?.status === 'BLOCKED') {
          return reply('bot.admin.blocked_from_receipt', {
            customer: who(standing.customer, standing.payment.customerId),
          });
        }
        return askReply(standing, 'PROMPT');
      }
      default:
        return null;
    }
  }

  /**
   * An administrator's plain message, offered to their ONE open prompt: the credit's amount
   * capture, or Block User's reason capture. The two cannot both be open — one partial unique
   * index covers both purposes — so at most one of them answers; `null` for everything else,
   * and the message then routes exactly as it did before either existed.
   */
  private async adminCaptureText(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const amount = await this.adminCreditAmount(scope, actor, text, input);
    if (amount !== null) return amount;
    const refundDecision = await this.adminRefundRequestText(scope, actor, text, input);
    if (refundDecision !== null) return refundDecision;
    const blockReason = await this.adminBlockReason(scope, actor, text, input);
    if (blockReason !== null) return blockReason;
    const customerBlockReason = await this.adminCustomerBlockReason(scope, actor, text, input);
    if (customerBlockReason !== null) return customerBlockReason;
    return this.adminRejectReason(scope, actor, text, input);
  }

  /**
   * A tap on a refund request's review card, or on the prompt behind it (WP19). Approve and
   * reject open a prompt and decide nothing; the confirmation names the amount CAPTURE and
   * is the only tap that approves. Every refusal is a sentence from the closed list below.
   */
  private async adminRefundRequestTurn(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    targetId: string,
    botInstanceId: BotInstanceId,
    updateId: bigint | undefined,
  ): Promise<PendingReply | null> {
    const decisions = this.deps.serviceRefundDecisions;
    if (decisions === undefined) return null;
    const minutes = Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000);
    const plain = (key: TemplateKey): PendingReply => ({
      key,
      values: {},
      buttons: [],
      orderId: null,
    });
    try {
      if (intent === 'ADMIN_REFUND_REQUEST_APPROVE' || intent === 'ADMIN_REFUND_REQUEST_REJECT') {
        const approve = intent === 'ADMIN_REFUND_REQUEST_APPROVE';
        const opened = approve
          ? await decisions.openApprove(scope, actor, {
              botInstanceId,
              requestId: targetId,
              ...(updateId === undefined ? {} : { updateId }),
            })
          : await decisions.openReject(scope, actor, {
              botInstanceId,
              requestId: targetId,
              ...(updateId === undefined ? {} : { updateId }),
            });
        if (opened.outcome === 'CLOSED') return plain('bot.admin.refund_request_closed');
        if (opened.outcome === 'NOT_EXECUTABLE') {
          return plain('bot.admin.refund_request_not_executable');
        }
        return {
          key: approve
            ? 'bot.admin.refund_request_amount_prompt'
            : 'bot.admin.refund_request_reject_prompt',
          values: approve ? { remaining: opened.review.remaining, minutes } : { minutes },
          buttons: [refundRequestCancelButton(opened.capture.id)],
          orderId: null,
        };
      }
      if (intent === 'ADMIN_REFUND_REQUEST_CONFIRM') {
        const result = await decisions.confirmApprove(scope, actor, { captureId: targetId });
        switch (result.outcome) {
          case 'EXECUTING':
            return result.request.approvedAmount === null
              ? plain('bot.admin.refund_request_closed')
              : {
                  key: 'bot.admin.refund_request_executing',
                  values: { amount: result.request.approvedAmount },
                  buttons: [],
                  orderId: null,
                };
          case 'INVALID_AMOUNT':
            return {
              key: 'bot.admin.refund_request_amount_invalid',
              values: { remaining: result.remaining },
              buttons: [],
              orderId: null,
            };
          case 'EXPIRED':
            return plain('bot.admin.refund_request_expired');
          case 'CANCELLED':
            return plain('bot.admin.refund_request_cancelled');
          case 'NOT_EXECUTABLE':
            return plain('bot.admin.refund_request_not_executable');
          case 'CLOSED':
          case 'GONE':
            return plain('bot.admin.refund_request_closed');
        }
      }
      if (intent === 'ADMIN_REFUND_REQUEST_CANCEL') {
        const result = await decisions.cancel(scope, actor, { captureId: targetId });
        return plain(
          result.outcome === 'CANCELLED'
            ? 'bot.admin.refund_request_cancelled'
            : 'bot.admin.refund_request_closed',
        );
      }
      /* istanbul ignore next -- the four intents above are the only ones routed here. */
      return null;
    } catch {
      return plain('bot.admin.refused');
    }
  }

  /**
   * An administrator's plain message, offered to their refund-request prompt (WP19): an
   * amount restated with one destructive confirmation, or a reason that rejects at once.
   * `null` when they have no such prompt waiting — the answer for almost every message.
   */
  private async adminRefundRequestText(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const decisions = this.deps.serviceRefundDecisions;
    const admins = this.deps.telegramAdmins;
    if (decisions === undefined || admins === undefined) return null;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;
    const plain = (key: TemplateKey): PendingReply => ({
      key,
      values: {},
      buttons: [],
      orderId: null,
    });
    const updateId = updateIdOf(input.update);
    try {
      const result = await decisions.submitText(scope, identity.actor, {
        idempotencyKey: `${input.idempotencyKey}:refund-text`,
        botInstanceId: input.botInstanceId,
        text,
        ...(updateId === undefined ? {} : { updateId }),
      });
      switch (result.outcome) {
        case 'NO_CAPTURE':
          return null;
        case 'EXPIRED':
          return plain('bot.admin.refund_request_expired');
        case 'CLOSED':
          return plain('bot.admin.refund_request_closed');
        case 'NOT_EXECUTABLE':
          return plain('bot.admin.refund_request_not_executable');
        case 'INVALID_AMOUNT':
          // Answered, and the prompt stays open: a swallowed message is INCIDENT-FIN-001.
          return {
            key: 'bot.admin.refund_request_amount_invalid',
            values: { remaining: result.remaining },
            buttons: [],
            orderId: null,
          };
        case 'INVALID_REASON':
          return {
            key: 'bot.admin.refund_request_reject_invalid',
            values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
            buttons: [],
            orderId: null,
          };
        case 'REJECTED':
          return plain('bot.admin.refund_request_rejected');
        case 'AMOUNT_ENTERED':
          return {
            key: 'bot.admin.refund_request_confirm',
            values: {
              amount: result.amount,
              customer: result.review.customer?.telegramUserId ?? '—',
              service: result.review.service?.providerUsername ?? '—',
            },
            buttons: [
              {
                label: { kind: 'TEMPLATE', key: 'bot.admin.refund_request_confirm_button' },
                data: `${ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
                row: 0,
              },
              { ...refundRequestCancelButton(result.capture.id), row: 0 },
            ],
            orderId: null,
          };
      }
    } catch {
      return plain('bot.admin.refused');
    }
  }

  /**
   * The typed reason of a block from the customers section (WP10G), recorded and restated;
   * nothing is blocked until the confirm. The same shape as `adminBlockReason`, for the same
   * purpose-keyed capture, so at most one of the three reason paths answers a message.
   */
  private async adminCustomerBlockReason(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const blocks = this.deps.customerBlocks;
    const admins = this.deps.telegramAdmins;
    if (blocks === undefined || admins === undefined) return null;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;
    try {
      const result = await blocks.submitReason(scope, identity.actor, {
        idempotencyKey: `${input.idempotencyKey}:customer-block-reason`,
        botInstanceId: input.botInstanceId,
        text,
      });
      switch (result.outcome) {
        case 'NO_CAPTURE':
          return null;
        case 'INVALID':
          return {
            key: 'bot.admin.block_reason_invalid',
            values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
            buttons: [],
            orderId: null,
          };
        case 'EXPIRED':
          return {
            key: 'bot.admin.customer_block_expired',
            values: {},
            buttons: [],
            orderId: null,
          };
        case 'GONE':
          return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
        case 'ENTERED':
          return {
            key: 'bot.admin.customer_block_confirm',
            values: { customer: result.customer.telegramUserId, reason: result.reason },
            buttons: [
              {
                label: { kind: 'TEMPLATE', key: 'bot.admin.block_confirm_button' },
                data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}c:${result.capture.id}`,
                row: 0,
              },
              { ...customerBlockCancelButton(result.capture.id), row: 0 },
            ],
            orderId: null,
          };
      }
    } catch {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /** The typed rejection reason, recorded and restated; nothing is rejected until the confirm. */
  private async adminRejectReason(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const rejects = this.deps.receiptRejects;
    const admins = this.deps.telegramAdmins;
    if (rejects === undefined || admins === undefined) return null;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;
    try {
      const result = await rejects.submitReason(scope, identity.actor, {
        idempotencyKey: `${input.idempotencyKey}:reject-reason`,
        botInstanceId: input.botInstanceId,
        text,
      });
      switch (result.outcome) {
        case 'NO_CAPTURE':
          return null;
        case 'INVALID':
          return {
            key: 'bot.admin.reject_reason_invalid',
            values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
            buttons: [],
            orderId: null,
          };
        case 'EXPIRED':
          return { key: 'bot.admin.reject_expired', values: {}, buttons: [], orderId: null };
        case 'GONE':
          return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
        case 'ENTERED':
          return {
            key: 'bot.admin.reject_confirm',
            values: { reference: result.payment.reference, reason: result.reason },
            buttons: [
              {
                label: { kind: 'TEMPLATE', key: 'bot.admin.reject_confirm_button' },
                data: `${ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
                row: 0,
              },
              { ...rejectCancelButton(result.capture.id), row: 0 },
            ],
            orderId: null,
            review: { paymentId: result.payment.id, sent: 'PROMPT' },
          };
      }
    } catch {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /** The typed reason, recorded and restated; nothing is blocked until the confirm. */
  private async adminBlockReason(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const blocks = this.deps.receiptBlocks;
    const admins = this.deps.telegramAdmins;
    if (blocks === undefined || admins === undefined) return null;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;
    try {
      const result = await blocks.submitReason(scope, identity.actor, {
        idempotencyKey: `${input.idempotencyKey}:block-reason`,
        botInstanceId: input.botInstanceId,
        text,
      });
      switch (result.outcome) {
        case 'NO_CAPTURE':
          return null;
        case 'INVALID':
          return {
            key: 'bot.admin.block_reason_invalid',
            values: { max: ADMIN_CAPTURE_REASON_MAX_LENGTH },
            buttons: [],
            orderId: null,
          };
        case 'EXPIRED':
          return { key: 'bot.admin.block_expired', values: {}, buttons: [], orderId: null };
        case 'GONE':
          return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
        case 'ENTERED':
          return {
            key: 'bot.admin.block_confirm',
            values: {
              customer: result.customer?.telegramUserId ?? result.payment.customerId,
              reason: result.reason,
            },
            buttons: [
              {
                label: { kind: 'TEMPLATE', key: 'bot.admin.block_confirm_button' },
                data: `${ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX}${result.capture.id}`,
                row: 0,
              },
              { ...blockCancelButton(result.capture.id), row: 0 },
            ],
            orderId: null,
            review: { paymentId: result.payment.id, sent: 'PROMPT' },
          };
      }
    } catch {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * Approve, through the SAME application method the Web Admin called.
   *
   * `confirmManualTransfer` — no parallel settlement, no second ledger write, no second
   * notification. Everything that makes a decision safe lives in there: the permission, the
   * conditional state transition, the wallet credit keyed on the payment, the customer's
   * notification, the audit row.
   *
   * A duplicate tap is safe TWICE OVER. The idempotency key is the update's, so Telegram's
   * redelivery of one tap is a replay; and two different taps race a conditional UPDATE that
   * only one can win, after which the loser is told WHICH decision won (WP10 follow-up §5).
   *
   * Rejection is NOT here any more: File 01 §7 makes its reason mandatory, so the reject
   * button opens a reason capture (`adminRejectTurn`) and there is no one-tap rejection.
   */
  private async adminApprove(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const item = await this.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
    if (item === null) return this.decidedReply(scope, actor, paymentId, 'REVIEW');
    try {
      await this.deps.payments.confirmManualTransfer(scope, actor, paymentId, {
        idempotencyKey: `${idempotencyKey}:admin-approve`,
        // An ASCII note, and an audit field rather than customer-facing text: it says
        // through which surface the decision was taken, which is exactly what a
        // reviewer reading the payment later wants to know.
        note: 'Approved in the Telegram management panel.',
        // A receipt-review decision: the service refuses a transfer with no stored receipt.
        requireReceipt: true,
      });
      /*
       * R2 (item 3): the receipt message the approval was tapped on becomes the result, in
       * place and without its buttons; every other recorded message of this payment too.
       */
      return {
        key: 'bot.admin.approved',
        values: {},
        buttons: [],
        orderId: null,
        review: { paymentId, origin: 'REVIEW', outcome: 'APPROVED' },
      };
    } catch (error) {
      return this.lostDecision(scope, actor, paymentId, error, 'REVIEW');
    }
  }

  /**
   * A decision that lost the conditional UPDATE to another between our read and its write:
   * told WHICH decision won, not a generic refusal. Nothing moved — the service's own
   * transaction refused. Every other error is `adminTurn`'s one refusal.
   */
  private async lostDecision(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    error: unknown,
    tapped?: 'REVIEW' | 'PROMPT',
  ): Promise<PendingReply> {
    if (
      isNexaError(error) &&
      error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID &&
      error.details['reason'] !== 'NO_RECEIPT'
    ) {
      return this.decidedReply(scope, actor, paymentId, tapped);
    }
    throw error;
  }

  /**
   * The rejection, with its MANDATORY reason (File 01 §7): the reject button opens this
   * administrator's reason capture; the reason arrives as text and is restated; the confirm
   * rejects through `rejectManualTransfer` — the one conditional PENDING→FAILED edge approve
   * and credit race on — and the customer's `PAYMENT_REJECTED` sentence carries the reason.
   */
  private async adminRejectTurn(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    targetId: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply | null> {
    const rejects = this.deps.receiptRejects;
    if (rejects === undefined) return null;
    const reply = (key: TemplateKey, values: TemplateValues = {}): PendingReply => ({
      key,
      values,
      buttons: [],
      orderId: null,
    });
    switch (intent) {
      case 'ADMIN_REJECT': {
        const opened = await rejects.open(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:reject-open`,
          botInstanceId: input.botInstanceId,
          targetId,
        });
        if (opened.outcome === 'GONE') {
          return this.decidedReply(scope, actor, targetId, 'REVIEW');
        }
        return {
          key: 'bot.admin.reject_reason_prompt',
          values: {
            reference: opened.payment.reference,
            minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
          },
          buttons: [rejectCancelButton(opened.capture.id)],
          orderId: null,
          review: { paymentId: opened.payment.id, origin: 'REVIEW', sent: 'PROMPT' },
        };
      }
      case 'ADMIN_REJECT_CONFIRM': {
        try {
          const done = await rejects.confirm(scope, actor, { captureId: targetId });
          if (done.outcome === 'DONE') {
            // R2: the payment is read from this confirmation's own record.
            return {
              ...reply('bot.admin.rejected'),
              review: { paymentId: null, origin: 'PROMPT', outcome: 'REJECTED' },
            };
          }
          if (done.outcome === 'CLOSED') {
            return reply(
              done.reason === 'CANCELLED'
                ? 'bot.admin.reject_cancelled'
                : 'bot.admin.reject_expired',
            );
          }
          return reply('bot.admin.receipt_gone');
        } catch (error) {
          // Another decision won between the reason and the confirm; nothing was rejected.
          if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID) {
            return reply('bot.admin.receipt_gone');
          }
          throw error;
        }
      }
      case 'ADMIN_REJECT_CANCEL': {
        const cancelled = await rejects.cancel(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:reject-cancel`,
          captureId: targetId,
        });
        if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.reject_cancelled');
        if (cancelled.outcome === 'GONE') return reply('bot.admin.receipt_gone');
        // A CONFIRMED reason is not a rejection: one that lost to another decision, or never
        // ran, left the capture confirmed. The payment answers — the receipt again while it
        // is pending, else WHICH decision it received.
        return this.adminReceipt(scope, actor, cancelled.targetId, permissions);
      }
      default:
        return null;
    }
  }

  /**
   * The services queue: what needs an administrator, and nothing else.
   *
   * TWO searches, and the choice of which two is the whole design. `UNRECONCILED` is a
   * service whose create was lost — nothing resolves it on its own, and 4D made it a
   * dead end deliberately so that nobody asks a panel for a second account. A `FAILED`
   * delivery is a customer who paid and has no link, after the automatic lane gave up
   * at its attempt ceiling. Every other state either settles itself or belongs to the
   * customer, and a queue that listed them would be a list of things not to do.
   *
   * Bounded by `ADMIN_QUEUE_LIMIT` per search and NOT paged, for the reason that
   * constant gives: this is a keyboard, Telegram refuses an oversized one, and ten rows
   * are ten decisions. An installation with more than ten of either has a bigger
   * question than the eleventh row, and the Web Admin pages properly.
   */
  private async adminServices(
    scope: TenantContext,
    actor: ActorContext,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const [unreconciled, undelivered] = await Promise.all([
      this.deps.serviceAdmin.list(scope, actor, {
        limit: ADMIN_QUEUE_LIMIT,
        search: { state: 'UNRECONCILED' },
      }),
      this.deps.serviceAdmin.list(scope, actor, {
        limit: ADMIN_QUEUE_LIMIT,
        search: { deliveryState: 'FAILED' },
      }),
    ]);

    /*
     * De-duplicated by id: a service can be BOTH unreconciled and undelivered, and two
     * buttons for one service is a list that looks longer than the work is.
     */
    const seen = new Set<string>();
    const buttons: CustomerButton[] = [];
    for (const service of [...unreconciled.items, ...undelivered.items]) {
      if (seen.has(service.id)) continue;
      seen.add(service.id);
      buttons.push({
        /*
         * The provider username, which is the handle an operator types into the panel
         * and is NOT a credential. Not the subscription ref and not the client id —
         * both are bearer capabilities, and this message stays in the chat for ever.
         */
        label: { kind: 'TEXT' as const, text: service.providerUsername },
        data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${service.id}`,
      });
    }
    /*
     * The browse button, appended to BOTH answers — including the empty queue.
     *
     * An empty queue is the normal, healthy state, and until WP3 it was also a dead
     * end: "nothing needs attention" with no way from there to the service a customer
     * is asking about. `docs/wp3-service-audit.md` is blunt about what that cost —
     * service management was the most built of the three and the least reachable.
     *
     * Drawn behind `services.view`, which is also what the section itself is behind, so
     * in practice it is always drawn here; the check is written out anyway because a
     * button is advertising and never permission — `list` charges the key again.
     */
    const withBrowse = permissions.has(SERVICES_VIEW_PERMISSION)
      ? [
          ...buttons,
          {
            label: { kind: 'TEMPLATE' as const, key: 'bot.admin.services_browse_button' as const },
            data: ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
          },
        ]
      : buttons;
    if (buttons.length === 0) {
      return {
        key: 'bot.admin.services_none',
        values: {},
        buttons: withBrowse,
        orderId: null,
      };
    }
    return { key: 'bot.admin.services_section', values: {}, buttons: withBrowse, orderId: null };
  }

  /**
   * The inventory: one button per service, newest first, and a page button when there
   * is more.
   *
   * Beside the queue above rather than instead of it, and the difference is what each
   * list IS — the note `adminPanels` carries about a fleet applies here word for word.
   * A queue of ten is ten decisions and an eleventh is a bigger question than the row;
   * an inventory has to be able to reach the four-hundredth service, because that is
   * where the customer who just wrote in happens to be.
   *
   * No filter on state and no filter on delivery: a TERMINATED service is exactly what
   * "my account stopped working" often means, and a list that hid it would be fast at
   * answering everything except the question people actually ask.
   *
   * `list` charges `services.view` itself, so an administrator who reached this through
   * a crafted callback without it is refused there rather than here.
   */
  private async adminServicesBrowse(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const page = await this.deps.serviceAdmin.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      ...(cursor === null ? {} : { cursor }),
      search: {},
    });

    const buttons: CustomerButton[] = page.items.map((service) => ({
      /*
       * The provider username, which is the handle an operator types into the panel and
       * is NOT a credential — the same rule the queue above states. Not the
       * subscription ref and not the client id: both are bearer capabilities and this
       * message stays in that chat for ever.
       */
      label: { kind: 'TEXT' as const, text: service.providerUsername },
      data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${service.id}`,
    }));
    if (buttons.length === 0) {
      return { key: 'bot.admin.services_browse_none', values: {}, buttons: [], orderId: null };
    }

    /*
     * The next page, appended only when the cursor ENCODES — the rule the panels
     * section and the customer's own services list both state: a cursor this codec
     * cannot carry would become a button whose `callback_data` is a bare prefix, and
     * the honest answer to that is the same as having no further page.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.services_more_button' },
        data: `${ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.services_browse', values: {}, buttons, orderId: null };
  }

  // -------------------------------------------------------------------------
  // The panels section (Phase 6B)
  // -------------------------------------------------------------------------

  /**
   * The fleet: one button per live panel, newest first, and a page button when there
   * is more.
   *
   * PAGED rather than bounded-and-truncated, which is the opposite of what the services
   * queue does, and the difference is what each list IS. The services section is a
   * QUEUE of work — ten rows are ten decisions and an eleventh is a bigger question than
   * the row. A fleet is an inventory: every panel is a legitimate destination, and an
   * installation with twenty of them must be able to reach the twentieth. So this
   * carries the repository's own keyset cursor, through the codec that makes it fit
   * Telegram's 64 bytes.
   *
   * `LIVE` and not `ALL`: an archived panel has no action on this surface — restoring
   * one may need a new name, and a name is not typed into a chat here — so listing them
   * would be a list of buttons that can only report what cannot be done.
   *
   * `list` charges `panels.view` itself, so an administrator who reached this through a
   * crafted callback without it is refused there rather than here.
   */
  /**
   * Every reminder setting and switch, printed before anything is editable.
   *
   * The whole point of the screen, and the cure for the defect CBR-013 and BC-SB-003
   * name: seven of twelve legacy settings screens never show the value they are about
   * to replace, so "an admin cannot read the current configuration without overwriting
   * it". Here the read is a read.
   *
   * `reminderConfig.read` charges `settings.view` itself — the one key both the
   * settings and the flags are read under. The
   * button that led here was drawn behind the same pair, and this is checked ANYWAY:
   * not drawing a button is never the control, because a callback can be replayed from
   * an old message after a role change.
   */
  private async adminReminders(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const config = await this.deps.reminderConfig.read(scope, actor);
    return {
      key: 'bot.admin.reminders_section',
      values: {
        expiry: onOff(config.expiryEnabled),
        expired: onOff(config.expiredNoticeEnabled),
        usage: onOff(config.usageEnabled),
        firstDays: config.expiryFirstDays,
        secondDays: config.expirySecondDays,
        firstPercent: config.usageFirstPercent,
        secondPercent: config.usageSecondPercent,
        finalPercent: config.usageFinalPercent,
      },
      buttons: REMINDER_SETTING_CODE_ORDER.map((code) => ({
        label: { kind: 'TEMPLATE' as const, key: REMINDER_SETTING_BUTTONS[code] },
        data: `${ADMIN_REMINDER_EDIT_CALLBACK_PREFIX}${code}`,
      })),
      orderId: null,
    };
  }

  /** One setting, its current value, and the values a tap may replace it with. */
  private async adminReminderEdit(
    scope: TenantContext,
    actor: ActorContext,
    code: ReminderSettingCode,
  ): Promise<PendingReply> {
    const config = await this.deps.reminderConfig.read(scope, actor);
    return {
      key: 'bot.admin.reminder_choose',
      values: {
        setting: REMINDER_SETTING_CODES[code],
        current: reminderValueOf(config, code),
      },
      /*
       * The options are plain TEXT labels, because a number is data and not a sentence.
       * `check:i18n` forbids hard-coded customer-facing STRINGS in a surface; rendering
       * `String(85)` is neither hard-coded nor a string a translator would touch.
       */
      buttons: reminderOptionsFor(code).map((option) => ({
        label: { kind: 'TEXT' as const, text: String(option) },
        data: `${ADMIN_REMINDER_SET_CALLBACK_PREFIX}${code}:${String(option)}`,
      })),
      orderId: null,
    };
  }

  /**
   * Writes one threshold, or says why the combination was refused.
   *
   * The write goes through `SettingsService.set`, which is the SAME path the Web Admin
   * uses: the same permission, the same audit row, the same idempotency record and the
   * same `ReminderThresholdsGuard`. This surface adds no rule of its own, which is what
   * makes the two surfaces impossible to drift apart.
   *
   * A refusal is rendered, not thrown. `refuseReminderThresholds` produces Persian
   * prose naming which of the five is wrong; letting it reach the generic error handler
   * would replace that with a shrug, which is the legacy `⭕️ ورودی نا معتبر` this whole
   * section is written against.
   */
  private async adminReminderSet(
    scope: TenantContext,
    actor: ActorContext,
    code: ReminderSettingCode,
    value: number,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const key = REMINDER_SETTING_CODES[code];
    /*
     * SUFFIXED, and the suffix is load-bearing — the same note `draft` carries.
     *
     * The update's bare key is already consumed by the turn that resolved this
     * account, so presenting it again with a different payload is
     * `platform.idempotency_payload_mismatch`. That throws, `adminTurn` catches
     * everything as `bot.admin.refused`, and the operator sees a generic denial for a
     * write that was never refused by any permission. Every other admin write on this
     * surface suffixes; this one did not.
     */
    const result = await this.deps.reminderConfig.write(
      scope,
      actor,
      key,
      value,
      `${idempotencyKey}:reminder-${code}`,
    );
    if (!result.ok) {
      return {
        key: 'bot.admin.reminder_refused',
        values: { reason: result.reason },
        buttons: [],
        orderId: null,
      };
    }
    return {
      key: 'bot.admin.reminder_saved',
      values: { setting: key, value },
      buttons: [],
      orderId: null,
    };
  }

  private async adminPanels(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const page = await this.deps.panelAdmin.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      archived: 'LIVE',
      cursor,
    });

    const buttons: CustomerButton[] = page.panels.map((view) => ({
      /*
       * The NAME the operator gave it, and nothing else. Not the base URL: an address
       * is most of what somebody needs to go looking, and this message stays in that
       * chat for ever and is forwardable.
       */
      label: { kind: 'TEXT' as const, text: view.panel.name },
      data: `${ADMIN_PANEL_DETAIL_CALLBACK_PREFIX}${view.panel.id}`,
    }));
    if (buttons.length === 0) {
      return { key: 'bot.admin.panels_none', values: {}, buttons: [], orderId: null };
    }

    /*
     * The next page, appended only when the cursor ENCODES — the rule the customer's
     * own services list states: a cursor this codec cannot carry would become a button
     * whose `callback_data` is a bare prefix, and the honest answer to that is the same
     * as having no further page.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.panels_more_button' },
        data: `${ADMIN_PANELS_PAGE_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.panels_section', values: {}, buttons, orderId: null };
  }

  /**
   * One panel: what it is, what its last probe said, how full it is, and the actions
   * this administrator may take on it.
   *
   * The health three — the state, when it was checked, and whether that is stale — come
   * from `readHealth`, the SAME projection the Web Admin's response builder calls, so
   * the two surfaces cannot come to disagree about whether a disabled panel reads as
   * `DISABLED`. The occupancy comes from the capacity projection the service attaches,
   * for the same reason.
   *
   * What it does NOT carry: the base URL, any credential, any masked stand-in for one,
   * and the provider's response body. The failure is the KIND from the frozen taxonomy,
   * because a provider's own error text can carry a hostname, a path or a token
   * fragment — and the Web Admin is where a probe is read in full.
   */
  private async adminPanelDetail(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      /*
       * Unknown, another tenant's, or malformed — ONE answer for all three, the rule
       * `bot.admin.service_gone` states: telling them apart would let anybody holding a
       * panel id learn whether it exists.
       */
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }

    const reading = readHealth(view.panel, view.health, this.deps.clock.now());
    const mayEdit = permissions.has(PANELS_EDIT_PERMISSION);
    const buttons: CustomerButton[] = [];
    if (mayEdit) {
      /*
       * Test is offered for a panel that is not archived, which is the same condition
       * `testConnection` enforces: it refuses an ARCHIVED panel, so a button for one
       * could only ever record a refusal.
       */
      if (view.panel.status !== 'ARCHIVED') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_test_button' },
          data: `${ADMIN_PANEL_TEST_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status === 'DISABLED') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_enable_button' },
          data: `${ADMIN_PANEL_ENABLE_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status === 'ACTIVE') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_disable_button' },
          data: `${ADMIN_PANEL_DISABLE_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status !== 'ARCHIVED') {
        buttons.push({
          /*
           * The ASKING prefix. `W:` opens the question and `X:` archives, and the two
           * differ by one character in a table — which is why that table exists and why
           * the archiving row is its last one.
           */
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_button' },
          data: `${ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      /*
       * Offered for an ARCHIVED panel too, and deliberately: `update` refuses one, so
       * the button records a refusal rather than working — but the SECTION behind it
       * is also where the policy is read, and an operator should be able to see what
       * an archived panel was configured to do.
       */
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_button' },
        data: `${ADMIN_USERNAME_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }

    return {
      key: 'bot.admin.panel_detail',
      values: {
        name: view.panel.name,
        /*
         * The descriptor's canonical name, with the stored type as the fallback the
         * Web Admin's own projection uses. `providerDescriptor` is nullable because a
         * stored row could in principle name a type this build has no adapter for —
         * which panel creation refuses, so the fallback is a belt rather than a case.
         */
        provider:
          providerDescriptor(view.panel.providerType)?.canonicalName ?? view.panel.providerType,
        status: view.panel.status,
        health: reading.state,
        ...(reading.checkedAt === null ? {} : { checkedAt: reading.checkedAt }),
        ...(reading.failure === null ? {} : { failure: reading.failure }),
        services: view.capacity.services,
        reservations: view.capacity.reservations,
        /*
         * A STRING, and `bot.admin.panel_detail` says why: "no cap" is one of this
         * field's values, and rendering that as 0 would read as a full panel — the
         * exact inversion a null cap means.
         */
        cap: view.capacity.maxServices === null ? UNCAPPED : String(view.capacity.maxServices),
        /*
         * The policy, and it is configuration rather than a secret.
         *
         * An administrator reading the template is the only way to answer "why is this
         * customer's account called that" — the question a support conversation starts
         * from. The base URL and the credentials stay out of this message for the
         * reasons the docblock gives; a list of placeholder tokens is neither of those.
         *
         * The DASH for a null prefix or template is the same value the cap uses for
         * "there is none", and means the same thing here: this preset takes no
         * configuration, so there is nothing to read.
         */
        usernameCustom: view.panel.usernamePolicy.allowCustom ? MODE_ON : MODE_OFF,
        usernameAutomatic: view.panel.usernamePolicy.allowAutomatic ? MODE_ON : MODE_OFF,
        usernamePrefix: view.panel.usernamePolicy.prefix ?? UNCAPPED,
        usernameTemplate: view.panel.usernamePolicy.template ?? UNCAPPED,
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * A panel's username policy, read back in full before anything is edited.
   *
   * Everything the operator can change is on this one screen WITH its current value —
   * the two customer choices, the selected preset, the prefix, the template, and a
   * preview rendered from synthetic values. That is the answer to the legacy
   * write-only settings screen, where the only way to read a price was to overwrite
   * it: nothing here has to be guessed at by changing it.
   *
   * The preview costs nothing and reserves nothing. `previewUsername` renders from
   * `USERNAME_PREVIEW_VALUES`, so looking at this screen cannot consume randomness a
   * customer would have got or take a name out of the namespace.
   */
  private async adminUsername(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    return this.usernameSection(
      view.panel.id,
      view.panel.name,
      view.panel.usernamePolicy,
      permissions,
    );
  }

  /**
   * The section, rendered from a policy. Shared by the read and by every write.
   *
   * A write re-renders through this rather than telling the operator it succeeded and
   * leaving them to go and look: the screen they are left on shows what is stored NOW,
   * which is the only way a save can be checked without a second round trip.
   */
  private usernameSection(
    panelId: string,
    panelName: string,
    policy: PanelUsernamePolicy,
    permissions: ReadonlySet<PermissionKey>,
  ): PendingReply {
    const buttons: CustomerButton[] = [];
    /*
     * Drawn only with `panels.edit`, and that is presentation and not enforcement:
     * `PanelService.update` charges the same permission through the same guard, so a
     * crafted callback from an administrator without it is refused there and the
     * refusal is recorded. Not drawing a button is never the check — `CLAUDE.md`.
     */
    if (permissions.has(PANELS_EDIT_PERMISSION)) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_custom_button' },
        data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}c:${policy.allowCustom ? '0' : '1'}:${panelId}`,
      });
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_automatic_button' },
        data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}a:${policy.allowAutomatic ? '0' : '1'}:${panelId}`,
      });
      for (const [code, key] of USERNAME_STRATEGY_BUTTONS) {
        buttons.push({
          label: { kind: 'TEMPLATE', key },
          data: `${ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX}${code}:${panelId}`,
        });
      }
    }
    return {
      key: 'bot.admin.username_section',
      values: {
        panel: panelName,
        custom: policy.allowCustom ? MODE_ON : MODE_OFF,
        automatic: policy.allowAutomatic ? MODE_ON : MODE_OFF,
        random: policy.strategy === 'RANDOM' ? MODE_ON : MODE_OFF,
        prefixRandom: policy.strategy === 'PREFIX_RANDOM' ? MODE_ON : MODE_OFF,
        telegramIdRandom: policy.strategy === 'TELEGRAM_ID_RANDOM' ? MODE_ON : MODE_OFF,
        customTemplate: policy.strategy === 'CUSTOM_TEMPLATE' ? MODE_ON : MODE_OFF,
        prefix: policy.prefix ?? UNCAPPED,
        template: policy.template ?? UNCAPPED,
        preview: previewUsername(policy) ?? UNCAPPED,
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * Read the stored policy, apply ONE change to it, and write the whole thing back.
   *
   * Whole-policy rather than a field, because `PanelService.update` replaces the
   * policy as a unit and three CHECK constraints are about combinations of its
   * columns — a partial write is what reaches a state none of them individually
   * forbids. The edit is expressed as a function of what is stored, so the caller
   * never has to assemble a policy it did not read.
   *
   * Every tap carries the TARGET value rather than "flip it", so a double tap writes
   * the same policy twice. The turn's idempotency key makes the second one a replay
   * on top of that, and the service takes the panel's row lock: three mechanisms, and
   * the only one that would survive two administrators editing at once is the lock.
   * Last write wins between two people, which is what an absolute value means; what
   * cannot happen is one person's slow connection undoing their own change.
   *
   * A refusal is rendered with the shared evaluator's own words and NOTHING is
   * written — the service refuses the whole update, so the operator is looking at the
   * policy that is still stored.
   */
  private async adminUsernameWrite(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
    edit: (policy: PanelUsernamePolicy) => PanelUsernamePolicy,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    let before;
    try {
      before = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    const wanted = edit(before.panel.usernamePolicy);
    try {
      const after = await this.deps.panelAdmin.update(scope, actor, panelId, {
        idempotencyKey: `${idempotencyKey}:panel-username`,
        usernamePolicy: wanted,
      });
      return this.usernameSection(
        after.panel.id,
        after.panel.name,
        after.panel.usernamePolicy,
        permissions,
      );
    } catch (error) {
      /*
       * The evaluator's own Persian, not a sentence composed here.
       *
       * `validateUsernamePolicy` is the one place that decides whether a policy is
       * storable, and it carries the words for each refusal. Writing them again on
       * this surface would be the second opinion that goes stale — and the Web Admin
       * renders the same function's `reason`, so the two surfaces cannot disagree
       * about why something was refused.
       */
      const reason = validateUsernamePolicy(wanted).reason;
      if (reason !== null) {
        return {
          key: 'bot.admin.username_refused',
          values: { reason },
          buttons: [],
          orderId: null,
        };
      }
      return refusal(error);
    }
  }

  /**
   * The confirmation screen for archiving, and the count it is decided against.
   *
   * Re-reads the panel rather than trusting the callback, for the two reasons the
   * services terminate-ask gives: the permission is charged again by `get`, and the
   * count on this screen is the one that is true NOW rather than when the list was
   * drawn. A stale tap lands on a panel that has since been archived and is answered
   * `bot.admin.panel_gone` by the status check below rather than by a button that
   * cannot work.
   */
  private async adminPanelArchiveAsk(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    if (!permissions.has(PANELS_EDIT_PERMISSION)) {
      return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
    }
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    if (view.panel.status === 'ARCHIVED') {
      return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.panel_archive_ask',
      values: { services: view.capacity.services },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_confirm_button' },
          data: `${ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX}${view.panel.id}`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * The four actions: test, enable, disable, archive.
   *
   * Every one of them goes through `PanelService`, which charges `panels.edit` through
   * the same guard the Web Admin uses and writes the same audit row — so a crafted
   * callback from an administrator without that key is refused there, and the refusal is
   * recorded rather than silently swallowed. This surface decides which buttons to draw
   * and nothing about what is allowed.
   *
   * The idempotency key is the TURN's, suffixed by the action. A double tap is the same
   * command twice, which is what makes the second one a replay rather than a second
   * write — and for the test that is the difference between one probe of somebody's
   * panel and two.
   */
  private async adminPanelAct(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    panelId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      if (intent === 'ADMIN_PANEL_TEST') {
        const result = await this.deps.panelAdmin.testConnection(scope, actor, panelId, {
          idempotencyKey: `${idempotencyKey}:panel-test`,
        });
        /*
         * `probed: false` means the stored health came back WITHOUT a new probe — a
         * replay under the same key, or a probe of this configuration recently enough
         * that repeating it would be a way to hammer somebody's provider. Reporting
         * that as "tested" is the legacy "✅ updated" for a write that did nothing.
         */
        return {
          key: result.probed ? 'bot.admin.panel_tested' : 'bot.admin.panel_test_replayed',
          values: {},
          buttons: [],
          orderId: null,
        };
      }

      const status =
        intent === 'ADMIN_PANEL_ENABLE'
          ? 'ACTIVE'
          : intent === 'ADMIN_PANEL_DISABLE'
            ? 'DISABLED'
            : 'ARCHIVED';
      await this.deps.panelAdmin.setStatus(scope, actor, panelId, {
        status,
        idempotencyKey: `${idempotencyKey}:panel-${status.toLowerCase()}`,
      });
      return {
        key:
          status === 'ACTIVE'
            ? 'bot.admin.panel_enabled'
            : status === 'DISABLED'
              ? 'bot.admin.panel_disabled'
              : 'bot.admin.panel_archived',
        values: {},
        buttons: [],
        orderId: null,
      };
    } catch (error) {
      /*
       * The one refusal this screen can resolve gets its own sentence, because the
       * remedy is the Test button an administrator is already looking at. Every other
       * panel refusal is one sentence pointing at the Web Admin, and a permission
       * denial is neither — it falls through to `act`'s own handling, which tells
       * whoever holds that chat nothing about what exists.
       */
      if ((error as { code?: unknown } | null)?.code === PANEL_ERROR_CODES.PANEL_NOT_VALIDATED) {
        return { key: 'bot.admin.panel_not_validated', values: {}, buttons: [], orderId: null };
      }
      if (isPanelRefusal(error)) {
        return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
  }

  /**
   * One service, and the actions this administrator may actually take on it.
   *
   * The verdicts come from `ServiceAdminService.detail` — the SAME evaluator the Web
   * Admin renders and the write paths agree with — so this surface decides nothing about
   * availability. What it adds is the second filter: a verdict says the SERVICE allows
   * an action, and the permission says this administrator may ask for it. A button drawn
   * without both is a button whose every tap records a denial.
   *
   * `detail` charges `services.view` itself, so an administrator who reached this
   * through a crafted callback without it is refused there rather than here.
   */
  private async adminService(
    scope: TenantContext,
    actor: ActorContext,
    needle: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    /*
     * The PERMISSION decides first, before the shape of the string is even considered.
     *
     * Without this, `/service <garbage>` from an administrator who holds no
     * `services.view` would be answered with the syntax — which is a small thing to
     * learn, and it is learned from a screen that is not theirs. The rule this path
     * already stated is that one place decides the answer and the permission is
     * charged before anything about the id is revealed; WP3 added a second shape to
     * the argument, so it had to be stated here rather than left to the guard inside
     * `detail`. `detail` and `list` still charge the key themselves: this is what is
     * ADVERTISED, never what is allowed.
     */
    if (!permissions.has(SERVICES_VIEW_PERMISSION)) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    const resolved = await this.resolveAdminService(scope, actor, needle);
    if (resolved.kind === 'SYNTAX') {
      return { key: 'bot.admin.service_usage', values: {}, buttons: [], orderId: null };
    }
    if (resolved.kind === 'MANY') {
      /*
       * One button per match, and NO action on this screen.
       *
       * Each button opens the ordinary detail, which names the panel and the customer
       * — the two facts that tell the operator which of these is theirs. Putting the
       * seven action buttons here instead would be offering a destructive verb against
       * a row nobody has identified yet.
       */
      return {
        key: 'bot.admin.service_ambiguous',
        values: {},
        buttons: resolved.matches.map((match) => ({
          label: { kind: 'TEXT' as const, text: adminServiceMatchLabel(match) },
          data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${match.id}`,
        })),
        orderId: null,
      };
    }
    if (resolved.kind === 'NONE') {
      /*
       * Unknown, another tenant's, or a name nobody here holds — ONE answer for all
       * three, which is the rule `bot.service.not_found` states on the customer side.
       * Telling them apart would let anybody holding a service id, or guessing a name,
       * learn whether it exists.
       */
      return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
    }

    const { service, actions } = resolved.found;
    const [history, title, customer] = await Promise.all([
      /*
       * `null` for a history that could not be READ, never an empty one.
       *
       * The first version caught the failure into `{ operations: [], limit: 0 }` and
       * rendered `0`, which tells the operator that this service has had nothing
       * attempted on it — the opposite of the truth when the read failed, and exactly
       * the kind of confident wrong answer this whole package is about. Found by the
       * Codex review of this branch.
       */
      this.deps.serviceAdmin
        .operations(scope, actor, service.id)
        .catch(() => null as ServiceOperationHistory | null),
      this.deps.purchaseTitle(scope, service.orderId),
      this.adminServiceCustomer(scope, actor, service.customerId, permissions),
    ]);
    const latest = history?.operations[0];

    return {
      key: 'bot.admin.service',
      values: {
        /*
         * WHO, by the identity a support conversation quotes — never the internal
         * uuid, which was what this field carried until WP3 while the contract
         * described it as "the numeric identity this installation holds". A uuid names
         * the right person to nobody, cannot be typed into any command here, and is a
         * customer identifier handed to an administrator who may not be allowed to
         * read customers at all. `-` when they are not: the screen says nothing rather
         * than something useless.
         */
        customer: customer?.telegramUserId ?? '-',
        username: service.providerUsername,
        panel: service.panelId,
        product: title ?? service.productId ?? '-',
        state: service.state,
        delivery: service.deliveryState,
        usedTrafficBytes: service.trafficUsedBytes,
        totalTrafficBytes: service.trafficLimitBytes,
        ...(service.usageSyncedAt === null ? {} : { syncedAt: service.usageSyncedAt }),
        ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
        /*
         * The latest operation AND its outcome, which is what tells a planned action
         * apart from a completed one. Both words come from the frozen vocabularies, so
         * an administrator reading this message and the Web Admin screen sees the same
         * token for the same fact.
         */
        operation: latest === undefined ? '-' : `${latest.type} ${latest.state}`,
        /*
         * The bound, stated rather than implied, in THREE cases and not two.
         *
         * A plain count when the whole history was read, and the bound with a `+` when
         * it was not: the reader asks for one row beyond its bound to know which, so
         * this never means "exactly the bound" when there is more, and never claims
         * more when the history happens to be exactly that long. An exact count past
         * the bound would mean walking every operation the service ever had to render
         * one figure.
         *
         * And `-` when the history could not be read AT ALL. That is the third case,
         * and collapsing it into `0` was this screen's own version of the defect the
         * package exists to fix: "nothing has been attempted on this service" is a
         * diagnosis, and the read having failed is the absence of one.
         */
        history:
          history === null
            ? '-'
            : history.hasMore
              ? `${history.limit}+`
              : String(history.operations.length),
      },
      buttons: [
        ...adminServiceButtons(service.id, actions, permissions),
        /*
         * The person, one tap away, and only for an administrator who may read them.
         *
         * `9:v:<customerId>` is the customers section's own detail callback, so this is
         * a link into a screen that already exists rather than a second rendering of a
         * customer — and that screen charges `users.view` again when it is tapped. Not
         * drawn without the key, because a button whose every tap records a denial is
         * an invitation to produce denials.
         */
        ...(customer === null
          ? []
          : [
              {
                label: {
                  kind: 'TEMPLATE' as const,
                  key: 'bot.admin.service_customer_button' as const,
                },
                data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customer.id}`,
              },
            ]),
        {
          label: { kind: 'TEMPLATE' as const, key: 'bot.admin.services_back_button' as const },
          data: ADMIN_SERVICES_CALLBACK_PREFIX,
        },
      ],
      orderId: null,
    };
  }

  /**
   * One service, from EITHER the internal id or the name on the panel.
   *
   * The two are told apart by shape, not by trying one and falling back: a uuid is
   * never a provider username and a provider username is never a uuid, so a string
   * that parses as neither is a syntax answer rather than a lookup that finds nothing.
   * `SYNTAX` and `null` are different sentences for a reason — "that is not a service
   * name" and "no such service" are different facts, and only the second is about what
   * this installation holds.
   *
   * The username path goes through `list` with its EXACT filter, which is the one way
   * this codebase asks that question. `limit: 1` because the answer is at most one row
   * per tenant: `services_panel_provider_username_key` makes the name unique per panel,
   * and two panels of one tenant pointing at different machines may legitimately hold
   * the same name — in which case the newest wins, which is the row a support
   * conversation is almost always about. Stated rather than hidden: the list ordering
   * is newest-first and that is what decides it.
   */
  private async resolveAdminService(
    scope: TenantContext,
    actor: ActorContext,
    needle: string,
  ): Promise<AdminServiceLookup> {
    const raw = needle.trim();
    if (raw === '') return { kind: 'SYNTAX' };
    if (uuidV7Schema.safeParse(raw).success) {
      try {
        return { kind: 'ONE', found: await this.deps.serviceAdmin.detail(scope, actor, raw) };
      } catch {
        return { kind: 'NONE' };
      }
    }
    const parsed = providerUsernameLookupSchema.safeParse(raw);
    if (!parsed.success) return { kind: 'SYNTAX' };
    /*
     * MORE than one row, deliberately, and this is the Codex round's P1.
     *
     * `services_panel_provider_username_key` is unique per PANEL, not per tenant —
     * `schema.ts` says so where the namespace is explained — and two panels of one
     * tenant may point at different machines, so one name legitimately names two
     * accounts. The first version asked for `limit: 1` and took the newest, with a
     * docblock calling it "the row a support conversation is almost always about".
     * That is a guess wearing a rule's clothes, and the screen it produced carried
     * SUSPEND and TERMINATE: the wrong customer's service under a right answer's
     * heading.
     *
     * So the bound is `AMBIGUOUS_MATCH_PROBE` and anything past one is handed back for
     * the operator to choose. The probe is small because the question is only "is this
     * unique", not "how many are there" — a name on more matches than fit one keyboard
     * is a different conversation, and the browse list is where it happens.
     */
    const page = await this.deps.serviceAdmin.list(scope, actor, {
      limit: AMBIGUOUS_MATCH_PROBE,
      search: { providerUsername: parsed.data },
    });
    const first = page.items[0];
    if (first === undefined) return { kind: 'NONE' };
    if (page.items.length > 1) return { kind: 'MANY', matches: page.items };
    try {
      return { kind: 'ONE', found: await this.deps.serviceAdmin.detail(scope, actor, first.id) };
    } catch {
      return { kind: 'NONE' };
    }
  }

  /**
   * The customer behind a service, or nothing.
   *
   * `null` for two different reasons, deliberately collapsed: this administrator may
   * not read customers, or the row could not be read. Both produce the same screen —
   * no identity and no link — because the alternative is a service screen that fails
   * entirely over a permission the service itself does not need.
   *
   * The read is skipped, not caught, when the key is absent: `customers.get` charges
   * `users.view` through the guard and a denial is an operational event, so asking
   * anyway would manufacture a denial per service screen an operator opens.
   */
  private async adminServiceCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<CustomerRecord | null> {
    if (!permissions.has(CUSTOMERS_VIEW_PERMISSION)) return null;
    try {
      return await this.deps.customers.get(scope, actor, customerId);
    } catch (error) {
      // NARROW, the rule `isCustomerMiss` states: anything else is a real failure and
      // must not be quietly rendered as "this service has no customer".
      if (isCustomerMiss(error)) return null;
      throw error;
    }
  }

  /**
   * A confirmation screen, and the only place its confirming callback is produced.
   *
   * Phase 6A, and the first ask-then-act flow the admin panel has. Terminate deletes the
   * account on somebody's panel while the customer keeps the order they paid for, so it
   * costs two taps — the same rule the customer half has held since 4E, and the reason
   * `service-management.test.ts` asserts the destructive prefix appears on no list and
   * no detail screen. A link rotation costs two taps too: it replaces the link the
   * customer is using. `AdminServiceAsk` names what differs between the two, so the
   * checks below cannot drift apart.
   *
   * The permission is checked again here: an administrator who reached the asking
   * callback without the action's permission is not shown a button they cannot press.
   */
  private async adminServiceAsk(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    permissions: ReadonlySet<PermissionKey>,
    ask: AdminServiceAsk,
  ): Promise<PendingReply> {
    if (!permissions.has(ask.permission)) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    let found;
    try {
      found = await this.deps.serviceAdmin.detail(scope, actor, serviceId);
    } catch {
      return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
    }
    /*
     * The verdict is read AGAIN, on the confirmation screen.
     *
     * An action that became illegal between the detail and this tap — the service was
     * ended by somebody else, or its panel was disabled — must not be offered a second
     * button. The write path refuses it anyway; this is the screen not promising what
     * the tap would refuse.
     */
    const verdict = found.actions.find((entry) => entry.action === ask.action);
    if (verdict === undefined || !verdict.available) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: ask.key,
      values: {},
      buttons: [
        {
          label: { kind: 'TEMPLATE' as const, key: ask.confirmKey },
          data: ask.confirmData(found.service),
        },
      ],
      orderId: null,
    };
  }

  /**
   * The rotation's confirmation: acted on only while the link it was asked about is
   * still the service's link.
   *
   * A rotation leaves the service `ACTIVE`, so without the stamp the old confirmation
   * would stay pressable for ever and each press would replace the customer's link
   * again — one tap, which is what asking first exists to prevent. A press before the
   * first rotation has finished finds the stamp unchanged and reaches
   * `requestFromOperator`, whose open-operation return answers it with the rotation
   * already planned. A press after it finds a different link and is refused.
   *
   * The read goes through `serviceAdmin.detail`, which charges `services.view`; the
   * write charges `services.edit` in `requestFromOperator`, as every action does.
   */
  private async adminServiceRotateConfirm(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    stamp: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    let found;
    try {
      found = await this.deps.serviceAdmin.detail(scope, actor, serviceId);
    } catch (error) {
      if (isServiceRefusal(error)) {
        return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
    if (rotationStamp(found.service.subscriptionUrl) !== stamp) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    return this.adminServiceAct(scope, actor, 'ADMIN_SERVICE_ROTATE', serviceId, idempotencyKey);
  }

  /**
   * One action, through the SAME application method the Web Admin's button calls.
   *
   * `requestFromOperator`, `retryProvisioning` and `resendForOperator` — no parallel
   * service logic, no second audit row, no second notification. Everything that makes an
   * action safe lives in there: the permission, the legal-state check, the panel's
   * operability, the scope-activity read inside the transaction, the open-operation
   * return that makes a double tap idempotent, and the audit row naming this
   * administrator.
   *
   * The reply distinguishes the two honest outcomes and nothing else. An operation comes
   * back PLANNED, so the answer is that the request was recorded — not that it was done,
   * which is the legacy "updated" for a write whose effect has not happened. A resend
   * plans no operation and says it was sent. Anything the write path refuses is one
   * sentence: which of the four refusals it was belongs to the operational log and the
   * audit row, and an administrator's next step is the Web Admin either way.
   */
  private async adminServiceAct(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const key = `${idempotencyKey}:${intent.toLowerCase()}`;
    try {
      if (intent === 'ADMIN_SERVICE_RESEND') {
        await this.deps.delivery.resendForOperator(scope, actor, serviceId);
        return { key: 'bot.admin.service_resent', values: {}, buttons: [], orderId: null };
      }
      if (intent === 'ADMIN_SERVICE_RETRY') {
        await this.deps.services.retryProvisioning(scope, actor, serviceId, {
          idempotencyKey: key,
        });
        return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
      }
      const operation = ADMIN_SERVICE_OPERATIONS[intent];
      /*
       * Unreachable while the dispatch and this table name the same intents, and
       * answered rather than asserted: a non-null assertion here would turn a future
       * edit that adds an intent to one and not the other into a runtime throw, on a
       * button an administrator pressed to fix somebody's service.
       */
      if (operation === undefined) {
        return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
      }
      await this.deps.services.requestFromOperator(scope, actor, serviceId, operation, {
        idempotencyKey: key,
      });
      return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
    } catch (error) {
      /*
       * A refusal about the SERVICE is answered differently from a refusal about the
       * ADMINISTRATOR, and the difference is deliberate. A stale button — the state
       * moved, the panel was disabled, an operation of that type is already open — is
       * something the person can act on, so it says the action is not possible now. A
       * permission denial falls through to `adminTurn`'s single refusal, which tells
       * whoever holds the chat nothing about what exists.
       */
      if (isServiceRefusal(error)) {
        return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
  }

  /**
   * The customers section: a page of this tenant's customers, oldest first.
   *
   * ## Why it pages rather than bounding like the queues do
   *
   * `adminServices` is a QUEUE — the ten things needing attention — and drops its
   * `nextCursor` on the floor deliberately, because the eleventh unreconciled service is
   * not a thing an operator scrolls to. A customer list is an INVENTORY: the customer an
   * operator is looking for is as likely to be the four-hundredth as the fourth, so this
   * pages the way `adminPanels` does, through the codec that makes a keyset cursor fit
   * Telegram's 64-byte `callback_data`.
   *
   * ## And why the lookup command exists beside it
   *
   * Paging to the four-hundredth customer is forty taps. The command in the section's
   * own text takes the numeric id from a support conversation straight to the detail
   * screen, and charges `users.search` on top of `users.view` for doing it — a list of
   * a tenant's own customers and a lookup of one specific person are different
   * questions, which is why `CustomerService.list` separates them.
   *
   * ## No counts
   *
   * The rule `bot.admin.panels_section` states: a figure in this message goes stale
   * between the render and the tap. `adminSection` prints `shown of total` because an
   * administrator roster is a bounded hand-made list that is NOT paged, so its bound
   * would otherwise be silent. This one has a next-page button instead, which is the
   * same honesty by a different means.
   */
  private async adminCustomers(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const page = await this.deps.customers.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      /*
       * The decoded token, used as this module's cursor.
       *
       * `CustomerCursor.id` is branded `UserId` and a token's is a plain string, so the
       * brand is asserted rather than parsed — deliberately, and for the reason
       * `keyset-cursor.ts` gives about accepting any UUID version: this id only ever
       * feeds a `>` comparison against `(created_at, id)`, never a lookup of a person,
       * and `decodeKeysetToken` has already guaranteed it is thirty-two hex digits in a
       * UUID's shape. Running it through `userIdSchema` would refuse a v4 row an import
       * or a restore created and end that traversal early.
       */
      cursor: cursor === null ? null : { createdAt: cursor.createdAt, id: cursor.id as UserId },
    });
    if (page.items.length === 0) {
      /*
       * Empty is empty, cursor or not.
       *
       * Reachable WITH a cursor: an operator pages forward and the last of the customers
       * was on the previous page. `bot.admin.customers_none` reads correctly in both
       * cases, because it says nobody is here rather than that nobody exists.
       */
      return { key: 'bot.admin.customers_none', values: {}, buttons: [], orderId: null };
    }

    const buttons: CustomerButton[] = page.items.map((customer) => ({
      label: { kind: 'TEXT' as const, text: adminCustomerLabel(customer) },
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customer.id}`,
    }));
    /*
     * The next page, appended only when the cursor ENCODES — the rule `adminPanels` and
     * the customer's own services list both state. A cursor this codec cannot carry
     * would become a button whose tap Telegram rejects, and a list that ends is the
     * safe direction.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.customers_more_button' },
        data: `${ADMIN_CUSTOMERS_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.customers_section', values: {}, buttons, orderId: null };
  }

  /**
   * One customer, by the internal id a row carries.
   *
   * An id that is unknown, malformed or another tenant's gets ONE answer — the rule
   * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
   * anybody on this installation. `CustomerService.get` charges `users.view` BEFORE it
   * validates the id, so an administrator without the permission cannot even learn
   * whether an id is well-formed.
   */
  private async adminCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let customer: CustomerRecord;
    try {
      customer = await this.deps.customers.get(scope, actor, customerId);
    } catch (error) {
      // NARROW. See `isCustomerMiss`: a denial is not a missing person, and saying so
      // is what an operator would act on.
      if (isCustomerMiss(error)) {
        return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
    return adminCustomerReply(customer, permissions);
  }

  /**
   * The same screen, reached by the numeric Telegram id an operator quotes.
   *
   * Through `list` with its EXACT `telegramUserId` filter, which is the one way this
   * codebase asks that question — `CustomerRepository` says so in the comment where
   * `findByTelegramId` used to be, and two ways to ask one question is how two answers
   * start. The filter is exact rather than a prefix for a reason stated there too: a
   * partial match on a Telegram id is a way to enumerate them.
   *
   * A blank or unmatched argument gets the SYNTAX rather than a prompt for the missing
   * one, because a prompt that outlives its question swallows the next unrelated
   * message (INCIDENT-FIN-001). An id that matches nobody gets `customer_gone`, the
   * same single answer the row path gives.
   */
  private async adminCustomerFind(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const needle = telegramUserId.trim();
    /*
     * The shape is checked HERE, against the CONTRACT's own schema, and the permission
     * is NOT.
     *
     * An argument that is not a Telegram id is a typing mistake, not a lookup, and
     * answering it with the syntax costs nothing and tells nobody anything: it is a
     * fact about the message that was sent, not about this installation's customers.
     * Everything that IS a fact about them — whether that id exists — goes through
     * `list`, which charges `users.view` and then `users.search` before it looks.
     *
     * `telegramUserIdSchema` and not a regex written here. This was `/^\d{1,32}$/`,
     * which is looser than the contract in both directions: it accepted a leading zero
     * and up to thirty-two digits, neither of which any Telegram account has. Those
     * reached `list` — which trusts its `CustomerSearch` and validates nothing — spent
     * `users.search` on a value that cannot match, and came back `customer_gone`: the
     * sentence that says the person does not exist, for a string that is not an id at
     * all. One schema means the Telegram lookup and the HTTP one agree about what an
     * id is, which is the same reason `orders.tsx` parses with `uuidV7Schema` rather
     * than its own idea of a uuid.
     */
    if (!telegramUserIdSchema.safeParse(needle).success) {
      return { key: 'bot.admin.customer_usage', values: {}, buttons: [], orderId: null };
    }
    /*
     * NOT wrapped in a catch at all.
     *
     * `list` refuses with a permission denial or it answers; there is no "miss" it can
     * raise, because an id that matches nobody comes back as an empty page. So a
     * denial — an administrator holding `users.view` and not `users.search` — reaches
     * `adminTurn`'s single refusal, which is the same answer every other denial on this
     * surface gets and is not `customer_gone`: that sentence would tell somebody who
     * was refused permission that the person does not exist.
     */
    const page = await this.deps.customers.list(scope, actor, {
      search: { telegramUserId: needle },
      limit: 1,
    });
    const customer = page.items[0];
    if (customer === undefined) {
      return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
    }
    return adminCustomerReply(customer, permissions);
  }

  /**
   * Blocks or unblocks one customer, in two steps each (WP10G, closing OQ-WP10F-03).
   *
   * A block is ask → yes (open the reason capture) → the reason, typed → a confirmation
   * restating it → `CustomerService.blockWithOutcome`, through `CustomerBlockCaptureService`:
   * the receipt's Block User mechanics with a customer as the target, so a block cannot be
   * silent and the typed text alone changes nothing. An unblock is ask → confirm →
   * `CustomerService.unblock`. Both services carry every refusal this needs — the permission
   * is charged and re-checked inside the writing transaction, the scope's activity is read
   * there too, the id is validated and lower-cased before the idempotency hash, and the update
   * is CONDITIONAL on the status it expects to find — so this adds none of its own and catches
   * nothing: `adminTurn`'s single refusal answers a denial.
   *
   * Every reply after a write is the detail screen's own builder, so the buttons an operator
   * sees are the ones the state actually offers, and a redelivered update reads as the state it
   * found rather than claiming a second change.
   */
  private async adminCustomerStatusTurn(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    targetId: string,
    permissions: ReadonlySet<PermissionKey>,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply | null> {
    const blocks = this.deps.customerBlocks;
    const reply = (
      key: TemplateKey,
      values: TemplateValues = {},
      buttons: readonly CustomerButton[] = [],
    ): PendingReply => ({ key, values, buttons: [...buttons], orderId: null });
    const detail = async (customerId: string): Promise<PendingReply> => {
      try {
        return adminCustomerReply(
          await this.deps.customers.get(scope, actor, customerId),
          permissions,
        );
      } catch (error) {
        if (isCustomerMiss(error)) return reply('bot.admin.customer_gone');
        throw error;
      }
    };
    const changed = (customer: CustomerRecord): PendingReply => ({
      key: 'bot.admin.customer_status_changed',
      values: { telegramId: customer.telegramUserId, status: customer.status },
      buttons: adminCustomerReply(customer, permissions).buttons,
      orderId: null,
    });
    const backButton = (customerId: string): CustomerButton => ({
      label: { kind: 'TEMPLATE', key: 'bot.admin.block_cancel_button' },
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customerId}`,
      row: 0,
    });

    switch (intent) {
      case 'ADMIN_CUSTOMER_BLOCK': {
        // The ASK writes nothing. Through the capture service so the same permission pair
        // (`users.block`, `users.view`) is charged that the open will charge.
        if (blocks === undefined) return null;
        const asked = await blocks.ask(scope, actor, targetId);
        if (asked.outcome === 'GONE') return reply('bot.admin.customer_gone');
        if (asked.customer.status === 'BLOCKED') return changed(asked.customer);
        return reply('bot.admin.customer_block_ask', { customer: asked.customer.telegramUserId }, [
          {
            label: { kind: 'TEMPLATE', key: 'bot.admin.block_yes_button' },
            data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}o:${targetId}`,
            row: 0,
          },
          backButton(targetId),
        ]);
      }
      case 'ADMIN_CUSTOMER_BLOCK_OPEN': {
        if (blocks === undefined) return null;
        const opened = await blocks.open(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:customer-block-open`,
          botInstanceId: input.botInstanceId,
          targetId,
        });
        if (opened.outcome === 'GONE') return reply('bot.admin.customer_gone');
        return reply(
          'bot.admin.customer_block_reason_prompt',
          {
            customer: opened.customer.telegramUserId,
            minutes: Math.round(ADMIN_AMOUNT_CAPTURE_TTL_MS / 60_000),
          },
          [customerBlockCancelButton(opened.capture.id)],
        );
      }
      case 'ADMIN_CUSTOMER_BLOCK_CONFIRM': {
        if (blocks === undefined) return null;
        const done = await blocks.confirm(scope, actor, { captureId: targetId });
        if (done.outcome === 'DONE') {
          // Already blocked: the conditional UPDATE did not match, the stored reason stands
          // untouched, and the operator is told the state found rather than a second change.
          if (!done.result.changed) {
            return reply(
              'bot.admin.customer_block_already',
              { customer: done.result.customer.telegramUserId },
              adminCustomerReply(done.result.customer, permissions).buttons,
            );
          }
          return changed(done.result.customer);
        }
        if (done.outcome === 'CLOSED') {
          return reply(
            done.reason === 'CANCELLED'
              ? 'bot.admin.customer_block_cancelled'
              : 'bot.admin.customer_block_expired',
          );
        }
        return reply('bot.admin.customer_gone');
      }
      case 'ADMIN_CUSTOMER_BLOCK_CANCEL': {
        if (blocks === undefined) return null;
        const cancelled = await blocks.cancel(scope, actor, {
          idempotencyKey: `${input.idempotencyKey}:customer-block-cancel`,
          captureId: targetId,
        });
        if (cancelled.outcome === 'CANCELLED') return reply('bot.admin.customer_block_cancelled');
        if (cancelled.outcome === 'GONE') return reply('bot.admin.customer_gone');
        // A CONFIRMED reason is not a block: the block runs after the capture closes, and one
        // refused or interrupted leaves the capture confirmed and the customer untouched. So
        // the customer's own row answers, through the detail screen's builder.
        return detail(cancelled.targetId);
      }
      case 'ADMIN_CUSTOMER_UNBLOCK': {
        // The ASK writes nothing; the read charges `users.view`, as the detail screen does.
        const customer = await this.deps.customers.get(scope, actor, targetId).catch((error) => {
          if (isCustomerMiss(error)) return null;
          throw error;
        });
        if (customer === null) return reply('bot.admin.customer_gone');
        if (customer.status !== 'BLOCKED') return changed(customer);
        return reply('bot.admin.customer_unblock_ask', { customer: customer.telegramUserId }, [
          {
            label: { kind: 'TEMPLATE', key: 'bot.admin.customer_unblock_confirm_button' },
            data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}n:${targetId}`,
            row: 0,
          },
          backButton(targetId),
        ]);
      }
      case 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM': {
        const updated = await this.deps.customers.unblock(scope, actor, {
          // Suffixed: the update's own key is `resolveFromUpdate`'s record in the `TELEGRAM`
          // namespace, which is where a Telegram administrator's unblock is remembered too.
          idempotencyKey: `${input.idempotencyKey}:customer-unblock`,
          customerId: targetId,
          reason: null,
        });
        return changed(updated);
      }
      default:
        return null;
    }
  }

  /**
   * The categories section: one dispatcher, so the switch in `adminTurn` has one arm.
   *
   * Every branch calls `ProductCategoryService` or `ProductService` and nothing else, so
   * this surface decides which buttons to draw and how to word an outcome, and never
   * whether something is allowed. The permission is charged by the service on every call
   * — including the reads — and a denial is left to reach `adminTurn`'s single refusal.
   *
   * The idempotency key is the TURN's, suffixed by the action, the shape `adminPanelAct`
   * uses: a redelivered update is the same command twice and replays.
   */
  private async adminCategoryTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    permissions: ReadonlySet<PermissionKey>,
    idempotencyKey: string,
  ): Promise<PendingReply | null> {
    const categories = this.deps.productCategories;
    if (categories === undefined) return null;
    const mayEdit = permissions.has(CATALOG_EDIT_PERMISSION);
    const id = command.targetId;

    switch (command.intent) {
      case 'ADMIN_CATEGORIES':
        return this.adminCategoryList(
          await categories.list(scope, actor),
          command.page ?? 0,
          mayEdit,
        );
      case 'ADMIN_CATEGORY':
        return id === null ? null : this.adminCategoryDetail(scope, actor, id, mayEdit);
      case 'ADMIN_CATEGORY_ACTIVATE':
      case 'ADMIN_CATEGORY_DEACTIVATE':
      case 'ADMIN_CATEGORY_SHOW':
      case 'ADMIN_CATEGORY_HIDE': {
        if (id === null) return null;
        const input = {
          idempotencyKey: `${idempotencyKey}:category-${command.intent.slice('ADMIN_CATEGORY_'.length).toLowerCase()}`,
          categoryId: id,
        };
        try {
          if (command.intent === 'ADMIN_CATEGORY_ACTIVATE')
            await categories.activate(scope, actor, input);
          else if (command.intent === 'ADMIN_CATEGORY_DEACTIVATE')
            await categories.deactivate(scope, actor, input);
          else if (command.intent === 'ADMIN_CATEGORY_SHOW')
            await categories.show(scope, actor, input);
          else await categories.hide(scope, actor, input);
        } catch (error) {
          if (isCategoryMiss(error)) return CATEGORY_GONE;
          throw error;
        }
        // The state it HOLDS now, from the same builder the read uses — so a redelivered
        // tap reads as the state it found, and the button left on the screen is the
        // opposite of the state rather than the one just pressed.
        return this.adminCategoryDetail(scope, actor, id, mayEdit);
      }
      case 'ADMIN_CATEGORY_UP':
      case 'ADMIN_CATEGORY_DOWN':
        return id === null
          ? null
          : this.adminCategoryMove(
              scope,
              actor,
              id,
              command.intent === 'ADMIN_CATEGORY_UP',
              mayEdit,
              idempotencyKey,
            );
      case 'ADMIN_CATEGORY_DELETE_ASK':
        return id === null ? null : this.adminCategoryDeleteAsk(scope, actor, id, mayEdit);
      case 'ADMIN_CATEGORY_DELETE':
        return id === null ? null : this.adminCategoryDelete(scope, actor, id, idempotencyKey);
      case 'ADMIN_CATEGORY_NEW':
        return this.adminCategoryNew(scope, actor, command.args ?? [], mayEdit, idempotencyKey);
      case 'ADMIN_CATEGORY_RENAME':
      case 'ADMIN_CATEGORY_EMOJI':
        return this.adminCategoryEdit(
          scope,
          actor,
          command.intent === 'ADMIN_CATEGORY_RENAME' ? 'name' : 'emoji',
          command.args ?? [],
          mayEdit,
          idempotencyKey,
        );
      case 'ADMIN_CATEGORY_PRODUCTS':
        return this.adminCategoryProducts(scope, actor, command.cursor ?? null);
      case 'ADMIN_CATEGORY_PICK':
        return id === null ? null : this.adminCategoryPick(scope, actor, id, command.page ?? 0);
      case 'ADMIN_CATEGORY_ASSIGN':
        return id === null || command.secondaryId === undefined || command.secondaryId === null
          ? null
          : this.adminCategoryAssign(scope, actor, id, command.secondaryId, idempotencyKey);
      default:
        return null;
    }
  }

  /**
   * One page of the operator's category list.
   *
   * EVERY category, in the order customers see them — empty, hidden and inactive ones
   * included, because this is where an operator finds them to fix. Paged in memory from
   * `list`, which returns the whole list the Web Admin's screen draws: an operator's own
   * categories are a hand-made list, and the reorder buttons need its full order anyway.
   *
   * A page past the end — a delete shrank the list since the button was drawn — shows the
   * LAST page rather than an empty one: the list exists, it is just shorter now.
   */
  private adminCategoryList(
    list: readonly ProductCategoryListing[],
    requested: number,
    mayEdit: boolean,
  ): PendingReply {
    if (list.length === 0) {
      return { key: 'bot.admin.categories_none', values: {}, buttons: [], orderId: null };
    }
    const lastPage = Math.floor((list.length - 1) / ADMIN_CATEGORY_PAGE_SIZE);
    const page = Math.min(requested, lastPage);
    const start = page * ADMIN_CATEGORY_PAGE_SIZE;
    const buttons: CustomerButton[] = list
      .slice(start, start + ADMIN_CATEGORY_PAGE_SIZE)
      .map((category) => ({
        label: { kind: 'TEXT' as const, text: adminCategoryLabel(category) },
        data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${category.id}`,
      }));
    if (page > 0) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_previous_button' },
        data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${page - 1}`,
      });
    }
    if (page < lastPage) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_next_button' },
        data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}${page + 1}`,
      });
    }
    if (mayEdit) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.category_products_button' },
        data: ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
      });
    }
    return { key: 'bot.admin.categories_section', values: {}, buttons, orderId: null };
  }

  /**
   * One category, re-read from the list rather than trusted from the callback.
   *
   * From `list` and not `get`, because the screen needs two things `get` does not carry:
   * the product count, which decides whether the delete is possible, and the category's
   * POSITION, which decides whether up and down are drawn. Both are read now, so a stale
   * tap lands on the state that is true rather than on the one the old screen showed.
   */
  private async adminCategoryDetail(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    mayEdit: boolean,
  ): Promise<PendingReply> {
    const list = await this.requireCategories().list(scope, actor);
    const index = list.findIndex((category) => category.id === categoryId);
    const category = list[index];
    if (category === undefined) return CATEGORY_GONE;
    return adminCategoryReply(category, index, list.length, mayEdit);
  }

  /**
   * Moves a category one place, by writing the WHOLE order back.
   *
   * The service's reorder takes positions for any subset, and swapping only the two
   * neighbours' `sort_order` values looks simpler — and does nothing at all when they are
   * equal, which the default of every category created without a position is. So the
   * current order is renumbered in steps of ten with the two swapped, and the service
   * refuses the lot if any of them has gone.
   *
   * A redelivered update recomputes the order from the state its first delivery left and
   * sends a DIFFERENT position list under the same key, which the idempotency store
   * refuses as a payload mismatch. That refusal means "this update already ran", so it
   * is answered with the list as it now stands rather than with a refusal for a move
   * that happened.
   */
  private async adminCategoryMove(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    up: boolean,
    mayEdit: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const categories = this.requireCategories();
    const list = await categories.list(scope, actor);
    const index = list.findIndex((category) => category.id === categoryId);
    if (index < 0) return CATEGORY_GONE;
    const target = up ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) {
      // Already at that end: nothing to move, and the list says so.
      return this.adminCategoryList(list, Math.floor(index / ADMIN_CATEGORY_PAGE_SIZE), mayEdit);
    }
    const order = [...list];
    [order[index], order[target]] = [
      order[target] as ProductCategoryListing,
      order[index] as ProductCategoryListing,
    ];
    let after: readonly ProductCategoryListing[];
    try {
      after = await categories.reorder(scope, actor, {
        idempotencyKey: `${idempotencyKey}:category-move`,
        positions: order.map((category, position) => ({
          id: category.id,
          sortOrder: (position + 1) * 10,
        })),
      });
    } catch (error) {
      if (
        isNexaError(error) &&
        (error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH ||
          error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_FOUND)
      ) {
        /*
         * Either this update already ran, or a category in the list was deleted between
         * the read and the write — in which case the service refused the WHOLE reorder
         * and nothing moved. Both are answered with the list as it is now, which is the
         * truth in either case.
         */
        const now = await categories.list(scope, actor);
        const at = now.findIndex((category) => category.id === categoryId);
        return this.adminCategoryList(
          now,
          Math.floor(Math.max(at, 0) / ADMIN_CATEGORY_PAGE_SIZE),
          mayEdit,
        );
      }
      throw error;
    }
    const moved = after.findIndex((category) => category.id === categoryId);
    return this.adminCategoryList(
      after,
      Math.floor(Math.max(moved, 0) / ADMIN_CATEGORY_PAGE_SIZE),
      mayEdit,
    );
  }

  /**
   * The question before a delete, or the refusal it would get.
   *
   * A category that still holds products is answered with the count and no confirm
   * button: the delete would be refused, and a button whose every press is refused is
   * the "silent success" shape the other way round. The count here is a COURTESY read
   * when the screen is drawn; `ProductCategoryService.remove` counts again under the
   * category's lock and refuses on that number, not this one.
   */
  private async adminCategoryDeleteAsk(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    mayEdit: boolean,
  ): Promise<PendingReply> {
    if (!mayEdit) return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    const list = await this.requireCategories().list(scope, actor);
    const category = list.find((candidate) => candidate.id === categoryId);
    if (category === undefined) return CATEGORY_GONE;
    const back: CustomerButton = {
      label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
      data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${category.id}`,
    };
    if (category.productCount > 0) {
      return {
        key: 'bot.admin.category_not_empty',
        values: { products: category.productCount },
        buttons: [back],
        orderId: null,
      };
    }
    return {
      key: 'bot.admin.category_delete_ask',
      values: { name: category.name },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.category_delete_confirm_button' },
          data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}X:${category.id}`,
        },
        back,
      ],
      orderId: null,
    };
  }

  /**
   * Deletes a category — and says how many products stopped it when it cannot.
   *
   * The count in the refusal is the one `remove` took under the category's lock and put on
   * the error, not one read here: a product filed under the category between the ask and
   * the confirm is exactly the case the lock exists for, and this reply names it.
   *
   * The name is read BEFORE the delete, because afterwards there is nothing to read it
   * from. A redelivered confirm finds no row to read, and `remove` replays its first
   * answer; the reply then names nothing rather than inventing a name.
   */
  private async adminCategoryDelete(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const categories = this.requireCategories();
    const before = (await categories.list(scope, actor)).find(
      (candidate) => candidate.id === categoryId,
    );
    try {
      await categories.remove(scope, actor, {
        idempotencyKey: `${idempotencyKey}:category-delete`,
        categoryId,
      });
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CATEGORY_NOT_EMPTY) {
        const held = error.details?.['productCount'];
        return {
          key: 'bot.admin.category_not_empty',
          values: { products: typeof held === 'number' ? held : (before?.productCount ?? 0) },
          buttons: [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
              data: `${ADMIN_CATEGORY_CALLBACK_PREFIX}v:${categoryId}`,
            },
          ],
          orderId: null,
        };
      }
      if (isCategoryMiss(error)) return CATEGORY_GONE;
      throw error;
    }
    return {
      key: 'bot.admin.category_deleted',
      values: { name: before?.name ?? '—' },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
          data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * `/category_new <name>` — a new category at the END of the list.
   *
   * At the end because that is where an operator looks for the thing they just made, and
   * because putting it anywhere else would reorder what customers already see. It is
   * created ACTIVE and VISIBLE by the service, and an empty category is invisible to
   * customers whatever its flags say, so nothing reaches a customer until a product is
   * filed under it.
   *
   * The position is part of what the idempotency key hashes, and a redelivered update
   * computes it from a list that now includes the category it created — a payload
   * mismatch meaning "this already ran", answered with the list that shows it.
   */
  private async adminCategoryNew(
    scope: TenantContext,
    actor: ActorContext,
    args: readonly string[],
    mayEdit: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const categories = this.requireCategories();
    const name = args.join(' ').trim();
    if (name === '') return CATEGORY_USAGE;
    const list = await categories.list(scope, actor);
    const last = list.reduce((max, category) => Math.max(max, category.sortOrder), 0);
    let created;
    try {
      created = await categories.create(scope, actor, {
        idempotencyKey: `${idempotencyKey}:category-new`,
        draft: {
          name,
          description: null,
          emoji: null,
          sortOrder: Math.min(last + 10, CATEGORY_SORT_ORDER_MAX),
        },
      });
    } catch (error) {
      if (isNexaError(error) && error.code === PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH) {
        const now = await categories.list(scope, actor);
        return this.adminCategoryList(now, Number.MAX_SAFE_INTEGER, mayEdit);
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID) {
        return CATEGORY_USAGE;
      }
      // A redelivered create whose category has since been deleted: the service says
      // what it created is gone, which is the section's one answer for that.
      if (isCategoryMiss(error)) return CATEGORY_GONE;
      throw error;
    }
    return this.adminCategoryDetail(scope, actor, created.id, mayEdit);
  }

  /**
   * `/category_rename <id> <name>` and `/category_emoji <id> <emoji or ->`.
   *
   * The service's edit replaces name, description and emoji together — the Web Admin's
   * form sends all three — so the current values are read first and only the one this
   * command names is changed. `-` clears the emoji, because absence is a valid state
   * and a command needs a way to say it.
   *
   * A malformed id, an empty name, a name too long for a button or a string that is not
   * an emoji all answer with the syntax: each is a fact about the message that was sent,
   * and the service is what decided it. An id that is well-formed and names nothing here
   * is `category_gone`, the section's one answer for that.
   */
  private async adminCategoryEdit(
    scope: TenantContext,
    actor: ActorContext,
    field: 'name' | 'emoji',
    args: readonly string[],
    mayEdit: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const categories = this.requireCategories();
    const [categoryId, ...rest] = args;
    const value = rest.join(' ').trim();
    if (categoryId === undefined || value === '') return CATEGORY_USAGE;
    const current = (await categories.list(scope, actor)).find(
      (candidate) => candidate.id === categoryId.toLowerCase(),
    );
    if (current === undefined) {
      return uuidV7Schema.safeParse(categoryId).success ? CATEGORY_GONE : CATEGORY_USAGE;
    }
    try {
      await categories.update(scope, actor, {
        idempotencyKey: `${idempotencyKey}:category-${field}`,
        categoryId: current.id,
        edit: {
          name: field === 'name' ? value : current.name,
          description: current.description,
          emoji: field === 'emoji' ? (value === '-' ? null : value) : current.emoji,
        },
      });
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID) {
        return CATEGORY_USAGE;
      }
      if (isCategoryMiss(error)) return CATEGORY_GONE;
      throw error;
    }
    return this.adminCategoryDetail(scope, actor, current.id, mayEdit);
  }

  /**
   * The products an operator can move, each labelled with the category it is in NOW.
   *
   * Every product of this tenant, whatever its status, by `ProductService.list` — the
   * same list the Web Admin's products screen pages — so an uncategorised product, the
   * one no customer can buy, is on it. Keyset-paged by `(created_at, id)`, which no
   * operator action changes, so the next page is stable.
   */
  private async adminCategoryProducts(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const [page, list] = await Promise.all([
      this.deps.products.list(scope, actor, {
        limit: ADMIN_QUEUE_LIMIT,
        search: {},
        ...(cursor === null
          ? {}
          : { cursor: { createdAt: cursor.createdAt, id: cursor.id as ProductId } }),
      }),
      this.requireCategories().list(scope, actor),
    ]);
    if (page.items.length === 0) {
      return { key: 'bot.admin.category_products_none', values: {}, buttons: [], orderId: null };
    }
    const names = new Map(list.map((category) => [category.id as string, category.name]));
    const buttons: CustomerButton[] = page.items.map((product) => ({
      label: {
        kind: 'TEXT' as const,
        text: `${product.title} — ${product.categoryId === null ? '—' : (names.get(product.categoryId) ?? '—')}`,
      },
      data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.0`,
    }));
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.category_products_more_button' },
        data: `${ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.category_products', values: {}, buttons, orderId: null };
  }

  /**
   * Which category one product should move to: every category except its current one.
   *
   * Inactive and hidden categories are offered too. Filing a product under one is a real
   * operator choice — staging a category before showing it — and the customer-facing
   * rules decide separately whether anybody can buy it there.
   */
  private async adminCategoryPick(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    requested: number,
  ): Promise<PendingReply> {
    let product: ProductRecord;
    try {
      product = await this.deps.products.get(scope, actor, productId);
    } catch (error) {
      if (isProductMiss(error)) return PRODUCT_GONE;
      throw error;
    }
    const list = await this.requireCategories().list(scope, actor);
    const current = list.find((category) => category.id === product.categoryId);
    const choices = list.filter((category) => category.id !== product.categoryId);
    if (choices.length === 0) {
      return { key: 'bot.admin.category_pick_none', values: {}, buttons: [], orderId: null };
    }
    const lastPage = Math.floor((choices.length - 1) / ADMIN_CATEGORY_PAGE_SIZE);
    const page = Math.min(requested, lastPage);
    const start = page * ADMIN_CATEGORY_PAGE_SIZE;
    const buttons: CustomerButton[] = choices
      .slice(start, start + ADMIN_CATEGORY_PAGE_SIZE)
      .map((category) => ({
        label: { kind: 'TEXT' as const, text: adminCategoryLabel(category) },
        data: `${ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX}${encodeIdPair(product.id, category.id)}`,
      }));
    if (page > 0) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_previous_button' },
        data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.${page - 1}`,
      });
    }
    if (page < lastPage) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.categories_next_button' },
        data: `${ADMIN_CATEGORY_PICK_CALLBACK_PREFIX}${product.id}.${page + 1}`,
      });
    }
    return {
      key: 'bot.admin.category_pick',
      values: { product: product.title, category: current?.name ?? '—' },
      buttons,
      orderId: null,
    };
  }

  /**
   * Moves one product into one category, through `ProductCategoryService.reassignProduct`,
   * which locks the destination first so the category it names still exists at commit.
   *
   * The names in the reply are read AFTER the move, so they are the ones that are true
   * now — a rename between the pick and the tap shows the new name, not the button's.
   */
  private async adminCategoryAssign(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    categoryId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const categories = this.requireCategories();
    try {
      await categories.reassignProduct(scope, actor, {
        idempotencyKey: `${idempotencyKey}:category-assign`,
        productId,
        categoryId,
      });
    } catch (error) {
      if (isProductMiss(error)) return PRODUCT_GONE;
      if (isCategoryMiss(error)) return CATEGORY_GONE;
      throw error;
    }
    const [product, list] = await Promise.all([
      this.deps.products.get(scope, actor, productId),
      categories.list(scope, actor),
    ]);
    const category = list.find((candidate) => candidate.id === product.categoryId);
    return {
      key: 'bot.admin.category_moved',
      values: { product: product.title, category: category?.name ?? '—' },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.categories_back_button' },
          data: `${ADMIN_CATEGORIES_CALLBACK_PREFIX}0`,
        },
      ],
      orderId: null,
    };
  }

  /** The categories service, which `adminCategoryTurn` has already proven present. */
  private requireCategories(): NonNullable<BotRuntimeDeps['productCategories']> {
    const categories = this.deps.productCategories;
    if (categories === undefined) throw new Error('The categories section is not configured.');
    return categories;
  }

  /**
   * The administrator section: who holds Telegram access, and the two commands.
   *
   * The rows are buttons that REVOKE, which is the one thing the research found its
   * own section could do besides list and create — and the label is the administrator's
   * username plus their Telegram id, because identity here is the numeric id and a
   * reviewer needs to see which account they are removing.
   */
  private async adminSection(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const roster = await this.deps.telegramAdmins?.listAll(scope, actor);
    if (roster === undefined || roster.length === 0) {
      return { key: 'bot.admin.admins_none', values: {}, buttons: [], orderId: null };
    }
    /*
     * BOUNDED, and the bound is printed rather than applied silently.
     *
     * A Telegram inline keyboard has a size limit, and `create` enforces no
     * ceiling on how many administrators a tenant may hold — so mapping an
     * unbounded roster into one keyboard eventually fails the whole send, and
     * the section stops working at exactly the size where an operator most
     * needs it. Every other list on this surface bounds itself for the same
     * reason.
     *
     * What is NOT acceptable is the quiet version: a truncated roster reads
     * exactly like a complete one, and an operator who cannot find somebody
     * concludes they are not an administrator. The header carries both counts,
     * so a bound that was reached says so.
     */
    const page = roster.slice(0, ADMIN_ROSTER_LIMIT);
    return {
      key: 'bot.admin.section',
      values: { shown: page.length, total: roster.length },
      /*
       * EVERY administrator, not only the Telegram-bound ones.
       *
       * Until WP1 this listed `listBound`, which put the operator's most urgent reason
       * to open this surface out of reach: the administrator you need to disable from a
       * phone is under no obligation to have a Telegram binding, and one who had none
       * simply did not appear. `listBound` still exists and still answers a different
       * question — who can be REACHED here — which is what the receipt lane needs.
       *
       * The row carries the username and the status and nothing else. A row is a
       * button label, so it is as forwardable as the detail screen and gets the same
       * treatment: no numeric Telegram id, which belongs on the screen where the
       * revoke button that acts on it is.
       */
      buttons: page.map((entry) => ({
        label: {
          kind: 'TEXT' as const,
          text: `${entry.admin.username} — ${entry.admin.status}`,
        },
        data: `${ADMIN_ADMIN_CALLBACK_PREFIX}${entry.admin.id}`,
      })),
      orderId: null,
    };
  }

  /**
   * One administrator, and the two writes this surface may make about them.
   *
   * The roster is re-read rather than a per-administrator repository method being
   * added, and the reason is the rule rather than convenience: `management.list` is
   * the one projection that charges `admins.view`, scopes to the tenant and resolves
   * role keys, and a second read path would be a second answer to "what may be shown".
   * An administrator roster is people an operator created by hand, so the cost is a
   * bounded scan, not a table.
   *
   * An id that is unknown, another tenant's or malformed gets ONE answer — the rule
   * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
   * anything.
   */
  private async adminAdmin(
    scope: TenantContext,
    actor: ActorContext,
    adminId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const roster = (await this.deps.telegramAdmins?.listAll(scope, actor)) ?? [];
    const found = roster.find((entry) => entry.admin.id === adminId);
    if (found === undefined) {
      return { key: 'bot.admin.admin_gone', values: {}, buttons: [], orderId: null };
    }
    return this.adminAdminReply(found, actor, permissions);
  }

  /**
   * Activates or disables one administrator.
   *
   * `setStatus` carries every refusal this needs — the caller may not act on
   * themselves, the last remaining owner survives, an actor cannot restore more
   * privilege than they hold, the tenant is locked and the permission is re-checked
   * inside the writing transaction — so this adds none of its own and catches nothing:
   * `adminTurn`'s single refusal is what answers a denial, and which denial it was
   * belongs to the audit row.
   *
   * The reply names the STATUS the administrator now holds rather than the button that
   * was pressed. A redelivered update therefore reads as the state it found instead of
   * claiming a second change, which is the same property the target-valued callback
   * gives the tap itself.
   */
  private async adminAdminStatus(
    scope: TenantContext,
    actor: ActorContext,
    adminId: string,
    status: 'ACTIVE' | 'DISABLED',
    permissions: ReadonlySet<PermissionKey>,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    const updated = await admins.setStatus(
      scope,
      actor,
      adminId,
      status,
      'Status changed from the Telegram management panel.',
      idempotencyKey,
    );
    return {
      key: 'bot.admin.admin_status_changed',
      values: { username: updated.admin.username, status: updated.admin.status },
      buttons: this.adminAdminReply(updated, actor, permissions).buttons,
      orderId: null,
    };
  }

  /**
   * The detail screen for one administrator, shared by the read and the write.
   *
   * ONE builder, so the buttons an operator sees after a change are the buttons the
   * new state actually offers — a second copy is how a disable leaves an "disable"
   * button on the screen.
   *
   * The status button offered is the OPPOSITE of the current status, and it is not
   * drawn at all for the caller themselves: `setStatus` refuses self-modification
   * outright, so a button there could only ever record a refusal. That is a courtesy,
   * not the enforcement — the service refuses it whether or not the button exists.
   */
  private adminAdminReply(
    entry: AdminRosterEntry,
    actor: ActorContext,
    permissions: ReadonlySet<PermissionKey>,
  ): PendingReply {
    const isSelf = actor.id === entry.admin.id;
    const mayEdit = permissions.has(ADMINS_EDIT_PERMISSION);
    const buttons: CustomerButton[] = [];
    if (mayEdit && !isSelf) {
      const next = entry.admin.status === 'ACTIVE' ? 'd' : 'a';
      buttons.push({
        label: {
          kind: 'TEMPLATE',
          key:
            entry.admin.status === 'ACTIVE'
              ? 'bot.admin.admin_disable_button'
              : 'bot.admin.admin_enable_button',
        },
        data: `${ADMIN_ADMIN_STATUS_CALLBACK_PREFIX}${next}:${entry.admin.id}`,
      });
      if (entry.admin.telegramUserId !== null) {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.revoke_button' },
          data: `${ADMIN_REVOKE_CALLBACK_PREFIX}${entry.admin.id}`,
        });
      }
    }
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.admins_back_button' },
      data: ADMIN_SECTION_CALLBACK_PREFIX,
    });
    return {
      key: 'bot.admin.admin_detail',
      values: {
        username: entry.admin.username,
        displayName: entry.admin.displayName,
        status: entry.admin.status,
        roles: entry.roleKeys.join(', '),
        telegram: entry.admin.telegramUserId ?? '—',
      },
      buttons,
      orderId: null,
    };
  }

  /** Removes one administrator's Telegram access, by the button beside their row. */
  private async adminRevokeAccess(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    const revoked = await admins.revoke(
      scope,
      actor,
      targetId,
      'Telegram access revoked from the management panel.',
    );
    return {
      key: 'bot.admin.revoked',
      values: { username: revoked.username },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * `/link <telegram id> <username>` — gives an existing administrator Telegram access.
   *
   * TWO arguments in one message, which is what makes this a command rather than a
   * prompt: nothing is remembered between updates, so there is no window in which an
   * ordinary message can be swallowed as an answer (INCIDENT-FIN-001).
   *
   * It cannot create an administrator, and that is stated in the reply rather than
   * worked around: a Telegram-only administrator would need a row with no usable
   * password hash, and this identity model has no such shape.
   */
  private async adminLink(
    scope: TenantContext,
    actor: ActorContext,
    args: readonly string[],
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    const telegramUserId = args[0];
    const username = args[1];
    if (admins === undefined || telegramUserId === undefined || username === undefined) {
      return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
    }
    const linked = await admins.link(scope, actor, {
      telegramUserId,
      username,
      reason: 'Telegram access granted from the management panel.',
    });
    return {
      key: 'bot.admin.linked',
      values: { username: linked.username },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * `/role <username> <role key>` — sets an administrator's roles to one Nexa preset.
   *
   * Nexa's roles, not a second enum. The four labels the Mirza research observed are
   * expressible as presets that already exist (`owner`, `sales`, `support`,
   * `receipt_reviewer`), and `setRoles` carries the escalation rule, the last-owner
   * protection and the audit row that a Telegram-side enum would not.
   *
   * ONE role, because a keyboard-free command that took a list would be a list a
   * reviewer cannot see; the Web Admin is where a multi-role composition is edited.
   */
  private async adminRole(
    scope: TenantContext,
    actor: ActorContext,
    args: readonly string[],
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    const username = args[0];
    const roleKey = args[1];
    if (admins === undefined || username === undefined || roleKey === undefined) {
      return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
    }
    const result = await admins.setRoles(scope, actor, {
      username,
      roleKeys: [roleKey],
      reason: 'Roles set from the Telegram management panel.',
      // The update's own key, as the payment decisions pass theirs: a redelivered
      // command is answered from the store, never run twice.
      idempotencyKey,
    });
    return {
      key: 'bot.admin.roles_set',
      values: { username: result.admin.username, roles: result.roleKeys.join(', ') },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * The mandatory channel membership guard (Package B, audit §2.6), in front of `act` and
   * nowhere else — one guard, not a check copied into each handler.
   *
   * Runs after the customer is resolved and counted, so a `/start ref-…` still attributes
   * and anti-spam still sees the interaction; only the business action is withheld. Exempt:
   * the management panel, support and help (`/paysupport` opens support), and the check
   * itself. A bound administrator is never locked out, and the binding is asked only when
   * something is missing, so an ordinary turn pays for no extra lookup.
   *
   * The check button answers the MAIN MENU on a pass. It never replays what the customer
   * first asked for: a purchase, a payment or a termination is not something a membership
   * check may run.
   */
  private async guardedAct(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const checking = command.intent === 'MEMBERSHIP_CHECK';
    const safe: BotCommand = checking
      ? { intent: 'MAIN_MENU', targetId: null, callbackQueryId: command.callbackQueryId }
      : command;
    const membership = this.deps.membership;
    if (
      membership === undefined ||
      /*
       * Customer 360 (§11.4): an operator's per-customer exemption, read from the row this
       * update resolved — so it is enforced HERE, at the one gate, and an exemption lifted
       * a moment ago applies to the very next update. Telegram is not asked at all.
       */
      customer.channelMembershipExemptAt !== null ||
      (!checking &&
        (MEMBERSHIP_EXEMPT_INTENTS.has(command.intent) || ADMIN_INTENTS.has(command.intent)))
    ) {
      return this.termsGatedAct(scope, actor, safe, customer, arrival, input);
    }
    const missing = await membership.missingRequired(scope, {
      botInstanceId: input.botInstanceId,
      telegramUserId: input.telegramUserId,
      fresh: checking,
    });
    if (
      missing.length === 0 ||
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
    ) {
      return this.termsGatedAct(scope, actor, safe, customer, arrival, input);
    }
    return membershipRequired(
      checking ? 'bot.channels.still_missing' : 'bot.channels.join_required',
      missing,
    );
  }

  /**
   * The terms and rules gate (program §6), the second half of the ONE central guard: it
   * runs only behind the membership gate, and `act` is reached only through it. Not a check
   * copied into handlers — a handler cannot forget it, and a crafted callback for any
   * customer action meets it like a tapped one.
   *
   * While enforcement is on and the customer has not accepted the CURRENT published
   * version, every customer intent is answered with that version and its accept button
   * instead. Exempt, as from the membership gate: support, help, the promotional opt-out
   * and the management panel; a bound administrator is never stopped. The requirement is
   * asked only for an intent that would be gated, so the exempt ones pay for no lookup.
   *
   * The accept button is the only way through. It names the version it was drawn under:
   * that version is recorded only while it is still the current one, and a button under an
   * older message answers with the version that replaced it. After acceptance the customer
   * gets the main menu — never a replay of what they first asked for.
   */
  private async termsGatedAct(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const terms = this.deps.terms;
    if (command.intent === 'TERMS_ACCEPT') {
      return this.acceptTerms(scope, actor, command, customer, arrival, input);
    }
    if (
      terms === undefined ||
      MEMBERSHIP_EXEMPT_INTENTS.has(command.intent) ||
      ADMIN_INTENTS.has(command.intent)
    ) {
      return this.act(scope, actor, command, customer, arrival, input);
    }
    const required = await terms.requirement(scope, customer.id);
    if (
      required === null ||
      (await this.deps.telegramAdmins?.resolve(scope, input.telegramUserId, actor.correlationId)) !=
        null
    ) {
      return this.act(scope, actor, command, customer, arrival, input);
    }
    return termsRequired('bot.terms.required', required);
  }

  private async acceptTerms(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    const menu: BotCommand = {
      intent: 'MAIN_MENU',
      targetId: null,
      callbackQueryId: command.callbackQueryId,
    };
    const terms = this.deps.terms;
    if (terms === undefined || command.targetId === null) {
      return this.act(scope, actor, menu, customer, arrival, input);
    }
    // The update's key is already spent by `resolveFromUpdate` under this surface: the
    // acceptance is a second command of the same turn, so it takes the turn's sub-key.
    const accepted = await terms.accept(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:terms`,
      customerId: customer.id,
      termsVersionId: command.targetId,
      botInstanceId: input.botInstanceId,
    });
    if (accepted.outcome === 'STALE') {
      /*
       * Nothing was recorded. When a newer version replaced the one shown, it is shown now
       * with its own button — whatever enforcement says, because the customer asked to
       * accept the rules and the rules they would be accepting are these. When nothing is
       * published any more, there is nothing to accept: the main menu.
       */
      return accepted.current === null
        ? this.act(scope, actor, menu, customer, arrival, input)
        : termsRequired('bot.terms.updated', accepted.current);
    }
    const reply = await this.act(scope, actor, menu, customer, arrival, input);
    return { ...reply, key: 'bot.terms.accepted' };
  }

  /**
   * What this intent produces, as a reply that has not been sent yet.
   *
   * Every branch returns; there is no fallthrough that leaves a customer unanswered,
   * which is the failure mode the legacy bot has for anything it does not recognise.
   */
  private async act(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      /**
       * WHO sent it, by Telegram's numeric id.
       *
       * Carried because the management panel resolves an administrator from it, and
       * never used as a fact about a customer — `resolveFromUpdate` already turned it
       * into a row before this runs. Never a username: usernames are reassignable and a
       * customer can choose one that looks like an administrator's.
       */
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    /*
     * Item 12 (C4): a TAPPED button this runtime could not read — a MirzaBot keyboard still
     * in a chat after cutover (same token), a keyboard from an older release, or data a
     * client truncated or made up. `intentOf` already refused to map it onto any action;
     * this answers it truthfully: the button is no longer active, and here is the main
     * menu. Decided first, so no handler below ever sees it, and with nothing read from the
     * data. A typed message nobody recognises keeps `bot.unknown_command`.
     */
    if (command.intent === 'UNSUPPORTED' && isCallbackQueryUpdate(input.update)) {
      return staleCallbackReply();
    }
    if (command.intent === 'CATALOG') return this.catalogue(scope, actor, 0, customer);
    if (command.intent === 'CATALOG_PAGE') {
      return this.catalogue(scope, actor, command.page ?? 0, customer);
    }
    if (command.intent === 'TRIAL_CLAIM') {
      return this.beginTrial(scope, actor, customer, input.idempotencyKey);
    }
    if (command.intent === 'TRIAL_PANEL' && command.targetId !== null) {
      return this.claimTrial(scope, actor, customer, command.targetId, input.idempotencyKey);
    }
    if (command.intent === 'CUSTOM_SERVICE_MENU') {
      return this.customServiceMenu(scope, actor, customer);
    }
    if (command.intent === 'CUSTOM_SERVICE_LOCATION' && command.targetId !== null) {
      return this.customServiceLocation(scope, actor, customer, command.targetId, {
        idempotencyKey: input.idempotencyKey,
        botInstanceId: input.botInstanceId,
      });
    }
    if (command.intent === 'CATEGORY' && command.targetId !== null) {
      return this.categoryPage(scope, actor, command.targetId, command.page ?? 0, customer.id);
    }
    if (command.intent === 'ORDER' && command.targetId !== null) {
      return this.draft(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'CONFIRM' && command.targetId !== null) {
      return this.confirm(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'USERNAME_CUSTOM' && command.targetId !== null) {
      return this.customUsername(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'USERNAME_AUTOMATIC' && command.targetId !== null) {
      return this.automaticUsername(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'DISCOUNT_CODE_ENTER' && command.targetId !== null) {
      return this.enterDiscountCode(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'DISCOUNT_CODE_REMOVE' && command.targetId !== null) {
      return this.removeDiscountCode(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
      );
    }
    /*
     * The one intent produced by an ordinary message, and the one place this surface
     * asks the database what an ordinary message meant.
     *
     * `args[0]` is the raw text, untouched: `isValidCustomUsername` is asked of the raw
     * input, and a surface that trimmed it first would be deciding what the customer
     * typed. `NO_WINDOW` returns the same fallback any unrecognised string has always
     * got, which is what makes routing plain text here safe.
     */
    if (command.intent === 'USERNAME_TEXT') {
      const text = command.args?.[0];
      /*
       * An administrator's amount capture is asked FIRST, and only answers for a sender
       * whose own capture is waiting (Payment File 02 §12). A customer's username window
       * is theirs as a customer; the two never read the same message, because a capture
       * that answers returns here and one that does not falls through untouched.
       */
      const amount =
        text === undefined ? null : await this.adminCaptureText(scope, actor, text, input);
      if (amount !== null) return amount;
      /*
       * The customer's own text window next (customer UX completion §N): an amount, a
       * search term or a note, whichever prompt they saw last. A window that is not
       * open answers NO_WINDOW and the message goes on to the order windows untouched.
       */
      const captured =
        text === undefined ? null : await this.capturedText(scope, actor, customer, text, input);
      if (captured !== null) return captured;
      if (text !== undefined) {
        return this.typedUsername(
          scope,
          actor,
          text,
          customer,
          input.botInstanceId,
          input.idempotencyKey,
        );
      }
    }
    if (command.intent === 'WALLET') return this.walletBalance(scope, actor, customer);
    if (command.intent === 'MARKETING_OPT_OUT' || command.intent === 'MARKETING_OPT_IN') {
      return this.marketingPreference(
        scope,
        actor,
        customer,
        command.intent === 'MARKETING_OPT_OUT',
        input.idempotencyKey,
      );
    }
    if (
      command.intent === 'MAIN_MENU' ||
      command.intent === 'HELP' ||
      command.intent === 'SUPPORT'
    ) {
      if (command.intent !== 'MAIN_MENU') return this.supportScreen(scope, customer);
      return {
        key: 'bot.start.welcome_back',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
      };
    }
    // WP-A7: the customer's support tickets.
    const ticketed = await this.ticketTurn(scope, actor, command, customer, input);
    if (ticketed !== null) return ticketed;
    if (command.intent === 'TUTORIAL') return this.tutorialChoice(scope, customer);
    if (command.intent === 'TUTORIAL_PLATFORM' && command.targetId !== null) {
      return this.tutorialPlatform(scope, customer, command.targetId as ClientAppPlatform);
    }
    if (command.intent === 'CLIENT_APP' && command.targetId !== null) {
      return this.clientApp(scope, customer, command.targetId, input.botInstanceId);
    }
    if (command.intent === 'SERVICE_CONNECTED' && command.targetId !== null) {
      // Acknowledged, and NOTHING is written: the customer told us a fact about their
      // own device, and a row saying so would be a claim this installation cannot check.
      const owned = await this.ownedService(scope, customer, command.targetId);
      return {
        key: owned === null ? 'bot.service.not_found' : 'bot.service.connected_ack',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    if (command.intent === 'TOPUP_MENU') {
      return this.topupBegin(scope, actor, customer, input.botInstanceId, input.idempotencyKey);
    }
    if (
      command.intent === 'TOPUP_ROUTE' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.topupRoute(
        scope,
        actor,
        customer,
        command.targetId,
        command.secondaryId as PaymentGatewayProvider,
      );
    }
    if (command.intent === 'TOPUP_CLOSE' && command.targetId !== null) {
      return this.topupClose(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICES_SEARCH') {
      return this.servicesSearchBegin(
        scope,
        actor,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_REFRESH' && command.targetId !== null) {
      return this.serviceRefresh(scope, actor, customer, command.targetId, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_CARD' && command.targetId !== null) {
      const card = await this.serviceDetail(scope, actor, customer, command.targetId);
      /*
       * Owner spec §2.3: a stale tap — a service transferred, refunded or never theirs —
       * still edits the list's message, and keeps the way back to the list on it, so the
       * customer is never left on a dead end where their list was.
       */
      return card.key === 'bot.service.not_found'
        ? { ...card, buttons: [backToListButton()], edit: true }
        : { ...card, edit: true };
    }
    /*
     * Round N (F4): every screen a service card's button opens is edited INTO the card's
     * message (`inCard`), and its way back (`sv:`) draws the same card in place again.
     */
    if (command.intent === 'SERVICE_NOTE' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceNoteBegin(
          scope,
          actor,
          customer,
          command.targetId,
          input.botInstanceId,
          input.idempotencyKey,
        ),
      );
    }
    if (command.intent === 'SERVICE_RENEW_QUOTE' && command.targetId !== null) {
      // The quote opens the payment wizard, which is its own message (R2).
      return this.commercialQuote(scope, actor, customer, command.targetId, 'RENEW', null, input);
    }
    if (command.intent === 'REFERRAL_GIFT') {
      return this.referralGift(scope, actor, customer, input.idempotencyKey);
    }
    if (command.intent === 'REFERRAL_INVITE') {
      return this.referralInvite(scope, actor, customer, input.botInstanceId, input.idempotencyKey);
    }
    if (command.intent === 'TOPUP_PICK' && command.targetId !== null) {
      return this.topupPick(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        input.botInstanceId,
      );
    }
    if (command.intent === 'PAY_WALLET' && command.targetId !== null) {
      return this.walletPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_MANUAL' && command.targetId !== null) {
      return this.manualPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_METHODS' && command.targetId !== null) {
      return this.paymentMethods(scope, actor, command.targetId, customer);
    }
    if (command.intent === 'PAY_METHODS_CLOSE' && command.targetId !== null) {
      const back = await this.paymentMethodsBack(scope, actor, command.targetId, customer);
      if (back !== null) return back;
      return {
        key: 'bot.start.welcome_back',
        values: {},
        buttons: [],
        orderId: null,
        keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
      };
    }
    /*
     * A rail with no adapter, answered rather than simulated.
     *
     * No button offers it — `paymentButtons` draws only what can be performed — so this
     * is reached by a customer holding an older message, and it is the one place that
     * answer is produced. Nothing here pretends money moved.
     */
    if (command.intent === 'PAY_GATEWAY' && command.targetId !== null) {
      return this.gatewayPayment(
        scope,
        actor,
        command.targetId,
        customer,
        input.idempotencyKey,
        (command.secondaryId as PaymentGatewayProvider | undefined) ?? null,
      );
    }
    if (command.intent === 'GATEWAY_CHECK' && command.targetId !== null) {
      return this.gatewayCheck(scope, command.targetId, customer);
    }
    if (command.intent === 'GATEWAY_RECEIPT' && command.targetId !== null) {
      return this.gatewayReceipt(scope, actor, command.targetId, customer, input.botInstanceId);
    }
    if (command.intent === 'GATEWAY_CARD_CHANGE' && command.targetId !== null) {
      return this.gatewayCardChange(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelPaymentAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'PAY_CANCEL' && command.targetId !== null) {
      return this.cancelPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'RECEIPT_UPLOAD' && command.file != null) {
      /*
       * WP-A7: a file answers a ticket window when that is the prompt the customer saw last;
       * otherwise it is a receipt, exactly as before.
       */
      const ticketFile = await this.ticketFile(scope, actor, customer, command.file, input);
      if (ticketFile !== null) return ticketFile;
      /*
       * TonPays Telegram (§8.3): a provider receipt window open for this customer IN THIS
       * BOT takes the file; its payment, provider and invoice come from the window's row.
       * Never the manual review queue. No window: the manual flow, exactly as before.
       */
      const providerReceipt = await this.gatewayReceiptPhoto(
        scope,
        actor,
        customer,
        input.botInstanceId,
        command.file,
      );
      if (providerReceipt !== null) return providerReceipt;
      return this.submitReceipt(
        scope,
        actor,
        customer,
        input.botInstanceId,
        command.file,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_SENT' && command.targetId !== null) {
      return this.signalTransferSent(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'ORDER_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelOrderAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'ORDER_CANCEL' && command.targetId !== null) {
      return this.cancelOrder(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_RENEW' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.renewMenu(scope, actor, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_ADD_TRAFFIC' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TRAFFIC'),
      );
    }
    if (command.intent === 'SERVICE_ADD_TIME' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TIME'),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TRAFFIC' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TRAFFIC',
        command.secondaryId,
        input,
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TIME' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TIME',
        command.secondaryId,
        input,
      );
    }
    if (command.intent === 'SERVICE_ADD_DEVICES' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.devicesChoice(scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_BUY_DEVICES' &&
      command.targetId !== null &&
      command.secondaryId != null &&
      command.quantity !== undefined
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_DEVICES',
        command.secondaryId,
        input,
        command.quantity,
      );
    }
    if (command.intent === 'SERVICE_CHANGE_LOCATION' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.locationChoice(scope, actor, customer, command.targetId),
      );
    }
    if (
      command.intent === 'SERVICE_LOCATION_TARGET' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return inCard(
        command.targetId,
        await this.locationTarget(
          scope,
          actor,
          customer,
          command.targetId,
          command.secondaryId,
          input,
        ),
      );
    }
    if (
      command.intent === 'SERVICE_LOCATION_CONFIRM' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return inCard(
        command.targetId,
        await this.locationRequest(
          scope,
          actor,
          customer,
          command.targetId,
          command.secondaryId,
          input,
        ),
      );
    }
    if (command.intent === 'SERVICE_ACTION_CONFIRM' && command.targetId !== null) {
      return this.commercialConfirm(scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICES') return this.services(scope, customer, 1);
    if (command.intent === 'SERVICES_PAGE') {
      // A keyset token from a message older than the paged list lands on page 1: the
      // token names a position in an ordering this list no longer uses.
      // Owner spec §2.3: a page, and «back to the list» from a card, EDIT the tapped
      // message — the list, the card and the list again are one message.
      return { ...(await this.services(scope, customer, command.page ?? 1)), edit: true };
    }
    if (command.intent === 'SERVICE' && command.targetId !== null) {
      return this.serviceDetail(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return this.serviceResend(scope, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_FILES' && command.targetId !== null) {
      return this.serviceFiles(scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'SUSPEND',
        input.idempotencyKey,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'RESUME',
        input.idempotencyKey,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    /*
     * WP15 G1: a customer cannot terminate a service. Both taps are still RECOGNISED —
     * a message drawn before this release still carries the buttons, and a bookmark or
     * a replayed callback carries the data — and both answer the same refusal a service
     * that cannot do something already gives. Neither looks the service up, plans an
     * operation or contacts anything: the refusal is about the customer, not the row.
     */
    if (command.intent === 'SERVICE_TERMINATE_ASK' || command.intent === 'SERVICE_TERMINATE') {
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    if (command.intent === 'SERVICE_ROTATE_ASK' && command.targetId !== null) {
      return this.serviceRotateAsk(scope, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_REFUND_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceRefundAsk(scope, customer, command.targetId),
      );
    }
    if (command.intent === 'SERVICE_REFUND_CONFIRM' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceRefundConfirm(
          scope,
          actor,
          customer,
          command.targetId,
          input.botInstanceId,
          input.idempotencyKey,
          updateIdOf(input.update),
        ),
      );
    }
    if (command.intent === 'SERVICE_TRANSFER_ASK' && command.targetId !== null) {
      return inCard(
        command.targetId,
        await this.serviceTransferAsk(scope, actor, customer, command.targetId, input),
      );
    }
    if (
      command.intent === 'SERVICE_TRANSFER_CONFIRM' &&
      command.targetId !== null &&
      typeof command.secondaryId === 'string' &&
      command.ownershipVersion !== undefined
    ) {
      return inCard(
        command.targetId,
        await this.serviceTransferConfirm(
          scope,
          actor,
          customer,
          command.targetId,
          {
            recipientTelegramUserId: command.secondaryId,
            ownershipVersion: command.ownershipVersion,
          },
          input,
        ),
      );
    }
    if (command.intent === 'SERVICE_ROTATE' && command.targetId !== null) {
      /*
       * Suffixed, as every other write that shares a turn with `resolveFromUpdate` is
       * (`docs/wp6-audit.md` §4): the bare update key is already spent in that turn.
       */
      return this.serviceRotate(
        scope,
        actor,
        customer,
        command.targetId,
        `${input.idempotencyKey}:rotate`,
        cardMessageOf(input.update, input.botInstanceId),
      );
    }
    /*
     * The main menu rides on `/start`, and on nothing else.
     *
     * Real v0.2.0 staging acceptance is what put it here: the bot registered five
     * commands with Telegram and an ordinary customer still had to know to type a
     * slash. Telegram keeps a `ReplyKeyboardMarkup` shown until something replaces it,
     * so attaching it once — to the first message anybody ever receives — is enough,
     * and attaching it to every reply would fight the inline keyboards the contextual
     * flows use.
     *
     * A BLOCKED customer gets `bot.blocked` and NO keyboard: the reply above returns
     * before this, and drawing a menu for somebody who may not use it is the untruthful
     * surface this codebase keeps refusing.
     */
    /*
     * The management panel, and it is reached through ONE door.
     *
     * Every admin intent lands here, whoever sent it, and `adminTurn` resolves the
     * Telegram account's binding before it decides anything. A customer who crafts
     * `D:<uuid>` reaches this line, resolves to no administrator, and falls through to
     * the same unsupported-input reply below that any other unrecognised string gets.
     */
    if (ADMIN_INTENTS.has(command.intent)) {
      const reply = await this.adminTurn(scope, actor, command, input);
      if (reply !== null) return reply;
    }

    const key = replyFor(command.intent, arrival);
    /*
     * Item 12 (C4): a TAPPED button that reached this fallback — an admin-shaped callback
     * from somebody who is not (or no longer) an administrator with that section, as well
     * as the unreadable ones decided at the top of `act` — gets the same stale-button
     * answer. One answer for every button this account cannot use, so the reply is not an
     * oracle for which callback shapes are management routes.
     */
    if (key === 'bot.unknown_command' && isCallbackQueryUpdate(input.update)) {
      return staleCallbackReply();
    }
    /*
     * The admin row is added for a Telegram account that resolves to an administrator,
     * and the resolution is the SAME one every admin action makes. A keyboard is not
     * authority — the actions re-check — but a button nobody behind it can use is the
     * untruthful surface this codebase keeps refusing.
     */
    const menu =
      command.intent === 'START'
        ? ({
            keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
          } as const)
        : {};
    return { key, values: {}, buttons: [], orderId: null, ...menu };
  }

  /**
   * The customer's own services: a heading and one button each.
   *
   * The same shape as the catalogue and for the same reason — `bot.service.list_heading`
   * declares no placeholders and a template is not a list renderer — so the services are
   * BUTTONS whose `callback_data` is the id. The empty case is a different KEY rather
   * than the heading with nothing under it, because an empty list reads as a failure
   * and `bot.service.list_empty` says what it actually is.
   *
   * `listForCustomer` takes the customer id from the RESOLVED customer row, never from
   * anything the update carried, so there is no id here for a modified client to change.
   */
  private async services(
    scope: TenantContext,
    customer: CustomerRecord,
    pageNumber: number,
  ): Promise<PendingReply> {
    const page = await this.deps.services.pageForCustomer(scope, customer.id, pageNumber);
    if (page.count === 0) {
      return {
        key: 'bot.service.list_empty',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const buttons: CustomerButton[] = page.items.map((service) => ({
      // The REAL username on the panel, as the approved list shows it; never the title.
      ...inlineLabel('services.item', { username: service.providerUsername }),
      // Owner spec §2.3: the card IN PLACE of the list (`sv:`); its back (`sl:`) the list again.
      data: `${SERVICE_CARD_CALLBACK_PREFIX}${service.id}`,
    }));
    buttons.push(...servicesListControls(page.page, page.pages));
    return {
      key: 'bot.service.list',
      values: { page: page.page, pages: page.pages, total: page.count },
      buttons,
      orderId: null,
    };
  }

  /**
   * R3 item 10: the customer's own service card, exactly as `serviceDetail` draws it, for
   * the provisioner to edit into the card a disable or enable was asked from. Null when
   * the service is not theirs to see any more (the same answer the tap would get), so
   * nothing is drawn for somebody else's service.
   */
  async serviceCardFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    /** Round N (F4): the one-line notice the card carries, e.g. a change that did not happen. */
    notice?: TemplateKey,
  ): Promise<{
    readonly key: TemplateKey;
    readonly values: TemplateValues;
    readonly buttons: readonly CustomerButton[];
  } | null> {
    const reply = await this.serviceDetail(
      scope,
      actor,
      { id: customerId },
      serviceId,
      notice === undefined ? {} : { notice },
    );
    if (reply.key === null || reply.key === 'bot.service.not_found') return null;
    return { key: reply.key, values: reply.values, buttons: reply.buttons };
  }

  /**
   * One service, as its owner sees it.
   *
   * `getForCustomer` asks for the service by id AND owner in one query, so an id that is
   * not theirs, an id that does not exist, and a service a completed refund request took
   * out of their view (WP19) all arrive here as `SERVICE_NOT_FOUND` — and all answer
   * `bot.service.not_found`. Keeping them the same
   * answer is what stops this being an oracle for guessing service ids.
   *
   * The usage figure is reported WITH the moment it was read. A figure with no `asOf` is
   * a figure a customer reads as live, and `usage_synced_at` is null until the first
   * `SYNC_USAGE` succeeds — so the template gets an absent `syncedAt` rather than a
   * fabricated one, which is the whole reason that placeholder is not required.
   */
  private async serviceDetail(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    /**
     * Round N (F4): `working` draws the card as «working» before the change it is about is
     * even planned — the tap's own answer, put on the card first so no later edit can
     * overwrite a final one — and `notice` adds one line under the status.
     */
    options: { readonly working?: boolean; readonly notice?: TemplateKey } = {},
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    if (title === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    /*
     * Round N (F4): a change still being applied — a disable, an enable, a new link or a
     * location move, planned, in flight or being reconciled — makes the card «working»,
     * from the operation rows, whichever message draws it. Its state is not final, so it
     * offers no action until the change has its answer; only the refresh (which redraws
     * it) and the way back to the list.
     */
    const working =
      options.working === true || (await this.deps.services.changeInProgress(scope, service));
    if (working) {
      const buttons: CustomerButton[] = [];
      if (await this.deps.services.customerSyncOffered(scope, service)) {
        buttons.push({
          ...inlineLabel('service.refresh'),
          data: `${SERVICE_REFRESH_CALLBACK_PREFIX}${service.id}`,
          row: 0,
        });
      }
      buttons.push({
        ...inlineLabel('service.back_to_list'),
        data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
        row: 5,
      });
      const card = await this.serviceCardScreen(scope, service, title, false, {
        working: true,
        ...(options.notice === undefined ? {} : { notice: options.notice }),
      });
      return { key: card.key, values: card.values, buttons, orderId: null };
    }

    /*
     * Every button below is a server-side decision re-decided on the tap; drawing one is
     * never the authorization. Rows: refresh alone; link beside rotate; note beside
     * add-traffic; renew beside the on/off switch; the terminate ask; back to the list.
     */
    const buttons: CustomerButton[] = [];
    if (await this.deps.services.customerSyncOffered(scope, service)) {
      buttons.push({
        ...inlineLabel('service.refresh'),
        data: `${SERVICE_REFRESH_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      });
    }
    // Package E: only where the panel's adapter can fetch its files.
    if (
      this.deps.subscriptionFiles !== undefined &&
      (await this.deps.subscriptionFiles.offered(scope, service))
    ) {
      buttons.push({
        ...inlineLabel('service.files'),
        data: `${SERVICE_FILES_CALLBACK_PREFIX}${service.id}`,
        row: 0,
      });
    }
    if (ProvisioningService.isDeliverable(service)) {
      buttons.push({
        ...inlineLabel('service.link'),
        data: `${SERVICE_RESEND_CALLBACK_PREFIX}${service.id}`,
        row: 1,
      });
    }
    const rotation = await this.deps.services.customerRotationFor(scope, service);
    if (rotation.offered) {
      buttons.push({
        ...inlineLabel('service.rotate'),
        data: `${SERVICE_ROTATE_ASK_CALLBACK_PREFIX}${service.id}`,
        row: 1,
      });
    }
    buttons.push({
      ...inlineLabel('service.note'),
      data: `${SERVICE_NOTE_CALLBACK_PREFIX}${service.id}`,
      row: 2,
    });
    const commercial = await this.deps.commercial.availableFor(scope, actor, service);
    if (commercial.includes('ADD_TRAFFIC')) {
      buttons.push({
        ...inlineLabel('service.add_traffic'),
        data: `${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${service.id}`,
        row: 2,
      });
    }
    if (commercial.includes('RENEW') || commercial.includes('ADD_TIME')) {
      buttons.push({
        ...inlineLabel('service.renew'),
        data: `${SERVICE_RENEW_CALLBACK_PREFIX}${service.id}`,
        row: 3,
      });
    }
    /*
     * WP-A5: extra users, on a row of their own, only where `availableFor` found every
     * condition true — a recorded limit, a panel whose adapter declares and implements
     * DEVICE_LIMIT_ADJUSTMENT, a rate that applies, and room left under its maximum. No
     * provider-name test anywhere: the capability decides.
     */
    if (commercial.includes('ADD_DEVICES')) {
      buttons.push({
        ...inlineLabel('service.add_devices'),
        data: `${SERVICE_ADD_DEVICES_CALLBACK_PREFIX}${service.id}`,
        // Its own row, drawn just below renew: an unused number is a new row where it
        // first appears, and 3 already holds renew and the on/off switch.
        row: 7,
      });
    }
    /*
     * WP-A6: «🌍 تغییر لوکیشن», on a row of its own, only where `availableFor` found every
     * condition true — an ACTIVE service, a panel whose adapter declares and implements
     * LOCATION_CHANGE, a known current location, and a configured target other than it.
     * The capability decides; no provider is named.
     */
    if (commercial.includes('CHANGE_LOCATION')) {
      buttons.push({
        ...inlineLabel('service.change_location'),
        data: `${SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX}${service.id}`,
        row: 8,
      });
    }
    const actions = await this.deps.services.customerActionsFor(scope, service);
    if (actions.includes('SUSPEND')) {
      buttons.push({
        ...inlineLabel('service.suspend'),
        data: `${SERVICE_SUSPEND_CALLBACK_PREFIX}${service.id}`,
        row: 3,
      });
    }
    if (actions.includes('RESUME')) {
      buttons.push({
        ...inlineLabel('service.resume'),
        data: `${SERVICE_RESUME_CALLBACK_PREFIX}${service.id}`,
        row: 3,
      });
    }
    // WP19: the refund request, alone on its row — it deletes the service, so it sits
    // apart from the everyday actions above it.
    if ((await this.deps.serviceRefunds?.offeredFor(scope, service)) === true) {
      buttons.push({
        ...inlineLabel('service.refund_request'),
        data: `${SERVICE_REFUND_ASK_CALLBACK_PREFIX}${service.id}`,
        row: 4,
      });
    }
    // Package F: beside the refund request — both hand the service away for good.
    if ((await this.deps.serviceTransfers?.offered(scope, service)) === true) {
      buttons.push({
        ...inlineLabel('service.transfer'),
        data: `${SERVICE_TRANSFER_ASK_CALLBACK_PREFIX}${service.id}`,
        row: 4,
      });
    }
    buttons.push({
      ...inlineLabel('service.back_to_list'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
      row: 5,
    });

    const card = await this.serviceCardScreen(
      scope,
      service,
      title,
      rotation.offered,
      options.notice === undefined ? {} : { notice: options.notice },
    );
    return { key: card.key, values: card.values, buttons, orderId: null };
  }

  /** The card's text: one composition for the ordinary card and the «working» one. */
  private async serviceCardScreen(
    scope: TenantContext,
    service: ServiceRecord,
    title: string,
    rotateOffered: boolean,
    extra: { readonly working?: boolean; readonly notice?: TemplateKey },
  ): Promise<{ readonly key: TemplateKey; readonly values: TemplateValues }> {
    const display = await this.deps.productDisplay.displayFor(scope, service.productId);
    return this.deps.screens.serviceCard(scope, {
      state: service.state,
      serviceUsername: service.providerUsername,
      // WP-A6: where the service has moved to, when it has; the product's label otherwise.
      serviceLocation: service.locationLabel ?? display?.serviceLocationLabel ?? null,
      productName: title,
      trafficLimitBytes: service.trafficLimitBytes,
      trafficUsedBytes: service.trafficUsedBytes,
      usageSyncedAt: service.usageSyncedAt,
      expiresAt: service.expiresAt,
      now: this.deps.clock.now(),
      lastSeen: lastSeenOf(service),
      note: service.customerNote,
      rotateOffered,
      ...extra,
    });
  }

  /**
   * A customer asking for their configuration again.
   *
   * The remedy `UNCONFIRMED` and `FAILED` were designed around: an announcement whose
   * outcome was never observed leaves a customer with nothing, and until now they had
   * no way to recover it themselves. `DeliveryService.redeliver` is what sends it —
   * through the SAME `markSendStarted` stamp and the same delivery accounting the
   * automatic lane uses, so a customer-requested send and a swept one cannot race each
   * other into two messages.
   *
   * This returns `key: null`, which `handle` reads as "nothing further to send". The
   * delivery service has already sent the subscription; a second message here would be
   * the runtime and the delivery lane both answering the same tap.
   */
  /**
   * The packages a customer may buy for one service, as buttons.
   *
   * A read and nothing else — no order, no row, no money. Each button carries the
   * service AND the package, because with no conversation state there is nowhere to
   * keep the first while the customer chooses the second, and neither can be inferred
   * from the other: they OWN the service and CHOOSE the package.
   *
   * The amount and the price are rendered from the row the operator configured, and
   * neither travels in the callback. What comes back is two identifiers.
   */
  private async addonChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<PendingReply> {
    let offer;
    try {
      offer = await this.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
    } catch (error) {
      return refusal(error);
    }

    const prefix =
      kind === 'ADD_TRAFFIC'
        ? SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX
        : SERVICE_BUY_TIME_CALLBACK_PREFIX;
    return {
      key: 'bot.service.addon_choice',
      values: {},
      /*
       * Unpriced rows are dropped rather than rendered at zero.
       *
       * `listOfferable` already filters them out in SQL, so this cannot fire — and it
       * is a filter rather than a `?? zero` because `catalog.ts` says an absent price
       * means unsellable and never free. A zero here would offer a customer a package
       * for nothing, which is the one way to be wrong that money cannot be taken back
       * from.
       */
      buttons: [
        ...offer.addons
          .filter((addon): addon is typeof addon & { price: Money } => addon.price !== null)
          .map((addon) => ({
            // The VALUES the key declares. Before the customer UX completion they were
            // put on a label that carried none, so the resolver threw and the screen
            // never sent; the label type carries values now and the messenger renders
            // them. A MONEY value, so the currency is the catalogue's, never typed.
            ...inlineLabel('service.addon_option', { title: addon.title, price: addon.price }),
            data: `${prefix}${encodeIdPair(serviceId, addon.id)}`,
          })),
        backToServiceButton(serviceId),
      ],
      orderId: null,
    };
  }

  /**
   * The extra users / devices offer for one service, as quantity buttons (WP-A5).
   *
   * A read and nothing else — no order, no row, no money. The current limit, the price of
   * one and how many more may be bought all come from `CommercialActionService.offer`,
   * which refuses for every reason the purchase would. Each button carries the service,
   * the rate and a count within what the server said remains; its label shows that
   * count's list price, and the quote screen the next tap produces states the final one.
   */
  private async devicesChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    let offer;
    try {
      offer = await this.deps.commercial.offer(scope, actor, customer.id, serviceId, 'ADD_DEVICES');
    } catch (error) {
      return refusal(error);
    }
    const devices = offer.devices;
    if (devices === null) {
      return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
    }
    const shown = Math.min(devices.remaining, DEVICE_ADDON_MAX_QUANTITY);
    const unit = devices.addon.price;
    const buttons: CustomerButton[] = [];
    for (let quantity = 1; quantity <= shown; quantity += 1) {
      buttons.push({
        ...inlineLabel('service.devices_option', {
          quantity,
          price: money(unit.amountMinor * BigInt(quantity), unit.currency),
        }),
        data: encodeDeviceQuantity(serviceId, devices.addon.id, quantity),
        // Two to a row, so a maximum of twenty stays a readable keyboard.
        row: Math.floor((quantity - 1) / 2),
      });
    }
    buttons.push({ ...backToServiceButton(serviceId), row: Math.ceil(shown / 2) });
    return {
      key: 'bot.service.devices_choice',
      values: {
        currentLimit: devices.currentLimit,
        unitPrice: unit,
        remaining: devices.remaining,
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * Where the service is and where it may be moved (WP-A6), as one button per target.
   *
   * A read and nothing else. The current location, the targets and their list prices all
   * come from `CommercialActionService.offer`, which refuses for every reason a move
   * would; each button carries the service and the configured location, never a price.
   */
  private async locationChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    let offer;
    try {
      offer = await this.deps.commercial.offer(
        scope,
        actor,
        customer.id,
        serviceId,
        'CHANGE_LOCATION',
      );
    } catch (error) {
      return refusal(error);
    }
    const locations = offer.locations ?? null;
    if (locations === null) {
      return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
    }
    const shown = locations.targets.slice(0, LOCATION_TARGETS_SHOWN);
    const buttons: CustomerButton[] = shown.map((target, index) => ({
      ...(target.price.amountMinor === 0n
        ? inlineLabel('service.location_option_free', { location: target.label })
        : inlineLabel('service.location_option', { location: target.label, price: target.price })),
      data: `${SERVICE_LOCATION_TARGET_CALLBACK_PREFIX}${encodeIdPair(serviceId, target.id)}`,
      row: index,
    }));
    buttons.push({ ...backToServiceButton(serviceId), row: shown.length });
    return {
      key: 'bot.service.location_choice',
      values: { currentLocation: locations.current.label },
      buttons,
      orderId: null,
    };
  }

  /**
   * A target tapped (WP-A6): its impact and price, and the way to confirm.
   *
   * Decided on the server first — not offered, already there, cooldown, limit and the
   * panel are each refused with their own sentence before anything is shown. A FREE move
   * then asks for an explicit confirmation (`lf:`) and writes nothing yet; a PRICED one
   * becomes the ordinary quote — the pre-invoice with its from / to block and the same
   * confirmation and payment buttons every commercial order uses.
   */
  private async locationTarget(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    let decided;
    try {
      decided = await this.deps.commercial.locationTarget(
        scope,
        actor,
        customer.id,
        serviceId,
        locationId,
      );
    } catch (error) {
      return refusal(error);
    }
    if (decided.target.price.amountMinor !== 0n) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        serviceId,
        'CHANGE_LOCATION',
        null,
        input,
        undefined,
        locationId,
      );
    }
    return {
      key: 'bot.service.location_confirm_free',
      values: { fromLocation: decided.current.label, toLocation: decided.target.label },
      buttons: [
        {
          ...inlineLabel('service.location_confirm'),
          data: `${SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX}${encodeIdPair(serviceId, locationId)}`,
          row: 0,
        },
        { ...backToServiceButton(serviceId), row: 1 },
      ],
      orderId: null,
    };
  }

  /**
   * A free move, confirmed (WP-A6). `LocationChangeService.requestFree` decides everything
   * again in its own transaction and plans the operation; the customer is told it was
   * recorded, and its outcome later through the notification lane.
   *
   * `idempotencyKey` is the update's, so Telegram redelivering the tap requests it once.
   */
  private async locationRequest(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    const changes = this.deps.locationChanges;
    if (changes === undefined) {
      return { key: 'bot.service.action_unavailable', values: {}, buttons: [], orderId: null };
    }
    try {
      await changes.requestFree(scope, actor, customer.id, {
        serviceId,
        locationId,
        idempotencyKey: `${input.idempotencyKey}:change_location`,
      });
    } catch (error) {
      return refusal(error);
    }
    return {
      key: 'bot.service.location_requested',
      values: {},
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
    };
  }

  /**
   * The quote a customer answers: what this action buys, and what it costs.
   *
   * It writes a DRAFT order and its invoice line — both in one transaction — and
   * commits the customer to nothing. The number shown is the number the order was
   * written with, and it is never re-taken: confirming re-checks that the service and
   * the package are still eligible and leaves the price exactly as the customer saw it.
   *
   * `idempotencyKey` is the update's, so Telegram redelivering the same tap produces
   * the same draft rather than a second one.
   */
  private async commercialQuote(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION',
    addonId: string | null,
    input: { readonly idempotencyKey: string },
    /** WP-A5: the extra-users count a `dq:` tap chose; absent for every other kind. */
    quantity?: number,
    /** WP-A6: the configured location an `lt:` tap chose; absent for every other kind. */
    locationId?: string,
  ): Promise<PendingReply> {
    try {
      const service = await this.ownedService(scope, customer, serviceId);
      if (service === null) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      const { order } = await this.deps.commercial.draft(scope, actor, customer.id, {
        serviceId,
        kind,
        ...(addonId === null ? {} : { addonId }),
        ...(quantity === undefined ? {} : { quantity }),
        ...(locationId === undefined ? {} : { locationId }),
        idempotencyKey: `${input.idempotencyKey}:${kind.toLowerCase()}`,
      });
      // The same pre-invoice and the same payment buttons as a new purchase (§H5, §H6):
      // one payment UX, and the username shown is the service's own.
      return this.preinvoice(scope, actor, order, customer, service.providerUsername);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer answering the quote: DRAFT to AWAITING_PAYMENT, then the payment
   * buttons.
   *
   * The same two steps a product purchase takes, and deliberately the same screen after
   * them — `paymentButtons` is shared, so wallet and manual transfer work on a
   * commercial order without knowing it is one.
   */
  private async commercialConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    orderId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.commercial.confirm(scope, actor, customer.id, {
        orderId,
        idempotencyKey: `${input.idempotencyKey}:action_confirm`,
      });
      return this.awaitingPaymentReply(scope, customer, order);
    } catch (error) {
      return refusal(error);
    }
  }

  private async serviceResend(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const chatId = privateChatIdOf(input.update);
    if (chatId === null) {
      /*
       * A tap from somewhere that is not a private chat.
       *
       * Refused with the same answer as an unknown service rather than sent to the
       * chat the service was FIRST delivered to: a subscription link is a bearer
       * capability, and delivering it anywhere other than where it was asked for is
       * how one lands in a group.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    /*
     * Round N (F4): «🔗 لینک اشتراک» turns the card the tap came from into the link, with a
     * way back to the card — no separate link message (`DeliveryService.showLinkOnCard`).
     * Without a card (a client that sent no message) the delivery card is sent, as before.
     */
    const card = cardMessageOf(input.update, input.botInstanceId);
    try {
      await this.deps.delivery.redeliver(
        scope,
        service,
        customer.id,
        chatId,
        input.botInstanceId,
        card === null ? {} : { card },
      );
      return { key: null, values: {}, buttons: [], orderId: null };
    } catch {
      // Round N (F4): with a card, the card stays as it is and the tap gets the notice.
      if (card !== null) return toastReply('bot.service.not_found');
      /*
       * Every refusal `deliver` can produce, as one customer-facing answer.
       *
       * `SERVICE_NOT_DELIVERABLE` carries a `reason` — NO_SUBSCRIPTION, SCOPE_INACTIVE,
       * SEND_IN_PROGRESS — and its own docblock says a surface maps them to a template
       * key. They are mapped to ONE here because a customer can act on none of them
       * and because the third is a race whose honest description is "try again in a
       * moment", which is what a service that answers nothing already tells them.
       * `bot.service.provisioning` is the closest true sentence for a service that has
       * no link yet and it is NOT used, because it would be wrong for the other two.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * A customer asking for their service's connection files (Package E).
   *
   * Sent only to the private chat the tap came from, for the reason `serviceResend`
   * gives: these are credentials. Ownership, state and the panel are decided again by
   * `SubscriptionFileService.send`, which sends the files itself — this handler sees a
   * count, never a file — and the one answer after them is a template key.
   */
  private async serviceFiles(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    const files = this.deps.subscriptionFiles;
    const chatId = privateChatIdOf(input.update);
    if (files === undefined || chatId === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const result = await files.send(scope, actor, {
      customerId: customer.id,
      serviceId,
      chatId,
      botInstanceId: input.botInstanceId,
    });
    switch (result.outcome) {
      case 'NOT_FOUND':
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      case 'RATE_LIMITED':
        return {
          key: 'bot.service.files_rate_limited',
          values: { seconds: result.retryAfterSeconds },
          buttons: [],
          orderId: null,
        };
      case 'UNAVAILABLE':
        return { key: 'bot.service.files_unavailable', values: {}, buttons: [], orderId: null };
      case 'SENT':
        return result.failed === 0
          ? { key: null, values: {}, buttons: [], orderId: null }
          : {
              key: 'bot.service.files_partial',
              values: { failed: result.failed },
              buttons: [],
              orderId: null,
            };
      case 'STOPPED':
        // Telegram declined a send part-way; a further message would meet the same answer.
        return { key: null, values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * A customer asking for one of the two management actions on their own service.
   *
   * The TYPE is a literal chosen by which callback prefix matched, never parsed out of
   * the payload. That is the property worth stating: nothing a client sends can turn a
   * tap on "pause" into a terminate, because the only thing that crosses the boundary
   * is a service id.
   *
   * What this does is PLAN an operation. The provisioner claims it on its next tick and
   * calls the panel; this surface never touches a provider, which is why the reply says
   * the request was recorded rather than that it is done. Saying "your service is
   * paused" here would be a claim about somebody else's machine, made before anything
   * was asked of it.
   *
   * Every refusal `requestFromCustomer` can produce is answered BY NAME, and the
   * mapping is a closed list rather than a catch-all. `SERVICE_NOT_FOUND` is the same
   * answer an id that is not theirs gets. The other three — a state the action is not
   * legal from, a panel that cannot perform it, a tenant that has stopped — are one
   * sentence, because that sentence is true for all of them, none is the customer's to
   * fix, and telling them apart would describe an operator's panel to a customer.
   *
   * Anything ELSE is re-thrown, and that is the part worth stating. A catch-all here
   * would answer a database failure with "this action is not available for your
   * service" — a false statement about the customer's panel, made to hide an outage,
   * and indistinguishable from the three real refusals in every log this installation
   * keeps. The runtime's own error path exists for the unknown case.
   */
  private async serviceAction(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: CustomerServiceOperation,
    idempotencyKey: string,
    card: CardMessageRef | null,
  ): Promise<PendingReply> {
    /*
     * Round N (F4): the card turns «working» on the tap — BEFORE the operation exists, so the
     * provisioner's answer (`OperationCardEditor`), which can only follow the operation, can
     * never be overwritten by this turn's loading edit. The switch is re-offered first, so a
     * tap from a keyboard that is already out of date (a second tap after the change landed)
     * redraws the card as it is, with a notice, and never flashes «working».
     */
    if (card !== null) {
      const service = await this.ownedService(scope, customer, serviceId);
      if (service === null) return toastReply('bot.service.not_found');
      /*
       * Codex review of #116: a REDELIVERY of this very tap is decided before the card is
       * touched. Its operation already exists: open, the card already reads «working» and is
       * answered when it ends; ended, the card was answered (or the sweep answers it) — and a
       * «working» edit now would overwrite that answer with a state nothing ever clears.
       */
      if (
        (await this.deps.services.findCustomerRequest(scope, serviceId, type, idempotencyKey)) !==
        null
      ) {
        return { key: null, values: {}, buttons: [], orderId: null };
      }
      if (!(await this.deps.services.customerActionsFor(scope, service)).includes(type)) {
        return this.cardWithToast(
          scope,
          actor,
          customer,
          serviceId,
          'bot.service.capability_unsupported',
        );
      }
      await this.showWorking(scope, actor, customer, serviceId, card);
    }
    let planned;
    try {
      planned = await this.deps.services.requestFromCustomer(
        scope,
        actor,
        customer.id,
        serviceId,
        type,
        {
          idempotencyKey,
          ...(card === null ? {} : { card }),
        },
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return card === null
          ? plainReply('bot.service.not_found')
          : this.cardWithToast(scope, actor, customer, serviceId, 'bot.service.not_found');
      }
      const refusals: readonly unknown[] = [
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      ];
      if (!refusals.includes(code)) throw error;
      // The card was turned «working» above: it is put back as it is, with the notice.
      return card === null
        ? plainReply('bot.service.capability_unsupported')
        : this.cardWithToast(
            scope,
            actor,
            customer,
            serviceId,
            'bot.service.capability_unsupported',
          );
    }
    /*
     * R3 item 10: nothing more is sent now. The provisioner performs the disable or enable
     * and then edits THIS card — «working» since the tap — to the state it left
     * (`OperationCardEditor`); round N: a failure is answered on the card too, as the service
     * still is with the failure line. A tap with no card to edit (a client that sent no
     * message) is answered as before.
     *
     * Codex review of #116: a concurrent redelivery can pass the check above before the
     * first turn planned, then get the first turn's operation back ENDED — answered on the
     * card before this turn's «working» edit landed. The card is drawn as it now is.
     */
    if (card !== null && operationHasEnded(planned)) {
      return this.cardAfterEnded(scope, actor, customer, serviceId, planned.state);
    }
    if (card !== null) return { key: null, values: {}, buttons: [], orderId: null };
    return { key: 'bot.service.action_requested', values: {}, buttons: [], orderId: null };
  }

  /**
   * The screen between a customer and a new subscription link (WP6-C).
   *
   * Plans nothing and writes nothing: it only asks. The offer is re-read
   * rather than trusted from the message that was tapped, and the cooldown shown is the
   * setting as it stands now. The sentence says a new link will be issued and has to be
   * put into the customer's apps; it says nothing about the old one (OQ-RP-07).
   */
  private async serviceRotateAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const offer = await this.deps.services.customerRotationFor(scope, service);
    if (!offer.offered) {
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    /*
     * R3 item 9: the question replaces the card in place, with a way back to it; the
     * confirmation then puts the card back (`serviceRotate`), so the change of link is
     * one message throughout rather than a new one per step.
     */
    return {
      key: 'bot.service.rotate_ask',
      values: { cooldownHours: offer.cooldownHours },
      buttons: [
        {
          ...inlineLabel('service.rotate_confirm'),
          data: `${SERVICE_ROTATE_CALLBACK_PREFIX}${service.id}`,
          row: 0,
        },
        { ...backToCardButton(service.id), row: 1 },
      ],
      orderId: null,
      edit: true,
    };
  }

  /**
   * A customer confirms a new subscription link for their own service (WP6-C).
   *
   * `requestRotation` decides everything, inside its transaction; this answers each of
   * its refusals BY NAME from a closed list and re-throws anything else, for the reason
   * `serviceAction` gives. The cooldown is the one refusal with a value in it: the
   * instant another rotation will be accepted, read from the refusal rather than
   * computed here, so the sentence is the server's answer.
   */
  private async serviceRotate(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
    /** Round N (F4): the card the confirmation was tapped on — answered on it. */
    card: CardMessageRef | null = null,
  ): Promise<PendingReply> {
    /*
     * Round N (F4): the card reads «working» from the confirmation until the panel has
     * answered — put there BEFORE the rotation is planned, for the reason `serviceAction`
     * gives. The new link then lands on this same card (`DeliveryService.sendRotated`), a
     * failure puts the card back with its notice (`OperationCardEditor`), and a refusal
     * below is edited over it.
     */
    if (card !== null) {
      const service = await this.ownedService(scope, customer, serviceId);
      // Codex review of #116: a redelivered confirmation leaves the card to its answer.
      if (
        service !== null &&
        (await this.deps.services.findCustomerRequest(
          scope,
          serviceId,
          'ROTATE_SUBSCRIPTION',
          idempotencyKey,
        )) !== null
      ) {
        return { key: null, values: {}, buttons: [], orderId: null };
      }
      if (
        service !== null &&
        (await this.deps.services.customerRotationFor(scope, service)).offered
      ) {
        await this.showWorking(scope, actor, customer, serviceId, card);
      }
    }
    let planned;
    try {
      planned = await this.deps.services.requestRotation(scope, actor, customer.id, serviceId, {
        idempotencyKey,
        ...(card === null ? {} : { card }),
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null, edit: true };
      }
      if (code === COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN) {
        const at = (error as { details?: Readonly<Record<string, unknown>> }).details?.[
          'availableAt'
        ];
        if (typeof at === 'string') {
          return {
            key: 'bot.service.rotate_cooldown',
            values: { availableAt: new Date(at) },
            buttons: [backToCardButton(serviceId)],
            orderId: null,
            edit: true,
          };
        }
        throw error;
      }
      if (code === COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED) {
        return { key: 'bot.blocked', values: {}, buttons: [], orderId: null, edit: true };
      }
      const refusals: readonly unknown[] = [
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        // WP-A6: a location move in flight refuses a rotation; the card is put back.
        COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
      ];
      if (!refusals.includes(code)) throw error;
      return {
        key: 'bot.service.capability_unsupported',
        values: {},
        buttons: [backToCardButton(serviceId)],
        orderId: null,
        edit: true,
      };
    }
    /*
     * R3 item 9: no «request registered» message, and never «service created». Round N
     * (F4): with a card, it already reads «working» and nothing more is sent now — the new
     * link lands on it (then the files, as an album), or it comes back with the failure
     * notice. Without one (a client that sent no message), the card is drawn as before.
     * A concurrent redelivery that got the operation back ENDED draws the card as it is
     * (Codex review of #116, as `serviceAction`).
     */
    if (card !== null && operationHasEnded(planned)) {
      return this.cardAfterEnded(scope, actor, customer, serviceId, planned.state);
    }
    if (card !== null) return { key: null, values: {}, buttons: [], orderId: null };
    return { ...(await this.serviceDetail(scope, actor, customer, serviceId)), edit: true };
  }

  /**
   * Round N (F4): the service card, as «working», edited into the message a change was asked
   * from. Best effort: a card Telegram cannot edit is answered by the provisioner's own
   * fallback (the final card, sent once), so nothing here needs one.
   */
  private async showWorking(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    card: CardMessageRef,
  ): Promise<void> {
    const edit = this.deps.messenger.edit;
    if (edit === undefined) return;
    const working = await this.serviceDetail(scope, actor, customer, serviceId, { working: true });
    if (working.key === null || working.key === 'bot.service.not_found') return;
    await edit.call(this.deps.messenger, scope, {
      ...card,
      templateKey: working.key,
      values: working.values,
      buttons: working.buttons,
    });
  }

  /**
   * Codex review of #116: the card as it now is, edited in place, after a request whose
   * operation had already ENDED — with the failure line when it ended without happening.
   */
  private async cardAfterEnded(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    state: OperationState,
  ): Promise<PendingReply> {
    return {
      ...(await this.serviceDetail(
        scope,
        actor,
        customer,
        serviceId,
        state === 'SUCCEEDED' ? {} : { notice: 'bot.service.notice_action_failed' },
      )),
      edit: true,
    };
  }

  /** Round N (F4): the card as it now is, edited in place, with a short notice on the tap. */
  private async cardWithToast(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    toast: TemplateKey,
  ): Promise<PendingReply> {
    const card = await this.serviceDetail(scope, actor, customer, serviceId);
    if (card.key === 'bot.service.not_found') return toastReply(toast);
    return { ...card, edit: true, toast: { key: toast, values: {} } };
  }

  /**
   * A plain message offered to the customer's own text window, if one is open: a top-up
   * amount, a search term or a note, by the window's PURPOSE. Null means no window read
   * it and the message goes on to the order windows.
   */
  private async capturedText(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const updateId = updateIdOf(input.update);
    const read = await this.deps.captures.readText(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:capture-text`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      text,
      ...(updateId === undefined ? {} : { updateId }),
    });
    if (read.outcome !== 'READ') return null;
    const { capture } = read;
    if (capture.purpose === 'TOPUP_AMOUNT') {
      const result = await this.deps.topup.recordAmountText(scope, {
        customerId: customer.id,
        captureId: capture.id,
        text,
      });
      return this.topupAmountReply(scope, result, capture.id);
    }
    if (capture.purpose === 'SERVICE_SEARCH') {
      const query = text.trim();
      if (query.length === 0 || Array.from(query).length > SERVICE_SEARCH_MAX_LENGTH) {
        return {
          key: 'bot.service.search_invalid',
          values: {},
          buttons: [backToListButton()],
          orderId: null,
        };
      }
      const found = await this.deps.services.searchForCustomer(scope, customer.id, query);
      if (found.length === 0) {
        return {
          key: 'bot.service.search_none',
          values: {},
          buttons: [backToListButton()],
          orderId: null,
        };
      }
      return {
        key: 'bot.service.search_results',
        values: { query: query.toLowerCase() },
        buttons: [
          ...found.map((service) => ({
            ...inlineLabel('services.item', { username: service.providerUsername }),
            // Owner spec §2.3: the card IN PLACE of the list (`sv:`); its back (`sl:`) the list again.
            data: `${SERVICE_CARD_CALLBACK_PREFIX}${service.id}`,
          })),
          backToListButton(),
        ],
        orderId: null,
      };
    }
    if (capture.purpose === 'SERVICE_REFUND_REASON') {
      return this.serviceRefundReason(scope, actor, customer, capture.subjectId, text, input);
    }
    if (capture.purpose === 'SERVICE_TRANSFER_RECIPIENT') {
      return this.serviceTransferRecipient(scope, actor, customer, capture.subjectId, text, input);
    }
    // WP-A7: a new ticket's first message, or a reply to one.
    if (capture.purpose === 'TICKET_NEW_MESSAGE' || capture.purpose === 'TICKET_REPLY') {
      return this.ticketSubmit(scope, actor, customer, capture, text, null, input);
    }
    if (capture.purpose === 'CUSTOM_SERVICE_VOLUME' || capture.purpose === 'CUSTOM_SERVICE_DAYS') {
      return this.customServiceFigure(scope, actor, customer, capture, text, input);
    }
    // SERVICE_NOTE: the window names the service; the write re-checks ownership.
    if (capture.subjectId === null) return null;
    try {
      const cleared = text.trim() === SERVICE_NOTE_CLEAR_TOKEN;
      const saved = await this.deps.services.setCustomerNote(
        scope,
        actor,
        customer.id,
        capture.subjectId,
        cleared ? null : text,
      );
      /*
       * Round N (F4): the answer IS the service card, with the note as it now stands and the
       * saved/cleared line under its status — one message showing the result, not a sentence
       * and a button back to it. A new message, because a typed answer carries no reference
       * to the card that asked for it (the smallest fallback for a typed step).
       */
      return this.serviceDetail(scope, actor, customer, capture.subjectId, {
        notice: saved.note === null ? 'bot.service.note_cleared' : 'bot.service.note_saved',
      });
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID) {
        return {
          key: 'bot.service.note_invalid',
          values: { max: SERVICE_NOTE_MAX_LENGTH },
          buttons: [backToServiceButton(capture.subjectId)],
          orderId: null,
        };
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      return refusal(error);
    }
  }

  /** The answer to a recorded (or refused) top-up amount: the route chooser, or why not. */
  private async topupAmountReply(
    scope: TenantContext,
    result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
    captureId: string,
  ): Promise<PendingReply> {
    const reply = await this.topupAmountScreen(scope, result, captureId);
    /*
     * R2: a TYPED amount continues the wizard that asked for it — anchored on the amount
     * screen of this capture. A tapped preset has its claim and ignores the anchor.
     */
    return {
      ...reply,
      wizard: {
        ...(reply.wizard ?? { kind: 'TOPUP', step: 'NOTICE' }),
        anchor: { steps: ['AMOUNT'], subjectId: captureId },
      },
    };
  }

  private async topupAmountScreen(
    scope: TenantContext,
    result: Awaited<ReturnType<WalletTopupFlowService['recordAmountText']>>,
    captureId: string,
  ): Promise<PendingReply> {
    const amountStep: WizardDirective = { kind: 'TOPUP', step: 'AMOUNT', subjectId: captureId };
    const close = {
      ...inlineLabel('list.close'),
      data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
    };
    if (result.outcome === 'GONE') {
      return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
    }
    if (result.outcome === 'INVALID') {
      return {
        key: 'bot.wallet.topup_amount_invalid',
        values: {},
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    if (result.outcome === 'BELOW_MINIMUM') {
      return {
        key: 'bot.wallet.topup_below_minimum',
        values: { minimum: result.minimum },
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    if (result.outcome === 'ABOVE_MAXIMUM') {
      return {
        key: 'bot.wallet.topup_above_maximum',
        values: { maximum: result.maximum },
        buttons: [close],
        orderId: null,
        wizard: amountStep,
      };
    }
    return this.topupChooser(scope, captureId, result.routes);
  }

  /**
   * «💳 روش پرداخت خود را انتخاب نمایید»: one button per route the amount may be paid
   * through, in the operator's order, with the route's gift when it has one. The buttons
   * carry the capture id and the provider — identifiers, never the amount.
   */
  private async topupChooser(
    scope: TenantContext,
    captureId: string,
    routes: readonly TopupRoute[],
  ): Promise<PendingReply> {
    const close = {
      ...inlineLabel('list.close'),
      data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${captureId}`,
    };
    const methods: WizardDirective = { kind: 'TOPUP', step: 'METHODS', subjectId: captureId };
    if (routes.length === 0) {
      return {
        key: 'bot.wallet.topup_none_available',
        values: {},
        buttons: [close],
        orderId: null,
        wizard: methods,
      };
    }
    const buttons: CustomerButton[] = [];
    for (const route of routes) {
      const name = await this.deps.screens.routeName(scope, route);
      buttons.push({
        ...(route.topupCashbackPercent > 0
          ? inlineLabel('payment.route_gift', { name, percent: route.topupCashbackPercent })
          : inlineLabel('payment.route', { name })),
        data: `${TOPUP_ROUTE_CALLBACK_PREFIX}${captureId}.${route.provider}`,
      });
    }
    buttons.push(close);
    return {
      key: 'bot.wallet.topup_method_prompt',
      values: {},
      buttons,
      orderId: null,
      wizard: methods,
    };
  }

  private async topupRoute(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    captureId: string,
    provider: PaymentGatewayProvider,
  ): Promise<PendingReply> {
    try {
      const chosen = await this.deps.topup.choose(scope, actor, {
        customerId: customer.id,
        captureId,
        provider,
      });
      if (chosen.outcome === 'GONE') {
        return { key: 'bot.wallet.topup_expired', values: {}, buttons: [], orderId: null };
      }
      if (chosen.outcome === 'NOT_OFFERED') {
        return this.topupChooser(scope, captureId, chosen.routes);
      }
      if (chosen.outcome === 'GATEWAY_REQUESTED') {
        return await this.gatewayAttemptReply(chosen.attempt, null, scope);
      }
      return this.transferInstruction(scope, chosen.instruction, null);
    } catch (error) {
      return refusal(error);
    }
  }

  private async topupClose(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    captureId: string,
  ): Promise<PendingReply> {
    await this.deps.topup.close(scope, actor, { customerId: customer.id, captureId });
    return {
      key: 'bot.wallet.topup_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
      wizard: { kind: 'TOPUP', step: 'CLOSED' },
    };
  }

  private async servicesSearchBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:search-open`,
      botInstanceId,
      customerId: customer.id,
      purpose: 'SERVICE_SEARCH',
      subjectId: null,
    });
    return {
      key: 'bot.service.search_prompt',
      values: {},
      buttons: [backToListButton()],
      orderId: null,
    };
  }

  private async serviceRefresh(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    /*
     * R3 item 7: read the panel now and redraw the SAME card, or leave it untouched with a
     * short notice on the button. No «request registered», no «result later».
     */
    const refresh = this.deps.serviceRefresh;
    if (refresh !== undefined) {
      const result = await refresh.refresh(scope, actor, { customerId: customer.id, serviceId });
      if (result.outcome === 'NOT_FOUND') return toastReply('bot.service.not_found');
      if (result.outcome === 'FAILED') return toastReply('bot.service.refresh_failed');
      return { ...(await this.serviceDetail(scope, actor, customer, serviceId)), edit: true };
    }
    try {
      await this.deps.services.requestSyncFromCustomer(scope, actor, customer.id, serviceId, {
        idempotencyKey: `${idempotencyKey}:refresh`,
      });
      return {
        key: 'bot.service.refresh_requested',
        values: {},
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      if (
        code === COMMERCE_ERROR_CODES.ORDER_STATE_INVALID ||
        code === COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE
      ) {
        return {
          key: 'bot.service.capability_unsupported',
          values: {},
          buttons: [backToServiceButton(serviceId)],
          orderId: null,
        };
      }
      return refusal(error);
    }
  }

  /**
   * «درخواست بازگشت وجه» (WP19, brief §2.2): what would happen, and one confirm button.
   * Writes nothing. The offer is re-read here rather than trusted from the drawn button, so
   * a stale or forged tap on a service that is no longer eligible is told so.
   */
  private async serviceRefundAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const offer = await this.refundOffer(scope, service);
    if (offer !== 'OFFERED') return refundOfferReply(offer, service.id);
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    return {
      key: 'bot.service.refund_request_ask',
      values: { service: service.providerUsername, product: title ?? '—' },
      buttons: [
        {
          ...inlineLabel('service.refund_request_confirm'),
          data: `${SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX}${service.id}`,
          row: 0,
        },
        { ...backToServiceButton(service.id), row: 1 },
      ],
      orderId: null,
    };
  }

  /**
   * «✅ تأیید درخواست بازگشت وجه»: opens the reason window. Still files nothing — the reason
   * files the request, so a confirmation never followed by a reason leaves no row.
   */
  private async serviceRefundConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
    updateId: bigint | undefined,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const offer = await this.refundOffer(scope, service);
    if (offer !== 'OFFERED') return refundOfferReply(offer, service.id);
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:refund-reason-open`,
      botInstanceId,
      customerId: customer.id,
      purpose: 'SERVICE_REFUND_REASON',
      subjectId: service.id,
      // The reason must be typed after this tap (Codex review of #83, round 8).
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: 'bot.service.refund_request_reason_prompt',
      values: {},
      buttons: [backToServiceButton(service.id)],
      orderId: null,
    };
  }

  /**
   * The customer's reason, which files the request exactly once (brief §2.2). An invalid
   * reason is told so and the window is opened again; everything else is decided by
   * `ServiceRefundRequestService.file`, inside its transaction.
   */
  private async serviceRefundReason(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string | null,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const refunds = this.deps.serviceRefunds;
    if (serviceId === null) return null;
    if (refunds === undefined) return refundOfferReply('UNAVAILABLE', serviceId);
    const updateId = updateIdOf(input.update);
    // A window this message reopens reads only messages sent after it (round 8).
    const reopen = (suffix: string) =>
      this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:${suffix}`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'SERVICE_REFUND_REASON',
        subjectId: serviceId,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
    if (normaliseRefundReason(text) === null) {
      await reopen('refund-reason-reopen');
      return {
        key: 'bot.service.refund_request_reason_invalid',
        values: { min: SERVICE_REFUND_REASON_MIN_LENGTH, max: SERVICE_REFUND_REASON_MAX_LENGTH },
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
      };
    }
    try {
      const result = await refunds.file(scope, actor, {
        customerId: customer.id,
        serviceId,
        botInstanceId: input.botInstanceId,
        reason: text,
        // The update that carried the reason: a redelivery files nothing new, whatever
        // became of the request in between.
        idempotencyKey: `${input.idempotencyKey}:refund-file`,
      });
      if (result.outcome === 'ALREADY_OPEN') return refundOfferReply('PENDING', serviceId);
      /*
       * A redelivered reason is answered with its own request, whatever became of it
       * (round 3) — so "registered, awaiting review" is said only while that is still true
       * (Codex review of #83, round 6). An approved request still deleting is pending; a
       * decided one was told through the lane, and the customer is shown the service as it
       * now stands (or `not_found`, once a completed request has hidden it).
       */
      if (result.request.state === 'EXECUTING') return refundOfferReply('PENDING', serviceId);
      if (result.request.state !== 'OPEN') {
        return this.serviceDetail(scope, actor, customer, serviceId);
      }
      return {
        key: 'bot.service.refund_request_registered',
        values: {},
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
        // A registration the customer never saw is repeated through the lane, once.
        fallback: { kind: 'SERVICE_REFUND_REQUEST_REGISTERED', subjectId: result.request.id },
      };
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE) {
        return refundOfferReply('UNAVAILABLE', serviceId);
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      /*
       * A failure nobody answers — the database, a timeout, or a typed error with no reply
       * sentence such as the outbox's own — filed nothing, but reading the reason already
       * closed its window, and the webhook answers 2xx, so Telegram will not redeliver
       * (Codex review of #83, rounds 8 and 9). The window is reopened, so the customer's next
       * message files the request. A refusal that HAS a sentence is an answer, and keeps
       * the window shut: a window reopened under "not available" would swallow whatever the
       * customer typed next. Best effort: if the reopen fails too, the original failure is
       * the one reported.
       */
      if (!hasRefusalReply(error)) {
        await reopen('refund-reason-retry').catch(() => undefined);
      }
      return refusal(error);
    }
  }

  /**
   * «🔄 انتقال سرویس» (Package F): opens the window that reads the recipient's numeric id and
   * asks for it. Moves nothing; the service's eligibility is read again here rather than
   * trusted from the drawn button.
   */
  private async serviceTransferAsk(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply> {
    const transfers = this.deps.serviceTransfers;
    if (transfers === undefined) return transferUnavailableReply(serviceId);
    const updateId = updateIdOf(input.update);
    const begun = await transfers.begin(scope, actor, {
      customerId: customer.id,
      serviceId,
      botInstanceId: input.botInstanceId,
      idempotencyKey: `${input.idempotencyKey}:transfer-open`,
      // The id must be typed after this tap, as a refund reason must (WP19 round 8).
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    if (begun.outcome === 'NOT_FOUND') {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    if (begun.outcome === 'NOT_TRANSFERABLE') return transferUnavailableReply(serviceId);
    return {
      key: 'bot.service.transfer_prompt',
      values: {},
      buttons: [backToServiceButton(serviceId)],
      orderId: null,
    };
  }

  /**
   * The recipient's id, typed into the transfer window: the confirmation screen, or the
   * refusal. A refusal about the recipient opens the window again, because its sentence asks
   * for the id once more; a service that cannot be transferred, or is not theirs, does not.
   */
  private async serviceTransferRecipient(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string | null,
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    if (serviceId === null) return null;
    const transfers = this.deps.serviceTransfers;
    if (transfers === undefined) return transferUnavailableReply(serviceId);
    const preview = await transfers.preview(scope, actor, {
      customerId: customer.id,
      serviceId,
      text,
    });
    if (preview.outcome === 'NOT_FOUND') {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    if (preview.outcome === 'NOT_TRANSFERABLE') return transferUnavailableReply(serviceId);
    if (preview.outcome === 'REFUSED') {
      const updateId = updateIdOf(input.update);
      await this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:transfer-reopen`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'SERVICE_TRANSFER_RECIPIENT',
        subjectId: serviceId,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
      return {
        key: TRANSFER_RECIPIENT_REPLIES[preview.refusal],
        values: {},
        buttons: [backToServiceButton(serviceId)],
        orderId: null,
      };
    }
    const confirm = transferConfirmData(
      preview.serviceId,
      preview.recipientTelegramUserId,
      preview.ownershipVersion,
    );
    // Past the version a callback can carry, no confirmation is drawn rather than one
    // Telegram would refuse (`TRANSFER_CONFIRM_VERSION_MAX`).
    if (confirm === null) return transferUnavailableReply(serviceId);
    return {
      key: 'bot.service.transfer_confirm',
      values: preview.values,
      buttons: [
        {
          ...inlineLabel('service.transfer_confirm'),
          data: confirm,
          row: 0,
        },
        { ...backToServiceButton(serviceId), row: 1 },
      ],
      orderId: null,
    };
  }

  /**
   * «✅ تأیید انتقال سرویس»: the transfer. Keyed by THIS update, so a redelivery answers with
   * the transfer it made; a second tap is a new update, and is answered with the transfer
   * already made rather than told it failed.
   */
  private async serviceTransferConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    confirmed: { readonly recipientTelegramUserId: string; readonly ownershipVersion: number },
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    const transfers = this.deps.serviceTransfers;
    if (transfers === undefined) return transferUnavailableReply(serviceId);
    try {
      await transfers.transfer(scope, actor, {
        customerId: customer.id,
        serviceId,
        recipientTelegramUserId: confirmed.recipientTelegramUserId,
        ownershipVersion: confirmed.ownershipVersion,
        botInstanceId: input.botInstanceId,
        // Suffixed: the bare update key is already spent by `resolveFromUpdate` this turn.
        idempotencyKey: `${input.idempotencyKey}:transfer`,
      });
      return {
        key: 'bot.service.transfer_done',
        values: {},
        // The service is not theirs any more: back to the list, not to it.
        buttons: [
          {
            ...inlineLabel('service.back_to_list'),
            data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
          },
        ],
        orderId: null,
      };
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.SERVICE_NOT_TRANSFERABLE) {
        return transferUnavailableReply(serviceId);
      }
      if (
        isNexaError(error) &&
        error.code === COMMERCE_ERROR_CODES.SERVICE_TRANSFER_RECIPIENT_REFUSED
      ) {
        const refusal = serviceTransferRecipientRefusalSchema.safeParse(error.details['refusal']);
        return {
          key: TRANSFER_RECIPIENT_REPLIES[refusal.success ? refusal.data : 'RECIPIENT_UNKNOWN'],
          values: {},
          buttons: [backToServiceButton(serviceId)],
          orderId: null,
        };
      }
      return refusal(error);
    }
  }

  private async refundOffer(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<'OFFERED' | 'PENDING' | 'UNAVAILABLE'> {
    const refunds = this.deps.serviceRefunds;
    return refunds === undefined ? 'UNAVAILABLE' : refunds.customerOffer(scope, service);
  }

  private async serviceNoteBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:note-open`,
      botInstanceId,
      customerId: customer.id,
      purpose: 'SERVICE_NOTE',
      subjectId: service.id,
    });
    return {
      key: 'bot.service.note_prompt',
      values: { max: SERVICE_NOTE_MAX_LENGTH },
      buttons: [backToServiceButton(service.id)],
      orderId: null,
    };
  }

  /**
   * «💊 تمدید سرویس»: the renewal (the product re-priced at its current terms) and the
   * add-time packages, on one screen. Each option is re-decided by the quote it opens.
   */
  private async renewMenu(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const offered = await this.deps.commercial.availableFor(scope, actor, service);
    const buttons: CustomerButton[] = [];
    if (offered.includes('RENEW')) {
      const renewal = await this.offerOrNull(scope, actor, customer, service.id, 'RENEW');
      const product = renewal?.product ?? null;
      if (product !== null && product.price !== null) {
        buttons.push({
          ...inlineLabel('service.renew_option', { title: product.title, price: product.price }),
          data: `${SERVICE_RENEW_QUOTE_CALLBACK_PREFIX}${service.id}`,
        });
      }
    }
    if (offered.includes('ADD_TIME')) {
      const packages = await this.offerOrNull(scope, actor, customer, service.id, 'ADD_TIME');
      for (const addon of packages?.addons ?? []) {
        if (addon.price === null) continue;
        buttons.push({
          ...inlineLabel('service.addon_option', { title: addon.title, price: addon.price }),
          data: `${SERVICE_BUY_TIME_CALLBACK_PREFIX}${encodeIdPair(service.id, addon.id)}`,
        });
      }
    }
    if (buttons.length === 0) {
      return {
        key: 'bot.service.renew_unavailable',
        values: {},
        buttons: [backToServiceButton(service.id)],
        orderId: null,
      };
    }
    buttons.push(backToServiceButton(service.id));
    return { key: 'bot.service.renew_choose', values: {}, buttons, orderId: null };
  }

  /** `commercial.offer`, with "nothing offered" as null rather than a throw: the menu decides. */
  private async offerOrNull(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TIME',
  ): Promise<Awaited<ReturnType<CommercialActionService['offer']>> | null> {
    try {
      return await this.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
    } catch (error) {
      if (isNexaError(error) && error.code in REFUSAL_REPLIES) return null;
      throw error;
    }
  }

  private async referralGift(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    if (this.deps.referralGifts === undefined) {
      return { key: 'bot.referral.gift_disabled', values: {}, buttons: [], orderId: null };
    }
    try {
      const claimed = await this.deps.referralGifts.claim(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:signup-gift`,
      });
      if (claimed.claimedCount === 0 || claimed.credited.amountMinor === 0n) {
        return {
          key: 'bot.referral.gift_nothing',
          values: {},
          buttons: [mainMenuButton()],
          orderId: null,
        };
      }
      return {
        key: 'bot.referral.gift_claimed',
        values: { amount: claimed.credited },
        buttons: [mainMenuButton()],
        orderId: null,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  // --- WP-A7: the customer's support tickets ----------------------------------------------

  /**
   * The ticket desk's seven intents, or null for every other intent (and for all of them when
   * the desk is not wired). Nothing here decides a fact: every write is `TicketService`'s,
   * which re-reads the ticket and its owner inside its transaction; the screens only draw.
   */
  private async ticketTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const desk = this.deps.tickets;
    if (desk === undefined) return null;
    const id = command.targetId;
    switch (command.intent) {
      case 'TICKETS':
        return this.ticketList(scope, desk, customer, input.botInstanceId);
      case 'TICKET_NEW':
        return this.ticketNew(scope, desk, customer, input.botInstanceId);
      case 'TICKET_CATEGORY':
        return id === null ? null : this.ticketCategory(scope, actor, desk, customer, id, input);
      case 'TICKET_VIEW':
        return id === null ? null : this.ticketView(scope, desk, customer, input.botInstanceId, id);
      case 'TICKET_REPLY':
        return id === null ? null : this.ticketReplyOpen(scope, actor, desk, customer, id, input);
      case 'TICKET_CLOSE_ASK':
        return id === null
          ? null
          : this.ticketCloseAsk(scope, desk, customer, input.botInstanceId, id);
      case 'TICKET_CLOSE':
        return id === null
          ? null
          : this.ticketClose(scope, actor, desk, customer, input.botInstanceId, id);
      default:
        return null;
    }
  }

  /** The ticket desk's list: the customer's tickets, active first, and a new one. */
  private async ticketList(
    scope: TenantContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const tickets = await desk.service.customerTickets(scope, customer.id, botInstanceId);
    const buttons: CustomerButton[] = [];
    for (const ticket of tickets) {
      buttons.push({
        ...inlineLabel('tickets.item', {
          status: await desk.screens.statusLabel(scope, ticket.status),
          number: ticket.number,
          category: ticket.categoryTitle,
        }),
        data: `${TICKET_VIEW_CALLBACK_PREFIX}${ticket.id}`,
      });
    }
    buttons.push(newTicketButton(), mainMenuButton());
    return {
      key: tickets.length === 0 ? 'bot.ticket.list_empty' : 'bot.ticket.list',
      values: {},
      buttons,
      orderId: null,
    };
  }

  /** A new ticket: the active categories. A courtesy check of the open-ticket rail first. */
  private async ticketNew(
    scope: TenantContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const open = (await desk.service.customerTickets(scope, customer.id, botInstanceId)).filter(
      (ticket) => ticket.status !== 'CLOSED',
    ).length;
    if (open >= TICKET_OPEN_MAX_PER_CUSTOMER) {
      return {
        key: 'bot.ticket.open_limit',
        values: { max: TICKET_OPEN_MAX_PER_CUSTOMER },
        buttons: [ticketsButton()],
        orderId: null,
      };
    }
    const categories = await desk.categories.activeForCustomer(scope);
    if (categories.length === 0) {
      return {
        key: 'bot.ticket.no_categories',
        values: {},
        buttons: [ticketsButton()],
        orderId: null,
      };
    }
    return {
      key: 'bot.ticket.choose_category',
      values: {},
      buttons: [
        ...categories.map((category) => ({
          ...inlineLabel('tickets.category', { title: category.title }),
          data: `${TICKET_CATEGORY_CALLBACK_PREFIX}${category.id}`,
        })),
        ticketsButton(),
      ],
      orderId: null,
    };
  }

  /** A category was chosen: open the window that reads the new ticket's first message. */
  private async ticketCategory(
    scope: TenantContext,
    actor: ActorContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    categoryId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply> {
    const category = (await desk.categories.activeForCustomer(scope)).find(
      (candidate) => candidate.id === categoryId,
    );
    // A stale button for a category since hidden: the chooser again, as it now stands.
    if (category === undefined) return this.ticketNew(scope, desk, customer, input.botInstanceId);
    const updateId = updateIdOf(input.update);
    try {
      await this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:ticket-window`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'TICKET_NEW_MESSAGE',
        subjectId: category.id,
        // A window reads only messages sent after the tap that opened it.
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
    } catch (error) {
      return refusal(error);
    }
    return {
      key: 'bot.ticket.message_prompt',
      values: { category: category.title, max: TICKET_MESSAGE_MAX_LENGTH },
      buttons: [ticketsButton()],
      orderId: null,
    };
  }

  /** One of the customer's own tickets: its heading and its latest messages. */
  private async ticketView(
    scope: TenantContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    ticketId: string,
  ): Promise<PendingReply> {
    const found = await desk.service.customerTicket(
      scope,
      customer.id,
      botInstanceId,
      ticketId,
      TICKET_VIEW_MESSAGE_COUNT,
    );
    if (found === null) return ticketNotFound();
    const { ticket } = found;
    const rendered = await desk.screens.conversation(
      scope,
      found.messages,
      found.messageCount,
      found.filed,
    );
    const active = ticket.status !== 'CLOSED';
    return {
      key: 'bot.ticket.view',
      values: {
        number: ticket.number,
        category: ticket.categoryTitle,
        status: await desk.screens.statusLabel(scope, ticket.status),
        conversation: rendered.conversation,
        ...(rendered.olderLine === null ? {} : { olderLine: rendered.olderLine }),
      },
      buttons: [
        ...(active
          ? [
              {
                ...inlineLabel('tickets.reply'),
                data: `${TICKET_REPLY_CALLBACK_PREFIX}${ticket.id}`,
              },
              {
                ...inlineLabel('tickets.close'),
                data: `${TICKET_CLOSE_ASK_CALLBACK_PREFIX}${ticket.id}`,
              },
            ]
          : [newTicketButton()]),
        ticketsButton(),
      ],
      orderId: null,
    };
  }

  /** The reply button: open the window that reads the customer's reply to this ticket. */
  private async ticketReplyOpen(
    scope: TenantContext,
    actor: ActorContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    ticketId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply> {
    const found = await desk.service.customerTicket(
      scope,
      customer.id,
      input.botInstanceId,
      ticketId,
      1,
    );
    if (found === null) return ticketNotFound();
    if (found.ticket.status === 'CLOSED') return ticketAlreadyClosed();
    const updateId = updateIdOf(input.update);
    try {
      await this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:ticket-window`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'TICKET_REPLY',
        subjectId: found.ticket.id,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
    } catch (error) {
      return refusal(error);
    }
    return {
      key: 'bot.ticket.reply_prompt',
      values: { number: found.ticket.number, max: TICKET_MESSAGE_MAX_LENGTH },
      buttons: [ticketViewButton(found.ticket.id)],
      orderId: null,
    };
  }

  /** The close button: the question. Writes nothing; its one button is the close. */
  private async ticketCloseAsk(
    scope: TenantContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    ticketId: string,
  ): Promise<PendingReply> {
    const found = await desk.service.customerTicket(scope, customer.id, botInstanceId, ticketId, 1);
    if (found === null) return ticketNotFound();
    if (found.ticket.status === 'CLOSED') return ticketAlreadyClosed();
    return {
      key: 'bot.ticket.close_ask',
      values: { number: found.ticket.number },
      buttons: [
        {
          ...inlineLabel('tickets.close_confirm'),
          data: `${TICKET_CLOSE_CALLBACK_PREFIX}${found.ticket.id}`,
        },
        ticketViewButton(found.ticket.id),
      ],
      orderId: null,
    };
  }

  /** The close itself. Closing a ticket already closed answers the same sentence. */
  private async ticketClose(
    scope: TenantContext,
    actor: ActorContext,
    desk: TicketDeskPort,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    ticketId: string,
  ): Promise<PendingReply> {
    try {
      const closed = await desk.service.closeByCustomer(scope, actor, {
        customerId: customer.id,
        botInstanceId,
        ticketId,
      });
      return {
        key: 'bot.ticket.closed',
        values: { number: closed.ticket.number },
        buttons: [ticketsButton()],
        orderId: null,
      };
    } catch (error) {
      if (isNexaError(error) && error.code === TICKET_ERROR_CODES.TICKET_NOT_FOUND) {
        return ticketNotFound();
      }
      return refusal(error);
    }
  }

  /**
   * A photo or document, offered to the customer's ticket window — only when a ticket window
   * is the prompt they saw last, and read with `onlyPurposes` so a file can never close some
   * other window as though it were its text. Null leaves the file to the receipt path.
   *
   * "Saw last" is decided inside the read's transaction, under the ticket window's lock and
   * then the receipt window's: a receipt window at least as new wins and the ticket window
   * stays open. The receipt path that runs after a null is reached only when the receipt
   * window was the newer one at that instant; a ticket window opened afterwards is newer
   * than this file, and — as with `openedUpdateId` — not what it answered.
   */
  private async ticketFile(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    file: InboundReceiptFile,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const desk = this.deps.tickets;
    if (desk === undefined) return null;
    const updateId = updateIdOf(input.update);
    const read = await this.deps.captures.readText(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:capture-file`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      text: file.caption ?? '',
      onlyPurposes: ['TICKET_NEW_MESSAGE', 'TICKET_REPLY'],
      yieldTo: (tx) => desk.receiptWindowOpenedAt(scope, input.botInstanceId, customer.id, tx),
      ...(updateId === undefined ? {} : { updateId }),
    });
    if (read.outcome !== 'READ') return null;
    return this.ticketSubmit(
      scope,
      actor,
      customer,
      read.capture,
      file.caption,
      {
        kind: file.kind,
        fileId: file.fileId,
        fileUniqueId: file.fileUniqueId,
        mimeType: file.mimeType,
        fileName: file.fileName,
        fileSize: file.fileSize,
      },
      input,
    );
  }

  /**
   * What a ticket window read — text, or a file with its caption — filed as a new ticket or
   * a reply. The window closed when it was read; a refusal that asks the customer to try
   * again reopens it, reading only messages sent after this one, and a refusal that is an
   * answer ("closed", "too many open") leaves it shut.
   */
  private async ticketSubmit(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: CustomerCaptureRecord,
    text: string | null,
    file: InboundTicketFile | null,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const desk = this.deps.tickets;
    if (desk === undefined || capture.subjectId === null) return null;
    const subjectId = capture.subjectId;
    const updateId = updateIdOf(input.update);
    const reopen = (suffix: string) =>
      this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:${suffix}`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: capture.purpose,
        subjectId,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
    try {
      if (capture.purpose === 'TICKET_NEW_MESSAGE') {
        const opened = await desk.service.openByCustomer(scope, actor, {
          customerId: customer.id,
          botInstanceId: input.botInstanceId,
          categoryId: subjectId,
          text,
          file,
          // The update that carried the message: a redelivery opens nothing new.
          idempotencyKey: `${input.idempotencyKey}:ticket`,
        });
        return {
          key: 'bot.ticket.created',
          values: { number: opened.ticket.number },
          buttons: [ticketViewButton(opened.ticket.id), ticketsButton()],
          orderId: null,
        };
      }
      const posted = await desk.service.replyByCustomer(scope, actor, {
        customerId: customer.id,
        botInstanceId: input.botInstanceId,
        ticketId: subjectId,
        text,
        file,
        idempotencyKey: `${input.idempotencyKey}:ticket`,
      });
      return {
        key: 'bot.ticket.reply_sent',
        values: { number: posted.ticket.number },
        buttons: [ticketViewButton(posted.ticket.id), ticketsButton()],
        orderId: null,
      };
    } catch (error) {
      const code = isNexaError(error) ? error.code : null;
      const back =
        capture.purpose === 'TICKET_REPLY' ? ticketViewButton(subjectId) : ticketsButton();
      if (code === TICKET_ERROR_CODES.TICKET_MESSAGE_INVALID) {
        await reopen('ticket-reopen');
        return {
          key: 'bot.ticket.message_invalid',
          values: { max: TICKET_MESSAGE_MAX_LENGTH },
          buttons: [back],
          orderId: null,
        };
      }
      if (code === TICKET_ERROR_CODES.TICKET_ATTACHMENT_REFUSED) {
        await reopen('ticket-reopen');
        const tooLarge = isNexaError(error) && error.details['refusal'] === 'TOO_LARGE';
        return tooLarge
          ? {
              key: 'bot.ticket.attachment_too_large',
              values: { maxBytes: BigInt(TICKET_ATTACHMENT_MAX_BYTES) },
              buttons: [back],
              orderId: null,
            }
          : {
              key: 'bot.ticket.attachment_type_refused',
              values: {},
              buttons: [back],
              orderId: null,
            };
      }
      if (code === TICKET_ERROR_CODES.TICKET_OPEN_LIMIT) {
        return {
          key: 'bot.ticket.open_limit',
          values: { max: TICKET_OPEN_MAX_PER_CUSTOMER },
          buttons: [ticketsButton()],
          orderId: null,
        };
      }
      if (code === TICKET_ERROR_CODES.TICKET_CATEGORY_NOT_FOUND) {
        return this.ticketNew(scope, desk, customer, input.botInstanceId);
      }
      if (code === TICKET_ERROR_CODES.TICKET_CLOSED) return ticketAlreadyClosed();
      if (code === TICKET_ERROR_CODES.TICKET_NOT_FOUND) return ticketNotFound();
      if (code === TICKET_ERROR_CODES.TICKET_MESSAGE_LIMIT) {
        return {
          key: 'bot.ticket.message_limit',
          values: {},
          buttons: [newTicketButton()],
          orderId: null,
        };
      }
      /*
       * A failure nobody answers — the database, a timeout — wrote nothing, but reading the
       * message already closed its window and the webhook answers 2xx, so Telegram will not
       * redeliver. The window is reopened so the customer's next message is still read; the
       * refund reason's rule (WP19). Best effort: the original failure is the one reported.
       */
      if (!hasRefusalReply(error)) await reopen('ticket-retry').catch(() => undefined);
      return refusal(error);
    }
  }

  /**
   * The FAQ/support screen (§J): the tenant's active entries in parts split at item
   * boundaries, the earlier parts as leads and the last carrying the keyboard; with no
   * active entry, the contact action alone. The contact button opens the FIRST configured
   * support account and is not drawn when none is configured.
   */
  /**
   * Round N close (§D): the customer's own promotional opt-out or opt-in, under the update's
   * key. The reply names what changed and carries the way back; a repeated tap is answered
   * with the same reply, because the preference already holds.
   */
  private async marketingPreference(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    optedOut: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    /*
     * Spec §9: while the installation does not let customers stop promotions, /stop and an
     * old opt-out / opt-in button are answered and change nothing. The service decides
     * again inside its transaction; its refusal (the switch moved between the two reads) is
     * answered the same way.
     */
    const unavailable: PendingReply = {
      key: 'bot.marketing.unavailable',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
    if (!(await this.deps.customers.marketingOptOutAllowed(scope))) return unavailable;
    // The update's key is already spent by `resolveFromUpdate` under this surface: the
    // preference is a second command of the same turn, so it takes the turn's sub-key.
    try {
      await this.deps.customers.setMarketingOptOut(scope, actor, {
        idempotencyKey: `${idempotencyKey}:marketing`,
        customerId: customer.id,
        optedOut,
      });
    } catch (error) {
      if (isMarketingOptOutDisabled(error)) return unavailable;
      throw error;
    }
    return {
      key: optedOut ? 'bot.marketing.opted_out' : 'bot.marketing.opted_in',
      values: {},
      buttons: [marketingPreferenceButton(!optedOut), mainMenuButton()],
      orderId: null,
    };
  }

  private async supportScreen(
    scope: TenantContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const screen = await this.deps.support.partsFor(scope);
    const buttons: CustomerButton[] = [
      // WP-A7: the ticket desk, from the support screen and from /paysupport alike.
      ...(this.deps.tickets === undefined ? [] : [ticketDeskButton()]),
      ...(screen.supportUrl === null
        ? []
        : [
            {
              ...inlineLabel('support.contact'),
              url: screen.supportUrl,
            },
          ]),
      // Round N close (§D): the promotional opt-out lives on the support screen, as the
      // reverse of whatever the customer holds now — the same path /stop takes. Spec §9:
      // not drawn while the installation does not let customers change it.
      ...((await this.deps.customers.marketingOptOutAllowed(scope))
        ? [marketingPreferenceButton(customer.marketingOptOutAt !== null)]
        : []),
      mainMenuButton(),
    ];
    if (screen.parts.length === 0) {
      return {
        key: screen.supportUrl === null ? 'bot.support.unconfigured' : 'bot.support.contact',
        values: {},
        buttons,
        orderId: null,
      };
    }
    const last = screen.parts[screen.parts.length - 1] as string;
    return {
      key: 'bot.faq.page',
      values: { content: last },
      buttons,
      orderId: null,
      ...(screen.parts.length === 1
        ? {}
        : {
            lead: screen.parts.slice(0, -1).map((content) => ({
              kind: 'TEXT' as const,
              key: 'bot.faq.page' as const,
              values: { content },
            })),
          }),
    };
  }

  /**
   * The connection guide's first screen: the platforms (WP-A10).
   *
   * The five with a guide of their own always, and «🧩 سایر» only while the tenant files
   * an app there that this customer may see — decided by the catalogue, per tap.
   */
  private async tutorialChoice(
    scope: TenantContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const platforms =
      this.deps.clientApps === undefined
        ? CONNECTION_GUIDE_PLATFORMS
        : await this.deps.clientApps.platformsFor(scope, customer.id);
    return tutorialChoice(platforms);
  }

  /**
   * One platform: its recommended apps as buttons, or — when the tenant configured none
   * this customer may see — the platform's own `bot.tutorial.<platform>` guide, which is
   * exactly the screen a `to:<platform>` button opened before WP-A10.
   */
  private async tutorialPlatform(
    scope: TenantContext,
    customer: CustomerRecord,
    platform: ClientAppPlatform,
  ): Promise<PendingReply> {
    const apps =
      this.deps.clientApps === undefined
        ? []
        : await this.deps.clientApps.appsFor(scope, customer.id, platform);
    return clientAppPlatformScreen(platform, apps);
  }

  /** One app: its guide, its download links, and the customer's own service actions. */
  private async clientApp(
    scope: TenantContext,
    customer: CustomerRecord,
    appId: string,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const detail =
      this.deps.clientApps === undefined
        ? null
        : await this.deps.clientApps.appFor(scope, customer.id, appId);
    const screen = clientAppScreen(detail);
    /*
     * Spec §7: the app's tutorial video, when an administrator set one through THIS bot — a
     * `file_id` is valid only for the bot that received it. Sent by reference, nothing
     * downloaded, as a decorative lead: a video Telegram refuses is dropped and the screen
     * still goes out.
     */
    const video =
      detail === null || this.deps.clientAppVideos === undefined
        ? null
        : await this.deps.clientAppVideos.videoFor(scope, appId, botInstanceId);
    if (video === null) return screen;
    return {
      ...screen,
      lead: [...(screen.lead ?? []), { kind: 'VIDEO_FILE', fileId: video.fileId }],
    };
  }

  /** One of the customer's own services, or null. Never anybody else's, never a throw. */
  private async ownedService(
    scope: TenantContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    try {
      return await this.deps.services.getForCustomer(scope, customer.id, serviceId);
    } catch {
      // `SERVICE_NOT_FOUND` for an id that is not theirs and one that does not exist
      // alike. Caught rather than propagated because a surface answers a customer.
      return null;
    }
  }

  /**
   * The catalogue: a heading and one button per product.
   *
   * The product list cannot be interpolated into `bot.catalog.heading` — it declares no
   * placeholders, and a template is not a list renderer. So the products are BUTTONS,
   * whose labels are the tenant's own data and whose `callback_data` is the id. That is
   * also why the empty case is a different KEY rather than the same message with nothing
   * under it: `bot.catalog.empty` says why there is nothing, and an empty list reads as
   * a failure.
   */
  /**
   * One page of the CATEGORY list — the first of the two steps (OQ-4B-01).
   *
   * What reaches this list is decided entirely in SQL, ahead of LIMIT/OFFSET: tenant,
   * category status and visibility, and non-emptiness by EXISTS over products that are
   * themselves listed, priced and on an eligible panel. Nothing here filters what came
   * back — §6.4 forbids fetching a page and then trimming it, which is the shape that
   * emptied this catalogue three times at three different thresholds.
   *
   * Next and Previous are drawn only when TRUE: Previous when this is not the first
   * page, Next when the query read a row beyond this one. `hasMore` is a fact about the
   * data, not an inference from a count.
   *
   * A page past the end — a stale button after categories were withdrawn — recovers to
   * the first page rather than showing an empty list with a Previous button. That is a
   * navigation recovery and selects nothing: the customer taps again from what exists.
   */
  private async catalogue(
    scope: TenantContext,
    actor: ActorContext,
    page: number,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const { items, hasMore } = await this.deps.products.browseCategories(
      scope,
      actor,
      CATALOG_BROWSE_PAGE_SIZE,
      page * CATALOG_BROWSE_PAGE_SIZE,
      // Whose catalogue: a reseller's tier decides what they see (WP9-B R6).
      customer.id,
    );
    /*
     * No trial here (F5). A trial is not something a customer buys or browses to: it is
     * its own main-menu action («🧪 دریافت سرویس تست», `/trial`), drawn while a panel
     * offers one. The purchase flow — categories, products, plans — sells, and only sells.
     *
     * The custom service (Package D), on the first page only: drawn when at least one
     * location could price this customer now. A courtesy — every step after the tap
     * decides again. Unlike the trial it IS a way to buy, so it stays.
     */
    const leading: CustomerButton[] = [];
    if (page === 0 && (await this.customServiceOffered(scope, actor, customer))) {
      leading.push({
        ...inlineLabel('catalog.custom_service'),
        data: CUSTOM_SERVICE_CALLBACK_DATA,
      });
    }
    if (items.length === 0) {
      if (page > 0) return this.catalogue(scope, actor, 0, customer);
      return { key: 'bot.catalog.empty', values: {}, buttons: leading, orderId: null };
    }
    const buttons: CustomerButton[] = [...leading];
    buttons.push(
      ...items.map((category) => ({
        // Operator text, exactly as a product title is. The emoji is optional and its
        // absence renders as an ordinary category — §6.1.
        ...inlineDataLabel('catalog.category', {
          kind: 'TEXT',
          text: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
        }),
        data: `${CATEGORY_CALLBACK_PREFIX}${category.id}.0`,
      })),
    );
    if (page > 0) {
      buttons.push({
        ...inlineLabel('catalog.previous_page'),
        data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page - 1}`,
      });
    }
    if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
      buttons.push({
        ...inlineLabel('catalog.next_page'),
        data: `${CATALOG_PAGE_CALLBACK_PREFIX}${page + 1}`,
      });
    }
    return {
      key: 'bot.catalog.categories_heading',
      values: {},
      buttons,
      orderId: null,
      wizard: { kind: 'ORDER', step: 'CATEGORIES' },
    };
  }

  /** Whether to draw the custom-service button (Package D): some location prices this customer. */
  private async customServiceOffered(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<boolean> {
    if (this.deps.customService === undefined) return false;
    return (await this.deps.customService.offeredLocations(scope, actor, customer.id)).length > 0;
  }

  /** The custom-service button: the locations, each by the label the operator wrote. */
  private async customServiceMenu(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const locations =
      this.deps.customService === undefined
        ? []
        : await this.deps.customService.offeredLocations(scope, actor, customer.id);
    if (locations.length === 0) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.custom_service.locations',
      values: {},
      buttons: locations.map((location) => ({
        ...inlineDataLabel('custom_service.location', { kind: 'TEXT', text: location.label }),
        data: `${CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX}${location.panelId}`,
      })),
      orderId: null,
    };
  }

  /** A location was tapped: re-decided, then the volume question and its window. */
  private async customServiceLocation(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    panelId: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    if (this.deps.customService === undefined) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    const begun = await this.deps.customService.begin(scope, actor, {
      idempotencyKey: `${input.idempotencyKey}:custom-service-volume`,
      botInstanceId: input.botInstanceId,
      customerId: customer.id,
      panelId,
    });
    if (begun.outcome === 'UNAVAILABLE') {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.custom_service.ask_volume',
      values: { location: begun.location.label },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * A figure a custom-service window read (Package D): the volume, then the days, then
   * the draft and the ordinary username step and pre-invoice.
   */
  private async customServiceFigure(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: CustomerCaptureRecord,
    text: string,
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    const flow = this.deps.customService;
    if (flow === undefined || capture.customerId !== customer.id) {
      return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
    }
    if (capture.purpose === 'CUSTOM_SERVICE_VOLUME') {
      const volume = await flow.recordVolume(scope, actor, {
        capture,
        text,
        botInstanceId: input.botInstanceId,
      });
      if (volume.outcome === 'INVALID') {
        return { key: 'bot.custom_service.invalid_volume', values: {}, buttons: [], orderId: null };
      }
      if (volume.outcome === 'UNAVAILABLE') {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.custom_service.ask_days',
        values: { volumeBytes: volume.volumeBytes },
        buttons: [],
        orderId: null,
      };
    }
    try {
      const days = await flow.recordDays(scope, actor, { capture, text });
      if (days.outcome === 'INVALID') {
        return { key: 'bot.custom_service.invalid_days', values: {}, buttons: [], orderId: null };
      }
      return this.afterDraft(
        scope,
        actor,
        days.order,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * A customer asked for a trial — the main menu's «🧪 دریافت سرویس تست», `/trial`, or a
   * pre-F5 catalogue message's trial button (R1).
   *
   * Which panels offer one is `TrialService.claim`'s answer, decided with no panel named —
   * enabled, eligible by the one evaluator, able to name the account — and never this
   * surface's. Exactly
   * one: the trial is taken on it at once. Several: the customer chooses, from buttons
   * carrying only the panel's id. None, or a customer who may not take one: the one
   * unavailable sentence. Every refusal says the same thing; the reason is the service's.
   *
   * A NEW message rather than an edit: the main-menu tap is a text message of the
   * customer's, which there is nothing of ours to edit, and the choice is the one step
   * between the tap and the result.
   */
  private async beginTrial(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    if (this.deps.trials === undefined) return trialUnavailable();
    /*
     * The claim decides — not an availability read ahead of it. It answers a redelivered
     * update from the record the first delivery left, BEFORE it looks at what is offered
     * now: a trial already issued for this update is issued again (not "unavailable"
     * because the allowance is now spent), and a refusal stays a refusal even if a panel
     * came on in between. Codex, PR #111.
     */
    const result = await this.deps.trials.claim(scope, actor, customer.id, {
      idempotencyKey: `${idempotencyKey}:trial`,
    });
    if (result.outcome === 'ISSUED') {
      return { key: 'bot.trial.issued', values: {}, buttons: [], orderId: null };
    }
    if (result.outcome === 'REFUSED') return trialUnavailable();
    return {
      key: 'bot.trial.choose_panel',
      values: {},
      buttons: [
        ...result.offers.map((offer) => ({
          ...inlineLabel('trial.panel', {
            label: offer.label,
            traffic: offer.trafficBytes,
            hours: offer.durationHours,
          }),
          data: `${TRIAL_PANEL_CALLBACK_PREFIX}${offer.panelId}`,
        })),
        mainMenuButton(),
      ],
      orderId: null,
    };
  }

  /**
   * The customer takes the trial on one panel: the only one offered, or the one they
   * chose.
   *
   * One sentence either way. `bot.trial.issued` says the service is being created — the
   * link then arrives through the ordinary delivery lane, as a purchase's does, once the
   * panel has answered. Every refusal says `bot.trial.unavailable`: the reason (limit
   * reached, blocked, panel no longer offering one) is in the audit row for an operator.
   *
   * Idempotent by the UPDATE: a redelivered tap is answered from the claim's record with
   * the same trial, and a second tap — a new update — is decided afresh under the
   * customer's lock, finds the allowance spent and is refused, so a double tap never
   * issues two trials a limit of one does not allow.
   */
  private async claimTrial(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    panelId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    if (this.deps.trials === undefined) return trialUnavailable();
    // Suffixed, as every other write this update makes: `resolveFromUpdate` has already
    // spent the bare key in the same namespace.
    const result = await this.deps.trials.claim(scope, actor, customer.id, {
      idempotencyKey: `${idempotencyKey}:trial`,
      panelId,
    });
    return result.outcome === 'ISSUED'
      ? { key: 'bot.trial.issued', values: {}, buttons: [], orderId: null }
      : trialUnavailable();
  }

  /**
   * One page of the products inside one category — the second step.
   *
   * The category id comes from a button, so it may be stale: withdrawn, hidden, emptied
   * or another tenant's since the list was drawn. None of that is decided HERE. The
   * query carries the category's own status and visibility predicates and the tenant,
   * so every one of those cases reaches this handler as an empty page — and an empty
   * first page is answered with `bot.catalog.category_empty` and a way back, which is
   * the truthful outcome whichever of them it was.
   *
   * A product button carries the PRODUCT'S id. Tapping it goes through `createDraft`,
   * which re-reads the product and its category inside its own transaction and refuses
   * what is no longer orderable — so a button older than a withdrawal is refused with a
   * sentence rather than honoured, and nothing a position in this page could mean is
   * ever looked up.
   */
  private async categoryPage(
    scope: TenantContext,
    actor: ActorContext,
    categoryId: string,
    page: number,
    /** Whose catalogue: a reseller's tier decides what they see (WP9-B R6). */
    customerId: string,
  ): Promise<PendingReply> {
    const { items, hasMore } = await this.deps.products.browseCategory(
      scope,
      actor,
      categoryId,
      CATALOG_BROWSE_PAGE_SIZE,
      page * CATALOG_BROWSE_PAGE_SIZE,
      customerId,
    );
    const back: CustomerButton = {
      ...inlineLabel('catalog.back_to_categories'),
      data: `${CATALOG_PAGE_CALLBACK_PREFIX}0`,
    };
    if (items.length === 0) {
      if (page > 0) return this.categoryPage(scope, actor, categoryId, 0, customerId);
      return {
        key: 'bot.catalog.category_empty',
        values: {},
        buttons: [back],
        orderId: null,
        wizard: { kind: 'ORDER', step: 'PRODUCTS' },
      };
    }
    const buttons: CustomerButton[] = [];
    for (const product of items) {
      // The SQL returns only priced products; a null here would mean the read model
      // changed under this surface. Skipped rather than drawn without an amount,
      // because a plan whose price a customer cannot see is one they cannot consent to.
      if (product.price === null) continue;
      buttons.push({
        ...inlineDataLabel('catalog.product', {
          kind: 'TEXT',
          text: product.title,
          amount: product.price,
        }),
        data: `${ORDER_CALLBACK_PREFIX}${product.id}`,
      });
    }
    if (page > 0) {
      buttons.push({
        ...inlineLabel('catalog.previous_page'),
        data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page - 1}`,
      });
    }
    if (hasMore && page < CATALOG_BROWSE_MAX_PAGE) {
      buttons.push({
        ...inlineLabel('catalog.next_page'),
        data: `${CATEGORY_CALLBACK_PREFIX}${categoryId}.${page + 1}`,
      });
    }
    buttons.push(back);
    return {
      key: 'bot.catalog.heading',
      values: {},
      buttons,
      orderId: null,
      wizard: { kind: 'ORDER', step: 'PRODUCTS' },
    };
  }

  /**
   * The summary a customer confirms, with the name their service will carry.
   *
   * One builder for every path that reaches it — the draft, the two mode buttons and
   * the typed name — because the summary is the thing the customer AGREES to, and four
   * copies of it are four chances for one of them to show a figure the order does not
   * have. `username` is omitted rather than blanked when there is none: the placeholder
   * is optional, so a body that renders it simply does not, and a body a tenant
   * overrode before this step existed is unaffected.
   */
  private async preinvoice(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    username: string | null,
  ): Promise<PendingReply> {
    const discounted = order.totals.discount.amountMinor > 0n;
    const cashback = order.totals.quote.cashback;
    // A purchase shows the plan's allowance; an action on an existing service does not.
    const commercial = order.purpose !== 'NEW_SERVICE' && order.purpose !== 'CUSTOM_SERVICE';
    // Marketing display data for the plan being bought or renewed; a package has none.
    const display =
      order.purpose === 'ADD_TRAFFIC' ||
      order.purpose === 'ADD_TIME' ||
      order.purpose === 'ADD_DEVICES' ||
      order.purpose === 'CHANGE_LOCATION'
        ? null
        : await this.deps.productDisplay.displayFor(scope, order.line.productId);
    // WP-A6: a paid move states from where and to where, from its frozen change request.
    const locationChange =
      order.purpose === 'CHANGE_LOCATION'
        ? await this.deps.commercial.locationChangeFor(scope, actor, customer.id, order.id)
        : null;
    /*
     * WP-A5: an extra-users order states what it bought from its own frozen line — the
     * count, the price of one, and the limit before and after, the target being what
     * `line_device_limit` holds.
     */
    const target = order.line.specification.deviceLimit;
    const devices =
      order.purpose === 'ADD_DEVICES' && target !== null
        ? {
            quantity: order.line.quantity,
            unitPrice: order.line.unitPrice,
            currentLimit: target - order.line.quantity,
            targetLimit: target,
          }
        : null;
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    // A custom service shows what it was priced from, from the order's frozen terms.
    const custom =
      order.purpose === 'CUSTOM_SERVICE'
        ? await this.deps.customService?.termsFor(scope, order.id)
        : undefined;
    const screen = await this.deps.screens.preinvoice(scope, {
      custom:
        custom === undefined || custom === null
          ? null
          : {
              location: custom.locationLabel,
              volumeBytes: custom.trafficBytes,
              pricePerGb: custom.pricePerGb,
              volumePrice: custom.volumePrice,
              durationDays: custom.durationDays,
              pricePerDay: custom.pricePerDay,
              timePrice: custom.timePrice,
            },
      devices,
      locationChange,
      serviceUsername: username,
      productName: order.line.title,
      durationDays:
        order.purpose === 'ADD_TRAFFIC' ||
        order.purpose === 'ADD_DEVICES' ||
        order.purpose === 'CHANGE_LOCATION'
          ? null
          : order.line.specification.durationDays,
      total: order.totals.total,
      trafficBytes: commercial ? null : order.line.specification.trafficBytes,
      addedTrafficBytes:
        order.purpose === 'ADD_TRAFFIC' ? order.line.specification.trafficBytes : null,
      discount: discounted
        ? { subtotal: order.totals.subtotal, discount: order.totals.discount }
        : null,
      cashback: cashback === undefined ? null : cashback.amount,
      locations: display?.displayLocations ?? [],
      features: display?.displayFeatures ?? [],
      walletBalance: money(balance.amountMinor, balance.currency),
    });
    const routes = await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total);
    return {
      key: screen.key,
      values: screen.values,
      buttons: preinvoiceButtons(order, routes.length > 0),
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'PREINVOICE', subjectId: order.id },
    };
  }

  /**
   * The summary again, for a draft whose quote just changed under a code.
   *
   * The username is read back rather than carried, because the code turn does not know
   * it: the window that brought the code names only the order.
   */
  private async repricedSummary(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const step = await this.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    return this.preinvoice(scope, actor, order, customer, step.reservation?.username ?? null);
  }

  /** Opens the code window for one draft and asks for the code. */
  private async enterDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.beginDiscountCodeEntry(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-entry`,
        botInstanceId,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.discount.ask',
        values: {},
        buttons: [],
        orderId,
        wizard: { kind: 'ORDER', step: 'DISCOUNT', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Takes the code off a draft: the draft is re-quoted from its own snapshot. */
  private async removeDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.applyDiscountCode(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-remove`,
        customerId: customer.id,
        orderId,
        code: null,
      });
      return this.repricedSummary(scope, actor, order, customer);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * An ordinary message the username window did not claim. A code only if the code
   * window says so; otherwise the fallback every unrecognised message has always had.
   */
  private async typedDiscountCode(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.orders.submitTypedDiscountCode(scope, actor, {
        idempotencyKey: `${idempotencyKey}:discount-text`,
        botInstanceId,
        customerId: customer.id,
        text,
      });
      if (result.outcome === 'NO_WINDOW') {
        return { key: 'bot.unknown_command', values: {}, buttons: [], orderId: null };
      }
      const summary = await this.repricedSummary(scope, actor, result.order, customer);
      // R2: the wizard that asked for the code shows the re-priced pre-invoice.
      return {
        ...summary,
        wizard: {
          kind: 'ORDER',
          step: 'PREINVOICE',
          subjectId: result.order.id,
          anchor: { steps: ['DISCOUNT'], subjectId: result.order.id },
        },
      };
    } catch (error) {
      // `DISCOUNT_CODE_REJECTED` through the shared table: one sentence for every reason,
      // and the window left open by the rolled-back transaction — on ITS order's wizard.
      const refused = refusal(error);
      const orderId =
        (await this.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'DISCOUNT')) ??
        null;
      return {
        ...refused,
        wizard: {
          kind: 'ORDER',
          step: 'DISCOUNT',
          anchor: { steps: ['DISCOUNT'], subjectId: orderId },
        },
      };
    }
  }

  /**
   * What to show once a draft exists: the summary, or the username question first.
   *
   * The question is skipped in two cases and both are deliberate. A name already
   * reserved — a redelivered tap, a customer who came back — goes straight to the
   * summary carrying it, because asking again would suggest the first answer did not
   * take. And a panel offering only RANDOM has no question to ask: one button is a tap
   * that teaches nothing, so the name is drawn and the summary shows it.
   *
   * A panel offering only CUSTOM still shows this screen rather than opening the
   * window unasked. The window makes an ordinary message mean something, and opening
   * one the customer did not ask for is the half of INCIDENT-FIN-001 that is about
   * surprise rather than duration.
   */
  private async afterDraft(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const step = await this.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    if (step.reservation !== null) {
      return this.preinvoice(scope, actor, order, customer, step.reservation.username);
    }
    if (step.modes.length === 0) return this.preinvoice(scope, actor, order, customer, null);
    /*
     * ONE mode is not a question, whichever mode it is.
     *
     * An earlier version made an exception for CUSTOM: a single AUTOMATIC button was
     * skipped, but a single CUSTOM button was still drawn, on the reasoning that
     * opening a typing window the customer did not ask for is the surprise half of
     * INCIDENT-FIN-001. The owner overruled that, and the overruling is right — what
     * INCIDENT-FIN-001 is about is a window that outlives its question and swallows an
     * unrelated message. This window is opened BY the purchase the customer is in the
     * middle of, it names that one order, and it says in full what it is waiting for.
     *
     * What the exception actually produced was a screen offering one button, which
     * teaches the customer nothing and costs them a tap.
     */
    if (step.modes.length === 1) {
      return step.modes[0] === 'AUTOMATIC'
        ? this.automaticUsername(scope, actor, order.id, customer, idempotencyKey)
        : this.customUsername(scope, actor, order.id, customer, botInstanceId, idempotencyKey);
    }

    const buttons: CustomerButton[] = [];
    if (step.modes.includes('CUSTOM')) {
      buttons.push({
        ...inlineLabel('username.custom'),
        data: `${USERNAME_CUSTOM_CALLBACK_PREFIX}${order.id}`,
      });
    }
    if (step.modes.includes('AUTOMATIC')) {
      buttons.push({
        ...inlineLabel('username.automatic'),
        data: `${USERNAME_AUTOMATIC_CALLBACK_PREFIX}${order.id}`,
      });
    }
    return {
      key: 'bot.username.choose',
      values: {},
      buttons,
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: order.id },
    };
  }

  /** The installation draws a name, and the summary shows the one it drew. */
  private async automaticUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const reservation = await this.deps.orders.chooseUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username`,
        customerId: customer.id,
        orderId,
        choice: { mode: 'AUTOMATIC' },
      });
      /*
       * The CUSTOMER's read, not the operator's. `get` charges `orders.view`, which a
       * customer turn does not hold — so it threw here AFTER the reservation had
       * committed, and the customer saw nothing at all.
       */
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      return this.preinvoice(scope, actor, order, customer, reservation.username);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Open the typing window and state the whole rule.
   *
   * The rule is sent in FULL, once, before the customer types, which is why
   * `bot.username.invalid` names no clause: a refusal that said which rule was broken
   * would add nothing they were not already told and would turn each attempt into a
   * probe of the validator.
   */
  private async customUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.beginUsernameEntry(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-entry`,
        botInstanceId,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.username.instructions',
        values: {},
        buttons: [],
        orderId,
        wizard: { kind: 'ORDER', step: 'USERNAME', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * An ordinary message, which is a username only if a window says so.
   *
   * `NO_WINDOW` is the answer for almost every message this bot receives, and it
   * returns the same fallback the surface has always given. That is the whole safety
   * argument for routing plain text here at all: the decision is the database's, the
   * default is unchanged, and nothing about this path can reach anything but one draft
   * order of one customer.
   */
  private async typedUsername(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.orders.submitTypedUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-text`,
        botInstanceId,
        customerId: customer.id,
        text,
      });
      if (result.outcome === 'NO_WINDOW') {
        // Not a username. Perhaps a discount code; otherwise the fallback it always got.
        return this.typedDiscountCode(scope, actor, text, customer, botInstanceId, idempotencyKey);
      }
      // The customer's read. See `automaticUsername` for what `get` did here.
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId: result.reservation.orderId,
      });
      const summary = await this.preinvoice(
        scope,
        actor,
        order,
        customer,
        result.reservation.username,
      );
      // R2: the wizard that asked for the name shows the pre-invoice.
      return {
        ...summary,
        wizard: {
          kind: 'ORDER',
          step: 'PREINVOICE',
          subjectId: order.id,
          anchor: { steps: ['USERNAME'], subjectId: order.id },
        },
      };
    } catch (error) {
      /*
       * Every refusal through the shared table, and NOTHING about the window.
       *
       * The two the customer can act on — an invalid name and a taken one — leave the
       * window OPEN, because `submitTypedUsername` closes it only for an accepted
       * name, so they type another and are answered again.
       *
       * They used to be mapped by two branches here rather than in `REFUSAL_REPLIES`,
       * which meant the same refusal arriving through the AUTOMATIC path had no entry
       * at all and `refusal` rethrew it. One table for all five is what makes the two
       * paths answer alike.
       */
      /*
       * R2: shown in the wizard that asked; the window stays open, so the step does too. The
       * refusal names no order, so the open window is asked which one: with two purchases
       * open, the chat's most recently touched USERNAME wizard may be the OTHER order's.
       */
      const refused = refusal(error);
      const orderId =
        (await this.deps.answerWindowOrder?.(scope, botInstanceId, customer.id, 'USERNAME')) ??
        null;
      return {
        ...refused,
        wizard: {
          kind: 'ORDER',
          step: 'USERNAME',
          anchor: { steps: ['USERNAME'], subjectId: orderId },
        },
      };
    }
  }

  /** The summary a customer confirms. Every figure comes from the ORDER, never the tap. */
  private async draft(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.createDraft(scope, actor, {
        // Suffixed, and the suffix is load-bearing. `resolveFromUpdate` already consumed
        // the bare update key in the `TELEGRAM` namespace, and presenting it again with
        // a different payload is `platform.idempotency_payload_mismatch` — the exact
        // collision `webhook.controller.ts` records for `/ping`. The update's identity is
        // still the base; this names the second command WITHIN that update.
        idempotencyKey: `${idempotencyKey}:draft`,
        customerId: customer.id,
        productId,
      });
      return this.afterDraft(scope, actor, order, customer, botInstanceId, idempotencyKey);
    } catch (error) {
      return refusal(error);
    }
  }

  /** DRAFT to AWAITING_PAYMENT, and the message that says what that means. */
  private async confirm(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId: customer.id,
        orderId,
      });
      return this.awaitingPaymentReply(scope, customer, order);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The awaiting-payment message: what is owed, until when, and the buttons that pay it.
   * One builder for a confirmed purchase, a confirmed commercial action and the selector's
   * «❌ بستن لیست», so the three can never draw different buttons for the same order.
   */
  private async awaitingPaymentReply(
    scope: TenantContext,
    customer: CustomerRecord,
    order: OrderRecord,
  ): Promise<PendingReply> {
    return {
      key: 'bot.order.awaiting_payment',
      /*
       * What is owed, until when, and — since 4C — the buttons that pay it.
       *
       * The sentence here used to say there was no way to pay, which was true when
       * this message was written and false the moment `paymentButtons` was attached
       * below. The deadline it renders is now enforced where the money moves:
       * `orderAwaitingPayment` refuses a tap after `expiresAt`, so «اعتبار تا» is a
       * fact rather than decoration on a button that worked for ever.
       *
       * `expiresAt` is required by the key's declaration, and an order that reached
       * AWAITING_PAYMENT always has one — the draft carried it. The fallback is the
       * renderer's rule rather than a guess: a missing required value throws in the
       * resolver, which is better than a customer reading a literal `{expiresAt}`.
       */
      values: {
        total: order.totals.total,
        ...(order.expiresAt === null ? {} : { expiresAt: order.expiresAt }),
      },
      buttons: paymentButtons(
        order.id,
        (await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total)).length > 0,
      ),
      orderId: order.id,
      wizard: { kind: 'ORDER', step: 'AWAITING_PAYMENT', subjectId: order.id },
    };
  }

  /**
   * The customer's own balance, derived from the ledger every time it is asked for.
   *
   * There is no balance column to read and no cache to go stale — `balanceOf` sums the
   * entries. `bot.wallet.balance` declares exactly one placeholder and this supplies
   * exactly that.
   */
  private async walletBalance(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    const counters = await this.deps.counters.counters(scope, customer.id);
    /*
     * The referral COUNT stays on the account summary: it is a fact about this customer
     * that Mirza's /wallet shows too (the one referral surface its research VERIFIED). The
     * referral BUTTON does not (F5): the wallet carries wallet operations only, and the
     * program is reached from its own main-menu button and `/referral`.
     */
    const referralCount =
      this.deps.referralGifts === undefined
        ? 0
        : (await this.deps.referralGifts.stats(scope, customer.id)).referralCount;
    const reseller =
      this.deps.resellers === undefined
        ? null
        : await this.deps.resellers.standing(scope, customer.id, undefined);
    const fundable =
      (await this.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null)).length > 0;
    const summary = await this.deps.screens.walletSummary(scope, {
      telegramId: customer.telegramUserId,
      displayName: displayNameOf(customer),
      registeredAt: customer.createdAt,
      balance: money(balance.amountMinor, balance.currency),
      serviceCount: counters.services,
      paidInvoiceCount: counters.paidInvoices,
      referralCount,
      group: reseller === null ? 'CUSTOMER' : 'RESELLER',
      // Owner spec §3: when the screen was drawn, not when anything happened.
      now: this.deps.clock.now(),
    });
    return {
      key: summary.key,
      values: summary.values,
      buttons: [
        ...(fundable
          ? [
              {
                ...inlineLabel('wallet.topup'),
                data: TOPUP_MENU_CALLBACK_PREFIX,
              },
            ]
          : []),
        mainMenuButton(),
      ],
      orderId: null,
    };
  }

  /**
   * The referral program, in EXACTLY two messages (R1).
   *
   * 1. The invite — the one a customer forwards to a friend: the banner, the program's
   *    introduction and the customer's link, as ONE message (the banner's caption when
   *    there is a banner, text otherwise). It carries no figure about the customer.
   * 2. The dashboard — theirs alone: the gift terms, the commission, its scope and
   *    minimum, and their figures, under the share, claim-gift and back buttons.
   *
   * Every figure is `ReferralProgram.terms`' and `ReferralSignupGiftService.stats`' —
   * nothing is calculated here. Asking records the customer's code the first time, which
   * is why it carries the turn's idempotency key; every other answer is the one
   * unconfigured sentence. Reached from the main menu's «👥 زیرمجموعه‌گیری», `/referral`
   * and — from a wallet message drawn before F5 — the wallet's old referral button alike.
   */
  private async referralInvite(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const unconfigured: PendingReply = {
      key: 'bot.referral.unconfigured',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
    if (this.deps.referrals === undefined || this.deps.referralGifts === undefined) {
      return unconfigured;
    }
    const terms = await this.deps.referrals.terms(scope);
    if (!terms.active || terms.percent === null) return unconfigured;
    const invite = await this.deps.referrals.invite(scope, actor, {
      // Suffixed, as every other write that shares a turn with `resolveFromUpdate` is:
      // the bare key was consumed there.
      idempotencyKey: `${idempotencyKey}:referral`,
      customerId: customer.id,
      botInstanceId,
    });
    if (invite.outcome !== 'READY') return unconfigured;
    const gift = await this.deps.referralGifts.terms(scope);
    const stats = await this.deps.referralGifts.stats(scope, customer.id);
    /*
     * The claim button only when there is something to claim — the gift on AND a share
     * owed to this customer now (`claimableFor`, the service's own answer). A button that
     * can only say "nothing to claim" is a promise the keyboard broke.
     */
    const claimable =
      gift.active &&
      (this.deps.referralGifts.claimableFor === undefined ||
        (await this.deps.referralGifts.claimableFor(scope, customer.id)).length > 0);
    const card = this.deps.screens.referralInviteCard({
      commissionPercent: terms.percent,
      referralLink: invite.link,
    });
    const dashboard = await this.deps.screens.referralDashboard(scope, {
      commissionPercent: terms.percent,
      commissionScope: terms.scope,
      minimumOrder: terms.minimum,
      gift: gift.active
        ? {
            total: gift.total,
            referrerPercent: gift.referrerPercent,
            referredPercent: gift.referredPercent,
          }
        : null,
      referralCount: stats.referralCount,
      referredPurchaseCount: stats.referredPurchaseCount,
      referredPurchaseTotal: stats.referredPurchaseTotal,
      commissionReceivedTotal: stats.commissionReceivedTotal,
    });
    const banner =
      this.deps.media === undefined
        ? null
        : await this.deps.media.bytesFor(scope, 'REFERRAL_BANNER');
    return {
      key: dashboard.key,
      values: dashboard.values,
      buttons: [
        {
          ...inlineLabel('referral.share'),
          // Telegram's own share sheet, with the customer's link as the payload.
          url: `https://t.me/share/url?url=${encodeURIComponent(invite.link)}`,
        },
        ...(claimable
          ? [
              {
                ...inlineLabel('referral.gift'),
                data: REFERRAL_GIFT_CALLBACK_DATA,
              },
            ]
          : []),
        mainMenuButton(),
      ],
      orderId: null,
      // Message 1, ahead of the dashboard: the banner WITH the invite as its caption, so
      // forwarding it forwards the picture, the words and the link together.
      lead: [
        banner === null
          ? { kind: 'TEXT' as const, key: card.key, values: card.values }
          : {
              kind: 'PHOTO_BYTES' as const,
              bytes: banner.bytes,
              mimeType: banner.mimeType,
              fileName: banner.mimeType === 'image/png' ? 'banner.png' : 'banner.jpg',
              caption: { key: card.key, values: card.values },
            },
      ],
    };
  }

  /**
   * The offered amounts, one button each, read when the tap arrives.
   *
   * No amount is baked into the message that drew this: a customer scrolling back to an
   * old balance and tapping gets today's presets, not the ones that were configured when
   * it was sent. The refusal when nothing is offered is the same one the service gives,
   * so a customer who taps a button that has since become unfundable is told the same
   * thing either way.
   */
  private async topupBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const offered = await this.deps.routes.routesFor(scope, customer.id, 'WALLET_TOPUP', null);
    if (offered.length === 0) {
      return {
        key: 'bot.wallet.topup_unavailable',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const begun = await this.deps.topup.begin(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:topup-begin`,
    });
    // The presets, when configured, are shortcuts that record the figure on the same
    // capture the typed path uses; they are not a second flow.
    const presets = await this.deps.payments.topupPresets(scope);
    return {
      key: 'bot.wallet.topup_amount_prompt',
      values: {
        ...(begun.minimum === null ? {} : { minimum: begun.minimum }),
        ...(begun.maximum === null ? {} : { maximum: begun.maximum }),
      },
      buttons: [
        ...presets.map((preset) => ({
          ...inlineDataLabel('wallet.topup_amount', { kind: 'AMOUNT', amount: preset }),
          data: `${TOPUP_PICK_CALLBACK_PREFIX}${preset.amountMinor.toString()}`,
        })),
        {
          ...inlineLabel('list.close'),
          data: `${TOPUP_CLOSE_CALLBACK_PREFIX}${begun.capture.id}`,
        },
      ],
      orderId: null,
      wizard: { kind: 'TOPUP', step: 'AMOUNT', subjectId: begun.capture.id },
    };
  }

  /**
   * A chosen amount becomes an invoice — the SAME invoice an order's transfer produces.
   *
   * `renderTransferInstruction` is shared, so the customer gets the structured
   * card-to-card destination, the two copy buttons and the combined
   * «پرداخت را انجام دادم | ارسال رسید» button that 5A and 5R built. A top-up has no
   * order, so nothing here names one.
   */
  private async topupPick(
    scope: TenantContext,
    actor: ActorContext,
    amountMinor: string,
    customer: CustomerRecord,
    idempotencyKey: string,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const presets = await this.deps.payments.topupPresets(scope);
    const preset = presets.find((candidate) => candidate.amountMinor.toString() === amountMinor);
    if (preset === undefined) {
      return {
        key: 'bot.wallet.topup_refused',
        values: {},
        buttons: [],
        orderId: null,
        wizard: { kind: 'TOPUP', step: 'NOTICE' },
      };
    }
    const begun = await this.deps.topup.begin(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:topup-pick`,
    });
    const result = await this.deps.topup.recordAmount(scope, {
      customerId: customer.id,
      captureId: begun.capture.id,
      amount: preset,
    });
    return this.topupAmountReply(scope, result, begun.capture.id);
  }

  /**
   * Paying for an order from the wallet. The tap carries the ORDER ID AND NOTHING ELSE.
   *
   * Every figure that decides how much money moves is read by the service inside the
   * transaction that moves it — the amount and currency from the order's frozen
   * snapshot, the owner from the order row, the state by the conditional UPDATE. Nothing
   * this surface passes could change any of them: it has an id and a customer, and the
   * customer comes from the resolved Telegram user rather than from the tap.
   *
   * The success reply is `bot.order.settled`, which says the payment was confirmed and
   * the order is paid. It does NOT say a service is being prepared, because nothing in
   * this release prepares one.
   */
  private async walletPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      /*
       * From the pre-invoice a DRAFT is paid in one tap: the balance is read FIRST, and a
       * shortfall answers without confirming anything — a reservation held for money
       * that is not there is a slot nobody can buy until it lapses. Then the confirm
       * (which reserves and redeems) and the settlement, each under its own key, each
       * exactly-once on replay.
       */
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (before.state === 'DRAFT') {
        const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
        if (
          balance.currency !== before.totals.total.currency ||
          balance.amountMinor < before.totals.total.amountMinor
        ) {
          const shortfall = money(
            balance.currency === before.totals.total.currency
              ? before.totals.total.amountMinor - balance.amountMinor
              : before.totals.total.amountMinor,
            before.totals.total.currency,
          );
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [topupButton(), mainMenuButton()],
            orderId,
            // R2: its own message, so the pre-invoice stays payable after a top-up.
            wizard: WALLET_SHORT,
          };
        }
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const { order } = await this.deps.payments.settleFromWallet(scope, actor, customer.id, {
        // Suffixed within the update's own key, the shape `draft` and `confirm` use: the
        // bare key was consumed by `resolveFromUpdate`, and presenting it again with a
        // different payload is an idempotency payload mismatch. A REDELIVERED update
        // recomputes this same suffix, which is what makes the replay produce one debit.
        idempotencyKey: `${idempotencyKey}:wallet-pay`,
        orderId,
      });
      /*
       * R2 (items 5 and 11): the wizard is CLOSED here, in place and with no buttons, and
       * what follows is a NEW message — the delivery of a new service, or the renewal's own
       * result from the notification lane. A renewal is not closed with the generic "order
       * paid" sentence: its payment message says the renewal is on its way.
       */
      return {
        key: order.purpose === 'RENEW' ? 'bot.service.renew_paid' : 'bot.order.settled',
        values: {},
        buttons: [],
        orderId: order.id,
        ...followUpForSettlement(order.purpose),
        wizard: { kind: 'ORDER', step: 'CLOSED', subjectId: order.id },
      };
    } catch (error) {
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW) {
        return {
          key: 'bot.payment.transfer_under_review',
          values: {},
          buttons: [],
          orderId,
          wizard: WALLET_SHORT,
        };
      }
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS) {
        const shortfall = shortfallOf(error.details);
        if (shortfall !== null) {
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [topupButton(), mainMenuButton()],
            orderId,
            wizard: WALLET_SHORT,
          };
        }
      }
      return refusal(error);
    }
  }

  /**
   * DRAFT → AWAITING_PAYMENT through the lane that owns the order's purpose: a new
   * service through `OrderService.confirm`, a renewal or a package through
   * `CommercialActionService.confirm`. Both are exactly-once under the update's key.
   */
  private async confirmDraft(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<OrderRecord> {
    if (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE') {
      return this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId: customer.id,
        orderId: order.id,
      });
    }
    return this.deps.commercial.confirm(scope, actor, customer.id, {
      orderId: order.id,
      idempotencyKey: `${idempotencyKey}:action_confirm`,
    });
  }

  /**
   * Choosing to pay out of band: a PENDING payment, WHERE to send the money, and the
   * code to quote.
   *
   * No money moves and nothing settles. Every figure comes from what the service
   * committed — the total from the order's frozen snapshot, the reference GENERATED
   * because a customer who could choose it could choose somebody else's, and the bank
   * details from `payment_destinations`, which was written in the same transaction as
   * the payment and can never be edited afterwards.
   *
   * That last one is the whole of 5A. Before it, this message said «طبق راهنمای
   * فروشنده» — follow the seller's instructions — and the only place an operator could
   * put a card number was inside an overridden copy of this very template, where editing
   * it rewrote what every already-issued instruction said.
   *
   * A payment issued BEFORE 5A has no snapshot, and falls back to the old key. That is
   * not a lesser rendering of the same thing: it is the only thing this installation can
   * truthfully say about a payment whose destination was never recorded.
   */
  private async manualPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (before.state === 'DRAFT') {
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const instruction = await this.deps.payments.requestManualTransfer(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:manual-pay`, orderId },
      );
      return this.transferInstruction(scope, instruction, orderId);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * One button per payment route offered for paying this order, in the operator's order —
   * what «🧾 ثبت پرداخت» opens, and whether it is drawn at all.
   *
   * Built from the routes rather than from a list of providers, so a route added later
   * appears here without a change: each is dispatched by what its DESCRIPTOR says it
   * settles through. `GATEWAY` taps `gp:<order>.<provider>` (TonPays, Stars, any external
   * route); `MANUAL_TRANSFER` taps `m:<order>`, the card-to-card instruction and then the
   * receipt flow. A route that settles any other way has no order tap and is not drawn.
   *
   * Card-to-card keeps the offer rule it always had: `manualTransferOffered` (the route
   * switched on for purchases AND an enabled account to pay into), not the per-customer
   * thresholds — whether those apply to an order payment is `OQ-5C-01`. So it is drawn
   * where the operator ordered it when `routesFor` lists it, and last otherwise.
   *
   * Every button carries identifiers only. Each tap re-decides its route on the server.
   */
  private async orderRouteButtons(
    scope: TenantContext,
    customerId: UserId,
    orderId: string,
    amount: Money,
  ): Promise<readonly CustomerButton[]> {
    const routes = await this.deps.routes.routesFor(scope, customerId, 'SERVICE_PURCHASE', amount);
    const manualOffered = await this.deps.payments.manualTransferOffered(scope);
    const buttons: CustomerButton[] = [];
    let manualDrawn = false;
    for (const route of routes) {
      let data: string | null = null;
      if (route.descriptor.settlesVia === 'GATEWAY') {
        data = `${GATEWAY_ROUTE_PAY_CALLBACK_PREFIX}${orderId}.${route.provider}`;
      } else if (
        route.descriptor.settlesVia === 'MANUAL_TRANSFER' &&
        manualOffered &&
        !manualDrawn
      ) {
        data = `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`;
        manualDrawn = true;
      }
      if (data === null) continue;
      buttons.push(routeButton(await this.deps.screens.routeName(scope, route), data));
    }
    if (manualOffered && !manualDrawn) {
      const name = await this.deps.screens.routeName(scope, {
        provider: 'MANUAL_TRANSFER',
        displayName: null,
      });
      buttons.push(routeButton(name, `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`));
    }
    return buttons;
  }

  /**
   * «💰 روش پرداخت خود را انتخاب نمایید» for one order: the routes `orderRouteButtons`
   * offers, then «❌ بستن لیست».
   *
   * Writes nothing. The order is read as THIS customer's, so another customer's id
   * answers the refusal, and an order no longer payable (paid, cancelled, expired) answers
   * `bot.order.not_awaiting_payment`. No payment attempt exists until a route is tapped.
   */
  private async paymentMethods(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      const close: CustomerButton = {
        ...inlineLabel('list.close'),
        data: `${PAY_METHODS_CLOSE_CALLBACK_PREFIX}${order.id}`,
      };
      if (order.state !== 'DRAFT' && order.state !== 'AWAITING_PAYMENT') {
        return {
          key: 'bot.order.not_awaiting_payment',
          values: {},
          buttons: [mainMenuButton()],
          orderId: order.id,
        };
      }
      const routes = await this.orderRouteButtons(scope, customer.id, order.id, order.totals.total);
      if (routes.length === 0) {
        return {
          key: 'bot.wallet.topup_none_available',
          values: {},
          buttons: [close],
          orderId: order.id,
          wizard: { kind: 'ORDER', step: 'METHODS', subjectId: order.id },
        };
      }
      return {
        key: 'bot.wallet.topup_method_prompt',
        values: {},
        buttons: [...routes, close],
        orderId: order.id,
        wizard: { kind: 'ORDER', step: 'METHODS', subjectId: order.id },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * «❌ بستن لیست» on an order's selector: the screen the customer opened it from, or null
   * for the main menu. Writes nothing and creates no payment.
   *
   * An order awaiting payment answers its awaiting-payment message again; a new purchase
   * still in DRAFT answers its pre-invoice again. Anything else — a commercial draft, an
   * order that was paid, cancelled or expired meanwhile — answers the main menu.
   */
  private async paymentMethodsBack(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply | null> {
    try {
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      if (order.state === 'AWAITING_PAYMENT') {
        return this.awaitingPaymentReply(scope, customer, order);
      }
      if (
        order.state === 'DRAFT' &&
        (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
      ) {
        return this.repricedSummary(scope, actor, order, customer);
      }
      return null;
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Paying an order through an external gateway (WP11A). The tap carries the ORDER ID.
   *
   * The route is the first external route offered for this order, in the operator's
   * order — decided BEFORE a draft is confirmed, so a customer shown a stale button does
   * not reserve a slot for a payment they cannot make. Then the service opens (or hands
   * back) the attempt; the provider invoice is created by the worker, never while
   * Telegram waits, so the first answer is usually "being prepared" with a check button.
   *
   * A route that cannot be used right now is answered as unavailable, never as the
   * customer's payment failing (brief §19).
   */
  private async gatewayPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
    /** The route the customer tapped (`gp:`), or null for the older `g:` button. */
    provider: PaymentGatewayProvider | null,
  ): Promise<PendingReply> {
    try {
      const before = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      const route = (
        await this.deps.routes.routesFor(
          scope,
          customer.id,
          'SERVICE_PURCHASE',
          before.totals.total,
        )
      ).find(
        (candidate) =>
          candidate.descriptor.settlesVia === 'GATEWAY' &&
          (provider === null || candidate.provider === provider),
      );
      // R2: in the wizard, a way back to the other methods rather than a dead end.
      if (route === undefined) {
        return { ...gatewayUnavailable(), buttons: [payMethodsButton(orderId), mainMenuButton()] };
      }
      if (before.state === 'DRAFT') {
        await this.confirmDraft(scope, actor, before, customer, idempotencyKey);
      }
      const attempt = await this.deps.payments.requestGatewayPayment(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:gateway-pay`,
        orderId,
        provider: route.provider,
      });
      return await this.gatewayAttemptReply(attempt, orderId, scope);
    } catch (error) {
      const refused = gatewayRefusal(error);
      return refused.key === 'bot.payment.gateway_unavailable'
        ? { ...refused, buttons: [payMethodsButton(orderId), mainMenuButton()] }
        : refused;
    }
  }

  /**
   * "Check my payment" (WP11A): the stored state, and the next inquiry brought forward.
   * Another customer's payment, or one that is not a gateway attempt, is answered as a
   * closed attempt — never with anything about it.
   */
  private async gatewayCheck(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    await this.deps.gateway.requestCheck(scope, view);
    return this.gatewayAttemptReply({ ...view, reissued: true }, view.payment.orderId, scope);
  }

  /** An external-gateway attempt, as the customer sees it: `gatewayAttemptScreen`, now. */
  private async gatewayAttemptReply(
    attempt: GatewayAttempt | GatewayAttemptView,
    orderId: string | null,
    scope: TenantContext,
  ): Promise<PendingReply> {
    const facts = await this.deps.gateway.cardFactsFor(scope, attempt.invoice);
    return gatewayAttemptScreen(attempt, orderId, this.deps.clock.now(), facts);
  }

  /**
   * «📤 ارسال فیش واریزی» (TonPays Telegram, §8.3): opens the payment-scoped receipt window
   * and asks for ONE photo, as its own message — the payment message stays as it is. Refused
   * (re-decided against the rows) with the attempt's current screen: closed, in review, a
   * receipt already on its way. The tap extends nothing.
   */
  private async gatewayReceipt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    /*
     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
     * answered as closed — never with anything about the attempt.
     */
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const window = await this.deps.gatewayReceipts.openReceiptCapture(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (window === null) return this.refusedCardTap(scope, view);
    return {
      key: 'bot.payment.gateway_receipt_prompt',
      values: { closesAt: window.expiresAt },
      buttons: [mainMenuButton()],
      orderId: view.payment.orderId,
      wizard: {
        kind: view.payment.orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: view.payment.id,
        placement: 'NEW',
      },
    };
  }

  /**
   * «🔄 تعویض کارت» (TonPays Telegram, §8.2): a request row the worker sends; the payment
   * message is redrawn in place ("changing card…") and the worker edits the new card in.
   * Refused locally while one is in flight, during the cooldown or once exhausted — the
   * current screen is redrawn, which no longer carries the button.
   */
  private async gatewayCardChange(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    /*
     * TPTG-19: another customer's payment, another bot's attempt, or no such lane is
     * answered as closed — never with anything about the attempt.
     */
    if (
      view === null ||
      view.invoice.botInstanceId !== botInstanceId ||
      this.deps.gatewayReceipts === undefined
    ) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const requested = await this.deps.gatewayReceipts.requestCardChange(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:card-change`,
    });
    const fresh = (await this.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
    return requested
      ? this.gatewayAttemptReply({ ...fresh, reissued: true }, fresh.payment.orderId, scope)
      : this.refusedCardTap(scope, fresh);
  }

  /**
   * A refused `gr:`/`gk:` (TPTG-19): a payment still PENDING (a receipt already on its way, a
   * cooldown) or in review / UNKNOWN is redrawn as it stands — the review screens included;
   * anything else that is no longer payable answers `gateway_closed` and nothing more.
   */
  private refusedCardTap(
    scope: TenantContext,
    view: GatewayAttemptView,
  ): Promise<PendingReply> | PendingReply {
    if (view.payment.state === 'PENDING' || view.payment.state === 'UNKNOWN') {
      return this.gatewayAttemptReply({ ...view, reissued: true }, view.payment.orderId, scope);
    }
    return {
      key: 'bot.payment.gateway_closed',
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }

  /**
   * A photo for an open provider receipt window in THIS bot (§8.3), or null when none is
   * open — the caller then runs the manual flow exactly as before.
   */
  private async gatewayReceiptPhoto(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    file: InboundReceiptFile,
  ): Promise<PendingReply | null> {
    if (this.deps.gatewayReceipts === undefined) return null;
    const result = await this.deps.gatewayReceipts.receivePhoto(scope, actor, {
      customerId: customer.id,
      botInstanceId,
      file,
    });
    const reply = (key: TemplateKey): PendingReply => ({
      key,
      values: {},
      buttons: [mainMenuButton()],
      orderId: null,
    });
    switch (result) {
      case 'NO_WINDOW':
        return null;
      case 'QUEUED':
      case 'DUPLICATE':
        return reply('bot.payment.gateway_receipt_queued');
      case 'ALREADY_SENT':
        return reply('bot.payment.gateway_receipt_already_sent');
      case 'PHOTO_ONLY':
        return reply('bot.payment.gateway_receipt_photo_only');
      case 'TOO_LARGE':
        return reply('bot.payment.gateway_receipt_too_large');
      case 'CLOSED':
        return reply('bot.payment.gateway_closed');
    }
  }

  /**
   * The transfer invoice, rendered once for every payment that needs one.
   *
   * Shared by the order path and the wallet top-up path — the owner's 5B instruction is
   * to reuse this UX rather than build a second one, and sharing the FUNCTION is what
   * makes that structural: a change to the destination block, the copy buttons or the
   * receipt button reaches both, and neither can drift into telling a customer something
   * the other does not.
   *
   * `orderId` is null for a top-up. It travels on the reply rather than being read off
   * the payment because the messenger uses it for correlation, and a top-up correlates
   * to no order.
   */
  private async transferInstruction(
    scope: TenantContext,
    { payment, destination }: ManualTransferInstruction,
    orderId: string | null,
  ): Promise<PendingReply> {
    /*
     * The two copy controls, and they exist only when there is a snapshot to copy from.
     *
     * `copy_text` is Telegram's own clipboard button: no callback data, no handler,
     * nothing reaches this server when one is tapped. The amount is copied as BARE
     * digits — `plainAmount`, not `formatMoney` — because a banking app rejects
     * «۱٬۵۰۰٬۰۰۰ تومان` and accepts `1500000`.
     *
     * `row: 0` puts them side by side above the actions, which is the layout the owner
     * specified after staging acceptance.
     */
    const copies: CustomerButton[] =
      destination === null
        ? []
        : [
            {
              ...inlineLabel('payment.copy_card'),
              copyText: destination.cardNumber,
              row: 0,
            },
            {
              ...inlineLabel('payment.copy_amount'),
              copyText: plainAmount(payment.amount),
              row: 0,
            },
          ];

    return {
      key:
        destination === null
          ? 'bot.payment.manual_instructions'
          : 'bot.payment.transfer_instructions',
      values: {
        total: payment.amount,
        reference: payment.reference,
        /*
         * Composed behind the application layer, by the renderer this surface is
         * handed. A surface may not resolve the catalogue — `check-boundaries.sh`
         * refuses an `@nexa/i18n` import here — and the four destination lines are
         * catalogue text like any other.
         */
        ...(destination === null
          ? {}
          : { destination: await this.deps.destinations.render(scope, destination) }),
      },
      /*
       * The way out, beside the instructions that created the obligation.
       *
       * It names the PAYMENT rather than the order, which is the only id here that
       * identifies what a withdrawal would close: an order can have had several
       * payments over its life, and this message is about one of them.
       *
       * It carries the ASK prefix. Tapping it closes nothing — it answers with a
       * question and one further button — because this message stays in the chat for
       * ever and a customer who has already transferred the money is one mis-touch
       * away from closing the payment it was against.
       */
      buttons: [
        ...copies,
        /*
         * The step the instructions now tell them to take.
         *
         * The Persian used to end «سپس رسید را ارسال نمایید» — send the receipt — and
         * no surface in this product accepts one (owner revision 17). So a customer
         * who had transferred the money had nothing to do and nothing to say, and
         * `bot.payment.received_for_review` was a frozen sentence with no producer.
         *
         * The owner's 5A addendum reverses that revision and asks for this label to
         * become «✅ پرداخت را انجام دادم | ارسال رسید», which is what 5R made it: one
         * button whose tap records the claim AND opens the upload window. The label is
         * a template key, so the catalogue carries the wording and this carries the
         * intent.
         *
         * First among the actions, before the withdrawal: it is what most customers
         * who come back to this message want, and the destructive one should not be
         * the nearest thumb.
         */
        {
          ...inlineLabel('payment.sent'),
          data: `${PAY_SENT_CALLBACK_PREFIX}${payment.id}`,
        },
        {
          ...inlineLabel('payment.cancel'),
          data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId,
      // R2: the invoice screen of the order's (or the top-up's) wizard.
      wizard: {
        kind: orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: payment.id,
        ...(orderId === null ? {} : { subjectId: orderId }),
      },
    };
  }

  /**
   * Withdrawing a pending transfer the customer decided not to make.
   *
   * The button that reaches this is attached to `bot.payment.manual_instructions` — the
   * message that gave them the reference — so it sits beside the thing it undoes. That
   * message lives in the chat for ever, which is exactly why the service re-reads the
   * state rather than trusting the tap: a customer scrolling back to it a week later
   * gets `bot.payment.not_pending`, not a second withdrawal of something already closed.
   *
   * The reply does NOT say the order is gone, because it is not: a withdrawal closes the
   * payment and leaves the order open until its own deadline, so the customer may pay
   * from their wallet instead. `bot.payment.cancelled` says so.
   */
  /**
   * The question between the cancel button and the withdrawal.
   *
   * It writes nothing and closes nothing. Its only job is to say what is about to
   * happen and offer the ONE button that carries the destructive prefix —
   * `serviceRotateAsk` is the same shape one aggregate over.
   *
   * The payment is re-read here rather than trusted from whichever message was tapped:
   * a customer whose payment an operator has since rejected, or the sweep has expired,
   * is told it is no longer pending instead of being shown a question whose answer
   * would be refused.
   */
  private async cancelPaymentAsk(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const payment = await this.deps.payments.pendingTransferForCustomer(
      scope,
      customer.id,
      paymentId,
    );
    if (payment === null) {
      return { key: 'bot.payment.not_pending', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.payment.cancel_confirm',
      values: {},
      buttons: [
        {
          ...inlineLabel('payment.cancel_confirm'),
          data: `${CANCEL_PAY_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId: null,
    };
  }

  private async cancelPayment(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.payments.withdrawPending(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:cancel-pay`,
        paymentId,
      });
      return { key: 'bot.payment.cancelled', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return withdrawalRefusal(error);
    }
  }

  /**
   * The customer saying they have sent the transfer, AND asking to send its receipt.
   *
   * ONE tap for both, which is what the Payment UX addendum fixes: the button reads
   * «✅ پرداخت را انجام دادم | ارسال رسید» and `signalTransferSent` stamps the claim
   * and opens the upload window in the same transaction. Two buttons would be two ways
   * to reach one action, and a customer who pressed only the first would have a window
   * open with no idea it was there.
   *
   * It still moves no money and no state. `bot.payment.receipt_prompt` says exactly
   * what is true — the claim is recorded, nothing has been received or verified, and
   * the file may be sent now — and the caution `bot.payment.received_for_review`
   * carries applies to it word for word.
   *
   * Two replies, because `receiptWindow` is genuinely null in two cases: a redelivered
   * tap whose window has since closed, and a payment already past its own deadline,
   * where asking for evidence nobody can act on would be the wrong thing to do. Those
   * get the older sentence, which is true without promising an upload.
   *
   * No button on either. The instructions message above still carries both, which is
   * where a customer who wants to withdraw after all will look — and re-offering "I
   * have sent it" under a message saying it is recorded invites a second tap.
   */
  private async signalTransferSent(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const { payment, receiptWindow } = await this.deps.payments.signalTransferSent(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:pay-sent`, paymentId, botInstanceId },
      );
      /*
       * Owner spec §2.4: the tap EDITS the invoice it was on (its claim, `PAY_SENT`'s gate).
       * The card details and the copy buttons go with the old screen; the wizard keeps its
       * kind and its order, and names the payment so the receipt can find this message.
       */
      const screen = (step: 'RECEIPT_WAIT' | 'RECEIPT_REVIEW'): WizardDirective => ({
        kind: payment.orderId === null ? 'TOPUP' : 'ORDER',
        step,
        paymentId: payment.id,
        ...(payment.orderId === null ? {} : { subjectId: payment.orderId }),
      });
      if (receiptWindow === null) {
        return {
          key: 'bot.payment.received_for_review',
          values: {},
          // Nothing more to do on this message: no button, as the receipt's final state.
          buttons: [],
          orderId: null,
          fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
          wizard: screen('RECEIPT_REVIEW'),
        };
      }
      return {
        key: 'bot.payment.receipt_prompt',
        /*
         * A NUMBER, not a string. `minutes` is declared `type: 'NUMBER'`, and the
         * resolver VALIDATES values against the declaration — a string refused the
         * whole render, which the webhook then swallowed: the claim committed and the
         * customer was told nothing at all after tapping the button.
         */
        values: { minutes: receiptWindow.minutes },
        /*
         * Owner spec §2.4, state 2: the receipt is asked for, with no card details and no
         * copy buttons. The withdrawal stays — the invoice it replaced offered it, and a
         * customer who did not pay after all must still be able to close the payment.
         */
        buttons: [
          {
            ...inlineLabel('payment.cancel'),
            data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
          },
        ],
        orderId: null,
        wizard: { ...screen('RECEIPT_WAIT'), receiptPrompt: { customerId: customer.id } },
        /*
         * The fallback is the CLAIM, not the prompt.
         *
         * `PAYMENT_TRANSFER_RECORDED` is what the notification lane can say, and it is
         * the half that matters when the interactive reply could not be delivered: a
         * customer who does not learn their claim is on record sends the money again.
         * Asking for a receipt through a lane whose messages arrive minutes later
         * would ask for one after the window it names had closed.
         */
        fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * A file the customer sent while a window was open for them.
   *
   * What it attaches to is decided by the WINDOW, never by anything in the update: the
   * row names one payment, and `ReceiptService` re-reads that payment's state and owner
   * inside the transaction that files the row. So a client that invents a file reaches a
   * payment only if a window for that customer on that bot is genuinely open, and a
   * customer who sends a screenshot at random is told nothing was expected.
   *
   * `filed === false` gets the SAME reply as a new row. That is Telegram redelivering an
   * update whose file is already on the payment; the customer's situation is identical
   * either way, and a different sentence for a retry they cannot see would be a
   * difference they cannot act on.
   *
   * No fallback. The notification lane's kinds are a closed set with no payload, and
   * there is no frozen kind that means "your receipt arrived" — inventing one to cover
   * a failed interactive send is what ADR-0030 §1 refuses. A customer whose reply was
   * lost sees their receipt on the invoice thread and may tap the button again.
   */
  private async submitReceipt(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    file: InboundReceiptFile,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const submitted = await this.deps.receipts.submit(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:receipt`,
        botInstanceId,
        file,
      });
      /*
       * No poke from here (WP10 follow-up §3). Filing the receipt wrote a
       * `PaymentReceiptSubmitted` event in the same transaction, and the administrators'
       * push is that event's consumer and its own lane — durable with the receipt, never
       * able to cost the customer this answer, and not lost by a crash after the commit.
       */
      return {
        key: 'bot.payment.receipt_received',
        values: {},
        /*
         * Owner spec §2.4, state 3: the ORIGINAL payment message is edited once more into
         * the final sentence, with NO button — no status check, no resend, no cancel, no
         * copy, no card details. Anchored on the chat's invoice of THIS payment waiting at
         * the receipt prompt (or already final, for a further receipt of the same payment),
         * either kind. With no such message — an invoice from before this release, or one
         * Telegram will not edit — the same sentence goes out as its own message, as before.
         */
        buttons: [],
        orderId: null,
        wizard: {
          kind: 'ORDER',
          step: 'RECEIPT_REVIEW',
          paymentId: submitted.paymentId,
          anchor: {
            steps: ['RECEIPT_WAIT', 'RECEIPT_REVIEW'],
            paymentId: submitted.paymentId,
            anyKind: true,
          },
        },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The question between the cancel-order button and the cancellation.
   *
   * `cancelPaymentAsk` one aggregate over is the same shape and states the reasons: it
   * writes nothing, it offers the ONE button carrying the destructive prefix, and it
   * re-reads rather than trusting whichever message was tapped.
   *
   * The re-read goes through `awaitingPaymentForCustomer`, NOT `orders.get`. That one
   * is the operator's read and checks `orders.view`, which this turn does not hold —
   * a job actor holds `maintenance.run` and nothing else (see the job permission list
   * in `packages/contracts/src/permissions.ts`, named there rather than here because
   * `check:boundaries` refuses a surface that so much as mentions it) — so the first
   * version of this method refused every customer who tapped the button. Nothing
   * asserting only that the BUTTON was drawn would have noticed.
   *
   * Ownership and state are both compared against the ROW, so a customer holding
   * somebody else's order id is answered exactly as one holding an id that does not
   * exist. The cancellation re-checks both inside its own transaction; this check is
   * about not drawing a question, not about authorization.
   */
  private async cancelOrderAsk(
    scope: TenantContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.awaitingPaymentForCustomer(scope, customer.id, orderId);
      if (order === null) {
        return { key: 'bot.order.not_awaiting_payment', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.order.cancel_confirm',
        values: {},
        buttons: [
          {
            ...inlineLabel('order.cancel_confirm'),
            data: `${CANCEL_ORDER_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer withdrawing their own unpaid order.
   *
   * `ORDER_MACHINE`'s `CANCEL` edge reaching a surface at last —
   * `docs/phase4h-audit.md` §3 measured that 4G made it writable and left it with no
   * caller, and `bot.order.cancelled` a frozen sentence with nowhere to be sent from.
   *
   * The reply says the ORDER is gone and says nothing about a payment, although the
   * service withdrew any pending transfer in the same transaction. That is not an
   * omission: a customer who reaches this has been told about the order, which is the
   * thing they acted on, and a second sentence about a reference they were about to
   * stop using is noise. The refusal when they HAVE claimed to pay is the case where
   * the payment matters, and it has its own key.
   */
  private async cancelOrder(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.cancelByCustomer(scope, actor, {
        idempotencyKey: `${idempotencyKey}:cancel-order`,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.order.cancelled',
        values: {},
        buttons: [],
        orderId: null,
        // The order is gone. A customer who does not learn that keeps waiting for
        // a service that will never be made.
        fallback: { kind: 'ORDER_CANCELLED', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Best effort, after the answer, and never allowed to fail the turn. */
  /** R2: the tapped message, by its identity. */
  private refOf(
    botInstanceId: BotInstanceId,
    origin: CallbackOrigin,
  ): { botInstanceId: BotInstanceId; chatId: string; messageId: number } {
    return { botInstanceId, chatId: origin.chatId, messageId: origin.messageId };
  }

  /**
   * R2 (item 5): shows a wizard step by EDITING the wizard's message.
   *
   * The message is the tapped one (`claim`), or — for a typed answer — the chat's latest
   * wizard waiting at the step that asked for it (`reply.wizard.anchor`), in which case the
   * customer's own typed message is deleted once the wizard shows the next step, so the
   * wizard stays the last thing in the chat.
   *
   * Null hands the reply back to the ordinary send: nothing was waiting for a typed answer,
   * or the reply must be its own message (`placement: 'NEW'`, a main-menu keyboard, a file).
   *
   * The landing is written BEFORE the edit, so a tap on the new keyboard finds the new
   * screen. When Telegram refuses the edit outright (a message it will not edit any more),
   * the smallest fallback is taken: the same screen as a NEW message, and the wizard moves
   * onto it. A landing overtaken by the gateway worker — which has the fresher invoice —
   * answers nothing: the worker's edit is the one the message keeps.
   */
  private async editWizard(
    scope: TenantContext,
    actor: ActorContext,
    reply: PendingReply,
    claim: TelegramWizardRecord | null,
    origin: CallbackOrigin | null,
    chatId: string,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly idempotencyKey: string;
    },
  ): Promise<CustomerSendOutcome | 'NOT_ATTEMPTED' | null> {
    const state = this.deps.messageState;
    if (state === undefined || reply.key === null) return null;
    const directive = reply.wizard;
    let target = claim;
    let typed = false;
    if (target === null) {
      if (directive?.anchor === undefined) return null;
      target = await state.claimLatest(scope, actor, {
        botInstanceId: input.botInstanceId,
        chatId,
        kind: directive.anchor.anyKind === true ? null : directive.kind,
        steps: directive.anchor.steps,
        subjectId: directive.anchor.subjectId ?? null,
        paymentId: directive.anchor.paymentId ?? null,
        updateKey: input.idempotencyKey,
      });
      if (target === null) return null;
      typed = true;
    }
    /*
     * Its own message after all: a reply the handler marked so; one that needs the reply
     * keyboard, a file or a lead (Telegram edits none of them into a text message); and a
     * bare refusal no handler drew for the wizard — a product withdrawn, a code refused —
     * which must not replace the screen the customer can still choose from with a dead end.
     */
    if (
      directive?.placement === 'NEW' ||
      (directive === undefined && reply.buttons.length === 0) ||
      reply.keyboard !== undefined ||
      reply.media !== undefined ||
      reply.lead !== undefined
    ) {
      await state.release(scope, actor, target);
      return null;
    }
    const loading = directive?.invoicePending === true && directive.paymentId != null;
    const prompt =
      directive?.receiptPrompt !== undefined && directive.paymentId != null
        ? { customerId: directive.receiptPrompt.customerId, paymentId: directive.paymentId }
        : null;
    const landed = await state.land(scope, actor, target, {
      kind:
        directive === undefined || directive.anchor?.anyKind === true
          ? target.kind
          : directive.kind,
      step: directive?.step ?? 'NOTICE',
      subjectId: directive?.subjectId !== undefined ? directive.subjectId : target.subjectId,
      paymentId: directive?.paymentId !== undefined ? directive.paymentId : target.paymentId,
      updateKey: input.idempotencyKey,
      // The loading screen is landed at INVOICE_LOADING and HELD until it is marked below; the
      // receipt prompt is held until it is on the message (Codex 4170910529).
      ...(loading || prompt !== null ? { hold: true } : {}),
    });
    if (!landed) return 'NOT_ATTEMPTED';
    let edited = await editSent(
      this.deps.messenger,
      scope,
      {
        chatId: target.chatId,
        messageId: target.messageId,
        botInstanceId: target.botInstanceId,
        templateKey: reply.key,
        values: reply.values,
        buttons: reply.buttons,
      },
      !typed && origin !== null && origin.media,
    );
    if (edited.outcome === 'REFUSED') {
      edited = await this.deps.messenger.send(scope, {
        chatId: target.chatId,
        templateKey: reply.key,
        values: reply.values,
        botInstanceId: target.botInstanceId,
        ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
      });
      if (edited.outcome === 'DELIVERED' && edited.messageId !== undefined) {
        await state.move(scope, actor, target.id, edited.messageId);
      }
    }
    if (typed && edited.outcome === 'DELIVERED') {
      const own = typedMessageOf(input.update);
      if (own !== null && this.deps.messenger.remove !== undefined) {
        await this.deps.messenger.remove(scope, {
          chatId: own.chatId,
          messageId: own.messageId,
          botInstanceId: input.botInstanceId,
        });
      }
    }
    /*
     * R2 (item 4): the invoice is still being created in the worker. The loading screen was
     * landed at `INVOICE_LOADING`, a step the worker never moves from — so an outcome the
     * worker committed while this turn was editing cannot be edited in and then buried under
     * the loading screen. Only NOW that the loading edit has been asked for is THIS wizard
     * marked `INVOICE_PENDING` (which clears the hold), and the attempt read again: whichever
     * of this turn and the worker moves the mark first edits the message into the invoice or
     * the attempt's end, so neither waits for a status-check tap.
     */
    if (prompt !== null) await this.settleReceiptPrompt(scope, actor, target, prompt);
    if (loading && directive.paymentId != null) {
      await state.moveAll(
        scope,
        actor,
        { paymentId: directive.paymentId, id: target.id },
        ['INVOICE_LOADING'],
        'INVOICE_PENDING',
      );
      await this.deps.invoiceScreens?.refresh(scope, directive.paymentId);
    }
    return edited.outcome;
  }

  /**
   * Owner spec §2.4 (Codex 4170910529): the receipt prompt is on the message. Release its
   * hold FIRST — from here a receipt's own turn can claim it and draw the final state — and
   * THEN ask whether a receipt was filed meanwhile; if so, move the prompt on to the final
   * state (one conditional move: a receipt turn that got there first leaves nothing to move)
   * and edit it, with no button. A receipt filed before the release found the message held
   * and went out as its own message; this is what still ends the invoice in its final state.
   */
  private async settleReceiptPrompt(
    scope: TenantContext,
    actor: ActorContext,
    target: TelegramWizardRecord,
    prompt: { readonly customerId: string; readonly paymentId: string },
  ): Promise<void> {
    const state = this.deps.messageState;
    if (state === undefined) return;
    const where = { paymentId: prompt.paymentId, id: target.id };
    await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_WAIT');
    const filed = await this.deps.receipts.filedForCustomer(
      scope,
      actor,
      prompt.customerId as UserId,
      prompt.paymentId as PaymentId,
    );
    if (!filed) return;
    const moved = await state.moveAll(scope, actor, where, ['RECEIPT_WAIT'], 'RECEIPT_REVIEW');
    for (const wizard of moved) {
      await editSent(
        this.deps.messenger,
        scope,
        {
          chatId: wizard.chatId,
          messageId: wizard.messageId,
          botInstanceId: wizard.botInstanceId,
          templateKey: 'bot.payment.receipt_received',
          values: {},
          buttons: [],
        },
        false,
      );
    }
  }

  /**
   * R2 (item 3): a receipt decision, shown where the question was.
   *
   * The tapped message is recorded (when the directive names its role) and then every
   * unfinalised message of the payment is stamped — only this chat's for a block, which
   * decides nothing about the payment. Exactly the messages THIS call stamped are edited: the
   * tapped one into this reply, every other receipt into the outcome's one line, every other
   * prompt loses its buttons. A tapped message another turn already stamped is answered and
   * nothing else — the repeated-tap rule, reached through a race instead of the gate.
   *
   * An edit Telegram definitely did not apply has its stamp cleared, so a later tap can
   * finish it. Null when no payment could be named: the reply goes out as before.
   */
  private async finaliseReview(
    scope: TenantContext,
    actor: ActorContext,
    reply: PendingReply,
    origin: CallbackOrigin,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<CustomerSendOutcome | 'NOT_ATTEMPTED' | null> {
    const state = this.deps.messageState;
    const directive = reply.review;
    if (state === undefined || directive?.outcome === undefined || reply.key === null) return null;
    const ref = this.refOf(botInstanceId, origin);
    const tapped = await state.findReview(scope, ref);
    const paymentId = directive.paymentId ?? tapped?.paymentId ?? null;
    if (paymentId === null) return null;
    if (tapped === null) {
      await state.recordReview(scope, actor, {
        ref,
        paymentId,
        role: directive.origin ?? 'PROMPT',
        hasMedia: origin.media,
      });
    }
    const outcome = directive.outcome;
    const stamped = await state.finaliseReviews(
      scope,
      actor,
      outcome === 'BLOCKED' ? { paymentId, chatId: origin.chatId } : { paymentId },
    );
    const same = (row: { botInstanceId: string; chatId: string; messageId: number }): boolean =>
      row.botInstanceId === ref.botInstanceId &&
      row.chatId === ref.chatId &&
      row.messageId === ref.messageId;
    const clearFailed = async (id: string, result: CustomerSendResult): Promise<void> => {
      if (result.outcome === 'REFUSED' || result.outcome === 'RATE_LIMITED') {
        await state.unfinaliseReview(scope, actor, id);
      }
    };
    /*
     * F1 (round N): a receipt becomes the COMPLETE final record — the outcome's label and the
     * facts the reviewer decided on — read once, after the decision committed. The wallet
     * lines go only on this reviewer's own chat: a copy pushed to another reviewer is read by
     * somebody whose permissions this turn does not know, so theirs carries every fact but
     * the balance. A record that cannot be read (no administrator behind the tap, a payment
     * gone) falls back to the outcome's one line, which is still true.
     */
    const records = new Map<boolean, { key: TemplateKey; values: TemplateValues }>();
    const recordFor = async (
      own: boolean,
    ): Promise<{ key: TemplateKey; values: TemplateValues }> => {
      const cached = records.get(own);
      if (cached !== undefined) return cached;
      const record = await this.finalReviewRecord(
        scope,
        actor,
        telegramUserId,
        paymentId,
        outcome,
        own,
      );
      records.set(own, record);
      return record;
    };
    let answer: CustomerSendOutcome | 'NOT_ATTEMPTED' = 'NOT_ATTEMPTED';
    for (const row of stamped) {
      const message = {
        chatId: row.chatId,
        messageId: row.messageId,
        botInstanceId: row.botInstanceId,
      };
      const ownChat = row.botInstanceId === ref.botInstanceId && row.chatId === ref.chatId;
      if (same(row)) {
        // A receipt becomes the final record; a prompt becomes this reply's sentence.
        const receipt = row.role === 'REVIEW';
        const record = receipt ? await recordFor(true) : null;
        const edited =
          record !== null
            ? await this.editReviewRecord(scope, message, record, origin.media)
            : await editSent(
                this.deps.messenger,
                scope,
                {
                  ...message,
                  templateKey: reply.key,
                  values: reply.values,
                  buttons: reply.buttons,
                },
                origin.media,
              );
        await clearFailed(row.id, edited);
        answer = edited.outcome;
        continue;
      }
      const record = row.role === 'REVIEW' ? await recordFor(ownChat) : null;
      const other =
        record !== null
          ? await this.editReviewRecord(scope, message, record, row.hasMedia)
          : this.deps.messenger.clearButtons === undefined
            ? ({ outcome: 'REFUSED' } as const)
            : await this.deps.messenger.clearButtons(scope, message);
      await clearFailed(row.id, other);
    }
    return answer;
  }

  /**
   * F1 (round N, Codex review of #113): ONE review message edited into its final record, and
   * never into a record that silently lost its end.
   *
   * The record is edited in place, WHOLE (`whole`): the normal case, and still no new
   * message. A receipt FILE is edited through its caption, which Telegram bounds at 1,024
   * characters, and a tenant's override of the record or of its labels can pass that (a text
   * message, at 4,096). Cut, the tracking code and the wallet lines at the end would be gone
   * while the review reads as final. So a record that does not fit is refused by the
   * messenger before any request, and the one documented fallback is the smallest arrangement
   * that loses nothing and stays attached to the receipt:
   *
   *   1. the message becomes `bot.admin.review_final_short` — the decision and the tracking
   *      code, and a sentence pointing at the reply (bounded; if a tenant's override of THAT
   *      is too long it is cut, and nothing is lost, because the record follows);
   *   2. the complete record is sent as a REPLY to that same message.
   *
   * The result is what the stamp logic reads: a refused or rate-limited step — Telegram
   * definitely did not apply it — unfinalises the message so a later tap finishes it; an
   * UNKNOWN step is left finalised, since it may have landed. This runs only for a message
   * `finaliseReviews` stamped in THIS call, and a finalised message is never stamped again,
   * so a repeated tap never sends the reply a second time.
   */
  private async editReviewRecord(
    scope: TenantContext,
    message: CustomerMessageRef,
    record: { readonly key: TemplateKey; readonly values: TemplateValues },
    media: boolean,
  ): Promise<CustomerSendResult> {
    const full = { ...message, templateKey: record.key, values: record.values, buttons: [] };
    if (record.key !== 'bot.admin.review_final') {
      return editSent(this.deps.messenger, scope, full, media);
    }
    const whole = await editSent(this.deps.messenger, scope, { ...full, whole: true }, media);
    if (
      whole.outcome !== 'REFUSED' ||
      (whole.reason !== 'CAPTION_OVER_BOUND' && whole.reason !== 'TEXT_OVER_BOUND')
    ) {
      return whole;
    }
    const short = await editSent(
      this.deps.messenger,
      scope,
      {
        ...message,
        templateKey: 'bot.admin.review_final_short',
        values: {
          outcome: record.values['outcome'] ?? '',
          reference: record.values['reference'] ?? '',
        },
        buttons: [],
      },
      media,
    );
    if (short.outcome !== 'DELIVERED') return short;
    const reply = await this.deps.messenger.send(scope, {
      chatId: message.chatId,
      botInstanceId: message.botInstanceId,
      templateKey: record.key,
      values: record.values,
      replyToMessageId: message.messageId,
    });
    return reply.outcome === 'DELIVERED' ? short : reply;
  }

  /**
   * F1 (round N): the final record a receipt review message becomes — `bot.admin.review_final`
   * with the facts the reviewer decided on, read as the administrator who tapped (the
   * receipts read charges `receipts.view`, and the wallet lines `users.view`). `GONE`, or a
   * record that cannot be read, is the outcome's own one line: still true, and never blank.
   */
  private async finalReviewRecord(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
    paymentId: string,
    outcome: TelegramReviewOutcome | 'GONE',
    wallet: boolean,
  ): Promise<{ key: TemplateKey; values: TemplateValues }> {
    const line = { key: REVIEW_OUTCOME_KEYS[outcome], values: {} };
    if (outcome === 'GONE') return line;
    try {
      const reviewer = await this.reviewerActor(scope, actor, telegramUserId);
      if (reviewer === null) return line;
      const values = await this.deps.receipts.finalRecord(
        scope,
        reviewer,
        paymentId as PaymentId,
        outcome,
        REVIEW_OUTCOME_KEYS[outcome],
        wallet,
      );
      return values === null ? line : { key: 'bot.admin.review_final', values };
    } catch {
      // A refused read decides nothing; the one line still says what was decided.
      return line;
    }
  }

  /** The administrator behind a review tap, or null when there is none. */
  private async reviewerActor(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
  ): Promise<ActorContext | null> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return null;
    const identity = await admins.resolve(scope, telegramUserId, actor.correlationId);
    return identity === null ? null : identity.actor;
  }

  /**
   * F1 (round N): what a tap on a review message ALREADY finalised is answered with — the
   * callback's own notice, and nothing else. The payment's recorded disposition decides the
   * sentence; a payment still pending whose message was finalised was finalised by a BLOCK
   * (the one decision that leaves it in the queue). Nothing is decided, credited, sent or
   * edited here. A read that cannot be made answers without a notice, as before.
   */
  private async repeatedReviewToast(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
    paymentId: string,
  ): Promise<Pick<PendingReply, 'toast'>> {
    const toast = (key: TemplateKey): Pick<PendingReply, 'toast'> => ({
      toast: { key, values: {} },
    });
    try {
      const reviewer = await this.reviewerActor(scope, actor, telegramUserId);
      if (reviewer === null) return {};
      const found = await this.deps.receipts.dispositionOf(scope, reviewer, paymentId as PaymentId);
      if (found !== null) {
        switch (found.disposition) {
          case 'APPROVED':
            return toast('bot.admin.review_repeat_approved');
          case 'REJECTED':
            return toast('bot.admin.review_repeat_rejected');
          case 'CREDITED_TO_WALLET':
            return toast('bot.admin.review_repeat_credited');
        }
      }
      const pending = await this.deps.receipts.reviewItem(scope, reviewer, paymentId as PaymentId);
      return toast(
        pending === null ? 'bot.admin.review_repeat_gone' : 'bot.admin.review_repeat_blocked',
      );
    } catch {
      return {};
    }
  }

  private async stopSpinner(
    scope: TenantContext,
    command: BotCommand,
    botInstanceId: BotInstanceId,
    toast?: PendingReply['toast'],
  ): Promise<void> {
    if (command.callbackQueryId === null) return;
    await this.deps.messenger.acknowledge(scope, {
      callbackQueryId: command.callbackQueryId,
      botInstanceId,
      ...(toast === undefined ? {} : { toast: { templateKey: toast.key, values: toast.values } }),
    });
  }

  /**
   * R3: edits the tapped message into this reply; when Telegram cannot edit it (deleted,
   * too old, a photo with no text to edit), sends the same reply once as a new message.
   * `UNKNOWN` and `RATE_LIMITED` are not followed by a send: the edit may have landed, or
   * a send would meet the same refusal.
   */
  private async editOrSend(
    scope: TenantContext,
    target: CardMessageRef,
    reply: PendingReply,
    asText: () => Promise<CustomerSendResult>,
  ): Promise<CustomerSendResult> {
    const edit = this.deps.messenger.edit;
    if (edit === undefined || reply.key === null) return asText();
    const edited = await edit.call(this.deps.messenger, scope, {
      chatId: target.chatId,
      messageId: target.messageId,
      botInstanceId: target.botInstanceId,
      templateKey: reply.key,
      values: reply.values,
      buttons: reply.buttons,
    });
    return edited.outcome === 'REFUSED' ? asText() : edited;
  }
}

/**
 * What follows `bot.order.settled`, if anything.
 *
 * A pure function of the ORDER PURPOSE, exported for the same reason `replyFor` is:
 * the decision is testable without a database or a Telegram server, and a rule that
 * can only be reached through a webhook is a rule the suite cannot distinguish from
 * its absence. It could be: no test in this repository settles a RENEW over Telegram,
 * so an unconditional follow-up stayed green until this function existed.
 *
 * `NEW_SERVICE` is the only purpose that PROVISIONS. `orderPurposeTargetsExistingService` states
 * the same rule from the other side and `COMMERCIAL_ORDER_PURPOSES` derives itself by
 * exclusion, so a purpose added without thought lands on the safe side — as one that
 * does not provision. A renewal settles and CHANGES a service that already exists;
 * telling that customer their service is being created describes something that is not
 * happening, and they would then wait for a link that is never coming because they
 * already have it.
 *
 * The three commercial purposes are not silent either: they answer with
 * `bot.service.action_requested` through their own path, and 4H's outcome announcer
 * tells them how it turned out.
 */
export function followUpForSettlement(purpose: OrderPurpose): {
  readonly followUpKey?: TemplateKey;
} {
  return purpose === 'NEW_SERVICE' || purpose === 'CUSTOM_SERVICE'
    ? { followUpKey: 'bot.service.provisioning' }
    : {};
}

/**
 * Which template answers this turn.
 *
 * A pure function of the intent and the arrival, so the decision is testable without a
 * database or a Telegram server — and so the blocked case cannot be forgotten by one
 * branch. BLOCKED wins over everything: a blocked customer gets the block message
 * whatever they asked for, because every other answer is a service they are not
 * entitled to.
 *
 * `UNSUPPORTED` for an ACTIVE customer gets the existing `bot.unknown_command`, which
 * Phase 1 already declared — a new key for the same sentence would be a second string to
 * keep in step.
 */
export function replyFor(intent: BotIntent, arrival: CustomerArrival): TemplateKey | null {
  if (arrival === 'BLOCKED') return 'bot.blocked';
  if (intent === 'START') {
    return arrival === 'FIRST_SEEN' ? 'bot.start.welcome' : 'bot.start.welcome_back';
  }
  if (intent === 'HELP') return 'bot.help';
  return 'bot.unknown_command';
}

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };

/**
 * The payment methods this installation can actually perform RIGHT NOW, as buttons.
 *
 * `WALLET` always, `MANUAL_TRANSFER` only when the tenant has an enabled destination. A
 * gateway button is NOT drawn, and that is the rule `provider.ts` records applied to
 * money: Marzban's descriptor advertising fourteen operations no code could perform was
 * rejected, because what a product publishes is how it tells a user what it can do.
 *
 * Each button carries the ORDER ID and nothing else. There is no amount in a callback
 * and no place to put one.
 */
/**
 * The pre-invoice's buttons (§D), in the approved order: wallet; «🧾 ثبت پرداخت», which
 * opens the selector of every route offered for the order (card-to-card and each external
 * route live THERE, not here); the discount code on a new order still in DRAFT; back to
 * the main menu. A cancel is not here: a DRAFT expires on its own, and the cancel button
 * lives on the awaiting-payment message.
 */
/** One route in a payment-method selector: the route's customer-facing name, and its tap. */
function routeButton(name: string, data: string): CustomerButton {
  return {
    ...inlineLabel('payment.route', { name }),
    data,
  };
}

/**
 * «🧾 ثبت پرداخت»: opens the order's payment-method selector (`pm:`). It is the generic
 * entry to every route, never card-to-card itself; drawn only when at least one route is
 * offered for the order, because a selector with nothing in it is a button with no outcome.
 */
function payMethodsButton(orderId: string): CustomerButton {
  return {
    ...inlineLabel('payment.methods'),
    data: `${PAY_METHODS_CALLBACK_PREFIX}${orderId}`,
  };
}

/**
 * The Stars summary for one attempt, from its snapshot: principal, fee and payable in the
 * sales currency, and the Stars the invoice asks for. With no fee the payable is all three.
 */
function starsInvoiceBody(
  payment: PaymentRecord,
  stars: bigint,
): Pick<PendingReply, 'key' | 'values'> {
  const fee = payment.customerFee;
  const expiresAt = payment.expiresAt ?? new Date(0);
  if (fee !== null && fee.fee.amountMinor > 0n) {
    return {
      key:
        payment.orderId === null
          ? 'bot.payment.stars_invoice_topup_fee'
          : 'bot.payment.stars_invoice_order_fee',
      values: { principal: payment.amount, fee: fee.fee, payable: fee.payable, stars, expiresAt },
    };
  }
  return {
    key:
      payment.orderId === null
        ? 'bot.payment.stars_invoice_topup'
        : 'bot.payment.stars_invoice_order',
    values: { payable: fee?.payable ?? payment.amount, stars, expiresAt },
  };
}

function preinvoiceButtons(order: OrderRecord, routesOffered: boolean): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('payment.wallet'),
      data: `${WALLET_PAY_CALLBACK_PREFIX}${order.id}`,
    },
    ...(routesOffered ? [payMethodsButton(order.id)] : []),
    ...(order.state === 'DRAFT' &&
    (order.purpose === 'NEW_SERVICE' || order.purpose === 'CUSTOM_SERVICE')
      ? [
          order.discountCode === null
            ? {
                ...inlineLabel('discount.enter'),
                data: `${DISCOUNT_CODE_ENTER_CALLBACK_PREFIX}${order.id}`,
              }
            : {
                ...inlineLabel('discount.remove'),
                data: `${DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX}${order.id}`,
              },
        ]
      : []),
    mainMenuButton(),
  ];
}

/** WP-A7: back to the customer's ticket list. */
function ticketsButton(): CustomerButton {
  return {
    ...inlineLabel('tickets.back'),
    data: TICKETS_CALLBACK_DATA,
  };
}

/** WP-A7: the support screen's (and /paysupport's) way into the ticket desk. */
function ticketDeskButton(): CustomerButton {
  return {
    ...inlineLabel('support.tickets'),
    data: TICKETS_CALLBACK_DATA,
  };
}

/** WP-A7: start a new ticket. */
function newTicketButton(): CustomerButton {
  return {
    ...inlineLabel('tickets.new'),
    data: TICKET_NEW_CALLBACK_DATA,
  };
}

/** WP-A7: open one ticket's conversation. */
function ticketViewButton(ticketId: string): CustomerButton {
  return {
    ...inlineLabel('tickets.view'),
    data: `${TICKET_VIEW_CALLBACK_PREFIX}${ticketId}`,
  };
}

/** WP-A7: a ticket that is not the customer's own, or does not exist — one answer. */
function ticketNotFound(): PendingReply {
  return { key: 'bot.ticket.not_found', values: {}, buttons: [ticketsButton()], orderId: null };
}

/** WP-A7: a closed ticket refuses a reply and a close; a new ticket is the way on. */
function ticketAlreadyClosed(): PendingReply {
  return {
    key: 'bot.ticket.already_closed',
    values: {},
    buttons: [newTicketButton(), ticketsButton()],
    orderId: null,
  };
}

/**
 * «🔎 بررسی وضعیت» on a TonPays Telegram screen: the same `gc:` tap, its own label.
 */
function cardCheck(paymentId: string): CustomerButton {
  return {
    ...inlineLabel('payment.gateway_card_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${paymentId}`,
  };
}

/**
 * A created TonPays Telegram attempt in its customer window (`docs/tonpays-telegram-gateway-
 * audit.md` §8.1): the payable from the payment's own snapshot, TonPays' transfer figure when
 * it differs (labelled as TonPays', never what Nexa settles), the CURRENT card, the deadline,
 * and the three actions — each drawn only while the rule behind it allows it, and each
 * re-decided against the rows when tapped. Never says paid.
 */
function cardTransferScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts | null,
): PendingReply {
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  if (invoice.creationErrorCode !== null) {
    // Created without a card: it cannot be paid from here, and a new attempt is the way on.
    return {
      key: 'bot.payment.gateway_card_missing',
      values: {},
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard: { kind, step: 'NOTICE', paymentId: payment.id },
    };
  }
  const expiresAt = payment.expiresAt ?? new Date(0);
  const fee = payment.customerFee;
  const payable = fee?.payable ?? payment.amount;
  const submissions = facts?.submissions ?? [];
  const latest = facts?.latestChange ?? null;
  const windowOpen =
    payment.state === 'PENDING' &&
    (payment.providerReviewUntil ?? null) === null &&
    payment.expiresAt !== null &&
    at.getTime() < payment.expiresAt.getTime();
  const receipt: CustomerButton = {
    ...inlineLabel('payment.gateway_receipt'),
    data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
  };
  const change: CustomerButton = {
    ...inlineLabel('payment.gateway_change_card'),
    data: `${GATEWAY_CARD_CHANGE_CALLBACK_PREFIX}${payment.id}`,
  };
  const actions = [
    ...(facts !== null && windowOpen && receiptUploadAvailable(invoice, submissions)
      ? [receipt]
      : []),
    ...(facts !== null && windowOpen && cardChangeAvailable(invoice, latest, at) ? [change] : []),
    cardCheck(payment.id),
    mainMenuButton(),
  ];
  const brief = { payable, expiresAt };
  const newest = submissions.at(-1) ?? null;
  // A receipt on its way, accepted without a review, or whose answer was lost: shown as sent.
  if (
    newest !== null &&
    (newest.state === 'QUEUED' ||
      newest.state === 'SENDING' ||
      newest.state === 'ACCEPTED' ||
      (newest.state === 'UNKNOWN' && newest.inquiryResolvedAt === null))
  ) {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  // TonPays itself says the receipt is being checked (an inquiry, not an acknowledgement).
  if (invoice.providerStatus === 'processing') {
    return {
      key: 'bot.payment.gateway_card_receipt_sent',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  if (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) {
    return {
      key: 'bot.payment.gateway_card_changing',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  if (invoice.cardNumber === null) {
    // The last card change's answer was lost: no card is shown, never a stale one.
    return {
      key: 'bot.payment.gateway_card_unconfirmed',
      values: brief,
      buttons: actions,
      orderId,
      wizard,
    };
  }
  const card = {
    cardNumber: invoice.cardNumber,
    ...(invoice.cardName === null ? {} : { cardName: invoice.cardName }),
  };
  if (newest !== null && (newest.state === 'REFUSED' || newest.state === 'ABANDONED')) {
    return {
      key: 'bot.payment.gateway_card_receipt_refused',
      values: { ...brief, ...card },
      buttons: actions,
      orderId,
      wizard,
    };
  }
  return {
    key: 'bot.payment.gateway_card_invoice',
    values: {
      ...brief,
      ...card,
      ...(fee !== null && fee.fee.amountMinor > 0n
        ? { principal: payment.amount, fee: fee.fee }
        : {}),
      /*
       * TonPays' own `final_amount` (OQ-TPTG-03), shown only when present and different from
       * what Nexa asked for: the provider's transfer instruction, never what Nexa settles,
       * credits or refunds (§12).
       */
      ...(invoice.finalAmount !== null && invoice.finalAmount !== invoice.sentAmount
        ? { transferAmount: money(invoice.finalAmount, 'IRT') }
        : {}),
    },
    buttons: actions,
    orderId,
    wizard,
  };
}

/**
 * An external-gateway attempt, as the customer sees it (brief §11, §23) — and, since R2
 * (item 4), the SAME screen whether the turn draws it or the gateway worker edits the wizard
 * message into it once the invoice is ready (`WizardInvoiceScreens`). A pure function of the
 * attempt and the moment, so the two can never show different things for one attempt.
 *
 * Only a CONFIRMED payment is ever called paid, and a payment is CONFIRMED only by the
 * gateway's own inquiry through the one settlement path. The link is the invoice's web link
 * when the gateway returned one, else its Telegram link; nothing is fabricated.
 *
 * Every screen that ends the attempt without an invoice — refused, not approved, closed, or
 * a create whose answer was lost — says so truthfully and offers a way back to choosing how
 * to pay (the order's method selector, or the top-up's amount), never a retry of THIS
 * attempt: an attempt whose create is unknown is never created again (TonPays rule three).
 */
/**
 * The review-window and needs-review sentences per provider, for a route whose own words
 * differ from TonPays Telegram's receipt wording (NOWPayments: coins confirming on chain,
 * `docs/nowpayments-gateway-audit.md` §5.8). A provider absent here keeps the original keys.
 */
const PROVIDER_REVIEW_SCREEN_KEYS: Partial<
  Record<
    PaymentGatewayProvider,
    { readonly inReview: TemplateKey; readonly unresolved: TemplateKey }
  >
> = {
  NOWPAYMENTS: {
    inReview: 'bot.payment.nowpayments_in_review',
    unresolved: 'bot.payment.nowpayments_review_unresolved',
  },
  /*
   * CentralPay has no review window (`docs/centralpay-gateway-audit.md` §5.8): it reaches
   * UNKNOWN only when a verify did not match the payment, which its own sentence says.
   */
  CENTRALPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.centralpay_review_unresolved',
  },
};

/**
 * The label of the URL button that opens a provider's invoice page. NOWPayments carries the
 * owner's «💳 پرداخت با ارز دیجیتال» under its OWN key, isolated so the central inline-button
 * registry can take it over as `payment.nowpayments_open` without touching any other route;
 * CentralPay's «💳 پرداخت با CentralPay» is isolated the same way (`payment.centralpay_open`).
 */
const PROVIDER_PAY_BUTTON_KEYS: Partial<Record<PaymentGatewayProvider, InlineButtonKey>> = {
  NOWPAYMENTS: 'payment.nowpayments_open',
  CENTRALPAY: 'payment.centralpay_open',
};

export function gatewayAttemptScreen(
  attempt: GatewayAttempt | GatewayAttemptView,
  orderId: string | null,
  at: Date,
  /**
   * A card-transfer attempt's card-change and receipt facts (TonPays Telegram, §8.1); null
   * for every other route — and absent, the card screen offers neither the receipt nor the
   * card-change button, never a stale one.
   */
  cardFacts: GatewayCardFacts | null = null,
): PendingReply {
  const { payment, invoice } = attempt;
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const check: CustomerButton = {
    ...inlineLabel('payment.gateway_check'),
    data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${payment.id}`,
  };
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  const screen = (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending = false,
  ): PendingReply => ({
    key,
    values: {},
    buttons: [...buttons, mainMenuButton()],
    orderId,
    wizard: {
      kind,
      step,
      paymentId: payment.id,
      ...(pending ? { invoicePending: true } : {}),
    },
  });
  if (payment.state === 'CONFIRMED') return screen('bot.payment.gateway_confirmed', [], 'CLOSED');
  /*
   * TonPays Telegram, the owner's review window (§8.1, §9.6.6), decided BEFORE the "closed"
   * test below: a payment whose receipt the provider is reviewing is not closed, and one
   * whose review ended unresolved has neither failed nor closed. Neither invites a new
   * payment, a new receipt or a card change. Both stay `INVOICE` so the worker's edit of the
   * outcome (confirmed, failed) replaces them in place.
   */
  const reviewKeys = PROVIDER_REVIEW_SCREEN_KEYS[invoice.provider] ?? {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.gateway_review_unresolved',
  };
  if (payment.state === 'UNKNOWN') {
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  const reviewUntil = payment.providerReviewUntil ?? null;
  if (payment.state === 'PENDING' && reviewUntil !== null) {
    if (reviewUntil.getTime() > at.getTime()) {
      return {
        key: reviewKeys.inReview,
        values: {
          payable: payment.customerFee?.payable ?? payment.amount,
          reviewUntil,
        },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard: { kind, step: 'INVOICE', paymentId: payment.id },
      };
    }
    // Lapsed and not yet swept: the same truth the sweep is about to record.
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  if (payment.state === 'FAILED') {
    // A create the gateway refused is "unavailable"; an invoice it did not approve failed.
    return screen(
      invoice.creationState === 'CREATE_FAILED'
        ? 'bot.payment.gateway_unavailable'
        : 'bot.payment.gateway_failed',
      [retry],
      'NOTICE',
    );
  }
  if (
    payment.state !== 'PENDING' ||
    payment.expiresAt === null ||
    payment.expiresAt.getTime() <= at.getTime()
  ) {
    return screen('bot.payment.gateway_closed', [retry], 'NOTICE');
  }
  /*
   * Telegram Stars (Package A): the invoice is its own Telegram message, sent by this bot —
   * Telegram cannot turn a text message into an invoice, so it follows this one. The summary
   * shows the principal, the fee when there is one, the payable in the sales currency and the
   * Stars asked for — all from THIS attempt's snapshot — while the invoice is being sent and
   * once it has been.
   */
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceCredential === 'BOT_TOKEN' &&
    (invoice.creationState === 'CREATING' || invoice.creationState === 'CREATED')
  ) {
    return {
      ...starsInvoiceBody(payment, invoice.sentAmount),
      buttons: [check, mainMenuButton()],
      orderId,
      wizard: { kind, step: 'INVOICE', paymentId: payment.id },
    };
  }
  /*
   * The loading screen: the worker edits this very message into the invoice once it exists.
   * Landed at `INVOICE_LOADING` and marked `INVOICE_PENDING` by the turn once its edit has
   * been asked for (`editWizard`). It carries the check button, gated from both, so a
   * worker edit that did not land is one tap from the current attempt.
   */
  if (invoice.creationState === 'CREATING') {
    return screen('bot.payment.gateway_preparing', [check], 'INVOICE_LOADING', true);
  }
  /*
   * F3 (round N): each end says what actually happened, and each offers a way on that opens
   * a NEW attempt — none of these is an open attempt (`findOpenAttempt`), so the retry is
   * never handed this one back.
   *
   * - A create the gateway REFUSED is "unavailable" even while its payment is still PENDING
   *   (the failure's own write did not land): it was a refusal, never a lost answer.
   * - An invoice the gateway reported CREATED with no link a customer can open: its answer
   *   was received, so it is not "the answer was lost".
   * - Only a create whose answer really was lost (`CREATE_UNKNOWN`) is `gateway_unknown`.
   */
  if (invoice.creationState === 'CREATE_FAILED') {
    return screen('bot.payment.gateway_unavailable', [retry], 'NOTICE');
  }
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm === 'CARD_TRANSFER' &&
    invoice.creationState === 'CREATED'
  ) {
    return cardTransferScreen(payment, invoice, orderId, at, cardFacts);
  }
  const link = invoice.webInvoiceUrl ?? invoice.invoiceUrl;
  if (invoice.creationState === 'CREATED' && link === null) {
    return screen('bot.payment.gateway_no_link', [retry], 'NOTICE');
  }
  if (invoice.creationState !== 'CREATED' || link === null) {
    return screen('bot.payment.gateway_unknown', [retry], 'NOTICE');
  }
  /*
   * A route that charges a customer fee shows the three figures apart (WP18): the
   * principal — the order amount, or the top-up the wallet receives — the gateway fee, and
   * the payable the invoice asks for. From THIS attempt's snapshot, never the route's
   * current rate. With no fee the single amount is already all three.
   */
  const fee = payment.customerFee;
  const invoiceBody: Pick<PendingReply, 'key' | 'values'> =
    fee !== null && fee.fee.amountMinor > 0n
      ? {
          key:
            payment.orderId === null
              ? 'bot.payment.gateway_invoice_topup_fee'
              : 'bot.payment.gateway_invoice_order_fee',
          values: {
            principal: payment.amount,
            fee: fee.fee,
            payable: fee.payable,
            expiresAt: payment.expiresAt,
          },
        }
      : {
          key: 'bot.payment.gateway_invoice',
          values: { total: payment.amount, expiresAt: payment.expiresAt },
        };
  return {
    ...invoiceBody,
    buttons: [
      {
        ...inlineLabel(PROVIDER_PAY_BUTTON_KEYS[invoice.provider] ?? 'payment.gateway_pay'),
        url: link,
      },
      check,
      mainMenuButton(),
    ],
    orderId,
    wizard: { kind, step: 'INVOICE', paymentId: payment.id },
  };
}

/**
 * R2: a wallet refusal the customer acts on and comes back from — too little balance, a
 * transfer already under review — goes out as its OWN message, so the pre-invoice it answers
 * stays on screen and payable once they have topped up.
 */
const WALLET_SHORT: WizardDirective = { kind: 'ORDER', step: 'PREINVOICE', placement: 'NEW' };

/**
 * Whether this update is a tapped inline button (a `callback_query`), whatever its data.
 * Read through the passthrough fields, as `intentOf` does.
 */
export function isCallbackQueryUpdate(update: unknown): boolean {
  const callback = (update as { callback_query?: unknown } | null)?.callback_query;
  return typeof callback === 'object' && callback !== null;
}

/**
 * Item 12 (C4): the answer to a button whose data this installation does not recognise —
 * one sentence and the main menu. Nothing from the data reaches it: no placeholder, no
 * echo, so an old MirzaBot payload or a crafted one cannot shape the reply.
 */
export function staleCallbackReply(): PendingReply {
  return { key: 'bot.callback.stale', values: {}, buttons: [mainMenuButton()], orderId: null };
}

/** The one trial refusal, with the way back to the main menu. */
function trialUnavailable(): PendingReply {
  return { key: 'bot.trial.unavailable', values: {}, buttons: [mainMenuButton()], orderId: null };
}

function mainMenuButton(): CustomerButton {
  return {
    ...inlineLabel('main_menu'),
    data: MAIN_MENU_CALLBACK_DATA,
  };
}

/**
 * Round N close (§D): the opt-in button when the customer has opted out of promotions, the
 * opt-out button otherwise. One button, the reverse of the state, so the screen never shows
 * a choice that is already the case.
 */
/** Spec §9: the service's refusal while customers may not change their preference. */
function isMarketingOptOutDisabled(error: unknown): boolean {
  return isNexaError(error) && error.details['reason'] === MARKETING_OPT_OUT_DISABLED_REASON;
}

export function marketingPreferenceButton(optedOut: boolean): CustomerButton {
  return optedOut
    ? {
        ...inlineLabel('marketing.opt_in'),
        data: MARKETING_OPT_IN_CALLBACK_DATA,
      }
    : {
        ...inlineLabel('marketing.opt_out'),
        data: MARKETING_OPT_OUT_CALLBACK_DATA,
      };
}

function topupButton(): CustomerButton {
  return {
    ...inlineLabel('wallet.topup'),
    data: TOPUP_MENU_CALLBACK_PREFIX,
  };
}

function backToListButton(): CustomerButton {
  return {
    ...inlineLabel('service.back_to_list'),
    data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
  };
}

/** The answer to a refund request the service cannot take right now (WP19). */
function refundOfferReply(offer: 'PENDING' | 'UNAVAILABLE', serviceId: string): PendingReply {
  return {
    key:
      offer === 'PENDING'
        ? 'bot.service.refund_request_pending'
        : 'bot.service.refund_request_unavailable',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * The sentence for each recipient refusal (Package F). Unknown and blocked are ONE
 * sentence: telling them apart would tell a stranger which accounts an operator blocked.
 */
const TRANSFER_RECIPIENT_REPLIES: Readonly<Record<ServiceTransferRecipientRefusal, TemplateKey>> = {
  RECIPIENT_INVALID: 'bot.service.transfer_recipient_invalid',
  RECIPIENT_UNKNOWN: 'bot.service.transfer_recipient_unavailable',
  RECIPIENT_BLOCKED: 'bot.service.transfer_recipient_unavailable',
  RECIPIENT_SELF: 'bot.service.transfer_recipient_self',
};

/** One sentence for every reason a service cannot be transferred now, and the way back. */
function transferUnavailableReply(serviceId: string): PendingReply {
  return {
    key: 'bot.service.transfer_unavailable',
    values: {},
    buttons: [backToServiceButton(serviceId)],
    orderId: null,
  };
}

/**
 * The largest ownership version a `tc:` payload can carry: four base-36 digits. With the
 * 36-byte service id and a 19-digit recipient the payload is then at most 64 bytes,
 * Telegram's limit. A service that has changed hands more often than this is not offered
 * a confirmation at all (`transferConfirmData` returns null) rather than one Telegram
 * would refuse to draw.
 */
export const TRANSFER_CONFIRM_VERSION_MAX = 36 ** 4 - 1;

/**
 * `tc:<service uuid>.<recipient telegram id>.<ownership version, base 36>` — at most 64
 * bytes. Null past `TRANSFER_CONFIRM_VERSION_MAX`.
 */
export function transferConfirmData(
  serviceId: string,
  recipientTelegramUserId: string,
  ownershipVersion: number,
): string | null {
  if (
    !Number.isSafeInteger(ownershipVersion) ||
    ownershipVersion < 0 ||
    ownershipVersion > TRANSFER_CONFIRM_VERSION_MAX
  ) {
    return null;
  }
  return `${SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX}${serviceId}.${recipientTelegramUserId}.${ownershipVersion.toString(36)}`;
}

/**
 * A `tc:` payload's three parts, each validated here — the service as a UUIDv7, the
 * recipient by `telegramUserIdSchema`, the version as one to four lower-case base-36 digits
 * with no leading zero — or null. Anything else is UNSUPPORTED rather than a half-read that
 * could transfer a service nobody named, or at a version nobody saw.
 */
export function decodeTransferConfirm(data: string): {
  readonly serviceId: string;
  readonly recipientTelegramUserId: string;
  readonly ownershipVersion: number;
} | null {
  if (!data.startsWith(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX)) return null;
  const parts = data.slice(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  const service = uuidV7Schema.safeParse(parts[0]);
  const recipient = telegramUserIdSchema.safeParse(parts[1]);
  const version = parts[2] ?? '';
  if (!service.success || !recipient.success || !/^(0|[1-9a-z][0-9a-z]{0,3})$/.test(version)) {
    return null;
  }
  return {
    serviceId: service.data,
    recipientTelegramUserId: recipient.data,
    ownershipVersion: Number.parseInt(version, 36),
  };
}

/**
 * The inline buttons a customer NOTIFICATION carries, derived from its subject by kind
 * (Package F). Handed to the notification lane by the composition root, because the
 * callback vocabulary is this surface's: the lane stores no button and carries no payload.
 *
 * A transfer's and a renewal's open the service; support's reply opens the ticket; the
 * low-balance alert offers the top-up and a wallet credit the wallet and the catalogue
 * (owner spec §2) — those last are derived from the KIND alone. Every label and style is
 * the registry's (`inlineLabel`); a button key is not a payload.
 */
export function notificationButtons(
  kind: CustomerNotificationKind,
  subject: { readonly serviceId?: string; readonly ticketId?: string },
): readonly CustomerButton[] {
  // WP-A7: support's reply opens the ticket, or its reply window, for whoever taps it.
  if (kind === 'TICKET_REPLY' && subject.ticketId !== undefined) {
    return [
      {
        ...inlineLabel('tickets.reply'),
        data: `${TICKET_REPLY_CALLBACK_PREFIX}${subject.ticketId}`,
      },
      {
        ...inlineLabel('tickets.view'),
        data: `${TICKET_VIEW_CALLBACK_PREFIX}${subject.ticketId}`,
      },
    ];
  }
  /*
   * Owner spec §2.1: the low-balance alert's one action, the top-up — the wallet screen's
   * own «افزایش موجودی», so the flow it opens is the existing one, not a copy. No id: the
   * tap's customer is the subject, and the top-up re-decides what it may offer.
   */
  if (kind === 'WALLET_LOW_BALANCE') {
    return [{ ...inlineLabel('wallet.topup'), data: TOPUP_MENU_CALLBACK_PREFIX }];
  }
  /*
   * Owner spec §2.2: a credit to the wallet — a confirmed top-up, or a receipt a reviewer
   * credited — answers with the two useful next actions, side by side. Both open a NEW
   * message, so the credit stays in the chat as its record.
   */
  if (kind === 'WALLET_TOPUP_CREDITED' || kind === 'RECEIPT_CREDITED_TO_WALLET') {
    return [
      { ...inlineLabel('wallet.open'), data: WALLET_OPEN_CALLBACK_DATA, row: 0 },
      { ...inlineLabel('catalog.open'), data: CATALOG_OPEN_CALLBACK_DATA, row: 0 },
    ];
  }
  // R2 (item 11): the renewal result's one button opens the renewed service's card.
  if (kind === 'SERVICE_RENEWED' && subject.serviceId !== undefined) {
    return [
      {
        ...inlineLabel('service.renewed_details'),
        data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
      },
    ];
  }
  if (kind !== 'SERVICE_TRANSFER_RECEIVED' || subject.serviceId === undefined) return [];
  return [
    {
      ...inlineLabel('service.transfer_details'),
      data: `${SERVICE_CALLBACK_PREFIX}${subject.serviceId}`,
    },
  ];
}

/** R3: back to the service card, drawn IN PLACE (`sv:`). */
function backToCardButton(serviceId: string): CustomerButton {
  return {
    ...inlineLabel('service.back_to_card'),
    data: `${SERVICE_CARD_CALLBACK_PREFIX}${serviceId}`,
  };
}

/** R3: an answer that is only a notice on the tapped button; nothing is sent or edited. */
function toastReply(key: TemplateKey): PendingReply {
  return { key: null, values: {}, buttons: [], orderId: null, toast: { key, values: {} } };
}

/** An ordinary one-line reply with no buttons. */
function plainReply(key: TemplateKey): PendingReply {
  return { key, values: {}, buttons: [], orderId: null };
}

/**
 * R3: the service card a tap came from — the private chat, the message's own id, and the
 * bot that drew it — or null when the update carries no such message.
 */
export function cardMessageOf(
  update: unknown,
  botInstanceId: BotInstanceId,
): CardMessageRef | null {
  const chatId = privateChatIdOf(update);
  const messageId = (update as { callback_query?: { message?: { message_id?: unknown } } } | null)
    ?.callback_query?.message?.message_id;
  if (chatId === null || typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) {
    return null;
  }
  if (messageId <= 0) return null;
  return { botInstanceId, chatId, messageId };
}

/**
 * The way back from a screen about one service. Round N (F4): the service card drawn IN
 * PLACE (`sv:`) — every screen a card's button opens is the card's own message, so «back»
 * restores that same card rather than sending a second one. On a screen that is a message
 * of its own (the answer to a typed step), it turns that message into the card.
 */
function backToServiceButton(serviceId: string): CustomerButton {
  return backToCardButton(serviceId);
}

/**
 * Round N (F4): a screen a service card's button opened, edited INTO the card's message
 * (`PendingReply.edit`) — the renew menu, the add-traffic and extra-users offers, the
 * location move, the note, refund and transfer prompts and their answers. A screen that
 * would be left without a single button gets the way back to the card, so the card is
 * never lost in its own message.
 *
 * A WIZARD screen is left as its own message: a quote opens the payment wizard, whose
 * message identity and step gate are R2's (`telegram_wizards`), and a card message already
 * tracked there could not be given a fresh quote in place without rewinding that state.
 */
function inCard(serviceId: string, reply: PendingReply): PendingReply {
  if (reply.key === null || reply.wizard !== undefined) return reply;
  const lost = reply.buttons.length === 0 && reply.key !== 'bot.service.not_found';
  return { ...reply, ...(lost ? { buttons: [backToCardButton(serviceId)] } : {}), edit: true };
}

/**
 * The list's bottom controls (§G): the search pair, the pager, back to the menu. The
 * page indicator is a real button — a tap re-renders the page — and the arrows appear
 * only where there is a page to go to.
 */
function servicesListControls(page: number, pages: number): readonly CustomerButton[] {
  const controls: CustomerButton[] = [
    {
      ...inlineLabel('services.search_label'),
      data: SERVICES_SEARCH_CALLBACK_DATA,
      row: 100,
    },
    {
      ...inlineLabel('services.search'),
      data: SERVICES_SEARCH_CALLBACK_DATA,
      row: 100,
    },
  ];
  if (page > 1) {
    controls.push({
      ...inlineLabel('services.previous_page'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page - 1}`,
      row: 101,
    });
  }
  controls.push({
    ...inlineLabel('services.page', { page, pages }),
    data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page}`,
    row: 101,
  });
  if (page < pages) {
    controls.push({
      ...inlineLabel('services.next_page'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}${page + 1}`,
      row: 101,
    });
  }
  controls.push({
    ...inlineLabel('services.back_to_menu'),
    data: MAIN_MENU_CALLBACK_DATA,
    row: 102,
  });
  return controls;
}

/** The stored last-seen columns as the tri-state the composer renders. NULL is UNSUPPORTED. */
function lastSeenOf(service: ServiceRecord): ProviderLastSeen {
  if (service.lastSeenState === 'AT' && service.lastSeenAt !== null) {
    return { kind: 'AT', at: service.lastSeenAt };
  }
  if (service.lastSeenState === 'NEVER') return { kind: 'NEVER' };
  return { kind: 'UNSUPPORTED' };
}

/** First and last name, else the username, else the numeric id — never blank. */
function displayNameOf(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  if (name.length > 0) return name;
  if (customer.username !== null && customer.username.trim().length > 0) return customer.username;
  return customer.telegramUserId;
}

/** Each platform's button on the choice screen. `OTHER` has a button and no guide of its own. */
const PLATFORM_BUTTONS: Readonly<Record<ClientAppPlatform, InlineButtonKey>> = {
  ANDROID: 'apps.platform_android',
  IOS: 'apps.platform_ios',
  WINDOWS: 'apps.platform_windows',
  MACOS: 'apps.platform_macos',
  LINUX: 'apps.platform_linux',
  OTHER: 'apps.platform_other',
};

/** The guide a platform shows when no client app is configured for it — the pre-WP-A10 screen. */
const TUTORIAL_BODY_KEYS: Readonly<Record<ConnectionGuidePlatform, TemplateKey>> = {
  ANDROID: 'bot.tutorial.android',
  IOS: 'bot.tutorial.ios',
  WINDOWS: 'bot.tutorial.windows',
  MACOS: 'bot.tutorial.macos',
  LINUX: 'bot.tutorial.linux',
};

/**
 * The connection guide's first screen: the platform choice, two to a row. The platforms
 * are decided by the caller — the catalogue adds `OTHER` only when it holds something.
 */
export function tutorialChoice(platforms: readonly ClientAppPlatform[]): PendingReply {
  return {
    key: 'bot.tutorial.choose',
    values: {},
    buttons: [
      ...platforms.map((platform, index) => ({
        ...inlineLabel(PLATFORM_BUTTONS[platform]),
        data: `${TUTORIAL_PLATFORM_CALLBACK_PREFIX}${platform}`,
        row: Math.floor(index / 2),
      })),
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/**
 * One platform's screen (WP-A10).
 *
 * The apps are BUTTONS whose labels are the operator's own data, for the reason the
 * catalogue gives: a template is not a list renderer. With none to show, a platform that
 * has a guide of its own answers it with EXACTLY the pre-WP-A10 screen — same key, same two
 * buttons — so an installation that configures nothing sees no change at all; `OTHER`,
 * which has no guide, says there is nothing here yet.
 */
export function clientAppPlatformScreen(
  platform: ClientAppPlatform,
  apps: readonly { readonly id: string; readonly label: string }[],
): PendingReply {
  if (apps.length === 0) {
    if (platform === 'OTHER') {
      return {
        key: 'bot.apps.platform_empty',
        values: {},
        buttons: [platformsButton(), mainMenuButton()],
        orderId: null,
      };
    }
    return {
      key: TUTORIAL_BODY_KEYS[platform],
      values: {},
      buttons: [
        {
          ...inlineLabel('service.tutorial'),
          data: TUTORIAL_CALLBACK_DATA,
        },
        mainMenuButton(),
      ],
      orderId: null,
    };
  }
  return {
    key: 'bot.apps.platform',
    values: {},
    buttons: [
      ...apps.map((app) => ({
        ...inlineDataLabel('apps.app', { kind: 'TEXT', text: app.label }),
        data: `${CLIENT_APP_CALLBACK_PREFIX}${app.id}`,
      })),
      platformsButton(),
      mainMenuButton(),
    ],
    orderId: null,
  };
}

/**
 * One app's screen (WP-A10): the operator's description and rendered guide, a URL button
 * per link, and the customer's own service actions where they are safe.
 *
 * The service actions are the EXISTING flows, reached by their existing callbacks —
 * `r:<service>` re-sends the delivery card through the redelivery path, `sf:<service>`
 * opens Package E's files — so each is re-decided on its own tap exactly as it is from the
 * service card, and this screen never carries a subscription URL itself. With more than
 * one live service the customer is sent to «سرویس‌های من» to pick one.
 *
 * HF-A10: an entry with a picture sends it FIRST, as a bare photo lead — the referral
 * banner's arrangement, because the guide can outgrow a photo caption (1,024 characters)
 * and the text must never be cut. The lead is decorative: the composer drops a photo
 * Telegram refuses and sends the screen regardless, so the fallback is the emoji-and-text
 * screen an entry without a picture always gets.
 */
export function clientAppScreen(
  detail: Awaited<ReturnType<ClientAppCatalog['appFor']>>,
): PendingReply {
  if (detail === null) {
    return {
      key: 'bot.apps.not_found',
      values: {},
      buttons: [platformsButton(), mainMenuButton()],
      orderId: null,
    };
  }
  const buttons: CustomerButton[] = [];
  if (detail.officialUrl !== null) {
    buttons.push({
      ...inlineLabel('apps.download'),
      url: detail.officialUrl,
    });
  }
  if (detail.alternativeUrl !== null) {
    buttons.push({
      ...inlineLabel('apps.alternative'),
      url: detail.alternativeUrl,
    });
  }
  if (detail.helpUrl !== null) {
    buttons.push({ ...inlineLabel('apps.help'), url: detail.helpUrl });
  }
  if (detail.service !== null) {
    if (detail.service.link) {
      buttons.push({
        ...inlineLabel('service.link'),
        data: `${SERVICE_RESEND_CALLBACK_PREFIX}${detail.service.id}`,
      });
    }
    if (detail.service.files) {
      buttons.push({
        ...inlineLabel('service.files'),
        data: `${SERVICE_FILES_CALLBACK_PREFIX}${detail.service.id}`,
      });
    }
  } else if (detail.manyServices) {
    buttons.push({
      ...inlineLabel('apps.services'),
      data: `${SERVICES_LIST_PAGE_CALLBACK_PREFIX}1`,
    });
  }
  buttons.push(
    {
      ...inlineLabel('apps.back'),
      data: `${TUTORIAL_PLATFORM_CALLBACK_PREFIX}${detail.platform}`,
    },
    mainMenuButton(),
  );
  return {
    key: detail.filesNote ? 'bot.apps.detail_files' : 'bot.apps.detail',
    values: { app: detail.title, description: detail.description, guide: detail.guide },
    buttons,
    orderId: null,
    ...(detail.image === null
      ? {}
      : {
          lead: [
            {
              kind: 'PHOTO_BYTES' as const,
              bytes: detail.image.bytes,
              mimeType: detail.image.mimeType,
              fileName: detail.image.mimeType === 'image/png' ? 'app.png' : 'app.jpg',
            },
          ],
        }),
  };
}

function platformsButton(): CustomerButton {
  return {
    ...inlineLabel('apps.platforms'),
    data: TUTORIAL_CALLBACK_DATA,
  };
}

function paymentButtons(orderId: string, routesOffered: boolean): readonly CustomerButton[] {
  return [
    {
      ...inlineLabel('payment.wallet'),
      data: `${WALLET_PAY_CALLBACK_PREFIX}${orderId}`,
    },
    /*
     * «🧾 ثبت پرداخت», opening the selector of every route offered for the order —
     * card-to-card, each external route. Drawn only when there is at least one: a
     * card-to-card route with no enabled account to pay into is not offered
     * (`manualTransferOffered`), so a selector drawn regardless could hold nothing.
     *
     * The read can be a moment stale; each route's own tap re-decides it on the server.
     */
    ...(routesOffered ? [payMethodsButton(orderId)] : []),
    /*
     * The way out, beside the two ways in.
     *
     * Before 4H a customer who changed their mind had exactly one option — never pay —
     * and the order sat `AWAITING_PAYMENT` until a sweep expired it, which is the state
     * `docs/phase4h-audit.md` §3 records as the CANCEL edge having no caller at all.
     *
     * It carries the ASK prefix. Tapping it closes nothing: this message stays in the
     * chat for ever and `ORDER_MACHINE` has no edge out of CANCELLED, so a mis-touch
     * would take the customer's quoted price with it.
     */
    {
      ...inlineLabel('order.cancel'),
      data: `${CANCEL_ORDER_ASK_CALLBACK_PREFIX}${orderId}`,
    },
  ];
}

/**
 * The shortfall the service put on the refusal, or null.
 *
 * Parsed rather than cast, because `details` is `Record<string, unknown>` and a template
 * that declares a MONEY placeholder will refuse a string. Returning null on anything
 * unexpected sends the customer the generic refusal instead of a message with a hole in
 * it — the shortfall is a number they act on, and a wrong one is worse than none.
 */
function shortfallOf(details: Record<string, unknown> | undefined): Money | null {
  const minor = details?.shortfallMinor;
  const currency = details?.currency;
  if (typeof minor !== 'string' || !/^\d{1,19}$/u.test(minor)) return null;
  const parsed = currencyCodeSchema.safeParse(currency);
  if (!parsed.success) return null;
  return money(BigInt(minor), parsed.data);
}
