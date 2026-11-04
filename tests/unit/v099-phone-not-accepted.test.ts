import { describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  phoneGateOf,
  type PhoneGateState,
} from '../../apps/api/src/modules/commerce/customers/application/phone-verification.service';
import {
  notAcceptedPhoneCounts,
  phoneRuleRefuses,
  phoneStandingOf,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-eligibility';
import {
  phoneGatewayRequiredReply,
  phoneNotAcceptedReply,
  refusedForNotAcceptedNumber,
} from '../../apps/api/src/surfaces/telegram/runtime/phone-verify-flow';

/**
 * NEXA v099 (owner) — the pure halves of a number stored as NOT accepted (IRAN_ONLY, not
 * +98): the gate's decision table, the one predicate the gate and the route rule share, and
 * the reply that replaces «📞 Share Contact». End to end: `tests/integration/v099-phone-not-accepted.test.ts`.
 *
 * Mutation-checked: `notAcceptedPhoneCounts` made true for IRAN_ONLY -> the two tables here
 * go red.
 */

const AT = new Date('2026-11-04T10:00:00.000Z');

describe('the bot-wide gate (phoneGateOf)', () => {
  it('decides switch × verified × exempt × not accepted × allowed numbers', () => {
    const table: [
      boolean,
      Date | null,
      Date | null,
      Date | null,
      'ALL' | 'IRAN_ONLY',
      PhoneGateState,
    ][] = [
      // switch off: nobody is held
      [false, null, null, null, 'IRAN_ONLY', 'OPEN'],
      [false, null, null, AT, 'IRAN_ONLY', 'OPEN'],
      // no number: asked for one, whatever the setting
      [true, null, null, null, 'IRAN_ONLY', 'REQUIRED'],
      [true, null, null, null, 'ALL', 'REQUIRED'],
      // a number stored as not accepted: told so under IRAN_ONLY, verified under ALL
      [true, null, null, AT, 'IRAN_ONLY', 'NOT_ACCEPTED'],
      [true, null, null, AT, 'ALL', 'OPEN'],
      // an exemption opens everything
      [true, null, AT, AT, 'IRAN_ONLY', 'OPEN'],
      // a verified number opens everything
      [true, AT, null, null, 'IRAN_ONLY', 'OPEN'],
    ];
    for (const [
      enabled,
      phoneVerifiedAt,
      phoneVerificationExemptAt,
      phoneNotAcceptedAt,
      allowed,
      want,
    ] of table) {
      expect(
        phoneGateOf(
          { phoneVerifiedAt, phoneVerificationExemptAt, phoneNotAcceptedAt },
          enabled,
          allowed,
        ),
        JSON.stringify({
          enabled,
          phoneVerifiedAt,
          phoneVerificationExemptAt,
          phoneNotAcceptedAt,
          allowed,
        }),
      ).toBe(want);
    }
  });
});

describe('the route rule', () => {
  it('a not-accepted number is UNVERIFIED under IRAN_ONLY and VERIFIED under ALL', () => {
    const rule = { requiresVerifiedPhone: true };
    expect(notAcceptedPhoneCounts('IRAN_ONLY')).toBe(false);
    expect(notAcceptedPhoneCounts('ALL')).toBe(true);
    expect(
      phoneRuleRefuses(rule, phoneStandingOf(notAcceptedPhoneCounts('IRAN_ONLY'), false)),
    ).toBe(true);
    expect(phoneRuleRefuses(rule, phoneStandingOf(notAcceptedPhoneCounts('ALL'), false))).toBe(
      false,
    );
    // The exemption wins, as for every customer.
    expect(phoneRuleRefuses(rule, phoneStandingOf(false, true))).toBe(false);
  });
});

describe('the reply', () => {
  it('is the owner’s sentence with the main menu keyboard: no contact button, nothing held', () => {
    expect(CATALOGUE_FA['bot.phone.not_accepted']).toBe(
      'فقط شماره‌های ایران (+98) اجازهٔ استفاده از ربات را دارند. اگر فکر می‌کنید اشتباه شده، با پشتیبانی در تماس باشید.',
    );
    const reply = phoneNotAcceptedReply('MAIN_MENU');
    expect(reply).toMatchObject({ key: 'bot.phone.not_accepted', keyboard: 'MAIN_MENU' });
    expect(reply.phoneHold).toBeUndefined();
  });

  it('replaces a route’s contact request only for a number stored as not accepted', () => {
    const gateway = phoneGatewayRequiredReply();
    expect(
      refusedForNotAcceptedNumber(gateway, { phoneVerifiedAt: null, phoneNotAcceptedAt: AT }),
    ).toBe(true);
    expect(
      refusedForNotAcceptedNumber(gateway, { phoneVerifiedAt: null, phoneNotAcceptedAt: null }),
    ).toBe(false);
    expect(
      refusedForNotAcceptedNumber(phoneNotAcceptedReply('MAIN_MENU'), {
        phoneVerifiedAt: null,
        phoneNotAcceptedAt: AT,
      }),
    ).toBe(false);
  });
});
