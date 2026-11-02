import { createHmac } from 'node:crypto';
import { webhookSecretFingerprint } from './webhook-fingerprint.js';

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
 * Every registration this installation makes (the bootstrap's `setWebhook`, a Web Admin
 * token replacement) sends THIS value to Telegram, never the master.
 *
 * THE ROTATION WINDOW. The receiver accepts BOTH this and the master, for every bot, for as
 * long as this release runs: every webhook registered before it was registered with the
 * master and keeps working until it is re-registered — which the next `botctl update`,
 * `botctl telegram register` or installer rerun does by itself, keeping the queue — and a
 * rollback to the release that only accepted the master is re-registered by that release's
 * own reconcile. Closing the window (refusing the master) is a later release's change, made
 * once `botctl telegram status` shows no bot left on the installation-wide secret. Derived
 * from the bot id IN THE URL, before that id is looked up, so the check still says nothing
 * about which bots exist.
 */
export const WEBHOOK_SECRET_DERIVATION_LABEL = 'nexa-telegram-webhook:v1:';

export function perBotWebhookSecret(master: string, botInstanceId: string): string {
  return createHmac('sha256', master)
    .update(`${WEBHOOK_SECRET_DERIVATION_LABEL}${botInstanceId}`, 'utf8')
    .digest('base64url');
}

/**
 * Which secret a recorded registration digest names, for THIS bot.
 *
 *  - `PER_BOT`       — its own derived secret: the steady state from this release on;
 *  - `INSTALLATION`  — the master: a registration made before this release, still accepted
 *                      (the rotation window) and moved by the next re-registration;
 *  - `OTHER`         — neither: the master was rotated since, or this is another bot's
 *                      secret. The receiver refuses it.
 *
 * Compares DIGESTS of the candidates, so no secret is compared with stored data and nothing
 * here can return one.
 */
export type WebhookSecretRegistration = 'PER_BOT' | 'INSTALLATION' | 'OTHER';

export function webhookSecretRegistration(
  recordedFingerprint: string,
  master: string,
  botInstanceId: string,
): WebhookSecretRegistration {
  if (recordedFingerprint === perBotWebhookSecretFingerprint(master, botInstanceId)) {
    return 'PER_BOT';
  }
  if (recordedFingerprint === webhookSecretFingerprint(master)) return 'INSTALLATION';
  return 'OTHER';
}

/** The digest a registration with this bot's own secret records. */
export function perBotWebhookSecretFingerprint(master: string, botInstanceId: string): string {
  return webhookSecretFingerprint(perBotWebhookSecret(master, botInstanceId));
}
