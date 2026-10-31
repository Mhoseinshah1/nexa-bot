import { z } from 'zod';
import type { OpsLogTopicCategory } from './ops-log-group.js';
import { paymentMethodSlugOf } from './payment-gateways.js';
import type { PlaceholderDefinition, PlaceholderType, TemplateDefinition } from './templates.js';

/**
 * Round 4 PR-D — the operations log group's LOG TYPES.
 *
 * The owner reviewed every message the group receives, one by one (Appendix L, L1–L31), and
 * gave each a decision. A log type is the unit of that review: it has ONE template key per
 * rendering (editable in «متن‌ها»), ONE topic, and ONE on/off switch in «گروه گزارش‌های
 * مدیریتی». This file is the registry that ties the three together, so a type cannot have a
 * message without a switch or a switch without a topic.
 *
 * The switch is stored as the list of types switched OFF (`ops.log.disabled_types`), not as
 * one boolean per type: a type added by a later release is ON until somebody turns it off,
 * and a stored list that names a type this release does not know still parses.
 *
 * L30 (the automatic cleanup) is deliberately not a type: the owner decided it is one line
 * inside the nightly report, never a message of its own.
 */

// ---------------------------------------------------------------------------
// The types
// ---------------------------------------------------------------------------

export const OPS_LOG_TYPE_IDS = [
  // PAYMENTS
  'PAYMENT_TOPUP', // L1
  'PAYMENT_ORDER', // L2
  'PAYMENT_CRYPTO', // L3
  'PAYMENT_FAILED', // L4
  'PAYMENT_LATE', // L5
  'REFUND', // L6
  'ADMIN_WALLET', // L7
  'REFERRAL_COMMISSION', // L8
  'SIGNUP_GIFT', // L9
  // SERVICES
  'SERVICE_CREATED', // L10
  'SERVICE_CREATED_WALLET', // L11
  'SERVICE_RENEWED', // L12
  'TRAFFIC_ADDED', // L13
  'TIME_ADDED', // L14
  'LINK_CHANGED', // L15
  'TRIAL_CREATED', // L16
  // USERS
  'USER_NEW', // L17
  'USER_BLOCK', // L18
  // SECURITY
  'ADMIN_CHANGED', // L19
  // USERS
  'RESELLER_CHANGED', // L20
  // SERVICES
  'SERVICE_ALERT', // L21
  // ERRORS
  'ERROR_PAYMENT_LINK', // L22
  'ERROR_PROVISION', // L23
  'ERROR_OPERATION', // L24
  // PANELS
  'PANEL_STATE', // L25
  // BOT
  'TICKET_NEW', // L26
  // REPORTS
  'REPORT_SUMMARY', // L27
  'REPORT_FINANCIAL', // L28
  'REPORT_PANELS', // L29
  // BACKUPS
  'BACKUP_FILE', // L31
  // PAYMENTS — added after the Appendix L review
  'GIFT_CARD', // R10 D4
] as const;
export type OpsLogTypeId = (typeof OPS_LOG_TYPE_IDS)[number];

export const opsLogTypeIdSchema = z.enum(OPS_LOG_TYPE_IDS);

export interface OpsLogTypeDefinition {
  /** The Appendix L item this type implements. */
  readonly l: string;
  /** The topic its messages are posted to. */
  readonly topic: OpsLogTopicCategory;
  /** Every template key the type renders. The first is its main one. */
  readonly templates: readonly string[];
  /**
   * Whether the type is an ERROR report whose identical repeats the optional storm roll-up
   * may merge (`ops.log.storm_rollup_enabled`). Every other type is never rolled up.
   */
  readonly storm?: true;
}

export const OPS_LOG_TYPES = {
  PAYMENT_TOPUP: { l: 'L1', topic: 'PAYMENTS', templates: ['ops.financial.topup_credited'] },
  PAYMENT_ORDER: { l: 'L2', topic: 'PAYMENTS', templates: ['ops.financial.order_paid'] },
  PAYMENT_CRYPTO: { l: 'L3', topic: 'PAYMENTS', templates: ['ops.log.payment_crypto'] },
  /*
   * R8 A3: one headline per outcome — a failure, a cancelled invoice, a rejected receipt, an
   * expired payment. Four templates of ONE type: one switch, one topic, as before.
   */
  PAYMENT_FAILED: {
    l: 'L4',
    topic: 'PAYMENTS',
    templates: [
      'ops.financial.payment_failed',
      'ops.financial.invoice_cancelled',
      'ops.financial.receipt_rejected',
      'ops.financial.payment_expired',
      /*
       * R9 C1: an OPEN attempt the gateway reported paid LESS (a remainder is owed) or MORE (a
       * refund card is owed) than the invoice. Not a failure — nothing ended — but the same
       * switch: the operator reads "this payment did not go as invoiced" in one place.
       */
      'ops.financial.payment_underpaid',
      'ops.financial.payment_overpaid',
    ],
  },
  PAYMENT_LATE: {
    l: 'L5',
    topic: 'PAYMENTS',
    templates: [
      'ops.financial.late_completion',
      'ops.financial.outcome_unknown',
      'ops.financial.late_credit',
      // R12 F1: money for an attempt that could no longer pay its order, returned to the wallet.
      'ops.financial.late_credit_returned',
      // R9 C1: the provider's webhook `credit_amount` differs from what Nexa invoiced.
      'ops.financial.credit_amount_mismatch',
    ],
  },
  REFUND: {
    l: 'L6',
    topic: 'PAYMENTS',
    templates: [
      'ops.financial.refund_completed',
      'ops.financial.refund_failed',
      'ops.financial.service_refund_request',
    ],
  },
  ADMIN_WALLET: {
    l: 'L7',
    topic: 'PAYMENTS',
    // R8 A4: a mass credit is one summary message per operation, never one per customer.
    templates: ['ops.log.wallet_adjusted', 'ops.log.wallet_mass_credited'],
  },
  REFERRAL_COMMISSION: {
    l: 'L8',
    topic: 'PAYMENTS',
    templates: ['ops.log.referral_commission'],
  },
  SIGNUP_GIFT: { l: 'L9', topic: 'PAYMENTS', templates: ['ops.log.signup_gift'] },
  SERVICE_CREATED: { l: 'L10', topic: 'SERVICES', templates: ['ops.log.service_created'] },
  SERVICE_CREATED_WALLET: {
    l: 'L11',
    topic: 'SERVICES',
    templates: ['ops.log.service_created_wallet'],
  },
  SERVICE_RENEWED: { l: 'L12', topic: 'SERVICES', templates: ['ops.log.service_renewed'] },
  TRAFFIC_ADDED: { l: 'L13', topic: 'SERVICES', templates: ['ops.log.traffic_added'] },
  TIME_ADDED: { l: 'L14', topic: 'SERVICES', templates: ['ops.log.time_added'] },
  LINK_CHANGED: { l: 'L15', topic: 'SERVICES', templates: ['ops.log.link_changed'] },
  TRIAL_CREATED: { l: 'L16', topic: 'SERVICES', templates: ['ops.log.trial_created'] },
  USER_NEW: { l: 'L17', topic: 'USERS', templates: ['ops.log.user_new'] },
  USER_BLOCK: { l: 'L18', topic: 'USERS', templates: ['ops.log.user_blocked'] },
  ADMIN_CHANGED: { l: 'L19', topic: 'SECURITY', templates: ['ops.log.admin_changed'] },
  RESELLER_CHANGED: { l: 'L20', topic: 'USERS', templates: ['ops.log.reseller_changed'] },
  SERVICE_ALERT: { l: 'L21', topic: 'SERVICES', templates: ['ops.log.service_alert'] },
  ERROR_PAYMENT_LINK: {
    l: 'L22',
    topic: 'ERRORS',
    templates: ['ops.notification.payment_link_failed'],
    storm: true,
  },
  ERROR_PROVISION: {
    l: 'L23',
    topic: 'ERRORS',
    // R9 C2: a service an administrator created from the Web Admin has a message of its own.
    templates: ['ops.log.error_provision', 'ops.log.error_provision_admin'],
    storm: true,
  },
  ERROR_OPERATION: {
    l: 'L24',
    topic: 'ERRORS',
    templates: ['ops.log.error_operation'],
    storm: true,
  },
  PANEL_STATE: {
    l: 'L25',
    topic: 'PANELS',
    templates: ['ops.log.panel_down', 'ops.log.panel_up'],
  },
  TICKET_NEW: {
    l: 'L26',
    topic: 'BOT',
    templates: ['ops.support.ticket_opened', 'ops.support.customer_replied'],
  },
  REPORT_SUMMARY: { l: 'L27', topic: 'REPORTS', templates: ['ops.log.report_summary'] },
  REPORT_FINANCIAL: { l: 'L28', topic: 'REPORTS', templates: ['ops.log.report_financial'] },
  REPORT_PANELS: { l: 'L29', topic: 'REPORTS', templates: ['ops.log.report_panels'] },
  BACKUP_FILE: { l: 'L31', topic: 'BACKUPS', templates: ['ops.log.backup_caption'] },
  /*
   * R10 D4: gift cards. A redemption (a wallet credit through the ledger) and a batch minted (a
   * liability created in one act). One switch, the PAYMENTS topic, beside the signup gift.
   */
  GIFT_CARD: {
    l: 'R10-D4',
    topic: 'PAYMENTS',
    templates: ['ops.log.gift_card_redeemed', 'ops.log.gift_card_batch_created'],
  },
} as const satisfies Record<OpsLogTypeId, OpsLogTypeDefinition>;

export function opsLogTypeTopic(id: OpsLogTypeId): OpsLogTopicCategory {
  return OPS_LOG_TYPES[id].topic;
}

/** Whether the type is an error report the optional storm roll-up may merge. */
export function opsLogTypeIsStorm(id: OpsLogTypeId): boolean {
  return (OPS_LOG_TYPES[id] as OpsLogTypeDefinition).storm === true;
}

/** The type a template key renders, or null for a key that is no log type's (a test send). */
export function opsLogTypeOfTemplate(templateKey: string): OpsLogTypeId | null {
  for (const id of OPS_LOG_TYPE_IDS) {
    if ((OPS_LOG_TYPES[id].templates as readonly string[]).includes(templateKey)) return id;
  }
  return null;
}

/**
 * Which types are switched on, given the stored list of the ones switched OFF. A name in the
 * list that is not a type this release knows is ignored, never an error: a later release may
 * have written it.
 */
export function opsLogTypeEnabled(disabled: readonly string[], id: OpsLogTypeId): boolean {
  return !disabled.includes(id);
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

/**
 * The inline URL buttons a log message may carry. A button names WHAT it opens and the
 * record's id; the dispatcher turns that into the Web Admin address at send time, so an
 * address is never stored in a notification and a change of the admin's host applies to
 * messages still waiting in the queue.
 */
export const OPS_LOG_BUTTON_KINDS = [
  'USER',
  'PAYMENT',
  'ORDER',
  'SERVICE',
  'PANEL',
  'GATEWAY',
  'TICKET',
  'MANUAL_CREDIT',
  // R8 A4: «🧾 تراکنش» — the customer's wallet (the financial tab of their page).
  'WALLET',
  // R8 A4: one bulk operation's page (a mass credit).
  'BULK_OPERATION',
  'DASHBOARD',
  'NOTIFICATIONS',
] as const;
export type OpsLogButtonKind = (typeof OPS_LOG_BUTTON_KINDS)[number];

export const opsLogButtonSchema = z.object({
  kind: z.enum(OPS_LOG_BUTTON_KINDS),
  /** The record's id (a uuid, or a gateway's provider key). Absent for a page without one. */
  ref: z.string().min(1).max(64).optional(),
});
export type OpsLogButton = z.infer<typeof opsLogButtonSchema>;

/** The payload keys the lane reserves; a template token can never collide with them. */
export const OPS_LOG_BUTTONS_PAYLOAD_KEY = '__buttons';
export const OPS_LOG_STORM_PAYLOAD_KEY = '__storm';
export const OPS_LOG_STORM_USERS_PAYLOAD_KEY = '__users';

const SAFE_REF = /^[A-Za-z0-9_-]{1,64}$/;

/** The Web Admin path a button opens, or null when its record id is not a safe path segment. */
export function opsLogButtonPath(button: OpsLogButton): string | null {
  const ref = button.ref;
  const needsRef = (): string | null => (ref !== undefined && SAFE_REF.test(ref) ? ref : null);
  switch (button.kind) {
    case 'USER':
    case 'MANUAL_CREDIT': {
      const id = needsRef();
      return id === null ? null : `/users/${id}`;
    }
    case 'WALLET': {
      const id = needsRef();
      return id === null ? null : `/users/${id}?tab=financial`;
    }
    case 'BULK_OPERATION': {
      const id = needsRef();
      return id === null ? null : `/bulk-operations/${id}`;
    }
    case 'PAYMENT': {
      const id = needsRef();
      return id === null ? null : `/payments/${id}`;
    }
    case 'ORDER': {
      const id = needsRef();
      return id === null ? null : `/orders/${id}`;
    }
    case 'SERVICE': {
      const id = needsRef();
      return id === null ? null : `/services/${id}`;
    }
    case 'PANEL': {
      const id = needsRef();
      return id === null ? null : `/panels/${id}`;
    }
    case 'GATEWAY': {
      // The ref is the provider's KEY (`TONPAYS`); the route is its Web Admin slug
      // (`tonpays`). A key this release does not know opens the list, never a guessed path.
      const slug = ref === undefined ? null : paymentMethodSlugOf(ref);
      return slug === null ? '/payment-gateways' : `/payment-gateways/${slug}`;
    }
    case 'TICKET': {
      const id = needsRef();
      return id === null ? null : `/tickets/${id}`;
    }
    case 'DASHBOARD':
      return '/';
    case 'NOTIFICATIONS':
      return '/notification-center';
  }
}

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

/**
 * One token of the log templates: its type and what it stands for. Declared ONCE so two
 * templates that print the same fact cannot disagree about its type, and a Persian label
 * (`PLACEHOLDER_LABELS_FA`) is one entry per token.
 */
const TOKENS = {
  // The customer.
  displayName: ['STRING', 'The customer’s display name, or a Persian word for "no name".'],
  username: ['STRING', 'The customer’s @username, or a Persian word for "no username".'],
  telegramId: ['STRING', 'The customer’s numeric Telegram id.'],
  phone: ['STRING', 'The customer’s verified phone number; absent when there is none.'],
  // Money.
  principal: ['MONEY', 'The principal: what the order cost or the wallet receives.'],
  fee: ['MONEY', 'The gateway fee the customer paid; absent when it is zero.'],
  payable: ['MONEY', 'What the customer was asked to pay: principal plus fee.'],
  gift: ['MONEY', 'The top-up gift actually credited, read from the ledger.'],
  amount: ['MONEY', 'The amount of the movement, from the ledger or the order.'],
  price: ['MONEY', 'The final price the order cost.'],
  listPrice: [
    'MONEY',
    'The product price before a discount or a reseller price; absent otherwise.',
  ],
  balanceBefore: ['MONEY', 'The wallet balance before the movement, derived from the ledger.'],
  balanceAfter: ['MONEY', 'The wallet balance after the movement, derived from the ledger.'],
  // Identity of the fact.
  reference: ['STRING', 'The payment’s 8-character public tracking code.'],
  orderCode: ['STRING', 'The order’s 8-character public code.'],
  serviceCode: ['STRING', 'The service’s 8-character public code.'],
  ticketNumber: ['STRING', 'The ticket’s number.'],
  at: ['DATETIME', 'When the fact was recorded.'],
  expiredAt: [
    'DATETIME',
    'R5A item 4: when the payment stopped being payable in Nexa (its effective deadline).',
  ],
  approvedAt: ['DATETIME', 'R5A item 4: when the gateway’s approval was observed and credited.'],
  // Payment detail.
  method: ['STRING', 'The payment method, in Persian, once.'],
  evidence: ['STRING', 'What confirmed the payment, in Persian.'],
  cause: ['STRING', 'Why it happened, in Persian.'],
  channel: ['STRING', 'Where a refund went, in Persian.'],
  providerInvoiceId: ['STRING', 'The provider’s invoice id, or absent.'],
  providerFinalAmount: ['STRING', 'The provider’s own final figure, diagnostic only.'],
  remainingAmount: [
    'STRING',
    'R9 C1: the remainder the gateway asks the customer to pay, in its own unit — diagnostic only, never settled.',
  ],
  remainderInvoiceId: ['STRING', 'R9 C1: the gateway’s invoice id for the remainder, or absent.'],
  refundAmount: [
    'STRING',
    'R9 C1: the surplus the gateway says it will return, in its own unit — diagnostic only, never credited.',
  ],
  creditAmount: [
    'STRING',
    'R9 C1: the `credit_amount` the gateway’s webhook reported, in its own unit — never credited.',
  ],
  invoicedAmount: [
    'STRING',
    'R9 C1: what Nexa asked the gateway for, in the gateway’s unit (the principal, and the payable when a fee was added).',
  ],
  providerStatus: ['STRING', 'The provider’s own status word for the payment.'],
  providerPaymentId: ['STRING', 'The provider’s payment id, or absent.'],
  fiatEquivalent: ['STRING', 'The dollar amount the invoice was priced at.'],
  cryptoRequested: ['STRING', 'The crypto amount requested, when the provider reported it.'],
  cryptoPaid: ['STRING', 'The crypto amount paid, when the provider reported it.'],
  cryptoReceived: ['STRING', 'The final crypto amount received, when the provider reported it.'],
  walletAddress: ['STRING', 'The provider’s deposit address, when the provider reported it.'],
  kindTitle: ['STRING', 'What the payment was for, in Persian.'],
  // The log's own headings and badges.
  heading: ['STRING', 'The message’s title line, in Persian.'],
  code: ['STRING', 'The event code, for a template written before Round 4.'],
  message: [
    'STRING',
    'The server’s own short English message, for a template written before Round 4.',
  ],
  badges: ['STRING', 'The title badges (first purchase, reseller), already separated; or absent.'],
  source: [
    'STRING',
    'R9 C2: where the request came from, in Persian — the bot or the mini app. The bot unless the recorded source surface is the mini app.',
  ],
  firstPurchase: [
    'STRING',
    'R9 C2: a Persian «yes» when this is the customer’s first paid purchase (a catalogue or custom service; a trial, a renewal, an add-on and an adopted legacy service are none); absent otherwise.',
  ],
  // Orders and services.
  productTitle: ['STRING', 'The product or order line title.'],
  location: ['STRING', 'The service location label; absent when the product has none.'],
  panelName: ['STRING', 'The panel’s name.'],
  serviceUsername: ['STRING', 'The service’s username on the panel.'],
  traffic: ['TRAFFIC_LIMIT', 'The traffic allowance bought.'],
  duration: ['DURATION_DAYS', 'The duration bought.'],
  usedBytes: ['BYTES', 'Traffic used, in bytes; zero is zero bytes.'],
  limitBefore: ['TRAFFIC_LIMIT', 'The traffic allowance before the operation.'],
  limitAfter: ['TRAFFIC_LIMIT', 'The traffic allowance after the operation.'],
  addedBytes: ['BYTES', 'The traffic added.'],
  addedDays: ['DURATION_DAYS', 'The days added.'],
  expiresBefore: ['DATE', 'The expiry before the operation.'],
  expiresAfter: ['DATE', 'The expiry after the operation.'],
  rotations: ['NUMBER', 'How many times the link changed in the last 30 days, this one included.'],
  byWhom: ['STRING', 'Who asked for the change, in Persian.'],
  // Referrals.
  referrerName: ['STRING', 'The referrer’s display name.'],
  referrerUsername: ['STRING', 'The referrer’s @username.'],
  referrerTelegramId: ['STRING', 'The referrer’s numeric Telegram id.'],
  referrerPhone: ['STRING', 'The referrer’s verified phone number; absent when none.'],
  referrerBefore: ['MONEY', 'The referrer’s wallet before the credit.'],
  referrerAfter: ['MONEY', 'The referrer’s wallet after the credit.'],
  buyerName: ['STRING', 'The buyer’s display name.'],
  buyerUsername: ['STRING', 'The buyer’s @username.'],
  buyerTelegramId: ['STRING', 'The buyer’s numeric Telegram id.'],
  buyerPhone: ['STRING', 'The buyer’s verified phone number; absent when none.'],
  refereeName: ['STRING', 'The new customer’s display name.'],
  refereeUsername: ['STRING', 'The new customer’s @username.'],
  refereeTelegramId: ['STRING', 'The new customer’s numeric Telegram id.'],
  refereeBefore: ['MONEY', 'The new customer’s wallet before the gift.'],
  refereeAfter: ['MONEY', 'The new customer’s wallet after the gift.'],
  orderTotal: ['MONEY', 'The order total the commission was earned on.'],
  percent: ['STRING', 'The commission percentage, already formatted.'],
  // Administrators.
  adminName: ['STRING', 'The administrator’s display name.'],
  adminUsername: ['STRING', 'The administrator’s username.'],
  adminTelegramId: ['STRING', 'The administrator’s Telegram id, or a Persian word for none.'],
  reason: ['STRING', 'The operator’s stated reason, bounded.'],
  customerNotified: [
    'STRING',
    'R8 A4: whether the customer is sent a message about the change, in Persian.',
  ],
  recipients: ['NUMBER', 'R8 A4: how many customers a mass credit credited.'],
  skipped: ['NUMBER', 'R8 A4: how many customers of a mass credit were skipped.'],
  total: ['MONEY', 'R8 A4: the sum a mass credit credited, read from the ledger.'],
  cancelledBy: [
    'STRING',
    'R8 A3: who cancelled the invoice (the customer, Nexa, an operator or the gateway), in Persian.',
  ],
  rejectReasons: [
    'STRING',
    'R8 A3: why the receipt was rejected — the operator’s reason, or the gateway’s reasons as it worded them (sanitised, bounded), one line.',
  ],
  targetName: ['STRING', 'The administrator the change is about.'],
  targetUsername: ['STRING', 'The username of the administrator the change is about.'],
  targetTelegramId: ['STRING', 'Their Telegram id, or a Persian word for none.'],
  roles: ['STRING', 'The roles an administrator holds, for an addition or a removal.'],
  rolesBefore: ['STRING', 'The roles before the change.'],
  rolesAfter: ['STRING', 'The roles after the change.'],
  permissions: ['NUMBER', 'How many permissions the roles grant in all.'],
  actorName: ['STRING', 'Who made the change, in Persian.'],
  // Users and resellers.
  blockType: ['STRING', 'Whether the block was manual or automatic, in Persian.'],
  until: ['STRING', 'Until when the block lasts, in Persian.'],
  tierBefore: ['STRING', 'The reseller tier before, or the word for "ordinary customer".'],
  tierAfter: ['STRING', 'The reseller tier after, or the word for "ordinary customer".'],
  // Service alerts.
  status: ['STRING', 'The service’s state, in Persian.'],
  remainingBytes: ['BYTES', 'The traffic left; zero is zero bytes, never NaN.'],
  remainingTime: ['STRING', 'The time left, in Persian.'],
  lastConnection: ['DATETIME', 'When the service last connected; absent when never read.'],
  // Generic operational events.
  severity: ['STRING', 'The class the event is presented as, in Persian.'],
  details: ['STRING', 'Safe structured detail, one `name: value` per line; no ids.'],
  occurrences: ['NUMBER', 'How many times the condition has fired since it was first seen.'],
  firstSeenAt: ['DATETIME', 'When the condition was first recorded.'],
  lastSeenAt: ['DATETIME', 'When this occurrence was recorded.'],
  outcome: ['STRING', 'The outcome of a refund request, in Persian.'],
  // Errors.
  gateway: ['STRING', 'The gateway’s name, in Persian.'],
  technical: ['STRING', 'One short technical line (an HTTP status or a machine code).'],
  retry: ['STRING', 'Whether trying again helps, in Persian.'],
  impact: ['STRING', 'What happened to the customer, in Persian.'],
  operation: [
    'STRING',
    'The operation in Persian: what failed, or what the paid order was for (purchase, renewal, traffic, time).',
  ],
  state: ['STRING', 'Whether the outcome is failed or unknown, in Persian.'],
  count: ['NUMBER', 'How many identical errors the roll-up stands for.'],
  users: ['NUMBER', 'How many customers they concern.'],
  // Panels.
  downtime: ['STRING', 'How long the panel was down, in Persian.'],
  since: ['DATETIME', 'When the panel went out of reach.'],
  salesNote: ['STRING', 'Whether sales on the panel stopped, in Persian.'],
  // Support.
  category: ['STRING', 'The ticket’s topic.'],
  snippet: ['STRING', 'The first two lines of the customer’s message, bounded.'],
  // Backups.
  fileName: ['STRING', 'The archive’s file name.'],
  size: ['STRING', 'The archive’s size, formatted.'],
  nextAt: ['DATETIME', 'When the next automatic backup is due; absent when none is scheduled.'],
  checksum: ['STRING', 'The archive’s SHA-256, abbreviated.'],
  // Reports.
  day: ['DATE', 'The report’s day.'],
  sales: ['MONEY', 'Total sales.'],
  salesChange: ['STRING', 'The change against yesterday, formatted, or absent.'],
  newPurchases: ['NUMBER', 'New purchases.'],
  firstPurchases: ['NUMBER', 'First purchases.'],
  renewals: ['NUMBER', 'Renewals.'],
  newCustomers: ['NUMBER', 'New customers.'],
  activeCustomers: ['NUMBER', 'Customers active in the day.'],
  trials: ['NUMBER', 'Trials issued.'],
  activeServices: ['NUMBER', 'Active services now.'],
  bestHour: ['STRING', 'The best selling hour, formatted.'],
  errors: ['NUMBER', 'Errors recorded in the day.'],
  failedPayments: ['NUMBER', 'Failed payments in the day.'],
  openTickets: ['NUMBER', 'Open tickets now.'],
  cleanup: ['STRING', 'The one cleanup line (L30), or absent when nothing was cleaned.'],
  // Gift cards (R10 D4).
  batchLabel: ['STRING', 'R10 D4: the gift card batch’s label, as the operator typed it.'],
  codeLast4: [
    'STRING',
    'R10 D4: the last four symbols of the redeemed code — enough to find it with the holder, never the code.',
  ],
  codeCount: ['NUMBER', 'R10 D4: how many codes the batch minted.'],
  faceTotal: ['MONEY', 'R10 D4: the face value of every code of the batch together.'],
  expiry: ['DATETIME', 'R10 D4: when the batch’s codes stop being redeemable.'],
  newOrdersSum: ['MONEY', 'The new purchases’ total.'],
  renewalsSum: ['MONEY', 'The renewals’ total.'],
  trafficCount: ['NUMBER', 'Extra-traffic purchases.'],
  trafficSum: ['MONEY', 'Extra-traffic total.'],
  timeCount: ['NUMBER', 'Extra-time purchases.'],
  timeSum: ['MONEY', 'Extra-time total.'],
  otherCount: ['NUMBER', 'Paid orders that are none of the four categories.'],
  otherSum: ['MONEY', 'Their total.'],
  gross: ['MONEY', 'Gross income.'],
  refundsCount: ['NUMBER', 'Refunds.'],
  refundsSum: ['MONEY', 'Refunds total.'],
  commissionCount: ['NUMBER', 'Commissions.'],
  commissionSum: ['MONEY', 'Commissions total.'],
  giftSum: ['MONEY', 'Top-up gifts total.'],
  net: ['MONEY', 'Net income.'],
  methods: ['STRING', 'The split by payment method, formatted.'],
  panelsBlock: ['STRING', 'One block per panel, formatted.'],
  resellersBlock: ['STRING', 'The reseller summary, formatted.'],
  topResellers: [
    'STRING',
    'R9 C2: the day’s top resellers by sales, one line each (Telegram id, username, total, order count), at most five; absent when no reseller sold.',
  ],
  customersWithService: [
    'NUMBER',
    'R9 C2: customers with at least one active service now (active = a service in the ACTIVE state at the time the report is made).',
  ],
  customersWithoutService: [
    'NUMBER',
    'R9 C2: customers with no active service now: every customer that is not counted as having one.',
  ],
} as const satisfies Record<string, readonly [PlaceholderType, string]>;

type TokenName = keyof typeof TOKENS;

/** A required token, then an optional one: a line made only of absent optionals is dropped. */
const req = (...names: TokenName[]): PlaceholderDefinition[] => names.map((n) => token(n, true));
const opt = (...names: TokenName[]): PlaceholderDefinition[] => names.map((n) => token(n, false));

function token(name: TokenName, required: boolean): PlaceholderDefinition {
  const [type, description] = TOKENS[name];
  return { token: name, type, description, required, repeatable: false };
}

function logTemplate<const K extends string>(
  key: K,
  description: string,
  placeholders: PlaceholderDefinition[],
): TemplateDefinition & { readonly key: K } {
  return { key, description, format: 'PLAIN_TEXT', placeholders, digits: 'PERSIAN' };
}

/** The customer line every log prints: `Sara · @sample_user · 100200300`. */
const WHO = (): PlaceholderDefinition[] => [
  ...opt('displayName', 'username'),
  ...req('telegramId'),
];

/**
 * The log templates that are new in Round 4. The ones that already existed
 * (`ops.financial.*`, `ops.support.*`, `ops.notification.*`) keep their keys and are changed
 * in place in `templates.ts`.
 */
export const OPS_LOG_TEMPLATES = [
  // --- The templates that already existed, reworked in place (same keys) -----------------------
  logTemplate(
    'ops.notification.operational_event',
    'An operational event, projected into the operations destination, titled in Persian from its code. Sent once per deduplicated condition; the occurrence count is part of the message.',
    [
      ...req('severity'),
      // Optional so a body written before Round 4, which has none of them, stays valid.
      ...opt('heading', 'technical', 'details', 'occurrences', 'firstSeenAt', 'lastSeenAt'),
      // R11 A7: the panel account name of the service an event is about; absent for any other event.
      ...opt('serviceUsername'),
      // Kept so an override written before Round 4 (`{code}`, `{message}`) still saves and renders.
      ...opt('code', 'message'),
    ],
  ),
  logTemplate(
    'ops.notification.payment_link_failed',
    'Log L22: a gateway could not make a payment link — the customer, the gateway, the amount, the Persian cause, one short technical line, whether trying again helps and what happened to the customer.',
    [
      ...req('gateway', 'cause', 'technical', 'retry', 'impact', 'at'),
      ...WHO(),
      ...opt('amount', 'reference', 'orderCode', 'providerInvoiceId', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.topup_credited',
    'Log L1: a wallet top-up was confirmed and credited — the principal credit, the fee, the total paid and the gift, with the wallet before and after.',
    [
      ...req('method', 'reference', 'principal', 'fee', 'payable', 'evidence', 'at'),
      ...WHO(),
      ...opt('gift', 'providerInvoiceId', 'providerFinalAmount', 'balanceBefore', 'balanceAfter'),
    ],
  ),
  logTemplate(
    'ops.financial.order_paid',
    'Log L2: an order payment was confirmed, by any method — the order, the product, the operation (purchase, renewal, traffic, time), the first-purchase and reseller badges, the amounts and, for a wallet payment, the wallet before and after. A wallet payment has no gateway fee and its evidence is the debit itself, so it prints neither line (hotfix v0.8.2-e).',
    [
      ...req('method', 'reference', 'principal', 'payable', 'at'),
      ...WHO(),
      ...opt(
        // Optional since hotfix v0.8.2-e: omitted for a wallet payment, present for every other.
        'fee',
        'evidence',
        'orderCode',
        'serviceUsername',
        'productTitle',
        'operation',
        'badges',
        'providerInvoiceId',
        'providerFinalAmount',
        'balanceBefore',
        'balanceAfter',
      ),
    ],
  ),
  logTemplate(
    'ops.financial.payment_failed',
    'Log L4: a payment failed — the cause in Persian, the method and the amounts. Since R8 A3 a cancelled invoice, a rejected receipt and an expired payment each have their own template.',
    [
      ...req('cause', 'method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.invoice_cancelled',
    'Log L4 (R8 A3): an invoice was cancelled before it was paid — by whom, the method and the amounts. Nothing was received.',
    [
      ...req('cancelledBy', 'method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.receipt_rejected',
    'Log L4 (R8 A3): a receipt was rejected — by the operator or by the gateway — with the reasons, the method and the amounts. Nothing was credited.',
    [
      ...req('method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('rejectReasons', 'orderCode', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.payment_expired',
    'Log L4 (R8 A3): the gateway reported the payment expired before it was paid — the method and the amounts. Nothing was received.',
    [
      ...req('method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.payment_underpaid',
    'Log L4 (R9 C1): the gateway reported the customer paid LESS than the invoice and is waiting for the remainder. Nothing was settled or credited; only the gateway’s approval after the remainder settles it, at the principal.',
    [
      ...req('method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt(
        'orderCode',
        'serviceUsername',
        'providerInvoiceId',
        'remainingAmount',
        'remainderInvoiceId',
      ),
    ],
  ),
  logTemplate(
    'ops.financial.payment_overpaid',
    'Log L4 (R9 C1): the gateway reported the customer paid MORE than the invoice and is waiting for the card the surplus is returned to. The surplus is never credited to the wallet; the payment settles at its principal only.',
    [
      ...req('method', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'providerInvoiceId', 'refundAmount'),
    ],
  ),
  logTemplate(
    'ops.financial.late_completion',
    'Log L5: a gateway approved a payment after Nexa had closed it. Nothing was credited; it needs a manual check.',
    [
      ...req('gateway', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'providerInvoiceId', 'providerFinalAmount'),
    ],
  ),
  logTemplate(
    'ops.financial.late_credit',
    'Log L5 (R5A item 4): a gateway approved a payment after Nexa had closed it, its inquiry re-verified the approval, and the paid amount was credited to the customer’s wallet. The order was not reopened and no service was built.',
    [
      ...req('gateway', 'reference', 'amount', 'expiredAt', 'approvedAt'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'balanceBefore', 'balanceAfter'),
    ],
  ),
  logTemplate(
    'ops.financial.late_credit_returned',
    'Log L5 (R12 F1): a gateway confirmed money for an attempt that could no longer pay its order — the attempt had been cancelled (the order was paid from the wallet, the customer withdrew it) or the order was already paid by another payment. Its inquiry re-verified the approval and the payment’s own principal was returned to the customer’s wallet, whatever the late-credit switch says. The order was not changed and no service was built.',
    [
      ...req('gateway', 'reference', 'amount', 'approvedAt'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'balanceBefore', 'balanceAfter'),
    ],
  ),
  logTemplate(
    'ops.financial.outcome_unknown',
    'Log L5: a gateway review ended with no trustworthy answer. Nothing was credited or rejected; it needs a manual check.',
    [
      ...req('gateway', 'reference', 'principal', 'fee', 'payable', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'providerInvoiceId', 'providerFinalAmount'),
    ],
  ),
  logTemplate(
    'ops.financial.credit_amount_mismatch',
    'Log L5 (R9 C1): the gateway’s webhook reported a `credit_amount` that is neither the principal nor what Nexa invoiced. Nothing was credited on it — the payment settles only by the inquiry, at its principal; an operator should compare it with the gateway’s records.',
    [
      ...req('gateway', 'reference', 'principal', 'fee', 'payable', 'creditAmount', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'providerInvoiceId', 'invoicedAmount'),
    ],
  ),
  logTemplate(
    'ops.financial.refund_completed',
    'Log L6: a refund was completed — where it went, the amount and, for a wallet refund, the wallet before and after.',
    [
      ...req('channel', 'reference', 'amount', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername', 'balanceBefore', 'balanceAfter'),
    ],
  ),
  logTemplate(
    'ops.financial.refund_failed',
    'Log L6: a refund failed or was cancelled — where it was to go, why and the amount.',
    [
      ...req('channel', 'cause', 'reference', 'amount', 'at'),
      ...WHO(),
      ...opt('orderCode', 'serviceUsername'),
    ],
  ),
  logTemplate(
    'ops.financial.service_refund_request',
    'Log L6 (WP19): a customer’s service refund request reached a final outcome — completed (deleted and credited), rejected, or failed. Never the customer’s or the administrator’s free text.',
    [
      ...req('outcome', 'at'),
      ...WHO(),
      ...opt('serviceCode', 'serviceUsername', 'reference', 'amount', 'adminName'),
    ],
  ),
  logTemplate(
    'ops.support.ticket_opened',
    'Log L26: a customer opened a support ticket — its number, its topic and the first two lines of the message, and (R9 C2) the source: bot or mini app.',
    [...req('ticketNumber', 'category', 'at'), ...WHO(), ...opt('snippet', 'source')],
  ),
  logTemplate(
    'ops.support.customer_replied',
    'Log L26: a customer wrote in an existing support ticket — its number, its topic and the first two lines of the message, and (R9 C2) the source: bot or mini app.',
    [...req('ticketNumber', 'category', 'at'), ...WHO(), ...opt('snippet', 'source')],
  ),
  // --- New log types -----------------------------------------------------------------------
  logTemplate(
    'ops.log.payment_crypto',
    'Log L3: a crypto payment (NOWPayments) confirmed — the order amount, the dollar equivalent, the provider’s status, the crypto figures the provider reported, the wallet before and after.',
    [
      ...req('kindTitle', 'principal', 'method', 'reference', 'at'),
      ...WHO(),
      ...opt(
        'fiatEquivalent',
        'cryptoRequested',
        'cryptoPaid',
        'cryptoReceived',
        'providerStatus',
        'walletAddress',
        'providerPaymentId',
        'providerInvoiceId',
        'orderCode',
        'serviceUsername',
        'balanceBefore',
        'balanceAfter',
      ),
    ],
  ),
  logTemplate(
    'ops.log.wallet_adjusted',
    'Log L7: an administrator raised or lowered a customer’s wallet — who, whom, the amount, the balance before and after, the reason.',
    [
      ...req('heading', 'amount', 'balanceBefore', 'balanceAfter', 'reason', 'at'),
      ...WHO(),
      ...opt('adminName', 'adminUsername', 'adminTelegramId', 'customerNotified'),
    ],
  ),
  logTemplate(
    'ops.log.wallet_mass_credited',
    'Log L7 (R8 A4): an administrator’s mass wallet credit finished — who, the amount each customer received, how many were credited and skipped, the total, the reason and whether customers were told. One message per operation.',
    [
      ...req('amount', 'recipients', 'total', 'reason', 'at'),
      ...opt('skipped', 'adminName', 'adminUsername', 'adminTelegramId', 'customerNotified'),
    ],
  ),
  logTemplate(
    'ops.log.referral_commission',
    'Log L8: a referral commission credited to the referrer — both parties, what the buyer bought and the referrer’s wallet before and after.',
    [
      ...req('amount', 'balanceBefore', 'balanceAfter', 'at'),
      ...opt(
        'referrerName',
        'referrerUsername',
        'referrerTelegramId',
        'referrerPhone',
        'buyerName',
        'buyerUsername',
        'buyerTelegramId',
        'buyerPhone',
        'productTitle',
        'orderTotal',
        'percent',
        'orderCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.signup_gift',
    'Log L9: the signup gift of a referral — each side that has received it, with its wallet before and after.',
    [
      ...req('at'),
      ...opt(
        'refereeName',
        'refereeUsername',
        'refereeTelegramId',
        'refereeBefore',
        'refereeAfter',
        'referrerName',
        'referrerUsername',
        'referrerTelegramId',
        'referrerBefore',
        'referrerAfter',
      ),
    ],
  ),
  logTemplate(
    'ops.log.service_created',
    'Log L10: a service was created after a purchase paid by card, a gateway, Stars or crypto. R9 C2: a «first purchase of the customer» line when it is their first paid purchase, and the source line (bot or mini app).',
    [
      ...req('price', 'method', 'at'),
      ...WHO(),
      ...opt(
        'firstPurchase',
        'source',
        'badges',
        'phone',
        'productTitle',
        'location',
        'traffic',
        'duration',
        'panelName',
        'serviceUsername',
        'listPrice',
        'orderCode',
        'serviceCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.service_created_wallet',
    'Log L11: a service was created after a purchase paid from the wallet — the wallet before and after. R9 C2: a «first purchase of the customer» line when it is their first paid purchase, and the source line (bot or mini app).',
    [
      ...req('price', 'balanceBefore', 'balanceAfter', 'at'),
      ...WHO(),
      ...opt(
        'firstPurchase',
        'source',
        'badges',
        'phone',
        'productTitle',
        'location',
        'traffic',
        'duration',
        'panelName',
        'serviceUsername',
        'listPrice',
        'orderCode',
        'serviceCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.service_renewed',
    'Log L12: a service was renewed — the used volume before, the expiry before and after, and (R9 C2) the source: bot or mini app.',
    [
      ...req('price', 'method', 'at'),
      ...WHO(),
      ...opt(
        'source',
        'badges',
        'phone',
        'productTitle',
        'panelName',
        'serviceUsername',
        'usedBytes',
        'limitBefore',
        'expiresBefore',
        'expiresAfter',
        'listPrice',
        'balanceBefore',
        'balanceAfter',
        'orderCode',
        'serviceCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.traffic_added',
    'Log L13: extra traffic was bought — the amount added and the allowance before and after, and (R9 C2) the source: bot or mini app.',
    [
      ...req('addedBytes', 'price', 'method', 'at'),
      ...WHO(),
      ...opt(
        'source',
        'badges',
        'phone',
        'panelName',
        'serviceUsername',
        'limitBefore',
        'limitAfter',
        'usedBytes',
        'balanceBefore',
        'balanceAfter',
        'orderCode',
        'serviceCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.time_added',
    'Log L14: extra time was bought — the days added and the expiry before and after, and (R9 C2) the source: bot or mini app.',
    [
      ...req('addedDays', 'price', 'method', 'at'),
      ...WHO(),
      ...opt(
        'source',
        'badges',
        'phone',
        'panelName',
        'serviceUsername',
        'expiresBefore',
        'expiresAfter',
        'balanceBefore',
        'balanceAfter',
        'orderCode',
        'serviceCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.link_changed',
    'Log L15: a service’s subscription link was changed; the previous link no longer works.',
    [
      ...req('byWhom', 'at'),
      ...WHO(),
      ...opt('panelName', 'serviceUsername', 'serviceCode', 'rotations'),
    ],
  ),
  logTemplate('ops.log.trial_created', 'Log L16: a trial account was created.', [
    ...req('at'),
    ...WHO(),
    ...opt('phone', 'panelName', 'serviceUsername', 'traffic', 'duration', 'serviceCode'),
  ]),
  logTemplate('ops.log.user_new', 'Log L17: a new customer started the bot.', [
    ...req('at'),
    ...WHO(),
    ...opt('phone', 'referrerName', 'referrerUsername', 'referrerTelegramId'),
  ]),
  logTemplate(
    'ops.log.user_blocked',
    'Log L18: a customer was blocked or unblocked — by whom, why, what kind and until when.',
    [
      ...req('heading', 'blockType', 'at'),
      ...WHO(),
      ...opt('adminName', 'adminUsername', 'reason', 'until'),
    ],
  ),
  logTemplate(
    'ops.log.admin_changed',
    'Log L19: an administrator was added, removed or had their role changed — who, the old and new role, the permissions.',
    [
      ...req('heading', 'targetUsername', 'at'),
      ...opt(
        'targetName',
        'targetTelegramId',
        'roles',
        'rolesBefore',
        'rolesAfter',
        'permissions',
        'actorName',
      ),
    ],
  ),
  logTemplate(
    'ops.log.reseller_changed',
    'Log L20: a customer was promoted to reseller, moved between tiers, suspended or demoted.',
    [...req('heading', 'tierBefore', 'tierAfter', 'at'), ...WHO(), ...opt('reason', 'actorName')],
  ),
  logTemplate(
    'ops.log.service_alert',
    'Log L21: one service reached a volume, time, expiry or no-connection threshold. One message per service.',
    [
      ...req('heading', 'status', 'remainingBytes', 'at'),
      ...WHO(),
      ...opt('serviceUsername', 'panelName', 'remainingTime', 'lastConnection'),
    ],
  ),
  logTemplate(
    'ops.log.error_provision',
    'Log L23: a service could not be created on a panel — the customer, the cause, a short technical line and what happened to the customer.',
    [
      ...req('cause', 'technical', 'impact', 'at'),
      ...WHO(),
      ...opt('productTitle', 'panelName', 'serviceUsername', 'amount', 'orderCode', 'reference'),
    ],
  ),
  logTemplate(
    'ops.log.error_provision_admin',
    'Log L23 (R9 C2): a service an ADMINISTRATOR created for a customer from the Web Admin could not be created on the panel — who created it (name, username, Telegram id), the customer, the panel, the cause, a short technical line and what happened to the customer.',
    [
      ...req('cause', 'technical', 'impact', 'at'),
      ...WHO(),
      ...opt(
        'adminName',
        'adminUsername',
        'adminTelegramId',
        'productTitle',
        'panelName',
        'serviceUsername',
        'amount',
        'orderCode',
        'reference',
      ),
    ],
  ),
  logTemplate(
    'ops.log.error_operation',
    'Log L24: a renewal, extra traffic, extra time, a trial or (R9 C2) a free extra-volume gift could not be completed — the operation, the service and its panel, the cause, whether the outcome is failed or unknown, and what happened to the customer.',
    [
      ...req('operation', 'state', 'cause', 'technical', 'impact', 'at'),
      ...WHO(),
      ...opt('serviceUsername', 'panelName', 'amount', 'retry', 'orderCode', 'reference'),
    ],
  ),
  logTemplate(
    'ops.log.storm_rollup',
    'Log L25 (optional guard): the identical errors of the last window, merged into one message because there were more than the configured threshold.',
    [...req('heading', 'count', 'users', 'cause', 'at'), ...opt('technical', 'panelName')],
  ),
  logTemplate(
    'ops.log.panel_down',
    'Log L25: a panel went out of reach — the cause, whether sales stopped, since when.',
    [...req('panelName', 'cause', 'since'), ...opt('technical', 'salesNote')],
  ),
  logTemplate(
    'ops.log.panel_up',
    'Log L25: a panel that was out of reach is back — and how long it was down.',
    [...req('panelName', 'at'), ...opt('downtime')],
  ),
  logTemplate(
    'ops.log.report_summary',
    'Log L27: the nightly summary — sales, purchases, renewals, customers, trials, the change against yesterday and the best hour; with the cleanup line (L30). R9 C2: «active» and «inactive» customers — ACTIVE means the customer has at least one service in the ACTIVE state now (a trial service counts, a suspended, expired or terminated one does not); INACTIVE is every other customer (a row the legacy import wrote is history and is counted in neither). They are counted when the report is made and add up to all the installation’s own customers.',
    [
      ...req(
        'day',
        'sales',
        'newPurchases',
        'firstPurchases',
        'renewals',
        'newCustomers',
        'trials',
      ),
      ...opt(
        'salesChange',
        'activeCustomers',
        'customersWithService',
        'customersWithoutService',
        'activeServices',
        'bestHour',
        'errors',
        'failedPayments',
        'openTickets',
        'cleanup',
      ),
    ],
  ),
  logTemplate(
    'ops.log.report_financial',
    'Log L28: the nightly financial report — orders, renewals, extra traffic and time, refunds, commissions, gifts, gross and net, all from the ledger and the orders.',
    [
      ...req(
        'day',
        'newOrdersSum',
        'renewalsSum',
        'trafficCount',
        'trafficSum',
        'timeCount',
        'timeSum',
        'gross',
        'refundsCount',
        'refundsSum',
        'commissionCount',
        'commissionSum',
        'giftSum',
        'net',
      ),
      ...opt('otherCount', 'otherSum', 'methods'),
    ],
  ),
  logTemplate(
    'ops.log.report_panels',
    'Log L29: the nightly panel and reseller report — orders, sales and gigabytes sold per panel, health and capacity, and the resellers’ summary. R9 C2: the day’s top five resellers by sales (Telegram id, username, total, order count); the block is left out when no reseller sold.',
    [...req('day'), ...opt('panelsBlock', 'resellersBlock', 'topResellers')],
  ),
  logTemplate(
    'ops.log.backup_caption',
    'Log L31: the caption of a backup archive sent to the backups topic.',
    [...req('at', 'fileName', 'size'), ...opt('nextAt', 'checksum')],
  ),
  logTemplate(
    'ops.log.gift_card_redeemed',
    'R10 D4: a customer redeemed a gift card — who, the amount credited, the batch, the code’s last four symbols, the wallet before and after (from the ledger) and where it was redeemed (the bot or the mini app).',
    [
      ...req('amount', 'balanceBefore', 'balanceAfter', 'at'),
      ...WHO(),
      ...opt('batchLabel', 'codeLast4', 'source'),
    ],
  ),
  logTemplate(
    'ops.log.gift_card_batch_created',
    'R10 D4: an administrator minted a batch of gift cards — how many codes, the face value of each and of all together, the expiry, who and why.',
    [
      ...req('codeCount', 'amount', 'faceTotal', 'expiry', 'at'),
      ...opt('batchLabel', 'adminName', 'adminUsername', 'adminTelegramId', 'reason'),
    ],
  ),
] as const;
