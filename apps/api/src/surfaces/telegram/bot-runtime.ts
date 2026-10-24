import {
  ADMIN_AMOUNT_CAPTURE_TTL_MS,
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  providerDescriptor,
  orderCodeOf,
  paymentTrackingCode,
  isNexaError,
  currencyCodeSchema,
  money,
  plainAmount,
  providerUsernameLookupSchema,
  telegramUserIdSchema,
  uuidV7Schema,
  CONNECTION_GUIDE_PLATFORMS,
  SERVICE_NOTE_CLEAR_TOKEN,
  SERVICE_NOTE_MAX_LENGTH,
  SERVICE_SEARCH_MAX_LENGTH,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TONPAYS_TELEGRAM_STATUS_LESS,
  TONPAYS_TELEGRAM_STATUS_MORE,
  TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED,
  TETRAPAY_DAILY_LIMIT_STORED,
} from '@nexa/contracts';
import type {
  ClientAppPlatform,
  ConnectionGuidePlatform,
  PaymentGatewayProvider,
  ActorContext,
  BotInstanceId,
  CustomerArrival,
  Money,
  OrderPurpose,
  PaymentId,
  PermissionKey,
  ProductId,
  ServiceActionAvailability,
  ServiceOperatorAction,
  ServiceReminderThresholds,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import { DEFAULT_USERNAME_PREFIX, previewUsername, validateUsernamePolicy } from '@nexa/contracts';
import type { PanelUsernamePolicy } from '../../modules/platform/panels/application/ports.js';
import type { InboundReceiptFile } from '../../modules/commerce/payments/application/receipt-ports.js';
import type { PaymentRecord } from '../../modules/commerce/payments/application/ports.js';
import { mayBePushedRefundRequests } from '../../modules/commerce/payments/application/service-refund-push.consumer.js';
import type { ReasonAskResult } from '../../modules/commerce/payments/application/receipt-reason-capture.service.js';
import {
  RECEIPT_REVIEW_NOTE_MAX,
  reviewNoteOf,
} from '../../modules/commerce/payments/application/receipt-review-caption.js';
import { ADMIN_CAPTURE_REASON_MAX_LENGTH, formatCustomServiceVolume } from '@nexa/contracts';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerSendResult,
  CustomerMessageRef,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../modules/commerce/messaging/application/inline-buttons.js';
import type { InlineButtonKey } from '@nexa/contracts';
import { CATEGORY_SORT_ORDER_MAX } from '../../modules/commerce/catalog/application/product-category.service.js';
import type {
  ProductCategoryListing,
  ProductRecord,
} from '../../modules/commerce/catalog/application/ports.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import {
  FX_UNAVAILABLE_REASON,
  type GatewayAttempt,
  type ManualTransferInstruction,
} from '../../modules/commerce/payments/application/payment.service.js';
import type {
  GatewayAttemptView,
  GatewayCardFacts,
} from '../../modules/commerce/payments/application/gateway-payment.service.js';
import type {
  GatewayInvoiceRecord,
  GatewayProviderRequestRecord,
} from '../../modules/commerce/payments/application/gateway-invoice-ports.js';
import {
  cancelAvailable,
  cardChangeOffered,
  customerMessageKeyOfError,
  decideCardChange,
  isBuyerConflictCode,
  receiptUploadAvailable,
  refundCardAvailable,
  remainderReceiptAvailable,
} from '../../modules/commerce/payments/domain/tonpays-telegram.js';
import { gatewaySettlementDeadline } from '../../modules/commerce/payments/domain/settlement.js';
import type { CustomerServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import {
  SERVICE_CARD_CALLBACK_PREFIX,
  TUTORIAL_CALLBACK_DATA,
} from '../../modules/commerce/provisioning/application/delivery.service.js';
import type { CustomerCaptureRecord } from '../../modules/commerce/customers/application/customer-capture-ports.js';
import type { CardMessageRef } from '../../modules/commerce/provisioning/application/operation-card.js';
import type {
  TopupRoute,
  WalletTopupFlowService,
} from '../../modules/commerce/payments/application/wallet-topup-flow.service.js';
import type { StartGreetingKey } from '../../modules/commerce/messaging/application/start-greeting.js';
import { amountToTransfer } from '../../modules/commerce/payments/domain/amount-to-transfer.js';
import {
  CARD_INVOICE_ROW,
  cardInvoiceAmountValues,
  cardInvoiceCardValues,
  copyCardNumberButton,
  copyRialAmountButton,
} from './card-invoice.js';
import type { ServiceRecord } from '../../modules/commerce/provisioning/application/ports.js';
import type { OperatorServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type {
  ServiceAdminService,
  ServiceOperationHistory,
} from '../../modules/commerce/provisioning/application/service-admin.service.js';
import { encodeKeysetToken, type KeysetToken } from './keyset-token.js';
import type { TelegramWizardRecord } from '../../modules/commerce/messaging/application/telegram-message-state.js';
import type { TelegramReviewOutcome } from '@nexa/contracts';
import {
  REVIEW_OUTCOME_KEYS,
  REVIEW_TAP_INTENTS,
  WIZARD_GATES,
  callbackOriginOf,
  typedMessageOf,
  type CallbackOrigin,
  type ReviewDirective,
  type WizardDirective,
} from './wizard-state.js';
import type { InboundTicketFile } from '../../modules/commerce/tickets/application/ticket.service.js';
import type { ClientAppCatalog } from '../../modules/control/client-apps/application/client-app-catalog.js';
import { CLIENT_APP_VIEW_PERMISSION } from '../../modules/control/client-apps/application/client-app.service.js';
import {
  adminTutorialTurn,
  maySeeTutorials,
  messageSentAt,
  tutorialsPanelButton,
} from './admin-tutorial-video.js';

import { readHealth } from '../../modules/platform/panels/application/panel-health-view.js';
import {
  ADMIN_ADMIN_CALLBACK_PREFIX,
  ADMIN_ADMIN_STATUS_CALLBACK_PREFIX,
  ADMIN_APPROVE_CALLBACK_PREFIX,
  ADMIN_BLOCK_ASK_CALLBACK_PREFIX,
  ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX,
  ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX,
  ADMIN_BLOCK_OPEN_CALLBACK_PREFIX,
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PICK_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_PANELS_CALLBACK_PREFIX,
  ADMIN_PANELS_PAGE_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX,
  ADMIN_PANEL_DETAIL_CALLBACK_PREFIX,
  ADMIN_PANEL_DISABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_ENABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_TEST_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CALLBACK_PREFIX,
  ADMIN_REJECT_CANCEL_CALLBACK_PREFIX,
  ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REMINDERS_CALLBACK_PREFIX,
  ADMIN_REMINDER_EDIT_CALLBACK_PREFIX,
  ADMIN_REMINDER_SET_CALLBACK_PREFIX,
  ADMIN_REVOKE_CALLBACK_PREFIX,
  ADMIN_SECTION_CALLBACK_PREFIX,
  ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
  ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
  ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX,
  ADMIN_STATUS_CODES,
  ADMIN_USERNAME_CALLBACK_PREFIX,
  ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX,
  ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX,
  type AdminCategoryCode,
  type AdminStatusCode,
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  CANCEL_ORDER_CALLBACK_PREFIX,
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  CLIENT_APP_CALLBACK_PREFIX,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  MANUAL_PAY_CALLBACK_PREFIX,
  ORDER_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  REFERRAL_GIFT_CALLBACK_DATA,
  REMINDER_SETTING_CODES,
  type ReminderSettingCode,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  TRIAL_PANEL_CALLBACK_PREFIX,
  TUTORIAL_PLATFORM_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  USERNAME_STRATEGY_CODES,
  USERNAME_TOGGLE_FIELDS,
  type UsernameStrategyCode,
  type UsernameToggleField,
  WALLET_PAY_CALLBACK_PREFIX,
  encodeIdPair,
  rotationStamp,
} from './runtime/callbacks.js';
import type { AdminRosterEntry, BotRuntimeDeps } from './runtime/deps.js';
import {
  type MainMenuRoutes,
  intentOf,
  isCallbackQueryUpdate,
  privateChatIdOf,
  startPayloadOf,
  updateIdOf,
} from './runtime/intent-of.js';
import { BOT_INTENTS, type BotCommand, type BotIntent } from './runtime/intents.js';
import { mainMenuButton } from './runtime/keyboards.js';
import { refusal } from './runtime/refusals.js';
import {
  type BotTurnResult,
  type PendingReply,
  type ReplyMedia,
  blockedReply,
  editSent,
  replyFor,
  staleCallbackReply,
  withBlockedSupportButton,
} from './runtime/replies.js';
import * as startMenuFlow from './runtime/start-menu-flow.js';
import {
  MEMBERSHIP_EXEMPT_INTENTS,
  membershipRequired,
  termsRequired,
  termsAcceptedReply,
  termsStaleReply,
} from './runtime/start-menu-flow.js';
import * as serviceCardFlow from './runtime/service-card-flow.js';
import * as serviceRequestsFlow from './runtime/service-requests-flow.js';
import * as serviceActionsFlow from './runtime/service-actions-flow.js';
import {
  serviceListButton,
  backToListButton,
  cardMessageOf,
  backToServiceButton,
  inCard,
} from './runtime/service-card-flow.js';
import * as supportFlow from './runtime/support-flow.js';

export { serviceListButton, cardMessageOf } from './runtime/service-card-flow.js';
export { LOCATION_TARGETS_SHOWN } from './runtime/service-actions-flow.js';

export {
  termsAcceptedReply,
  termsStaleReply,
  marketingPreferenceButton,
} from './runtime/start-menu-flow.js';

export { BOT_INTENTS } from './runtime/intents.js';
export type { BotIntent, BotCommand } from './runtime/intents.js';
export {
  encodeIdPair,
  decodeIdPair,
  ORDER_CALLBACK_PREFIX,
  CONFIRM_CALLBACK_PREFIX,
  WALLET_PAY_CALLBACK_PREFIX,
  MANUAL_PAY_CALLBACK_PREFIX,
  GATEWAY_PAY_CALLBACK_PREFIX,
  GATEWAY_CHECK_CALLBACK_PREFIX,
  GATEWAY_RECEIPT_CALLBACK_PREFIX,
  GATEWAY_CARD_CHANGE_CALLBACK_PREFIX,
  GATEWAY_CANCEL_ASK_CALLBACK_PREFIX,
  GATEWAY_CANCEL_CALLBACK_PREFIX,
  GATEWAY_REFUND_CARD_CALLBACK_PREFIX,
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  TICKETS_CALLBACK_DATA,
  TICKET_NEW_CALLBACK_DATA,
  TICKET_CATEGORY_CALLBACK_PREFIX,
  TICKET_VIEW_CALLBACK_PREFIX,
  TICKET_REPLY_CALLBACK_PREFIX,
  TICKET_CLOSE_ASK_CALLBACK_PREFIX,
  TICKET_CLOSE_CALLBACK_PREFIX,
  PAY_METHODS_CALLBACK_PREFIX,
  PAY_METHODS_CLOSE_CALLBACK_PREFIX,
  CANCEL_PAY_ASK_CALLBACK_PREFIX,
  CANCEL_PAY_CALLBACK_PREFIX,
  PAY_SENT_CALLBACK_PREFIX,
  PAY_SWITCH_CARD_CALLBACK_PREFIX,
  CANCEL_ORDER_ASK_CALLBACK_PREFIX,
  CANCEL_ORDER_CALLBACK_PREFIX,
  TOPUP_MENU_CALLBACK_PREFIX,
  TOPUP_PICK_CALLBACK_PREFIX,
  REFERRAL_INVITE_CALLBACK_PREFIX,
  SERVICE_CALLBACK_PREFIX,
  SERVICES_PAGE_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CALLBACK_PREFIX,
  SERVICE_RESUME_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  SERVICE_TERMINATE_CALLBACK_PREFIX,
  SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  SERVICE_ROTATE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  SERVICE_ADD_DEVICES_CALLBACK_PREFIX,
  SERVICE_BUY_DEVICES_CALLBACK_PREFIX,
  encodeDeviceQuantity,
  decodeDeviceQuantity,
  SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX,
  SERVICE_LOCATION_TARGET_CALLBACK_PREFIX,
  SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX,
  USERNAME_CUSTOM_CALLBACK_PREFIX,
  USERNAME_AUTOMATIC_CALLBACK_PREFIX,
  DISCOUNT_CODE_ENTER_CALLBACK_PREFIX,
  DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX,
  MAIN_MENU_CALLBACK_DATA,
  MARKETING_OPT_OUT_CALLBACK_DATA,
  MARKETING_OPT_IN_CALLBACK_DATA,
  MEMBERSHIP_CHECK_CALLBACK_DATA,
  TERMS_ACCEPT_CALLBACK_PREFIX,
  TUTORIAL_PLATFORM_CALLBACK_PREFIX,
  CLIENT_APP_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
  TOPUP_CLOSE_CALLBACK_PREFIX,
  SERVICES_LIST_PAGE_CALLBACK_PREFIX,
  SERVICES_SEARCH_CALLBACK_DATA,
  SERVICE_REFRESH_CALLBACK_PREFIX,
  SERVICE_FILES_CALLBACK_PREFIX,
  SERVICE_NOTE_CALLBACK_PREFIX,
  SERVICE_RENEW_QUOTE_CALLBACK_PREFIX,
  SERVICE_RENEW_PLAN_CALLBACK_PREFIX,
  REFERRAL_GIFT_CALLBACK_DATA,
  WALLET_OPEN_CALLBACK_DATA,
  CATALOG_OPEN_CALLBACK_DATA,
  ADMIN_PANEL_CALLBACK_PREFIX,
  ADMIN_RECEIPTS_CALLBACK_PREFIX,
  ADMIN_RECEIPT_CALLBACK_PREFIX,
  SERVICE_REFUND_ASK_CALLBACK_PREFIX,
  SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX,
  SERVICE_TRANSFER_ASK_CALLBACK_PREFIX,
  SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX,
  ADMIN_APPROVE_CALLBACK_PREFIX,
  ADMIN_REJECT_CALLBACK_PREFIX,
  ADMIN_SECTION_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  ADMIN_BLOCK_ASK_CALLBACK_PREFIX,
  ADMIN_BLOCK_OPEN_CALLBACK_PREFIX,
  ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX,
  ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX,
  ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_REJECT_CANCEL_CALLBACK_PREFIX,
  ADMIN_REVOKE_CALLBACK_PREFIX,
  ADMIN_SERVICES_CALLBACK_PREFIX,
  ADMIN_SERVICES_BROWSE_CALLBACK_DATA,
  ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX,
  ADMIN_SERVICE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
  ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
  ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
  ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX,
  rotationStamp,
  ADMIN_PANELS_CALLBACK_PREFIX,
  ADMIN_PANEL_DETAIL_CALLBACK_PREFIX,
  ADMIN_PANEL_TEST_CALLBACK_PREFIX,
  ADMIN_PANEL_ENABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_DISABLE_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX,
  ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX,
  ADMIN_PANELS_PAGE_CALLBACK_PREFIX,
  ADMIN_REMINDERS_CALLBACK_PREFIX,
  ADMIN_REMINDER_EDIT_CALLBACK_PREFIX,
  ADMIN_REMINDER_SET_CALLBACK_PREFIX,
  ADMIN_ADMIN_CALLBACK_PREFIX,
  ADMIN_ADMIN_STATUS_CALLBACK_PREFIX,
  ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  ADMIN_CUSTOMER_CALLBACK_PREFIX,
  ADMIN_USERNAME_CALLBACK_PREFIX,
  ADMIN_CATEGORIES_CALLBACK_PREFIX,
  ADMIN_CATEGORY_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX,
  ADMIN_CATEGORY_PICK_CALLBACK_PREFIX,
  ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX,
  ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX,
  ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX,
  REMINDER_SETTING_CODES,
  CATALOG_BROWSE_MAX_PAGE,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  TRIAL_CALLBACK_DATA,
  TRIAL_PANEL_CALLBACK_PREFIX,
  CUSTOM_SERVICE_CALLBACK_DATA,
  CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX,
  parseCatalogPage,
  TRANSFER_CONFIRM_VERSION_MAX,
  transferConfirmData,
  decodeTransferConfirm,
} from './runtime/callbacks.js';
export type { ReminderSettingCode } from './runtime/callbacks.js';
export {
  startPayloadOf,
  updateIdOf,
  intentOf,
  privateChatIdOf,
  isCallbackQueryUpdate,
} from './runtime/intent-of.js';
export type { MainMenuRoutes } from './runtime/intent-of.js';
export type {
  CustomServiceSurface,
  BotRuntimeDeps,
  TicketDeskPort,
  CaptureReadTransaction,
  PaymentRouteSource,
  SupportScreenSource,
  ProductDisplaySource,
  PanelLocationLabelSource,
  ReferralGiftSource,
  TenantMediaSource,
  TelegramAdminPort,
  AdminRosterEntry,
} from './runtime/deps.js';
export {
  blockedReply,
  withBlockedSupportButton,
  editSent,
  replyFor,
  staleCallbackReply,
} from './runtime/replies.js';
export type { BotTurnResult, PendingReply, LeadMessage } from './runtime/replies.js';
export { REFUSAL_REPLIES, refusalValuesFor } from './runtime/refusals.js';
export { notificationButtons } from './runtime/keyboards.js';

/**
 * `sv:<service id>` — R3: the service card, edited into the message the tap came from.
 * Declared beside the delivery lane's buttons since round N (F4), which draws it too.
 */
export { SERVICE_CARD_CALLBACK_PREFIX };

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

/** How many categories one page of the operator list — and of the picker — shows. */
const ADMIN_CATEGORY_PAGE_SIZE = 8;

const USERNAME_STRATEGY_BUTTONS: readonly (readonly [UsernameStrategyCode, TemplateKey])[] = [
  ['r', 'bot.admin.username_strategy_random'],
  ['p', 'bot.admin.username_strategy_prefix_random'],
  ['t', 'bot.admin.username_strategy_telegram_id_random'],
];

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

/*
 * The reviewer's caption is built by ONE application function the pull item and the push
 * share (`receipt-review-caption.ts`); these are re-exported for the tests that pin them.
 */
export { RECEIPT_REVIEW_NOTE_MAX, reviewNoteOf };

/**
 * A receipt's refusal (roadmap E6). The shared table, except a receipt that arrived after its
 * window closed: while the payment can still take one, the sentence that says "press the
 * button below" carries that button — the same «پرداخت را انجام دادم | ارسال رسید» tap that
 * opened the first window, which opens a new one (`signalTransferSent`, a new key). The prompt
 * edited the invoice's own button away, so without it the remedy named a button that was
 * nowhere. A payment that can no longer take a receipt is told so instead of being sent to a
 * button that would refuse.
 */
function receiptRefusal(error: unknown): PendingReply {
  if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED) {
    const paymentId = error.details?.['paymentId'];
    const next = error.details?.['next'];
    const reference = error.details?.['reference'];
    // Past its deadline but holding a receipt: still waiting for a reviewer, never "closed".
    if (next === 'UNDER_REVIEW') {
      return {
        key: 'bot.payment.received_for_review',
        // Already the public tracking code (`ReceiptService`), never the stored reference.
        values: typeof reference === 'string' ? { reference } : {},
        buttons: [],
        orderId: null,
      };
    }
    if (typeof paymentId !== 'string' || next !== 'REOPEN') {
      return { key: 'bot.payment.not_pending', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.payment.receipt_expired',
      values: {},
      buttons: [
        { ...inlineLabel('payment.sent'), data: `${PAY_SENT_CALLBACK_PREFIX}${paymentId}` },
      ],
      orderId: null,
    };
  }
  return refusal(error);
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
  constructor(readonly deps: BotRuntimeDeps) {}

  /**
   * The route table for this update (R1): the shared defaults, then this tenant's current
   * labels over them. Read only for a TEXT message — a keyboard tap is text, and nothing
   * else consults the table, so a callback or a file pays for no template rendering.
   */
  async menuFor(scope: TenantContext, update: unknown): Promise<MainMenuRoutes> {
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
    const blocked: PendingReply =
      arrival === 'BLOCKED'
        ? withBlockedSupportButton(
            blockedReply(customer),
            (await this.deps.support.partsFor(scope)).supportUrl,
          )
        : blockedReply(customer);
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
      else if (claimed.outcome === 'STALE') {
        // Lenient only for a CLOSED wizard; a message another turn still holds is swallowed.
        staleWizard = gate.lenient !== true || claimed.held === true;
      }
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
     *
     * One stated exception: a filed receipt (A10, `submitReceipt`) answers its redelivery
     * with NOTHING — the PO's instruction is one new message per payment, keyed on its first
     * receipt row.
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
        await this.stopSpinner(scope, command, input.botInstanceId, reply.toast);
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
              ...(lead.caption !== undefined
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
        if (lead.kind === 'PHOTO_BYTES') continue;
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
              ...(reply.media.captionWhole === true ? { captionWhole: true as const } : {}),
              ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
            });
    /*
     * A4: a whole-or-nothing caption over the bound — a long tutorial guide. The file goes
     * bare, decorative again, so its own outcome is ignored; the reply then goes as text below.
     */
    if (
      reply.media?.captionWhole === true &&
      sent.outcome === 'REFUSED' &&
      sent.reason === 'CAPTION_OVER_BOUND'
    ) {
      await this.deps.messenger.sendFile(scope, {
        chatId,
        botInstanceId: reply.media.botInstanceId,
        kind: reply.media.kind,
        source: { kind: 'FILE_ID', fileId: reply.media.fileId },
      });
    }
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
  async adminTurn(
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
  async isAdmin(
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
  async adminReceipts(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const items = await this.deps.receipts.reviewQueue(scope, actor, ADMIN_QUEUE_LIMIT);
    if (items.length === 0) {
      return { key: 'bot.admin.receipts_none', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.receipts_list',
      values: {},
      buttons: items.map((item) => ({
        label: {
          kind: 'TEXT' as const,
          text: paymentTrackingCode(item.payment),
          // R6 item 4: what the customer had to transfer, which a receipt is checked against.
          amount: amountToTransfer(item.payment),
        },
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
  async adminReceipt(
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
  async decidedReply(
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
  receiptDecisionButtons(
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
  async adminCreditOpen(
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
          reference: paymentTrackingCode(opened.payment),
          total: amountToTransfer(opened.payment),
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
  async adminCreditAmount(
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
            values: { total: amountToTransfer(result.payment) },
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
              reference: paymentTrackingCode(result.payment),
              customer: result.customer?.telegramUserId ?? result.payment.customerId,
              total: amountToTransfer(result.payment),
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
  async adminCreditConfirm(
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
          values: {
            amount: result.amount,
            reference: paymentTrackingCode(result.result.payment),
          },
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
  async adminCreditCancel(
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
  async adminBlockTurn(
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
  async adminCaptureText(
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
  async adminRefundRequestTurn(
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
  async adminRefundRequestText(
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
  async adminCustomerBlockReason(
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
  async adminRejectReason(
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
            values: {
              reference: paymentTrackingCode(result.payment),
              reason: result.reason,
            },
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
  async adminBlockReason(
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
  async adminApprove(
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
  async lostDecision(
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
  async adminRejectTurn(
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
            reference: paymentTrackingCode(opened.payment),
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
  async adminServices(
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
  async adminServicesBrowse(
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
  async adminReminders(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
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
  async adminReminderEdit(
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
  async adminReminderSet(
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

  async adminPanels(
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
  async adminPanelDetail(
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
  async adminUsername(
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
  usernameSection(
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
  async adminUsernameWrite(
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
  async adminPanelArchiveAsk(
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
  async adminPanelAct(
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
  async adminService(
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
  async resolveAdminService(
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
  async adminServiceCustomer(
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
  async adminServiceAsk(
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
  async adminServiceRotateConfirm(
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
  async adminServiceAct(
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
  async adminCustomers(
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
  async adminCustomer(
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
  async adminCustomerFind(
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
  async adminCustomerStatusTurn(
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
  async adminCategoryTurn(
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
  adminCategoryList(
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
  async adminCategoryDetail(
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
  async adminCategoryMove(
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
  async adminCategoryDeleteAsk(
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
  async adminCategoryDelete(
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
  async adminCategoryNew(
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
  async adminCategoryEdit(
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
  async adminCategoryProducts(
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
  async adminCategoryPick(
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
  async adminCategoryAssign(
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
  requireCategories(): NonNullable<BotRuntimeDeps['productCategories']> {
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
  async adminSection(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
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
  async adminAdmin(
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
  async adminAdminStatus(
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
  adminAdminReply(
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
  async adminRevokeAccess(
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
  async adminLink(
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
  async adminRole(
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
  async guardedAct(
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
   * older message answers with the version that replaced it. After acceptance the terms
   * message is edited into the accepted text with the way to the main menu (Batch 01 item
   * 1) — never a replay of what they first asked for, and never a second message.
   */
  async termsGatedAct(
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

  async acceptTerms(
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
        : termsStaleReply(accepted.current);
    }
    /*
     * Batch 01 item 1: the terms message the customer tapped is EDITED into the accepted
     * text — no second message. A repeated tap or a redelivered update edits it into the
     * same text again, which Telegram answers "message is not modified" and the messenger
     * counts as delivered, so nothing is sent then either.
     */
    return termsAcceptedReply();
  }

  /**
   * What this intent produces, as a reply that has not been sent yet.
   *
   * Every branch returns; there is no fallthrough that leaves a customer unanswered,
   * which is the failure mode the legacy bot has for anything it does not recognise.
   */
  async act(
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
        ...(await this.startGreeting(scope, actor, customer, 'bot.start.welcome_back')),
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
      const card = await this.openServiceCard(scope, actor, customer, command.targetId);
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
    if (
      command.intent === 'SERVICE_RENEW_PLAN' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      // An imported service's chosen plan; the draft re-decides it against the panel's plans.
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'RENEW',
        null,
        input,
        undefined,
        undefined,
        command.secondaryId,
      );
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
        ...(await this.startGreeting(scope, actor, customer, 'bot.start.welcome_back')),
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
    if (
      (command.intent === 'GATEWAY_CHECK' || command.intent === 'GATEWAY_RETURN') &&
      command.targetId !== null
    ) {
      // A return is the same question as a tap on «بررسی وضعیت»: the payment's own state, read
      // now, with a verify brought forward - and answered as closed for anyone else's payment.
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
    if (command.intent === 'GATEWAY_CANCEL_ASK' && command.targetId !== null) {
      return this.gatewayCancelAsk(scope, command.targetId, customer, input.botInstanceId);
    }
    if (command.intent === 'GATEWAY_CANCEL' && command.targetId !== null) {
      return this.gatewayCancel(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'GATEWAY_REFUND_CARD' && command.targetId !== null) {
      return this.gatewayRefundCardPrompt(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
        updateIdOf(input.update),
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
        privateChatIdOf(input.update),
        command.file,
        input.idempotencyKey,
      );
    }
    if (
      command.intent === 'PAY_SWITCH_CARD' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.switchCard(
        scope,
        actor,
        command.targetId,
        Number(command.secondaryId),
        customer,
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
      return this.openServiceCard(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return this.serviceResend(scope, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_FILES' && command.targetId !== null) {
      return this.serviceFiles(scope, actor, customer, command.targetId, input);
    }
    /*
     * B8: the switch's first tap draws the question IN the card and plans nothing — on any
     * card, so an old message's `u:` / `e:` can no longer act on one tap either.
     */
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return this.serviceToggleAsk(scope, actor, customer, command.targetId, 'SUSPEND');
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return this.serviceToggleAsk(scope, actor, customer, command.targetId, 'RESUME');
    }
    if (command.intent === 'SERVICE_SUSPEND_CONFIRM' && command.targetId !== null) {
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
    if (command.intent === 'SERVICE_RESUME_CONFIRM' && command.targetId !== null) {
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
    // R6 item 3: only the two greetings take variables, and only this customer's own.
    const greeting =
      key === 'bot.start.welcome' || key === 'bot.start.welcome_back'
        ? await this.startGreeting(scope, actor, customer, key)
        : { key, values: {} };
    return { ...greeting, buttons: [], orderId: null, ...menu };
  }

  startGreeting(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    key: StartGreetingKey,
  ): Promise<{ readonly key: TemplateKey; readonly values: TemplateValues }> {
    return startMenuFlow.startGreeting(this, scope, actor, customer, key);
  }

  services(
    scope: TenantContext,
    customer: CustomerRecord,
    pageNumber: number,
  ): Promise<PendingReply> {
    return serviceCardFlow.services(this, scope, customer, pageNumber);
  }

  /** Public: the provisioner edits the card through this (`container.ts`). */
  serviceCardFor(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    notice?: TemplateKey,
  ): Promise<{
    readonly key: TemplateKey;
    readonly values: TemplateValues;
    readonly buttons: readonly CustomerButton[];
  } | null> {
    return serviceCardFlow.serviceCardFor(this, scope, actor, customerId, serviceId, notice);
  }

  serviceDetail(
    scope: TenantContext,
    actor: ActorContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
    options?: {
      readonly working?: boolean;
      readonly notice?: TemplateKey;
      /** Track 3 §1: drawn from stored figures; the status names when they were read. */
      readonly lastUpdatedAt?: Date;
    },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceDetail(this, scope, actor, customer, serviceId, options);
  }

  addonChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<PendingReply> {
    return serviceActionsFlow.addonChoice(this, scope, actor, customer, serviceId, kind);
  }

  devicesChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.devicesChoice(this, scope, actor, customer, serviceId);
  }

  locationChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationChoice(this, scope, actor, customer, serviceId);
  }

  locationTarget(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationTarget(
      this,
      scope,
      actor,
      customer,
      serviceId,
      locationId,
      input,
    );
  }

  locationRequest(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    locationId: string,
    input: {
      readonly idempotencyKey: string;
      readonly update?: unknown;
      readonly botInstanceId?: BotInstanceId;
    },
  ): Promise<PendingReply> {
    return serviceActionsFlow.locationRequest(
      this,
      scope,
      actor,
      customer,
      serviceId,
      locationId,
      input,
    );
  }

  commercialQuote(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION',
    addonId: string | null,
    input: { readonly idempotencyKey: string },
    quantity?: number,
    locationId?: string,
    planId?: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.commercialQuote(
      this,
      scope,
      actor,
      customer,
      serviceId,
      kind,
      addonId,
      input,
      quantity,
      locationId,
      planId,
    );
  }

  commercialConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    orderId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    return serviceActionsFlow.commercialConfirm(this, scope, actor, customer, orderId, input);
  }

  serviceResend(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
    },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceResend(this, scope, customer, serviceId, input);
  }

  serviceFiles(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceFiles(this, scope, actor, customer, serviceId, input);
  }

  serviceAction(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: CustomerServiceOperation,
    idempotencyKey: string,
    card: CardMessageRef | null,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceAction(
      this,
      scope,
      actor,
      customer,
      serviceId,
      type,
      idempotencyKey,
      card,
    );
  }

  serviceToggleAsk(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: 'SUSPEND' | 'RESUME',
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceToggleAsk(this, scope, actor, customer, serviceId, type);
  }

  serviceRotateAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.serviceRotateAsk(this, scope, customer, serviceId);
  }

  serviceRotate(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
    card?: CardMessageRef | null,
  ): Promise<PendingReply> {
    return serviceActionsFlow.serviceRotate(
      this,
      scope,
      actor,
      customer,
      serviceId,
      idempotencyKey,
      card,
    );
  }

  /**
   * A plain message offered to the customer's own text window, if one is open: a top-up
   * amount, a search term or a note, by the window's PURPOSE. Null means no window read
   * it and the message goes on to the order windows.
   */
  async capturedText(
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
      const now = this.deps.clock.now();
      return {
        key: 'bot.service.search_results',
        values: { query: query.toLowerCase() },
        buttons: [...found.map((service) => serviceListButton(service, now)), backToListButton()],
        orderId: null,
      };
    }
    if (capture.purpose === 'GATEWAY_REFUND_CARD') {
      return this.gatewayRefundCardText(scope, actor, customer, capture, text, input);
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
  async topupAmountReply(
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

  async topupAmountScreen(
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
  async topupChooser(
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

  async topupRoute(
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

  async topupClose(
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

  servicesSearchBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.servicesSearchBegin(
      this,
      scope,
      actor,
      customer,
      botInstanceId,
      idempotencyKey,
    );
  }

  openServiceCard(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.openServiceCard(this, scope, actor, customer, serviceId);
  }

  serviceRefresh(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceRefresh(this, scope, actor, customer, serviceId, idempotencyKey);
  }

  serviceRefundAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceRefundAsk(this, scope, customer, serviceId);
  }

  serviceRefundConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
    updateId: bigint | undefined,
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceRefundConfirm(
      this,
      scope,
      actor,
      customer,
      serviceId,
      botInstanceId,
      idempotencyKey,
      updateId,
    );
  }

  serviceRefundReason(
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
    return serviceRequestsFlow.serviceRefundReason(
      this,
      scope,
      actor,
      customer,
      serviceId,
      text,
      input,
    );
  }

  serviceTransferAsk(
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
    return serviceRequestsFlow.serviceTransferAsk(this, scope, actor, customer, serviceId, input);
  }

  serviceTransferRecipient(
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
    return serviceRequestsFlow.serviceTransferRecipient(
      this,
      scope,
      actor,
      customer,
      serviceId,
      text,
      input,
    );
  }

  serviceTransferConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    confirmed: { readonly recipientTelegramUserId: string; readonly ownershipVersion: number },
    input: { readonly idempotencyKey: string; readonly botInstanceId: BotInstanceId },
  ): Promise<PendingReply> {
    return serviceRequestsFlow.serviceTransferConfirm(
      this,
      scope,
      actor,
      customer,
      serviceId,
      confirmed,
      input,
    );
  }

  serviceNoteBegin(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return serviceCardFlow.serviceNoteBegin(
      this,
      scope,
      actor,
      customer,
      serviceId,
      botInstanceId,
      idempotencyKey,
    );
  }

  renewMenu(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    return serviceActionsFlow.renewMenu(this, scope, actor, customer, serviceId);
  }

  async referralGift(
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

  ticketTurn(
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
    return supportFlow.ticketTurn(this, scope, actor, command, customer, input);
  }

  ticketFile(
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
    return supportFlow.ticketFile(this, scope, actor, customer, file, input);
  }

  ticketSubmit(
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
    return supportFlow.ticketSubmit(this, scope, actor, customer, capture, text, file, input);
  }

  marketingPreference(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    optedOut: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    return startMenuFlow.marketingPreference(
      this,
      scope,
      actor,
      customer,
      optedOut,
      idempotencyKey,
    );
  }

  supportScreen(scope: TenantContext, customer: CustomerRecord): Promise<PendingReply> {
    return supportFlow.supportScreen(this, scope, customer);
  }

  /**
   * The connection guide's first screen: the platforms (WP-A10).
   *
   * The five with a guide of their own always, and «🧩 سایر» only while the tenant files
   * an app there that this customer may see — decided by the catalogue, per tap.
   */
  async tutorialChoice(scope: TenantContext, customer: CustomerRecord): Promise<PendingReply> {
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
  async tutorialPlatform(
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
  async clientApp(
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
     * downloaded.
     *
     * A4 (delta a): the video IS the screen's message — the guide its caption, the buttons on
     * it — when the rendered guide fits a caption whole (`ReplyMedia.captionWhole`). Longer,
     * the video goes bare and the guide follows as today's text. A video Telegram refuses is
     * dropped and the guide still goes out as text, with its buttons.
     */
    const video =
      detail === null || this.deps.clientAppVideos === undefined
        ? null
        : await this.deps.clientAppVideos.videoFor(scope, appId, botInstanceId);
    if (video === null) return screen;
    return {
      ...screen,
      media: { botInstanceId, kind: 'VIDEO', fileId: video.fileId, captionWhole: true },
    };
  }

  ownedService(
    scope: TenantContext,
    customer: Pick<CustomerRecord, 'id'>,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    return serviceCardFlow.ownedService(this, scope, customer, serviceId);
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
  async catalogue(
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
    /*
     * B1: the entry is the LAST item of the category list — below every category, never
     * above them — so it sits on the final page, after the categories and before the
     * paging row. Drawn where the list ends (no further page), not on page 0.
     */
    const lastPage = !hasMore || page >= CATALOG_BROWSE_MAX_PAGE;
    const trailing: CustomerButton[] = [];
    if (lastPage && (await this.customServiceOffered(scope, actor, customer))) {
      trailing.push({
        ...inlineLabel('catalog.custom_service'),
        data: CUSTOM_SERVICE_CALLBACK_DATA,
      });
    }
    if (items.length === 0) {
      if (page > 0) return this.catalogue(scope, actor, 0, customer);
      return { key: 'bot.catalog.empty', values: {}, buttons: trailing, orderId: null };
    }
    const buttons: CustomerButton[] = [];
    buttons.push(
      ...items.map((category) => ({
        // Operator text, exactly as a product title is. The emoji is optional and its
        // absence renders as an ordinary category — §6.1.
        ...inlineDataLabel('catalog.category', {
          kind: 'TEXT',
          text: category.emoji === null ? category.name : `${category.emoji} ${category.name}`,
        }),
        data: `${CATEGORY_CALLBACK_PREFIX}${category.id}.0`,
        // UX Batch 01, item 2: the category's own colour; the route above is unchanged.
        category: category.id,
      })),
      ...trailing,
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
  async customServiceOffered(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<boolean> {
    if (this.deps.customService === undefined) return false;
    return (await this.deps.customService.offeredLocations(scope, actor, customer.id)).length > 0;
  }

  /** The custom-service button: the locations, each by the label the operator wrote. */
  async customServiceMenu(
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
  async customServiceLocation(
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
      values: { location: begun.location.label, ...volumeRangeValues(begun.range) },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * A figure a custom-service window read (Package D): the volume, then the days, then
   * the draft and the ordinary username step and pre-invoice.
   */
  async customServiceFigure(
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
        // B1: the wrong input is named and the allowed range repeated. No range means the
        // window is no longer one this customer can price: the one unavailable sentence.
        if (volume.range === null) {
          return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
        }
        return {
          key: 'bot.custom_service.invalid_volume',
          values: volumeRangeValues(volume.range),
          buttons: [],
          orderId: null,
        };
      }
      if (volume.outcome === 'UNPRICED') {
        return {
          key: 'bot.custom_service.volume_unpriced',
          values: {},
          buttons: [],
          orderId: null,
        };
      }
      if (volume.outcome === 'UNAVAILABLE') {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.custom_service.ask_days',
        values: { volumeBytes: volume.volumeBytes, ...daysRangeValues(volume.range) },
        buttons: [],
        orderId: null,
      };
    }
    try {
      const days = await flow.recordDays(scope, actor, { capture, text });
      if (days.outcome === 'INVALID') {
        if (days.range === null) {
          return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
        }
        return {
          key: 'bot.custom_service.invalid_days',
          values: daysRangeValues(days.range),
          buttons: [],
          orderId: null,
        };
      }
      if (days.outcome === 'UNPRICED') {
        return { key: 'bot.custom_service.days_unpriced', values: {}, buttons: [], orderId: null };
      }
      if (days.outcome === 'UNAVAILABLE') {
        return { key: 'bot.custom_service.unavailable', values: {}, buttons: [], orderId: null };
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
  async beginTrial(
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
  async claimTrial(
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
  async categoryPage(
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
        // R4 PR-F (F2): the plan table of a rich message; an ordinary message ignores it.
        planFacts: {
          trafficBytes: product.specification.trafficBytes,
          durationDays: product.specification.durationDays,
        },
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
  async preinvoice(
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
      // PR-C: the order's public code, the one the customer quotes and every log prints.
      orderCode: orderCodeOf(order),
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
      // B1: the one editable customer-facing description, in place of the two blocks.
      description: display?.description ?? null,
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
  async repricedSummary(
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
  async enterDiscountCode(
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
  async removeDiscountCode(
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
  async typedDiscountCode(
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
  async afterDraft(
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
  async automaticUsername(
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
  async customUsername(
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
  async typedUsername(
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
  async draft(
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
  async confirm(
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
  async awaitingPaymentReply(
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
  async walletBalance(
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
        /*
         * R8-C2: no separate «کپی شناسه» button. The numeric id is in <code> in the summary
         * (`bot.wallet.summary` is TELEGRAM_HTML), so a tap on the text copies it.
         */
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
  async referralInvite(
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
  async topupBegin(
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
  async topupPick(
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
  async walletPayment(
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
        key: settledKeyFor(order.purpose),
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
  async confirmDraft(
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
  async manualPayment(
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
  async orderRouteButtons(
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
  async paymentMethods(
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
  async paymentMethodsBack(
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
  async gatewayPayment(
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
  async gatewayCheck(
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
  async gatewayAttemptReply(
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
  async gatewayReceipt(
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
  async gatewayCardChange(
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
    if (requested) {
      return this.gatewayAttemptReply({ ...fresh, reissued: true }, fresh.payment.orderId, scope);
    }
    /*
     * R8 A2: the button is drawn during a cooldown, so a press inside one is answered with the
     * seconds left and the invoice stays exactly as it is — the manual switch's answer
     * (R5C-1). The refusal itself was decided under the payment's lock; this only explains it.
     */
    if (fresh.payment.state === 'PENDING') {
      const facts = await this.deps.gateway.cardFactsFor(scope, fresh.invoice);
      const decision = decideCardChange(
        fresh.invoice,
        facts?.latestChange ?? null,
        this.deps.clock.now(),
        facts?.changeAllowance ?? null,
      );
      if (decision.kind === 'COOLDOWN') {
        return {
          key: null,
          values: {},
          buttons: [],
          orderId: null,
          toast: {
            key: 'bot.payment.switch_card_cooldown',
            values: { seconds: decision.retryAfterSeconds },
          },
        };
      }
    }
    return this.refusedCardTap(scope, fresh);
  }

  /**
   * «❌ لغو فاکتور» (Round 6): the question first. Writes nothing. Offered only while the
   * cancel can be asked for (a `pending` invoice, the customer window, nothing in flight);
   * otherwise the attempt's current screen is redrawn. The confirm button carries the
   * destructive prefix; «🔎» is the way back.
   */
  async gatewayCancelAsk(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
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
    const offered = await this.deps.gatewayReceipts.cancelOffered(scope, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (!offered) return this.refusedCardTap(scope, view);
    return {
      key: 'bot.payment.gateway_cancel_confirm',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [
        {
          ...inlineLabel('payment.gateway_cancel_confirm'),
          data: `${GATEWAY_CANCEL_CALLBACK_PREFIX}${view.payment.id}`,
        },
        cardCheck(view.payment.id),
      ],
      orderId: view.payment.orderId,
      wizard: {
        kind: view.payment.orderId === null ? 'TOPUP' : 'ORDER',
        step: 'INVOICE',
        paymentId: view.payment.id,
      },
    };
  }

  /**
   * The confirmed cancel (Round 6): a request row the worker sends; the payment message is
   * redrawn as "cancelling…" and the worker edits the result in. Re-decided against the rows
   * under the payment's lock; a refusal redraws the attempt as it stands.
   */
  async gatewayCancel(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
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
    const requested = await this.deps.gatewayReceipts.requestCancel(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
      idempotencyKey: `${idempotencyKey}:gateway-cancel`,
    });
    const fresh = (await this.deps.gateway.attemptFor(scope, customer.id, paymentId)) ?? view;
    return requested
      ? this.gatewayAttemptReply({ ...fresh, reissued: true }, fresh.payment.orderId, scope)
      : this.refusedCardTap(scope, fresh);
  }

  /**
   * «💳 ثبت کارت بازگشت وجه» (Round 6): opens the text window that reads the refund card and
   * asks for it as its own message. Offered only for an overpaid invoice whose refund is not
   * already pending or in flight.
   */
  async gatewayRefundCardPrompt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
    updateId: bigint | undefined,
  ): Promise<PendingReply> {
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
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
    const offered = await this.deps.gatewayReceipts.refundCardOffered(scope, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId,
    });
    if (!offered) return this.refusedCardTap(scope, view);
    await this.deps.captures.open(scope, actor, {
      idempotencyKey: `${idempotencyKey}:refund-card-open`,
      botInstanceId,
      customerId: customer.id,
      purpose: 'GATEWAY_REFUND_CARD',
      subjectId: view.payment.id,
      // The card must be typed after this tap.
      ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
    });
    return {
      key: 'bot.payment.gateway_refund_card_prompt',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [cardCheck(view.payment.id), mainMenuButton()],
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
   * The customer's answer to the refund-card prompt (Round 6): two lines, validated locally,
   * sealed and queued. The text is used for exactly that and is never logged, echoed or stored
   * — the reply shows the card masked. A bad format reopens the window, so the next message is
   * still read.
   */
  async gatewayRefundCardText(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    capture: { readonly subjectId: string | null },
    text: string,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update?: unknown;
    },
  ): Promise<PendingReply | null> {
    const paymentId = capture.subjectId;
    if (paymentId === null || this.deps.gatewayReceipts === undefined) return null;
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null || view.invoice.botInstanceId !== input.botInstanceId) {
      return {
        key: 'bot.payment.gateway_closed',
        values: {},
        buttons: [mainMenuButton()],
        orderId: null,
      };
    }
    const result = await this.deps.gatewayReceipts.requestRefund(scope, actor, {
      customerId: customer.id,
      paymentId: view.payment.id,
      botInstanceId: input.botInstanceId,
      idempotencyKey: `${input.idempotencyKey}:gateway-refund`,
      text,
    });
    const reference = paymentTrackingCode(view.payment);
    if (result === 'INVALID') {
      const updateId = updateIdOf(input.update);
      await this.deps.captures.open(scope, actor, {
        idempotencyKey: `${input.idempotencyKey}:refund-card-reopen`,
        botInstanceId: input.botInstanceId,
        customerId: customer.id,
        purpose: 'GATEWAY_REFUND_CARD',
        subjectId: view.payment.id,
        ...(updateId === undefined ? {} : { openedUpdateId: updateId }),
      });
      return {
        key: 'bot.payment.gateway_refund_card_invalid',
        values: {},
        buttons: [cardCheck(view.payment.id), mainMenuButton()],
        orderId: view.payment.orderId,
      };
    }
    if (result === 'REFUSED') return this.refusedCardTap(scope, view);
    const refunds = await this.deps.gateway.cardFactsFor(scope, view.invoice);
    return {
      key: 'bot.payment.gateway_refund_requested',
      values: {
        reference,
        ...(refunds?.latestRefund?.refundCardMasked == null
          ? {}
          : { maskedCard: refunds.latestRefund.refundCardMasked }),
      },
      buttons: [cardCheck(view.payment.id), mainMenuButton()],
      orderId: view.payment.orderId,
    };
  }

  /**
   * A refused `gr:`/`gk:` (TPTG-19): a payment still PENDING (a receipt already on its way, a
   * cooldown) or in review / UNKNOWN is redrawn as it stands — the review screens included;
   * anything else that is no longer payable answers `gateway_closed` and nothing more.
   */
  refusedCardTap(
    scope: TenantContext,
    view: GatewayAttemptView,
  ): Promise<PendingReply> | PendingReply {
    if (view.payment.state === 'PENDING' || view.payment.state === 'UNKNOWN') {
      return this.gatewayAttemptReply({ ...view, reissued: true }, view.payment.orderId, scope);
    }
    return {
      key: 'bot.payment.gateway_closed',
      values: { reference: paymentTrackingCode(view.payment) },
      buttons: [mainMenuButton()],
      orderId: null,
    };
  }

  /**
   * A photo for an open provider receipt window in THIS bot (§8.3), or null when none is
   * open — the caller then runs the manual flow exactly as before.
   */
  async gatewayReceiptPhoto(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    file: InboundReceiptFile,
  ): Promise<PendingReply | null> {
    if (this.deps.gatewayReceipts === undefined) return null;
    /*
     * FIX-02 (Codex review of #253): the window's payment, read BEFORE the photo can close it,
     * so a photo that arrives after the window's deadline is answered with the code the
     * invoice carried. Only a read; `receivePhoto` decides everything, again, under its lock.
     */
    const window = await this.deps.gatewayReceipts.openCaptureFor(
      scope,
      botInstanceId,
      customer.id,
    );
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
        return {
          ...reply('bot.payment.gateway_closed'),
          values: await this.ownedTrackingCode(scope, customer, botInstanceId, window?.paymentId),
        };
    }
  }

  /**
   * FIX-02: `{ reference }` for a gateway attempt that is THIS customer's, in THIS bot — the
   * ownership check `attemptFor` makes — else `{}`, whose optional line is then dropped. A
   * payment that is not theirs is never named (TPTG-19).
   */
  async ownedTrackingCode(
    scope: TenantContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    paymentId: string | undefined,
  ): Promise<TemplateValues> {
    if (paymentId === undefined) return {};
    const view = await this.deps.gateway.attemptFor(scope, customer.id, paymentId);
    if (view === null || view.invoice.botInstanceId !== botInstanceId) return {};
    return { reference: paymentTrackingCode(view.payment) };
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
  async transferInstruction(
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
    /*
     * R8 A2: the owner-approved card invoice's first row — the amount in RIAL digits (what
     * must be TRANSFERRED: the payable, with any customer fee, R6 item 4) and the card's
     * sixteen digits without spaces.
     */
    const copies: CustomerButton[] =
      destination === null
        ? []
        : [
            copyRialAmountButton(amountToTransfer(payment)),
            copyCardNumberButton(destination.cardNumber),
          ];

    const switchOffer =
      destination === null || this.deps.cardSwitch === undefined
        ? null
        : await this.deps.cardSwitch.offer(scope, payment);
    const switchCard: CustomerButton[] =
      switchOffer === null || !switchOffer.offered
        ? []
        : [
            {
              ...inlineLabel('payment.switch_card'),
              data: `${PAY_SWITCH_CARD_CALLBACK_PREFIX}${payment.id}.${String(switchOffer.sequence)}`,
              row: CARD_INVOICE_ROW.SWITCH,
            },
          ];

    return {
      key:
        destination === null
          ? 'bot.payment.manual_instructions'
          : 'bot.payment.transfer_instructions',
      values: {
        // R6 item 4: the PAYABLE (principal plus the customer fee when the route charges
        // one). The principal and the fee are shown apart, from this payment's own snapshot.
        total: amountToTransfer(payment),
        ...(payment.customerFee !== null && payment.customerFee.fee.amountMinor > 0n
          ? { principal: payment.amount, fee: payment.customerFee.fee }
          : {}),
        reference: paymentTrackingCode(payment),
        // R8 A2: the amount in rial (Toman beside it) and the deadline's time of day.
        ...cardInvoiceAmountValues(amountToTransfer(payment)),
        ...(payment.expiresAt === null ? {} : { expiresTime: payment.expiresAt }),
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
        /*
         * R4 A1: «🔄 تغییر شماره کارت», only while another enabled card exists and the press
         * limit (when the owner set one) is not reached. Its tap re-decides all of that under
         * the payment's lock; drawing it authorises nothing.
         */
        ...switchCard,
        {
          ...inlineLabel('payment.sent'),
          data: `${PAY_SENT_CALLBACK_PREFIX}${payment.id}`,
          ...(destination === null ? {} : { row: CARD_INVOICE_ROW.ACTIONS }),
        },
        {
          ...inlineLabel('payment.cancel'),
          data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
          ...(destination === null ? {} : { row: CARD_INVOICE_ROW.ACTIONS }),
        },
        // R8 A2: the way home, on its own last row.
        ...(destination === null ? [] : [mainMenuButton()]),
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
  async cancelPaymentAsk(
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
      // FIX-02: the question replaces the invoice; the code it carried stays on the message.
      values: { reference: paymentTrackingCode(payment) },
      buttons: [
        {
          ...inlineLabel('payment.cancel_confirm'),
          data: `${CANCEL_PAY_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId: null,
    };
  }

  async cancelPayment(
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
  /**
   * R4 A1: «🔄 تغییر شماره کارت». The answer is the SAME invoice, edited in place (the tap's
   * wizard gate, `from: ['INVOICE']`), drawn from what the service recorded: the new card when
   * one was switched to, the card recorded now when nothing was (a second tap of one keyboard,
   * the limit reached). The payment, its amount and its tracking code are the invoice's own.
   * A payment no longer an open card-to-card invoice is answered as a stale payment tap is.
   */
  async switchCard(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    expectedSequence: number,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    if (this.deps.cardSwitch === undefined) return staleCallbackReply();
    try {
      const result = await this.deps.cardSwitch.switchCard(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:card-switch`,
        paymentId,
        expectedSequence,
      });
      /*
       * R5C-1: a press that came too early is a notice on the button and nothing else — the
       * invoice stays exactly as it is. A press over a limit is the same notice, and the
       * invoice is redrawn (below) without the button the limit has taken away.
       */
      if (result.outcome === 'COOLDOWN') {
        return {
          key: null,
          values: {},
          buttons: [],
          orderId: null,
          toast: {
            key: 'bot.payment.switch_card_cooldown',
            values: { seconds: result.retryAfterSeconds },
          },
        };
      }
      const refused =
        result.outcome === 'UNCHANGED' && result.reason === 'LIMIT'
          ? { toast: { key: 'bot.payment.switch_card_refused' as const, values: {} } }
          : {};
      const instruction = result.instruction;
      if (instruction === null) {
        return {
          key: 'bot.payment.not_pending',
          values: {},
          buttons: [mainMenuButton()],
          orderId: null,
        };
      }
      return {
        ...(await this.transferInstruction(scope, instruction, instruction.payment.orderId)),
        ...refused,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  async signalTransferSent(
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
          // Roadmap E6: the code the invoice carried stays on the message that replaces it.
          values: { reference: paymentTrackingCode(payment) },
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
        values: {
          minutes: receiptWindow.minutes,
          // FIX-02: this edits the invoice — the code it carried stays on the message.
          reference: paymentTrackingCode(payment),
        },
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
   * A10 (pre-support brief §10, superseding owner spec §2.4 "state 3"): the invoice is
   * edited up to the receipt and no further message is sent until one arrives. On the FIRST
   * receipt filed for the payment, two things happen, in this order:
   *
   * 1. the invoice (at the prompt, or already final) is edited into its final, button-less
   *    state — `bot.payment.received_for_review`, which names the claim and not the file;
   * 2. ONE new message goes out: `bot.payment.receipt_received`, the brief's two sentences.
   *
   * "First" is `ReceiptService`'s answer, decided in the transaction that inserted the
   * payment's first row and FALSE on an idempotent replay — so a redelivered update, a
   * second file, the same file sent again and the fifth file all send nothing new. That is
   * durable state, not memory: two replicas, a restart between deliveries and two files
   * racing all read the same rows. A further receipt still re-asserts the invoice's final
   * state (an edit Telegram answers "not modified" when nothing changed), which is not a new
   * message.
   *
   * No fallback. The notification lane's kinds are a closed set with no payload, and
   * there is no frozen kind that means "your receipt arrived" — inventing one to cover
   * a failed interactive send is what ADR-0030 §1 refuses.
   */
  async submitReceipt(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    chatId: string | null,
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
      /*
       * BEST EFFORT, and that is load-bearing. The receipt has committed: a throw here (the
       * wizard row's write refused by a recovery quiesce, a guard, a lost connection) would
       * fail the turn, and its redelivery answers `first: false` — so the one new message
       * would never go out, or a refusal would be shown for a receipt that was filed. The
       * invoice keeps its prompt instead, and the failure is logged rather than swallowed.
       */
      if (chatId !== null) {
        try {
          await this.finaliseReceiptInvoice(
            scope,
            actor,
            botInstanceId,
            chatId,
            customer.id,
            submitted.paymentId,
            idempotencyKey,
          );
        } catch (error) {
          this.deps.logger?.error(
            { err: error, paymentId: submitted.paymentId, tenantId: scope.tenantId },
            'receipt invoice finalisation failed; the receipt is filed and its message still goes',
          );
        }
      }
      if (!submitted.first) return { key: null, values: {}, buttons: [], orderId: null };
      return { key: 'bot.payment.receipt_received', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return receiptRefusal(error);
    }
  }

  /**
   * A10: the invoice of THIS payment in this chat, waiting at the receipt prompt (or already
   * final), edited into its final state with NO button — no status check, no resend, no
   * cancel, no copy, no card details. Either kind (`ORDER` or `TOPUP`).
   *
   * Claimed through `claimLatest`, which skips a wizard another turn holds: the
   * «پرداخت را انجام دادم» turn lands its prompt HELD until the prompt is on the message
   * (Codex 4170910529), and `settleReceiptPrompt` ends that message in this same state once
   * it releases the hold. With no such message — an invoice from before R2, or one already
   * moved on — nothing is edited, and the new message alone answers the receipt. A refused
   * edit is not re-sent as a new message: the new message is the one the customer is owed.
   */
  async finaliseReceiptInvoice(
    scope: TenantContext,
    actor: ActorContext,
    botInstanceId: BotInstanceId,
    chatId: string,
    customerId: UserId,
    paymentId: PaymentId,
    updateKey: string,
  ): Promise<void> {
    const state = this.deps.messageState;
    if (state === undefined) return;
    const target = await state.claimLatest(scope, actor, {
      botInstanceId,
      chatId,
      kind: null,
      steps: ['RECEIPT_WAIT', 'RECEIPT_REVIEW'],
      subjectId: null,
      paymentId,
      updateKey,
    });
    if (target === null) return;
    const landed = await state.land(scope, actor, target, {
      kind: target.kind,
      step: 'RECEIPT_REVIEW',
      subjectId: target.subjectId,
      paymentId,
      updateKey,
    });
    if (!landed) return;
    await editSent(
      this.deps.messenger,
      scope,
      {
        chatId: target.chatId,
        messageId: target.messageId,
        botInstanceId: target.botInstanceId,
        templateKey: RECEIPT_INVOICE_FINAL_KEY,
        values: await this.receiptInvoiceFinalValues(scope, actor, customerId, paymentId),
        buttons: [],
      },
      false,
    );
  }

  /**
   * Roadmap E6: what the invoice's final state renders — the payment's tracking code, so the
   * one code the customer quotes is still in the chat after the invoice that first carried
   * it is edited. An unreadable code drops the line (the template's optional token), never
   * the edit.
   */
  async receiptInvoiceFinalValues(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    paymentId: PaymentId,
  ): Promise<TemplateValues> {
    /*
     * Never the reason the edit does not happen (review of PR #243, m4): the wizard is
     * already marked final when this runs, so a throw here would leave the prompt on the
     * message with nothing left to retry it. An unreadable code drops the line instead.
     */
    try {
      const reference = await this.deps.receipts.trackingCodeForCustomer(
        scope,
        actor,
        customerId,
        paymentId,
      );
      return reference === null ? {} : { reference };
    } catch (error) {
      this.deps.logger?.error(
        { err: error, paymentId, tenantId: scope.tenantId },
        'reading the tracking code for the final invoice failed; edited without it',
      );
      return {};
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
  async cancelOrderAsk(
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
  async cancelOrder(
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
  refOf(
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
  async editWizard(
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
   * and edited nothing (its one new message went out regardless — A10); this is what still
   * ends the invoice in its final state. It sends no new message: that is the receipt
   * turn's, keyed on the receipt being the payment's first.
   */
  async settleReceiptPrompt(
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
    if (moved.length === 0) return;
    const values = await this.receiptInvoiceFinalValues(
      scope,
      actor,
      prompt.customerId as UserId,
      prompt.paymentId as PaymentId,
    );
    for (const wizard of moved) {
      await editSent(
        this.deps.messenger,
        scope,
        {
          chatId: wizard.chatId,
          messageId: wizard.messageId,
          botInstanceId: wizard.botInstanceId,
          templateKey: RECEIPT_INVOICE_FINAL_KEY,
          values,
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
  async finaliseReview(
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
  async editReviewRecord(
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
  async finalReviewRecord(
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
  async reviewerActor(
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
  async repeatedReviewToast(
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

  async stopSpinner(
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
  async editOrSend(
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
 * R5C-1 item 4: the sentence the payment message carries once the wallet has paid. A renewal
 * and a package say the action is on its way (the same message is then edited into the result:
 * the renewal's result, or the package's receipt); everything else keeps `bot.order.settled`.
 */
export function settledKeyFor(purpose: OrderPurpose): TemplateKey {
  if (purpose === 'RENEW') return 'bot.service.renew_paid';
  if (purpose === 'ADD_TRAFFIC' || purpose === 'ADD_TIME') return 'bot.service.addon_paid';
  return 'bot.order.settled';
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
  // FIX-02: the payment's one public code, on the invoice before anything is paid.
  const reference = paymentTrackingCode(payment);
  if (fee !== null && fee.fee.amountMinor > 0n) {
    return {
      key:
        payment.orderId === null
          ? 'bot.payment.stars_invoice_topup_fee'
          : 'bot.payment.stars_invoice_order_fee',
      values: {
        principal: payment.amount,
        fee: fee.fee,
        payable: fee.payable,
        stars,
        expiresAt,
        reference,
      },
    };
  }
  return {
    key:
      payment.orderId === null
        ? 'bot.payment.stars_invoice_topup'
        : 'bot.payment.stars_invoice_order',
    values: { payable: fee?.payable ?? payment.amount, stars, expiresAt, reference },
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
  // FIX-02: every screen of this attempt quotes the same public code.
  const reference = paymentTrackingCode(payment);
  if (invoice.creationErrorCode !== null) {
    // Created without a card: it cannot be paid from here, and a new attempt is the way on.
    return {
      key: 'bot.payment.gateway_card_missing',
      values: { reference },
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
  // R8 A2: the owner-approved rows — copies, the card switch, receipt and cancel, main menu.
  const receipt: CustomerButton = {
    ...inlineLabel('payment.gateway_receipt'),
    data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  const change: CustomerButton = {
    ...inlineLabel('payment.gateway_change_card'),
    data: `${GATEWAY_CARD_CHANGE_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.SWITCH,
  };
  const cancelRequest = facts?.latestCancel ?? null;
  const cancel: CustomerButton = {
    ...inlineLabel('payment.gateway_cancel'),
    data: `${GATEWAY_CANCEL_ASK_CALLBACK_PREFIX}${payment.id}`,
    row: CARD_INVOICE_ROW.ACTIONS,
  };
  /*
   * R6 item 2: TonPays approves automatically only on the EXACT amount it named (its odd
   * `final_amount`), so that is what the customer is told and what the copy button carries.
   * When TonPays named none, the exact amount IS what Nexa asked for - `sentAmount`, the
   * payable in the provider's own unit (Toman), never the payment-currency payable (an IRR
   * payment would show rial as Toman). R8 A2: shown in RIAL (Toman beside it) and copied as
   * bare rial digits. It is display and clipboard only: what Nexa settles, credits and
   * refunds is still the payment's own principal.
   */
  const exact = money(
    invoice.finalAmount !== null ? invoice.finalAmount : invoice.sentAmount,
    invoice.providerUnit === 'IRR' ? 'IRR' : 'IRT',
  );
  const transferAmount = plainAmount(exact);
  const copyExact = copyRialAmountButton(exact);
  const copyCard = invoice.cardNumber === null ? null : copyCardNumberButton(invoice.cardNumber);
  /*
   * R8 A2: «🔄 تعویض کارت» is drawn while a change is allowed now OR after a cooldown — the
   * invoice is drawn the moment its card arrives, inside the first minute, so a button that
   * waited for the cooldown to pass was never on the screen. The tap decides again under the
   * payment's lock and answers a cooldown with the seconds left. The owner's R5C-1 limits
   * (`changeAllowance`) bound it like the manual switch.
   */
  const menu = mainMenuButton();
  const actions = [
    copyExact,
    ...(copyCard === null ? [] : [copyCard]),
    ...(facts !== null &&
    windowOpen &&
    cardChangeOffered(invoice, latest, at, facts.changeAllowance ?? null)
      ? [change]
      : []),
    ...(facts !== null && windowOpen && receiptUploadAvailable(invoice, submissions)
      ? [receipt]
      : []),
    ...(facts !== null && windowOpen && cancelAvailable(invoice, cancelRequest, submissions)
      ? [cancel]
      : []),
    menu,
  ];
  const copies = (button: CustomerButton): boolean => button !== copyExact && button !== copyCard;
  const brief = {
    payable,
    transferAmount,
    expiresAt,
    expiresTime: expiresAt,
    reference,
    ...cardInvoiceAmountValues(exact),
  };
  // Round 6: a cancel with the provider, or one it refused / lost and no inquiry has answered since.
  if (cancelRequest !== null) {
    const cancelKey = cancelNoticeKey(cancelRequest, invoice);
    if (cancelKey !== null) {
      return {
        key: cancelKey,
        values: { reference },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard,
      };
    }
  }
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
      // No copy buttons: the new card may carry a new exact amount, copied once it shows.
      buttons: actions.filter(copies),
      orderId,
      wizard,
    };
  }
  if (invoice.cardNumber === null) {
    // The last card change's answer was lost: no card is shown, never a stale one.
    return {
      key: 'bot.payment.gateway_card_unconfirmed',
      values: brief,
      // No card is shown, so no exact amount is offered for copying either. Its text offers a
      // status check, so the check stays on this one screen.
      buttons: [
        ...actions.filter((button) => copies(button) && button !== menu),
        cardCheck(payment.id),
        menu,
      ],
      orderId,
      wizard,
    };
  }
  const card = {
    cardNumber: invoice.cardNumber,
    ...cardInvoiceCardValues(invoice.cardNumber),
    ...(invoice.cardName === null ? {} : { cardName: invoice.cardName }),
  };
  if (newest !== null && (newest.state === 'REFUSED' || newest.state === 'ABANDONED')) {
    // Round 6: the provider's own words for an empty image or a receipt it could not match.
    const refusedKey = customerMessageKeyOfError(newest.errorCode);
    return {
      key:
        refusedKey === 'bot.payment.gateway_card_receipt_empty' ||
        refusedKey === 'bot.payment.gateway_card_receipt_invoice'
          ? refusedKey
          : 'bot.payment.gateway_card_receipt_refused',
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
 * The notice a customer's cancel request leaves on the invoice (Round 6): "cancelling…" while
 * it is with the provider; the provider's refusal or a lost answer until the next inquiry has
 * answered (that inquiry says what the invoice is now, and replaces the notice). A request that
 * was applied, rate-limited, or answered before the latest inquiry leaves none.
 */
function cancelNoticeKey(
  request: GatewayProviderRequestRecord,
  invoice: Pick<GatewayInvoiceRecord, 'lastInquiryAt'>,
): TemplateKey | null {
  if (request.state === 'REQUESTED' || request.state === 'SENT') {
    return 'bot.payment.gateway_cancel_requested';
  }
  const answeredSince =
    request.decidedAt !== null &&
    invoice.lastInquiryAt !== null &&
    invoice.lastInquiryAt.getTime() >= request.decidedAt.getTime();
  if (answeredSince) return null;
  if (request.state === 'UNKNOWN') return 'bot.payment.gateway_cancel_unknown';
  if (request.state === 'REFUSED') {
    const key = customerMessageKeyOfError(request.errorCode);
    // Only the cancel refusals have a sentence of their own here; others change nothing.
    return key !== null &&
      (key.startsWith('bot.payment.gateway_cancel_not_allowed_') ||
        key === 'bot.payment.gateway_not_pending')
      ? key
      : null;
  }
  return null;
}

/**
 * An under- or overpaid TonPays Telegram invoice (Round 6): `action_required_less` shows the
 * remainder, the card to pay it to (tap-to-copy buttons for the card and the exact amount) and
 * «📤 ارسال رسید مابقی»; `action_required_more` asks for the refund card. Null for any other
 * status — and for one whose settlement deadline has passed. Every figure is TonPays' own
 * instruction to the customer; none of it is what Nexa settles, credits or refunds.
 */
function providerNeedScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  at: Date,
  facts: GatewayCardFacts,
): PendingReply | null {
  const less = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_LESS;
  const more = invoice.providerStatus === TONPAYS_TELEGRAM_STATUS_MORE;
  if (!less && !more) return null;
  const deadline = gatewaySettlementDeadline(payment);
  if (payment.state !== 'PENDING' || deadline === null || at.getTime() >= deadline.getTime()) {
    return null;
  }
  const kind = payment.orderId === null ? ('TOPUP' as const) : ('ORDER' as const);
  const wizard = { kind, step: 'INVOICE' as const, paymentId: payment.id };
  const reference = paymentTrackingCode(payment);
  const provider = facts.providerFacts ?? null;
  const base = { expiresAt: deadline, reference };
  const tail = [cardCheck(payment.id), mainMenuButton()];
  const submissions = facts.submissions;
  if (less) {
    const shortfall =
      provider?.remainingAmount == null
        ? {}
        : { shortfall: money(provider.remainingAmount, 'IRT') };
    // Only a receipt aimed at the REMAINDER invoice says the remainder was paid: the original's
    // accepted receipt is how the shortfall was found, not an answer to it.
    const remainderNewest =
      provider?.remainingInvoiceId == null
        ? null
        : (submissions
            .filter((one) => one.providerInvoiceId === provider.remainingInvoiceId)
            .at(-1) ?? null);
    const sending =
      (remainderNewest !== null &&
        (remainderNewest.state === 'QUEUED' ||
          remainderNewest.state === 'SENDING' ||
          remainderNewest.state === 'ACCEPTED' ||
          (remainderNewest.state === 'UNKNOWN' && remainderNewest.inquiryResolvedAt === null))) ||
      provider?.remainingReceiptReceived === true;
    if (sending) {
      return {
        key: 'bot.payment.gateway_card_underpaid_receipt_sent',
        values: { ...base, ...shortfall },
        buttons: tail,
        orderId,
        wizard,
      };
    }
    if (
      provider === null ||
      provider.remainingAmount === null ||
      provider.remainingCardNumber === null ||
      provider.remainingInvoiceId === null
    ) {
      // TonPays said "less" without a usable remainder: nothing is invented.
      return {
        key: 'bot.payment.gateway_card_underpaid_unavailable',
        values: base,
        buttons: tail,
        orderId,
        wizard,
      };
    }
    const amount = money(provider.remainingAmount, 'IRT');
    const offerReceipt = remainderReceiptAvailable(invoice, provider, submissions);
    return {
      key: 'bot.payment.gateway_card_underpaid',
      values: {
        ...base,
        shortfall: amount,
        cardNumber: provider.remainingCardNumber,
        ...(provider.remainingCardHolder === null
          ? {}
          : { cardName: provider.remainingCardHolder }),
      },
      buttons: [
        { ...inlineLabel('payment.copy_card'), copyText: provider.remainingCardNumber, row: 0 },
        { ...inlineLabel('payment.copy_amount'), copyText: plainAmount(amount), row: 0 },
        ...(offerReceipt
          ? [
              {
                ...inlineLabel('payment.gateway_remainder_receipt'),
                data: `${GATEWAY_RECEIPT_CALLBACK_PREFIX}${payment.id}`,
              },
            ]
          : []),
        ...tail,
      ],
      orderId,
      wizard,
    };
  }
  // action_required_more
  const refundAmount =
    provider?.refundAmount == null ? {} : { refundAmount: money(provider.refundAmount, 'IRT') };
  const latest = facts.latestRefund ?? null;
  const masked = latest?.refundCardMasked == null ? {} : { maskedCard: latest.refundCardMasked };
  const retryCard: CustomerButton = {
    ...inlineLabel('payment.gateway_refund_card'),
    data: `${GATEWAY_REFUND_CARD_CALLBACK_PREFIX}${payment.id}`,
  };
  if (
    (latest !== null && (latest.state === 'REQUESTED' || latest.state === 'SENT')) ||
    provider?.refundPending === true ||
    latest?.state === 'APPLIED'
  ) {
    return {
      key: 'bot.payment.gateway_card_overpaid_pending',
      values: { ...base, ...refundAmount, ...masked },
      buttons: tail,
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'UNKNOWN') {
    return {
      key: 'bot.payment.gateway_refund_unknown',
      values: { reference },
      buttons: [retryCard, ...tail],
      orderId,
      wizard,
    };
  }
  if (latest !== null && latest.state === 'REFUSED') {
    const key = customerMessageKeyOfError(latest.errorCode);
    if (
      key === 'bot.payment.gateway_refund_not_allowed' ||
      key === 'bot.payment.gateway_refund_already_open'
    ) {
      return { key, values: { reference }, buttons: tail, orderId, wizard };
    }
    if (
      key === 'bot.payment.gateway_refund_card_refused' ||
      key === 'bot.payment.gateway_refund_holder_refused'
    ) {
      return { key, values: { reference }, buttons: [retryCard, ...tail], orderId, wizard };
    }
  }
  return {
    key: 'bot.payment.gateway_card_overpaid',
    values: { ...base, ...refundAmount },
    buttons: [...(refundCardAvailable(invoice, provider, latest) ? [retryCard] : []), ...tail],
    orderId,
    wizard,
  };
}

/**
 * A FAILED card-transfer attempt that deserves its own words (Round 6): one the customer
 * cancelled, one TonPays rejected WITH reasons (shown as TonPays worded them, sanitised), and
 * a create TonPays refused because the buyer already holds an open invoice (the invoice that
 * blocks is one tap away when Nexa knows it). Null for everything else.
 */
function failedCardScreen(
  payment: PaymentRecord,
  invoice: GatewayInvoiceRecord,
  orderId: string | null,
  facts: GatewayCardFacts | null,
  screen: (
    key: TemplateKey,
    buttons: readonly CustomerButton[],
    step: WizardDirective['step'],
    pending?: boolean,
  ) => PendingReply,
): PendingReply | null {
  if (PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceForm !== 'CARD_TRANSFER') return null;
  const retry: CustomerButton =
    payment.orderId === null ? topupButton() : payMethodsButton(payment.orderId);
  if (facts?.latestCancel?.state === 'APPLIED') {
    return screen('bot.payment.gateway_cancelled', [retry], 'NOTICE');
  }
  if (invoice.creationState === 'CREATE_FAILED' && isBuyerConflictCode(invoice.creationErrorCode)) {
    const key = customerMessageKeyOfError(invoice.creationErrorCode);
    if (key === null) return null;
    const open = facts?.openElsewherePaymentId ?? null;
    return screen(
      key,
      [
        ...(open === null
          ? []
          : [
              {
                ...inlineLabel('payment.gateway_open_invoice'),
                data: `${GATEWAY_CHECK_CALLBACK_PREFIX}${open}`,
              },
            ]),
        retry,
      ],
      'NOTICE',
    );
  }
  const reasons = facts?.providerFacts?.rejectReasons ?? [];
  if (reasons.length > 0) {
    return {
      ...screen('bot.payment.gateway_card_rejected', [retry], 'NOTICE'),
      values: { reasons: reasons.join('\n'), reference: paymentTrackingCode(payment) },
    };
  }
  return null;
}

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
  /*
   * TetraPay has no review window either: it reaches UNKNOWN only when a verify said `paid` for
   * an amount, order id or receipt that does not match the payment, which its own sentence says.
   */
  TETRAPAY: {
    inReview: 'bot.payment.gateway_in_review',
    unresolved: 'bot.payment.tetrapay_review_unresolved',
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

/**
 * The screen for a TetraPay create refusal the customer can act on, or null for any other code.
 * Pure: the code is what the attempt recorded (`tetrapay.DAILY_LIMIT_REACHED`, or
 * `tetrapay.AMOUNT_OUT_OF_RANGE:<min Toman>:<max Toman>` with 0 for a bound not stated).
 */
export function tetrapayRefusalScreen(
  code: string | null,
  reference: string,
  retry: CustomerButton,
  orderId: string | null,
  kind: 'ORDER' | 'TOPUP',
  paymentId: string,
): PendingReply | null {
  if (code === null) return null;
  const wizard = { kind, step: 'NOTICE' as const, paymentId };
  if (code === TETRAPAY_DAILY_LIMIT_STORED) {
    return {
      key: 'bot.payment.tetrapay_daily_limit',
      values: { reference },
      buttons: [retry, mainMenuButton()],
      orderId,
      wizard,
    };
  }
  const range = new RegExp(
    `^${TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED.replace('.', '\\.')}:(\\d{1,18}):(\\d{1,18})$`,
    'u',
  ).exec(code);
  if (range === null) return null;
  const min = BigInt(range[1] ?? '0');
  const max = BigInt(range[2] ?? '0');
  return {
    key: 'bot.payment.tetrapay_amount_out_of_range',
    // A bound the provider did not state (0) is left out, and its line is dropped with it.
    values: {
      reference,
      ...(min > 0n ? { min: money(min, 'IRT') } : {}),
      ...(max > 0n ? { max: money(max, 'IRT') } : {}),
    },
    buttons: [retry, mainMenuButton()],
    orderId,
    wizard,
  };
}

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
  /*
   * FIX-02: the payment's ONE public tracking code, on every screen of this attempt — the
   * preparing screen, the invoice, the review and every end — computed from the payment's
   * own stored reference, so a re-render, a worker edit or a replayed tap shows the same code.
   */
  const reference = paymentTrackingCode(payment);
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
    values: { reference },
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
   * R5A item 4: the gateway approved after the payment closed and the amount went to the
   * wallet. Decided BEFORE the unresolved / closed / failed screens below, which would all
   * still tell this customer the payment is open, expired or lost. It offers no way to pay.
   */
  if (invoice.outcome === 'LATE_CREDITED') {
    return screen('bot.payment.gateway_late_credited_screen', [], 'CLOSED');
  }
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
  /*
   * Round 6: an under- or overpaid invoice is never shown as plain open (or "in review"): it
   * has a next step, decided from what the provider's latest inquiry said. Before the review
   * and closed tests because a review window may be what the invoice is inside when the
   * provider finds the mismatch.
   */
  if (cardFacts !== null && invoice.creationState === 'CREATED') {
    const needed = providerNeedScreen(payment, invoice, orderId, at, cardFacts);
    if (needed !== null) return needed;
  }
  const reviewUntil = payment.providerReviewUntil ?? null;
  if (payment.state === 'PENDING' && reviewUntil !== null) {
    if (reviewUntil.getTime() > at.getTime()) {
      return {
        key: reviewKeys.inReview,
        values: {
          payable: payment.customerFee?.payable ?? payment.amount,
          reviewUntil,
          reference,
        },
        buttons: [cardCheck(payment.id), mainMenuButton()],
        orderId,
        wizard: { kind, step: 'INVOICE', paymentId: payment.id },
      };
    }
    // Lapsed and not yet swept: the same truth the sweep is about to record.
    return screen(reviewKeys.unresolved, [], 'INVOICE');
  }
  /*
   * TetraPay's two create refusals a customer can act on: the daily limit (the route is hidden
   * until 00:00 Tehran) and an amount outside the provider's range (its own bounds, in Toman).
   * Read from the code the attempt recorded; every other refusal keeps the generic sentence.
   */
  const refusal =
    invoice.creationState === 'CREATE_FAILED'
      ? tetrapayRefusalScreen(
          invoice.creationErrorCode,
          reference,
          retry,
          orderId,
          kind,
          payment.id,
        )
      : null;
  if (refusal !== null && (payment.state === 'FAILED' || payment.state === 'PENDING')) {
    return refusal;
  }
  if (payment.state === 'FAILED') {
    // Round 6: the customer's own cancel, a rejection with reasons, a buyer with another invoice.
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
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
   *
   * B12: no «check payment status» button here. A Stars payment settles from Telegram's own
   * `successful_payment`, never from a status read, so the button could only ever answer
   * "still waiting"; the invoice message's Pay button (Telegram's own, the first and only
   * button of an invoice sent with no keyboard) is the one action, and the way back stays.
   */
  if (
    PAYMENT_GATEWAY_DESCRIPTORS[invoice.provider].invoiceCredential === 'BOT_TOKEN' &&
    (invoice.creationState === 'CREATING' || invoice.creationState === 'CREATED')
  ) {
    return {
      ...starsInvoiceBody(payment, invoice.sentAmount),
      buttons: [mainMenuButton()],
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
    const failed = failedCardScreen(payment, invoice, orderId, cardFacts, screen);
    if (failed !== null) return failed;
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
            reference,
          },
        }
      : {
          key: 'bot.payment.gateway_invoice',
          values: { total: payment.amount, expiresAt: payment.expiresAt, reference },
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
 * A10: the invoice's FINAL text once a receipt is on the payment, edited in, with no button.
 * The claim's sentence — recorded, nothing received or verified, a person will check — and
 * NOT `bot.payment.receipt_received`, which is the one new message the first receipt sends:
 * the same two sentences twice, one above the other, would be noise.
 */
const RECEIPT_INVOICE_FINAL_KEY: TemplateKey = 'bot.payment.received_for_review';

/**
 * R2: a wallet refusal the customer acts on and comes back from — too little balance, a
 * transfer already under review — goes out as its OWN message, so the pre-invoice it answers
 * stays on screen and payable once they have topped up.
 */
const WALLET_SHORT: WizardDirective = { kind: 'ORDER', step: 'PREINVOICE', placement: 'NEW' };

/** The one trial refusal, with the way back to the main menu. */
/** The GB bounds a custom-service volume question and its refusal quote (B1). */
export function volumeRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minGb: string;
  maxGb: string;
} {
  return {
    minGb: formatCustomServiceVolume(range.min),
    maxGb: formatCustomServiceVolume(range.max),
  };
}

/** The day bounds a custom-service days question and its refusal quote (B1). */
export function daysRangeValues(range: { readonly min: bigint; readonly max: bigint }): {
  minDays: string;
  maxDays: string;
} {
  return { minDays: range.min.toString(), maxDays: range.max.toString() };
}

function trialUnavailable(): PendingReply {
  return { key: 'bot.trial.unavailable', values: {}, buttons: [mainMenuButton()], orderId: null };
}

function topupButton(): CustomerButton {
  return {
    ...inlineLabel('wallet.topup'),
    data: TOPUP_MENU_CALLBACK_PREFIX,
  };
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
