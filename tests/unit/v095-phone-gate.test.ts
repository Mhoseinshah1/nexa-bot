import { describe, expect, it } from 'vitest';
import type { BotInstanceId, CorrelationId, TenantContext, UserId } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  isIranianPhoneNumber,
  normaliseContactPhone,
  phoneGateHolds,
} from '../../apps/api/src/modules/commerce/customers/application/phone-verification.service';
import type { CustomerRecord } from '../../apps/api/src/modules/commerce/customers/application/ports';
import {
  lateCreditReference,
  recordedChargeApproves,
} from '../../apps/api/src/modules/commerce/payments/domain/late-credit';
import { MiniAppSessionService } from '../../apps/api/src/modules/commerce/miniapp/application/miniapp-session.service';
import {
  PHONE_GATE_EXEMPT_INTENTS,
  phoneGatewayRequiredReply,
  phoneRequiredReply,
  phoneResumeOf,
  resumable,
  resumedUpdate,
} from '../../apps/api/src/surfaces/telegram/runtime/phone-verify-flow';
import {
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  PHONE_OTHER_GATEWAY_COMMAND,
  PHONE_VERIFY_START_PAYLOAD,
  START_CAPTCHA_CALLBACK_PREFIX,
  TOPUP_ROUTE_CALLBACK_PREFIX,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { intentOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';

/**
 * NEXA v095 PR-4 — the pure halves of the phone gate: who the bot-wide gate holds, which
 * numbers B accepts, what a held action is remembered as (and never as), the replies the two
 * gates draw, and the mini app's gate table (A after the terms, the channel exemption, the
 * phone exemption) against fakes. The end-to-end behaviour, with PostgreSQL, is
 * `tests/integration/v095-phone-gate.test.ts`.
 */

const CAPTURE = '01900000-0000-7000-8000-0000000000c1';
const ORDER = '01900000-0000-7000-8000-0000000000d1';
const AT = new Date('2026-11-03T10:00:00.000Z');

describe('A — who the bot-wide gate holds (with the switch on)', () => {
  it('holds only a customer with neither a verified number nor an exemption', () => {
    const table: [Date | null, Date | null, boolean][] = [
      [null, null, true],
      [AT, null, false],
      [null, AT, false],
      [AT, AT, false],
    ];
    for (const [phoneVerifiedAt, phoneVerificationExemptAt, holds] of table) {
      expect(phoneGateHolds({ phoneVerifiedAt, phoneVerificationExemptAt })).toBe(holds);
    }
  });

  it('never holds the verification’s own steps or the promotional opt-out/in', () => {
    for (const intent of ['PHONE_VERIFY', 'PHONE_CONTACT', 'MARKETING_OPT_OUT', 'MARKETING_OPT_IN'])
      expect(PHONE_GATE_EXEMPT_INTENTS.has(intent as never)).toBe(true);
    for (const intent of ['START', 'MAIN_MENU', 'SUPPORT', 'HELP', 'WALLET', 'CATALOG', 'ORDER'])
      expect(PHONE_GATE_EXEMPT_INTENTS.has(intent as never)).toBe(false);
  });

  it('draws the contact button ALONE on the mandatory screen, and remembers what it held', () => {
    const reply = phoneRequiredReply();
    expect(reply).toMatchObject({
      key: 'bot.phone.required',
      keyboard: 'PHONE_REQUIRED',
      phoneHold: true,
      buttons: [],
    });
    expect(CATALOGUE_FA['bot.phone.required']).toContain('📞 Share Contact');
    expect(CATALOGUE_FA['bot.phone.share_button']).toBe('📞 Share Contact');
  });
});

describe('B — the allowed numbers, normalised first', () => {
  it('reads +98, 98 and 0098 as Iranian, and nothing else', () => {
    for (const raw of ['+989121234567', '989121234567', '00989121234567', '+98 912 123 4567']) {
      const phone = normaliseContactPhone(raw);
      expect(phone, raw).toBe('+989121234567');
      expect(isIranianPhoneNumber(phone as string), raw).toBe(true);
    }
    for (const raw of ['+15551234567', '447700900123', '0049301234567', '+9989012345678']) {
      const phone = normaliseContactPhone(raw);
      expect(phone, raw).not.toBeNull();
      expect(isIranianPhoneNumber(phone as string), raw).toBe(false);
    }
  });

  it('refuses with a sentence that says only Iranian numbers are accepted', () => {
    expect(CATALOGUE_FA['bot.phone.iran_only']).toContain('+98');
  });
});

describe('C — the gateway step and what it remembers', () => {
  it('answers with the gateway sentence over «📞 Share Contact» / «↩️ انتخاب درگاه دیگر»', () => {
    expect(phoneGatewayRequiredReply()).toMatchObject({
      key: 'bot.phone.gateway_required',
      keyboard: 'PHONE_REQUEST_GATEWAY',
      phoneHold: true,
    });
    expect(CATALOGUE_FA['bot.phone.other_gateway_button']).toBe('↩️ انتخاب درگاه دیگر');
    const menu = new Map([
      [CATALOGUE_FA['bot.phone.other_gateway_button'], `/${PHONE_OTHER_GATEWAY_COMMAND}`],
    ]);
    expect(
      intentOf({ message: { text: CATALOGUE_FA['bot.phone.other_gateway_button'] } }, menu).intent,
    ).toBe('PHONE_OTHER_GATEWAY');
  });

  it('remembers the tapped route button exactly, and re-reads it as the same command', () => {
    const data = `${TOPUP_ROUTE_CALLBACK_PREFIX}${CAPTURE}.TONPAYS`;
    const update = { callback_query: { id: 'q', data } };
    const command = intentOf(update);
    expect(command.intent).toBe('TOPUP_ROUTE');
    const resume = phoneResumeOf(update, command);
    expect(resume).toBe(`c:${data}`);
    const again = intentOf(resumedUpdate(resume as string));
    expect(again).toMatchObject({
      intent: 'TOPUP_ROUTE',
      targetId: CAPTURE,
      secondaryId: 'TONPAYS',
    });
    expect(resumable(again)).toBe(true);
  });

  it('remembers a typed command or a deep link as typed', () => {
    const update = { message: { text: '/start ref-abc' } };
    expect(phoneResumeOf(update, intentOf(update))).toBe('t:/start ref-abc');
  });

  it('never remembers free text, a gate’s own step, or a tap it did not act on', () => {
    // A typed amount or username answers a window the customer may no longer have.
    const text = { message: { text: '250000' } };
    expect(intentOf(text).intent).toBe('USERNAME_TEXT');
    expect(phoneResumeOf(text, intentOf(text))).toBeNull();
    // The captcha's right answer continues as `/start`: `/start` is what resumes, never `hc:`.
    const captcha = { callback_query: { id: 'q', data: `${START_CAPTCHA_CALLBACK_PREFIX}x:1` } };
    expect(phoneResumeOf(captcha, { intent: 'START', targetId: null, callbackQueryId: null })).toBe(
      't:/start',
    );
    // The verification's own steps.
    for (const intent of ['PHONE_VERIFY', 'PHONE_CONTACT', 'PHONE_OTHER_GATEWAY'] as const) {
      expect(phoneResumeOf(text, { intent, targetId: null, callbackQueryId: null })).toBeNull();
    }
    expect(resumedUpdate('x:nothing')).toBeNull();
    expect(resumedUpdate('c:')).toBeNull();
  });

  it('opens the contact prompt from the mini app’s fallback link', () => {
    expect(intentOf({ message: { text: `/start ${PHONE_VERIFY_START_PAYLOAD}` } }).intent).toBe(
      'PHONE_VERIFY',
    );
    expect(intentOf({ message: { text: `/start ${PHONE_VERIFY_START_PAYLOAD}` } }).intent).not.toBe(
      'START',
    );
  });

  it('keeps an order route tap resumable too', () => {
    const data = `${GATEWAY_ROUTE_PAY_CALLBACK_PREFIX}${ORDER}.TONPAYS`;
    const update = { callback_query: { id: 'q', data } };
    const command = intentOf(update);
    expect(command).toMatchObject({ intent: 'PAY_GATEWAY', targetId: ORDER });
    expect(phoneResumeOf(update, command)).toBe(`c:${data}`);
  });
});

// ---------------------------------------------------------------------------------------
// The mini app's gate table, against fakes
// ---------------------------------------------------------------------------------------

const scope = {
  tenantId: '01900000-0000-7000-8000-0000000000a1',
  botInstanceId: null,
} as unknown as TenantContext;

function customer(over: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: '01900000-0000-7000-8000-0000000000e1' as UserId,
    telegramUserId: '42',
    status: 'ACTIVE',
    channelMembershipExemptAt: null,
    phoneVerificationExemptAt: null,
    phoneVerifiedAt: null,
    ...over,
  } as unknown as CustomerRecord;
}

function sessions(options: {
  readonly phoneOn: boolean;
  readonly missingChannels?: boolean;
  readonly terms?: boolean;
  readonly admin?: boolean;
}) {
  return new MiniAppSessionService({
    membership: {
      missingRequired: async () =>
        options.missingChannels === true ? [{ id: '-100', handle: '@nexa', mandatory: true }] : [],
    },
    terms: {
      requirement: async () =>
        options.terms === true ? { id: 't1', title: 'قوانین', body: 'متن' } : null,
    },
    telegramAdmins: {
      resolve: async () => (options.admin === true ? ({ id: 'a' } as never) : null),
    },
    phoneGate: { enabled: async () => options.phoneOn },
  } as never);
}

const gate = (service: MiniAppSessionService, record: CustomerRecord) =>
  service.gateFor(
    {
      scope,
      botInstanceId: 'bot' as BotInstanceId,
      sessionId: 's',
      customer: record,
      telegramUserId: '42',
    },
    'c' as CorrelationId,
  );

describe('the mini app’s gates (A, D)', () => {
  it('holds at PHONE exactly when the switch is on and the customer is neither verified nor exempt', async () => {
    for (const phoneOn of [false, true]) {
      for (const verified of [false, true]) {
        for (const exempt of [false, true]) {
          const held = await gate(
            sessions({ phoneOn }),
            customer({
              phoneVerifiedAt: verified ? AT : null,
              phoneVerificationExemptAt: exempt ? AT : null,
            }),
          );
          const expected = phoneOn && !verified && !exempt ? { kind: 'PHONE' } : null;
          expect(held, JSON.stringify({ phoneOn, verified, exempt })).toEqual(expected);
        }
      }
    }
  });

  it('asks the terms BEFORE the phone, and never holds a bound administrator at the phone', async () => {
    expect(await gate(sessions({ phoneOn: true, terms: true }), customer())).toMatchObject({
      kind: 'TERMS',
    });
    expect(await gate(sessions({ phoneOn: true, admin: true }), customer())).toBeNull();
  });

  it('lets a channel-EXEMPT customer past the join check, and holds the others at it', async () => {
    const service = sessions({ phoneOn: false, missingChannels: true });
    expect(await gate(service, customer())).toMatchObject({ kind: 'CHANNELS' });
    expect(await gate(service, customer({ channelMembershipExemptAt: AT }))).toBeNull();
  });
});

describe('G — a late Stars charge: the recorded charge is the approval', () => {
  it('approves only a recorded, still-paid successful payment', () => {
    const charge = {
      providerChargeId: 'stxCharge1',
      providerPaid: true,
      providerStatus: 'successful_payment',
    };
    expect(recordedChargeApproves(charge)).toBe(true);
    expect(recordedChargeApproves({ ...charge, providerChargeId: null })).toBe(false);
    // Telegram reported it refunded (R12 F1 item 6): `provider_paid` was cleared.
    expect(recordedChargeApproves({ ...charge, providerPaid: false })).toBe(false);
    expect(recordedChargeApproves({ ...charge, providerPaid: null })).toBe(false);
    expect(recordedChargeApproves({ ...charge, providerStatus: 'refunded_payment' })).toBe(false);
  });

  it('credits through the one late-credit reference, so a payment is credited at most once', () => {
    expect(lateCreditReference('p-1')).toBe('p-1:late-credit');
  });
});
