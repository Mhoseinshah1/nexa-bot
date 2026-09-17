import { z } from 'zod';

/**
 * Where a manual transfer actually goes.
 *
 * ## Why this exists at all
 *
 * Until Phase 5 the only way an operator could put a card number in front of a customer
 * was to override `bot.payment.manual_instructions` and type the digits into the message
 * body. `docs/phase5-audit.md` §1 measures what that costs: editing the template rewrites
 * what every already-issued instruction says, one body holds exactly one destination,
 * nothing validates a transposed digit, and the free-text setting of the same shape is the
 * one `INCIDENT-FIN-001` overwrote in production by typing a navigation string into a
 * captured prompt.
 *
 * So a payment destination stops being copy and becomes a row — and, once a payment has
 * been issued against it, a FROZEN COPY of that row. The two halves are separate on
 * purpose and the separation is the whole point: `PaymentAccount` is configuration an
 * operator may change at any time, and `PaymentDestinationSnapshot` is what a particular
 * customer was told, which nobody may change ever.
 *
 * ## What the research does and does not say
 *
 * The corpus establishes that `کارت به کارت` exists in the legacy system as one of eleven
 * gateways with sixteen controls, and that one of them is a free-text "tutorial"
 * (`FBR-009`, `INCIDENT-FIN-001`). It does NOT establish the remaining controls: the file
 * that would list them is not in the distilled corpus. `docs/research/README.md`'s rule
 * therefore applies — `NOT_EXPOSED` never means "does not exist", and an `UNKNOWN` is not
 * resolved by guessing.
 *
 * The field list below is consequently derived from what an Iranian card-to-card transfer
 * REQUIRES, and it is stated as such rather than attributed to MirzaBot. There is no
 * `accountNumber`: a card-to-card transfer is performed against the card number or the
 * Sheba and never the account number, and nothing asks for one.
 */

/** Operator-facing. Never shown to a customer — it names the account, it is not a fact about it. */
export const PAYMENT_ACCOUNT_LABEL_MAX_LENGTH = 80;
export const PAYMENT_ACCOUNT_BANK_NAME_MAX_LENGTH = 80;
export const PAYMENT_ACCOUNT_HOLDER_NAME_MAX_LENGTH = 120;

/**
 * The ordering an operator controls, and the same bounds `PRODUCT_SORT_*` uses.
 *
 * Ordering is `(sortOrder, createdAt, id)` everywhere it is applied, so two accounts
 * sharing a sort order still have ONE order rather than whatever the planner returns.
 */
export const PAYMENT_ACCOUNT_SORT_MIN = 0;
export const PAYMENT_ACCOUNT_SORT_MAX = 100_000;

/**
 * The ceiling on how many accounts one tenant may hold, as a rail rather than a policy.
 *
 * It exists so the list can be COMPLETE by construction. Every other list in this product
 * is a keyset page, because customers, orders and payments grow without bound; a payment
 * destination does not — a tenant has one card, or a handful. Paginating configuration
 * would mean a Web Admin page that silently omits the account an operator is looking for,
 * and the honest alternative to that is a bound the create path enforces and says so.
 *
 * Fifty is far past any real installation and far below anything that makes the query
 * expensive. It is not a product rule and nothing renders it to a customer.
 */
export const PAYMENT_ACCOUNT_MAX_PER_TENANT = 50;

/**
 * Everything that is not a digit or a Latin letter, removed.
 *
 * Written as "keep what matters" rather than "drop these separators", and that direction
 * is the load-bearing part. An operator pastes a card number out of a banking app, a bank
 * SMS or a Persian PDF, and what comes with it is unbounded: ordinary spaces, the no-break
 * space, hyphens, en dashes, the zero-width non-joiner, and the two bidi marks an RTL copy
 * carries invisibly. A deny-list has to enumerate them, and the ones it misses are the
 * INVISIBLE ones — a Sheba that looks identical to a valid one and is refused, which is
 * the support ticket nobody can diagnose.
 *
 * Nothing is lost by being strict here, because the patterns below then demand exactly
 * sixteen digits, or `IR` and twenty-four. A letter that survives this is a letter that
 * fails the pattern.
 */
const NOISE = /[^0-9A-Za-z]/gu;

/**
 * Persian and Arabic-Indic digits, mapped to ASCII.
 *
 * Load-bearing rather than polite. An operator pasting a card number out of a banking
 * app, a bank SMS or a Persian keyboard gets `۶۰۳۷۹۹۷...`, and every check below — the
 * length, the Luhn, the mod-97 — is defined over ASCII digits. Without this the operator
 * is told their own card number is malformed and has no way to find out why.
 */
const PERSIAN_ZERO = 0x06f0;
const ARABIC_INDIC_ZERO = 0x0660;

function toAsciiDigits(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) {
      out += String(code - PERSIAN_ZERO);
    } else if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * A card number reduced to the sixteen digits it is, or `null`.
 *
 * `null` for anything that is not exactly sixteen digits once the noise is removed. The
 * STRUCTURE only — see `isValidCardNumber` for the check digit, and neither of them
 * proves that the card exists or that the name beside it is its holder.
 */
export function normalizeCardNumber(input: string): string | null {
  const stripped = toAsciiDigits(input).replace(NOISE, '');
  return /^[0-9]{16}$/u.test(stripped) ? stripped : null;
}

/**
 * The Luhn check digit, over an already-normalised card number.
 *
 * Iranian bank cards are Luhn-valid, so this catches the single commonest way a card
 * number is entered wrongly: one transposed pair of digits. It is a STRUCTURAL check. It
 * says the string is a well-formed card number; it does not say the card exists, that it
 * is open, or that it belongs to the person named beside it. Only a transfer arriving
 * says that, which is why an operator still confirms one by hand.
 */
export function isValidCardNumber(normalized: string): boolean {
  if (!/^[0-9]{16}$/u.test(normalized)) return false;
  let sum = 0;
  for (let index = 0; index < 16; index += 1) {
    const digit = normalized.charCodeAt(15 - index) - 48;
    if (index % 2 === 0) {
      sum += digit;
      continue;
    }
    const doubled = digit * 2;
    sum += doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}

/**
 * A Sheba reduced to `IR` plus twenty-four digits, or `null`.
 *
 * Iran's IBAN. The product calls it شبا and the column calls it `iban`, because what is
 * validated below is the ISO 13616 structure and calling it anything else would invite a
 * second, differently-behaved implementation for "the international one".
 *
 * A leading `IR` is accepted in either case and may be absent entirely — an operator who
 * pastes the twenty-four digits alone means the same thing, and refusing them teaches
 * nobody anything.
 */
export function normalizeIban(input: string): string | null {
  const stripped = toAsciiDigits(input).replace(NOISE, '').toUpperCase();
  const withPrefix = /^[0-9]{24}$/u.test(stripped) ? `IR${stripped}` : stripped;
  return /^IR[0-9]{24}$/u.test(withPrefix) ? withPrefix : null;
}

/**
 * The ISO 13616 mod-97 check, over an already-normalised Sheba.
 *
 * Computed digit by digit rather than through `BigInt`, which is not a micro-optimisation:
 * the rearranged string is twenty-six characters and its numeric expansion exceeds every
 * exact integer JavaScript has. A `Number` implementation of this returns plausible
 * answers for short inputs and silently wrong ones here.
 */
export function isValidIban(normalized: string): boolean {
  if (!/^IR[0-9]{24}$/u.test(normalized)) return false;
  // The four leading characters move to the end, and each letter becomes its
  // position in the alphabet plus nine: I = 18, R = 27.
  const rearranged = `${normalized.slice(4)}1827${normalized.slice(2, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    remainder = (remainder * 10 + (character.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * What an operator submits, normalised and structurally checked on the way in.
 *
 * The normalisation happens HERE, inside the schema, so that what the service receives is
 * what the database stores and what the snapshot freezes — one representation, decided at
 * the trust boundary. A second normalisation anywhere downstream would be a second
 * opinion about what a card number is.
 *
 * `iban` is the one optional field, and it is optional because it is the one an operator
 * may legitimately not want to publish. Everything else is required, which is what makes
 * a rendered instruction always complete: `docs/phase5-audit.md` §4.6 records why an
 * absent required field cannot be rendered around.
 */
export const paymentAccountInputSchema = z.object({
  label: z.string().trim().min(1).max(PAYMENT_ACCOUNT_LABEL_MAX_LENGTH),
  bankName: z.string().trim().min(1).max(PAYMENT_ACCOUNT_BANK_NAME_MAX_LENGTH),
  holderName: z.string().trim().min(1).max(PAYMENT_ACCOUNT_HOLDER_NAME_MAX_LENGTH),
  cardNumber: z.string().transform((value, ctx) => {
    const normalized = normalizeCardNumber(value);
    if (normalized === null || !isValidCardNumber(normalized)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a 16-digit card number that passes its check digit',
      });
      return z.NEVER;
    }
    return normalized;
  }),
  /*
   * An empty string means "no Sheba", not "a Sheba that is empty".
   *
   * A web form submits `''` for a field the operator cleared, and a schema that refused
   * it would make removing a Sheba impossible through the only surface that can. The
   * value reaching the service is `null` either way, so nothing downstream has to know
   * which of the two an operator did.
   */
  iban: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value === null || value.trim() === '') return null;
      const normalized = normalizeIban(value);
      if (normalized === null || !isValidIban(normalized)) {
        ctx.addIssue({ code: 'custom', message: 'must be a Sheba that passes its check digits' });
        return z.NEVER;
      }
      return normalized;
    }),
  sortOrder: z.number().int().min(PAYMENT_ACCOUNT_SORT_MIN).max(PAYMENT_ACCOUNT_SORT_MAX),
});

export type PaymentAccountInput = z.output<typeof paymentAccountInputSchema>;

/**
 * The customer-facing half of an account, frozen at the moment a payment was issued.
 *
 * Exactly the fields a customer needs in order to send money, and nothing else — no id,
 * no `enabled`, no ordering, no `isDefault`. Those are configuration, and a snapshot that
 * carried them would be answering "what was the state of the tenant's settings", which
 * nobody has ever needed to know and which changes meaning the moment the settings do.
 *
 * `label` IS here even though a customer never sees it, because an operator reconciling a
 * bank statement against a payment does, and the label is the only field that survives an
 * operator renaming the account it names.
 */
export interface PaymentDestinationSnapshot {
  readonly bankName: string;
  readonly holderName: string;
  readonly cardNumber: string;
  readonly iban: string | null;
  readonly label: string;
}
