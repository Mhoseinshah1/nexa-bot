import { z } from 'zod';
import { CLIENT_APP_PLATFORMS } from './client-apps.js';
import { ORDER_PURPOSES, ORDER_STATES } from './commerce.js';
import { CUSTOMER_STATUSES } from './customer.js';
import { CURRENCY_CODES } from './money.js';
import { PAYMENT_METHODS, PAYMENT_STATES } from './payment.js';
import { SERVICE_STATES } from './provisioning.js';

/**
 * TB3 — the support context: what the support agent may know about one conversation.
 *
 * ADR-0034 §4 and ADR-0035. Built by the server from the conversation row's resolved
 * customer — the model never names a tenant or a customer — and emitted as THIS shape and
 * nothing else. Every object is `.strict()`, so a key that is not listed here is a parse
 * failure rather than a silent widening: adding a fact to what a model reads is a contract
 * change, reviewed on its own.
 *
 * JSON-safe by construction: money and byte counts are decimal strings, instants are ISO
 * strings. Internal ids never appear; a service, order or payment is named by a short
 * per-payload alias (`S1`, `O1`, `P1`), and the mapping back to a row stays on the server.
 * A knowledge entry is named `K1`, `K2`, … so a decision can cite it.
 *
 * NEVER part of this shape, by decision: a subscription URL or reference, a panel's name
 * or id, provider-side ids, raw service/order/payment ids, a payment's reference, external
 * reference or notes, the wallet ledger or balance, the customer's phone, Telegram id or
 * block reason, an incident's title or description, a service's customer note.
 */

/** How many of each family one payload carries, newest first. */
export const SUPPORT_CONTEXT_LIMITS = {
  services: 10,
  orders: 5,
  payments: 5,
  incidents: 3,
  clientApps: 6,
  /**
   * A8 (2026-10-07): at most eight knowledge entries, every one of them RELEVANT — an entry the
   * query does not match at all is never sent. It was twenty, chosen by recency and then by
   * relevance, and the byte budget cut most of them anyway.
   */
  knowledge: 8,
} as const;

/** A client app's rendered guide is cut to this many characters (an ellipsis marks a cut). */
export const SUPPORT_CONTEXT_GUIDE_MAX_CHARS = 1500;

/**
 * The serialised payload's budget, in UTF-8 bytes. A payload over it is cut by dropping
 * whole entries from the TAIL of each family, in `SUPPORT_CONTEXT_TRUNCATION_ORDER`, until
 * it fits. Flags are computed before any cut, so a dropped entry never clears a flag.
 */
export const SUPPORT_CONTEXT_MAX_BYTES = 24 * 1024;

/**
 * Which family gives way first (D2). Client apps first: they are long, and an app whose guide
 * is also an approved knowledge article carries no guide of its own. Knowledge next, but only
 * down to `SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES`; then the account facts; an incident
 * affecting this customer last; and the knowledge reserve only after everything else is gone.
 *
 * Knowledge used to give way FIRST, on the grounds that it was "retrievable again" — nothing
 * retrieved it, and in a realistic installation (six apps, twenty articles) no article reached
 * the model at all.
 */
export const SUPPORT_CONTEXT_TRUNCATION_ORDER = [
  'clientApps',
  'knowledge',
  'orders',
  'payments',
  'services',
  'incidents',
] as const;

/**
 * The knowledge entries' own share of `SUPPORT_CONTEXT_MAX_BYTES` (D2), as the UTF-8 bytes of
 * the knowledge array's JSON. Knowledge is cut in its turn only down to this, and never below
 * its first (most relevant) entry; the rest of it gives way only once every other family is
 * empty. A8 (2026-10-07): half of the 24 KiB budget, about three full Persian articles (it was
 * 6 KiB of 16 KiB, about two).
 */
export const SUPPORT_CONTEXT_KNOWLEDGE_RESERVE_BYTES = 12 * 1024;
export type SupportContextFamily = (typeof SUPPORT_CONTEXT_TRUNCATION_ORDER)[number];

/**
 * The status a customer is SHOWN for a service, derived from state, expiry and usage
 * (`provisioning/domain/service-display-status.ts`, which a unit test pins equal to this).
 */
export const SUPPORT_CONTEXT_SERVICE_DISPLAY_STATUSES = [
  'ACTIVE',
  'EXPIRED',
  'EXHAUSTED',
  'SUSPENDED',
  'PENDING',
  'UNRECONCILED',
  'TERMINATED',
] as const;

const instant = z.iso.datetime({ offset: true });
/** A non-negative or negative integer, as decimal digits: a bigint that survives JSON. */
const integerString = z.string().regex(/^-?(0|[1-9][0-9]*)$/u);
const byteString = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const text = (max: number) => z.string().max(max);

export const supportContextMoneySchema = z
  .object({ amountMinor: integerString, currency: z.enum(CURRENCY_CODES) })
  .strict();
export type SupportContextMoney = z.infer<typeof supportContextMoneySchema>;

export const supportContextCustomerSchema = z
  .object({
    status: z.enum(CUSTOMER_STATUSES),
    username: text(64).nullable(),
    firstName: text(256).nullable(),
    languageCode: text(16).nullable(),
    lastSeenAt: instant,
  })
  .strict();

export const supportContextServiceSchema = z
  .object({
    alias: z.string().regex(/^S[1-9][0-9]?$/u),
    /** The account's username on the panel, as the customer's own service card shows it. */
    label: text(128),
    productTitle: text(256).nullable(),
    locationLabel: text(256).nullable(),
    state: z.enum(SERVICE_STATES),
    displayStatus: z.enum(SUPPORT_CONTEXT_SERVICE_DISPLAY_STATUSES),
    isTrial: z.boolean(),
    expiresAt: instant.nullable(),
    /** `"0"` is unlimited. */
    trafficLimitBytes: byteString,
    trafficUsedBytes: byteString,
    /** Null when usage was never read, or the allowance is unlimited: never a guess. */
    remainingTrafficBytes: byteString.nullable(),
    usageSyncedAt: instant.nullable(),
    deviceLimit: z.number().int().nonnegative().nullable(),
    /** The customer can be re-sent a working link — never the link itself. */
    hasSubscriptionLink: z.boolean(),
    unreconciled: z.boolean(),
  })
  .strict();

export const supportContextOrderSchema = z
  .object({
    alias: z.string().regex(/^O[1-9][0-9]?$/u),
    state: z.enum(ORDER_STATES),
    purpose: z.enum(ORDER_PURPOSES),
    title: text(256),
    total: supportContextMoneySchema,
    createdAt: instant,
    settledAt: instant.nullable(),
    expiresAt: instant.nullable(),
  })
  .strict();

export const supportContextPaymentSchema = z
  .object({
    alias: z.string().regex(/^P[1-9][0-9]?$/u),
    amount: supportContextMoneySchema,
    method: z.enum(PAYMENT_METHODS),
    /** The template key naming the route as the customer saw it; null for a wallet payment. */
    routeLabelKey: z
      .string()
      .regex(/^bot\.payment\.route_name_[a-z_]+$/u)
      .nullable(),
    state: z.enum(PAYMENT_STATES),
    /** Ambiguous or awaiting a human: presented as «under review» and a hard handoff topic. */
    underReview: z.boolean(),
    createdAt: instant,
    confirmedAt: instant.nullable(),
  })
  .strict();

export const supportContextClientAppSchema = z
  .object({
    platform: z.enum(CLIENT_APP_PLATFORMS),
    name: text(128),
    description: text(512),
    guide: text(SUPPORT_CONTEXT_GUIDE_MAX_CHARS),
    helpUrl: text(2048).nullable(),
    officialUrl: text(2048).nullable(),
  })
  .strict();

export const supportContextIncidentSchema = z
  .object({
    /** The operator's customer-facing text, and only that — never the title or description. */
    customerMessage: text(2000),
    startedAt: instant,
    scheduledEndAt: instant.nullable(),
  })
  .strict();

/**
 * `FAQ` — an ACTIVE entry of the customer's FAQ screen, read live. `KNOWLEDGE` (TB8) — an
 * APPROVED and enabled support knowledge article (ADR-0035 §1): reviewed text, never a draft,
 * a candidate or a retired article.
 *
 * D2: the entries are the most RELEVANT to the customer's latest messages (a deterministic
 * lexical score over title, tags and body), most relevant first, so the byte budget, which cuts
 * from the tail, drops the least relevant.
 */
export const SUPPORT_CONTEXT_KNOWLEDGE_SOURCES = ['FAQ', 'KNOWLEDGE'] as const;
export const supportContextKnowledgeSchema = z
  .object({
    /**
     * The entry's alias (`K1`, `K2`, …, by position), which a decision cites in
     * `knowledgeRefs`. The decision schema has always required refs of this shape; before the
     * alias existed a model grounding a reply on knowledge had nothing valid to cite, and
     * whatever it wrote instead failed the decision's parse (support-agent runbook, §AI
     * diagnostics).
     */
    alias: z.string().regex(/^K[1-9][0-9]?$/u),
    source: z.enum(SUPPORT_CONTEXT_KNOWLEDGE_SOURCES),
    question: text(512),
    answer: text(4096),
  })
  .strict();

export const supportContextFlagsSchema = z
  .object({
    /** Any of the customer's payments is under review — over ALL of them, not the five shown. */
    hasUnderReviewPayment: z.boolean(),
    /**
     * Any of the customer's services is UNRECONCILED — over ALL of them, not the ten shown (L4),
     * like `hasUnderReviewPayment`.
     */
    hasUnreconciledService: z.boolean(),
    /** The conversation resolved to a customer of this tenant. False: public support only. */
    identityLinked: z.boolean(),
    /** The linked customer is BLOCKED (ADR-0033 / tb0-audit §3.6: handed off, never auto-answered). */
    customerBlocked: z.boolean(),
  })
  .strict();

export const supportContextPayloadSchema = z
  .object({
    generatedAt: instant,
    customer: supportContextCustomerSchema.nullable(),
    services: z.array(supportContextServiceSchema).max(SUPPORT_CONTEXT_LIMITS.services),
    orders: z.array(supportContextOrderSchema).max(SUPPORT_CONTEXT_LIMITS.orders),
    payments: z.array(supportContextPaymentSchema).max(SUPPORT_CONTEXT_LIMITS.payments),
    clientApps: z.array(supportContextClientAppSchema).max(SUPPORT_CONTEXT_LIMITS.clientApps),
    incidents: z.array(supportContextIncidentSchema).max(SUPPORT_CONTEXT_LIMITS.incidents),
    knowledge: z.array(supportContextKnowledgeSchema).max(SUPPORT_CONTEXT_LIMITS.knowledge),
    /** The `support.accounts` setting: the Telegram handles customers are pointed at. */
    supportAccounts: z.array(text(64)).max(10),
    flags: supportContextFlagsSchema,
  })
  .strict();

export type SupportContextPayload = z.infer<typeof supportContextPayloadSchema>;
export type SupportContextService = z.infer<typeof supportContextServiceSchema>;
export type SupportContextOrder = z.infer<typeof supportContextOrderSchema>;
export type SupportContextPayment = z.infer<typeof supportContextPaymentSchema>;
export type SupportContextClientApp = z.infer<typeof supportContextClientAppSchema>;
export type SupportContextIncident = z.infer<typeof supportContextIncidentSchema>;
export type SupportContextKnowledge = z.infer<typeof supportContextKnowledgeSchema>;
export type SupportContextCustomer = z.infer<typeof supportContextCustomerSchema>;
export type SupportContextFlags = z.infer<typeof supportContextFlagsSchema>;
