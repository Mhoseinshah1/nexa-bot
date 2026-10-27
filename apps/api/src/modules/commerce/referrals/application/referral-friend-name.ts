/**
 * How an invited friend is NAMED to the customer who invited them (R11 B3).
 *
 * A referee did not agree to be listed to anyone. What the referrer may see is therefore as
 * little as identifies them to the referrer who already knows them: a first name, or — when
 * there is none — a username with its middle hidden. Never the last name, the Telegram id or
 * a phone; those are never even read (`DrizzleReferralFriendsRepository` selects the first
 * name and the username only), and this is the one place the displayed text is made.
 */

/** The longest first name drawn, in characters (code points, so an emoji is one). */
export const FRIEND_NAME_MAX_LENGTH = 24;

/** ASCII and C1 controls (a newline, a tab): read as a space. */
const CONTROLS = /\p{Cc}/gu;
/**
 * Zero-width space, the bidi marks and overrides and the BOM: invisible, and a way to spoof a
 * line, so they are dropped. The zero-width NON-joiner (U+200C) and joiner (U+200D) are NOT:
 * Persian spells «می‌خواهم» and «کتاب‌ها» with the first, and a name without it is misspelt.
 */
const FORMAT_MARKS = /[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu;

function cleaned(value: string | null): string {
  return (value ?? '')
    .replace(CONTROLS, ' ')
    .replace(FORMAT_MARKS, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `@ab***`: the first two letters of a username of five or more, one of three or four, none otherwise. */
export function maskUsername(username: string): string {
  const letters = Array.from(username.replace(/^@+/u, ''));
  const shown = letters.length >= 5 ? 2 : letters.length >= 3 ? 1 : 0;
  return `@${letters.slice(0, shown).join('')}***`;
}

/** The friend's display text, or null when they have neither a first name nor a username. */
export function friendDisplayName(
  firstName: string | null,
  username: string | null,
): string | null {
  const name = cleaned(firstName);
  if (name !== '') return Array.from(name).slice(0, FRIEND_NAME_MAX_LENGTH).join('');
  const handle = cleaned(username).replace(/^@+/u, '');
  return handle === '' ? null : maskUsername(handle);
}
