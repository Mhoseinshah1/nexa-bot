import type { BotInstanceId } from '@nexa/contracts';

/**
 * Premium UI: the one operational condition decoration can open, and its recovery.
 *
 * Declared in the application layer so the appearance service (a different module's
 * application layer) can name the SAME key when it closes the condition — after an
 * operator removes the last custom emoji, there is nothing left to re-test and the
 * warning would otherwise stay open for ever (Codex, PR #121, finding 8). The messenger
 * opens it and the next accepted test closes it; both use these.
 *
 * Deduplicated per bot: the decoration is the tenant's, the refusal is the bot's.
 */
export const APPEARANCE_DECORATION_FAILED_CODE = 'telegram.appearance_decoration_failed';
export const APPEARANCE_DECORATION_OK_CODE = 'telegram.appearance_decoration_ok';

export function appearanceDecorationConditionKey(botInstanceId: BotInstanceId): string {
  return `${APPEARANCE_DECORATION_FAILED_CODE}:${botInstanceId}`;
}
