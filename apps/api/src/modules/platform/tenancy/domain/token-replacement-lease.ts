/**
 * R4 — how long a claim on a bot's token/webhook (`bot_instances.token_replacement_claim`)
 * lasts, derived from the Telegram call timeout it has to outlive.
 *
 * A Web Admin replacement makes at most seven sequential Telegram calls while it holds
 * the claim — getMe, getWebhookInfo, setWebhook, getWebhookInfo, and on a failure the
 * compensation's getWebhookInfo, deleteWebhook, getWebhookInfo — each bounded by the call
 * core's timeout (`NOTIFICATION_SEND_TIMEOUT_MS`, up to 120 s). A fixed lease shorter than
 * that lets a slow attempt's claim lapse mid-flight and a second one interleave with it.
 * So the lease is the worst case plus a minute for the transactions around the calls, and
 * never under five minutes. The installer's registration makes fewer calls under the same
 * claim, so the same bound covers it.
 */
export const TOKEN_REPLACEMENT_LEASE_FLOOR_MS = 5 * 60_000;
export const TOKEN_REPLACEMENT_MAX_TELEGRAM_CALLS = 7;
export const TOKEN_REPLACEMENT_LEASE_MARGIN_MS = 60_000;

export function tokenReplacementLeaseMs(telegramCallTimeoutMs: number): number {
  return Math.max(
    TOKEN_REPLACEMENT_LEASE_FLOOR_MS,
    TOKEN_REPLACEMENT_MAX_TELEGRAM_CALLS * telegramCallTimeoutMs +
      TOKEN_REPLACEMENT_LEASE_MARGIN_MS,
  );
}
