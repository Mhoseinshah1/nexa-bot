import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ARRIVALS,
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_USERNAME_MAX_LENGTH,
  normaliseProfileField,
  profileFactsFrom,
  referralCodeFor,
  providerUsernameFor,
  customerListQuerySchema,
  telegramUserIdSchema,
  type TemplateKey,
  failureOutcome,
  isMutatingOperation,
  debitIsWithinMeans,
  discountAmountMinor,
  clampDiscount,
  normaliseDiscountCode,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  BOT_INTENTS,
  CONFIRM_CALLBACK_PREFIX,
  GATEWAY_PAY_CALLBACK_PREFIX,
  intentOf,
  MANUAL_PAY_CALLBACK_PREFIX,
  ORDER_CALLBACK_PREFIX,
  privateChatIdOf,
  replyFor,
  SERVICE_CALLBACK_PREFIX,
  SERVICE_RESEND_CALLBACK_PREFIX,
  SERVICE_RESUME_CALLBACK_PREFIX,
  SERVICE_SUSPEND_CALLBACK_PREFIX,
  SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
  SERVICE_TERMINATE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  encodeIdPair,
  WALLET_PAY_CALLBACK_PREFIX,
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
    expect(intentOf({ message: { text: '/start' } }).intent).toBe('START');
    // A deep link puts a payload after the command. 4F's referral codes arrive this way,
    // so the command must survive one.
    expect(intentOf({ message: { text: '/start ref_ABC123' } }).intent).toBe('START');
    // In a group Telegram sends `/start@thebot`. The bot it names is the bot that got it.
    expect(intentOf({ message: { text: '/start@nexa_bot' } }).intent).toBe('START');
    expect(intentOf({ message: { text: '  /START  ' } }).intent).toBe('START');
  });

  it('reads /catalog the same way, and carries no target for it', () => {
    expect(intentOf({ message: { text: '/catalog' } })).toEqual({
      intent: 'CATALOG',
      targetId: null,
      callbackQueryId: null,
    });
    expect(intentOf({ message: { text: '/catalog@nexa_bot' } }).intent).toBe('CATALOG');
  });

  it('reads a tapped button, and VALIDATES the id it carries', () => {
    const product = '01900000-0000-7000-8000-0000000000a1';
    expect(intentOf({ callback_query: { id: 'q1', data: `p:${product}` } })).toEqual({
      intent: 'ORDER',
      targetId: product,
      callbackQueryId: 'q1',
    });
    expect(intentOf({ callback_query: { id: 'q2', data: `c:${product}` } })).toEqual({
      intent: 'CONFIRM',
      targetId: product,
      callbackQueryId: 'q2',
    });

    /*
     * `callback_data` is CLIENT-SUPPLIED text and Telegram signs nothing about it, so a
     * modified client can put anything after the prefix. Every one of these becomes
     * UNSUPPORTED — which answers the customer — rather than reaching a service that
     * would cast it into a `uuid` column and answer 500.
     *
     * The callback id SURVIVES the refusal, because the button is still spinning and
     * still has to be stopped.
     */
    for (const data of [
      'p:not-a-uuid',
      'p:',
      `p:${product}; DROP TABLE orders`,
      // A v4 UUID is not a v7 one. Every id this system mints is v7, so accepting
      // another version would be accepting an id this installation cannot have issued.
      'p:9f1b7c2e-4d3a-4b7e-8c1f-2a3b4c5d6e7f',
      'x:whatever',
      '',
    ]) {
      expect(intentOf({ callback_query: { id: 'q3', data } }), data).toEqual({
        intent: 'UNSUPPORTED',
        targetId: null,
        callbackQueryId: 'q3',
      });
    }
  });

  it('treats anything else as unsupported rather than as an error', () => {
    expect(intentOf({ message: { text: 'hello' } }).intent).toBe('UNSUPPORTED');
    expect(intentOf({ message: { text: '/startle' } }).intent).toBe('UNSUPPORTED');
    expect(intentOf({ message: {} }).intent).toBe('UNSUPPORTED');
    expect(intentOf({}).intent).toBe('UNSUPPORTED');
    expect(intentOf(null).intent).toBe('UNSUPPORTED');
    // A photo with a caption is not a command. Reading `caption` as text would make
    // a caption able to drive the bot, which is how the legacy system's Persian
    // caption became an identifier.
    expect(intentOf({ message: { caption: '/start' } }).intent).toBe('UNSUPPORTED');
  });

  it('replies only into a PRIVATE chat', () => {
    expect(privateChatIdOf({ message: { chat: { id: 777, type: 'private' } } })).toBe('777');
    // A group chat id would publish a customer's balance to everyone in the group.
    expect(privateChatIdOf({ message: { chat: { id: -100123, type: 'group' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { id: -100123, type: 'supergroup' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { id: 1, type: 'channel' } } })).toBeNull();
    expect(privateChatIdOf({ message: { chat: { type: 'private' } } })).toBeNull();
    expect(privateChatIdOf({})).toBeNull();

    // A tapped button carries the message it was attached to, and that message carries
    // the chat. Without this a customer who pressed Order would be answered NOWHERE,
    // silently — the invisible failure this codebase exists to remove.
    expect(
      privateChatIdOf({ callback_query: { message: { chat: { id: 777, type: 'private' } } } }),
    ).toBe('777');
    expect(
      privateChatIdOf({ callback_query: { message: { chat: { id: -100123, type: 'group' } } } }),
    ).toBeNull();
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

    /*
     * On a tapped button the human is `callback_query.from`, NOT
     * `callback_query.message.from` — that second one is the BOT that sent the message
     * the button hangs off. Reading it would resolve a customer row for the bot on every
     * single tap.
     */
    expect(telegramUserIdOf({ callback_query: { from: { id: 777002 } } })).toBe('777002');
    expect(
      telegramUserIdOf({
        callback_query: { from: { id: 777002 }, message: { from: { id: 999, is_bot: true } } },
      }),
    ).toBe('777002');
    expect(telegramUserIdOf({ callback_query: { from: { id: 999, is_bot: true } } })).toBeNull();
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

  it('sends no copy that promises a flow this head does not have', () => {
    /*
     * The two greetings told every customer to "use the menu to see the services you
     * can buy". There is no menu: `replyFor` answers `/start` and answers everything
     * else with "I did not understand that". So the product's first sentence to a
     * customer instructed them to do the one thing guaranteed to fail.
     *
     * The SET is asserted first, and that is the half with teeth. Checking only the
     * wording would leave the rule behind the moment somebody wires a catalogue send:
     * the new key's copy would be unreviewed and this test would stay green. Pinning
     * the reachable set means adding a send fails here and forces the question.
     */
    // Over the DECLARED vocabularies, not a typed-out list: adding an intent or an
    // arrival without reviewing its copy is exactly the drift this case exists for,
    // and a hand-written list would not notice either.
    const reachable = new Set<TemplateKey>();
    for (const intent of BOT_INTENTS) {
      for (const arrival of CUSTOMER_ARRIVALS) {
        const key = replyFor(intent, arrival);
        if (key !== null) reachable.add(key);
      }
    }
    expect([...reachable].sort()).toEqual([
      'bot.blocked',
      'bot.start.welcome',
      'bot.start.welcome_back',
      'bot.unknown_command',
    ]);

    /*
     * And the keys the RUNTIME itself can send, which `replyFor` no longer covers.
     *
     * `act` returns catalogue, order and refusal keys directly, so a set derived only
     * from `replyFor` would have gone on passing while four new customer-facing
     * sentences arrived unreviewed — the precise drift the paragraph above warns about,
     * one release later.
     *
     * Read from the SOURCE, because that is the only thing a new send cannot avoid
     * touching. A constant listing them would be a second list to keep in step, and the
     * commit that forgot to update it is the commit this case exists to catch.
     */
    const runtimeSource = readFileSync(
      resolve(import.meta.dirname, '../../apps/api/src/surfaces/telegram/bot-runtime.ts'),
      'utf8',
    );
    const sent = new Set<TemplateKey>();
    for (const [, key] of runtimeSource.matchAll(/'(bot\.[a-z0-9_.]+)'/g)) {
      if (key !== undefined && key in CATALOGUE_FA) sent.add(key as TemplateKey);
    }
    /*
     * Seven keys joined this list in 4C, and this case is what forced each to be
     * looked at — which is the whole reason it pins the SET rather than the wording.
     * Reviewed, one at a time:
     *
     *   `bot.order.settled`            the payment was confirmed. It used to say the
     *                                  service was being prepared; 4C is the phase that
     *                                  first SENDS this key and prepares nothing, so the
     *                                  shipped copy was corrected with it.
     *   `bot.wallet.balance`           a number the customer owns.
     *   `bot.wallet.insufficient`      the shortfall, which is the figure they can act
     *                                  on. It offers no top-up: there is none to offer.
     *   `bot.payment.manual_instructions`  the amount and the code to quote. The
     *                                  instructions themselves are tenant copy; this
     *                                  installation ships no bank details.
     *   `bot.payment.wallet_button`    a button label.
     *   `bot.payment.manual_button`    a button label.
     *   `bot.payment.unconfigured`     a rail this installation cannot perform, NAMED.
     *                                  Never a simulated success.
     *   `bot.order.not_awaiting_payment`  the ORDER is past paying for — almost always
     *                                  because the customer just paid and tapped the
     *                                  message's still-live button again. It replaced
     *                                  `bot.order.unavailable` here, which says a
     *                                  PRODUCT cannot be bought and so told somebody
     *                                  who had just been debited that their service
     *                                  was unavailable.
     *
     * None of them instructs a customer to do something that can only answer
     * `bot.unknown_command`, and none claims an effect that did not happen.
     *
     * Four more joined in 4E, when a customer could finally see a service at all.
     * Reviewed, one at a time:
     *
     *   `bot.service.list_heading`     introduces the customer's own services. It names
     *                                  no count, because a count interpolated at render
     *                                  goes stale the moment a service expires.
     *   `bot.service.not_found`        ONE answer for a service that is not theirs and
     *                                  one that does not exist, so the bot is not an
     *                                  oracle for guessing ids. It also answers every
     *                                  refusal `redeliver` can produce, and the reason
     *                                  it does is written where it is returned.
     *   `bot.service.list_empty`       the honest answer to owning nothing, and a
     *                                  different KEY from the heading rather than the
     *                                  heading with nothing under it.
     *   `bot.service.detail`           usage and expiry WITH the moment they were read.
     *                                  `syncedAt` is absent until a sync has succeeded,
     *                                  which is why the placeholder is not required: a
     *                                  figure with no asOf is one a customer reads as
     *                                  live.
     *   `bot.service.resend_button`    a button label, and its own key rather than
     *                                  `bot.service.subscription`. That was the first
     *                                  attempt and `validateTemplateValues` refused the
     *                                  send: a label is rendered with no values and
     *                                  that key requires a `subscriptionUrl`. The
     *                                  button carries a service id and no link; the
     *                                  link is sent by `DeliveryService.redeliver`,
     *                                  read from the row.
     *
     * Seven more joined when a customer could act on a service rather than only look
     * at one. Reviewed, one at a time:
     *
     *   `bot.service.suspend_button`   asks for a pause. Drawn only when the service is
     *                                  ACTIVE and the panel declares DISABLE_USER, so
     *                                  it is never offered where it cannot be honoured.
     *   `bot.service.resume_button`    the mirror, from SUSPENDED and ENABLE_USER.
     *   `bot.service.terminate_button` BEGINS ending a service and does not end one: it
     *                                  carries the ask prefix, so no message in this
     *                                  product ends a service on one tap.
     *   `bot.service.terminate_confirm` the question, and it states the consequence —
     *                                  the account on the panel is deleted, and it
     *                                  cannot be undone — rather than asking "are you
     *                                  sure". A question with no consequence in it is
     *                                  the same button with a delay.
     *   `bot.service.terminate_confirm_button`
     *                                  the only callback in this surface that plans a
     *                                  TERMINATE. It reads differently from the button
     *                                  that opened the question, because a customer who
     *                                  cannot tell them apart ends a service by tapping
     *                                  twice in the same place.
     *   `bot.service.action_requested` says the request was RECORDED, not that it is
     *                                  done. The panel is called by the provisioner
     *                                  seconds later and can fail; claiming completion
     *                                  here would be a claim about somebody else's
     *                                  machine made before anything was asked of it.
     *   `bot.service.capability_unsupported`
     *                                  frozen since Phase 4 and first SENT here. It
     *                                  answers a state the action is not legal from, a
     *                                  panel that cannot perform it, and a tenant that
     *                                  has stopped — one sentence for three, because
     *                                  none is the customer's to fix and telling them
     *                                  apart would describe an operator's panel to a
     *                                  customer.
     *
     * Nine more joined in 4F, when a customer could BUY something for a service they
     * already own. Reviewed, one at a time:
     *
     *   `bot.service.renew_button`     opens a quote and buys nothing. Drawn only when
     *                                  the state allows it, the panel declares
     *                                  RENEW_USER, and the plan behind it is still
     *                                  sellable — all three, because a button with only
     *                                  two of them is a button whose tap is a refusal.
     *   `bot.service.add_traffic_button`
     *   `bot.service.add_time_button`  the same, against ADD_VOLUME and ADD_TIME, and
     *                                  additionally requiring a configured package: an
     *                                  action with no configured price is explicitly
     *                                  unavailable rather than free.
     *   `bot.service.addon_choice`     the heading over the packages. The amounts and
     *                                  prices are on the BUTTONS and neither travels in
     *                                  a callback — what comes back is two identifiers.
     *   `bot.service.addon_option`     one package: what it adds, what it costs. The
     *                                  price is a MONEY value, so a customer never
     *                                  reads a bare number whose currency is implied.
     *   `bot.service.action_quote`     the offer being answered. The number is the one
     *                                  the order was written with and is never re-taken,
     *                                  so nobody is charged a price they did not see.
     *   `bot.service.action_confirm_button`
     *                                  commits to that quote and moves the order to
     *                                  awaiting payment. Its own key rather than the
     *                                  purchase confirmation's, because the two answer
     *                                  different questions.
     *   `bot.service.action_unavailable`
     *                                  one sentence for "nothing is configured", "the
     *                                  plan was withdrawn" and "this panel cannot do
     *                                  it". The customer's next step is the same for
     *                                  all three, and naming which would describe an
     *                                  operator's configuration to a customer.
     *   `bot.service.action_not_allowed`
     *                                  the SERVICE's state refuses it — distinct,
     *                                  because that one IS the customer's to act on.
     *   `bot.service.action_in_progress`
     *                                  the one TRANSIENT refusal: an earlier renewal or
     *                                  top-up for this service has not reached the panel
     *                                  yet, so the next one waits. Its own sentence
     *                                  because "try again in a moment" is the only
     *                                  answer in this group that is true by waiting, and
     *                                  telling somebody that would send them to support
     *                                  over ten seconds.
     *
     *   `bot.payment.cancel_button`  the way out, attached to the message that gave the
     *                                  customer the reference. It names the PAYMENT, not
     *                                  the order, because an order can have had several
     *                                  and a withdrawal names the one being withdrawn.
     *                                  It ASKS; it does not withdraw.
     *   `bot.payment.cancel_confirm`   the question between the two. That message stays
     *   `bot.payment.cancel_confirm_button`
     *                                  in the chat for ever, so a customer who has
     *                                  already transferred the money is otherwise one
     *                                  mis-touch from closing the payment it was
     *                                  against, with no edge back out of CANCELLED.
     *                                  TERMINATE is two taps for the same reason.
     *   `bot.payment.window_too_short` there is not enough of the order's own window
     *                                  left to transfer money inside it. Distinct from
     *                                  `bot.order.expired`: that one has closed, this
     *                                  one is about to, and the remedy is a new order
     *                                  rather than hurrying.
     *   `bot.payment.cancelled`        the withdrawal happened. It does NOT say the order
     *                                  is gone, because it is not: the order stays open
     *                                  until its own deadline so the customer can pay
     *                                  another way.
     *   `bot.payment.not_pending`      the payment has already ended — swept, rejected or
     *                                  withdrawn. Reached by scrolling back to a message
     *                                  that was live when it was sent, which is why it is
     *                                  its own key rather than `bot.order.unavailable`:
     *                                  "not available" reads as a fault in the product.
     *
     * None of them instructs a customer to do something that can only answer
     * `bot.unknown_command` either — `/services` is a real command in `intentOf`, and
     * every callback prefix is parsed.
     */
    expect([...sent].sort()).toEqual([
      'bot.blocked',
      'bot.catalog.empty',
      'bot.catalog.heading',
      'bot.order.awaiting_payment',
      'bot.order.confirm_button',
      'bot.order.expired',
      'bot.order.not_awaiting_payment',
      'bot.order.settled',
      'bot.order.summary',
      'bot.order.unavailable',
      'bot.payment.cancel_button',
      'bot.payment.cancel_confirm',
      'bot.payment.cancel_confirm_button',
      'bot.payment.cancelled',
      'bot.payment.manual_button',
      'bot.payment.manual_instructions',
      'bot.payment.not_pending',
      'bot.payment.unconfigured',
      'bot.payment.wallet_button',
      'bot.payment.window_too_short',
      'bot.service.action_confirm_button',
      'bot.service.action_in_progress',
      'bot.service.action_not_allowed',
      'bot.service.action_quote',
      'bot.service.action_requested',
      'bot.service.action_unavailable',
      'bot.service.add_time_button',
      'bot.service.add_traffic_button',
      'bot.service.addon_choice',
      'bot.service.addon_option',
      'bot.service.capability_unsupported',
      'bot.service.detail',
      'bot.service.list_empty',
      'bot.service.list_heading',
      'bot.service.not_found',
      'bot.service.renew_button',
      'bot.service.resend_button',
      'bot.service.resume_button',
      'bot.service.suspend_button',
      'bot.service.terminate_button',
      'bot.service.terminate_confirm',
      'bot.service.terminate_confirm_button',
      'bot.start.welcome',
      'bot.start.welcome_back',
      'bot.unknown_command',
      'bot.wallet.balance',
      'bot.wallet.insufficient',
    ]);

    /*
     * `منو` is "menu". The greetings pointed customers at one that does not exist.
     *
     * The sharper form of that rule is the loop below: every `/command` this product
     * writes to a customer must be a command `intentOf` actually recognises. That is
     * the defect generalised — the original copy did not fail because of the WORD
     * "menu", it failed because it instructed somebody to do something that could only
     * answer `bot.unknown_command`. A word list cannot notice `/orders` or `/support`
     * arriving in tenant-facing copy next release; this can.
     *
     * A deliberate non-rule: these bodies DO name amounts, and `bot.order.summary`
     * says "amount payable". That is a label on a number the customer is being shown,
     * not an instruction to pay, and a test that banned the word would be a test whose
     * exception list eventually covered every case it was meant to check.
     */
    for (const key of new Set([...reachable, ...sent])) {
      const body = CATALOGUE_FA[key];
      expect(body, `${key} has no body`).toBeTypeOf('string');
      expect(body, `${key} points the customer at a menu that does not exist`).not.toContain('منو');
      for (const [, command] of body.matchAll(/(?:^|\s)(\/[a-z_]+)/g)) {
        expect(
          intentOf({ message: { text: command } }).intent,
          `${key} tells the customer to send ${command}, which this bot does not answer`,
        ).not.toBe('UNSUPPORTED');
      }
    }
  });

  it('refuses the same ids in the OPERATOR search, not only at the webhook', () => {
    /*
     * One definition of what a Telegram id is, used on both sides.
     *
     * The list query took `z.string().max(32)`, so `?telegramUserId=12ab` was
     * accepted, matched nothing and returned an empty page — which says "no such
     * customer" when the truth is "that is not an id". It also made a comment in
     * `users.tsx` false, because that comment justified client-side validation by
     * the server's 400.
     */
    expect(customerListQuerySchema.safeParse({ telegramUserId: '5551234567' }).success).toBe(true);
    for (const malformed of ['12ab', '0', '0777', '-1', '55 512', '', ' 5551234567']) {
      expect(
        customerListQuerySchema.safeParse({ telegramUserId: malformed }).success,
        `accepted ${JSON.stringify(malformed)} as a Telegram id`,
      ).toBe(false);
    }
    // A USERNAME search stays a bounded free string: a half-remembered username is
    // what an operator actually has, and refusing one would remove the feature.
    expect(customerListQuerySchema.safeParse({ username: 'al' }).success).toBe(true);
  });

  it('gives the customer entity ONE name in the frozen contract', () => {
    /*
     * `UserId` is canonical and `CustomerId` must not exist.
     *
     * A type alias is invisible to every other test in this suite — it compiles,
     * nothing imports it, and the duplicate vocabulary it creates is exactly what
     * `customer.ts` argues against three lines above where the alias was. Read from
     * the SOURCE, because a removed export leaves no runtime trace to assert on.
     */
    const source = readFileSync(
      resolve(import.meta.dirname, '../../packages/contracts/src/customer.ts'),
      'utf8',
    );
    // Anchored to column zero, so the sentence IN the replacement comment that
    // quotes the removed declaration is not mistaken for the declaration.
    expect(source).not.toMatch(/^export type CustomerId\b/m);
    expect(source).not.toMatch(/^export (?:const|interface|class) CustomerId\b/m);
    // And the barrel does not re-export it under any spelling.
    const barrel = readFileSync(
      resolve(import.meta.dirname, '../../packages/contracts/src/index.ts'),
      'utf8',
    );
    expect(barrel).not.toMatch(/\bCustomerId\b/);
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

describe('a callback prefix decides what happens, so no prefix may shadow another', () => {
  /*
   * `intentOf` tests prefixes in a fixed order and returns on the first match, so a
   * prefix that is a prefix of another routes every tap for the longer one to whichever
   * branch comes first. The comment beside the resend/service pair already says this;
   * here it is checked, because the consequence is no longer "the customer gets the
   * wrong screen".
   *
   * `t:` opens a question and `k:` ends a service. If one ever shadowed the other, one
   * of them would silently stop happening — and the direction that matters is that a
   * tap meaning "ask me first" must never be able to arrive as "do it".
   */
  const PREFIXES: Readonly<Record<string, string>> = {
    ORDER: ORDER_CALLBACK_PREFIX,
    CONFIRM: CONFIRM_CALLBACK_PREFIX,
    PAY_WALLET: WALLET_PAY_CALLBACK_PREFIX,
    PAY_MANUAL: MANUAL_PAY_CALLBACK_PREFIX,
    PAY_GATEWAY: GATEWAY_PAY_CALLBACK_PREFIX,
    SERVICE: SERVICE_CALLBACK_PREFIX,
    SERVICE_RESEND: SERVICE_RESEND_CALLBACK_PREFIX,
    SERVICE_SUSPEND: SERVICE_SUSPEND_CALLBACK_PREFIX,
    SERVICE_RESUME: SERVICE_RESUME_CALLBACK_PREFIX,
    SERVICE_TERMINATE_ASK: SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
    SERVICE_TERMINATE: SERVICE_TERMINATE_CALLBACK_PREFIX,
    SERVICE_RENEW: SERVICE_RENEW_CALLBACK_PREFIX,
    SERVICE_ADD_TRAFFIC: SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
    SERVICE_ADD_TIME: SERVICE_ADD_TIME_CALLBACK_PREFIX,
    SERVICE_ACTION_CONFIRM: SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  };

  /*
   * The two that carry an id PAIR rather than one id.
   *
   * Separate because their payload is 43 base64url characters and not a uuid, so the
   * routing case below has to build them differently — but the SHADOWING rule is over
   * every prefix this runtime knows, so `ALL_PREFIXES` is the union and it is what the
   * distinctness and never-terminate cases iterate.
   *
   * Phase 4F added six prefixes and this map named none of them for a while: the
   * shadowing case, whose whole purpose is that a carelessly chosen prefix fails here
   * rather than by ending a customer's service, was checking eleven of seventeen.
   */
  const PAIR_PREFIXES: Readonly<Record<string, string>> = {
    SERVICE_BUY_TRAFFIC: SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
    SERVICE_BUY_TIME: SERVICE_BUY_TIME_CALLBACK_PREFIX,
  };

  const ALL_PREFIXES: Readonly<Record<string, string>> = { ...PREFIXES, ...PAIR_PREFIXES };

  it('gives every prefix a distinct string that no other prefix begins with', () => {
    const values = Object.values(ALL_PREFIXES);
    expect(new Set(values).size, 'two intents share a prefix').toBe(values.length);
    for (const one of values) {
      for (const other of values) {
        if (one === other) continue;
        expect(other.startsWith(one), `${other} is shadowed by ${one}`).toBe(false);
      }
    }
  });

  it('routes each prefix to its own intent, and carries the id through unchanged', () => {
    // A real uuid, because `callbackCommand` validates the payload rather than casting
    // it: `callback_data` is whatever the client sent, and a malformed id is answered
    // rather than turned into a 500 at the column.
    const id = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
    for (const [intent, prefix] of Object.entries(PREFIXES)) {
      const command = intentOf({
        callback_query: { id: 'cbq', data: `${prefix}${id}` },
      });
      expect(command.intent, `${prefix} must route to ${intent}`).toBe(intent);
      expect(command.targetId).toBe(id);
    }
  });

  it('carries BOTH ids through the pair-carrying prefixes, and fits in 64 bytes', () => {
    /*
     * The service and the package are two different things and neither can be inferred
     * from the other, so both have to survive the round trip intact — a pair read half
     * way would buy a package for a service nobody named.
     *
     * The length is asserted because it is the reason the encoding is raw base64url at
     * all: two uuids spell 73 characters and `callback_data` holds 64. Two for the
     * prefix and 43 for the pair is 45, and a change that pushed it over would be
     * rejected by Telegram at send time rather than here.
     */
    const service = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
    const addon = '0191f4a0-9e77-7d18-8c03-2b9d4e5a1f60';
    for (const [intent, prefix] of Object.entries(PAIR_PREFIXES)) {
      const data = `${prefix}${encodeIdPair(service, addon)}`;
      expect(Buffer.byteLength(data, 'utf8'), `${prefix} payload`).toBeLessThanOrEqual(64);
      const command = intentOf({ callback_query: { id: 'cbq', data } });
      expect(command.intent, `${prefix} must route to ${intent}`).toBe(intent);
      expect(command.targetId).toBe(service);
      expect(command.secondaryId).toBe(addon);
    }
  });

  it('answers a malformed pair rather than casting it at a column', () => {
    // Not a 500 and not a half-read. The payload is whatever the client sent.
    for (const prefix of Object.values(PAIR_PREFIXES)) {
      for (const payload of ['', 'short', 'x'.repeat(43), '='.repeat(43)]) {
        expect(
          intentOf({ callback_query: { id: 'c', data: `${prefix}${payload}` } }).intent,
          `${prefix}${payload}`,
        ).toBe('UNSUPPORTED');
      }
    }
  });

  it('never routes anything but the confirmation button to SERVICE_TERMINATE', () => {
    /*
     * The destructive intent, checked from the other direction: every OTHER prefix, and
     * a payload with no prefix at all, must produce something that is not
     * SERVICE_TERMINATE. A future prefix chosen carelessly — `k` followed by something,
     * say — fails here rather than by ending a customer's service.
     */
    for (const [intent, prefix] of Object.entries(ALL_PREFIXES)) {
      if (intent === 'SERVICE_TERMINATE') continue;
      expect(
        intentOf({
          callback_query: { id: 'c', data: `${prefix}0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa` },
        }).intent,
      ).not.toBe('SERVICE_TERMINATE');
    }
    expect(intentOf({ callback_query: { id: 'c', data: 'nonsense' } }).intent).toBe('UNSUPPORTED');
  });
});
