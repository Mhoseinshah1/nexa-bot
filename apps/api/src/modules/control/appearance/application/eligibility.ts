import type { AppearanceBotRecord } from './ports.js';

/**
 * Whether a bot may carry custom emoji — the ONE answer to that question.
 *
 * The runtime's decoration (`CachedAppearanceReader.decorationFor`) and the button builder's
 * Inspector (`BotMenuBuilderService.view`, `iconEligibility`) both ask it, so the page can
 * never call a bot eligible that the messenger will not decorate. Untested is not eligible,
 * and neither is any outcome but `SENT`: the Bot API grants custom emoji per bot and answers
 * nothing in advance, so only a recorded `SENT` proves it (round T, F-4 of
 * `docs/round-t-final-review.md`).
 */
export function isCustomEmojiEligible(bot: Pick<AppearanceBotRecord, 'test'> | undefined): boolean {
  return bot !== undefined && bot.test !== null && bot.test.outcome === 'SENT';
}
