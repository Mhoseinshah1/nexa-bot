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
