import type { PaymentAccountRecord } from './account-ports.js';

/**
 * R5C-1 item 2 — the ONE decision for «🔄 تغییر شماره کارت»: may this payment be switched to
 * another receiving card now, and to which.
 *
 * Pure. The press runs it under the payment's row lock with the facts read in the same
 * transaction; the invoice runs it (a courtesy) to decide whether to draw the button. A rule
 * copied into both places disagrees with itself invisibly, so there is one.
 */
export interface CardSwitchLimits {
  /** Most switches one payment may have. Zero: none is allowed. */
  readonly maxSwitches: number;
  /** Seconds to wait after the last switch. Zero: none. */
  readonly cooldownSeconds: number;
  /** Most DISTINCT cards one payment may show, the first included. */
  readonly maxDistinctCards: number;
}

export interface CardSwitchFacts {
  readonly limits: CardSwitchLimits;
  readonly now: Date;
  /** Switches already recorded on the payment. */
  readonly switchCount: number;
  /** When the last switch was recorded; null when there is none. */
  readonly lastSwitchAt: Date | null;
  /** Every account the customer has been shown on this payment, the first card included. */
  readonly shownAccountIds: readonly string[];
  /** The account shown now (null for a payment with no recorded card). */
  readonly currentAccountId: string | null;
  /** Enabled receiving accounts in their render order. */
  readonly enabled: readonly PaymentAccountRecord[];
}

export type CardSwitchDecision =
  | { readonly kind: 'SWITCH'; readonly next: PaymentAccountRecord }
  /** Too soon after the last switch; temporary, so the button stays. */
  | { readonly kind: 'COOLDOWN'; readonly retryAfterSeconds: number }
  /** The switch limit or the distinct-card limit is used up; permanent for this payment. */
  | { readonly kind: 'LIMIT' }
  /** No other enabled card exists at all. */
  | { readonly kind: 'NO_OTHER_CARD' };

/**
 * The next card after the one shown now, wrapping round and never the same one: two enabled
 * cards alternate, three rotate A → B → C → A. A card shown now that has since been DISABLED is
 * no longer in the list, so the rotation starts again from the first enabled card. Null when
 * no other card exists.
 */
export function nextReceivingCard(
  enabled: readonly PaymentAccountRecord[],
  currentAccountId: string | null,
): PaymentAccountRecord | null {
  const others = enabled.filter((account) => account.id !== currentAccountId);
  if (others.length === 0) return null;
  const at = enabled.findIndex((account) => account.id === currentAccountId);
  if (at === -1) return others[0] ?? null;
  return enabled[(at + 1) % enabled.length] ?? null;
}

export function decideCardSwitch(facts: CardSwitchFacts): CardSwitchDecision {
  const { limits, now } = facts;
  if (facts.switchCount >= limits.maxSwitches) return { kind: 'LIMIT' };

  /*
   * Once as many distinct cards as the owner allows have been shown, a press may only go back to
   * one of them: a card the customer has not seen stays unseen. Below the cap the whole enabled
   * list rotates, and showing one new card can never exceed it.
   */
  const shown = new Set(facts.shownAccountIds);
  const capped = shown.size >= limits.maxDistinctCards;
  const pool = capped ? facts.enabled.filter((account) => shown.has(account.id)) : facts.enabled;
  const next = nextReceivingCard(pool, facts.currentAccountId);
  if (next === null) {
    // Another enabled card exists but may not be shown: a limit. None at all: nothing to switch to.
    return capped && nextReceivingCard(facts.enabled, facts.currentAccountId) !== null
      ? { kind: 'LIMIT' }
      : { kind: 'NO_OTHER_CARD' };
  }

  if (facts.lastSwitchAt !== null && limits.cooldownSeconds > 0) {
    const readyAt = facts.lastSwitchAt.getTime() + limits.cooldownSeconds * 1000;
    const remainingMs = readyAt - now.getTime();
    if (remainingMs > 0)
      return { kind: 'COOLDOWN', retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  }
  return { kind: 'SWITCH', next };
}
