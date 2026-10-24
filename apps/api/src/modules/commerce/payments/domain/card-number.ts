/**
 * R8 A2: a payee card number as the card invoice shows it and as its copy button carries it.
 *
 * A card arrives in more than one shape — TonPays' own (`6037-9911-0000-1001`), an
 * operator-entered one with spaces, or Persian digits — and a banking app takes sixteen
 * ASCII digits. Pure display: the number a payment was ISSUED against is stored exactly as
 * it was received, and nothing here is written anywhere.
 */

// Whitespace, the joiners and direction marks a Persian keyboard inserts, and - _ . as written.
const SEPARATORS = /\s|\u200c|\u200d|\u200e|\u200f|[-_.]/gu;

/** Persian (U+06F0..) and Arabic-Indic (U+0660..) digits to ASCII; everything else as is. */
function asciiDigits(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else out += character;
  }
  return out;
}

/** The sixteen ASCII digits of a card number, or null when it is not a sixteen-digit card. */
export function cardDigits(cardNumber: string): string | null {
  const digits = asciiDigits(cardNumber).replace(SEPARATORS, '');
  return /^\d{16}$/u.test(digits) ? digits : null;
}

/** `5859 8318 8743 8546`: four groups of four; a number that is not sixteen digits, as sent. */
export function groupedCardNumber(cardNumber: string): string {
  const digits = cardDigits(cardNumber);
  return digits === null ? cardNumber : digits.replace(/(\d{4})(?=\d)/gu, '$1 ');
}

/** What «💳 کپی شماره کارت» puts on the clipboard: the sixteen digits, else the card as sent. */
export function cardNumberToCopy(cardNumber: string): string {
  return cardDigits(cardNumber) ?? cardNumber;
}
