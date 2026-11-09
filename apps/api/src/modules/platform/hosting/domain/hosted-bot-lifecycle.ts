import {
  errors,
  HOSTED_BOT_TENANT_STATUS,
  HOSTED_BOT_TRANSITIONS,
  HOSTING_ERROR_CODES,
  type HostedBotAction,
  type HostedBotState,
  type TenantStatus,
} from '@nexa/contracts';

/**
 * Phase 6A PR-3: a hosted bot's state machine, pure.
 *
 * `HOSTED_BOT_TRANSITIONS` (contracts) names, for each action, the states it may start from
 * and the state it lands in; the repository's UPDATE names the same `from` states, so a
 * concurrent change that moved the row first makes the statement match nothing (no
 * `setState`). ACTIVATE also needs the expiry to be in the future (or absent): activating
 * a bot whose date has passed would be undone by the next sweep a minute later.
 */
export interface TransitionPlan {
  readonly action: HostedBotAction;
  readonly from: HostedBotState;
  readonly to: HostedBotState;
  readonly allowedFrom: readonly HostedBotState[];
  readonly tenantStatusFrom: TenantStatus;
  readonly tenantStatusTo: TenantStatus;
}

export function planTransition(
  action: HostedBotAction,
  current: { readonly state: HostedBotState; readonly expiresAt: Date | null },
  now: Date,
): TransitionPlan {
  const rule = HOSTED_BOT_TRANSITIONS[action];
  if (!rule.from.includes(current.state)) {
    throw errors.conflict(
      HOSTING_ERROR_CODES.STATE_CONFLICT,
      `A ${current.state} hosted bot cannot be ${action.toLowerCase()}d.`,
      { action, state: current.state, allowedFrom: [...rule.from] },
    );
  }
  if (
    action === 'ACTIVATE' &&
    current.expiresAt !== null &&
    current.expiresAt.getTime() <= now.getTime()
  ) {
    throw errors.preconditionFailed(
      HOSTING_ERROR_CODES.EXPIRY_PASSED,
      'This bot’s expiry date has passed. Set a new date (or none) before activating it.',
      { expiresAt: current.expiresAt.toISOString() },
    );
  }
  return {
    action,
    from: current.state,
    to: rule.to,
    allowedFrom: rule.from,
    tenantStatusFrom: HOSTED_BOT_TENANT_STATUS[current.state],
    tenantStatusTo: HOSTED_BOT_TENANT_STATUS[rule.to],
  };
}

/**
 * SFR A5: the states the OWNER stops a bot into. A bot is brought back from one of them only
 * once its Telegram token was entered and verified SINCE the stop — the token is the gate, and
 * the re-enable comes after it, never before. EXPIRED is the sweep's stop, not the owner's:
 * renewing a date asks for no token.
 */
export const OWNER_STOPPED_STATES: readonly HostedBotState[] = ['SUSPENDED', 'DELETED'];

/**
 * Refuses ACTIVATE of an owner-stopped bot whose token was not verified after it stopped.
 * `tokenVerifiedAt` is the activation row's mark, set only when the creator ENTERS a token
 * («فعال‌سازی» → token) and Telegram accepts it.
 */
export function assertTokenReenteredSinceStop(
  action: HostedBotAction,
  current: { readonly state: HostedBotState; readonly stateChangedAt: Date },
  tokenVerifiedAt: Date | null,
): void {
  if (action !== 'ACTIVATE' || !OWNER_STOPPED_STATES.includes(current.state)) return;
  if (tokenVerifiedAt !== null && tokenVerifiedAt.getTime() > current.stateChangedAt.getTime()) {
    return;
  }
  throw errors.preconditionFailed(
    HOSTING_ERROR_CODES.TOKEN_REENTRY_REQUIRED,
    'This bot was stopped. Enter its Telegram token again before activating it.',
    { state: current.state, stoppedAt: current.stateChangedAt.toISOString() },
  );
}
