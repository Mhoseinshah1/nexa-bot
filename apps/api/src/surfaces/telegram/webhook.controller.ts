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
 *   - The webhook ANSWERS IMMEDIATELY and does the work behind the outbox.
 *     Telegram times a webhook out in seconds; a handler that calls a payment
 *     gateway or a panel inline will eventually be that timeout.
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

    if (isPingCommand(update)) {
      await this.container.recordPing.execute(scope, actor, {
        // Telegram redelivers an update after a timeout; keying on the bot AND
        // the update id makes that redelivery a replay, while keeping two bots'
        // identically numbered updates distinct.
        idempotencyKey: telegramUpdateKey(botInstance.id, updateId),
        source: 'telegram',
      });
    }

    // Always 200: a non-2xx makes Telegram retry the same update indefinitely,
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
