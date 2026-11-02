import { MINIAPP_NOTIFICATION_TEXT_MAX, type TemplateFormat } from '@nexa/contracts';
import { appearanceFallbackText } from './appearance-render.js';

/**
 * Round 11, B1: the words a delivered message is kept under for the mini app's notification
 * centre — what the customer was sent, as plain text.
 *
 * The renderer's output is what Telegram was given, so it carries two things a list item
 * must not: `{icon:…}` appearance markers (each becomes its fallback emoji, with no
 * custom-emoji decoration) and — for a `TELEGRAM_HTML` key — Telegram's tags and character
 * references. A hand-written pipe table stays as the plain lines it is. A `PLAIN_TEXT` key is NOT unescaped: its `&lt;` is the
 * letters the operator typed, and Telegram sends them as typed.
 *
 * Nothing is added. The text is a function of the rendered message alone, so it can say no
 * more than the bot already said, and a message that rendered to nothing yields `null` (there
 * is nothing to list). The result is cut at `MINIAPP_NOTIFICATION_TEXT_MAX` with an ellipsis
 * rather than refused: the delivery has happened, and its record must not depend on a bound.
 */
export function notificationCentreText(rendered: string, format: TemplateFormat): string | null {
  let text = appearanceFallbackText(rendered);
  if (format === 'TELEGRAM_HTML') {
    text = text
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<[^>]*>/gu, '')
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&quot;/gu, '"')
      .replace(/&#0?39;/gu, "'")
      // Last, so `&amp;lt;` is the four characters `&lt;` and not a `<`.
      .replace(/&amp;/gu, '&');
  }
  text = text.trim();
  if (text === '') return null;
  const points = Array.from(text);
  if (points.length <= MINIAPP_NOTIFICATION_TEXT_MAX) return text;
  return `${points.slice(0, MINIAPP_NOTIFICATION_TEXT_MAX - 1).join('')}…`;
}
