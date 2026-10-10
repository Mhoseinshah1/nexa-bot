import { z } from 'zod';
import { paymentGatewayProviderSchema, paymentGatewayStatusSchema } from './payment-gateways.js';
import { GATEWAY_INVOICE_CREATION_STATES } from './gateway-invoices.js';
import { paymentOpsWindowShape, refinePaymentOpsWindow } from './payment-operations.js';
import { OPERATIONAL_SEVERITIES } from './ports.js';

/**
 * Gateway Health (program §11, `docs/gateway-health.md`).
 *
 * Per configured route, ONLY what this installation has actually recorded: its switch, what
 * enabling it still needs, the operator's last credential check, what the provider last
 * answered on the attempts it holds, the per-route call budget, the payment queues, the open
 * operational conditions and the last reconciliation. No availability percentage and no
 * latency: nothing records either (a create's elapsed time is logged, never stored), and a
 * figure computed from too little data is a number an operator would act on.
 */

/**
 * What a DISABLED route still needs before `PaymentGatewayService.setStatus` would switch it
 * ON — the enable refusals' own reasons, in the order that method checks them (the
 * credential, the webhook secret, the verify key, the fixed rate, then the central rate's
 * switch and unit ratio), and one more a manual-transfer route needs to be PAYABLE: an
 * enabled receiving account. Never a value: whether something is set, never what.
 */
export const GATEWAY_CONFIGURATION_GAPS = [
  'CREDENTIAL_MISSING',
  'WEBHOOK_SECRET_MISSING',
  'VERIFY_KEY_MISSING',
  'RATE_MISSING',
  'CENTRAL_FX_DISABLED',
  'UNIT_RATIO_MISSING',
  'NO_RECEIVING_ACCOUNT',
] as const;
export type GatewayConfigurationGap = (typeof GATEWAY_CONFIGURATION_GAPS)[number];

/**
 * The existing operational-event codes that are about a payment route's health — the codes
 * the Notification Center subscribes to for the `PAYMENT_GATEWAY` category. Existing codes
 * only, spelled exactly as their producers write them (`gateway-payment.service.ts`; a unit
 * test holds the two together). Never renamed: `operational_events` dedupes and recovers by
 * code.
 */
export const GATEWAY_HEALTH_OPERATIONAL_CODES = [
  'payments.gateway_misconfigured',
  'payments.gateway_create_unknown',
  'payments.gateway_late_completion',
  'payments.gateway_identity_mismatch',
  'payments.gateway_receipt_unknown',
  'payments.gateway_card_change_unknown',
  'payments.gateway_review_unresolved',
  'payments.gateway_webhook_unverified',
  // FIX-03 (batch 2026-10-10; Codex P2 on #260): a gateway whose inquiries keep failing
  // cannot read approvals — a settlement outage, so an open condition on its route.
  'payments.gateway_inquiry_failing',
] as const;
export type GatewayHealthOperationalCode = (typeof GATEWAY_HEALTH_OPERATIONAL_CODES)[number];

/** The Notification Center's category for every gateway health signal. */
export const GATEWAY_HEALTH_CATEGORY = 'PAYMENT_GATEWAY' as const;

/**
 * Why a route asks for attention — each a fact some flow recorded, never an inference about
 * the provider's availability.
 *
 * - `OPEN_CONDITION` — an operational condition with one of the codes above is open.
 * - `CONFIGURATION_INCOMPLETE` — the route is ACTIVE and something enabling needs is unset
 *   (a ratio cleared, an account disabled after it was switched on).
 * - `CHECK_FAILED` — the operator's last credential check did not answer `ok`.
 * - `PROVIDER_ERRORS` — attempts in the window whose record shows a provider error.
 * - `PAYMENTS_UNKNOWN` — payments through it whose outcome is unknown.
 * - `PAYMENTS_NEED_RECONCILIATION` — unknown payments the recorded evidence can already settle.
 */
export const GATEWAY_HEALTH_SIGNAL_KINDS = [
  'OPEN_CONDITION',
  'CONFIGURATION_INCOMPLETE',
  'CHECK_FAILED',
  'PROVIDER_ERRORS',
  'PAYMENTS_UNKNOWN',
  'PAYMENTS_NEED_RECONCILIATION',
] as const;
export type GatewayHealthSignalKind = (typeof GATEWAY_HEALTH_SIGNAL_KINDS)[number];

/**
 * One typed gateway health signal — what the Notification Center consumes (program §12).
 *
 * `key` is stable for as long as the condition holds (`<provider>:<kind>[:<code>]`), so a
 * consumer dedupes on it; `opsCode` names the operational event behind an `OPEN_CONDITION`
 * so a consumer that already reads the ops log by code does not notify twice. `since` is when
 * the fact was first recorded, when the record says; `count` how many rows stand behind it.
 */
export const gatewayHealthSignalSchema = z.object({
  key: z.string(),
  category: z.literal(GATEWAY_HEALTH_CATEGORY),
  provider: paymentGatewayProviderSchema,
  kind: z.enum(GATEWAY_HEALTH_SIGNAL_KINDS),
  severity: z.enum(OPERATIONAL_SEVERITIES),
  opsCode: z.enum(GATEWAY_HEALTH_OPERATIONAL_CODES).nullable(),
  count: z.number().int().nonnegative(),
  since: z.iso.datetime().nullable(),
});
export type GatewayHealthSignal = z.infer<typeof gatewayHealthSignalSchema>;

/**
 * A route's summary, by a fixed rule over the facts below — never a score:
 * `DISABLED` (switched off) > `INCOMPLETE` (enabling still needs something) > `ATTENTION`
 * (any WARN-or-worse signal) > `NO_ACTIVITY` (nothing recorded in the window) >
 * `NO_ISSUES_RECORDED`. The last is deliberately not "healthy": it says what the record does
 * not contain, not what the provider is doing.
 */
export const GATEWAY_HEALTH_STATES = [
  'DISABLED',
  'INCOMPLETE',
  'ATTENTION',
  'NO_ACTIVITY',
  'NO_ISSUES_RECORDED',
] as const;
export type GatewayHealthState = (typeof GATEWAY_HEALTH_STATES)[number];

/** Sections behind a permission beyond `payments.gateways.view`. */
export const GATEWAY_HEALTH_SECTIONS = ['PAYMENTS'] as const;
export type GatewayHealthSection = (typeof GATEWAY_HEALTH_SECTIONS)[number];

export const gatewayHealthQuerySchema = z
  .object(paymentOpsWindowShape)
  .superRefine(refinePaymentOpsWindow);
export type GatewayHealthQuery = z.infer<typeof gatewayHealthQuerySchema>;

const at = z.iso.datetime();

export const gatewayHealthViewSchema = z.object({
  provider: paymentGatewayProviderSchema,
  status: paymentGatewayStatusSchema,
  state: z.enum(GATEWAY_HEALTH_STATES),
  configuration: z.object({
    complete: z.boolean(),
    gaps: z.array(z.enum(GATEWAY_CONFIGURATION_GAPS)),
  }),
  /**
   * The operator's credential check: whether the route's adapter offers a safe read-only
   * call at all (NOWPayments' `/v1/estimate`; none documented for the others), and the last
   * result — latest state only.
   */
  check: z.object({
    supported: z.boolean(),
    lastAt: at.nullable(),
    lastResult: z.string().nullable(),
  }),
  /**
   * What the provider last answered on this route's attempts. Each attempt keeps only its
   * LATEST inquiry, so these are the latest recorded answers, not a log of every call.
   * Null throughout for a route that holds no gateway invoices (a manual transfer).
   */
  answers: z.object({
    lastInvoiceCreatedAt: at.nullable(),
    lastInquiryAnsweredAt: at.nullable(),
    lastInquiryFailure: z.object({ at, code: z.string() }).nullable(),
    lastCreateFailure: z
      .object({
        at,
        state: z.enum(GATEWAY_INVOICE_CREATION_STATES),
        code: z.string().nullable(),
      })
      .nullable(),
    /** Attempts created in the window, and how many of them record a provider error. */
    attemptsInWindow: z.number().int().nonnegative(),
    attemptsWithProviderError: z.number().int().nonnegative(),
  }),
  /** The route's provider-call budget: calls used since its current window opened. */
  callBudget: z.object({ windowStartedAt: at, used: z.number().int().nonnegative() }).nullable(),
  /** Open operational conditions about this route, by code. */
  openConditions: z.array(
    z.object({
      code: z.enum(GATEWAY_HEALTH_OPERATIONAL_CODES),
      severity: z.enum(OPERATIONAL_SEVERITIES),
      count: z.number().int().positive(),
      since: at,
    }),
  ),
  /** Under `payments.view`: the Payment Operations Center's queue counts for this route. */
  queues: z.record(z.string(), z.number().int().nonnegative()).nullable(),
  /** Under `payments.view`: the last reconcile or "ask again" an operator recorded. */
  lastReconciliation: z.object({ at, action: z.string() }).nullable(),
  signals: z.array(gatewayHealthSignalSchema),
});
export type GatewayHealthView = z.infer<typeof gatewayHealthViewSchema>;

export const gatewayHealthResponseSchema = z.object({
  window: z.object({ start: at, end: at }).nullable(),
  gateways: z.array(gatewayHealthViewSchema),
  withheld: z.array(z.enum(GATEWAY_HEALTH_SECTIONS)),
  generatedAt: at,
});
export type GatewayHealthResponse = z.infer<typeof gatewayHealthResponseSchema>;

export const GATEWAY_HEALTH_ROUTES = {
  /** Every route's health, under `payments.gateways.view`. */
  list: '/payment-gateways-health',
} as const;
