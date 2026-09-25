import { z } from 'zod';
import { MAX_MONEY_AMOUNT_MINOR } from './money.js';
import type { PaymentMethod } from './payment.js';

/**
 * The payment ROUTES an operator offers, and the conditions under which a customer
 * sees each one.
 *
 * ## What a gateway is here, and what it is not
 *
 * A gateway is the route a customer chooses and the configuration around it: what it is
 * called, where it sits in the list, what it will accept, who may see it, and what the
 * customer is told about it. It is NOT how settlement happens — that is `PaymentMethod`,
 * and a gateway NAMES the method it settles through rather than becoming one.
 *
 * The two are separate because they answer different questions and change for different
 * reasons. `payment.ts` already records that `GATEWAY` as a method has no adapter in
 * this release and is REFUSED rather than simulated; that stays exactly as true. What
 * this file adds is the configuration layer above it, which the one route this
 * installation can actually perform needs today.
 *
 * ## The evidence, and the one thing it must not become
 *
 * The legacy system's `💎 مالی` is exclusively a gateway manager: eleven gateways, each
 * with the SAME base schema, differing only in per-gateway credential and endpoint
 * fields (`FBR-001`, `FBR-009`). The Web Admin's half configures enable, three
 * eligibility numbers, min/max amount and a cashback percent, and counts the roster at a
 * fixed eleven with no Add Gateway (`WEB-BR-012`). `کارت به کارت` — card-to-card, the
 * manual transfer this product already performs — is one of those eleven, carrying
 * exactly that schema. So modelling the manual route as a gateway ROW is what the
 * evidence shows rather than an extension of it.
 *
 * What the evidence must NOT become is a roster of eleven provider names. Nine of those
 * eleven are third parties with no adapter here, and `PAYMENT_METHODS` states the rule
 * that settles it: what a product publishes is how it tells an operator what it can do,
 * and a member with nothing behind it is that defect with money attached. The catalogue
 * below holds exactly the routes this codebase can operate, and grows in the commit that
 * brings an adapter — never before it.
 *
 * ## There is no gateway id
 *
 * A route is identified by `(tenant, provider)` and nothing else, which is the roster
 * being fixed by construction rather than by a unique index bolted onto a surrogate key.
 * Two consequences, both deliberate: a surface addresses a route by a value from a
 * CLOSED enum, so a crafted identifier fails at the schema instead of becoming a lookup
 * that has to remember to filter by tenant; and the audit row's `entityId` is the
 * provider name, so "who switched card-to-card off" reads as that rather than as a uuid.
 */

/**
 * The routes this installation can operate, as code rather than rows.
 *
 * The same rule `ADR-0023` states for panels: a provider TYPE is code, the adapter is
 * resolved before the row is written, and a route that cannot be operated must not
 * become a row. A `ZARINPAL` member here with no verification path behind it would be an
 * operator switching on a payment route that silently cannot take money.
 *
 * - `MANUAL_TRANSFER` — the customer transfers out of band and submits evidence; an
 *   operator with `receipts.review` confirms it. Fully operable today: 5A gives it a
 *   structured destination, 5R the receipt, 5T the review from Telegram.
 */
export const PAYMENT_GATEWAY_PROVIDERS = ['MANUAL_TRANSFER'] as const;
export type PaymentGatewayProvider = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
export const paymentGatewayProviderSchema = z.enum(PAYMENT_GATEWAY_PROVIDERS);

/**
 * What each route needs and how it settles, so no caller infers either from the name.
 *
 * `settlesVia` is what makes this layer provider-neutral in the only way that matters: a
 * caller asks the descriptor which `PaymentMethod` the route produces rather than
 * branching on the provider. When an external route lands, its descriptor says `GATEWAY`
 * and the branch that would otherwise have to be written already exists.
 *
 * `requiresCredentials` is declared and is `false` for every member, which is WHY this
 * release stores no credential column at all. `FBR-009` establishes that the legacy
 * gateways differ from one another exactly in their credential and endpoint fields, so
 * the field belongs to the route rather than to the base schema — and an encrypted
 * column with no producer is the placeholder abstraction the conventions refuse. The
 * panels module already holds the pattern for storing one when a route needs it, down to
 * the rule that a credential travels one way and no projection can read it back.
 */
export interface PaymentGatewayDescriptor {
  readonly provider: PaymentGatewayProvider;
  readonly settlesVia: PaymentMethod;
  readonly requiresCredentials: boolean;
}

export const PAYMENT_GATEWAY_DESCRIPTORS: {
  readonly [K in PaymentGatewayProvider]: PaymentGatewayDescriptor;
} = {
  MANUAL_TRANSFER: {
    provider: 'MANUAL_TRANSFER',
    settlesVia: 'MANUAL_TRANSFER',
    requiresCredentials: false,
  },
};

/**
 * Whether the route is offered at all.
 *
 * Two states, named as the panels module names them and for the reason `ADR-0023`
 * records: `DISABLED` is the operator saying stop using this for now, which is a
 * different fact from a route a particular customer is merely ineligible for. Folding
 * them into one boolean would make "why can this customer not see card-to-card"
 * unanswerable — and that question has two very different answers, one of which is a
 * misconfiguration the operator has to fix.
 */
export const PAYMENT_GATEWAY_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type PaymentGatewayStatus = (typeof PAYMENT_GATEWAY_STATUSES)[number];
export const paymentGatewayStatusSchema = z.enum(PAYMENT_GATEWAY_STATUSES);

/**
 * Operator-facing AND customer-facing: the name is the label the route is chosen by.
 *
 * NULLABLE everywhere it is stored, and `null` means "use the product's own name for
 * this route" rather than "unnamed". That is what lets a route exist before anybody has
 * typed anything: the upgrade that creates a tenant's manual route writes no copy, and a
 * migration inventing a Persian label would be a surface string in a SQL file — the one
 * place `docs/conventions.md`'s template rule cannot reach it.
 */
export const PAYMENT_GATEWAY_NAME_MAX_LENGTH = 60;

/**
 * The customer-facing instruction for this route, stored RAW.
 *
 * The legacy system calls it a tutorial (`FBR-009`), and it is the field
 * `INCIDENT-FIN-001` overwrote in production — by typing a navigation string into a
 * prompt that had outlived its question. Nothing here is captured from a conversation:
 * it is submitted whole, through a form, by an operator who can see its current value,
 * which is the same correction 5A applied to the destination.
 *
 * Raw, never rendered before storage. `docs/conventions.md`'s rule, and the reason the
 * legacy system baked an admin's own name into `{first_name}` for 13,700 customers.
 */
export const PAYMENT_GATEWAY_INSTRUCTIONS_MAX_LENGTH = 1000;

/** The bounds `PAYMENT_ACCOUNT_SORT_*` uses, for the same `(sort, provider)` ordering rule. */
export const PAYMENT_GATEWAY_SORT_MIN = 0;
export const PAYMENT_GATEWAY_SORT_MAX = 100_000;

/**
 * The ceiling on an eligibility threshold, as a rail rather than a policy.
 *
 * A payment count or a day count above this is not a rule anybody meant — it is a typo,
 * or an amount pasted into the wrong field. The effect of accepting one is a route no
 * customer will ever be eligible for, with nothing on screen saying why.
 */
export const PAYMENT_GATEWAY_THRESHOLD_MAX = 100_000;

/**
 * An eligibility threshold, where `0` means the condition is OFF.
 *
 * `WEB-BR-014` reads that semantics off the legacy form's own instruction text, so it is
 * evidenced rather than chosen — and it is why these are three plain counters rather
 * than three nullable ones. A nullable column would give "off" two spellings, and the
 * one that got written by a migration would be the one nothing tested.
 */
const thresholdSchema = z.number().int().min(0).max(PAYMENT_GATEWAY_THRESHOLD_MAX);

/**
 * The top-up gift a route promises, as a whole percentage of a top-up's principal
 * (Payment File 02 §17, `docs/payments-file02-design.md` D5).
 *
 * `0` means no gift, and it is the default — the same "0 is off" spelling the thresholds
 * use. A top-up payment SNAPSHOTS this value when it is created, from the route it was
 * offered through, and the payments guard trigger freezes the snapshot: an operator
 * changing the percentage later cannot change a promise already made. The gift is
 * `floor(principal × percent / 100)`, a separate `CASHBACK_TOPUP` entry, and written only
 * when above zero.
 *
 * Per ROUTE, so it applies to the manual transfer today and to any external gateway that
 * inherits the column later.
 */
export const PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN = 0;
export const PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX = 100;
export const topupCashbackPercentSchema = z
  .number()
  .int()
  .min(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MIN)
  .max(PAYMENT_GATEWAY_TOPUP_CASHBACK_PERCENT_MAX);

/**
 * Who may see a route, keyed on the customer's own history.
 *
 * `FBR-005` establishes all three controls verbatim, and `FBR-011` establishes the
 * negative that matters just as much: gateway gating keys off payment count and days
 * since joining, and NEVER off the customer's tier. Product visibility, discount codes
 * and cashback-on-topup all key off the tier in the legacy system; payment routes do
 * not. A tier here would be inventing a rule the evidence specifically contradicts —
 * and the tier itself is Phase 7.
 *
 * - `activateAfterPayments` — hidden until the customer has at least this many confirmed
 *   payments. `🔒 فعال‌سازی ... پس از X پرداخت`.
 * - `deactivateAfterPayments` — hidden once the customer has at least this many. `🚫
 *   غیرفعال‌سازی ... پس از X پرداخت`, which is the Web Admin's `hide-after-N`.
 * - `activateAfterAccountDays` — hidden until the account is at least this many days
 *   old. `⏳ فعال‌سازی ... پس از X روز عضویت`.
 *
 * What the evidence does NOT establish is what a legacy installation does when the two
 * payment-count bounds cross, and it cannot be read off a screen without writing a value
 * to a production gateway — which is what `INCIDENT-FIN-001` was. This product refuses
 * that configuration instead of resolving it: see `paymentGatewayConfigSchema`.
 */
export interface PaymentGatewayEligibility {
  readonly activateAfterPayments: number;
  readonly deactivateAfterPayments: number;
  readonly activateAfterAccountDays: number;
}

/**
 * Why a route is not being offered to this customer, or that it is.
 *
 * Every refusal is NAMED rather than collapsed into a boolean, because an operator
 * looking at "this customer cannot pay" needs to know which of four things they are
 * looking at — three of which are their own configuration, and one of which is simply a
 * new customer.
 */
export const PAYMENT_GATEWAY_INELIGIBILITY_REASONS = [
  /** The operator switched the route off. Not a fact about the customer at all. */
  'DISABLED',
  /** Fewer confirmed payments than `activateAfterPayments` requires. */
  'TOO_FEW_PAYMENTS',
  /** At or past `deactivateAfterPayments`. */
  'TOO_MANY_PAYMENTS',
  /** The account is younger than `activateAfterAccountDays`. */
  'ACCOUNT_TOO_NEW',
] as const;
export type PaymentGatewayIneligibilityReason =
  (typeof PAYMENT_GATEWAY_INELIGIBILITY_REASONS)[number];

/**
 * What an operator submits for one route.
 *
 * There is no `provider` field and no `status` field. The provider is the row's
 * identity, and editing it would silently move every threshold, limit and instruction an
 * operator wrote for one route onto another. The status is its own command for the
 * reason `PaymentAccountService` states about `setEnabled`: folding "switch this off"
 * into the edit makes "who stopped accepting card-to-card, and when" answerable only by
 * diffing two field sets.
 *
 * ## The amounts
 *
 * Minor units and nothing else — never a float, never a bare number. There is no
 * `currency` field, and its absence is deliberate rather than an omission: `FBR-010`
 * records that no legacy gateway exposes a currency, a fee or an exchange rate anywhere
 * (Telegram Stars, billed in Stars, has no conversion rate at all), and this product has
 * one denomination per installation in `sales.currency`. A per-route currency would be a
 * second denomination with no conversion to reach it, which is the FX guess the money
 * model refuses.
 *
 * `0` for either bound means unbounded on that side — the same "0 is off" spelling
 * `WEB-BR-014` establishes for the eligibility fields, kept consistent so an operator
 * does not have to hold two conventions in mind on one form.
 */
export const paymentGatewayConfigSchema = z
  .object({
    /*
     * Cleared means "use the product's own name", exactly as `instructions` below means
     * "the route adds nothing". Both go to `null` so that a cleared field is a decision
     * the model can represent, rather than an empty string nobody renders well.
     */
    displayName: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
      })
      .refine((value) => value === null || value.length <= PAYMENT_GATEWAY_NAME_MAX_LENGTH, {
        message: `must be at most ${PAYMENT_GATEWAY_NAME_MAX_LENGTH} characters`,
      }),
    /*
     * An empty string means "no per-route instruction", not "an instruction that is
     * empty" — the rule `paymentAccountInputSchema.iban` states, for the same reason: a
     * web form submits `''` for a field the operator cleared, and refusing it would make
     * clearing one impossible through the only surface that can.
     */
    instructions: z
      .union([z.string(), z.null()])
      .optional()
      .transform((value) => {
        if (value === undefined || value === null) return null;
        const trimmed = value.trim();
        return trimmed === '' ? null : trimmed;
      })
      .refine(
        (value) => value === null || value.length <= PAYMENT_GATEWAY_INSTRUCTIONS_MAX_LENGTH,
        { message: `must be at most ${PAYMENT_GATEWAY_INSTRUCTIONS_MAX_LENGTH} characters` },
      ),
    /*
     * Bounded ABOVE, and the ceiling is the column's rather than the product's.
     *
     * `payment_gateways.min_amount_minor` and its maximum are PostgreSQL `bigint`. A
     * larger value parses here, passes the wire schema's nineteen-digit regex, and then
     * fails inside the UPDATE as a range error the operator meets as a 500 — for what is
     * an out-of-range field, which is a validation response. `MAX_MONEY_AMOUNT_MINOR` is
     * that column's ceiling written down, so the refusal happens where every other
     * refusal about these two numbers already happens.
     */
    minAmountMinor: z.bigint().min(0n).max(MAX_MONEY_AMOUNT_MINOR),
    maxAmountMinor: z.bigint().min(0n).max(MAX_MONEY_AMOUNT_MINOR),
    eligibility: z.object({
      activateAfterPayments: thresholdSchema,
      deactivateAfterPayments: thresholdSchema,
      activateAfterAccountDays: thresholdSchema,
    }),
    sortOrder: z.number().int().min(PAYMENT_GATEWAY_SORT_MIN).max(PAYMENT_GATEWAY_SORT_MAX),
    /** The top-up gift, 0–100. See `topupCashbackPercentSchema`. */
    topupCashbackPercent: topupCashbackPercentSchema,
    /*
     * Per PURPOSE (customer UX completion §D/§F). Both default to true so a client on
     * the previous release, which sends neither, keeps the route offered for both — the
     * state every existing row is in. `status` still decides whether the route is
     * offered at all; these decide for what.
     */
    allowServicePurchase: z.boolean().optional().default(true),
    allowWalletTopup: z.boolean().optional().default(true),
  })
  .superRefine((value, ctx) => {
    /*
     * A window that admits nothing is refused rather than stored.
     *
     * Both of these produce a route that is configured, switched on, and impossible to
     * pay through — and neither says so anywhere an operator would look. The legacy
     * system has no such check, and `FBR-008` could not establish what it does when
     * limits conflict because resolving that would have meant writing to a production
     * gateway. Refusing at the boundary is the answer that needs no evidence: the
     * operator is told while they can still fix it.
     */
    if (value.maxAmountMinor > 0n && value.maxAmountMinor < value.minAmountMinor) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxAmountMinor'],
        message: 'the maximum must not be below the minimum',
      });
    }
    const { activateAfterPayments, deactivateAfterPayments } = value.eligibility;
    if (
      activateAfterPayments > 0 &&
      deactivateAfterPayments > 0 &&
      deactivateAfterPayments <= activateAfterPayments
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['eligibility', 'deactivateAfterPayments'],
        message:
          'the hide-after count must be above the show-after count, or no customer is ever eligible',
      });
    }
  });

export type PaymentGatewayConfig = z.output<typeof paymentGatewayConfigSchema>;

/**
 * The parity field this release deliberately does NOT store, and why.
 *
 * Recorded here rather than in a document, because this is the file somebody reads when
 * they wonder where it went.
 *
 * - **Customer-facing button colour** (`FBR-002`, `FBR-003`). The legacy control tints
 *   the route's button the way `🎨 رنگ محصول` tints a product's. Nexa has no
 *   product-colour idiom to reuse and no customer-facing gateway CHOOSER to render one
 *   in — with a single operable route the customer is shown that route, not a list. A
 *   stored colour nothing renders is configuration an operator would believe and nothing
 *   honours.
 *
 * The per-gateway cashback percent (`FBR-006`, `WEB-BR-021`) used to be listed here. It
 * is built now — Payment File 02 §17 asked for it and D5 honours it — as
 * `topupCashbackPercent`, which is why it left this list.
 */
export const PAYMENT_GATEWAY_PARITY_DEFERRALS = ['BUTTON_COLOUR'] as const;
export type PaymentGatewayParityDeferral = (typeof PAYMENT_GATEWAY_PARITY_DEFERRALS)[number];
