import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_USERNAME_MAX_LENGTH,
  normaliseProfileField,
  profileFactsFrom,
  referralCodeFor,
  providerUsernameFor,
  telegramUserIdSchema,
  failureOutcome,
  isMutatingOperation,
  debitIsWithinMeans,
  discountAmountMinor,
  clampDiscount,
  normaliseDiscountCode,
} from '@nexa/contracts';
import {
  intentOf,
  privateChatIdOf,
  replyFor,
} from '../../apps/api/src/surfaces/telegram/bot-runtime.js';
import { telegramUserIdOf } from '../../apps/api/src/surfaces/telegram/webhook.controller.js';

/**
 * The decisions a Telegram turn makes before any I/O.
 *
 * Every function here is pure and total, which is the reason they exist as functions at
 * all: a reply chosen inside a service could only be tested with a database and a fake
 * Telegram server, and the one branch nobody would write is the one that matters —
 * a blocked customer.
 */
describe('a Telegram turn, decided before any I/O', () => {
  it('reads /start, and keeps reading it when Telegram decorates it', () => {
    expect(intentOf({ message: { text: '/start' } })).toBe('START');
    // A deep link puts a payload after the command. 4F's referral codes arrive this way,
    // so the command must survive one.
    expect(intentOf({ message: { text: '/start ref_ABC123' } })).toBe('START');
    // In a group Telegram sends `/start@thebot`. The bot it names is the bot that got it.
    expect(intentOf({ message: { text: '/start@nexa_bot' } })).toBe('START');
    expect(intentOf({ message: { text: '  /START  ' } })).toBe('START');
  });

  it('treats anything else as unsupported rather than as an error', () => {
    expect(intentOf({ message: { text: 'hello' } })).toBe('UNSUPPORTED');
    expect(intentOf({ message: { text: '/startle' } })).toBe('UNSUPPORTED');
    expect(intentOf({ message: {} })).toBe('UNSUPPORTED');
    expect(intentOf({})).toBe('UNSUPPORTED');
    expect(intentOf(null)).toBe('UNSUPPORTED');
    // A photo with a caption is not a command. Reading `caption` as text would make
    // a caption able to drive the bot, which is how the legacy system's Persian
    // caption became an identifier.
    expect(intentOf({ message: { caption: '/start' } })).toBe('UNSUPPORTED');
  });

  it('replies only into a PRIVATE chat', () => {
    expect(privateChatIdOf({ message: { chat: { id: 777, type: 'private' } } })).toBe('777');
    // A group chat id would publish a customer's balance to everyone in the group.
    expect(privateChatIdOf({ message: { chat: { id: -100123, type: 'group' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { id: -100123, type: 'supergroup' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { id: 1, type: 'channel' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { type: 'private' } } })).toBeNull();
    expect(privateChatIdOf({})).toBeNull();
  });

  it('answers a BLOCKED customer with the block message whatever they asked for', () => {
    // The branch that would otherwise be forgotten. A blocked customer asking for
    // anything gets the same answer, because every other answer is a service they are
    // not entitled to.
    expect(replyFor('START', 'BLOCKED')).toBe('bot.blocked');
    expect(replyFor('UNSUPPORTED', 'BLOCKED')).toBe('bot.blocked');
  });

  it('greets a new customer differently from a returning one', () => {
    expect(replyFor('START', 'FIRST_SEEN')).toBe('bot.start.welcome');
    expect(replyFor('START', 'RETURNING')).toBe('bot.start.welcome_back');
    // The key Phase 1 already declared. A second key for the same sentence would be a
    // second string to keep in step.
    expect(replyFor('UNSUPPORTED', 'ACTIVE' as never)).toBe('bot.unknown_command');
    expect(replyFor('UNSUPPORTED', 'RETURNING')).toBe('bot.unknown_command');
  });

  it('takes the sender identity strictly, and refuses a bot as a customer', () => {
    expect(telegramUserIdOf({ message: { from: { id: 777001 } } })).toBe('777001');
    // A bot is not a customer: a row for one is a row no human can ever sign in to.
    expect(telegramUserIdOf({ message: { from: { id: 777001, is_bot: true } } })).toBeNull();
    // Identity is never coerced. A string id, a float, a negative and a zero are all
    // "not an id" rather than something to normalise, because a normalised guess at an
    // identity is a wrong row.
    expect(telegramUserIdOf({ message: { from: { id: '777001' } } })).toBeNull();
    expect(telegramUserIdOf({ message: { from: { id: 1.5 } } })).toBeNull();
    expect(telegramUserIdOf({ message: { from: { id: -1 } } })).toBeNull();
    expect(telegramUserIdOf({ message: { from: { id: 0 } } })).toBeNull();
    // A channel post carries no `from`, and inventing a customer for one would key a
    // row on an identity nobody has.
    expect(telegramUserIdOf({ message: {} })).toBeNull();
    expect(telegramUserIdOf(null)).toBeNull();
  });
});

describe('profile metadata, normalised before it is ever stored', () => {
  it('collapses empty and absent to the same null', () => {
    // Two representations of "absent" would mean every query had to know both.
    expect(normaliseProfileField('', 10)).toBeNull();
    expect(normaliseProfileField('   ', 10)).toBeNull();
    expect(normaliseProfileField(undefined, 10)).toBeNull();
    expect(normaliseProfileField(null, 10)).toBeNull();
    expect(normaliseProfileField(42, 10)).toBeNull();
  });

  it('truncates rather than refuses, because this arrives on a path that must answer 200', () => {
    const long = 'ف'.repeat(300);
    expect(normaliseProfileField(long, CUSTOMER_NAME_MAX_LENGTH)).toHaveLength(
      CUSTOMER_NAME_MAX_LENGTH,
    );
    // Refusing would turn a long display name into an update Telegram redelivers for
    // ever.
    expect(normaliseProfileField(long, CUSTOMER_USERNAME_MAX_LENGTH)).toHaveLength(
      CUSTOMER_USERNAME_MAX_LENGTH,
    );
  });

  it('reads a Telegram `from` totally, never throwing', () => {
    expect(profileFactsFrom({ username: ' nexa ', first_name: 'A', language_code: 'fa' })).toEqual({
      username: 'nexa',
      firstName: 'A',
      lastName: null,
      languageCode: 'fa',
    });
    expect(profileFactsFrom(undefined)).toEqual({
      username: null,
      firstName: null,
      lastName: null,
      languageCode: null,
    });
    expect(profileFactsFrom('not an object')).toEqual({
      username: null,
      firstName: null,
      lastName: null,
      languageCode: null,
    });
  });

  it('refuses a Telegram id that is not one, because identity is not normalised', () => {
    expect(telegramUserIdSchema.safeParse('777001').success).toBe(true);
    expect(telegramUserIdSchema.safeParse('0').success).toBe(false);
    expect(telegramUserIdSchema.safeParse('0777').success).toBe(false);
    expect(telegramUserIdSchema.safeParse('-1').success).toBe(false);
    expect(telegramUserIdSchema.safeParse('77 001').success).toBe(false);
    expect(telegramUserIdSchema.safeParse('').success).toBe(false);
  });
});

describe('the derivations Phase 4 depends on being stable', () => {
  it('derives a provider username from the service id, the same way every time', () => {
    // This is what makes adoption after an unknown outcome possible: a reconcile can ask
    // the provider for this exact name. A random name would leave only a blind create.
    const id = '01900000-0000-7000-8000-0000000000c1';
    expect(providerUsernameFor(id)).toBe('nx019000000000700080000000000000c1');
    expect(providerUsernameFor(id)).toBe(providerUsernameFor(id));
    // No customer text enters it. A username built from a display name would carry
    // Persian characters, emoji and somebody's real name onto a third party's panel.
    expect(providerUsernameFor(id)).toMatch(/^nx[0-9a-f]{32}$/);
    expect(() => providerUsernameFor('not-a-uuid')).toThrow();
  });

  it('derives a referral code from the LAST 64 bits, so same-millisecond joiners differ', () => {
    // A UUIDv7 leads with a timestamp. Codes derived from the front would share a prefix
    // for everyone who joined the same millisecond, and look to a customer as though they
    // had been given somebody else's code.
    const a = referralCodeFor('01900000-0000-7000-8000-00000000000a');
    const b = referralCodeFor('01900000-0000-7000-8000-00000000000b');
    expect(a).not.toBe(b);
    expect(a).toHaveLength(8);
    // No ambiguous glyphs: this string is retyped by humans out of a chat.
    expect(a).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(referralCodeFor('01900000-0000-7000-8000-00000000000a')).toBe(a);
  });
});

describe('the financial rules, as integer arithmetic', () => {
  it('never uses a float, and rounds a percentage in the customer’s favour', () => {
    // 33% of 1000 is 330; of 1001 it is 330.33, truncated to 330. Rounding up would add a
    // unit of a tenant's revenue on every order.
    expect(discountAmountMinor('PERCENTAGE', 1000n, 33n)).toBe(330n);
    expect(discountAmountMinor('PERCENTAGE', 1001n, 33n)).toBe(330n);
    expect(discountAmountMinor('PERCENTAGE', 1000n, 100n)).toBe(1000n);
    expect(discountAmountMinor('FIXED_AMOUNT', 1000n, 250n)).toBe(250n);
    expect(discountAmountMinor('PERCENTAGE', 0n, 50n)).toBe(0n);
    expect(discountAmountMinor('PERCENTAGE', 1000n, 0n)).toBe(0n);
  });

  it('clamps a discount to the subtotal, so a promo code cannot mint a credit', () => {
    expect(clampDiscount(1000n, 1500n)).toBe(1000n);
    expect(clampDiscount(1000n, 400n)).toBe(400n);
    expect(clampDiscount(1000n, -5n)).toBe(0n);
  });

  it('refuses an overdraft unless a credit limit was configured, and zero is the default', () => {
    // The owner's rule: a credit feature defaults to NO credit.
    expect(debitIsWithinMeans(1000n, 1000n, 0n)).toBe(true);
    expect(debitIsWithinMeans(1000n, 1001n, 0n)).toBe(false);
    // A limit is an allowance BELOW zero, stored positive, so no comparison is a double
    // negative.
    expect(debitIsWithinMeans(0n, 500n, 500n)).toBe(true);
    expect(debitIsWithinMeans(0n, 501n, 500n)).toBe(false);
    // A negative limit is treated as none rather than as unlimited credit.
    expect(debitIsWithinMeans(0n, 1n, -100n)).toBe(false);
    // A zero or negative debit is not a debit.
    expect(debitIsWithinMeans(1000n, 0n, 0n)).toBe(false);
  });

  it('normalises a discount code so case cannot split a redemption counter', () => {
    expect(normaliseDiscountCode(' summer ')).toBe('SUMMER');
    expect(normaliseDiscountCode('SuMmEr')).toBe('SUMMER');
  });
});

describe('a provider failure is classified by what it means, not how it feels', () => {
  it('calls a TIMEOUT on a mutation UNKNOWN, not failed', () => {
    // The one that costs a customer a duplicate account if it is classified by feel: a
    // timed-out create may have been received and processed.
    expect(failureOutcome('TIMEOUT', true)).toBe('UNKNOWN');
    expect(failureOutcome('PROVIDER_ERROR', true)).toBe('UNKNOWN');
  });

  it('calls a failure that certainly never arrived FAILED, so it is safe to replay', () => {
    expect(failureOutcome('UNREACHABLE', true)).toBe('FAILED');
    expect(failureOutcome('TLS_FAILED', true)).toBe('FAILED');
    expect(failureOutcome('BLOCKED_TARGET', true)).toBe('FAILED');
    expect(failureOutcome('AUTHENTICATION_FAILED', true)).toBe('FAILED');
    expect(failureOutcome('AUTHENTICATION_REQUIRES_INTERACTION', true)).toBe('FAILED');
    // The panel said explicitly that it did not process this one.
    expect(failureOutcome('RATE_LIMITED', true)).toBe('FAILED');
  });

  it('calls every READ failure FAILED, because a read that did not answer changed nothing', () => {
    expect(failureOutcome('TIMEOUT', false)).toBe('FAILED');
    expect(failureOutcome('PROVIDER_ERROR', false)).toBe('FAILED');
    expect(isMutatingOperation('SYNC_USAGE')).toBe(false);
    expect(isMutatingOperation('RECONCILE')).toBe(false);
    expect(isMutatingOperation('PROVISION')).toBe(true);
    expect(isMutatingOperation('TERMINATE')).toBe(true);
  });
});
