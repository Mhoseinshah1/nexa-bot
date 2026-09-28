/**
 * Mandatory channel membership (Package B, `docs/package-b-channel-membership-audit.md`).
 *
 * The windows are the brief's (B6): a positive answer is kept about a minute, a negative
 * one only briefly, so a customer who has just joined is let in on their next tap or at
 * once through the check button. Nothing is cached for ever.
 */

/** A MEMBER answer is trusted for this long. */
export const CHANNEL_MEMBER_CACHE_MS = 60_000;
/** A NOT_MEMBER answer is trusted only this long; the check button ignores it. */
export const CHANNEL_NOT_MEMBER_CACHE_MS = 10_000;
/**
 * An UNKNOWN answer (the check failed) is kept this long, so a channel the bot cannot
 * query does not cost a Telegram call on every tap. Unknown is treated as satisfied.
 */
export const CHANNEL_UNKNOWN_CACHE_MS = 10_000;
/** How many answers one process keeps; the oldest goes first. */
export const CHANNEL_MEMBERSHIP_CACHE_MAX = 10_000;
/** One `getChatMember` call's budget. The customer's turn is waiting on it. */
export const CHANNEL_MEMBERSHIP_TIMEOUT_MS = 3_000;

/**
 * The bot could not learn whether a customer is in a required channel — the bot is not
 * an administrator there, the chat does not exist, Telegram did not answer. The check
 * fails OPEN, and this condition says the channel is not being enforced. Per bot and
 * channel. Recovered by `CHANNEL_MEMBERSHIP_RECOVERED_CODE`.
 */
export const CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE = 'channels.membership_unavailable';
export const CHANNEL_MEMBERSHIP_RECOVERED_CODE = 'channels.membership_recovered';
/** How often, at most, one process writes the condition for one bot and channel. */
export const CHANNEL_MEMBERSHIP_RECORD_INTERVAL_MS = 60_000;
