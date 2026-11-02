import {
  BUSINESS_MESSAGE_TEXT_MAX,
  type SUPPORT_AI_SERVICE_ACTION_KINDS,
  SUPPORT_AI_TOOL_CALL_LIMIT,
  supportAiStartPayload,
  type BusinessOutboundButton,
  type BusinessOutboundButtons,
  type PaymentState,
  type SupportAiActionKind,
  type SupportAiDecision,
  type SupportAiDeepLinkFlow,
} from '@nexa/contracts';

/**
 * Phase 4 PR-3 — the support AI's read-only tools and deep links, pure.
 *
 * Cross-cutting item 1: identity comes from the server, never from the conversation. A decision's
 * `action.target` is NOT an id: it is a fact alias the payload showed (`S2`, `C1`) and is resolved
 * ONLY through the server-side alias map of THIS customer's rows (`SupportContextBuild.references`).
 * Anything else — an alias the payload did not hold, a UUID, a code, a name, another customer's
 * anything — is refused (`tool_scope`) and nothing is read or attached. A fully fooled model can
 * therefore never point a tool at a row that is not this customer's.
 *
 * §0: nothing here performs a change. A plan is a link to show, a status to read, or a URL button
 * into the bot's own flow, where the customer acts and every rule is decided again.
 */

/** What the server knows about the conversation when it reads a decision's action. */
export interface ActionContext {
  /** The conversation resolved to a customer of this tenant. */
  readonly linked: boolean;
  /** `S…` alias → service id, for the services the payload SHOWED (after the byte budget). */
  readonly services: ReadonlyMap<string, string>;
  /** `C…` alias → product id, for the catalogue plans the payload showed. */
  readonly catalogue: ReadonlyMap<string, string>;
  /** The bot a deep link opens; null when its username is unknown (no deep link then). */
  readonly botUsername: string | null;
}

export type ActionRefusal =
  /** The target is not one of this customer's rows in this payload (or a target was not wanted). */
  | 'target'
  /** A tool about one customer's own account, for a customer NEXA could not link. */
  | 'unlinked'
  /** A deep link with no bot to open. */
  | 'no_bot';

export type ActionPlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'refused';
      readonly why: ActionRefusal;
      readonly action: Exclude<SupportAiActionKind, 'NONE'>;
    }
  /** `SEND_SUBSCRIPTION_LINK`: this customer's own service, resolved by the server. */
  | { readonly kind: 'subscription_link'; readonly serviceId: string }
  /** `PAYMENT_STATUS`: this customer's latest payments. */
  | { readonly kind: 'payment_status' }
  /**
   * A URL button into an existing bot flow. `productId` set (BUY with a plan): the plan's
   * category is read and opened instead of the whole catalogue. `trialCheck`: the customer's
   * trial eligibility is read first, and an ineligible customer gets no button (`tool_scope`).
   */
  | {
      readonly kind: 'deep_link';
      readonly action: SupportAiActionKind;
      readonly flow: SupportAiDeepLinkFlow;
      readonly id: string | null;
      readonly productId?: string;
      readonly trialCheck?: true;
    }
  /** A service action for an UNLINKED customer: the bot itself, where they sign in first. */
  | { readonly kind: 'open_bot'; readonly action: SupportAiActionKind };

const SERVICE_ALIAS = /^S[1-9][0-9]?$/u;
const PLAN_ALIAS = /^C[1-9][0-9]?$/u;

const SERVICE_FLOWS: Readonly<
  Record<
    Exclude<(typeof SUPPORT_AI_SERVICE_ACTION_KINDS)[number], 'SEND_SUBSCRIPTION_LINK'>,
    SupportAiDeepLinkFlow
  >
> = {
  RENEW: 'renew',
  ADD_TRAFFIC: 'addTraffic',
  ADD_TIME: 'addTime',
  CHANGE_LOCATION: 'changeLocation',
  ROTATE_LINK: 'rotate',
};

/** The decision's action as the server will carry it out — or the refusal. */
export function planAction(
  action: SupportAiDecision['action'],
  context: ActionContext,
): ActionPlan {
  if (action === undefined || action.kind === 'NONE') return { kind: 'none' };
  const target = action.target.trim();
  const kind = action.kind;
  const refused = (why: ActionRefusal): ActionPlan => ({ kind: 'refused', why, action: kind });
  const serviceId = (): string | null =>
    SERVICE_ALIAS.test(target) ? (context.services.get(target) ?? null) : null;
  switch (action.kind) {
    case 'SEND_SUBSCRIPTION_LINK': {
      if (!context.linked) return refused('unlinked');
      const id = serviceId();
      return id === null ? refused('target') : { kind: 'subscription_link', serviceId: id };
    }
    case 'PAYMENT_STATUS':
      if (!context.linked) return refused('unlinked');
      // The tool reads THIS customer's payments; it takes no target, so none is ever looked up.
      return target === '' ? { kind: 'payment_status' } : refused('target');
    case 'RENEW':
    case 'ADD_TRAFFIC':
    case 'ADD_TIME':
    case 'CHANGE_LOCATION':
    case 'ROTATE_LINK': {
      if (context.botUsername === null) return refused('no_bot');
      if (!context.linked) return { kind: 'open_bot', action: action.kind };
      const id = serviceId();
      return id === null
        ? refused('target')
        : { kind: 'deep_link', action: action.kind, flow: SERVICE_FLOWS[action.kind], id };
    }
    case 'BUY': {
      if (context.botUsername === null) return refused('no_bot');
      if (target === '') return { kind: 'deep_link', action: 'BUY', flow: 'buy', id: null };
      const productId = PLAN_ALIAS.test(target) ? context.catalogue.get(target) : undefined;
      return productId === undefined
        ? refused('target')
        : { kind: 'deep_link', action: 'BUY', flow: 'buy', id: null, productId };
    }
    case 'TRIAL':
      if (context.botUsername === null) return refused('no_bot');
      if (target !== '') return refused('target');
      return context.linked
        ? { kind: 'deep_link', action: 'TRIAL', flow: 'trial', id: null, trialCheck: true }
        : { kind: 'deep_link', action: 'TRIAL', flow: 'trial', id: null };
    case 'WALLET_TOPUP':
      if (context.botUsername === null) return refused('no_bot');
      return target === ''
        ? { kind: 'deep_link', action: 'WALLET_TOPUP', flow: 'topup', id: null }
        : refused('target');
  }
}

/** A bot deep link: `https://t.me/<bot>?start=<payload>`, or the bare bot for `open_bot`. */
export function deepLinkUrl(
  botUsername: string,
  flow: SupportAiDeepLinkFlow | null,
  id: string | null,
): string {
  return flow === null
    ? `https://t.me/${botUsername}`
    : `https://t.me/${botUsername}?start=${supportAiStartPayload(flow, id)}`;
}

/**
 * Cross-cutting item 7 — whether this tool call goes over the limit: `used` calls already in the
 * epoch, plus this one, more than `SUPPORT_AI_TOOL_CALL_LIMIT`.
 */
export function toolCallLimitReached(used: number, limit = SUPPORT_AI_TOOL_CALL_LIMIT): boolean {
  return used + 1 > limit;
}

/**
 * The one message an automatic reply becomes: the optional label line, the model's reply, what a
 * tool added (a link, the payment lines — server text, never the model's), and the optional
 * «مشکل حل شد؟». Null when it would not fit one Telegram message: the caller hands off rather
 * than cut a link or a fact in half.
 */
export function composeAiMessage(parts: {
  readonly label: string | null;
  readonly reply: string;
  readonly extra: string | null;
  readonly feedbackQuestion: string | null;
}): string | null {
  const text = [parts.label, parts.reply, parts.extra, parts.feedbackQuestion]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
  return text.length === 0 || text.length > BUSINESS_MESSAGE_TEXT_MAX ? null : text;
}

/** The keyboard of an automatic message: the tool's button, then 👍 / 👎, then the human button. */
export function composeButtons(parts: {
  readonly action: BusinessOutboundButton | null;
  readonly feedback: readonly [BusinessOutboundButton, BusinessOutboundButton] | null;
  readonly human: BusinessOutboundButton | null;
}): BusinessOutboundButtons | null {
  const rows: BusinessOutboundButton[][] = [];
  if (parts.action !== null) rows.push([parts.action]);
  if (parts.feedback !== null) rows.push([...parts.feedback]);
  if (parts.human !== null) rows.push([parts.human]);
  return rows.length === 0 ? null : rows;
}

// ---------------------------------------------------------------------------------------------
// Check-before-handoff («paid but not received») — the owner's decision: the case stays a HARD
// handoff, but the AI looks first and tells the customer the facts it can read, in ONE message.
// ---------------------------------------------------------------------------------------------

/** One of THIS customer's recent payments, as the check reads it (already in Persian). */
export interface PaymentCheckFact {
  /** The tracking code the customer quotes; null for a row from before codes existed. */
  readonly code: string | null;
  /** The amount through the one money formatter. */
  readonly amount: string;
  /** How it was paid, in Persian (the method's name). */
  readonly route: string;
  /** The gateway's provider code, for the person's summary only; null for none. */
  readonly gateway: string | null;
  readonly state: PaymentState;
  /** The Payment Operations Center's own «under review» predicate. */
  readonly underReview: boolean;
  /** The state as the customer is told it (under review wins). */
  readonly stateLabel: string;
  readonly createdAt: Date;
  /**
   * For a CONFIRMED payment of a purchase: the service it delivered, when that service is live
   * with a subscription to give. Null otherwise (not delivered yet, a renewal, a top-up).
   */
  readonly delivered: { readonly serviceId: string; readonly username: string } | null;
}

export type PaymentCheckBranch =
  /** A payment under review or waiting for the gateway: told, no outcome promised, hard handoff. */
  | { readonly kind: 'UNDER_REVIEW'; readonly payment: PaymentCheckFact }
  /** Confirmed, its service delivered: that service's link, «مشکل حل شد؟», and wait. */
  | {
      readonly kind: 'SETTLED_DELIVERED';
      readonly payment: PaymentCheckFact;
      readonly service: { readonly serviceId: string; readonly username: string };
    }
  /** Confirmed, but no delivered service to give (pending, a renewal, a top-up): hard handoff. */
  | { readonly kind: 'SETTLED_PENDING'; readonly payment: PaymentCheckFact }
  /** Nothing matching: ask ONCE for the receipt, the code or the amount and time. */
  | { readonly kind: 'NOT_FOUND' };

/**
 * Which branch the facts are in. `payments` are THIS customer's (the reader's WHERE), newest
 * first, already bounded to the check's window. A payment still open (under review, PENDING,
 * UNKNOWN) decides first — it is the one the customer most likely means and the one whose
 * outcome nobody may promise; then the newest CONFIRMED one. Failed, cancelled and expired
 * payments match nothing the customer could be owed a service for.
 */
export function paymentCheckBranch(payments: readonly PaymentCheckFact[]): PaymentCheckBranch {
  const open = payments.find(
    (payment) => payment.underReview || payment.state === 'PENDING' || payment.state === 'UNKNOWN',
  );
  if (open !== undefined) return { kind: 'UNDER_REVIEW', payment: open };
  const confirmed = payments.find((payment) => payment.state === 'CONFIRMED');
  if (confirmed === undefined) return { kind: 'NOT_FOUND' };
  return confirmed.delivered === null
    ? { kind: 'SETTLED_PENDING', payment: confirmed }
    : { kind: 'SETTLED_DELIVERED', payment: confirmed, service: confirmed.delivered };
}

/** The Persian words of the handoff summary a person reads (operator text, never a customer's). */
export const PAYMENT_CHECK_SUMMARY_WORDS = {
  title: 'بررسی پیش از ارجاع («پرداخت کردم ولی نرسید»)',
  customer: 'مشتری',
  unlinked: 'مشتری به حسابی در ربات وصل نیست',
  payments: 'پرداخت‌های دو هفتهٔ اخیر',
  none: 'هیچ پرداختی پیدا نشد',
  told: 'به مشتری گفته شد',
  noCode: 'بدون کد',
  afterAsk: 'مشتری پس از درخواست رسید یا کد پیگیری پاسخ داد؛ پاسخ او در همین گفتگو است',
  afterLink: 'لینک سرویس فرستاده شد ولی مشتری حل شدن مشکل را تأیید نکرد',
} as const;

/**
 * The note the person who takes the conversation reads: the customer, every payment found (code,
 * state, amount, route), and what the AI already told the customer. Never the customer's words —
 * the transcript is there for that. Bounded to the escalation summary's length.
 */
export function paymentCheckSummary(input: {
  readonly customerId: string | null;
  readonly payments: readonly PaymentCheckFact[];
  readonly told: string;
  readonly max: number;
}): string {
  const w = PAYMENT_CHECK_SUMMARY_WORDS;
  const who = input.customerId === null ? w.unlinked : `${w.customer}: ${input.customerId}`;
  const found =
    input.payments.length === 0
      ? w.none
      : input.payments
          .map(
            (payment) =>
              `${payment.code ?? w.noCode} — ${payment.stateLabel} — ${payment.amount} — ${payment.route}${payment.gateway === null ? '' : ` (${payment.gateway})`}`,
          )
          .join('؛ ');
  const text = `${w.title}. ${who}. ${w.payments}: ${found}. ${w.told}: «${input.told}»`;
  return text.length <= input.max ? text : `${text.slice(0, input.max - 1)}…`;
}
