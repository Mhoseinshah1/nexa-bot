import type {
  ActorContext,
  BotInstanceId,
  CustomerArrival,
  TemplateKey,
  TenantContext,
} from '@nexa/contracts';
import type { CustomerService } from '../../modules/commerce/customers/application/customer.service.js';
import type { CustomerMessenger } from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';

/**
 * What the customer asked for.
 *
 * A tiny closed vocabulary rather than a parsed command string, decided at the
 * boundary and never passed onward as text. Phase 4A handles `/start` and answers
 * everything else with the unsupported-input fallback; later subphases add members.
 *
 * There is no FSM and no conversation state. The legacy system's prompt capture
 * swallowed an ordinary message and overwrote a production gateway setting
 * (INCIDENT-FIN-001), which is what a stateful prompt does when it outlives the
 * question it was asked for.
 */
export const BOT_INTENTS = ['START', 'UNSUPPORTED'] as const;
export type BotIntent = (typeof BOT_INTENTS)[number];

/**
 * Reads the intent out of an update.
 *
 * Reads through passthrough fields rather than a modelled `message` shape, exactly as
 * `isPingCommand` already does: `telegramUpdateSchema` states what this installation
 * depends on and the rest of an update stays unmodelled on purpose. Anything unexpected
 * is `UNSUPPORTED`, which is a real answer and not an error.
 *
 * The command is matched on the FIRST token only, so `/start payload` is still `/start` —
 * Telegram's deep links put a payload there and 4F's referral codes arrive that way.
 * The payload itself is deliberately NOT returned here: nothing in 4A consumes it, and a
 * field nothing consumes is a field that gets logged.
 */
export function intentOf(update: unknown): BotIntent {
  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return 'UNSUPPORTED';
  const first = text.trim().split(/\s+/)[0]?.toLowerCase();
  // `/start@somebot` is what Telegram sends in a group. Stripped, because the bot it
  // names is the bot that received it.
  const command = first?.split('@')[0];
  return command === '/start' ? 'START' : 'UNSUPPORTED';
}

/**
 * The customer's chat id for a private conversation.
 *
 * Telegram's private chat id IS the user id, but the update carries both and they can
 * differ — in a group, `chat.id` is the group. A reply to a group chat would publish a
 * customer's balance to everyone in it, so this prefers the chat id only when the chat
 * is private and otherwise has no answer.
 */
export function privateChatIdOf(update: unknown): string | null {
  const message = (update as { message?: { chat?: { id?: unknown; type?: unknown } } } | null)
    ?.message;
  const chat = message?.chat;
  if (chat === undefined || chat === null) return null;
  if (chat.type !== 'private') return null;
  return typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null;
}

export interface BotRuntimeDeps {
  readonly customers: CustomerService;
  readonly messenger: CustomerMessenger;
}

/**
 * What a handled update produced.
 *
 * Returned rather than logged, so the webhook controller decides what to do with it and
 * the tests can assert it. `sent` is deliberately not a boolean: a reply that may or may
 * not have arrived is a third thing, and the messenger already distinguishes it.
 */
export interface BotTurnResult {
  readonly intent: BotIntent;
  readonly arrival: CustomerArrival | null;
  readonly customerId: string | null;
  readonly replyKey: TemplateKey | null;
  readonly sent: 'DELIVERED' | 'REFUSED' | 'UNKNOWN' | 'NOT_ATTEMPTED';
}

/**
 * One turn of the customer-facing bot.
 *
 * The ORDER is the contract, and it is the same order `CLAUDE.md` fixes for the backup
 * pipeline and ADR-0028 fixes for recovery:
 *
 *   1. resolve and commit the state change — the customer exists, their profile is
 *      fresh, `last_seen_at` has moved;
 *   2. THEN send, outside any transaction.
 *
 * Never the other way round and never in one transaction. A send inside the transaction
 * could be rolled back after Telegram had delivered it, and a failed send must not undo
 * the fact that the customer arrived. `telegramSend` asserts the second half of that by
 * refusing to run inside a transaction at all.
 *
 * Nothing here throws for a send failure. A throw becomes a non-2xx, a non-2xx makes
 * Telegram redeliver the update, and a redelivered update whose only problem was a
 * failed reply is an unbounded loop that bumps `last_seen_at` for ever.
 */
export class BotRuntime {
  constructor(private readonly deps: BotRuntimeDeps) {}

  async handle(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
      readonly from: unknown;
    },
  ): Promise<BotTurnResult> {
    const intent = intentOf(input.update);

    // 1. The state change, committed.
    //
    // Runs for EVERY intent, not only `/start`. The customer's existence and their
    // `last_seen_at` are facts about any contact, and "last seen" that only moved on
    // `/start` would be a column an operator reads as activity and is not.
    const { customer, arrival } = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      telegramUserId: input.telegramUserId,
      from: input.from,
      botInstanceId: input.botInstanceId,
    });

    const replyKey = replyFor(intent, arrival);
    const chatId = privateChatIdOf(input.update);

    // 2. The reply, after the commit, and only into a private chat.
    if (replyKey === null || chatId === null) {
      return {
        intent,
        arrival,
        customerId: customer.id,
        replyKey,
        sent: 'NOT_ATTEMPTED',
      };
    }

    const sent = await this.deps.messenger.send(scope, {
      chatId,
      templateKey: replyKey,
      values: {},
      botInstanceId: input.botInstanceId,
    });

    return { intent, arrival, customerId: customer.id, replyKey, sent };
  }
}

/**
 * Which template answers this turn.
 *
 * A pure function of the intent and the arrival, so the decision is testable without a
 * database or a Telegram server — and so the blocked case cannot be forgotten by one
 * branch. BLOCKED wins over everything: a blocked customer gets the block message
 * whatever they asked for, because every other answer is a service they are not
 * entitled to.
 *
 * `UNSUPPORTED` for an ACTIVE customer gets the existing `bot.unknown_command`, which
 * Phase 1 already declared — a new key for the same sentence would be a second string to
 * keep in step.
 */
export function replyFor(intent: BotIntent, arrival: CustomerArrival): TemplateKey | null {
  if (arrival === 'BLOCKED') return 'bot.blocked';
  if (intent === 'START') {
    return arrival === 'FIRST_SEEN' ? 'bot.start.welcome' : 'bot.start.welcome_back';
  }
  return 'bot.unknown_command';
}

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };
