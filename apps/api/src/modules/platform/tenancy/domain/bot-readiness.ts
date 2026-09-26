import type {
  BotCommandMenuState,
  BotInstanceStatus,
  BotReadinessCause,
  BotReadinessState,
  BotWebhookSecretState,
} from '@nexa/contracts';
import { BOT_HOLDING_CAUSES } from '@nexa/contracts';

/**
 * What a bot's RECORDED state says about receiving updates (`docs/wp13-bots-management-audit.md` D5).
 *
 * Pure, and deliberately a different question from the bootstrap's `status`: that one
 * knows the public origin and asks whether Telegram is pointed at the right URL; this one
 * runs in the API process, which does not know the origin, and asks only whether a
 * registration was accepted with the secret this process holds now. So its best answer
 * is `REGISTERED`, never "receiving".
 */

/**
 * Whether the webhook secret that was registered is the one configured now.
 *
 * Takes the COMPARISON, not the digests: the repository compares the stored digest with
 * the current one in SQL, so the stored value never leaves the database.
 *
 * `NOT_CONFIGURED` first: with no secret at all the route refuses every update whatever
 * was registered. A NULL comparison is `UNKNOWN`, never a match — the rule the schema's
 * docblock states for the column.
 */
export function webhookSecretState(
  matches: boolean | null,
  secretConfigured: boolean,
): BotWebhookSecretState {
  if (!secretConfigured) return 'NOT_CONFIGURED';
  if (matches === null) return 'UNKNOWN';
  return matches ? 'MATCHES' : 'DIFFERS';
}

/** Whether Telegram was last given the menu this release would send. NULL is unknown. */
export function commandMenuState(recorded: string | null, current: string): BotCommandMenuState {
  if (recorded === null) return 'UNKNOWN';
  return recorded === current ? 'CURRENT' : 'STALE';
}

export interface BotReadinessInput {
  readonly webhookRouteEnabled: boolean;
  readonly tenantActive: boolean;
  readonly botStatus: BotInstanceStatus;
  readonly webhookRegisteredAt: Date | null;
  readonly secret: BotWebhookSecretState;
}

/**
 * Every cause that applies, in the order an operator can act on them.
 *
 * All of them rather than the first, because they are independent facts and fixing one
 * reveals the next: an operator who starts the bot should already know the webhook was
 * never registered. The ORDER is the bootstrap's (route, tenant, bot — `OQ-TG-04` item
 * 11): a stopped tenant makes the bot's own status moot, so it is named first.
 *
 * `NOT_CONFIGURED` is filed under the route: the webhook controller refuses every update
 * when no secret is configured, which is the route being unusable.
 */
export function readinessOf(input: BotReadinessInput): {
  readonly state: BotReadinessState;
  readonly causes: readonly BotReadinessCause[];
} {
  const causes: BotReadinessCause[] = [];
  if (!input.webhookRouteEnabled || input.secret === 'NOT_CONFIGURED') {
    causes.push('WEBHOOK_ROUTE_DISABLED');
  }
  if (!input.tenantActive) causes.push('TENANT_INACTIVE');
  if (input.botStatus !== 'ACTIVE') causes.push('BOT_NOT_ACTIVE');
  if (input.webhookRegisteredAt === null) {
    causes.push('WEBHOOK_NEVER_REGISTERED');
  } else if (input.secret === 'DIFFERS') {
    causes.push('WEBHOOK_SECRET_CHANGED');
  } else if (input.secret === 'UNKNOWN') {
    causes.push('WEBHOOK_SECRET_UNKNOWN');
  }

  const holding = causes.some((cause) =>
    (BOT_HOLDING_CAUSES as readonly BotReadinessCause[]).includes(cause),
  );
  const state: BotReadinessState = holding
    ? 'HELD'
    : causes.length > 0
      ? 'NOT_REGISTERED'
      : 'REGISTERED';
  return { state, causes };
}

/**
 * The bot id a Telegram token CLAIMS: the digits before the colon.
 *
 * Local and free, which is why it runs before `getMe` — a token for another bot is
 * refused without sending it anywhere (ADR-0029's refusal of a different bot on a rerun
 * uses the same claim). A claim is not evidence, so the identity that is compared after
 * the call is Telegram's own answer.
 *
 * The secret half is Telegram's alphabet only. A token carrying whitespace, a second
 * colon or anything else is refused as malformed rather than trimmed into shape — an
 * operator who pasted something else deserves to be told, not silently corrected.
 */
export function claimedBotId(token: string): string | null {
  const match = /^([1-9][0-9]{0,19}):([A-Za-z0-9_-]{20,200})$/u.exec(token);
  return match?.[1] ?? null;
}
