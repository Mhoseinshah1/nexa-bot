import { describe, expect, it } from 'vitest';
import {
  referralCodeFor,
  referralStartPayload,
  referralStartPayloadForTelegramId,
  referralTargetFromStartPayload,
} from '@nexa/contracts';

/**
 * B7: the three shapes a `/start` payload can name a referrer by — the numeric-id link,
 * the old eight-character code, and MirzaBot's bare numeric id — and everything else is
 * no referral at all.
 */
describe('B7 — the referral start payload', () => {
  it('builds the link from the numeric Telegram user id', () => {
    expect(referralStartPayloadForTelegramId('910910')).toBe('ref-910910');
    expect(referralStartPayloadForTelegramId('7123456789')).toBe('ref-7123456789');
    for (const bad of ['', '0123', '12a4', '-5', '12345678901234567', ' 910910']) {
      expect(() => referralStartPayloadForTelegramId(bad), bad).toThrow();
    }
  });

  it('reads ref-<telegram id> as a Telegram id', () => {
    expect(referralTargetFromStartPayload('ref-7123456789')).toEqual({
      code: null,
      telegramUserId: '7123456789',
    });
    expect(referralTargetFromStartPayload('REF-910910')).toEqual({
      code: null,
      telegramUserId: '910910',
    });
  });

  it('keeps reading the old ref-<CODE> links, in any case', () => {
    const code = referralCodeFor('0192f1d2-3c4b-7a5e-8f60-123456789abc');
    expect(referralTargetFromStartPayload(referralStartPayload(code))).toEqual({
      code,
      telegramUserId: null,
    });
    expect(referralTargetFromStartPayload(`ref-${code.toLowerCase()}`)).toEqual({
      code,
      telegramUserId: null,
    });
  });

  it('reads MirzaBot’s bare numeric payload as a Telegram id', () => {
    expect(referralTargetFromStartPayload('5150123')).toEqual({
      code: null,
      telegramUserId: '5150123',
    });
  });

  it('gives an eight-digit ref- payload both readings, the code first', () => {
    expect(referralTargetFromStartPayload('ref-12345678')).toEqual({
      code: '12345678',
      telegramUserId: '12345678',
    });
  });

  it('is no referral for anything else', () => {
    for (const payload of [
      'promo',
      'ref-',
      'ref-ABC',
      'ref-0123',
      'ref-12a45678x',
      '0123',
      '12345678901234567',
      'ref-12345678901234567',
      'refx910910',
      'ref_910910',
    ]) {
      expect(referralTargetFromStartPayload(payload), payload).toBeNull();
    }
  });
});
