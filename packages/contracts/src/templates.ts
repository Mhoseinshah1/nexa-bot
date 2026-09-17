import { CURRENCY_CODES, currencyCodeSchema, money, type Money } from './money.js';

/**
 * Customer-facing text.
 *
 * A message is addressed by a stable dotted key and stored RAW — never in its
 * rendered form. Placeholders are declared per key and validated.
 *
 * Three legacy defects motivate every rule here:
 *   - the Persian caption IS the identifier, so renaming a button renames its key;
 *   - the edit screen echoes the RENDERED text — `{first_name}` resolves in the
 *     viewing admin's own context — so the raw template cannot be read back from
 *     it, and saving from that view would bake the editor's own name into the
 *     template. The rendering is observed (TBR-TXT-004); the consequence is a
 *     HAZARD that was deliberately never tested, not a recorded event;
 *   - placeholders are unvalidated and overloaded — `{time}` means both "now"
 *     and "service duration", and units are hard-coded in copy, so one
 *     card-to-card template says تومان where its twin says ریال for the same
 *     `{price}`.
 *
 * Money is therefore never interpolated as a bare number: a `MONEY` placeholder
 * is rendered by the single Money formatter, so a unit cannot be typed by hand
 * into a template.
 *
 * Phase 0 shipped the key/placeholder machinery and the Translator port. Phase 2
 * adds what an administrator needs to change a body safely: a declared format
 * per key, required and repeatable placeholders, a body-length ceiling, and the
 * validator all three surfaces share. See
 * docs/adr/0016-template-defaults-and-overrides.md.
 */

export const PLACEHOLDER_TYPES = [
  'STRING',
  'NUMBER',
  'MONEY',
  'DATETIME',
  'DURATION_DAYS',
  'BYTES',
] as const;
export type PlaceholderType = (typeof PLACEHOLDER_TYPES)[number];

/**
 * What a placeholder token may look like.
 *
 * An ASCII identifier, and deliberately nothing wider. `اشتراک رایگان {تست}` is
 * a live legacy button caption in which the braces are DECORATION, not a token:
 * "a substitution engine that treats every `{…}` as a variable would erase this
 * caption" (C-TXT-009). Restricting the syntax means such text passes through
 * untouched, which in turn lets validation be strict about the expressions that
 * really are tokens — a mistyped `{first_nam}` is rejected instead of being
 * shipped to customers as literal text.
 *
 * A leading digit is excluded so a token is always a name.
 */
export const PLACEHOLDER_TOKEN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The same syntax, as a scanner over a template body. Stateless: no `g` flag. */
const PLACEHOLDER_EXPRESSION_SOURCE = '\\{([A-Za-z_][A-Za-z0-9_]*)\\}';

/** Every token-shaped expression in a body, in order, including repeats. */
export function placeholderTokensIn(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(new RegExp(PLACEHOLDER_EXPRESSION_SOURCE, 'g'))) {
    found.push(match[1] as string);
  }
  return found;
}

/**
 * How a rendered body is handed to the transport.
 *
 * `UNK-TXT-002` records that the legacy renderer's HTML contract is unstated:
 * the web help text says `<b>` is supported and must be preserved, while none of
 * the twenty Telegram templates that were read contained a tag. The corpus calls
 * that a contradiction and does not resolve it.
 *
 * We do not resolve it either. We decline to have one global answer: the format
 * is declared per key, so a key that needs markup says so and a key that does
 * not is sent as plain text with no parse mode at all.
 */
export const TEMPLATE_FORMATS = ['PLAIN_TEXT', 'TELEGRAM_HTML'] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];

/**
 * What a revision records.
 *
 * A `SET` stores the body; a `REVERT` stores none, because reverting goes back
 * to the default rather than copying it into tenant storage.
 */
export const TEMPLATE_REVISION_ACTIONS = ['SET', 'REVERT'] as const;
export type TemplateRevisionAction = (typeof TEMPLATE_REVISION_ACTIONS)[number];

export interface PlaceholderDefinition {
  readonly token: string;
  readonly type: PlaceholderType;
  readonly description: string;
  /**
   * Whether a body must contain this token.
   *
   * A required token that an override drops is a rejection. Dropping
   * `{correlationId}` from the ping reply does not fail; it silently removes the
   * only thing that made the message useful.
   */
  readonly required: boolean;
  /** Whether the token may appear more than once in one body. */
  readonly repeatable: boolean;
}

export interface TemplateDefinition {
  /** Stable machine key. Never a display string. */
  readonly key: string;
  readonly description: string;
  readonly format: TemplateFormat;
  readonly placeholders: readonly PlaceholderDefinition[];
}

/**
 * The longest body an override may store.
 *
 * Telegram's own message limit is 4,096 UTF-16 code units, so a longer body
 * could only ever fail at send time — with the failure landing on a customer's
 * message rather than on the administrator who typed it.
 *
 * The legacy limits are no help and are recorded as a conflict: the web phase
 * reports a 1,000-character cap while the text phase reports a counter reading
 * `n/8192` (`UNK-TXT-003`). Neither is adopted.
 */
export const TEMPLATE_BODY_MAX_LENGTH = 4096;

/**
 * The registered keys.
 *
 * Deliberately few, and they stay that way: a key is added when something in
 * this codebase actually sends it. Phase 0's docstring said "the ~650-key
 * catalog is authored alongside Phase 2", and that was wrong twice over. The
 * figure came from one of two irreconcilable readings of the legacy store
 * (`C-TXT-COUNT` in docs/open-questions.md), and the corpus warns explicitly
 * that a template's existence proves nothing about whether its feature is
 * enabled — three well-maintained legacy templates serve paths nobody walks
 * (TBR-TXT-010/011). Harvesting a catalogue would therefore import a feature
 * list we have not built.
 *
 * See docs/adr/0016-template-defaults-and-overrides.md.
 */
export const TEMPLATES = [
  {
    key: 'bot.ping.reply',
    description: 'Reply to the /ping health command.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'correlationId',
        type: 'STRING',
        description: 'Correlation id of the update.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.command.start',
    description: 'The one-line description Telegram shows beside /start in its command menu.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.command.catalog',
    description: 'The one-line description Telegram shows beside /catalog in its command menu.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.command.services',
    description: 'The one-line description Telegram shows beside /services in its command menu.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.command.wallet',
    description: 'The one-line description Telegram shows beside /wallet in its command menu.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.command.help',
    description: 'The one-line description Telegram shows beside /help in its command menu.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  /*
   * The four labels on the persistent main-menu keyboard.
   *
   * They are template keys for the reason every other customer-facing string is one —
   * `nexa-conventions` admits no literal in a surface, and the i18n missing-key check
   * covers what is declared here. What is DIFFERENT about them is stated where they are
   * used: `MAIN_MENU_ROWS` is a ROUTING table, and the surface reads these four from the
   * shared catalogue rather than from a tenant's overrides, because a label a tenant can
   * rename is a route a tenant can break.
   */
  {
    key: 'bot.menu.catalog',
    description: 'The main-menu button that opens the catalogue. Routes exactly as /catalog.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.menu.services',
    description:
      "The main-menu button that lists the customer's services. Routes exactly as /services.",
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.menu.wallet',
    description: 'The main-menu button that shows the wallet balance. Routes exactly as /wallet.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.menu.help',
    description:
      'The main-menu button that answers with the command list. Routes exactly as /help.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.help',
    description:
      'The list of what this bot can do, answered by /help. Exists because two of the ' +
      'four commands were discoverable only by guessing: `bot.start.welcome` names ' +
      '/catalog and nothing ever named /wallet or /services. Rendered from ' +
      '`BOT_COMMANDS`, which is also what `setMyCommands` registers, so the help text ' +
      'and Telegram\u2019s own command menu cannot drift apart.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.unknown_command',
    description: 'Shown when the bot receives a command it does not handle.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'error.internal',
    description: 'Generic failure message shown to a customer.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'error.permission_denied',
    description: 'Shown when an actor lacks a required permission.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },

  // Operations. Addressed to the people running the installation, not to
  // customers — but they are still text with placeholders, so they are still
  // templates, and an operator may still want to word them differently.
  {
    key: 'ops.notification.operational_event',
    description:
      'An operational event, projected into the operations destination. Sent once per ' +
      'deduplicated condition rather than once per occurrence, which is why the occurrence ' +
      'count is part of the message.',
    // The code is rendered in <code> so an operator can copy it into a filter.
    // This is the key that makes the per-key format contract real rather than
    // declarative: values interpolated here are HTML-escaped, values in a
    // PLAIN_TEXT template are not.
    format: 'TELEGRAM_HTML',
    placeholders: [
      {
        token: 'severity',
        type: 'STRING',
        description: 'DEBUG, INFO, WARN, ERROR or CRITICAL.',
        required: true,
        repeatable: false,
      },
      {
        token: 'code',
        type: 'STRING',
        description: 'The machine code of the condition.',
        required: true,
        repeatable: false,
      },
      {
        token: 'message',
        type: 'STRING',
        description: 'The human-readable message recorded with the event.',
        required: true,
        repeatable: false,
      },
      {
        token: 'occurrences',
        type: 'NUMBER',
        description: 'How many times this condition has fired since it was first seen.',
        required: false,
        repeatable: false,
      },
      {
        token: 'firstSeenAt',
        type: 'DATETIME',
        description: 'When the condition was first recorded.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'ops.notification.test',
    description:
      'Sent by an explicit test of the operations destination. The legacy log group could not ' +
      'be tested at all, and its forum topic id was never captured anywhere (UNK-GS-002), so a ' +
      'misconfigured destination was only ever discovered during an incident.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'requestedBy',
        type: 'STRING',
        description: 'Display name of the administrator who asked for the test.',
        required: true,
        repeatable: false,
      },
      {
        token: 'at',
        type: 'DATETIME',
        description: 'When the test was requested.',
        required: true,
        repeatable: false,
      },
    ],
  },

  // Customer-facing commerce — Phase 4.
  //
  // Every one of these is PLAIN_TEXT unless it interpolates something a reader must
  // be able to copy, because `TELEGRAM_HTML` means values are HTML-escaped and a
  // plain greeting has nothing to escape. The one exception is the subscription
  // link, which is rendered in <code> so a customer can tap to copy it.
  //
  // No template here interpolates a customer's own name. The legacy system baked an
  // admin's name into `{first_name}` for roughly 13,700 customers by saving a
  // RENDERED echo, and while the research corrects the detail of that incident the
  // hazard is real: a name placeholder is a placeholder whose value comes from a
  // third party and is rendered into a message sent to someone else. Greetings here
  // are name-free by design, and that is cheaper than an escaping rule.
  {
    key: 'bot.start.welcome',
    description: 'Greeting for a customer the installation has not seen before.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.start.welcome_back',
    description: 'Greeting for a returning customer.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.blocked',
    description:
      'Shown to a customer an operator has blocked. Says that the account cannot be ' +
      'served and nothing about why, because the reason is an operator note and not ' +
      'a statement the product makes to the person it is about.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.empty',
    description:
      'Shown when a tenant has no listed, priced, fulfillable product. The honest ' +
      'answer to an unconfigured catalogue, rather than an empty list that reads as ' +
      'a failure.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.heading',
    description: 'Introduces the product list.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.summary',
    description:
      'The server-calculated order summary a customer confirms. Every figure in it ' +
      'comes from the price quote, never from callback data.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'productTitle',
        type: 'STRING',
        description: 'The product title as snapshotted onto the order.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'MONEY',
        description: 'The server-calculated total.',
        required: true,
        repeatable: false,
      },
      {
        token: 'durationDays',
        type: 'DURATION_DAYS',
        description: 'Days of validity, or 0 for unlimited.',
        required: false,
        repeatable: false,
      },
      {
        token: 'trafficBytes',
        type: 'BYTES',
        description: 'Traffic allowance in bytes, or 0 for unlimited. The renderer owns the unit.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.order.awaiting_payment',
    description: 'Confirms that an order is recorded and waiting for payment.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'total',
        type: 'MONEY',
        description: 'The amount owed.',
        required: true,
        repeatable: false,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'When the unpaid order will expire.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.order.confirm_button',
    description:
      'The label on the button a customer presses to confirm the order summary. A ' +
      'button label is customer-facing text like any other, so it is a key rather ' +
      'than a literal in a surface — and a tenant that words its confirmation ' +
      'differently changes it here, not in code.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.unavailable',
    description:
      'Shown when a product cannot be ordered — withdrawn, unpriced, or not bound to ' +
      'a panel. ONE message for all three, deliberately: the operational log names ' +
      'which it was, and the customer can act on none of them. Telling them a plan ' +
      'has no panel is telling them about our configuration.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.expired',
    description:
      'Shown when an order is acted on after its own deadline has passed. TWO ' +
      'producers, and both are the same lapse: confirming a draft whose price hold ' +
      'expired, and — since 4C — paying for a confirmed order past the deadline the ' +
      'customer was shown in `bot.order.awaiting_payment`. Distinct from ' +
      '`bot.order.cancelled`: nobody withdrew this one, the window closed, and the ' +
      'customer has to start again rather than wonder what they did.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.not_awaiting_payment',
    description:
      'Shown when a customer taps a pay button on an order that is no longer ' +
      'awaiting payment — almost always the one they just paid for, because the ' +
      'awaiting-payment message keeps its buttons in the chat after settlement. ' +
      'It replaced `bot.order.unavailable` here, which says a PRODUCT cannot be ' +
      'bought and told a customer who had just been debited that their service was ' +
      'unavailable. Says only what is true of the ORDER and claims nothing about ' +
      'which state it reached, because a cancelled order reaches this too.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.settled',
    description:
      'Confirms that payment was accepted and the order is paid. It says nothing ' +
      'about a service: a phase that has not provisioned anything may not claim it ' +
      'has, and 4C is the phase that first sends this key. What follows a payment is ' +
      "a later phase's to announce, through its own key.",
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.cancelled',
    description:
      'Confirms that an order was withdrawn. Its producer, since 4H, is the customer’s ' +
      'own cancellation of an order they have not paid for. Distinct from ' +
      '`bot.order.expired`, which is the window closing on its own: this one is a ' +
      'decision the customer made, and a customer who is told their order “expired” ' +
      'when they cancelled it learns that the product did not register what they did.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.cancel_button',
    description:
      'The label on the button a customer presses to withdraw an order they have not ' +
      'paid for. A key rather than a literal, for the reason `bot.payment.wallet_button` ' +
      'gives. It is the ORDER, not the payment: `bot.payment.cancel_button` withdraws ' +
      'one transfer and leaves the order open to be paid another way, and these two ' +
      'appear in the same conversation, so neither label may read as the other.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.cancel_confirm',
    description:
      'The question between the cancel button and the cancellation itself. ' +
      '`bot.payment.cancel_confirm` is the same shape one aggregate over and exists for ' +
      'the same reason: the message carrying the button stays in the chat for ever, so a ' +
      'destructive tap reached by scrolling is not a decision the customer has made. It ' +
      'must say what cannot be taken back — `ORDER_MACHINE` has no edge out of ' +
      'CANCELLED, so the price they were quoted is gone and a new order starts at ' +
      'whatever the plan costs today.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.cancel_confirm_button',
    description:
      'The label on the one button that actually cancels the order. ' +
      '`bot.payment.cancel_confirm_button` is its counterpart one aggregate over, and ' +
      'both must read as an ANSWER to the question above them rather than as a fresh ' +
      'offer — that is what distinguishes the second tap from the first.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.order.transfer_under_review',
    description:
      'Shown when a customer asks to cancel an order whose transfer they have already ' +
      'said they sent. It is NOT a refusal to be argued with: it says the claim they ' +
      'made is queued for review and that money already sent cannot be unsent by ' +
      'cancelling the order it was for. Distinct from `bot.order.not_awaiting_payment`, ' +
      'which says the order can no longer be acted on — here the order is perfectly ' +
      'live and the customer’s own earlier claim is what stops them, so the sentence ' +
      'has to say so or they simply tap again.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.wallet.balance',
    description: "The customer's own balance, derived from the ledger.",
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'balance',
        type: 'MONEY',
        description: 'The derived balance.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.wallet.insufficient',
    description:
      'Shown when a wallet settlement is refused for want of funds. Carries the ' +
      'shortfall rather than the balance, because the shortfall is what the customer ' +
      'has to act on.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'shortfall',
        type: 'MONEY',
        description: 'How much more is needed.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.manual_instructions',
    description:
      'How to pay out of band, and how to submit the evidence. The instructions ' +
      'themselves are tenant copy — this installation ships no bank details and ' +
      'invents none.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'total',
        type: 'MONEY',
        description: 'The amount to transfer.',
        required: true,
        repeatable: false,
      },
      {
        token: 'reference',
        type: 'STRING',
        description: 'The reference the customer must quote.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.transfer_instructions',
    description:
      'How to pay out of band, with the destination the payment was ISSUED against. ' +
      'Supersedes bot.payment.manual_instructions, which is kept for payments created ' +
      'before a destination existed. {destination} is composed from the payment\u2019s ' +
      'frozen snapshot through the four bot.payment.destination.* keys, so a line whose ' +
      'field the tenant never configured is not composed at all \u2014 an optional ' +
      'placeholder could not do that, because an absent one renders as a literal ' +
      '{token}.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'destination',
        type: 'STRING',
        description: 'The bank, holder, card and Sheba lines, already rendered.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'MONEY',
        description: 'The amount to transfer.',
        required: true,
        repeatable: false,
      },
      {
        token: 'reference',
        type: 'STRING',
        description: 'The reference the customer must quote.',
        required: true,
        repeatable: false,
      },
    ],
  },
  /*
   * Four line keys rather than four placeholders on the message above.
   *
   * Each is one field of the frozen destination snapshot, rendered only when that field
   * is present. An optional placeholder cannot express that: `renderTemplateBody`
   * substitutes only the tokens it is given and leaves the rest exactly as written, so a
   * tenant who configured no Sheba would send the literal `{sheba}` to a customer.
   *
   * They are tenant-overridable like every other key here, which is the point — a
   * tenant who writes «به نام» where another writes
   * «صاحب حساب» changes one line and
   * nothing else. The token is `value` on all four rather than `card`, `sheba` and so on,
   * because the four are one shape and four differently-named declarations would be four
   * things to keep in step for no gain.
   */
  {
    key: 'bot.payment.destination.bank',
    description: 'One line of the transfer destination. The bank the account is held at.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'value',
        type: 'STRING',
        description: 'The field, taken from the payment’s frozen snapshot.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.destination.holder',
    description: 'One line of the transfer destination. The name the account is in.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'value',
        type: 'STRING',
        description: 'The field, taken from the payment’s frozen snapshot.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.destination.card',
    description:
      'One line of the transfer destination. The sixteen-digit card number, unseparated so it pastes into a banking app.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'value',
        type: 'STRING',
        description: 'The field, taken from the payment’s frozen snapshot.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.destination.sheba',
    description:
      'One line of the transfer destination. The Sheba — IR and twenty-four digits. The one field an account may not have.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'value',
        type: 'STRING',
        description: 'The field, taken from the payment’s frozen snapshot.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.copy_card_button',
    description:
      'Label on the button that copies the card number to the customer\u2019s clipboard. ' +
      'A Telegram CopyTextButton \u2014 it carries no callback data, reaches no handler ' +
      'and performs no action on the server.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.copy_amount_button',
    description:
      'Label on the button that copies the amount, as bare digits with no separators ' +
      'and no currency word, so it pastes into a banking app. Also a CopyTextButton.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.wallet_button',
    description:
      'The label on the button a customer presses to pay for an order from their ' +
      'wallet balance. A button label is customer-facing text like any other, so it ' +
      'is a key rather than a literal in a surface — the reason ' +
      '`bot.order.confirm_button` exists, applied to the pair of buttons the payment ' +
      'choice needs. It carries no amount: the figure a customer is agreeing to is in ' +
      '`bot.order.awaiting_payment`, and repeating it on a button is a second place ' +
      'for it to disagree.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.manual_button',
    description:
      'The label on the button a customer presses to pay for an order out of band. ' +
      'A key rather than a literal, for the reason `bot.payment.wallet_button` gives.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.unconfigured',
    description:
      'Shown when a customer chooses a payment method this installation has not ' +
      'configured. Names the situation rather than failing silently.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.received_for_review',
    description:
      'The answer to a customer pressing “I have sent it” on the message that gave ' +
      'them the reference. It must be careful about WHOSE claim it repeats: nothing has ' +
      'been received, nothing has been verified, and an operator has yet to look at a ' +
      'bank statement. What is true is that the customer’s claim is on record and ' +
      'somebody will check it, and the sentence says exactly that. A wording along the ' +
      'lines of “your payment was confirmed” would be the legacy receipt ' +
      'review’s defect in a message — `PRBR-004`, where “receipt” and ' +
      '“payment” name one record and nobody can tell a claim from a check.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.sent_button',
    description:
      'The label on the button a customer presses to say they have sent the transfer. A ' +
      'key rather than a literal, for the reason `bot.payment.wallet_button` gives. It ' +
      'sits beside `bot.payment.cancel_button` on the instructions message and is the ' +
      'opposite action, so the two labels must be impossible to confuse at a glance.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.window_too_short',
    description:
      'Shown when a customer chooses to pay out of band with too little of the order\u2019s ' +
      'own window left to do it in. It does NOT invite them to hurry: the remedy is a new ' +
      'order, because the one they are looking at is minutes from expiring and a transfer ' +
      'against it could not be confirmed afterwards.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.cancel_button',
    description:
      'The label on the button a customer presses to withdraw a pending out-of-band ' +
      'payment they started and decided not to make. A key rather than a literal, for ' +
      'the reason `bot.payment.wallet_button` gives. It exists because until this ' +
      'release a customer who changed their mind had exactly one option \u2014 never ' +
      'pay \u2014 and the payment stayed PENDING for ever with its reference live.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.cancel_confirm',
    description:
      'The question between the cancel button and the withdrawal itself. It must say the ' +
      'two things the customer cannot take back: the quoted reference stops being valid, ' +
      'and there is no way to undo it \u2014 a transfer sent against that reference ' +
      'afterwards cannot be matched to anything. The service detail\u2019s termination ' +
      'question is the same shape and exists for the same reason: a destructive tap that ' +
      'is one mis-touch away from a message the customer reads every time they open the ' +
      'chat is not a decision they have made.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.cancel_confirm_button',
    description:
      'The one button that carries the destructive prefix, answering ' +
      '`bot.payment.cancel_confirm`. A key rather than a literal, for the reason ' +
      '`bot.payment.wallet_button` gives.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.cancelled',
    description:
      'Confirms that a pending payment was withdrawn and that the quoted reference is ' +
      'no longer good. It does NOT say the order is gone: a withdrawal closes the ' +
      'payment and leaves the order open until its own deadline, so the customer may ' +
      'still pay by another method within the window.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.rejected',
    description:
      'Tells a customer an operator reviewed their manual transfer and did not accept ' +
      'it. Sent by the customer notification lane, not as a reply \u2014 the rejection ' +
      'happens while the customer is not looking. Says the payment is closed and the ' +
      'order is not: a rejection leaves the order open until its own deadline, so the ' +
      'customer may transfer again or pay from their wallet within the window.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.expired',
    description:
      'Tells a customer the payment window closed with nothing confirmed. Sent by the ' +
      'customer notification lane. Distinct from `bot.payment.rejected` because no ' +
      'person judged anything \u2014 a deadline passed \u2014 and a customer told ' +
      '"rejected" for a lapsed window would reasonably think somebody looked at it.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.not_pending',
    description:
      'Shown when a customer acts on a payment that has already ended \u2014 confirmed, ' +
      'withdrawn, rejected or expired. Its own key rather than the generic ' +
      '`bot.order.unavailable`, because this is the one refusal a customer reaches by ' +
      'scrolling back to an old message and pressing a button that was live when it was ' +
      'sent; telling them the thing is unavailable reads as a fault, and telling them it ' +
      'is no longer pending reads as what happened.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.list_empty',
    description: 'Shown when the customer has no services.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.list_heading',
    description:
      'Introduces the list of services a customer owns. Separate from ' +
      '`bot.catalog.heading` because the two lists are different things: one is what a ' +
      'customer could buy, the other what they already have, and a tenant will word ' +
      'them differently. The list itself is buttons, so this key carries no ' +
      'placeholders \u2014 a heading that interpolated a count would be a heading that ' +
      'went stale the moment a service expired between render and read.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.not_found',
    description:
      'Shown when a customer acts on a service id that is not theirs, or does not ' +
      'exist. ONE message for both, deliberately, and it is the reason this key is not ' +
      '`bot.unknown_command`: a tap on a stale button is not a typing mistake, and ' +
      'telling the two apart would let anybody holding a service id learn whether it ' +
      'exists by watching which answer they get. `getForCustomer` compares ownership ' +
      'against the row it read rather than filtering the query, so both cases already ' +
      'arrive here as the same outcome.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.resend_button',
    description:
      'The button that asks for a subscription link to be sent again. Its OWN key, ' +
      'because a button label is rendered with no values and `bot.service.subscription` ' +
      'requires a `subscriptionUrl` \u2014 using the message as the label made ' +
      '`validateTemplateValues` refuse the whole send, which is the template layer ' +
      'doing its job. It also has to be a different sentence: the label is a request ' +
      'and the message is the answer.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.detail',
    description:
      'One service, as its owner sees it. Usage and expiry come from the last ' +
      'successful sync and the message says so, because a figure with no asOf is a ' +
      'figure a customer will read as live.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'productTitle',
        type: 'STRING',
        description: 'The plan this service was bought as.',
        required: true,
        repeatable: false,
      },
      {
        token: 'state',
        type: 'STRING',
        description: 'The service state, already localised by the surface.',
        required: true,
        repeatable: false,
      },
      {
        token: 'usedTrafficBytes',
        type: 'BYTES',
        description: 'Traffic used, in bytes, as of the last sync.',
        required: false,
        repeatable: false,
      },
      {
        token: 'totalTrafficBytes',
        type: 'BYTES',
        description: 'Traffic allowance in bytes, or 0 for unlimited.',
        required: false,
        repeatable: false,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'When the service expires.',
        required: false,
        repeatable: false,
      },
      {
        token: 'syncedAt',
        type: 'DATETIME',
        description: 'When usage was last read from the provider.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.subscription',
    description:
      "The customer's subscription link. TELEGRAM_HTML so the link is rendered in " +
      '<code> and can be tapped to copy; this is the one customer-facing key where ' +
      'the format is load-bearing rather than incidental.',
    format: 'TELEGRAM_HTML',
    placeholders: [
      {
        token: 'subscriptionUrl',
        type: 'STRING',
        description: 'The subscription URL issued by the provider.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.provisioning',
    description:
      'Shown while a service is being created on a provider. Promises a follow-up ' +
      'rather than a duration, because the duration depends on somebody else.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.provision_delayed',
    description:
      'Shown when provisioning could not be completed and an operator has been told. ' +
      'Deliberately does NOT invite the customer to try again: a retry after an ' +
      'unknown outcome is how a duplicate account is created.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.suspend_button',
    description:
      'The button that asks for a service to be paused. Drawn only when the service ' +
      'is ACTIVE and the panel behind it declares DISABLE_USER \u2014 but not drawing ' +
      'it is never the control: `requestFromCustomer` checks ownership, the legal ' +
      'from-state and the panel capability again, so a tap on a stale message is ' +
      'refused rather than performed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.resume_button',
    description:
      'The button that asks for a paused service to start serving again. Drawn only ' +
      'when the service is SUSPENDED and the panel declares ENABLE_USER.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.terminate_button',
    description:
      'The button that BEGINS ending a service. It does not end one: it asks for the ' +
      'confirmation below. Its own key rather than a reuse of the confirm label ' +
      'because the two must not read alike \u2014 one opens a question and the other ' +
      'answers it, and a customer who cannot tell them apart will end a service by ' +
      'tapping twice in the same place.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.terminate_confirm',
    description:
      'The confirmation question, naming the service about to be ended and saying ' +
      'plainly that it cannot be undone. The only screen between a customer and the ' +
      'deletion of their provider account, so it states the consequence rather than ' +
      'asking "are you sure": the research records the legacy system destroying six ' +
      'order classes on one unconfirmed press.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'productTitle',
        type: 'STRING',
        description:
          'What the customer bought, from the order\u2019s frozen snapshot \u2014 ' +
          'never the service id, which is not a name a customer can recognise.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.renew_button',
    description:
      'The button that opens a renewal quote. It buys nothing: it shows the price and ' +
      'asks. Drawn only when the service is ACTIVE or EXPIRED, its product is still ' +
      'purchasable, and the panel declares RENEW_USER — and not drawing it is ' +
      'never the control, because every one of those is re-checked when the tap ' +
      'arrives and again when the money moves.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.add_traffic_button',
    description:
      'The button that lists the extra-traffic packages on offer. Drawn only when the ' +
      'service is ACTIVE, the panel declares ADD_VOLUME, and at least one package is ' +
      'configured and priced — an action with no configured price is explicitly ' +
      'unavailable rather than free.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.add_time_button',
    description:
      'The button that lists the extra-time packages on offer. Drawn under the same ' +
      'three conditions as extra traffic, against ADD_TIME.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_unavailable',
    description:
      'Shown when an action a customer asked for cannot be sold right now — no ' +
      'package is configured, the plan behind a renewal has been withdrawn, or the ' +
      'panel cannot perform it. One message for all three because the customer’s ' +
      'next step is the same and naming which would tell them about an operator’s ' +
      'configuration; the operational log carries the distinction an operator needs.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_not_allowed',
    description:
      'Shown when the SERVICE is not in a state this action means anything from — ' +
      'a terminated service cannot be renewed, a suspended one cannot be topped up. ' +
      'Distinct from the message above because the remedy is the customer’s ' +
      'rather than the operator’s.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_in_progress',
    description:
      'The one TRANSIENT commercial refusal: this service already has a renewal or a ' +
      'top-up the panel has not applied yet, so the next purchase waits. Its own key ' +
      'because the customer\u2019s next step is to try again in a moment, and every other ' +
      'refusal in this group means a thing that will not become possible by waiting. ' +
      'A shared sentence would send somebody whose renewal is seconds away to support.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.addon_choice',
    description:
      'The heading above the configured packages a customer may buy. The amounts and ' +
      'prices are on the BUTTONS, each of which carries a package id and nothing else ' +
      '— a callback is an intent and an identifier, never a quantity or a price.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.addon_option',
    description:
      'One package button: what it is called and what it costs. The AMOUNT is not here ' +
      'and is on `bot.service.action_quote`, the screen the customer answers — exactly ' +
      'where a product catalogue puts it, because a Telegram button label is one line ' +
      'and the figure that matters is the one beside the confirm button. Rendered from ' +
      'the row the operator configured, so a price a customer sees is the price the ' +
      'server will charge.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'title',
        type: 'STRING',
        description: 'The package’s own name, as the operator wrote it.',
        required: true,
        repeatable: false,
      },
      {
        token: 'price',
        type: 'MONEY',
        description:
          'What it costs, with its currency. A MONEY placeholder rather than a number, ' +
          'for the reason the whole catalogue uses one: the legacy system rendered the ' +
          'same figure as تومان on one template and ' +
          'ریال on its twin, a factor of ten apart.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.action_quote',
    description:
      'The offer a customer answers: what this action buys for this service, and what ' +
      'it costs. The number here is the number the order was written with — the ' +
      'quote is taken when the draft is made and never re-taken, so a customer is ' +
      'never charged a price they did not see.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'productTitle',
        type: 'STRING',
        description:
          'What is being bought — the plan’s title for a renewal, the ' +
          'package’s for a quantity purchase.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'MONEY',
        description: 'What it costs, with its currency.',
        required: true,
        repeatable: false,
      },
      /*
       * WHAT the customer is buying, beside what it costs.
       *
       * Optional because a renewal of an unlimited-in-one-direction plan has nothing to
       * say in that field, and zero here means "this purchase buys none of this" rather
       * than the UNLIMITED that the same zero means on a PRODUCT. The renderer owns that
       * distinction, which is why both are typed rather than pre-formatted numbers.
       *
       * They are here because a title is free text an operator wrote. «بسته ویژه» encodes
       * no allowance at all, and a screen that showed only that and a price let a
       * customer reach the payment buttons without ever being told how many bytes or
       * days they were buying. The frozen order line already carries both figures; not
       * rendering them was the omission.
       */
      {
        token: 'trafficBytes',
        type: 'BYTES',
        description:
          'Traffic this purchase adds, or 0 when it adds none. The renderer owns the ' +
          'unit, exactly as on `bot.order.summary`.',
        required: false,
        repeatable: false,
      },
      {
        token: 'durationDays',
        type: 'DURATION_DAYS',
        description: 'Days this purchase adds, or 0 when it adds none.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.action_confirm_button',
    description:
      'The button that commits the customer to the quote above and moves the order to ' +
      'awaiting payment. Its own key rather than a reuse of the purchase confirmation, ' +
      'because the two answer different questions and a shared label is a label that ' +
      'cannot say which.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.terminate_confirm_button',
    description:
      'The button that actually ends the service. The ONLY callback that plans a ' +
      'TERMINATE; every other path through this surface stops at the question above.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_requested',
    description:
      'Acknowledges that a pause, resume or end was recorded and is being applied to ' +
      'the panel. Deliberately does NOT say it is done: the provider call happens in ' +
      'the provisioner, seconds later, and can fail. Claiming completion here would ' +
      'be the fabricated success this codebase refuses \u2014 the same reason ' +
      '`bot.service.provisioning` says a service is being made rather than made.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_succeeded',
    description:
      'Tells a customer the pause, resume, end, renewal or allowance they asked for ' +
      'reached the panel. The counterpart to `bot.service.action_requested`, which ' +
      'deliberately claims only that the request was recorded \u2014 this is the ' +
      'message that says it actually happened, and without it the customer is never ' +
      'told, which for a renewal they have paid for is the gap this key closes.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.action_failed',
    description:
      'Tells a customer the action they asked for will not happen, so they can ask ' +
      'again or contact support rather than waiting for something that has stopped ' +
      'coming. Says nothing about WHY: a provider failure reason is operational detail ' +
      'and belongs in the operations log, not in a customer message.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.capability_unsupported',
    description:
      'Shown when the customer asks for something the panel behind their service ' +
      'cannot do. Names the limitation instead of failing quietly.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.discount.applied',
    description: 'Confirms a discount code and the amount it took off.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'code',
        type: 'STRING',
        description: 'The code, normalised to upper case.',
        required: true,
        repeatable: false,
      },
      {
        token: 'amount',
        type: 'MONEY',
        description: 'How much was taken off.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.discount.rejected',
    description:
      'Shown when a code cannot be applied. One message for every reason: telling a ' +
      'customer whether a code exists but is exhausted is an oracle for guessing ' +
      'codes.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.referral.invite',
    description: "The customer's own referral code, for sharing.",
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'referralCode',
        type: 'STRING',
        description: "The customer's derived referral code.",
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.referral.unconfigured',
    description:
      'Shown when a tenant has not configured a referral reward. The feature is ' +
      'disabled rather than paying zero.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.unavailable',
    description:
      'Shown when a trial cannot be issued — unconfigured, already taken, or the ' +
      'configured product is unavailable. One message, for the reason the discount ' +
      'rejection gives.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.issued',
    description: 'Confirms that a trial service is being created.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
] as const satisfies readonly TemplateDefinition[];

export type TemplateKey = (typeof TEMPLATES)[number]['key'];

export const TEMPLATE_KEYS: readonly TemplateKey[] = TEMPLATES.map((t) => t.key as TemplateKey);

const TEMPLATE_BY_KEY = new Map<string, TemplateDefinition>(TEMPLATES.map((t) => [t.key, t]));

export function templateDefinition(key: TemplateKey): TemplateDefinition {
  const found = TEMPLATE_BY_KEY.get(key);
  if (!found) {
    throw new Error(`Unknown template key: ${key}. Template keys are a frozen contract.`);
  }
  return found;
}

export function isTemplateKey(value: string): value is TemplateKey {
  return TEMPLATE_BY_KEY.has(value);
}

/**
 * A value supplied for one declared placeholder.
 *
 * `Money` is a member so that a `MONEY` placeholder cannot be satisfied by a
 * bare number. The legacy system's `{price}` is a bare number with its unit
 * typed into the surrounding copy, which is how one card-to-card template came
 * to say تومان where its twin says ریال for the same token.
 */
export type TemplateValue = string | number | bigint | Date | Money;

/** Values supplied for a template's declared placeholders. */
export type TemplateValues = Readonly<Record<string, TemplateValue>>;

export function isMoneyValue(value: TemplateValue): value is Money {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    'amountMinor' in value &&
    'currency' in value
  );
}

/**
 * One sample value, as a text field can hold it, turned into the type its
 * placeholder declares.
 *
 * A preview form is text inputs, and a `DATETIME` placeholder needs a `Date`
 * while a `MONEY` one needs an amount AND a currency. Without a coercion at the
 * seam, those two placeholder types were unreachable from the admin screen and
 * a `NUMBER` one was rejected on every attempt — the field could only ever send
 * a string, and the validator only ever accepted a number.
 *
 * The text forms are stated once, here, rather than in each surface:
 *
 *   - `NUMBER`, `DURATION_DAYS`, `BYTES` — a whole number, e.g. `30`.
 *   - `DATETIME` — anything `Date` parses, in practice ISO-8601, e.g.
 *     `2026-09-02T08:00:00Z`.
 *   - `MONEY` — minor units and a currency, e.g. `1250000 IRR`. Two parts on
 *     purpose: the legacy `{price}` is a bare number whose unit lives in the
 *     surrounding copy, which is how one card-to-card template came to say
 *     تومان where its twin says ریال for the same token.
 *   - `STRING` — itself.
 *
 * A refusal names the token and the form expected, because the person typing is
 * the person who has to fix it.
 */
export type CoercedTemplateValue =
  | { readonly ok: true; readonly value: TemplateValue }
  | { readonly ok: false; readonly problem: string };

export function coerceTemplateValue(
  placeholder: PlaceholderDefinition,
  raw: string,
): CoercedTemplateValue {
  const bad = (expected: string): CoercedTemplateValue => ({
    ok: false,
    problem: `{${placeholder.token}} is declared ${placeholder.type} and needs ${expected}; received ${JSON.stringify(raw)}.`,
  });

  switch (placeholder.type) {
    case 'STRING':
      return { ok: true, value: raw };

    case 'NUMBER':
    case 'DURATION_DAYS':
    case 'BYTES': {
      const trimmed = raw.trim();
      // A whole number, and `Number('')` is 0 — which would silently turn an
      // empty field into a supplied zero, and zero means something specific
      // enough in this system to have its own registry field.
      if (!/^-?\d{1,20}$/.test(trimmed)) return bad('a whole number such as 30');

      // And a number JavaScript can actually hold. `Number('9'.repeat(400))` is
      // `Infinity` and `Number('9007199254740993')` is a DIFFERENT integer —
      // both of which would have been rendered into a preview whose whole
      // purpose is showing the administrator what they will really get.
      // `money()` refuses an unsafe integer for the same reason; this branch
      // was the one that did not.
      const value = Number(trimmed);
      if (!Number.isSafeInteger(value)) {
        return bad('a whole number JavaScript can represent exactly');
      }
      return { ok: true, value };
    }

    case 'DATETIME': {
      const trimmed = raw.trim();
      // ISO-8601 or nothing. `new Date` alone accepts JavaScript's legacy
      // parsing, under which `'0'` is the year 2000 and `'2026-02-30'` is the
      // 2nd of March — a typo silently becoming a plausible date, in a
      // preview that exists to show what will really be sent.
      if (
        !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(
          trimmed,
        )
      ) {
        return bad('an ISO-8601 date such as 2026-09-02T08:00:00Z');
      }
      const at = new Date(trimmed);
      if (Number.isNaN(at.getTime())) {
        return bad('an ISO-8601 date such as 2026-09-02T08:00:00Z');
      }
      // A date that does not round-trip is one `Date` silently rolled over:
      // `2026-02-30` parses and comes back as the 2nd of March.
      //
      // Compared against the date AS WRITTEN, not against its UTC form. The
      // first version compared `toISOString()` with the typed prefix, which
      // rejected every valid offset that crosses midnight —
      // `2026-09-02T00:30:00+02:00` is the 1st of September in UTC — after the
      // pattern above had explicitly accepted offsets.
      const [year = 0, month = 0, day = 0] = trimmed.slice(0, 10).split('-').map(Number);
      const asWritten = new Date(Date.UTC(year, month - 1, day));
      if (
        asWritten.getUTCFullYear() !== year ||
        asWritten.getUTCMonth() !== month - 1 ||
        asWritten.getUTCDate() !== day
      ) {
        return bad('a real calendar date');
      }
      return { ok: true, value: at };
    }

    case 'MONEY': {
      // The amount is BOUNDED. `BigInt` accepts a million digits and the money
      // formatter's thousands-separator regex is quadratic in the digit count,
      // so an unbounded amount from a `templates.view` holder was a one-request
      // way to stall the event loop.
      const match = /^(-?\d{1,30})\s+([A-Za-z]{3,4})$/.exec(raw.trim());
      if (!match?.[1] || !match[2]) {
        return bad('minor units and a currency, such as 1250000 IRR');
      }
      const currency = currencyCodeSchema.safeParse(match[2].toUpperCase());
      if (!currency.success) {
        return bad(`a known currency, one of ${CURRENCY_CODES.join(', ')}`);
      }
      return { ok: true, value: money(BigInt(match[1]), currency.data) };
    }
  }
}

/**
 * A whole form of sample values, coerced together.
 *
 * Every field is attempted even after one fails, so a form with three wrong
 * fields reports three problems rather than the first one three times.
 */
export function coerceTemplateValues(
  definition: TemplateDefinition,
  raw: Readonly<Record<string, string>>,
): { readonly values: TemplateValues; readonly problems: readonly string[] } {
  const values: Record<string, TemplateValue> = {};
  const problems: string[] = [];

  for (const placeholder of definition.placeholders) {
    // `hasOwnProperty`, not a bare index. A token is an ASCII identifier, and
    // `toString` and `constructor` are ASCII identifiers: reading one straight
    // off the object returns a function from `Object.prototype`, and the
    // `.trim()` below then throws a TypeError out of a preview. No template
    // declares such a token today, which is precisely why it would have been
    // found by whoever added the first one.
    const supplied = Object.prototype.hasOwnProperty.call(raw, placeholder.token)
      ? raw[placeholder.token]
      : undefined;
    // An absent field and an empty one both mean "no sample for this token".
    // The preview reports it as unresolved and leaves the token in place.
    if (typeof supplied !== 'string' || supplied.trim() === '') continue;

    const coerced = coerceTemplateValue(placeholder, supplied);
    if (coerced.ok) values[placeholder.token] = coerced.value;
    else problems.push(coerced.problem);
  }

  // A token the catalogue does not declare cannot be rendered and is not
  // silently dropped: an administrator who typed one is told, rather than
  // shown a preview that ignored their input.
  for (const token of Object.keys(raw)) {
    if (!definition.placeholders.some((placeholder) => placeholder.token === token)) {
      problems.push(`{${token}} is not declared for this template.`);
    }
  }

  return { values, problems };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Why a body was refused.
 *
 * Structured rather than a string, because three surfaces render these: the web
 * editor beside the field, the HTTP layer as an error payload, and the tests as
 * assertions. A prose sentence would be re-parsed by at least one of them.
 */
export const TEMPLATE_BODY_ISSUES = [
  'EMPTY',
  'TOO_LONG',
  'UNKNOWN_PLACEHOLDER',
  'MISSING_REQUIRED_PLACEHOLDER',
  'REPEATED_PLACEHOLDER',
] as const;
export type TemplateBodyIssueKind = (typeof TEMPLATE_BODY_ISSUES)[number];

export interface TemplateBodyIssue {
  readonly kind: TemplateBodyIssueKind;
  /** The offending token, where the issue is about one. */
  readonly token?: string;
  readonly detail: string;
}

/**
 * Validates a raw body against one key's declaration.
 *
 * Pure, and exported from the frozen contracts on purpose: the web editor, the
 * application service and the tests must agree on what is valid, and the way to
 * guarantee that is for there to be one function rather than three that look
 * alike.
 *
 * Takes a definition rather than a key so the rules can be exercised against a
 * declaration that is not in the registry. Every branch of the type check below
 * is reachable that way, including the ones for placeholder types no registered
 * key uses yet — the type vocabulary is a Phase 0 contract, and a rule that
 * cannot be tested until some future phase registers a key is a rule nobody has
 * checked.
 *
 * Placeholders are checked against THIS KEY's declaration and never against a
 * global vocabulary. In the legacy system `{time}` means "now" in the start text
 * and "service duration" in the renewal invoice; a global vocabulary would have
 * to pick one and would be wrong in the other template.
 */
export function validateTemplateBody(
  definition: TemplateDefinition,
  body: string,
): TemplateBodyIssue[] {
  const key = definition.key;
  const issues: TemplateBodyIssue[] = [];

  if (body.trim().length === 0) {
    issues.push({ kind: 'EMPTY', detail: 'A template body may not be empty or only whitespace.' });
  }
  if (body.length > TEMPLATE_BODY_MAX_LENGTH) {
    issues.push({
      kind: 'TOO_LONG',
      detail: `A template body may be at most ${TEMPLATE_BODY_MAX_LENGTH} characters; this one is ${body.length}.`,
    });
  }

  const declared = new Map(definition.placeholders.map((p) => [p.token, p]));
  const used = placeholderTokensIn(body);
  const counts = new Map<string, number>();
  for (const token of used) counts.set(token, (counts.get(token) ?? 0) + 1);

  for (const [token, count] of counts) {
    const placeholder = declared.get(token);
    if (!placeholder) {
      issues.push({
        kind: 'UNKNOWN_PLACEHOLDER',
        token,
        detail: `{${token}} is not declared for ${key}. A token this key does not declare would be sent to customers as literal text.`,
      });
      continue;
    }
    if (count > 1 && !placeholder.repeatable) {
      issues.push({
        kind: 'REPEATED_PLACEHOLDER',
        token,
        detail: `{${token}} may appear only once in ${key}; it appears ${count} times.`,
      });
    }
  }

  for (const placeholder of definition.placeholders) {
    if (placeholder.required && !counts.has(placeholder.token)) {
      issues.push({
        kind: 'MISSING_REQUIRED_PLACEHOLDER',
        token: placeholder.token,
        detail: `${key} requires {${placeholder.token}}: ${placeholder.description}`,
      });
    }
  }

  return issues;
}

/**
 * Checks that supplied values match their declared types.
 *
 * Separate from body validation because it answers a different question at a
 * different time: a body is validated when an administrator saves it, values are
 * validated when a message is rendered.
 *
 * `requireAll` distinguishes the two callers. Sending a message with a required
 * placeholder unsupplied is a bug, and refusing it is right. PREVIEWING one is
 * not: an administrator asking what a body will look like has usually typed no
 * sample values at all, and the honest answer is the body with its placeholders
 * still visible, reported as unresolved — not an error message.
 */
export function validateTemplateValues(
  definition: TemplateDefinition,
  values: TemplateValues,
  options: { readonly requireAll?: boolean } = {},
): string[] {
  const requireAll = options.requireAll ?? true;
  const problems: string[] = [];
  for (const placeholder of definition.placeholders) {
    const value = values[placeholder.token];
    if (value === undefined) {
      if (placeholder.required && requireAll) {
        problems.push(`Missing value for {${placeholder.token}}.`);
      }
      continue;
    }
    const wrong = (expected: string) =>
      problems.push(
        `{${placeholder.token}} is declared ${placeholder.type} and needs ${expected}; received ${
          isMoneyValue(value) ? 'Money' : value instanceof Date ? 'Date' : typeof value
        }.`,
      );

    switch (placeholder.type) {
      case 'MONEY':
        if (!isMoneyValue(value)) wrong('a Money value');
        break;
      case 'DATETIME':
        if (!(value instanceof Date)) wrong('a Date');
        break;
      case 'NUMBER':
      case 'DURATION_DAYS':
      case 'BYTES':
        if (typeof value !== 'number' && typeof value !== 'bigint') wrong('a number or bigint');
        break;
      case 'STRING':
        if (typeof value !== 'string') wrong('a string');
        break;
    }
  }
  return problems;
}

/**
 * The translation port.
 *
 * Declared here so domain and application code can render text without
 * depending on any i18n implementation. `@nexa/i18n` implements it for both the
 * server/Telegram side and the web shell — one catalogue, two consumers.
 *
 * Surfaces may not pass raw strings to a send call; CI rejects it.
 */
export interface Translator {
  readonly locale: string;
  translate(key: TemplateKey, values?: TemplateValues): string;
  has(key: TemplateKey): boolean;
}
