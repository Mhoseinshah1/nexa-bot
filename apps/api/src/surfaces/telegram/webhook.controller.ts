import { createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, Inject, Param, Post } from '@nestjs/common';
import {
  errors,
  PLATFORM_ERROR_CODES,
  systemJobActor,
  TELEGRAM_SECRET_TOKEN_HEADER,
  telegramUpdateSchema,
  uuidV7Schema,
  type BotInstanceId,
  type TelegramUpdate,
  type TenantContext,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';

/**
 * The Telegram webhook receiver.
 *
 * Phase 1 scope stays narrow: authenticate the update, identify the bot,
 * acknowledge, and hand the work to the write path. No conversation state
 * machine, no menu, no product flow, no outbound send.
 *
 * Three shapes are fixed here because everything later copies them:
 *
 *   - No handler here calls an EXTERNAL service inline. Telegram times a
 *     webhook out in seconds, so a handler that dials a payment gateway or a
 *     panel while Telegram waits will eventually be that timeout — and a
 *     timeout makes Telegram redeliver the same update, so the slow path
 *     becomes a duplicated one.
 *
 *     Stated as the rule it is, because the earlier wording — "answers
 *     immediately and does the work behind the outbox" — described something
 *     this method does not do. Two database round trips and a write transaction
 *     are awaited before the 200. That is fine, and it is not "immediately";
 *     a later author who read the old sentence as a description of the shape
 *     they were copying would have concluded that awaiting work here was
 *     already forbidden, or already handled, and neither was true. The outbox
 *     is where the CONSEQUENCES of an update go, not where the update's own
 *     handling goes.
 *   - Every update is authenticated by the secret token header, and the
 *     endpoint does not exist at all unless the feature is switched on.
 *   - The route NAMES THE BOT INSTANCE. Telegram's `update_id` is a per-bot
 *     sequence, not a global one, so two bots in one installation routinely
 *     produce the same id. Keying idempotency on `update_id` alone therefore
 *     makes one bot's update look like a replay of another's — silently
 *     dropped, 200, nothing logged. The identity is `(bot_instance_id,
 *     update_id)`, and resolving the bot is also what supplies the tenant, so
 *     the update stops running under the system scope.
 */
/**
 * The largest body this route will read, in bytes.
 *
 * Far below the application-wide 1 MB limit, and that gap is the point: the
 * global limit is sized for Web Admin requests from an AUTHENTICATED operator,
 * while this route is reachable by anyone who can find it and the secret token
 * is checked only after the body has already been read and parsed. So an
 * unauthenticated caller could hand the process a megabyte of JSON to parse, and
 * the answer it got back — a 401 — cost it nothing.
 *
 * 64 KiB is generous for the traffic this actually carries. Telegram caps a
 * message at 4096 characters, so the largest realistic update is a long text
 * plus entities and a forwarded origin: a few tens of kilobytes in the worst
 * case, and under a kilobyte in the normal one.
 *
 * This is a ceiling on ONE request, not a rate limit. There is no rate limit on
 * this route; see `docs/adr/0026-webhook-edge.md` for why that is a recorded
 * decision rather than an oversight.
 */
export const TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

/** The route prefix the limit above is applied to, matched by an `onRoute` hook. */
export const TELEGRAM_WEBHOOK_ROUTE_PREFIX = '/telegram/webhook';

@Controller()
export class TelegramWebhookController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('/telegram/webhook/:botInstanceId')
  async receive(
    @Param('botInstanceId') botInstanceIdParam: string,
    @Headers(TELEGRAM_SECRET_TOKEN_HEADER) secretToken: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const expected = this.container.config.TELEGRAM_WEBHOOK_SECRET;

    // Authenticated before the bot id is even parsed, so the endpoint cannot be
    // used to probe which bot ids exist.
    if (!expected || !secretTokenMatches(secretToken, expected)) {
      throw errors.unauthenticated(
        PLATFORM_ERROR_CODES.TELEGRAM_BAD_SECRET_TOKEN,
        'Missing or incorrect Telegram secret token.',
      );
    }

    const parsed = uuidV7Schema.safeParse(botInstanceIdParam);
    if (!parsed.success) {
      throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'Unknown bot instance.');
    }

    const botInstance = await this.container.botInstances.findById(
      parsed.data as unknown as BotInstanceId,
    );
    // STOPPED and DISABLED are an inbound kill switch, and only mean that if
    // the receiver honours them. Refusing only a MISSING row let a validly
    // signed update keep executing under a stopped bot's tenant — and every
    // command handler added here later would have inherited that.
    //
    // Answered the same way as an unknown id, so the endpoint does not report
    // which bots exist but are switched off.
    if (botInstance === null || botInstance.status !== 'ACTIVE') {
      throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'Unknown bot instance.');
    }

    // The bot's own status is not the whole kill switch. Stopping a TENANT now
    // ends Web Admin logins and existing sessions, and it has to end this
    // surface too — the update below acts as SYSTEM_JOB, which never consults
    // the permission resolver, so nothing downstream would notice. An
    // installation switched off must be switched off everywhere, not only
    // where a human signs in.
    const tenant = await this.container.tenants.findById(botInstance.tenantId);
    if (tenant === null || tenant.status !== 'ACTIVE') {
      throw errors.notFound(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND, 'Unknown bot instance.');
    }

    // Parsed at the boundary, like every other command on this codebase.
    //
    // `@Body() update: Update` was a TypeScript type and nothing more, so at
    // runtime this was whatever was posted. A body with no `update_id` reached
    // the write path and was keyed as the literal string `unknown` — which
    // makes every malformed update from one bot a replay of the first, silently
    // swallowed with a 200. Refused here instead, before anything is written.
    //
    // Answered as a validation error rather than a 200: a genuine Telegram
    // update always carries an integer `update_id`, so a body without one is
    // not traffic to be tolerated. It is also not retried into a loop, because
    // Telegram is not the sender of it.
    // Answered 400 by the error filter, like every other malformed command.
    // Not a 200: a genuine Telegram update always carries an integer
    // `update_id`, so a body without one is not traffic to be tolerated — and
    // Telegram is not the sender of it, so there is no retry loop to avoid.
    const update = telegramUpdateSchema.parse(body);

    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());
    const updateId = String(update.update_id);

    // The update is a trigger; the ping itself is system work, so it acts as
    // SYSTEM_JOB and the audit row names the update that caused it. SYSTEM_JOB
    // is not a bypass — it holds only the narrow set the contract grants it.
    const actor = systemJobActor(`telegram-update:${botInstance.id}:${updateId}`, correlationId);

    // Scoped to the bot's own tenant rather than to the system scope, so the
    // rows this writes belong to somebody.
    const scope: TenantContext = {
      tenantId: botInstance.tenantId,
      botInstanceId: botInstance.id,
    };

    const idempotencyKey = telegramUpdateKey(botInstance.id, updateId);

    if (isPingCommand(update)) {
      await this.container.recordPing.execute(scope, actor, {
        // Telegram redelivers an update after a timeout; keying on the bot AND
        // the update id makes that redelivery a replay, while keeping two bots'
        // identically numbered updates distinct.
        idempotencyKey,
        source: 'telegram',
      });
      /*
       * `/ping` returns HERE, so it does NOT also run the customer turn.
       *
       * That is a real exclusion and it is stated rather than left to be noticed:
       * somebody who types `/ping` at the bot gets no customer row and no
       * `last_seen_at`, even though a contact is a contact. The reason is the
       * idempotency key. `RecordPingService` namespaces by `actor.surface`, which on
       * this path is `TELEGRAM` — the same namespace `resolveFromUpdate` uses — and
       * both would present `telegram:<bot>:update:<id>` with DIFFERENT request
       * hashes. The second would be refused as `platform.idempotency_payload_mismatch`,
       * the catch below would record `telegram.turn_failed`, and the ping would look
       * broken.
       *
       * Suffixing one of the two keys would fix the collision and cost more than it
       * buys: the key would stop being the update's identity, which is the one thing
       * every comment about it depends on. `/ping` is an operator affordance for
       * proving the pipeline end to end, not a customer command, so the customer it
       * does not create is a customer nobody was asking about.
       */
      return { ok: true };
    }

    /*
     * The customer-facing turn.
     *
     * Runs for every update that carries a Telegram user, which is the point: a
     * customer's existence and their `last_seen_at` are facts about any contact, not
     * only about `/start`. `BotRuntime` commits that state change and THEN replies,
     * outside the transaction — `telegramSend` refuses to run inside one at all.
     *
     * An update with no `from` is not a customer contact. Telegram sends such updates
     * (a channel post, an edited message in some shapes), and inventing a customer for
     * one would key a row on an identity nobody has.
     *
     * Wrapped, and the wrapping is deliberate. A throw here becomes a non-2xx, a
     * non-2xx makes Telegram redeliver the same update, and a redelivered update whose
     * only problem was a transient failure is an unbounded loop. The runtime already
     * returns send failures rather than throwing; this catches the rest — and records
     * it, because a swallowed error with no trace is the legacy system's `catch {}`.
     */
    const telegramUserId = telegramUserIdOf(update);
    if (telegramUserId !== null) {
      try {
        await this.container.botRuntime.handle(scope, actor, {
          idempotencyKey,
          botInstanceId: botInstance.id,
          update,
          telegramUserId,
          from: telegramFromOf(update),
        });
      } catch (error) {
        await this.container.opsLog.record(scope, {
          code: 'telegram.turn_failed',
          severity: 'ERROR',
          message: 'A Telegram update could not be handled.',
          dedupeKey: `telegram.turn_failed:${botInstance.id}`,
          // The update id and the bot, and nothing out of the update itself. A
          // customer's message text in an operational event is the hazard
          // `docs/open-questions.md` records for this phase.
          context: {
            botInstanceId: botInstance.id,
            updateId,
            error: error instanceof Error ? error.name : 'unknown',
          },
        });
      }
    }

    // Always a SUCCESSFUL 2xx — 201, which is Nest's POST default and what the
    // integration suite asserts. The rule is about the CLASS, not the number: a
    // non-2xx makes Telegram retry the same update indefinitely,
    // and an update we do not handle is not an error.
    return { ok: true };
  }
}

/**
 * The idempotency identity of a Telegram update.
 *
 * Exported so the tests assert the shape directly rather than inferring it from
 * behaviour — this is the property, not an implementation detail.
 */
export function telegramUpdateKey(botInstanceId: string, updateId: string): string {
  return `telegram:${botInstanceId}:update:${updateId}`;
}

/**
 * Telegram's `from` for the human who caused this update.
 *
 * On an ordinary message it is `message.from`; on a tapped button it is
 * `callback_query.from` — NOT `callback_query.message.from`, which is the BOT that sent
 * the message the button was attached to. Reading the wrong one would resolve a customer
 * row for the bot itself on every tap, and `is_bot` would only catch it because
 * `telegramUserIdOf` checks that flag.
 *
 * Exported so the controller passes ONE value to the runtime and nothing re-derives it.
 */
export function telegramFromOf(update: unknown): unknown {
  const shaped = update as {
    message?: { from?: unknown };
    callback_query?: { from?: unknown };
  } | null;
  return shaped?.message?.from ?? shaped?.callback_query?.from;
}

/**
 * Constant-time comparison.
 *
 * Timing analysis over the network is not a realistic attack on a 16+ character
 * secret, but the comparison costs nothing to do correctly. Both sides are
 * hashed first so the buffers are always equal length and the comparison itself
 * cannot leak the secret's length.
 */
function secretTokenMatches(supplied: string | undefined, expected: string): boolean {
  if (supplied === undefined) return false;
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Whether this update is the one command Phase 1 handles.
 *
 * Reads through the passthrough fields rather than a modelled `message` shape:
 * the schema states what this installation depends on, and the rest of an
 * update stays unmodelled on purpose. Anything that is not the expected shape
 * is simply not a ping.
 */
function isPingCommand(update: TelegramUpdate): boolean {
  const message = (update as { message?: { text?: unknown } }).message;
  const text = message?.text;
  return typeof text === 'string' && text.trim().startsWith('/ping');
}

/**
 * The Telegram numeric id of the person who sent this update, as text.
 *
 * Null when the update carries no `from` — a channel post, for instance. Identity, so it
 * is read strictly: a `from.id` that is not a number is not an id, and coercing one would
 * key a customer row on whatever was sent.
 */
export function telegramUserIdOf(update: unknown): string | null {
  const from = telegramFromOf(update) as { id?: unknown; is_bot?: unknown } | null | undefined;
  if (from === undefined || from === null) return null;
  // A bot is not a customer. Telegram marks its own and other bots' messages, and a
  // customer row for one would be a row no human can ever sign in to.
  if (from.is_bot === true) return null;
  if (typeof from.id !== 'number' || !Number.isSafeInteger(from.id) || from.id <= 0) return null;
  return String(from.id);
}
