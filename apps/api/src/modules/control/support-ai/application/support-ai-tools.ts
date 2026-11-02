import type { ScopeContext } from '@nexa/contracts';
import type { PaymentCheckFact } from '../domain/actions.js';

/**
 * Phase 4 PR-3 — the support AI's read-only tools: the ports the automatic-reply service reads
 * through. Every method is a READ that takes the customer id from the CONVERSATION row (never
 * from the model or the message), puts the tenant and that customer in its WHERE, and returns
 * only what the customer may be told. None performs a change.
 */
export interface SupportAiToolReader {
  /**
   * One of THIS customer's services, by the id the server resolved from a payload alias:
   * its panel username, and the subscription link «سرویس‌های من» would show — null when the
   * service is not deliverable (no link yet, terminated) — or `filesOnly` when its panel is set
   * to «فقط فایل، بدون لینک ساب» (then the link is never returned). Null when the service is
   * not this customer's.
   */
  subscriptionOf(
    scope: ScopeContext,
    customerId: string,
    serviceId: string,
    tx?: unknown,
  ): Promise<{
    readonly username: string;
    readonly link: string | null;
    readonly filesOnly: boolean;
  } | null>;

  /** THIS customer's payments created at or after `since`, newest first, at most five. */
  paymentsForCheck(
    scope: ScopeContext,
    customerId: string,
    since: Date,
    tx?: unknown,
  ): Promise<readonly PaymentCheckFact[]>;

  /** Whether the trial's deep link may be offered to this customer (the claim's own rule). */
  trialEligible(scope: ScopeContext, customerId: string): Promise<boolean>;

  /** The category a catalogue plan is listed under; null for none. */
  categoryOfProduct(scope: ScopeContext, productId: string): Promise<string | null>;
}

/** The three owner switches PR-3 reads (Web Admin, settings page, support group). */
export interface SupportAiToolSettings {
  read(
    scope: ScopeContext,
    tx?: unknown,
  ): Promise<{
    /** `support.ai.actions_enabled` (default off). */
    readonly actions: boolean;
    /** `support.ai.label_enabled` (default off). */
    readonly label: boolean;
    /** `support.ai.feedback_enabled` (default on; read only with `actions`). */
    readonly feedback: boolean;
  }>;
}

/** Everything off: what a deployment without the PR-3 wiring behaves as. */
export const SUPPORT_AI_TOOLS_OFF = { actions: false, label: false, feedback: false } as const;
