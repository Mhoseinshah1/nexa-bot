import { describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, RECOVERY_FAILURE_CODES } from '@nexa/contracts';
import { ApiError } from '../../apps/web/src/api/client';
import { t } from '../../apps/web/src/i18n/web.fa';
import {
  RECOVERY_FAILURE_TEXT,
  recoveryErrorText,
  recoveryFailureText,
} from '../../apps/web/src/recovery-failure-labels';

/**
 * Every recovery failure code has words (FIX-12, C5.9).
 *
 * Iterates the CONTRACT's vocabulary, not the map: a code added to
 * `RECOVERY_FAILURE_CODES` without a translation fails here (and fails typecheck on the
 * `Record`), rather than reaching an operator as `recovery.something` in a table.
 */
const PERSIAN = /[؀-ۿ]/;

describe('the recovery failure vocabulary in words', () => {
  it.each(RECOVERY_FAILURE_CODES.map((code) => [code]))('%s has a Persian sentence', (code) => {
    expect(Object.keys(RECOVERY_FAILURE_TEXT)).toContain(code);
    const text = recoveryFailureText(code);
    expect(text).toMatch(PERSIAN);
    expect(text).not.toContain('recovery.');
    expect(text.length).toBeGreaterThan(20);
  });

  it('names no code the contract does not', () => {
    expect(Object.keys(RECOVERY_FAILURE_TEXT).sort()).toEqual([...RECOVERY_FAILURE_CODES].sort());
  });

  it('gives each failure its own sentence', () => {
    const sentences = RECOVERY_FAILURE_CODES.map((code) => recoveryFailureText(code));
    expect(new Set(sentences).size).toBe(RECOVERY_FAILURE_CODES.length);
  });

  it('reads a code this build does not know as the internal one, never as the raw code', () => {
    expect(recoveryFailureText('recovery.from_a_newer_release')).toBe(
      recoveryFailureText('recovery.internal'),
    );
  });
});

describe('a refused request on the recovery page', () => {
  const refused = (code: string) =>
    new ApiError(409, code, 'The installation is refusing new durable writes.');

  it.each([
    PLATFORM_ERROR_CODES.RECOVERY_REFUSED,
    PLATFORM_ERROR_CODES.RECOVERY_ALREADY_ACTIVE,
    PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
    PLATFORM_ERROR_CODES.RECOVERY_CONFIRMATION_INVALID,
    PLATFORM_ERROR_CODES.BACKUP_ALREADY_RUNNING,
    PLATFORM_ERROR_CODES.BACKUP_RUN_MISSING,
    PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    PLATFORM_ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
  ])('%s is said in Persian, never as the server’s English', (code) => {
    const text = recoveryErrorText(refused(code));
    expect(text).toMatch(PERSIAN);
    expect(text).not.toContain('durable writes');
    expect(text).not.toBe(t('web.error'));
  });

  it('says anything else generically, with the code for the log, and never the message', () => {
    const text = recoveryErrorText(refused('platform.something_new'));
    expect(text).toMatch(PERSIAN);
    expect(text).toContain('platform.something_new');
    expect(text).not.toContain('durable writes');
  });

  it('never renders a raw exception', () => {
    expect(recoveryErrorText(new TypeError('x is undefined at Object.<anonymous>'))).toBe(
      t('web.error'),
    );
  });
});

/*
 * The words must be TRUE for every path that emits the code, not only the obvious one.
 * Each case below names a server path the first wording contradicted (Codex review of #274).
 */
describe('what each failure sentence is allowed to claim', () => {
  const text = (code: string) => recoveryFailureText(code);

  it('migration_incompatible names every refused verdict and does not claim the archive is newer', () => {
    // AHEAD is cut over to (RECOVERY_CUTOVER_READY_VERDICTS); the refusals are NONE, DIVERGED
    // and a BEHIND this release could not migrate forward (recovery-executor.ts).
    const sentence = text('recovery.migration_incompatible');
    expect(sentence).toContain('هیچ سابقه‌ی مهاجرتی ندارد');
    expect(sentence).toContain('واگرا');
    expect(sentence).toContain('نتوانست آن را به‌روز کند');
    expect(sentence).not.toMatch(/نسخه‌ی جدیدتر/);
  });

  it('checksum_mismatch does not blame the transfer: decryption had already authenticated', () => {
    const sentence = text('recovery.checksum_mismatch');
    expect(sentence).not.toContain('انتقال');
    expect(sentence).toContain('فایل پشتیبان سالم دیگری');
    expect(sentence).toContain('گزارش سرور');
  });

  it('upload_rejected also covers an uploaded file the server no longer has', () => {
    const sentence = text('recovery.upload_rejected');
    expect(sentence).toContain('دیگر روی سرور پیدا نمی‌شود');
    expect(sentence).toContain('فضای ذخیره‌سازی سرور');
  });

  it('candidate_validation_failed names the operational causes, not only bad data', () => {
    const sentence = text('recovery.candidate_validation_failed');
    expect(sentence).toContain('اتصال یا دسترسی پایگاه‌داده');
    expect(sentence).toContain('مهاجرت‌های این نسخه');
    expect(sentence).toContain('کلیدهای این نصب');
    expect(sentence).toContain('گزارش سرور');
    expect(sentence).toContain('دست‌نخورده');
  });

  it('archive_malformed tells an older install how to read a newer format', () => {
    const sentence = text('recovery.archive_malformed');
    expect(sentence).toContain('قالبی تازه‌تر');
    expect(sentence).toContain('نسخه‌ای از نکسا را نصب کنید');
    expect(sentence).toContain('فایل پشتیبان سازگار دیگری');
  });
});

describe('recovery.refused', () => {
  const refusal = (details?: Record<string, unknown>) =>
    new ApiError(400, PLATFORM_ERROR_CODES.RECOVERY_REFUSED, 'refused in English', details);

  it('without a failure code (uploads disabled, before any row exists) promises no row', () => {
    const sentence = recoveryErrorText(refusal());
    expect(sentence).toContain('صفحه را تازه کنید');
    expect(sentence).toContain('اگر برای این درخواست ردیفی');
    expect(sentence).not.toMatch(/ثبت شده است/);
  });

  it('with the service’s failure code says that code’s words', () => {
    expect(recoveryErrorText(refusal({ failureCode: 'recovery.upload_rejected' }))).toBe(
      recoveryFailureText('recovery.upload_rejected'),
    );
    expect(recoveryErrorText(refusal({ failureCode: 'recovery.checksum_mismatch' }))).toBe(
      recoveryFailureText('recovery.checksum_mismatch'),
    );
  });

  it('with a failure code this build does not know falls back to the generic refusal', () => {
    expect(recoveryErrorText(refusal({ failureCode: 'recovery.from_the_future' }))).toBe(
      recoveryErrorText(refusal()),
    );
  });
});
