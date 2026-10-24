import { formatPersianInteger, type Money } from '@nexa/contracts';

/**
 * R8 A2: the one amount a card invoice tells the customer to transfer, in the three forms the
 * owner-approved screen uses — RIAL, large, in Persian digits; TOMAN beside it; and the
 * clipboard's bare ASCII rial digits, which is what an Iranian banking app takes.
 *
 * Integer arithmetic on `bigint` only. Display and clipboard ONLY: the figure in is already
 * the one the customer must transfer (`amountToTransfer`, or TonPays' exact amount), and
 * nothing here is what Nexa settles, credits or refunds — those read the payment's own
 * principal.
 */
export interface TransferFigures {
  /** `{amountRial}`: `۲۵۰٬۹۹۰`, no unit (the template body writes it). */
  readonly amountRial: string;
  /** `{amountToman}`: `۲۵٬۰۹۹`, or null when the rial figure is not a whole toman. */
  readonly amountToman: string | null;
  /** The copy button's payload: `250990`. */
  readonly copyRial: string;
}

/** Null for a negative amount or a currency that is not the rial or the toman. */
export function transferFigures(amount: Money): TransferFigures | null {
  if (amount.amountMinor < 0n) return null;
  let rial: bigint;
  if (amount.currency === 'IRT') rial = amount.amountMinor * 10n;
  else if (amount.currency === 'IRR') rial = amount.amountMinor;
  else return null;
  const toman = rial % 10n === 0n ? rial / 10n : null;
  return {
    amountRial: formatPersianInteger(rial),
    amountToman: toman === null ? null : formatPersianInteger(toman),
    copyRial: rial.toString(),
  };
}
