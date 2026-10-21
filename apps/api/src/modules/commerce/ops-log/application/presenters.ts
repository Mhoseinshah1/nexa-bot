import {
  CURRENCY_EXPONENT,
  formatPersianInteger,
  paymentTrackingCode,
  toPersianDigits,
  type Money,
  type OpsLogButton,
  type OpsLogTypeId,
  type TemplateKey,
  type TemplateValue,
  type TemplateValues,
} from '@nexa/contracts';
import type {
  AdminFact,
  BalanceAround,
  CustomerFact,
  LedgerEntryFact,
  OperationFact,
  OpsLogWords,
  OrderFact,
  PaymentFact,
  ServiceBeforeImage,
  ServiceFact,
  TicketFact,
} from './ports.js';

/**
 * Round 4 PR-D — the operations log group's messages, built from facts.
 *
 * Pure: facts and words in, a template key, its values and its buttons out. No clock, no
 * database, no id in any value — a short public code stands wherever an id used to, and a
 * Persian word stands wherever an enum used to. A fact the builder does not have is OMITTED
 * (the renderer drops a line made only of absent tokens) rather than printed as a dash or a
 * guess, and an amount is always a `Money` of the ledger's or the order's own currency.
 */
export interface Built {
  readonly logType: OpsLogTypeId;
  readonly templateKey: TemplateKey;
  readonly values: TemplateValues;
  readonly buttons: readonly OpsLogButton[];
}

type Mutable = Record<string, TemplateValue>;

/** Sets `values[token]` only when there is something to say. */
function put(values: Mutable, token: string, value: TemplateValue | null | undefined): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' && value.trim() === '') return;
  values[token] = value;
}

export interface Identity {
  readonly displayName: string;
  readonly username: string;
  readonly telegramId: string;
}

/** Who a customer is, as Telegram knows them; a Persian word, never a dash, for the rest. */
export function identityOf(customer: CustomerFact | null, words: OpsLogWords): Identity {
  const name =
    customer === null
      ? ''
      : [customer.firstName, customer.lastName]
          .filter((part): part is string => part !== null && part.trim() !== '')
          .join(' ')
          .trim();
  return {
    displayName: name === '' ? words.noName : name,
    username:
      customer?.username === null || customer?.username === undefined
        ? words.noUsername
        : `@${customer.username}`,
    telegramId: customer?.telegramUserId ?? words.noTelegram,
  };
}

function identityValues(customer: CustomerFact | null, words: OpsLogWords): Mutable {
  return { ...identityOf(customer, words) };
}

function prefixed(prefix: string, who: Identity, phone: string | null): Mutable {
  const out: Mutable = {
    [`${prefix}Name`]: who.displayName,
    [`${prefix}Username`]: who.username,
    [`${prefix}TelegramId`]: who.telegramId,
  };
  if (phone !== null) out[`${prefix}Phone`] = phone;
  return out;
}

/** The short bound a free-text field is cut to before it enters a log. */
const FREE_TEXT_MAX = 300;

/** An operator's or customer's own words, one line, bounded, and never empty. */
export function oneLine(text: string | null, max = FREE_TEXT_MAX): string | null {
  if (text === null) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The first two lines of a message, each bounded: what a ticket log shows (L26). */
export function firstTwoLines(text: string | null, perLine = 160): string | null {
  if (text === null) return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .slice(0, 2)
    .map((line) => (line.length > perLine ? `${line.slice(0, perLine - 1)}…` : line));
  return lines.length === 0 ? null : lines.join('\n');
}

const userButton = (customerId: string): OpsLogButton => ({ kind: 'USER', ref: customerId });

// ---------------------------------------------------------------------------
// L7 — an administrator raised or lowered a wallet
// ---------------------------------------------------------------------------

export function walletAdjusted(input: {
  readonly entry: LedgerEntryFact;
  readonly balance: BalanceAround;
  readonly customer: CustomerFact | null;
  readonly admin: AdminFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { entry, balance, customer, admin, at, words } = input;
  const values: Mutable = {
    ...identityValues(customer, words),
    heading: words.walletAdjustHeading(entry.direction),
    amount: entry.amount,
    balanceBefore: balance.before,
    balanceAfter: balance.after,
    // The reason is required by the adjustment itself; if an entry somehow has none, the
    // word for "no reason" stands rather than an empty line.
    reason: oneLine(entry.note) ?? words.none,
    at,
  };
  if (admin !== null) {
    values['adminName'] = admin.displayName;
    values['adminUsername'] = `@${admin.username}`;
    values['adminTelegramId'] = admin.telegramUserId ?? words.noTelegram;
  }
  return {
    logType: 'ADMIN_WALLET',
    templateKey: 'ops.log.wallet_adjusted' as TemplateKey,
    values,
    buttons: [userButton(entry.customerId)],
  };
}

// ---------------------------------------------------------------------------
// L8 — a referral commission was credited
// ---------------------------------------------------------------------------

export function referralCommission(input: {
  readonly entry: LedgerEntryFact;
  readonly balance: BalanceAround;
  readonly referrer: CustomerFact | null;
  readonly buyer: CustomerFact | null;
  readonly order: OrderFact | null;
  readonly payment: PaymentFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { entry, balance, referrer, buyer, order, payment, at, words } = input;
  const values: Mutable = {
    ...prefixed('referrer', identityOf(referrer, words), referrer?.phone ?? null),
    ...prefixed('buyer', identityOf(buyer, words), buyer?.phone ?? null),
    amount: entry.amount,
    balanceBefore: balance.before,
    balanceAfter: balance.after,
    at,
  };
  if (order !== null) {
    put(values, 'productTitle', order.title);
    put(values, 'orderCode', order.code);
    values['orderTotal'] = order.total;
    // The commission as a share of what the buyer paid, by integer arithmetic. Omitted when
    // the order total is zero: a percentage of nothing is not a number.
    if (order.total.amountMinor > 0n && order.total.currency === entry.amount.currency) {
      const tenths =
        (entry.amount.amountMinor * 1000n + order.total.amountMinor / 2n) / order.total.amountMinor;
      const whole = tenths / 10n;
      const fraction = tenths % 10n;
      values['percent'] = `${toPersianDigits(
        fraction === 0n ? whole.toString() : `${whole.toString()}.${fraction.toString()}`,
      )}٪`;
    }
  }
  if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
  return {
    logType: 'REFERRAL_COMMISSION',
    templateKey: 'ops.log.referral_commission' as TemplateKey,
    values,
    buttons: [
      userButton(entry.customerId),
      ...(order === null ? [] : [{ kind: 'ORDER' as const, ref: order.id }]),
    ],
  };
}

// ---------------------------------------------------------------------------
// L9 — the signup gift of a referral
// ---------------------------------------------------------------------------

export interface GiftSide {
  readonly customer: CustomerFact | null;
  /** The balance on either side of the gift; null while this side has not claimed it. */
  readonly balance: BalanceAround | null;
}

export function signupGift(input: {
  readonly referee: GiftSide;
  readonly referrer: GiftSide;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { referee, referrer, at, words } = input;
  const values: Mutable = {
    ...prefixed('referee', identityOf(referee.customer, words), null),
    ...prefixed('referrer', identityOf(referrer.customer, words), null),
    at,
  };
  if (referee.balance !== null) {
    values['refereeBefore'] = referee.balance.before;
    values['refereeAfter'] = referee.balance.after;
  }
  if (referrer.balance !== null) {
    values['referrerBefore'] = referrer.balance.before;
    values['referrerAfter'] = referrer.balance.after;
  }
  return {
    logType: 'SIGNUP_GIFT',
    templateKey: 'ops.log.signup_gift' as TemplateKey,
    values,
    buttons: [
      ...(referee.customer === null ? [] : [userButton(referee.customer.id)]),
      ...(referrer.customer === null ? [] : [userButton(referrer.customer.id)]),
    ],
  };
}

// ---------------------------------------------------------------------------
// L10 / L11 — a service was created after a purchase
// ---------------------------------------------------------------------------

/** The product price when it differs from what the customer paid (a discount or a reseller). */
function listPriceOf(order: OrderFact): Money | null {
  const list = order.resellerListPrice ?? order.subtotal;
  return list.currency === order.total.currency && list.amountMinor > order.total.amountMinor
    ? list
    : null;
}

export function serviceCreated(input: {
  readonly order: OrderFact;
  readonly service: ServiceFact;
  readonly customer: CustomerFact | null;
  readonly payment: PaymentFact | null;
  /** The wallet on either side of THIS order's purchase debit; null when it was not a wallet payment. */
  readonly walletBalance: BalanceAround | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { order, service, customer, payment, walletBalance, at, words } = input;
  const wallet = payment?.method === 'WALLET' && walletBalance !== null;
  const values: Mutable = {
    ...identityValues(customer, words),
    productTitle: order.title,
    traffic: order.trafficBytes,
    duration: order.durationDays,
    price: order.total,
    method: words.methodName(payment?.method ?? 'GATEWAY', payment?.gatewayProvider ?? null),
    at,
  };
  // Always present, empty when no badge applies: the title line is made of its words and
  // this token, and the renderer drops a line whose tokens are ALL absent — the title with it.
  values['badges'] =
    words.badges({ firstPurchase: order.isFirstPurchase, reseller: order.reseller }) ?? '';
  put(values, 'phone', customer?.phone);
  put(values, 'location', order.locationLabel);
  put(values, 'panelName', service.panelName === '' ? null : service.panelName);
  put(values, 'serviceUsername', service.providerUsername);
  const list = listPriceOf(order);
  if (list !== null) values['listPrice'] = list;
  put(values, 'orderCode', order.code);
  put(values, 'serviceCode', service.code);
  if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
  if (wallet) {
    values['balanceBefore'] = walletBalance.before;
    values['balanceAfter'] = walletBalance.after;
  }
  return {
    logType: wallet ? 'SERVICE_CREATED_WALLET' : 'SERVICE_CREATED',
    templateKey: (wallet
      ? 'ops.log.service_created_wallet'
      : 'ops.log.service_created') as TemplateKey,
    values,
    buttons: [userButton(order.customerId), { kind: 'SERVICE', ref: service.id }],
  };
}

// ---------------------------------------------------------------------------
// L12 / L13 / L14 — a service was renewed, or got more traffic or time
// ---------------------------------------------------------------------------

export type ServiceChange = 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME';

export function serviceChanged(input: {
  readonly kind: ServiceChange;
  readonly order: OrderFact;
  readonly service: ServiceFact;
  readonly operation: OperationFact;
  /** The service as it was before the operation, from its own audit row; null when unrecorded. */
  readonly before: ServiceBeforeImage | null;
  readonly customer: CustomerFact | null;
  readonly payment: PaymentFact | null;
  readonly walletBalance: BalanceAround | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { kind, order, service, operation, before, customer, payment, walletBalance, at, words } =
    input;
  const values: Mutable = {
    ...identityValues(customer, words),
    price: order.total,
    method: words.methodName(payment?.method ?? 'GATEWAY', payment?.gatewayProvider ?? null),
    at,
  };
  // Always present (see `serviceCreated`): the title line must survive an absent badge.
  values['badges'] = words.badges({ firstPurchase: false, reseller: order.reseller }) ?? '';
  put(values, 'phone', customer?.phone);
  put(values, 'panelName', service.panelName === '' ? null : service.panelName);
  put(values, 'serviceUsername', service.providerUsername);
  put(values, 'orderCode', order.code);
  put(values, 'serviceCode', service.code);
  if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
  if (payment?.method === 'WALLET' && walletBalance !== null) {
    values['balanceBefore'] = walletBalance.before;
    values['balanceAfter'] = walletBalance.after;
  }

  // What the operation made true, from its own target — an absolute figure — against what the
  // audit row says the service WAS. Shown only when both halves are known, so a "before" is
  // never invented and "before" and "after" can never be the same stale read.
  const expiresAfter = operation.targetExpiresAt;
  const expiresBefore = before?.expiresAt ?? null;
  const limitAfter = operation.targetTrafficLimitBytes;
  const limitBefore = before?.trafficLimitBytes ?? null;

  if (kind === 'RENEW') {
    put(values, 'productTitle', order.title);
    const list = listPriceOf(order);
    if (list !== null) values['listPrice'] = list;
    if (
      before?.trafficUsedBytes !== null &&
      before?.trafficUsedBytes !== undefined &&
      limitBefore !== null
    ) {
      values['usedBytes'] = before.trafficUsedBytes;
      values['limitBefore'] = limitBefore;
    }
    if (expiresBefore !== null && expiresAfter !== null) {
      values['expiresBefore'] = expiresBefore;
      values['expiresAfter'] = expiresAfter;
    }
    return {
      logType: 'SERVICE_RENEWED',
      templateKey: 'ops.log.service_renewed' as TemplateKey,
      values,
      buttons: [userButton(order.customerId), { kind: 'SERVICE', ref: service.id }],
    };
  }
  if (kind === 'ADD_TRAFFIC') {
    values['addedBytes'] = order.trafficBytes;
    if (limitBefore !== null && limitAfter !== null) {
      values['limitBefore'] = limitBefore;
      values['limitAfter'] = limitAfter;
    }
    if (before?.trafficUsedBytes !== null && before?.trafficUsedBytes !== undefined) {
      values['usedBytes'] = before.trafficUsedBytes;
    }
    return {
      logType: 'TRAFFIC_ADDED',
      templateKey: 'ops.log.traffic_added' as TemplateKey,
      values,
      buttons: [userButton(order.customerId), { kind: 'SERVICE', ref: service.id }],
    };
  }
  values['addedDays'] = order.durationDays;
  if (expiresBefore !== null && expiresAfter !== null) {
    values['expiresBefore'] = expiresBefore;
    values['expiresAfter'] = expiresAfter;
  }
  return {
    logType: 'TIME_ADDED',
    templateKey: 'ops.log.time_added' as TemplateKey,
    values,
    buttons: [userButton(order.customerId), { kind: 'SERVICE', ref: service.id }],
  };
}

// ---------------------------------------------------------------------------
// L15 / L16 — a link changed; a trial was created
// ---------------------------------------------------------------------------

export function linkChanged(input: {
  readonly service: ServiceFact;
  readonly customer: CustomerFact | null;
  readonly by: 'CUSTOMER' | 'ADMIN' | 'SYSTEM';
  readonly rotations: number;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { service, customer, by, rotations, at, words } = input;
  const values: Mutable = {
    ...identityValues(customer, words),
    byWhom: words.byWhom(by),
    at,
  };
  put(values, 'panelName', service.panelName === '' ? null : service.panelName);
  put(values, 'serviceUsername', service.providerUsername);
  put(values, 'serviceCode', service.code);
  // "Nth time in 30 days": at least this one, so never zero and never NaN.
  values['rotations'] = Math.max(rotations, 1);
  return {
    logType: 'LINK_CHANGED',
    templateKey: 'ops.log.link_changed' as TemplateKey,
    values,
    buttons: [userButton(service.customerId), { kind: 'SERVICE', ref: service.id }],
  };
}

export function trialCreated(input: {
  readonly service: ServiceFact;
  readonly order: OrderFact | null;
  readonly customer: CustomerFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { service, order, customer, at, words } = input;
  const values: Mutable = { ...identityValues(customer, words), at };
  put(values, 'phone', customer?.phone);
  put(values, 'panelName', service.panelName === '' ? null : service.panelName);
  put(values, 'serviceUsername', service.providerUsername);
  put(values, 'serviceCode', service.code);
  values['traffic'] = order?.trafficBytes ?? service.trafficLimitBytes;
  if (order !== null) values['duration'] = order.durationDays;
  return {
    logType: 'TRIAL_CREATED',
    templateKey: 'ops.log.trial_created' as TemplateKey,
    values,
    buttons: [userButton(service.customerId), { kind: 'SERVICE', ref: service.id }],
  };
}

// ---------------------------------------------------------------------------
// L17 / L18 — customers
// ---------------------------------------------------------------------------

export function userNew(input: {
  readonly customer: CustomerFact;
  readonly referrer: CustomerFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { customer, referrer, at, words } = input;
  const values: Mutable = { ...identityValues(customer, words), at };
  put(values, 'phone', customer.phone);
  if (referrer !== null) {
    const who = identityOf(referrer, words);
    values['referrerName'] = who.displayName;
    values['referrerUsername'] = who.username;
    values['referrerTelegramId'] = who.telegramId;
  }
  return {
    logType: 'USER_NEW',
    templateKey: 'ops.log.user_new' as TemplateKey,
    values,
    buttons: [userButton(customer.id)],
  };
}

export function userBlocked(input: {
  readonly customer: CustomerFact | null;
  readonly customerId: string;
  readonly blocked: boolean;
  readonly automatic: boolean;
  readonly admin: AdminFact | null;
  readonly reason: string | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { customer, customerId, blocked, automatic, admin, reason, at, words } = input;
  const values: Mutable = {
    ...identityValues(customer, words),
    heading: words.block(blocked ? 'blocked' : 'unblocked'),
    blockType: words.block(automatic ? 'spam' : 'manual'),
    at,
  };
  if (blocked) values['until'] = words.block('until');
  if (admin !== null) {
    values['adminName'] = admin.displayName;
    values['adminUsername'] = `@${admin.username}`;
  }
  put(values, 'reason', oneLine(reason));
  return {
    logType: 'USER_BLOCK',
    templateKey: 'ops.log.user_blocked' as TemplateKey,
    values,
    buttons: [userButton(customerId)],
  };
}

export function resellerChanged(input: {
  readonly customer: CustomerFact | null;
  readonly customerId: string;
  readonly change: string;
  readonly fromTier: string | null;
  readonly toTier: string;
  readonly suspended: boolean;
  readonly admin: AdminFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { customer, customerId, change, fromTier, toTier, suspended, admin, at, words } = input;
  // A suspended reseller is an ordinary customer: the owner's rule, and so the message's.
  const before = fromTier === null ? words.resellerOrdinary : fromTier;
  const after = suspended ? words.resellerOrdinary : toTier;
  const values: Mutable = {
    ...identityValues(customer, words),
    heading: words.resellerHeading(change),
    tierBefore: change === 'REACTIVATED' ? words.resellerOrdinary : before,
    tierAfter: after,
    at,
  };
  if (admin !== null) values['actorName'] = `@${admin.username}`;
  return {
    logType: 'RESELLER_CHANGED',
    templateKey: 'ops.log.reseller_changed' as TemplateKey,
    values,
    buttons: [userButton(customerId)],
  };
}

// ---------------------------------------------------------------------------
// L19 — administrators
// ---------------------------------------------------------------------------

export function adminChanged(input: {
  readonly kind: 'created' | 'rolesChanged' | 'disabled' | 'enabled';
  readonly target: AdminFact;
  readonly rolesBefore: readonly string[] | null;
  /**
   * The roles (display names) and permission count AS OF THE EVENT, when the event carried
   * them; absent, the target's current ones stand (an event from before the snapshot).
   */
  readonly asOfEvent?:
    { readonly roleNames: readonly string[]; readonly permissionCount: number } | undefined;
  readonly actor: AdminFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { kind, rolesBefore, actor, at, words } = input;
  const target: AdminFact =
    input.asOfEvent === undefined
      ? input.target
      : {
          ...input.target,
          roleNames: input.asOfEvent.roleNames,
          permissionCount: input.asOfEvent.permissionCount,
        };
  const roles = (names: readonly string[]): string =>
    names.length === 0 ? words.noRole : names.join('، ');
  const values: Mutable = {
    heading: words.adminHeading(kind),
    targetName: target.displayName,
    targetUsername: target.username,
    targetTelegramId: target.telegramUserId ?? words.noTelegram,
    permissions: target.permissionCount,
    actorName: actor === null ? words.system : `@${actor.username}`,
    at,
  };
  if (kind === 'rolesChanged' && rolesBefore !== null) {
    values['rolesBefore'] = roles(rolesBefore);
    values['rolesAfter'] = roles(target.roleNames);
  } else {
    values['roles'] = roles(target.roleNames);
  }
  return {
    logType: 'ADMIN_CHANGED',
    templateKey: 'ops.log.admin_changed' as TemplateKey,
    values,
    buttons: [],
  };
}

// ---------------------------------------------------------------------------
// L21 — one service reached a threshold
// ---------------------------------------------------------------------------

export function serviceAlert(input: {
  readonly kind: string;
  readonly service: ServiceFact;
  readonly customer: CustomerFact | null;
  readonly remainingDays: number | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { kind, service, customer, remainingDays, at, words } = input;
  // Remaining traffic can be negative on the row if the panel over-reported; it is shown as
  // zero bytes, never as a negative figure and never as NaN.
  const remaining =
    service.trafficLimitBytes === 0n
      ? 0n
      : service.trafficLimitBytes > service.trafficUsedBytes
        ? service.trafficLimitBytes - service.trafficUsedBytes
        : 0n;
  const values: Mutable = {
    ...identityValues(customer, words),
    heading: words.reminderHeading(kind),
    status: words.serviceState(service.state),
    remainingBytes: remaining,
    at,
  };
  put(values, 'serviceUsername', service.providerUsername);
  put(values, 'panelName', service.panelName === '' ? null : service.panelName);
  values['remainingTime'] = words.timeLeft(remainingDays);
  if (service.lastSeenAt !== null) values['lastConnection'] = service.lastSeenAt;
  return {
    logType: 'SERVICE_ALERT',
    templateKey: 'ops.log.service_alert' as TemplateKey,
    values,
    buttons: [userButton(service.customerId), { kind: 'SERVICE', ref: service.id }],
  };
}

// ---------------------------------------------------------------------------
// L22 / L23 / L24 — the error reports
// ---------------------------------------------------------------------------

/** A short technical line: an HTTP status or a machine code, bounded and free of whitespace. */
export function technicalLine(...parts: (string | null | undefined)[]): string {
  const line = parts
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(' · ')
    .replace(/\s+/g, ' ')
    .trim();
  return line === '' ? '—' : line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** `HTTP 422` out of a stored failure message, when it names one; otherwise null. */
export function httpStatusIn(text: string | null): string | null {
  if (text === null) return null;
  const match =
    /\bHTTP[ _-]?(?:status )?(\d{3})\b/i.exec(text) ??
    /\b(?:status|code)[ :=]+(\d{3})\b/i.exec(text);
  return match?.[1] === undefined ? null : `HTTP ${match[1]}`;
}

export function provisionFailure(input: {
  readonly order: OrderFact;
  readonly customer: CustomerFact | null;
  readonly operation: OperationFact | null;
  readonly reason: string | null;
  readonly payment: PaymentFact | null;
  /** What the ledger says was credited back for this order; null when nothing was. */
  readonly refunded: Money | null;
  readonly unknown: boolean;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { order, customer, operation, reason, payment, refunded, unknown, at, words } = input;
  const cause = words.refundReason(reason, operation?.failureKind ?? null);
  const values: Mutable = {
    ...identityValues(customer, words),
    cause,
    technical: technicalLine(
      operation?.failureKind,
      reason,
      httpStatusIn(operation?.failureMessage ?? null),
    ),
    impact: unknown
      ? words.impact('pending')
      : refunded !== null
        ? `${words.impact('refundedToWallet')} (${formatMoneyText(refunded)})`
        : words.impact('notRefunded'),
    productTitle: order.title,
    amount: order.total,
    at,
  };
  put(values, 'panelName', order.panelName === '' ? null : order.panelName);
  put(values, 'orderCode', order.code);
  if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
  return {
    logType: 'ERROR_PROVISION',
    templateKey: 'ops.log.error_provision' as TemplateKey,
    values,
    buttons: [{ kind: 'PANEL', ref: order.panelId }, userButton(order.customerId)],
  };
}

export function operationFailure(input: {
  readonly order: OrderFact;
  readonly service: ServiceFact | null;
  readonly customer: CustomerFact | null;
  readonly operation: OperationFact | null;
  readonly reason: string | null;
  readonly payment: PaymentFact | null;
  /** What the ledger says was credited back for this order; null when nothing was. */
  readonly refunded: Money | null;
  readonly unknown: boolean;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { order, service, customer, operation, reason, payment, refunded, unknown, at, words } =
    input;
  const type = order.purpose === 'TRIAL' ? 'TRIAL' : (operation?.type ?? order.purpose);
  const values: Mutable = {
    ...identityValues(customer, words),
    operation: words.failedOperation(type),
    state: words.operationState(unknown ? 'UNKNOWN' : 'FAILED'),
    cause: words.refundReason(reason, operation?.failureKind ?? null),
    technical: technicalLine(
      operation?.failureKind,
      reason,
      httpStatusIn(operation?.failureMessage ?? null),
    ),
    impact: unknown
      ? words.impact('pending')
      : refunded !== null
        ? `${words.impact('refundedToWallet')} (${formatMoneyText(refunded)})`
        : order.purpose === 'TRIAL'
          ? words.impact('trialGivenBack')
          : words.impact('notRefunded'),
    at,
  };
  if (order.total.amountMinor > 0n) values['amount'] = order.total;
  put(values, 'serviceUsername', service?.providerUsername);
  put(
    values,
    'panelName',
    (service?.panelName ?? order.panelName) === '' ? null : (service?.panelName ?? order.panelName),
  );
  put(values, 'orderCode', order.code);
  if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
  if (unknown) values['retry'] = words.retry('UNKNOWN');
  return {
    logType: 'ERROR_OPERATION',
    templateKey: 'ops.log.error_operation' as TemplateKey,
    values,
    buttons: [
      ...(service === null ? [] : [{ kind: 'SERVICE' as const, ref: service.id }]),
      { kind: 'PANEL', ref: order.panelId },
    ],
  };
}

/**
 * `provisioning.stalled` as the error report it is (R5C-2 C1): a paid service that could not
 * be created (L23, `PROVISION` or no type) or any other operation that stalled (L24, named by
 * the R5A-2 wording). The outcome is NOT decided — nothing here says money moved — so the
 * customer line is «پول برنمی‌گردد تا نتیجه روشن شود»; a stall a refund already answered is
 * suppressed before it gets here.
 */
export function stalledReport(input: {
  readonly operationType: string;
  readonly reason: string | null;
  readonly service: ServiceFact;
  /** The order that created the service; used only for a PROVISION stall. */
  readonly order: OrderFact | null;
  readonly customer: CustomerFact | null;
  readonly payment: PaymentFact | null;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { operationType, reason, service, order, customer, payment, at, words } = input;
  const cause = words.refundReason(reason, null);
  const technical = technicalLine(reason, operationType);
  const impact = words.impact('pending');
  const panelName = service.panelName === '' ? null : service.panelName;
  if (operationType === 'PROVISION' && order !== null) {
    const values: Mutable = {
      ...identityValues(customer, words),
      cause,
      technical,
      impact,
      productTitle: order.title,
      amount: order.total,
      at,
    };
    put(values, 'panelName', panelName ?? (order.panelName === '' ? null : order.panelName));
    put(values, 'orderCode', order.code);
    if (payment !== null) put(values, 'reference', paymentTrackingCode(payment));
    return {
      logType: 'ERROR_PROVISION',
      templateKey: 'ops.log.error_provision' as TemplateKey,
      values,
      buttons: [{ kind: 'PANEL', ref: service.panelId }, userButton(service.customerId)],
    };
  }
  // The order that created the service is NOT this operation's order (a renewal has its
  // own), so no amount, order code or payment reference is claimed for it.
  const values: Mutable = {
    ...identityValues(customer, words),
    operation: words.stalledOperationTitle(operationType) ?? words.failedOperation(operationType),
    state: words.operationState('UNKNOWN'),
    cause,
    technical,
    impact,
    retry: words.retry('UNKNOWN'),
    at,
  };
  put(values, 'serviceUsername', service.providerUsername);
  put(values, 'panelName', panelName);
  return {
    logType: 'ERROR_OPERATION',
    templateKey: 'ops.log.error_operation' as TemplateKey,
    values,
    buttons: [
      { kind: 'SERVICE', ref: service.id },
      { kind: 'PANEL', ref: service.panelId },
    ],
  };
}

/**
 * A money amount as a plain Persian-digit sentence fragment, for the one place a template
 * placeholder cannot reach: a STRING value built from an amount (the customer-impact
 * sentence). Mirrors `formatMoney` — grouped thousands, the currency's Persian unit.
 */
export function formatMoneyText(amount: Money): string {
  const unit: Record<string, string> = {
    IRT: 'تومان',
    IRR: 'ریال',
    USD: 'دلار',
    EUR: 'یورو',
    USDT: 'تتر',
  };
  // Minor units are not major units (money review of #301): a dollar amount of 1234 minor
  // units is ۱۲٫۳۴ دلار, never ۱٬۲۳۴ دلار. The exponent is the currency's, as `formatMoney`'s.
  const exponent = CURRENCY_EXPONENT[amount.currency];
  const negative = amount.amountMinor < 0n;
  const magnitude = negative ? -amount.amountMinor : amount.amountMinor;
  const scale = 10n ** BigInt(exponent);
  const major = formatPersianInteger(magnitude / scale);
  const figure =
    exponent === 0
      ? major
      : `${major}٫${toPersianDigits((magnitude % scale).toString().padStart(exponent, '0'))}`;
  return `${negative ? '-' : ''}${figure} ${unit[amount.currency] ?? amount.currency}`;
}

// ---------------------------------------------------------------------------
// L26 — tickets
// ---------------------------------------------------------------------------

export function ticket(input: {
  readonly ticket: TicketFact;
  readonly customer: CustomerFact | null;
  readonly reply: boolean;
  readonly at: Date;
  readonly words: OpsLogWords;
}): Built {
  const { ticket: t, customer, reply, at, words } = input;
  const values: Mutable = {
    ...identityValues(customer, words),
    ticketNumber: toPersianDigits(t.number),
    category: t.categoryTitle,
    at,
  };
  put(values, 'snippet', firstTwoLines(t.snippetSource));
  return {
    logType: 'TICKET_NEW',
    templateKey: (reply
      ? 'ops.support.customer_replied'
      : 'ops.support.ticket_opened') as TemplateKey,
    values,
    buttons: [{ kind: 'TICKET', ref: t.id }, userButton(t.customerId)],
  };
}
