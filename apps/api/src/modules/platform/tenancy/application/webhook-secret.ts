import { createHmac } from 'node:crypto';

/**
 * R12 F2 item 7: a Telegram webhook secret PER BOT, derived from the one configured secret.
 *
 * `TELEGRAM_WEBHOOK_SECRET` is one value for every bot this installation runs, so a secret
 * that leaked from one bot's registration (a Telegram-side log, a reseller's own tooling)
 * authenticated updates for every other bot too. The per-bot secret is
 * HMAC-SHA256(master, "nexa-telegram-webhook:v1:<botInstanceId>"), base64url: 43
 * characters from Telegram's allowed `A-Za-z0-9_-`, different for every bot, and nothing new
 * to store or rotate — rotating the master rotates them all.
 *
 * The receiver accepts BOTH this and the master (the rotation window): every webhook
 * registered before this release was registered with the master and keeps working, and a
 * later release that registers per-bot secrets stays rollback-safe to this one, which already
 * accepts them. Derived from the bot id IN THE URL, before that id is looked up, so the
 * check still says nothing about which bots exist.
 */
export const WEBHOOK_SECRET_DERIVATION_LABEL = 'nexa-telegram-webhook:v1:';

export function perBotWebhookSecret(master: string, botInstanceId: string): string {
  return createHmac('sha256', master)
    .update(`${WEBHOOK_SECRET_DERIVATION_LABEL}${botInstanceId}`, 'utf8')
    .digest('base64url');
}
