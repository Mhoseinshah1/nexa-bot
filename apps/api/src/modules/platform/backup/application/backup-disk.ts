import { toPersianDigits } from '@nexa/contracts';

/**
 * Human units for the backup volume (Round 8, B3 and B6).
 *
 * The operations log used to print «The backup volume has 5368709120 bytes free…», which an
 * owner cannot read at a glance and which was English in a Persian group. Everything the
 * backup says about disk space goes through here, so the refusal, the warning and the Web
 * Admin card cannot disagree about a figure.
 */

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const KIB = 1024;

/** `5.4 گیگابایت` in Persian digits: one decimal, the decimal dropped when it is zero. */
export function persianGigabytes(bytes: number): string {
  const tenths = Math.max(0, Math.round((bytes / GIB) * 10));
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const text = fraction === 0 ? String(whole) : `${String(whole)}.${String(fraction)}`;
  return `${toPersianDigits(text)} گیگابایت`;
}

/**
 * Any size in the unit a person reads it in: بایت, کیلوبایت, مگابایت, گیگابایت. Whole numbers
 * for small units, one decimal for gigabytes («۱۸۲ مگابایت», «۲٫۴ گیگابایت»).
 */
export function persianByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `${toPersianDigits('0')} بایت`;
  if (bytes >= GIB) return persianGigabytes(bytes);
  if (bytes >= MIB) return `${toPersianDigits(String(Math.round(bytes / MIB)))} مگابایت`;
  if (bytes >= KIB) return `${toPersianDigits(String(Math.round(bytes / KIB)))} کیلوبایت`;
  return `${toPersianDigits(String(Math.floor(bytes)))} بایت`;
}

/** The refusal reason, word for word as the owner specified. */
export function diskInsufficientReason(freeBytes: number, requiredBytes: number): string {
  return (
    `فضای دیسک کافی نیست (آزاد: ${persianGigabytes(freeBytes)}، ` +
    `لازم: ${persianGigabytes(requiredBytes)})`
  );
}
