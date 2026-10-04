/**
 * The Telegram webhook URL of ONE bot instance on this installation, composed in one place.
 *
 * The route is `POST /telegram/webhook/:botInstanceId` (`webhook.controller.ts`), served by
 * the api process behind the edge's `/telegram/webhook/*` handler (`deploy/caddy/routes.caddy`).
 * ADR-0029 settled that the URL is composed from an ORIGIN and never accepted whole, so the
 * URL Telegram is given and the URL this installation answers on cannot drift apart. The
 * bootstrap and the Web Admin's token replacement (R4) both compose it here.
 */
export const TELEGRAM_WEBHOOK_PATH_PREFIX = '/telegram/webhook';

export function telegramWebhookUrl(origin: string, botInstanceId: string): string {
  return `${origin}${TELEGRAM_WEBHOOK_PATH_PREFIX}/${botInstanceId}`;
}

/**
 * The URL this installation registers for `botInstanceId`, derived from the registration
 * it RECORDED — or null when there is none it can trust.
 *
 * The API process is not told the public origin (ADR-0029: it is a CLI argument, and
 * `WEB_ADMIN_ORIGINS` is deliberately not it). What it does have is `webhook_url`, written
 * only after Telegram accepted a registration the installer composed from that origin —
 * the one public origin this installation has already proven it serves, the same source
 * `DrizzlePublicOriginReader` gives the payment callbacks. So the recorded URL is parsed,
 * its origin taken, and the URL recomposed through `telegramWebhookUrl`; and it is trusted
 * only when the recomposition is EXACTLY what was recorded. Anything else — plain http, a
 * path that is not this bot's route, a query, credentials in the authority, another bot's
 * id — is not a registration this installation made for this bot, and guessing from it
 * would register a URL that 404s.
 */
export function expectedWebhookUrl(recorded: string | null, botInstanceId: string): string | null {
  if (recorded === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(recorded);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (parsed.pathname !== `${TELEGRAM_WEBHOOK_PATH_PREFIX}/${botInstanceId}`) return null;
  const expected = telegramWebhookUrl(parsed.origin, botInstanceId);
  return expected === recorded ? expected : null;
}

/**
 * The update types this installation handles: a customer's message (and a Stars
 * `successful_payment`, which arrives in one), a button press, a Stars pre-checkout, and the
 * bot's own membership of the operations log group. Every one is in the Bot API's DEFAULT
 * set, which is why no registration here ever narrows `allowed_updates`.
 */
export const TELEGRAM_HANDLED_UPDATE_TYPES = [
  'message',
  'callback_query',
  'pre_checkout_query',
  'my_chat_member',
  // TB1 (ADR-0033): the Telegram Business connection and its chats.
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
] as const;

/**
 * Whether a registration's `allowed_updates` leaves out a type this installation handles.
 * Null or empty is Telegram's default set, which holds all of them.
 */
export function allowedUpdatesNarrowed(allowed: readonly string[] | null): boolean {
  if (allowed === null || allowed.length === 0) return false;
  return TELEGRAM_HANDLED_UPDATE_TYPES.some((type) => !allowed.includes(type));
}
