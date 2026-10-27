import { describe, expect, it } from 'vitest';
import { COMMERCE_ERROR_CODES, errors, maskPhoneNumber } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { intentOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { sharedContactOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';
import {
  PHONE_VERIFY_CALLBACK_DATA,
  PHONE_VERIFY_CANCEL_COMMAND,
} from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { refusal } from '../../apps/api/src/surfaces/telegram/runtime/refusals';
import { normaliseContactPhone } from '../../apps/api/src/modules/commerce/customers/application/phone-verification.service';
import {
  replyKeyboardButtonMarkup,
  textMessageBody,
} from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * R11 B7: the pure halves of phone verification — what the surface reads out of a contact
 * message (and the forwarded marks it must not miss), how a Telegram number becomes E.164,
 * how the three phone intents are routed, the contact button's markup, and the refusal
 * that carries the verify button. The rule itself (own number only) is decided against the
 * database in `tests/integration/r11-b7-phone-verification.test.ts`.
 */
describe('R11 B7 — reading a shared contact', () => {
  const message = (extra: Record<string, unknown>) => ({
    message_id: 1,
    from: { id: 42 },
    contact: { phone_number: '989121234567', first_name: 'زهرا', user_id: 42 },
    ...extra,
  });

  it('reads the number and the account it names, as a decimal string', () => {
    expect(sharedContactOf(message({}))).toEqual({
      phoneNumber: '989121234567',
      userId: '42',
      forwarded: false,
    });
  });

  it('marks EVERY forwarded form, the current and the legacy fields alike', () => {
    for (const mark of [
      { forward_origin: { type: 'user', date: 0 } },
      { forward_from: { id: 42 } },
      { forward_from_chat: { id: -100 } },
      { forward_sender_name: 'Someone' },
      { forward_date: 1 },
    ]) {
      expect(sharedContactOf(message(mark))?.forwarded, JSON.stringify(mark)).toBe(true);
    }
  });

  it('carries no account for a contact without one, or with an unsafe id', () => {
    expect(
      sharedContactOf({ contact: { phone_number: '989121234567', first_name: 'x' } })?.userId,
    ).toBeNull();
    expect(
      sharedContactOf({
        contact: { phone_number: '989121234567', user_id: Number.MAX_SAFE_INTEGER + 2 },
      })?.userId,
    ).toBeNull();
  });

  it('is not a contact without a number, and not one at all for a text message', () => {
    expect(sharedContactOf({ contact: { first_name: 'x', user_id: 42 } })).toBeNull();
    expect(sharedContactOf({ text: 'سلام' })).toBeNull();
  });

  it('routes a contact message to PHONE_CONTACT, ahead of every other message shape', () => {
    const command = intentOf({ message: message({}) });
    expect(command.intent).toBe('PHONE_CONTACT');
    expect(command.contact).toEqual({
      phoneNumber: '989121234567',
      userId: '42',
      forwarded: false,
    });
  });

  it('routes the verify button and the cancel label', () => {
    expect(intentOf({ callback_query: { id: 'q', data: PHONE_VERIFY_CALLBACK_DATA } }).intent).toBe(
      'PHONE_VERIFY',
    );
    // The label arrives as TEXT and is translated by the shared label map, as the panel's is.
    const menu = new Map([
      [CATALOGUE_FA['bot.phone.cancel_button'], `/${PHONE_VERIFY_CANCEL_COMMAND}`],
    ]);
    expect(
      intentOf({ message: { text: CATALOGUE_FA['bot.phone.cancel_button'] } }, menu).intent,
    ).toBe('PHONE_VERIFY_CANCEL');
  });
});

describe('R11 B7 — a Telegram number as E.164', () => {
  it('reads Telegram’s digits-only international form as international', () => {
    expect(normaliseContactPhone('989121234567')).toBe('+989121234567');
    expect(normaliseContactPhone('+989121234567')).toBe('+989121234567');
    expect(normaliseContactPhone('+98 912 123 4567')).toBe('+989121234567');
    expect(normaliseContactPhone('15551234567')).toBe('+15551234567');
  });

  it('refuses what is not a storable number rather than guessing', () => {
    expect(normaliseContactPhone('09121234567')).toBeNull();
    expect(normaliseContactPhone('12')).toBeNull();
    expect(normaliseContactPhone('not a number')).toBeNull();
  });

  it('masks to the last four digits', () => {
    expect(maskPhoneNumber('+989121234567')).toBe('…4567');
  });
});

describe('R11 B7 — the contact keyboard and the refusal', () => {
  it('puts request_contact on the wire only for the contact button', () => {
    expect(replyKeyboardButtonMarkup({ text: 'a', requestContact: true })).toEqual({
      text: 'a',
      request_contact: true,
    });
    expect(replyKeyboardButtonMarkup({ text: 'a' })).toEqual({ text: 'a' });
    const body = textMessageBody({
      chatId: '1',
      text: 't',
      html: false,
      keyboard: [[{ text: 'share', requestContact: true }], [{ text: 'cancel' }]],
    });
    expect(body['reply_markup']).toMatchObject({
      keyboard: [[{ text: 'share', request_contact: true }], [{ text: 'cancel' }]],
    });
  });

  it('answers PHONE_VERIFICATION_REQUIRED with its Persian sentence and the verify button', () => {
    const reply = refusal(
      errors.conflict(COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED, 'phone required'),
    );
    expect(reply.key).toBe('bot.payment.phone_required');
    expect(reply.buttons).toHaveLength(1);
    expect(reply.buttons[0]).toMatchObject({ data: PHONE_VERIFY_CALLBACK_DATA });
    // Every other refusal still carries no button.
    expect(
      refusal(errors.conflict(COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED, 'not offered')).buttons,
    ).toEqual([]);
  });
});
