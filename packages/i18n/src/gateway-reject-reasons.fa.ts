import type { TonPaysTelegramErrorCode } from '@nexa/contracts';

/**
 * R9 C1 — TonPays' `reject_reasons`, in Persian where the reason is one Nexa KNOWS.
 *
 * The shape and vocabulary of a reason are undocumented (`OQ-TPTG-21`, still open): the
 * document's examples show only `[]`. The only reason tokens whose meaning IS documented are
 * the provider's own error codes for a receipt or an invoice (the custom Telegram error table),
 * so exactly those are put into Persian here, matched case-insensitively. Every other reason —
 * Persian prose, an English sentence, a token nobody documented — is shown exactly as the
 * provider worded it (sanitised and bounded by `parseRejectReasons`), so nothing is invented
 * and no unknown code is hidden behind a guessed translation.
 */
export const TONPAYS_REJECT_REASONS_FA: Readonly<
  Partial<Record<TonPaysTelegramErrorCode, string>>
> = {
  INVALID_RECEIPT_TYPE: 'نوع فایل رسید پذیرفته نیست',
  RECEIPT_TOO_LARGE: 'حجم فایل رسید بیشتر از حد مجاز است',
  EMPTY_RECEIPT: 'فایل رسید خالی است',
  INVOICE_ID_MISMATCH: 'رسید با این فاکتور مطابقت ندارد',
  REMAINDER_INVOICE_MISSING: 'فاکتور مابقی پیدا نشد',
  NOT_PENDING: 'فاکتور دیگر در انتظار پرداخت نیست',
};

/** One reason in Persian when it is a known code; otherwise exactly as the provider sent it. */
export function rejectReasonFa(reason: string): string {
  const known = (TONPAYS_REJECT_REASONS_FA as Readonly<Record<string, string>>)[
    reason.trim().toUpperCase()
  ];
  return known ?? reason;
}
