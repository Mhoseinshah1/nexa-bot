import { GIFT_CARD_EXPORT_COLUMNS, type TenantContext } from '@nexa/contracts';
import { formatDateTime, type TemplatePresentation } from '@nexa/i18n';
import { formatGiftCardCode } from '../domain/gift-card-code.js';
import type { GiftCardBatchRecord, GiftCardCsvRenderer } from '../application/ports.js';

/**
 * A batch's codes as a CSV (R10 D4): one row per code, the code in its printed form
 * (`ABCD-EFGH-JKMN-PQRS-TVWX`), the face value in minor units with its currency, the expiry in
 * ISO-8601 UTC and in the tenant's calendar and time zone, and the batch's label.
 *
 * A leading UTF-8 BOM so a spreadsheet opens the Persian label as Persian. Every field is
 * quoted, and a field that begins with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * prefixed with an apostrophe — the operator-typed label must not become a formula in the
 * spreadsheet that opens it.
 */
export function buildGiftCardCsv(
  batch: GiftCardBatchRecord,
  codes: readonly string[],
  presentation: TemplatePresentation,
): string {
  const expiresUtc = batch.expiresAt.toISOString();
  const expiresLocal = formatDateTime(batch.expiresAt, presentation);
  const lines = [GIFT_CARD_EXPORT_COLUMNS.map(field).join(',')];
  for (const code of codes) {
    lines.push(
      [
        formatGiftCardCode(code),
        batch.amount.amountMinor.toString(),
        batch.amount.currency,
        expiresUtc,
        expiresLocal,
        batch.label,
      ]
        .map(field)
        .join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function field(value: string): string {
  const safe = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** `gift-cards-<first 8 of the batch id>.csv`: Latin letters, digits and dashes only. */
export function giftCardCsvFileName(batchId: string): string {
  return `gift-cards-${batchId.replace(/[^0-9a-f]/giu, '').slice(0, 8)}.csv`;
}

/** The CSV, in the tenant's own calendar and time zone (`TenantPresentationReader`). */
export class PresentationGiftCardCsvRenderer implements GiftCardCsvRenderer {
  constructor(
    private readonly presentation: {
      presentationFor(scope: TenantContext, tx?: unknown): Promise<TemplatePresentation>;
    },
  ) {}

  async render(
    scope: TenantContext,
    batch: GiftCardBatchRecord,
    codes: readonly string[],
  ): Promise<{ readonly fileName: string; readonly content: string }> {
    const presentation = await this.presentation.presentationFor(scope);
    return {
      fileName: giftCardCsvFileName(batch.id),
      content: buildGiftCardCsv(batch, codes, presentation),
    };
  }
}
