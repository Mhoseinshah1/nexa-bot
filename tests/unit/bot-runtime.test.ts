import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_ORDER_PURPOSES,
  CUSTOMER_ARRIVALS,
  CUSTOMER_NAME_MAX_LENGTH,
  ORDER_PURPOSES,
  CUSTOMER_USERNAME_MAX_LENGTH,
  normaliseProfileField,
  profileFactsFrom,
  referralCodeFor,
  providerUsernameFor,
  isNewProviderUsername,
  customerListQuerySchema,
  telegramUserIdSchema,
  type TemplateKey,
  failureOutcome,
  isMutatingOperation,
  debitIsWithinMeans,
  discountAmountMinor,
  clampDiscount,
  normaliseDiscountCode,
  templateDefinition,
  COMMERCE_ERROR_CODES,
  NexaError,
} from '@nexa/contracts';
import {
  MAIN_MENU_BUTTONS,
  MAIN_MENU_ROWS,
  RECEIPT_CAPTION_MAX_LENGTH,
  normalizeReceiptCaption,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  BOT_INTENTS,
  CONFIRM_CALLBACK_PREFIX,
  REFUSAL_REPLIES,
  CATALOG_PAGE_CALLBACK_PREFIX,
  CATEGORY_CALLBACK_PREFIX,
  CATALOG_BROWSE_MAX_PAGE,
  parseCatalogPage,
  refusalValuesFor,
  followUpForSettlement,
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
  SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
  SERVICE_ROTATE_CALLBACK_PREFIX,
  SERVICE_TERMINATE_CALLBACK_PREFIX,
  SERVICE_RENEW_CALLBACK_PREFIX,
  SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_ADD_TIME_CALLBACK_PREFIX,
  SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX,
  SERVICE_BUY_TIME_CALLBACK_PREFIX,
  SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX,
  encodeIdPair,
  WALLET_PAY_CALLBACK_PREFIX,
  ADMIN_CREDIT_CALLBACK_PREFIX,
  ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX,
  ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX,
  RECEIPT_REVIEW_NOTE_MAX,
  creditRefusal,
  reviewNoteOf,
  withdrawalRefusal,
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

  it('routes every main-menu button to the command it stands for', () => {
    /*
     * Real v0.2.0 staging acceptance is why this exists: the bot answered five commands
     * and an ordinary customer still had to type a slash. The keyboard is the fix, and
     * the rule that makes it safe is that a tap is NOT a second handler — it resolves to
     * the slash command and re-enters the branch that already existed.
     *
     * The map is built the way the composition root builds it, from the same two
     * constants, so a label edited in the catalogue without the routing table moving
     * with it fails here.
     */
    const menu = new Map(
      MAIN_MENU_BUTTONS.map((button) => [CATALOGUE_FA[button.label], `/${button.command}`]),
    );

    expect(intentOf({ message: { text: CATALOGUE_FA['bot.menu.catalog'] } }, menu)).toEqual(
      intentOf({ message: { text: '/catalog' } }),
    );
    expect(intentOf({ message: { text: CATALOGUE_FA['bot.menu.services'] } }, menu)).toEqual(
      intentOf({ message: { text: '/services' } }),
    );
    expect(intentOf({ message: { text: CATALOGUE_FA['bot.menu.wallet'] } }, menu)).toEqual(
      intentOf({ message: { text: '/wallet' } }),
    );
    expect(intentOf({ message: { text: CATALOGUE_FA['bot.menu.help'] } }, menu)).toEqual(
      intentOf({ message: { text: '/help' } }),
    );
  });

  it('answers a menu label it was not given as ordinary text', () => {
    // The map is the whole authority. Without it — a bot with no keyboard configured —
    // the label is ordinary text and takes the path ordinary text takes.
    //
    // That path is `USERNAME_TEXT` since the username step, and the CUSTOMER-visible
    // answer is unchanged: the handler asks the database whether a typing window is
    // open, is told no for every message but one, and returns `bot.unknown_command`.
    // Asserted at the parse layer, which is what this file tests.
    expect(intentOf({ message: { text: CATALOGUE_FA['bot.menu.catalog'] } }).intent).toBe(
      'USERNAME_TEXT',
    );
  });

  it('still answers arbitrary text as an unknown command', () => {
    const menu = new Map(
      MAIN_MENU_BUTTONS.map((button) => [CATALOGUE_FA[button.label], `/${button.command}`]),
    );
    // No fuzzy matching, no prefix matching, no case folding: the menu is a closed set
    // of exact strings and everything else is what it was before the menu existed.
    expect(intentOf({ message: { text: 'سلام' } }, menu).intent).toBe('USERNAME_TEXT');
    expect(intentOf({ message: { text: 'خرید' } }, menu).intent).toBe('USERNAME_TEXT');
    expect(
      intentOf({ message: { text: `${CATALOGUE_FA['bot.menu.catalog']} extra` } }, menu).intent,
    ).toBe('USERNAME_TEXT');

    /*
     * And the text is carried UNTOUCHED, which is the half that matters.
     *
     * `isValidCustomUsername` is asked of the raw input and refuses whitespace rather
     * than trimming it — the owner's rule: nothing is rewritten but ASCII case. A
     * surface that tidied the text here would make that rule unreachable, and the
     * customer would be given a name they did not type.
     */
    expect(intentOf({ message: { text: '  Ali_2026  ' } }, menu).args).toEqual(['  Ali_2026  ']);
  });

  it('offers exactly the four top-level actions this release can perform', () => {
    /*
     * A keyboard is a PROMISE. The legacy system's menu described a product that did
     * not exist, and `docs/research/` records what that cost; a button answering "not
     * available" would be that defect reproduced deliberately.
     *
     * So the set is pinned against `BOT_COMMANDS` minus `start` — every command the bot
     * answers that is a place a customer can go — and a Phase 7 button cannot be added
     * here without a command to carry it.
     */
    expect(MAIN_MENU_ROWS.map((row) => row.map((button) => button.command))).toEqual([
      ['catalog', 'services'],
      ['wallet', 'help'],
    ]);
    expect(MAIN_MENU_BUTTONS.map((button) => button.label)).toEqual([
      'bot.menu.catalog',
      'bot.menu.services',
      'bot.menu.wallet',
      'bot.menu.help',
    ]);
    // And every label renders. A key with no catalogue entry is a blank button.
    for (const button of MAIN_MENU_BUTTONS) {
      expect(CATALOGUE_FA[button.label], `${button.label} has no text`).toBeTruthy();
    }
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
    /*
     * TEXT takes the username path; everything that is not text stays `UNSUPPORTED`.
     *
     * The split is the point. Only a message a customer TYPED can be a username, so
     * only text is offered to the window — a message with no text at all has nothing to
     * offer and never reaches the database.
     */
    expect(intentOf({ message: { text: 'hello' } }).intent).toBe('USERNAME_TEXT');
    expect(intentOf({ message: { text: '/startle' } }).intent).toBe('USERNAME_TEXT');
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
      /*
       * `bot.help` joined the set in Phase 4H, and its copy was reviewed against the
       * rule this case exists for: it names four commands and every one of them
       * ANSWERS on this head. `/catalog`, `/services` and `/wallet` are the three the
       * runtime already parsed, and `/help` is itself.
       *
       * It is the fix for the defect measured in `docs/phase4h-audit.md` §9, which is
       * the same shape as the one this test was written about: the greeting named only
       * `/catalog`, so two of the four commands were reachable only by guessing. The
       * old failure was copy promising what did not exist; this was the mirror —
       * something that existed and no copy named.
       */
      'bot.help',
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
    /*
     * The customer-facing half. 5T's admin copy is asserted separately below, for the
     * reason stated there: this list is what a CUSTOMER can be sent.
     */
    expect([...sent].filter((key) => !key.startsWith('bot.admin.')).sort()).toEqual([
      'bot.blocked',
      /*
       * The five catalogue keys WP5 added, each reviewed against this case's rule.
       *
       *   `back_to_categories_button`  returns to page 0 of a list that exists.
       *   `categories_heading`         introduces a list the SQL guarantees is non-empty
       *                                per row — a category with nothing to buy is not
       *                                in it, so the heading never promises a dead end.
       *   `category_empty`             the one honest answer when the last product in a
       *                                category was withdrawn between two taps; it says
       *                                to look at the other categories, which exist.
       *   `next_page_button`, `previous_page_button`
       *                                drawn only when that page really exists, so
       *                                neither can lead to an empty page.
       *
       * `bot.catalog.heading` STAYS, now introducing the list inside a category; reused
       * rather than replaced so a tenant's existing override keeps its wording.
       */
      'bot.catalog.back_to_categories_button',
      'bot.catalog.categories_heading',
      'bot.catalog.category_empty',
      'bot.catalog.empty',
      'bot.catalog.heading',
      'bot.catalog.next_page_button',
      'bot.catalog.previous_page_button',
      /*
       * WP8's five discount keys, reviewed against this case's rule. `enter_button` is
       * drawn only on a new-purchase DRAFT, the one order a code can reach (P7), and
       * opens a window `ask` names; `remove_button` only when a code is on it.
       * `rejected` answers a typed code with one sentence for every reason, and
       * `no_longer_valid` answers a confirmation whose discount stopped holding — it
       * sends the customer back to start again, a flow this head has.
       */
      'bot.discount.ask',
      'bot.discount.enter_button',
      'bot.discount.no_longer_valid',
      'bot.discount.rejected',
      'bot.discount.remove_button',
      /*
       * `bot.help` is 4H's, and it is the one key here that exists to make the OTHERS
       * findable. `docs/phase4h-audit.md` §9: four commands answered, none registered
       * with Telegram, and the greeting named only `/catalog` — so `/wallet` and
       * `/services` were reachable by guessing alone. Reviewed against this case's own
       * rule: every command its copy names answers on this head.
       */
      'bot.help',
      'bot.order.awaiting_payment',
      /*
       * The 4H order-cancellation trio, reviewed against this case's own rule.
       *
       * `docs/phase4h-audit.md` §3: `ORDER_MACHINE`'s CANCEL edge became WRITABLE in 4G
       * and still had no caller, so `bot.order.cancelled` was a frozen sentence with
       * nowhere to be sent from. The button now sits beside the two pay buttons, the
       * confirm question stands between it and the cancellation, and the third is the
       * answer to the question — the same three-key shape the payment withdrawal and
       * the service termination already use, for the reason both record: a destructive
       * tap a customer can reach by scrolling is not a decision they have made.
       *
       * None of the three instructs the customer to do anything: they describe what the
       * tap does and what cannot be taken back.
       */
      'bot.order.cancel_button',
      'bot.order.cancel_confirm',
      'bot.order.cancel_confirm_button',
      'bot.order.cancelled',
      'bot.order.confirm_button',
      'bot.order.expired',
      'bot.order.not_awaiting_payment',
      'bot.order.settled',
      'bot.order.summary',
      /*
       * WP8's three summary variants: the same summary with the figures the quote
       * carries — the subtotal and discount taken off, the cashback promised after
       * delivery. Chosen from the quote, so each is sent only when its figures exist.
       */
      'bot.order.summary_cashback',
      'bot.order.summary_discounted',
      'bot.order.summary_discounted_cashback',
      /*
       * A reseller's price changed between the summary and the tap (WP9-B R9). Like
       * `bot.discount.no_longer_valid` it says nothing was charged and asks them to start
       * the order again — the catalogue they already have — and names no command.
       */
      'bot.order.terms_changed',
      /*
       * The refusal when the customer has already said they paid.
       *
       * Its Persian tells them to WAIT for a review they asked for, which is the one
       * instruction in this set — and it is an instruction to do nothing, not one to
       * send a command. It is a distinct key because `bot.order.not_awaiting_payment`
       * would say the order can no longer be acted on, and here it is perfectly live.
       */
      'bot.order.transfer_under_review',
      'bot.order.unavailable',
      'bot.payment.cancel_button',
      'bot.payment.cancel_confirm',
      'bot.payment.cancel_confirm_button',
      'bot.payment.cancelled',
      'bot.payment.copy_amount_button',
      'bot.payment.copy_card_button',
      'bot.payment.manual_button',
      'bot.payment.manual_instructions',
      'bot.payment.not_pending',
      /*
       * The five 5R keys. Each reviewed against this case's own rule — does the copy
       * promise a flow this head has — and the answer for all five is yes, because 5R is
       * the phase that builds the flow they describe.
       *
       *   `receipt_prompt`        asks for the file and names the minutes remaining. It
       *                           is sent only when a window was genuinely opened in the
       *                           tap's transaction: `receiptWindow === null` gets
       *                           `received_for_review` instead, which promises nothing.
       *                           It repeats the caution above it — nothing has been
       *                           received or verified — because a customer who reads
       *                           "send your receipt" as "you have paid" is the
       *                           `PRBR-004` collapse in a customer's own head.
       *   `receipt_received`      says the FILE arrived and a reviewer will look at it.
       *                           It may say that, and `received_for_review`'s comment
       *                           above is corrected in the catalogue to record why:
       *                           5R makes "your receipt was received" true and leaves
       *                           "your payment was received" as false as it ever was.
       *   `receipt_not_expected`  the refusal that keeps this from becoming
       *                           `INCIDENT-FIN-001`. It names the remedy — open the
       *                           invoice, tap the button — rather than consuming a file
       *                           nobody asked for.
       *   `receipt_expired`       distinct from the above BECAUSE the remedy differs:
       *                           the customer did what they were asked and took too
       *                           long, so it says to tap again.
       *   `receipt_limit`         says the receipts already sent are what the reviewer
       *                           sees, because a customer not told that sends more.
       */
      'bot.payment.receipt_expired',
      'bot.payment.receipt_limit',
      'bot.payment.receipt_not_expected',
      'bot.payment.receipt_prompt',
      'bot.payment.receipt_received',
      /*
       * The answer to the new button below, and the wording is the load-bearing part.
       *
       * Its Persian used to read «رسید شما دریافت شد» — "your receipt has been
       * received" — for a key with no producer at all. Both halves were untrue: this
       * product accepts no receipt (owner revision 17) and nothing has been received.
       * 4H rewrote it to say what IS true — the customer's claim is recorded and a
       * person will check it — which is the distinction `PRBR-004` records the legacy
       * system as unable to make.
       */
      'bot.payment.received_for_review',
      /*
       * The button that produces them, and since the Payment UX addendum it names both
       * halves of what one tap does: «✅ پرداخت را انجام دادم | ارسال رسید».
       *
       * `bot.payment.manual_instructions` used to end «سپس رسید را ارسال نمایید»
       * with no surface to send one to. 5A made the instruction name this button, and 5R
       * is what makes the second half of its label true.
       */
      'bot.payment.sent_button',
      'bot.payment.transfer_instructions',
      /*
       * WP10 P2: paying from the wallet while a transfer the customer vouched for waits.
       * Says the review decides the order and nothing was debited; promises no flow.
       */
      'bot.payment.transfer_under_review',
      'bot.payment.unconfigured',
      'bot.payment.wallet_button',
      'bot.payment.window_too_short',
      /*
       * Payment File 02 §9: withdrawing a transfer the customer sent a receipt for. About
       * the PAYMENT, so it is true of a top-up; it promises only the review's answer.
       */
      'bot.payment.withdraw_under_review',
      /*
       * WP9's three referral keys, reviewed against this case's rule. `button` is drawn on
       * the wallet only while the program is running (a flag AND a rate), and opens
       * `invite`, which names a /start link this head attributes on registration.
       * `unconfigured` is the one answer when the program is not running, which leads
       * nowhere because there is nowhere to lead.
       */
      'bot.referral.button',
      'bot.referral.invite',
      'bot.referral.unconfigured',
      /*
       * 5F's generic refusal. It is in this inventory because it IS customer-facing,
       * and it promises nothing: it says the request cannot be completed now and that
       * nothing was charged. Both are true of every cause that reaches it — a stopped
       * installation, an absent row, a funds refusal without its figure — and all three
       * roll back before the reply is built.
       */
      'bot.request_unavailable',
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
      'bot.service.list_more',
      'bot.service.not_found',
      /*
       * 4H's follow-up to `bot.order.settled`, and the one key here that is sent as a
       * SECOND message rather than as a turn's answer.
       *
       * `docs/phase4h-audit.md` §5: a customer who had paid saw the settled message and
       * then nothing at all until the subscription link arrived. Reviewed against this
       * case's own rule — it instructs the customer to do nothing and promises a
       * follow-up rather than a duration, because the duration depends on a panel.
       *
       * It is sent only for `NEW_SERVICE`. `followUpForSettlement` is the rule and has
       * its own cases below; a renewal creates nothing and is told nothing.
       */
      'bot.service.provisioning',
      'bot.service.renew_button',
      'bot.service.resend_button',
      'bot.service.resume_button',
      /*
       * WP6-C's four, reviewed against this case's rule. The button is drawn only when
       * the server has just offered a rotation; the ask names the cooldown and promises
       * a new link — which the delivery lane sends — and says NOTHING about the old one,
       * whose invalidation is unproven; the cooldown refusal names the instant the
       * server gave. None of them promises a flow this head lacks.
       */
      'bot.service.rotate_ask',
      'bot.service.rotate_button',
      'bot.service.rotate_confirm_button',
      'bot.service.rotate_cooldown',
      'bot.service.suspend_button',
      'bot.service.terminate_button',
      'bot.service.terminate_confirm',
      'bot.service.terminate_confirm_button',
      'bot.start.welcome',
      'bot.start.welcome_back',
      /*
       * WP6-A's three, reviewed against this case's rule. `bot.trial.button` is drawn
       * only when the server has just decided this customer can take a trial;
       * `bot.trial.issued` says the service is being created and promises only the link
       * the ordinary delivery lane then sends; `bot.trial.unavailable` is the one
       * sentence for every refusal. None of them promises a flow this head lacks.
       */
      'bot.trial.button',
      'bot.trial.issued',
      'bot.trial.unavailable',
      'bot.unknown_command',
      /*
       * Five joined with the username step. Reviewed, one at a time:
       *
       *   `bot.username.choose`        asks which mode, and is sent ONLY when the panel
       *                                offers both. One button is a tap that teaches
       *                                nothing, so a single-mode panel skips it.
       *   `bot.username.custom_button` opens the typing window, and the window is what
       *                                makes the next ordinary message mean something.
       *                                Nothing opens one the customer did not ask for.
       *   `bot.username.random_button` has the installation draw the name instead.
       *   `bot.username.instructions`  states the WHOLE rule before they type — length,
       *                                the character set, letter-and-digit, and that
       *                                case is not distinguished. It is why the refusal
       *                                below names no clause.
       *   `bot.username.invalid`       refuses without saying which rule was broken. The
       *                                rule was shown in full, so naming the clause adds
       *                                nothing they did not have and turns each attempt
       *                                into a probe of the validator.
       *   `bot.username.taken`         says the name is gone AND that no money moved,
       *                                which is a fact rather than a reassurance: it is
       *                                raised before any debit and before a transfer is
       *                                requested.
       *
       * None instructs a customer to do something that can only answer
       * `bot.unknown_command`, and none claims an effect that did not happen. A refusal
       * leaves the window OPEN, so "send another" is true when it is said.
       */
      'bot.username.automatic_button',
      'bot.username.choose',
      'bot.username.custom_button',
      'bot.username.exhausted',
      'bot.username.instructions',
      'bot.username.invalid',
      'bot.username.mode_unavailable',
      'bot.username.stale',
      'bot.username.taken',
      'bot.username.unavailable',
      'bot.wallet.balance',
      'bot.wallet.insufficient',
      /*
       * 5B's four. Reviewed against this case's own rule — none of them instructs a
       * customer to do something no surface answers:
       *
       *   `bot.wallet.topup_button`      sits under the balance, and only when a top-up
       *                                  could actually be performed: at least one preset
       *                                  amount in the selling currency AND an enabled
       *                                  account to transfer to.
       *   `bot.wallet.topup_choose`      the prompt above the preset amounts. The buttons
       *                                  ARE the amounts, read when the tap arrives, so a
       *                                  customer scrolling back to an old balance gets
       *                                  today's presets rather than that day's.
       *   `bot.wallet.topup_refused`     the chosen amount cannot be used — no longer
       *                                  offered, or below the configured minimum. One
       *                                  sentence for both because the action is the
       *                                  same: choose another. The codes stay distinct.
       *   `bot.wallet.topup_unavailable` nothing can fund a top-up: no preset, or no
       *                                  enabled account. It does not name the missing
       *                                  configuration, which is an operator's business.
       *
       * `bot.wallet.topup_credited` is deliberately NOT here: it is the notification
       * lane's, sent by the dispatcher when an operator confirms the transfer, and this
       * case is about what the interactive surface can produce.
       */
      'bot.wallet.topup_button',
      'bot.wallet.topup_choose',
      'bot.wallet.topup_refused',
      'bot.wallet.topup_unavailable',
    ]);

    /*
     * 5T's nineteen and 6A's seventeen, kept as their own assertion rather than merged
     * into the list above — because they are ADMIN-facing, and the rule this case
     * enforces is about what a CUSTOMER is promised. Merging them would quietly widen
     * a customer-copy review into "any text the runtime sends".
     *
     * Reviewed against the same rule anyway: none of them instructs anybody to do
     * something this head cannot do. The ones that name commands print `/link`,
     * `/role` and `/service`, which `intentOf` parses — and
     * `telegram-command-menu.test.ts` is what proves all three are parsed and
     * deliberately unregistered.
     *
     * `bot.menu.admin` and `bot.admin.receipt_awaiting` are NOT here and must not be:
     * the first is a keyboard label the messenger draws from the shared constant, and
     * the second is the notification lane's, sent by the dispatcher.
     */
    const adminKeys = [...sent].filter((key) => key.startsWith('bot.admin.')).sort();
    expect(adminKeys).toEqual([
      /*
       * WP1's seven, the administrator roster. Reviewed against the same rule and
       * against one more that matters most here: not one of them carries credential
       * material. `bot.admin.admin_detail` renders a username, a display name, a
       * status, role keys and a numeric Telegram id, and there is no key in this
       * group for a password, a hash, a session, an IP or a user agent — a reset is
       * the Web Admin's and a session listing stays there, because this message is
       * forwardable for ever.
       */
      'bot.admin.admin_detail',
      'bot.admin.admin_disable_button',
      'bot.admin.admin_enable_button',
      'bot.admin.admin_gone',
      'bot.admin.admin_status_changed',
      'bot.admin.admins_back_button',
      'bot.admin.admins_none',
      'bot.admin.approve_button',
      'bot.admin.approved',
      /*
       * WP5's twenty-eight, the categories section (the twenty-seven here and
       * `bot.admin.product_gone` further down). Reviewed against the same rule: the
       * commands they name — `/category_new`, `/category_rename`, `/category_emoji` — are
       * parsed by `intentOf` and deliberately unregistered, which
       * `telegram-command-menu.test.ts` asserts. None of them carries a price, a panel
       * or anything a customer bought: a category is a name, two flags and a count.
       */
      'bot.admin.categories_back_button',
      'bot.admin.categories_button',
      'bot.admin.categories_next_button',
      'bot.admin.categories_none',
      'bot.admin.categories_previous_button',
      'bot.admin.categories_section',
      'bot.admin.category_activate_button',
      'bot.admin.category_deactivate_button',
      'bot.admin.category_delete_ask',
      'bot.admin.category_delete_button',
      'bot.admin.category_delete_confirm_button',
      'bot.admin.category_deleted',
      'bot.admin.category_detail',
      'bot.admin.category_down_button',
      'bot.admin.category_gone',
      'bot.admin.category_hide_button',
      'bot.admin.category_moved',
      'bot.admin.category_not_empty',
      'bot.admin.category_pick',
      'bot.admin.category_pick_none',
      'bot.admin.category_products',
      'bot.admin.category_products_button',
      'bot.admin.category_products_more_button',
      'bot.admin.category_products_none',
      'bot.admin.category_show_button',
      'bot.admin.category_up_button',
      'bot.admin.category_usage',
      /*
       * Payment File 02 §12's eleven, the credit-to-wallet disposition. Reviewed against
       * the same rule: the button is drawn only for BOTH keys the credit charges, the
       * prompt reads one message from one administrator for five minutes, and nothing
       * moves until `credit_confirm` has stated the exact amount and been confirmed.
       */
      'bot.admin.credit_amount_invalid',
      'bot.admin.credit_amount_prompt',
      'bot.admin.credit_button',
      'bot.admin.credit_cancel_button',
      'bot.admin.credit_cancelled',
      'bot.admin.credit_confirm',
      'bot.admin.credit_confirm_button',
      'bot.admin.credit_currency',
      'bot.admin.credit_expired',
      'bot.admin.credit_no_receipt',
      'bot.admin.credited',
      /*
       * WP2's eleven, the customers section. Reviewed against the same rule, and
       * against the one that matters most for a screen about a PERSON: not one of
       * them carries anything the customer bought. No wallet balance, no order, no
       * service, no subscription reference, no provider username — each of those is a
       * different permission, and this message is as forwardable as the rest.
       *
       * `bot.admin.customers_section` names `/customer <telegram id>`, which
       * `intentOf` parses and `telegram-command-menu.test.ts` proves is deliberately
       * unregistered — the same standing the three commands above it have.
       *
       * `bot.admin.customer_gone` is ONE answer for unknown, malformed, another
       * tenant's and not-matched, so an administrator cannot use this surface to
       * discover whether an id names anybody here.
       */
      'bot.admin.customer_block_button',
      'bot.admin.customer_detail',
      'bot.admin.customer_gone',
      'bot.admin.customer_status_changed',
      'bot.admin.customer_unblock_button',
      'bot.admin.customer_usage',
      'bot.admin.customers_back_button',
      'bot.admin.customers_button',
      'bot.admin.customers_more_button',
      'bot.admin.customers_none',
      'bot.admin.customers_section',
      'bot.admin.linked',
      'bot.admin.panel',
      /*
       * 6B's nineteen, the panels section. Reviewed against the same rule, and one
       * property matters more here than "does it promise a flow": none of these
       * carries a credential, a base URL, a masked stand-in for either, or a
       * provider's response body. `bot.admin.panel_detail` renders the failure KIND
       * from the frozen taxonomy and never the text a provider returned, and no key
       * in this group offers to create or rotate a credential — that is the Web
       * Admin's, and `BotRuntimeDeps.panelAdmin` cannot reach it.
       *
       * `bot.admin.panel_not_validated` is the only refusal here with its own
       * sentence, because it is the only one an administrator can resolve without
       * leaving the screen: the Test button is on it.
       */
      'bot.admin.panel_archive_ask',
      'bot.admin.panel_archive_button',
      'bot.admin.panel_archive_confirm_button',
      'bot.admin.panel_archived',
      'bot.admin.panel_detail',
      'bot.admin.panel_disable_button',
      'bot.admin.panel_disabled',
      'bot.admin.panel_enable_button',
      'bot.admin.panel_enabled',
      'bot.admin.panel_gone',
      'bot.admin.panel_not_validated',
      'bot.admin.panel_test_button',
      'bot.admin.panel_test_replayed',
      'bot.admin.panel_tested',
      'bot.admin.panel_unavailable',
      'bot.admin.panels_button',
      'bot.admin.panels_more_button',
      'bot.admin.panels_none',
      'bot.admin.panels_section',
      'bot.admin.product_gone',
      'bot.admin.receipt',
      'bot.admin.receipt_gone',
      'bot.admin.receipts_button',
      'bot.admin.receipts_list',
      'bot.admin.receipts_none',
      'bot.admin.refused',
      'bot.admin.reject_button',
      'bot.admin.rejected',
      /*
       * The reminder settings section (Phase 6C). Ten keys, each reviewed against this
       * case's rule — none of them instructs an administrator to do something this head
       * cannot do, and the one that comes closest says the opposite: the section states
       * that turning a reminder family off is done in the Web Admin, because all three
       * flags are TENANT_WIDE and ADR-0010 wants a typed confirmation there.
       *
       * What this list pins is the SET of keys the runtime source names, not the set it
       * was observed sending — `sent` is scraped from the file. Adding a key here is
       * therefore a review checkpoint rather than a reachability proof, which is
       * exactly what the surrounding comment says it is for.
       */
      'bot.admin.reminder_choose',
      'bot.admin.reminder_expiry_first_button',
      'bot.admin.reminder_expiry_second_button',
      'bot.admin.reminder_refused',
      'bot.admin.reminder_saved',
      'bot.admin.reminder_usage_final_button',
      'bot.admin.reminder_usage_first_button',
      'bot.admin.reminder_usage_second_button',
      'bot.admin.reminders_button',
      'bot.admin.reminders_section',
      'bot.admin.revoke_button',
      'bot.admin.revoked',
      'bot.admin.roles_set',
      'bot.admin.section',
      'bot.admin.section_button',
      'bot.admin.service',
      /*
       * The disambiguation screen (the Codex round on this branch). It carries no
       * action and no identity: one button per match, each opening the ordinary
       * detail. The detail is where the panel and the customer are named, and where
       * the seven action buttons live — a screen that has not established WHICH
       * service the operator means must not offer to end one.
       */
      'bot.admin.service_ambiguous',
      'bot.admin.service_customer_button',
      'bot.admin.service_gone',
      'bot.admin.service_planned',
      'bot.admin.service_reconcile_button',
      'bot.admin.service_resend_button',
      'bot.admin.service_resent',
      'bot.admin.service_resume_button',
      'bot.admin.service_retry_button',
      // RickPanel rotation: a button, the question it asks, and the confirmation. None
      // carries a link, old or new; the customer receives the new one from delivery.
      'bot.admin.service_rotate_link_ask',
      'bot.admin.service_rotate_link_button',
      'bot.admin.service_rotate_link_confirm_button',
      'bot.admin.service_suspend_button',
      'bot.admin.service_sync_button',
      'bot.admin.service_terminate_ask',
      'bot.admin.service_terminate_button',
      'bot.admin.service_terminate_confirm_button',
      'bot.admin.service_unavailable',
      /*
       * WP3's seven, the browsable half of the services section and the two things a
       * service screen was missing. Reviewed against the same rule, and against the
       * one that matters most for a screen about somebody's ACCOUNT: none of them
       * carries a subscription URL, a subscription ref or a provider client id. What
       * the browse list prints is the provider username, which is the handle an
       * operator types into the panel and is not a credential — the queue above it has
       * printed exactly that since 6A.
       *
       * `bot.admin.service_customer_button` links to `bot.admin.customer_detail`,
       * already in this list, so the two screens together still carry nothing the
       * customer bought beyond the one service the administrator was already looking
       * at.
       *
       * `bot.admin.service_usage` names `/service <username or id>`, which `intentOf`
       * parses and `telegram-command-menu.test.ts` proves is deliberately unregistered
       * — the same standing `/customer`, `/link` and `/role` have.
       */
      'bot.admin.service_usage',
      'bot.admin.services_back_button',
      'bot.admin.services_browse',
      'bot.admin.services_browse_button',
      'bot.admin.services_browse_none',
      'bot.admin.services_button',
      'bot.admin.services_more_button',
      'bot.admin.services_none',
      'bot.admin.services_section',
      'bot.admin.usage',
      'bot.admin.username_automatic_button',
      'bot.admin.username_button',
      'bot.admin.username_custom_button',
      'bot.admin.username_refused',
      'bot.admin.username_section',
      'bot.admin.username_strategy_prefix_random',
      'bot.admin.username_strategy_random',
      'bot.admin.username_strategy_telegram_id_random',
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
  it('pins the PRE-CONTRACT derivation, which nothing may mint from any more', () => {
    /*
     * Not a rule this product still follows — the opposite. A name is now chosen or
     * drawn under `service-username.ts`, canonicalised and reserved before the money
     * moves, and the four-to-twenty contract rejects the thirty-four characters below.
     *
     * This pins the OLD shape because several proofs are written as "what we mint is
     * not this", and a mutation that restores the derivation has to have something to
     * restore. `tests/unit/provider-ref.test.ts` names it as its mutation target.
     *
     * The rationale this comment used to carry — "deterministic, so a reconcile can ask
     * for this exact name" — was true and beside the point: a name STORED before the
     * provider call is askable-for just as well, and can exist before the service does.
     */
    const id = '01900000-0000-7000-8000-0000000000c1';
    expect(providerUsernameFor(id)).toBe('nx019000000000700080000000000000c1');
    expect(providerUsernameFor(id)).toBe(providerUsernameFor(id));
    expect(providerUsernameFor(id)).toMatch(/^nx[0-9a-f]{32}$/);
    expect(() => providerUsernameFor('not-a-uuid')).toThrow();
    // And the contract refuses it, which is the half that matters now: thirty-four
    // characters is outside four-to-twenty, so this shape can never be minted again.
    expect(isNewProviderUsername(providerUsernameFor(id))).toBe(false);
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
    // 33% of 1000 is 330; of 1001 it is 330.33, rounded UP to 331, so the customer pays
    // 670 — at most the 67% they were promised. This line used to pin 330, and its comment
    // called truncation the customer's favour; it is the tenant's: a smaller discount is a
    // larger bill. `docs/wp8-pricing-audit.md` P5 records the correction.
    expect(discountAmountMinor('PERCENTAGE', 1000n, 33n)).toBe(330n);
    expect(discountAmountMinor('PERCENTAGE', 1001n, 33n)).toBe(331n);
    expect(1001n - discountAmountMinor('PERCENTAGE', 1001n, 33n)).toBeLessThanOrEqual(
      (1001n * 67n) / 100n,
    );
    expect(discountAmountMinor('PERCENTAGE', 1000n, 100n)).toBe(1000n);
    expect(discountAmountMinor('FIXED_AMOUNT', 1000n, 250n)).toBe(250n);
    expect(discountAmountMinor('PERCENTAGE', 0n, 50n)).toBe(0n);
    expect(discountAmountMinor('PERCENTAGE', 1000n, 0n)).toBe(0n);
  });

  it('clamps a discount one unit below the subtotal, so no commercial total reaches zero', () => {
    // Payment File 02 §14 (D4): a total of 0 confirmed and could not be settled, so the
    // clamp leaves one payable minor unit — and a promo code still cannot mint a credit.
    expect(clampDiscount(1000n, 1500n)).toBe(999n);
    expect(clampDiscount(1000n, 1000n)).toBe(999n);
    expect(clampDiscount(1000n, 999n)).toBe(999n);
    expect(clampDiscount(1000n, 400n)).toBe(400n);
    expect(clampDiscount(1000n, -5n)).toBe(0n);
    // Nothing to take off a subtotal of one, or of nothing.
    expect(clampDiscount(1n, 1n)).toBe(0n);
    expect(clampDiscount(0n, 5n)).toBe(0n);
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
    SERVICE_ROTATE_ASK: SERVICE_ROTATE_ASK_CALLBACK_PREFIX,
    SERVICE_ROTATE: SERVICE_ROTATE_CALLBACK_PREFIX,
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

  /*
   * The two catalogue prefixes (WP5), and the only TWO-character ones.
   *
   * Every single character was taken, so `cg:` and `ck:` begin with `c` — the same
   * letter as confirm's `c:`. The shadowing case below is what proves that is safe:
   * `c:` is `c` then a colon and these are `c` then a letter, so neither begins the
   * other. Registered here rather than trusted, because a careless third one — `c:x`,
   * say — would route a page turn to "confirm this order" with nothing else noticing.
   */
  const PAGE_PREFIXES: Readonly<Record<string, string>> = {
    CATALOG_PAGE: CATALOG_PAGE_CALLBACK_PREFIX,
    CATEGORY: CATEGORY_CALLBACK_PREFIX,
  };

  const ALL_PREFIXES: Readonly<Record<string, string>> = {
    ...PREFIXES,
    ...PAIR_PREFIXES,
    ...PAGE_PREFIXES,
  };

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

  describe('the two catalogue callbacks', () => {
    /*
     * A page number and, for `ck:`, a category id — and nothing else survives the
     * boundary. `callback_data` is whatever the client sent; these cases are the ways a
     * modified client could try to turn a page turn into something else.
     */
    const category = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
    const tap = (data: string) => intentOf({ callback_query: { id: 'cbq', data } });

    it('routes a category-list page and carries the page through', () => {
      expect(tap(`${CATALOG_PAGE_CALLBACK_PREFIX}0`)).toMatchObject({
        intent: 'CATALOG_PAGE',
        page: 0,
      });
      expect(tap(`${CATALOG_PAGE_CALLBACK_PREFIX}7`)).toMatchObject({
        intent: 'CATALOG_PAGE',
        page: 7,
      });
    });

    it('routes a category page with BOTH its id and its page', () => {
      expect(tap(`${CATEGORY_CALLBACK_PREFIX}${category}.3`)).toMatchObject({
        intent: 'CATEGORY',
        targetId: category,
        page: 3,
      });
    });

    it.each([
      ['a negative page', '-1'],
      ['a leading zero', '01'],
      ['an exponent', '1e2'],
      ['a hex literal', '0x10'],
      ['whitespace', ' 1'],
      ['a fraction', '1.5'],
      ['nothing at all', ''],
      ['a page past the bound', String(CATALOG_BROWSE_MAX_PAGE + 1)],
    ])('refuses %s as a page', (_label, raw) => {
      /*
       * `Number` would accept most of these — `' 1'` is 1, `'1e2'` is 100, `'0x10'` is
       * 16 — which is why the parser is a digits-only pattern and not a cast. A page
       * that reached the query as something other than what the button said would be
       * a list position the customer never saw.
       */
      expect(parseCatalogPage(raw)).toBeNull();
      expect(tap(`${CATALOG_PAGE_CALLBACK_PREFIX}${raw}`).intent).toBe('UNSUPPORTED');
    });

    it('accepts exactly the bound and nothing above it', () => {
      expect(parseCatalogPage(String(CATALOG_BROWSE_MAX_PAGE))).toBe(CATALOG_BROWSE_MAX_PAGE);
    });

    it.each([
      ['a malformed id', `not-a-uuid.0`],
      ['no page', `${category}`],
      ['an extra segment', `${category}.0.1`],
      ['a bad page', `${category}.x`],
    ])('refuses a category callback with %s', (_label, payload) => {
      expect(tap(`${CATEGORY_CALLBACK_PREFIX}${payload}`).intent).toBe('UNSUPPORTED');
    });

    it('fits the largest category callback in 64 bytes', () => {
      // Two for the prefix's letters, one colon, 36 for the id, a dot and three digits.
      const largest = `${CATEGORY_CALLBACK_PREFIX}${category}.${CATALOG_BROWSE_MAX_PAGE}`;
      expect(Buffer.byteLength(largest, 'utf8')).toBeLessThanOrEqual(64);
    });
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

describe('what follows a settlement', () => {
  /*
   * The rule that decides whether `bot.service.provisioning` is sent after
   * `bot.order.settled`, tested as a pure function.
   *
   * It is a function rather than an inline ternary because of what happened when it was
   * one: no test in this repository settles a RENEW over Telegram, so removing the
   * purpose check — telling every paying customer their service was being created —
   * left the whole suite green. A rule that can only be reached through a webhook is a
   * rule the suite cannot distinguish from its absence.
   */
  it('promises a service only for the purpose that creates one', () => {
    expect(followUpForSettlement('NEW_SERVICE')).toEqual({
      followUpKey: 'bot.service.provisioning',
    });
  });

  it('says nothing further about a purpose that changes a service that exists', () => {
    /*
     * A renewal settles and CHANGES a service the customer already has. Telling them it
     * is being created describes something that is not happening, and they would then
     * wait for a link that is never coming — because they already have it.
     *
     * Every commercial purpose, from the frozen list, so a fourth one added later is
     * covered by this case rather than needing a new one.
     */
    for (const purpose of COMMERCIAL_ORDER_PURPOSES) {
      expect(followUpForSettlement(purpose), `${purpose} must promise nothing`).toEqual({});
    }
  });

  it('says nothing after a trial, which is never settled by a payment', () => {
    /*
     * WP6-A. A trial reaches PAID through `GRANT`, not through settlement, so this
     * follow-up is never reached for one — and its claim already answered
     * `bot.trial.issued`. Promising provisioning a second time would be two sentences
     * for one fact.
     */
    expect(followUpForSettlement('TRIAL')).toEqual({});
  });

  it('covers every purpose the contract declares', () => {
    /*
     * The three cases above between them must exhaust `ORDER_PURPOSES`. Without this a
     * purpose added to the contract would be silently untested by all of them.
     */
    expect([...COMMERCIAL_ORDER_PURPOSES, 'NEW_SERVICE', 'TRIAL'].sort()).toEqual(
      [...ORDER_PURPOSES].sort(),
    );
  });
});

/**
 * Every refusal the bot can answer with must be RENDERABLE with the values it sends.
 *
 * This is the rule behind two defects on this branch, and it is the rule rather than
 * either instance because both were invisible in exactly the same way. The resolver
 * validates values against the template's declaration; a missing required token refuses
 * the whole render; and the webhook must swallow a reply failure, because a non-200
 * makes Telegram redeliver the update for ever. So the customer is told NOTHING, the
 * durable write has already committed, and no test that checks which KEY a handler
 * returns can see it.
 */
describe('a refusal the customer can actually be told', () => {
  it('supplies every required token for every refusal key', () => {
    const missing: string[] = [];
    for (const key of new Set(Object.values(REFUSAL_REPLIES))) {
      const supplied = refusalValuesFor(key);
      for (const placeholder of templateDefinition(key).placeholders) {
        if (placeholder.required && supplied[placeholder.token] === undefined) {
          missing.push(`${key} needs {${placeholder.token}}`);
        }
      }
    }
    expect(missing, 'a refusal that cannot render tells the customer nothing').toStrictEqual([]);
  });

  // The instance that proved the rule: `{limit}` carries the cap so the constant and the
  // Persian sentence cannot disagree, which is exactly why it must be supplied.
  it('carries the receipt cap into the limit refusal', () => {
    expect(refusalValuesFor('bot.payment.receipt_limit' as TemplateKey)).toStrictEqual({
      limit: 5,
    });
  });
});

/**
 * Which `PhotoSize` becomes the receipt.
 *
 * Telegram documents `file_size` as OPTIONAL on a photo size, so a ranking that mixes
 * bytes and pixels compares 5 KB against 1920 and picks the thumbnail — the operator
 * then opens a receipt they cannot read, which is a failure nothing else reports.
 */
describe('the customer’s caption on a receipt (D3)', () => {
  const sent = (message: Record<string, unknown>) =>
    intentOf({ message: { message_id: 9, chat: { id: 5, type: 'private' }, ...message } }).file;
  const photo = [{ file_id: 'full', file_unique_id: 'u-full', width: 800, height: 600 }];

  it('carries a photo’s or a document’s caption, trimmed, and none as null', () => {
    expect(sent({ photo, caption: '  از کارت همسرم  ' })?.caption).toBe('از کارت همسرم');
    expect(
      sent({ document: { file_id: 'd', file_unique_id: 'u-d' }, caption: 'رسید' })?.caption,
    ).toBe('رسید');
    expect(sent({ photo })?.caption).toBeNull();
    expect(sent({ photo, caption: '   ' })?.caption).toBeNull();
    expect(sent({ photo, caption: 42 })?.caption).toBeNull();
  });

  it('bounds it to 1024 characters, counted as the database counts them', () => {
    // A code point outside the BMP is TWO UTF-16 units; slicing units could split it.
    const long = '😀'.repeat(1_500);
    const caption = sent({ photo, caption: long })?.caption ?? '';
    expect(Array.from(caption)).toHaveLength(RECEIPT_CAPTION_MAX_LENGTH);
    expect(caption).toBe('😀'.repeat(RECEIPT_CAPTION_MAX_LENGTH));
    expect(normalizeReceiptCaption('x'.repeat(RECEIPT_CAPTION_MAX_LENGTH))).toHaveLength(
      RECEIPT_CAPTION_MAX_LENGTH,
    );
  });
});

describe('choosing a photo size', () => {
  const photo = (over: Record<string, unknown>) => ({
    message: {
      message_id: 9,
      chat: { id: 5, type: 'private' },
      photo: over['photo'],
    },
  });
  const chosen = (sizes: readonly unknown[]): string | null =>
    intentOf(photo({ photo: sizes })).file?.fileId ?? null;

  it('prefers the larger image when only the thumbnail declares its size', () => {
    expect(
      chosen([
        { file_id: 'thumb', file_unique_id: 'u-thumb', width: 90, height: 60, file_size: 5_000 },
        { file_id: 'full', file_unique_id: 'u-full', width: 1_920, height: 1_280 },
      ]),
    ).toBe('full');
  });

  it('breaks a tie between equal dimensions by declared size', () => {
    expect(
      chosen([
        { file_id: 'small', file_unique_id: 'u-s', width: 800, height: 600, file_size: 40_000 },
        { file_id: 'big', file_unique_id: 'u-b', width: 800, height: 600, file_size: 90_000 },
      ]),
    ).toBe('big');
  });

  it('does not let a wide, short crop outrank a taller image', () => {
    expect(
      chosen([
        { file_id: 'wide', file_unique_id: 'u-w', width: 1_200, height: 100 },
        { file_id: 'tall', file_unique_id: 'u-t', width: 900, height: 900 },
      ]),
    ).toBe('tall');
  });

  it('still chooses a size that declared no dimensions at all, rather than nothing', () => {
    expect(chosen([{ file_id: 'bare', file_unique_id: 'u-bare' }])).toBe('bare');
  });
});

describe('the Telegram Admin categories section, at the boundary', () => {
  /*
   * WP5. Every payload is client-supplied `callback_data`, so these are the ways a
   * modified client could try to turn one tap into another — above all an ASK into the
   * DELETE, and a page turn into a write.
   */
  const category = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
  const product = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51bb';
  const tap = (data: string) => intentOf({ callback_query: { id: 'cbq', data } });
  const typed = (text: string) => intentOf({ message: { text } });

  it('routes each of the nine category codes to its own intent, and no other', () => {
    const expected: Record<string, string> = {
      v: 'ADMIN_CATEGORY',
      a: 'ADMIN_CATEGORY_ACTIVATE',
      d: 'ADMIN_CATEGORY_DEACTIVATE',
      s: 'ADMIN_CATEGORY_SHOW',
      h: 'ADMIN_CATEGORY_HIDE',
      u: 'ADMIN_CATEGORY_UP',
      w: 'ADMIN_CATEGORY_DOWN',
      x: 'ADMIN_CATEGORY_DELETE_ASK',
      X: 'ADMIN_CATEGORY_DELETE',
    };
    for (const [code, intent] of Object.entries(expected)) {
      expect(tap(`kb:${code}:${category}`), `kb:${code}`).toMatchObject({
        intent,
        targetId: category,
      });
    }
  });

  it.each([
    ['an unknown code', `kb:q:${category}`],
    ['a missing id', 'kb:v:'],
    ['a v4 id', 'kb:v:0191f4a0-2d3c-4c2b-9a41-6f2b0c7e51aa'],
    ['a trailing segment', `kb:X:${category}:extra`],
    ['a page that is not a number', 'ka:one'],
    ['a page with a leading zero', 'ka:01'],
    ['a garbled product-list position', 'kc:not-a-token'],
    ['a picker with no page', `kd:${product}`],
    ['a picker with a v4 product', 'kd:0191f4a0-2d3c-4c2b-9a41-6f2b0c7e51aa.0'],
    ['a move with a truncated pair', `ke:${encodeIdPair(product, category).slice(1)}`],
  ])('refuses %s as UNSUPPORTED', (_label, data) => {
    expect(tap(data).intent).toBe('UNSUPPORTED');
  });

  it('carries a list page, a picker page and a product-list start through', () => {
    expect(tap('ka:3')).toMatchObject({ intent: 'ADMIN_CATEGORIES', page: 3 });
    expect(tap(`kd:${product}.2`)).toMatchObject({
      intent: 'ADMIN_CATEGORY_PICK',
      targetId: product,
      page: 2,
    });
    expect(tap('kc:')).toMatchObject({ intent: 'ADMIN_CATEGORY_PRODUCTS', cursor: null });
  });

  it('decodes a move into BOTH ids, product first, and fits it inside 64 bytes', () => {
    const data = `ke:${encodeIdPair(product, category)}`;
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    expect(tap(data)).toMatchObject({
      intent: 'ADMIN_CATEGORY_ASSIGN',
      targetId: product,
      secondaryId: category,
    });
  });

  it('carries a command argument untouched, spaces included, for the service to judge', () => {
    expect(typed('/category_new پلن های ویژه')).toMatchObject({
      intent: 'ADMIN_CATEGORY_NEW',
      args: ['پلن', 'های', 'ویژه'],
    });
    expect(typed(`/category_rename ${category} نام تازه`)).toMatchObject({
      intent: 'ADMIN_CATEGORY_RENAME',
      args: [category, 'نام', 'تازه'],
    });
    expect(typed(`/category_emoji ${category} -`)).toMatchObject({
      intent: 'ADMIN_CATEGORY_EMOJI',
      args: [category, '-'],
    });
  });

  it('lets no exported callback prefix begin another, across every section', async () => {
    /*
     * The registry above covers the customer prefixes by name. This one reads EVERY
     * exported `*_CALLBACK_PREFIX` from the module, so a new section cannot add a prefix
     * that shadows an old one without failing here — which matters more now that the
     * categories section is the first ADMIN one with two-character prefixes, `ka:` to
     * `ke:`, beside the one-character `k:` that TERMINATES a customer's service.
     *
     * One documented exception: `H:b:` is the services section's browse page and is a
     * sub-code of `H:` BY DESIGN — `H:` is matched by equality, so it never reaches a
     * `startsWith`. It is named here so that exception cannot grow silently.
     */
    const runtime = await import('../../apps/api/src/surfaces/telegram/bot-runtime.js');
    const prefixes = Object.entries(runtime)
      .filter(([name, value]) => name.endsWith('_CALLBACK_PREFIX') && typeof value === 'string')
      .map(([name, value]) => [name, value as string] as const)
      .filter(([name]) => name !== 'ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX');
    expect(prefixes.length, 'the export scan found almost nothing').toBeGreaterThan(50);
    for (const [name, one] of prefixes) {
      for (const [otherName, other] of prefixes) {
        if (name === otherName) continue;
        expect(one, `${name} and ${otherName} are the same prefix`).not.toBe(other);
        expect(
          other.startsWith(one),
          `${otherName} (${other}) is shadowed by ${name} (${one})`,
        ).toBe(false);
      }
    }
  });
});

/**
 * Payment File 02 §12 in Telegram, at the boundary: the three credit-to-wallet callbacks,
 * the reviewer's caption note, and the sentences a refused credit and a refused withdrawal
 * are answered with.
 */
describe('the credit-to-wallet disposition, at the boundary', () => {
  const payment = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51aa';
  const capture = '0191f4a0-2d3c-7c2b-9a41-6f2b0c7e51cc';
  const tap = (data: string) => intentOf({ callback_query: { id: 'cbq', data } });

  it('routes the open, the confirm and the cancel to their own intents, each naming one id', () => {
    expect(tap(`${ADMIN_CREDIT_CALLBACK_PREFIX}${payment}`)).toMatchObject({
      intent: 'ADMIN_CREDIT',
      targetId: payment,
    });
    expect(tap(`${ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX}${capture}`)).toMatchObject({
      intent: 'ADMIN_CREDIT_CONFIRM',
      targetId: capture,
    });
    expect(tap(`${ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX}${capture}`)).toMatchObject({
      intent: 'ADMIN_CREDIT_CANCEL',
      targetId: capture,
    });
    // The customer's own wallet payment is untouched by the two-character prefixes.
    expect(tap(`${WALLET_PAY_CALLBACK_PREFIX}${payment}`).intent).toBe('PAY_WALLET');
  });

  it.each([
    ['a v4 id', `wb:0191f4a0-2d3c-4c2b-9a41-6f2b0c7e51cc`],
    ['no id', 'wb:'],
    ['an amount smuggled beside the capture', `wb:${capture}.250000`],
    ['an amount in place of the payment', 'wa:250000'],
  ])('refuses %s as UNSUPPORTED', (_label, data) => {
    expect(tap(data).intent).toBe('UNSUPPORTED');
  });

  it('fits every credit callback inside Telegram’s 64 bytes', () => {
    for (const data of [
      `${ADMIN_CREDIT_CALLBACK_PREFIX}${payment}`,
      `${ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX}${capture}`,
      `${ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX}${capture}`,
    ]) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });

  it('reads a typed amount as ordinary text, which only a waiting capture may claim', () => {
    expect(intentOf({ message: { text: '۲۵۰٬۰۰۰' } })).toMatchObject({
      intent: 'USERNAME_TEXT',
      args: ['۲۵۰٬۰۰۰'],
    });
    // A command typed while a capture is open is still the command.
    expect(intentOf({ message: { text: '/start' } }).intent).toBe('START');
  });

  it('carries the customer’s note into the caption bounded, and a dash for none', () => {
    expect(reviewNoteOf(null)).toBe('—');
    expect(reviewNoteOf('   ')).toBe('—');
    expect(reviewNoteOf('از کارت همسرم')).toBe('از کارت همسرم');
    const long = '😀'.repeat(RECEIPT_REVIEW_NOTE_MAX + 10);
    const note = reviewNoteOf(long);
    expect(Array.from(note)).toHaveLength(RECEIPT_REVIEW_NOTE_MAX);
    expect(note.endsWith('…')).toBe(true);
  });

  const nexa = (code: string, details: Record<string, unknown> = {}) =>
    new NexaError({ kind: 'CONFLICT', code, message: 'x', details });

  it('answers the credit’s refusals about the payment, and rethrows everything else', () => {
    expect(creditRefusal(nexa(COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID)).key).toBe(
      'bot.admin.receipt_gone',
    );
    expect(
      creditRefusal(
        nexa(COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, { disposition: 'CREDITED_TO_WALLET' }),
      ).key,
    ).toBe('bot.admin.receipt_gone');
    expect(
      creditRefusal(nexa(COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID, { reason: 'NO_RECEIPT' })).key,
    ).toBe('bot.admin.credit_no_receipt');
    expect(creditRefusal(nexa(COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED)).key).toBe(
      'bot.admin.credit_currency',
    );
    expect(creditRefusal(nexa(COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND)).key).toBe(
      'bot.admin.receipt_gone',
    );
    // A permission denial is not a fact about the payment: `adminTurn` answers it as the
    // one refusal, and this must not pre-empt it.
    const denied = new NexaError({
      kind: 'PERMISSION_DENIED',
      code: 'platform.permission_denied',
      message: 'no',
    });
    expect(() => creditRefusal(denied)).toThrow(denied);
  });

  it('answers a refused withdrawal of a receipted transfer about the PAYMENT', () => {
    expect(withdrawalRefusal(nexa(COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW)).key).toBe(
      'bot.payment.withdraw_under_review',
    );
    // The shared table's order sentence speaks of cancelling an order — which a wallet
    // top-up has not got — and so is not the answer here.
    expect(REFUSAL_REPLIES[COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW]).toBe(
      'bot.order.transfer_under_review',
    );
    // Every other refusal still goes through the shared table.
    expect(withdrawalRefusal(nexa(COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE)).key).toBe(
      REFUSAL_REPLIES[COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE],
    );
  });
});
