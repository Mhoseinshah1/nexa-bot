import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  PANEL_UNUSABLE_HEALTH_STATES,
  type PanelHealthState,
  type PanelIneligibilityReason,
  type PanelStatus,
} from '@nexa/contracts';

/**
 * Everything the decision reads. A struct rather than a `PanelView`, because
 * eligibility is asked in the middle of an order transaction that holds no
 * panel repository — the caller assembles these four facts from what it has.
 */
export interface EligibilityInput {
  readonly status: PanelStatus;
  /** Null when the panel has never been probed. NOT a failure. */
  readonly health: {
    readonly state: PanelHealthState;
    readonly checkedAt: Date;
    readonly unusableStreak: number;
  } | null;
  /** The cap, or null for no limit. */
  readonly maxServices: number | null;
  /** Services that occupy a slot, plus reservations nobody has released. */
  readonly used: number;
  readonly now: Date;
}

export type PanelEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: PanelIneligibilityReason };

const ELIGIBLE: PanelEligibility = { eligible: true };

/**
 * Whether this panel may be SOLD onto right now.
 *
 * A different question from `decideOperability`, which asks whether one
 * operation may run against a panel at the moment of the provider call. This is
 * asked before a customer is charged, and the two disagree in both directions: a
 * fresh panel with no credentials is eligible and inoperable, and a full or
 * confirmed-down panel is operable and ineligible.
 *
 * ## The order is the argument
 *
 * `ARCHIVED` and `DISABLED` come first because they are DECISIONS. An operator
 * who archived a panel is not asking to be told it is also at capacity, and a
 * measurement must never be reported in place of somebody's own instruction.
 *
 * Health comes before capacity for the same reason inverted: a panel that cannot
 * be reached is not usefully described as full, and "at capacity" reads as a
 * business condition an operator resolves by raising a number.
 *
 * ## What is NOT a reason
 *
 * A panel nobody has probed is eligible. `UNCHECKED` is the absence of evidence,
 * not evidence of absence, and a fresh installation whose monitor has not run
 * yet must be able to sell — the alternative is a shop that opens empty and
 * stays that way until a background process nobody knows about has succeeded.
 *
 * A panel whose health is STALE is eligible, and this is the rule that keeps a
 * stopped monitor from closing every shop in the installation. Old evidence
 * stops being evidence; it does not become worse evidence. The panel is still
 * probed on every provisioning call, and a genuinely dead one fails there with a
 * classified error rather than silently earlier.
 *
 * A `DEGRADED` panel is eligible. `PANEL_UNUSABLE_HEALTH_STATES` says why: the
 * credentials were accepted and the panel answered, so the next create will very
 * likely work, and only the diagnostic read failed.
 */
export function decideEligibility(input: EligibilityInput): PanelEligibility {
  if (input.status === 'ARCHIVED') return { eligible: false, reason: 'ARCHIVED' };
  if (input.status !== 'ACTIVE') return { eligible: false, reason: 'DISABLED' };
  if (isConfirmedUnusable(input.health, input.now)) {
    return { eligible: false, reason: 'UNHEALTHY' };
  }
  if (input.maxServices !== null && input.used >= input.maxServices) {
    return { eligible: false, reason: 'AT_CAPACITY' };
  }
  return ELIGIBLE;
}

/**
 * Whether the health row is recent enough, and bad enough for long enough, to
 * stop this panel taking business.
 *
 * All three conditions, and dropping any one of them breaks a different case.
 * Without the STATE check a degraded panel stops selling. Without the STREAK a
 * single dropped packet does. Without the FRESHNESS a health row from before a
 * restore — or from before the monitor was stopped for an afternoon — keeps a
 * working panel shut for ever, because nothing will ever overwrite a row that
 * only a probe can overwrite.
 *
 * Exported because the recovery rule is the negation of it and the two must not
 * be able to drift: a panel becomes eligible again exactly when this stops
 * holding, which one fresh non-unusable probe achieves by resetting the streak.
 */
export function isConfirmedUnusable(
  health: EligibilityInput['health'],
  now: Date,
  freshForMs: number = PANEL_HEALTH_FRESH_FOR_MS,
): boolean {
  if (health === null) return false;
  if (!PANEL_UNUSABLE_HEALTH_STATES.includes(health.state)) return false;
  if (health.unusableStreak < PANEL_UNHEALTHY_AFTER_FAILURES) return false;
  return now.getTime() - health.checkedAt.getTime() <= freshForMs;
}

/**
 * The parts of a panel a successful connection test actually vouches for.
 *
 * Base URL, provider, activation and WHEN each credential was last set. A test
 * proves those four worked together; it proves nothing about a different
 * address, a different inbound or a password replaced since.
 *
 * Deliberately NOT `configurationFingerprint`, which exists to cancel an
 * in-flight probe whose panel changed under it and therefore includes `status`
 * and `updatedAt`. Both move when a panel is enabled, so a validation keyed on
 * that digest would be invalidated by the very act it authorises — and every
 * routine re-enable after maintenance would demand a fresh test for no reason.
 *
 * The three credential timestamps rather than the credentials: a value here
 * would put a verifier for a panel password in a column that is not the
 * credential table. A replaced password moves its timestamp, which is all this
 * needs to know.
 *
 * Activation is serialised with sorted keys so that re-saving the same
 * configuration in a different key order does not read as a change. A test an
 * operator did not invalidate must not stop authorising.
 */
export function connectionIdentityOf(input: {
  readonly providerType: string;
  readonly baseUrl: string;
  readonly activation: unknown;
  readonly usernameSetAt: Date | null;
  readonly passwordSetAt: Date | null;
  readonly apiTokenSetAt: Date | null;
}): string {
  return [
    input.providerType,
    input.baseUrl,
    stableJson(input.activation),
    input.usernameSetAt?.getTime() ?? 0,
    input.passwordSetAt?.getTime() ?? 0,
    input.apiTokenSetAt?.getTime() ?? 0,
  ].join('|');
}

/** JSON with object keys in a fixed order, so equal values compare equal. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${stableJson(held)}`).join(',')}}`;
}

/**
 * Whether a stored health row may authorise ENABLING this panel.
 *
 * Three conditions, and each one is a way an operator could otherwise enable a
 * panel that does not work:
 *
 *   - the probe concluded something USABLE. `DEGRADED` counts, for the reason
 *     `PANEL_UNUSABLE_HEALTH_STATES` gives: the credentials were accepted and
 *     the panel answered. What enabling needs to know is that this address and
 *     these credentials reach that panel, which a degraded probe establishes.
 *   - it ran against the CURRENT identity. Fix a password after a green test
 *     and the green test stops counting, which is the whole point.
 *   - it is recent. `PANEL_HEALTH_FRESH_FOR_MS` is reused rather than a second
 *     number invented: "is this answer still worth believing" is one question,
 *     and an installation with two freshness policies has one nobody can state.
 *
 * A row written before `validated_identity` existed has NULL there and
 * authorises nothing. That is the fail-closed direction: an upgrade must not
 * silently bless a validation nobody can attribute to a configuration.
 */
export function validationAuthorisesEnable(
  health: {
    readonly state: PanelHealthState;
    readonly checkedAt: Date;
    readonly validatedIdentity: string | null;
  } | null,
  currentIdentity: string,
  now: Date,
  freshForMs: number = PANEL_HEALTH_FRESH_FOR_MS,
): boolean {
  if (health === null) return false;
  if (PANEL_UNUSABLE_HEALTH_STATES.includes(health.state)) return false;
  if (health.validatedIdentity === null) return false;
  if (health.validatedIdentity !== currentIdentity) return false;
  return now.getTime() - health.checkedAt.getTime() <= freshForMs;
}
