import type { HostingCreateRefusal } from '@nexa/contracts';

/**
 * Phase 6A PR-3 — THE production gate on creating hosted bots.
 *
 * Owner decision: a hosted bot must not be creatable in production until tenant isolation
 * is enforced by the database (PR-1, row-level security, ADR-0037) AND proven (PR-5, the
 * isolation proof). Until then a hosted bot is a stranger's data one missed tenant predicate
 * away from the owner's.
 *
 * Two keys, both required in production, so neither alone can open it:
 *
 *   1. `HOSTED_BOTS_CREATE_ENABLED` — an operator's env flag (config, default `false`).
 *   2. `HOSTED_BOTS_PRODUCTION_RELEASE_MARKER` below — a CODE constant. Only a reviewed
 *      commit changes it, and PR-5 is the commit that does, once its isolation proof is
 *      green. An env var, a setting or a database row cannot: the marker is compiled in.
 *
 * Outside production (development, test, CI) the flag alone decides, so the feature can be
 * built and tested before the proof lands. `tests/unit/hosting-create-gate.test.ts` pins
 * the marker's value (released by PR-5): changing it either way fails that test, so every
 * flip is a deliberate, visible edit to a test as well as to this file.
 */

/** The exact value PR-5 sets the marker to. Any other value keeps the gate shut. */
export const HOSTED_BOTS_RELEASE_MARKER_VALUE = 'p6a-pr1-rls+p6a-pr5-isolation-proof';

/**
 * Set by PR-5 (phase 6A D3): PR-1's row-level security is merged and PR-5's isolation proof
 * (`tests/integration/isolation-proof/`) is green, including its mutation check. Never read
 * from the environment; setting it back to `null` shuts the gate again.
 */
export const HOSTED_BOTS_PRODUCTION_RELEASE_MARKER: string | null =
  HOSTED_BOTS_RELEASE_MARKER_VALUE;

export interface CreateGateInput {
  readonly nodeEnv: string;
  readonly flagEnabled: boolean;
  /** Injected for the tests; production passes the constant above. */
  readonly releaseMarker: string | null;
}

/** Null when creating is open; otherwise why it is shut. Deny by default. */
export function hostedBotCreateRefusal(input: CreateGateInput): HostingCreateRefusal | null {
  if (input.flagEnabled !== true) return 'FLAG_OFF';
  if (input.nodeEnv === 'development' || input.nodeEnv === 'test') return null;
  // Production — and ANY other value, so a typo in NODE_ENV is production, not development.
  return input.releaseMarker === HOSTED_BOTS_RELEASE_MARKER_VALUE
    ? null
    : 'PRODUCTION_NOT_RELEASED';
}
