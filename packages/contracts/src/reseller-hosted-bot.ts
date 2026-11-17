import { z } from 'zod';
import { secondFactorProofSchema } from './admin-security.js';
import { moneySchema, type MoneyWire } from './money.js';
import { HOSTED_BOT_STATES, type HostedBotState } from './hosting.js';
export * from './reseller-hosted-bot-keys.js';
import {
  RESELLER_BOT_REJECT_REASON_MAX,
  RESELLER_BOT_REJECT_REASON_MIN,
} from './reseller-hosted-bot-keys.js';

/**
 * Reseller-phase PR-6 (§5.9) — a dedicated hosted bot for a reseller, paid monthly from the
 * reseller's wallet.
 *
 * A reseller of the INSTALLATION tenant asks for a hosted bot (Phase 6A/6B) with their own
 * Telegram bot token and, optionally, a domain. The installation owner approves the request in
 * «میزبانی‌ها» → «درخواست‌های نماینده‌ها», which debits the first month (`HOSTED_BOT_FEE`) under
 * the reseller's wallet lock, then creates the hosted bot through the EXISTING creator flow,
 * pre-filled from and linked to the request. The activation link the owner issues is sent to the
 * reseller in Telegram. A renewal job debits each later period once; a short wallet earns one
 * notice a day during the grace days, then the hosted bot is stopped through the existing stop
 * path (data kept), and resumed when a debit succeeds again.
 *
 * Only the installation tenant offers it: hosting is the installation owner's alone (ADR-0038).
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * A request's lifecycle. `PENDING` waits for the owner; `APPROVED` was charged its first month
 * and is the subscription from then on; `REJECTED` (the owner's, with a reason) and `CANCELLED`
 * (the reseller's, while pending) are terminal and never charged.
 */
export const RESELLER_BOT_REQUEST_STATES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type ResellerBotRequestState = (typeof RESELLER_BOT_REQUEST_STATES)[number];

/** What one fee debit was: the approval's first month, a renewal, or the reseller's own pay. */
export const RESELLER_BOT_CHARGE_KINDS = ['APPROVAL', 'RENEWAL', 'REACTIVATION'] as const;
export type ResellerBotChargeKind = (typeof RESELLER_BOT_CHARGE_KINDS)[number];

/** Why a subscription is in the state it is, as the reseller and the owner are shown it. */
export const RESELLER_BOT_BILLING_STATES = [
  /** Not approved yet, or never will be. */
  'NONE',
  /** The current period is paid. */
  'PAID',
  /** The current period is unpaid and the grace days are running. */
  'GRACE',
  /** The grace days ended unpaid and the hosted bot was stopped (data kept). */
  'STOPPED',
] as const;
export type ResellerBotBillingState = (typeof RESELLER_BOT_BILLING_STATES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const RESELLER_BOT_ERROR_CODES = {
  /** The fee is not set (or this tenant is not the installation): nothing is offered. */
  NOT_OFFERED: 'reseller_bot.not_offered',
  /** The customer is not an ACTIVE reseller of this installation. */
  NOT_RESELLER: 'reseller_bot.not_reseller',
  /** No such request — or another reseller's: the same answer for both. */
  REQUEST_NOT_FOUND: 'reseller_bot.request_not_found',
  /** The reseller already has a request waiting for the owner. */
  REQUEST_OPEN: 'reseller_bot.request_open',
  /** The request is not in a state that allows this. */
  STATE_CONFLICT: 'reseller_bot.state_conflict',
  /** Not a Telegram bot token's shape. */
  TOKEN_MALFORMED: 'reseller_bot.token_malformed',
  /** Telegram refused the token (`getMe`), or it is not a bot's. */
  TOKEN_REJECTED: 'reseller_bot.token_rejected',
  /** Telegram could not be asked. */
  TOKEN_UNREACHABLE: 'reseller_bot.token_unreachable',
  /** Another open or approved request already names this Telegram bot. */
  TOKEN_IN_USE: 'reseller_bot.token_in_use',
  /** Not a bare domain name. */
  DOMAIN_INVALID: 'reseller_bot.domain_invalid',
  /** The wallet does not hold the fee: nothing was charged. No credit, never negative. */
  INSUFFICIENT_FUNDS: 'reseller_bot.insufficient_funds',
  /** The request has no hosted bot yet. */
  NOT_LINKED: 'reseller_bot.not_linked',
  /** The request already has its hosted bot. */
  ALREADY_LINKED: 'reseller_bot.already_linked',
  /** Nothing is owed: the current period is paid. */
  NOTHING_DUE: 'reseller_bot.nothing_due',
} as const;

// ---------------------------------------------------------------------------
// HTTP (owner side, under API_PREFIX; the reseller side follows with the reseller panel)
// ---------------------------------------------------------------------------

export const RESELLER_BOT_ADMIN_ROUTES = {
  list: '/hosting/reseller-bot-requests',
  approve: '/hosting/reseller-bot-requests/:requestId/approve',
  reject: '/hosting/reseller-bot-requests/:requestId/reject',
  configure: '/hosting/reseller-bot-requests/:requestId/configure',
} as const;

const idempotencyKey = z.string().min(8).max(255);

/** The owner's approval: a fresh code, like every sensitive action in the creator panel. */
export const resellerBotApproveRequestSchema = z.object({
  idempotencyKey,
  proof: secondFactorProofSchema,
});
export type ResellerBotApproveRequest = z.infer<typeof resellerBotApproveRequestSchema>;

export const resellerBotRejectRequestSchema = z.object({
  idempotencyKey,
  reason: z.string().trim().min(RESELLER_BOT_REJECT_REASON_MIN).max(RESELLER_BOT_REJECT_REASON_MAX),
});
export type ResellerBotRejectRequest = z.infer<typeof resellerBotRejectRequestSchema>;

/**
 * Hands the request's stored token to the hosted bot's activation («توکن و دامنه»): the token
 * never travels through the owner's browser. The domain is the request's, or the owner's.
 */
export const resellerBotConfigureRequestSchema = z.object({
  idempotencyKey,
  proof: secondFactorProofSchema,
  domain: z.string().trim().min(1).max(260),
});

/** The reseller's request (their panel or bot). The token is never returned. */
export const resellerBotSubmitRequestSchema = z.object({
  idempotencyKey,
  botToken: z.string().trim().min(10).max(256),
  /** Optional: a domain the reseller already pointed at this server. */
  domain: z.string().trim().min(1).max(260).nullable().optional(),
});
export type ResellerBotSubmitRequest = z.infer<typeof resellerBotSubmitRequestSchema>;

export const resellerBotCancelRequestSchema = z.object({ idempotencyKey });
export const resellerBotPayRequestSchema = z.object({ idempotencyKey });

/** One step of a request's history, newest last. */
export const RESELLER_BOT_TIMELINE_EVENTS = [
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'BOT_CREATED',
  'LINK_SENT',
  'CHARGED',
  'STOPPED',
  'RESUMED',
] as const;
export type ResellerBotTimelineEvent = (typeof RESELLER_BOT_TIMELINE_EVENTS)[number];

export interface ResellerBotTimelineEntry {
  readonly event: ResellerBotTimelineEvent;
  readonly at: string;
  /** CHARGED: the amount; REJECTED: nothing here (the reason is on the request). */
  readonly amount: MoneyWire | null;
  /** CHARGED: the period number (1 = the first month). */
  readonly period: number | null;
}

/** A request as its reseller sees it: the token only masked. */
export interface ResellerBotRequestView {
  readonly id: string;
  readonly number: string;
  readonly state: ResellerBotRequestState;
  readonly botUsername: string;
  /** A display form of the stored token, never the token. */
  readonly tokenMasked: string;
  readonly domain: string | null;
  readonly fee: MoneyWire;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
  readonly cancelledAt: string | null;
  readonly hostedBot: { readonly linked: boolean; readonly state: HostedBotState | null };
  readonly billing: {
    readonly state: ResellerBotBillingState;
    /** End of the last paid period. */
    readonly paidThrough: string | null;
    /** While in GRACE: when the bot stops if still unpaid. */
    readonly stopsAt: string | null;
  };
  readonly timeline: readonly ResellerBotTimelineEntry[];
}

/** «ربات اختصاصی»: whether it is offered, for how much, and whether a request may be filed. */
export interface ResellerBotOfferView {
  readonly offered: boolean;
  readonly fee: MoneyWire | null;
  readonly graceDays: number;
  /** False while a request waits, or the customer is not an ACTIVE reseller. */
  readonly canRequest: boolean;
}

/** A request as the owner sees it in «درخواست‌های نماینده‌ها». */
export interface ResellerBotRequestAdminView extends ResellerBotRequestView {
  readonly customer: {
    readonly id: string;
    readonly displayName: string | null;
    readonly telegramUserId: string | null;
  };
  /** The hosted bot linked to the request, by tenant id. */
  readonly hostedTenantId: string | null;
}

/** Newest-first keyset pages. The cursor is the last request id, scoped to the installation.
 * Later inserts ahead of it appear on refresh; this is not a historical snapshot.
 */
export const RESELLER_BOT_ADMIN_PAGE_SIZE = 50;
export const RESELLER_BOT_ADMIN_PAGE_MAX = 100;
export const resellerBotAdminListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(RESELLER_BOT_ADMIN_PAGE_MAX)
    .default(RESELLER_BOT_ADMIN_PAGE_SIZE),
});
export type ResellerBotAdminListQuery = z.input<typeof resellerBotAdminListQuerySchema>;

export interface ResellerBotRequestsAdminResponse {
  readonly nextCursor: string | null;
  readonly requests: readonly ResellerBotRequestAdminView[];
  readonly settings: { readonly fee: MoneyWire | null; readonly graceDays: number };
}

export interface ResellerBotRequestAdminResponse {
  readonly request: ResellerBotRequestAdminView;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// HTTP (reseller side, the reseller web panel's «ربات اختصاصی»)
// ---------------------------------------------------------------------------

/**
 * The reseller panel's request body. The idempotency key travels in the panel's
 * `idempotency-key` header (`RESELLER_IDEMPOTENCY_HEADER`), never in the body.
 */
export const resellerOwnBotSubmitBodySchema = resellerBotSubmitRequestSchema.omit({
  idempotencyKey: true,
});
export type ResellerOwnBotSubmitBody = z.infer<typeof resellerOwnBotSubmitBodySchema>;

const isoInstant = z.string();

export const resellerBotTimelineEntrySchema = z.object({
  event: z.enum(RESELLER_BOT_TIMELINE_EVENTS),
  at: isoInstant,
  amount: moneySchema.nullable(),
  period: z.number().int().nullable(),
});

/** `ResellerBotRequestView` on the wire, for the panel to parse every answer by. */
export const resellerBotRequestViewSchema = z.object({
  id: z.string(),
  number: z.string(),
  state: z.enum(RESELLER_BOT_REQUEST_STATES),
  botUsername: z.string(),
  tokenMasked: z.string(),
  domain: z.string().nullable(),
  fee: moneySchema,
  createdAt: isoInstant,
  decidedAt: isoInstant.nullable(),
  rejectReason: z.string().nullable(),
  cancelledAt: isoInstant.nullable(),
  hostedBot: z.object({ linked: z.boolean(), state: z.enum(HOSTED_BOT_STATES).nullable() }),
  billing: z.object({
    state: z.enum(RESELLER_BOT_BILLING_STATES),
    paidThrough: isoInstant.nullable(),
    stopsAt: isoInstant.nullable(),
  }),
  timeline: z.array(resellerBotTimelineEntrySchema),
});

export const resellerBotOfferViewSchema = z.object({
  offered: z.boolean(),
  fee: moneySchema.nullable(),
  graceDays: z.number().int(),
  canRequest: z.boolean(),
});

/** `GET own-bot`: the offer and the reseller's own requests, newest first. */
export const resellerOwnBotResponseSchema = z.object({
  offer: resellerBotOfferViewSchema,
  requests: z.array(resellerBotRequestViewSchema),
});
export type ResellerOwnBotResponse = z.infer<typeof resellerOwnBotResponseSchema>;
