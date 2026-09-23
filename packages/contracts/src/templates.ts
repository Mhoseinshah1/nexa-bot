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
    description:
      'Introduces the product list — which, since categories, is the list INSIDE one ' +
      'category. Reused rather than replaced so an override a tenant already wrote ' +
      'keeps working. The category NAME is not a placeholder: it is an ' +
      'operator-editable row, and the button the customer tapped already carries it.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.categories_heading',
    description:
      'Introduces the CATEGORY list — the first step of the two-step browse. A ' +
      'category appears here only when it has at least one product the customer ' +
      'could actually buy, so this list never offers a dead end.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.category_empty',
    description:
      'The category the customer tapped has nothing left to sell — its last product ' +
      'was withdrawn between the two taps. An ordinary outcome rather than an error, ' +
      'and deliberately NOT the same sentence as an unconfigured catalogue: the shop ' +
      'has other categories and this one says so.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.next_page_button',
    description: 'Moves to the next page. Drawn only when a next page really exists.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.previous_page_button',
    description: 'Moves back a page. Drawn only when the customer is past the first.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.catalog.back_to_categories_button',
    description: 'Returns from a product page to the category list.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.choose',
    description:
      'Asks which of the two username modes the customer wants. Sent only when the ' +
      "panel's policy allows both; with one enabled the question has no answer to " +
      'give and that mode runs directly.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.custom_button',
    description: 'The button that starts the custom-username prompt.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.automatic_button',
    description: 'The button that has the installation generate the username.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.instructions',
    description:
      'States the whole custom-username rule before the customer types: length, the ' +
      'accepted characters, the letter-and-digit requirement, and that case is not ' +
      'distinguished. Carries no payload, so a rule change is a copy change and the ' +
      'shared validator stays the single decider.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.invalid',
    description:
      'Refuses a username that does not satisfy the stated rule. Deliberately does ' +
      'not name which clause failed — the rule is shown in full beforehand, and a ' +
      'per-clause answer is a probe.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.taken',
    description:
      'Refuses a username already held on the same provider namespace, and says no ' +
      'money moved. Sent before any debit, so the statement is a fact about the ' +
      'order rather than a reassurance.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.exhausted',
    description:
      'The panel\u2019s automatic generator drew five candidates and every one was ' +
      'already held. Separate from `bot.username.taken` because the customer did ' +
      'nothing wrong and typing a different name is not the remedy \u2014 there is ' +
      'nothing for them to do but try again or ask. Sent before any debit.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.unavailable',
    description:
      'The panel\u2019s automatic configuration cannot produce a name for THIS ' +
      'purchase \u2014 the commonest case being a Telegram id long enough to push ' +
      '`TELEGRAM_ID_RANDOM` past the length limit. It names no configuration and no ' +
      'panel: an operator fixes this, and a customer being shown the internals of a ' +
      'generator learns nothing they can act on. Sent before any debit.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.mode_unavailable',
    description:
      'The customer tapped the typed-name button and the panel no longer offers ' +
      'typed names — an operator changed the policy after the button was drawn. ' +
      'The mirror of `bot.username.unavailable`, which is the same refusal the other ' +
      'way round, and it points at the choice that IS available rather than naming ' +
      'the policy that changed. Sent before any window opens and before any debit.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.username.stale',
    description:
      'An unpaid order was holding a name the current rules would not accept, so the ' +
      'hold was released and the customer chooses again. Safe precisely because no ' +
      'money has moved, which the body says.',
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
      {
        /*
         * The name the service will carry, in the summary the customer AGREES to.
         *
         * Optional because a tenant may have overridden this body before the username
         * step existed, and a required token would then throw in the resolver rather
         * than degrade — an order a customer cannot place at all, over a line of copy.
         *
         * The value is the CANONICAL lowercase form and never what they typed. Showing
         * the typed spelling here would mean the summary and the panel account say two
         * different things for every customer who used a capital.
         */
        token: 'username',
        type: 'STRING',
        description: 'The canonical username reserved for this order.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.order.summary_discounted',
    description:
      'The order summary for a quote with a discount (WP8). The plain summary plus the ' +
      'subtotal and the amount taken off, because a total the customer cannot reconcile ' +
      'with the list price reads as a mistake. Every figure comes from the price quote.',
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
      {
        /* Optional and canonical, for the reasons `bot.order.summary` gives. */
        token: 'username',
        type: 'STRING',
        description: 'The canonical username reserved for this order.',
        required: false,
        repeatable: false,
      },
      {
        token: 'subtotal',
        type: 'MONEY',
        description: "The price before any discount: the quote's BASE_PRICE amount.",
        required: true,
        repeatable: false,
      },
      {
        token: 'discount',
        type: 'MONEY',
        description:
          'The total the applied discounts took off, from the quote trace. Always greater than zero on this variant.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.order.summary_cashback',
    description:
      'The order summary for a quote that promises cashback and has no discount (WP8). ' +
      'Says the cashback is credited after delivery and nothing about when: it is a ' +
      'promise recorded at confirmation, not money moved.',
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
      {
        /* Optional and canonical, for the reasons `bot.order.summary` gives. */
        token: 'username',
        type: 'STRING',
        description: 'The canonical username reserved for this order.',
        required: false,
        repeatable: false,
      },
      {
        token: 'cashback',
        type: 'MONEY',
        description:
          'The cashback the quote promises, credited to the wallet after delivery. Always greater than zero on this variant.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.order.summary_discounted_cashback',
    description:
      'The order summary for a quote with both a discount and a cashback promise (WP8). ' +
      'A variant rather than optional lines, because the renderer has no conditional ' +
      'lines and a missing value renders as its token.',
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
      {
        /* Optional and canonical, for the reasons `bot.order.summary` gives. */
        token: 'username',
        type: 'STRING',
        description: 'The canonical username reserved for this order.',
        required: false,
        repeatable: false,
      },
      {
        token: 'subtotal',
        type: 'MONEY',
        description: "The price before any discount: the quote's BASE_PRICE amount.",
        required: true,
        repeatable: false,
      },
      {
        token: 'discount',
        type: 'MONEY',
        description:
          'The total the applied discounts took off, from the quote trace. Always greater than zero on this variant.',
        required: true,
        repeatable: false,
      },
      {
        token: 'cashback',
        type: 'MONEY',
        description:
          'The cashback the quote promises, credited to the wallet after delivery. Always greater than zero on this variant.',
        required: true,
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
    key: 'bot.order.terms_changed',
    description:
      "Shown at confirmation when a reseller's price changed between the summary and the " +
      'tap — a tier re-priced, an override changed, a suspension or a new registration ' +
      '(`docs/wp9-reseller-audit.md` R9). Modelled on `bot.discount.no_longer_valid`: ' +
      'nothing was charged, the order was not re-priced, and the customer starts again and ' +
      'sees the quote as it now stands. It names no tier and no rate, so it tells nobody ' +
      'how the seller prices its resellers.',
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
    key: 'bot.order.refunded_to_wallet',
    description:
      'Told to a customer whose money arrived and whose order this installation ' +
      'could not deliver: the amount is back on their wallet and they may buy ' +
      'again or withdraw it. The only sentence that follows a paid order which ' +
      'produced no service, because there is no third outcome — the product has ' +
      'no “we owe you one, an operator will look at it” state, and the sentence ' +
      'that used to stand in for one told a customer nothing they could act on. ' +
      'It names the amount and the resulting balance, both read back from the ' +
      'append-only ledger at send time — see the two placeholders below.',
    format: 'PLAIN_TEXT',
    placeholders: [
      /*
       * BOTH OPTIONAL, AND THAT IS THE WP3 LESSON APPLIED RATHER THAN RE-LEARNED.
       *
       * A template body is stored RAW and nothing rewrites it, so an installation
       * that overrode this key before this release holds a body with neither token.
       * Declared required, `validateTemplateBody` would refuse that body as
       * `MISSING_REQUIRED_PLACEHOLDER` — the operator could read their own override
       * and never save it again, for tokens they never wrote. That is the
       * write-only-settings failure the research records, arriving by upgrade
       * instead of by screen, and PR #57 shipped exactly this defect before Codex
       * found it.
       *
       * The runtime supplies both unconditionally, so the shipped body shows them
       * and an override that omits them simply does not. Requiring the token would
       * be the catalogue dictating what a body must SAY rather than what it may use.
       */
      {
        token: 'refundAmount',
        type: 'MONEY',
        description:
          'What was actually credited, summed from the REFUND entries the ledger ' +
          'holds for this order. Never the order total: an operator may already ' +
          'have returned part of it by bank transfer, and the sentence has to name ' +
          'what reached the wallet.',
        required: false,
        repeatable: false,
      },
      {
        token: 'walletBalance',
        type: 'MONEY',
        description:
          'The balance as of that credit — summed over every entry up to and ' +
          'including it, not read live. A resend a week later must say what was ' +
          'true when the refund landed rather than what the wallet holds today, ' +
          'or two copies of one message state two different balances.',
        required: false,
        repeatable: false,
      },
    ],
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
    key: 'bot.wallet.topup_button',
    description:
      'The label on the button that starts a wallet top-up. Shown under the balance, and ' +
      'only when the tenant has configured at least one preset amount and an enabled ' +
      'payment account to transfer to.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.wallet.topup_choose',
    description:
      'Shown above the preset amounts. Carries no amount of its own: the buttons are the ' +
      'amounts, and each is rendered from the configured preset rather than from this text.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.wallet.topup_unavailable',
    description:
      'Shown when a top-up is asked for and nothing can fund it — no preset amount is ' +
      'configured, or no enabled payment account exists. Says the facility is unavailable ' +
      'rather than naming the missing configuration, which is an operator’s business.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.wallet.topup_refused',
    description:
      'Shown when a chosen top-up amount cannot be used — it is no longer offered, or it ' +
      'is below the configured minimum. One sentence for both, because the customer’s ' +
      'action is the same: choose another amount. The two cases stay distinct as ERROR ' +
      'CODES, which is where an operator reads them.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.wallet.topup_credited',
    description:
      'Sent when an operator confirms a wallet top-up. Carries NO amount: the customer ' +
      'notification lane has no payload (ADR 0030 §1), so the sentence states that the ' +
      'balance changed and points at /wallet, where the figure is derived from the ledger.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  /* ---------------------------------------------------------------------------
   * Phase 5T — the Telegram admin surface.
   *
   * Admin-facing text, in the SAME catalogue as everything else on purpose: an
   * administrator reading a receipt in Telegram is reading text this product ships,
   * and a surface may not write a literal whatever the reader's role is.
   *
   * What none of these keys does is describe authority. The panel is drawn from the
   * permissions the guard resolves and every action re-checks server-side, so no
   * sentence here is load-bearing for access control — drawing a button is not a
   * grant and not drawing one is not a denial.
   * ------------------------------------------------------------------------- */
  {
    key: 'bot.menu.admin',
    description:
      'The keyboard button that opens the management panel. Drawn ONLY for a Telegram ' +
      'account bound to an ACTIVE administrator holding at least one of the panel\u2019s own ' +
      'permissions.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel',
    description:
      'The management panel\u2019s own screen. Says what is inside it and nothing about the ' +
      'installation; which sections a given administrator may open are the buttons, and ' +
      'those come from that administrator\u2019s permissions.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.receipts_button',
    description: 'Opens the queue of manual transfers waiting for a decision.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.section_button',
    description: 'Opens the administrator section: who holds Telegram access, and how.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.receipts_list',
    description:
      'Above the queue. Carries no count: the rows are the answer, and a number rendered ' +
      'beside them is one more thing that can disagree with them.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.receipts_none',
    description:
      'The empty queue \u2014 the only state the Mirza investigation could observe, and the ' +
      'reason its runtime behaviour is UNKNOWN rather than reproduced. Says nothing is ' +
      'waiting, never that none ever was: this section shows PENDING work and no history ' +
      'is reachable from it.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.receipt',
    description:
      'One payment awaiting a decision, with the facts a reviewer reconciles against a ' +
      'bank statement: the reference the customer was told to quote, the payable amount, ' +
      'and who owes it. The receipt files are sent as media beside this message by ' +
      'file_id, so no token and no URL is ever rendered.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'reference',
        type: 'STRING',
        description: 'The payment reference the customer quoted.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'MONEY',
        description: 'The payable amount, frozen on the payment.',
        required: true,
        repeatable: false,
      },
      {
        token: 'customer',
        type: 'STRING',
        description: 'Who owes it, by the identity this installation holds.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.receipt_gone',
    description:
      'The tapped payment is no longer awaiting a decision \u2014 approved, rejected, ' +
      'withdrawn or expired since the message was drawn. A stale inline button says so ' +
      'rather than doing anything, because this message stays in the chat for ever.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.approve_button',
    description: 'Confirms the transfer, through the same application path Web Admin uses.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reject_button',
    description: 'Rejects the transfer, through the same application path Web Admin uses.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.approved',
    description:
      'The decision landed: the payment is CONFIRMED, and whatever it funds was settled ' +
      'or credited by the service rather than by this surface.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.rejected',
    description:
      'The decision landed: the payment is FAILED, and the customer is told by the ' +
      'notification lane rather than from here.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_button',
    description:
      'Opens the services section of the management panel. Drawn only for an ' +
      'administrator who holds `services.view`, and the section charges that key again ' +
      'server-side \u2014 the button decides what is advertised, never what is allowed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_section',
    description:
      'Introduces the two queues this section shows: services stranded in ' +
      '`UNRECONCILED`, and services whose configuration could not be delivered. Those ' +
      'two because they are the states nothing resolves on its own \u2014 every other ' +
      'state either settles itself or belongs to the customer. No placeholders: a count ' +
      'here would go stale between the render and the tap.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_none',
    description:
      'Both queues are empty. Says nothing needs attention, never that nothing ever ' +
      'did: this section shows OPEN work and no history is reachable from it \u2014 the ' +
      'same rule `bot.admin.receipts_none` states.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service',
    description:
      'One service, as an administrator sees it in Telegram. Carries the identity, the ' +
      'lifecycle, the usage, the expiry, the delivery state and the latest operation ' +
      'outcome \u2014 and NO capability: no subscription URL, no subscription ref, no ' +
      'provider client id, no panel credential. All four are bearer capabilities and a ' +
      'chat message is the worst place to put one, because it stays in that chat for ' +
      'ever and is forwardable.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'customer',
        type: 'STRING',
        description:
          'Whose service it is, by the numeric Telegram identity this installation ' +
          'holds \u2014 the handle a support conversation quotes. WP3 made this true: ' +
          'the description already said "numeric identity" while the runtime passed ' +
          'the INTERNAL uuid, which names the right person to nobody and cannot be ' +
          'typed into any command. It is still not a display name, and the service ' +
          'screen carries no wallet balance, order or payment beside it.',
        required: true,
        repeatable: false,
      },
      {
        token: 'username',
        type: 'STRING',
        description: 'The handle an operator types into the panel. Not a credential.',
        required: true,
        repeatable: false,
      },
      {
        token: 'panel',
        type: 'STRING',
        description: 'The panel the service lives on, by the name the operator gave it.',
        required: true,
        repeatable: false,
      },
      {
        token: 'product',
        type: 'STRING',
        description: 'The plan as it was SOLD, from the order\u2019s frozen snapshot.',
        required: true,
        repeatable: false,
      },
      {
        token: 'state',
        type: 'STRING',
        description:
          'The lifecycle state, as the frozen vocabulary spells it \u2014 the same word the ' +
          'Web Admin, the audit row and the operational log use. An administrator ' +
          'matching a chat message against a screen needs the same token on both.',
        required: true,
        repeatable: false,
      },
      {
        token: 'delivery',
        type: 'STRING',
        description:
          'What is known about telling the customer, from the frozen vocabulary. A ' +
          'SECOND axis and never merged with the state: a provisioned account whose ' +
          'message bounced must not read as unprovisioned, because the obvious remedy ' +
          'for that is a second paid-for account on somebody\u2019s panel.',
        required: true,
        repeatable: false,
      },
      {
        token: 'usedTrafficBytes',
        type: 'BYTES',
        description: 'Traffic used, as of the last successful sync.',
        required: false,
        repeatable: false,
      },
      {
        token: 'totalTrafficBytes',
        type: 'BYTES',
        description: 'The allowance in bytes, or 0 for unlimited.',
        required: false,
        repeatable: false,
      },
      {
        token: 'syncedAt',
        type: 'DATETIME',
        description:
          'When usage was last read BACK from the panel. Absent means never, and the ' +
          'copy says so rather than leaving a figure to be read as live.',
        required: false,
        repeatable: false,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'When the service expires. Absent means it has no expiry.',
        required: false,
        repeatable: false,
      },
      {
        token: 'operation',
        type: 'STRING',
        description:
          'The latest operation and its outcome, as the frozen vocabulary spells both, ' +
          'or that nothing has been attempted. It is what tells a planned action apart ' +
          'from a completed one.',
        required: true,
        repeatable: false,
      },
      {
        token: 'history',
        type: 'STRING',
        description:
          'How many operations this service has, and whether that figure is exact. A ' +
          'plain number when the whole history was read; the bound with a trailing `+` ' +
          'when it was not, because the reader stops at a bound and an exact count ' +
          'would mean walking every operation the service ever had to render one ' +
          'figure; and `-` when the history could not be read AT ALL, which is a ' +
          'different fact from “none” and must never render as zero. WP3 added it so ' +
          'the screen above a SINGLE operation says whether that one is the whole ' +
          'story — the same rule the Web history now prints under its table, and the ' +
          'reason neither surface calls a long history a problem any more.',
        /*
         * NOT required, and on this key that is a decision rather than an oversight.
         *
         * `validateTemplateBody` refuses a body that omits a REQUIRED token. An
         * installation that already overrode `bot.admin.service` holds a stored body
         * predating this one — an override is raw persisted source and nothing rewrites
         * it — so requiring the token would leave that operator with a body they cannot
         * re-save: every attempt refused as MISSING_REQUIRED_PLACEHOLDER, for a token
         * they never wrote and did not ask for. That is the write-only-settings failure
         * the research records, produced by an upgrade rather than by a screen.
         *
         * The runtime supplies the value unconditionally, so the shipped body shows the
         * line and an override that omits it simply does not. Requiring the token would
         * be this catalogue dictating what a body must SAY rather than what it may use.
         */
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.service_gone',
    description:
      'The tapped service is not this tenant\u2019s, or no longer exists. ONE message for ' +
      'both, for the reason `bot.service.not_found` gives on the customer side: telling ' +
      'them apart would let anybody holding a service id learn whether it exists.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_sync_button',
    description: 'Reads usage back from the panel, through the canonical SYNC_USAGE operation.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_resend_button',
    description:
      'Sends the customer their configuration again. Plans no operation and calls no ' +
      'provider \u2014 a resend is a message and a delivery row.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_retry_button',
    description:
      'Asks for the provider account to be created again, through `retryProvisioning` ' +
      'and its own refusals \u2014 an UNRECONCILED service is reconciled first rather than ' +
      'given a second account.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_reconcile_button',
    description:
      'Resolves an UNRECONCILED service against its panel, which is how a lost create ' +
      'is settled without asking for a duplicate account.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_suspend_button',
    description: 'Pauses the account on the panel, through the canonical SUSPEND operation.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_resume_button',
    description: 'Re-enables a suspended account, through the canonical RESUME operation.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_rotate_link_button',
    description:
      'ASKS to give the customer a new subscription link. Carries the asking callback, ' +
      'never the rotating one: a rotation can cut the customer off from the link they ' +
      'are using, so it is two taps, like ending a service.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_rotate_link_ask',
    description:
      'The confirmation screen for a new subscription link. It says what will happen — ' +
      'the panel mints a new link and the customer is sent it — and deliberately does ' +
      'NOT say the old link stops working, because that has not been proven on any ' +
      'panel (docs/rickpanel-rotate-audit.md).',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_rotate_link_confirm_button',
    description: 'The second tap, and the only button that asks a panel for a new link.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_terminate_button',
    description:
      'ASKS to end the service. It carries the asking callback and never the destructive ' +
      'one, which is what makes ending a service two taps in the admin panel \u2014 the ' +
      'first such flow on the admin side, and the same rule the customer half has held ' +
      'since 4E.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_terminate_ask',
    description:
      'The confirmation screen for ending a service: it says what will happen \u2014 the ' +
      'account is deleted on the panel and the customer keeps the order they paid for ' +
      '\u2014 and offers the one button that does it. The destructive callback is produced ' +
      'here and nowhere else.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_terminate_confirm_button',
    description:
      'The second tap, and the only button in the admin panel whose press deletes an ' +
      'account on a provider.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_planned',
    description:
      'The request was RECORDED, and the operation is planned rather than done: no ' +
      'provider has been called yet. Saying it was done would be the legacy ' +
      '\u201c\u2705 updated\u201d for a write whose effect has not happened, and for the action ' +
      'that deletes an account that difference is the whole point.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_resent',
    description:
      'The configuration was sent to the customer. Its own key rather than ' +
      '`bot.admin.service_planned`, because a resend plans no operation and reporting a ' +
      'planned one would invent it.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_unavailable',
    description:
      'The tapped action cannot be taken on this service right now \u2014 the state, the ' +
      'provider\u2019s capabilities, the panel\u2019s configuration, or an operation of that ' +
      'type already under way. ONE sentence for all of them on this surface: the ' +
      'administrator\u2019s next step is the Web Admin, where the reason is named, and the ' +
      'operational log and audit row carry the distinction. Reached by a button drawn ' +
      'before the service moved.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  /*
   * Phase 6B — the panels section.
   *
   * The rule that shapes every key below: this surface shows a panel's IDENTITY, its
   * health STATE and its occupancy, and never a credential, never an address, and never
   * a provider's response body. A chat message stays in that chat for ever and is
   * forwardable, and a panel's base URL plus a failure body is most of what somebody
   * needs to go looking. Credential creation and rotation are not here at all — they
   * are the Web Admin's, behind `panels.credentials.rotate`.
   */
  /*
   * ## The reminder settings section (Phase 6C)
   *
   * Mirza's six cron capabilities are «a flag plus a single scalar prompt» (CBR-003,
   * CBR-011), and seven of its twelve settings screens never print the value they are
   * about to replace \u2014 «an admin cannot read the current configuration without
   * overwriting it» (CBR-013, BC-SB-003). The section template below prints all eight
   * values at once, before anything is editable, which is the cure applied rather than
   * merely written down.
   *
   * There is NO typed-value prompt on this surface. Every edit is a tap on a value
   * carried in the callback data, so `INCIDENT-FIN-001` \u2014 a pending prompt
   * swallowing an unrelated message and overwriting a production setting \u2014 has no
   * mechanism to occur here at all.
   */
  {
    key: 'bot.admin.reminders_button',
    description: 'Opens the reminder settings section from the admin panel.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminders_section',
    description:
      'Every reminder setting and switch, with its CURRENT value, before anything is ' +
      'editable. The three switches are shown and not toggled here: they are ' +
      'TENANT_WIDE, so ADR-0010 requires a typed confirmation and a reason, and a ' +
      'button that synthesised either would be the safeguard removed rather than met.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'expiry',
        type: 'STRING',
        description: 'Whether advance expiry reminders are on, as a state symbol.',
        required: false,
        repeatable: true,
      },
      {
        token: 'expired',
        type: 'STRING',
        description: 'Whether the expired notice is on, as a state symbol.',
        required: false,
        repeatable: true,
      },
      {
        token: 'usage',
        type: 'STRING',
        description: 'Whether usage reminders are on, as a state symbol.',
        required: false,
        repeatable: true,
      },
      {
        token: 'firstDays',
        type: 'NUMBER',
        description: 'The tenant\u2019s first expiry threshold, in days.',
        required: false,
        repeatable: true,
      },
      {
        token: 'secondDays',
        type: 'NUMBER',
        description: 'Its second.',
        required: false,
        repeatable: true,
      },
      {
        token: 'firstPercent',
        type: 'NUMBER',
        description: 'The first usage threshold, in percent.',
        required: false,
        repeatable: true,
      },
      {
        token: 'secondPercent',
        type: 'NUMBER',
        description: 'Its second.',
        required: false,
        repeatable: true,
      },
      {
        token: 'finalPercent',
        type: 'NUMBER',
        description: 'Its last.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.admin.reminder_expiry_first_button',
    description: 'Opens the chooser for reminders.expiry_first_days.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminder_expiry_second_button',
    description: 'Opens the chooser for reminders.expiry_second_days.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminder_usage_first_button',
    description: 'Opens the chooser for reminders.usage_first_percent.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminder_usage_second_button',
    description: 'Opens the chooser for reminders.usage_second_percent.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminder_usage_final_button',
    description: 'Opens the chooser for reminders.usage_final_percent.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.reminder_choose',
    description:
      'One setting, its current value, and the values that may replace it. `setting` ' +
      'is the registry KEY rather than a translated name \u2014 the same machine key ' +
      'the Web Admin row is titled with, so an operator reading both surfaces is ' +
      'looking at one identifier and not two names for it.',
    // TELEGRAM_HTML so the registry key renders in <code>: it is a machine
    // identifier an operator may want to copy into the Web Admin, and a proportional
    // font turns `reminders.usage_first_percent` into something to squint at.
    format: 'TELEGRAM_HTML',
    placeholders: [
      {
        token: 'setting',
        type: 'STRING',
        description: 'The registry key being edited.',
        required: false,
        repeatable: true,
      },
      {
        token: 'current',
        type: 'NUMBER',
        description: 'Its value right now.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.admin.reminder_saved',
    description: 'A reminder threshold was written. Names the value that is now stored.',
    // TELEGRAM_HTML so the registry key renders in <code>: it is a machine
    // identifier an operator may want to copy into the Web Admin, and a proportional
    // font turns `reminders.usage_first_percent` into something to squint at.
    format: 'TELEGRAM_HTML',
    placeholders: [
      {
        token: 'setting',
        type: 'STRING',
        description: 'The registry key that was written.',
        required: false,
        repeatable: true,
      },
      {
        token: 'value',
        type: 'NUMBER',
        description: 'The value now stored.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.admin.reminder_refused',
    description:
      'A combination the thresholds may not take. Carries the guard\u2019s own reason, ' +
      'which names WHICH of the five is wrong and why \u2014 Mirza answers the same ' +
      'situation with `\u2b55\ufe0f \u0648\u0631\u0648\u062f\u06cc \u0646\u0627 ' +
      '\u0645\u0639\u062a\u0628\u0631` (BC-SB-004), which tells an operator nothing.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'reason',
        type: 'STRING',
        description: 'The refusal, already in Persian, from `refuseReminderThresholds`.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.admin.panels_button',
    description:
      'Opens the panels section of the management panel. Drawn only for an ' +
      'administrator who holds `panels.view`, and the section charges that key again ' +
      'server-side — the button decides what is advertised, never what is allowed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panels_section',
    description:
      'Introduces the fleet: one button per live panel, newest first, and a further ' +
      'page when the server says there is one. No counts here — a figure in this ' +
      'message would go stale between the render and the tap, and the occupancy an ' +
      'administrator is deciding on belongs to ONE panel rather than to the fleet, ' +
      'because a cap is per panel and a sum over mixed caps means nothing.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panels_none',
    description:
      'This installation has no live panel. Names where one is created — the Web ' +
      'Admin — rather than offering to create one here: a panel needs credentials, ' +
      'and credentials are not entered in a chat.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panels_more_button',
    description:
      'The next page of panels, carrying the keyset cursor the server minted. Drawn ' +
      'only when the page says there is more AND the cursor fits Telegram’s 64-byte ' +
      'callback limit; a cursor that cannot be carried is a list that ends, which is ' +
      'the safe direction.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_detail',
    description:
      'One panel, as an administrator sees it in Telegram. Carries the name, the ' +
      'provider, the status, the health STATE with when it was last checked, the ' +
      'failure KIND from the frozen vocabulary when there is one, and the occupancy — ' +
      'services, held slots, the cap and the username policy. It carries NO base URL, ' +
      'NO credential, no ' +
      'masked stand-in for one, and no provider response body: all four are either a ' +
      'secret or most of the way to finding one, and this message is forwardable for ' +
      'ever.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'name',
        type: 'STRING',
        description: 'The panel, by the name the operator gave it.',
        required: true,
        repeatable: false,
      },
      {
        token: 'provider',
        type: 'STRING',
        description:
          'The provider, by the descriptor’s display name — a provider type is code ' +
          'in this codebase, so this is a fixed string and never a stored one.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description:
          'ACTIVE, DISABLED or ARCHIVED, as the frozen vocabulary spells it — the same ' +
          'word the Web Admin, the audit row and the operational log use.',
        required: true,
        repeatable: false,
      },
      {
        token: 'health',
        type: 'STRING',
        description:
          'The latest health state, including the two this repository PROJECTS rather ' +
          'than stores: `DISABLED` for a panel nobody is probing and `UNCHECKED` for one ' +
          'nobody has probed yet. Health is latest-state-only, so there is no trend to ' +
          'draw and none is implied.',
        required: true,
        repeatable: false,
      },
      {
        token: 'checkedAt',
        type: 'DATETIME',
        description:
          'When that health was written. Absent means never, and the copy says so rather ' +
          'than leaving a state to be read as current.',
        required: false,
        repeatable: false,
      },
      {
        token: 'failure',
        type: 'STRING',
        description:
          'The failure KIND from the provider taxonomy, when the last probe failed. A ' +
          'kind and never a body: a provider’s own error text can carry a hostname, a ' +
          'path or a token fragment, and the Web Admin is where a probe is read in full.',
        required: false,
        repeatable: false,
      },
      {
        token: 'services',
        type: 'NUMBER',
        description: 'How many services occupy a slot on this panel right now.',
        required: true,
        repeatable: false,
      },
      {
        token: 'reservations',
        type: 'NUMBER',
        description:
          'How many unexpired slots are HELD by orders that are confirmed and not yet ' +
          'settled. Its own figure rather than folded into the services count, because ' +
          'between a confirmation and a payment there is no service — and a number that ' +
          'hid them is the one that oversells the last slot.',
        required: true,
        repeatable: false,
      },
      {
        token: 'cap',
        type: 'STRING',
        description:
          'The operator’s cap, or that there is none. A STRING rather than a number ' +
          'because “no cap” is one of its values and rendering that as 0 would read as ' +
          'a full panel — the exact inversion the null means.',
        required: true,
        repeatable: false,
      },
      {
        /*
         * Which username modes this panel offers, as two marks and a template.
         *
         * THREE placeholders rather than one composed sentence, and that is the rule
         * `UNCAPPED` already follows: a surface may pass a VALUE into a message the
         * catalogue owns, and may not build one message out of another. The words stay
         * here; the surface passes a mark or the template text.
         *
         * Optional, because a body a tenant overrode before this line existed must
         * keep rendering rather than throwing in the resolver — an administrator
         * unable to read a panel at all, over a line of copy.
         */
        token: 'usernameCustom',
        type: 'STRING',
        description: 'A mark when the panel lets a customer type their own name.',
        required: false,
        repeatable: false,
      },
      {
        token: 'usernameAutomatic',
        type: 'STRING',
        description: 'A mark when the panel lets the installation generate one.',
        required: false,
        repeatable: false,
      },
      {
        /*
         * The template itself, which is configuration and not a secret — an
         * administrator reading it is the only way to answer "why is this customer
         * called that". The base URL and the credentials stay out of this message for
         * the reasons the docblock above gives; a token list is neither.
         */
        token: 'usernameTemplate',
        type: 'STRING',
        description: 'The CUSTOM_TEMPLATE template, or a mark when the strategy does not use one.',
        required: false,
        repeatable: false,
      },
      {
        token: 'usernamePrefix',
        type: 'STRING',
        description: 'The PREFIX_RANDOM prefix, or a mark when the strategy does not use one.',
        required: false,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.panel_gone',
    description:
      'The tapped panel is not this tenant’s, or no longer exists. ONE message for ' +
      'both, for the reason `bot.admin.service_gone` gives: telling them apart would let ' +
      'anybody holding a panel id learn whether it exists.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_test_button',
    description:
      'Runs a connection test against the panel, through the one probe implementation ' +
      'the background monitor also uses. Drawn only for `panels.edit`, which is the key ' +
      '`testConnection` charges.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_tested',
    description:
      'A real probe ran and the stored health is its result. Its own key, distinct from ' +
      'the replay below, because “tested” for a probe that did not happen is the ' +
      'legacy “✅ updated” for a write that did nothing.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_test_replayed',
    description:
      'No probe ran: either this exact request was already served, or the panel was ' +
      'probed recently enough that repeating it would be a way to hammer somebody’s ' +
      'provider. What is shown is the STORED health, and the message says so.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_enable_button',
    description:
      'Puts a disabled panel back in service. The server refuses it unless a connection ' +
      'test has succeeded against the panel as it is NOW — see ' +
      '`bot.admin.panel_not_validated`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_disable_button',
    description:
      'Takes a panel out of service: no new sales, and the background monitor stops ' +
      'probing it. Nothing already on it is touched.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_enabled',
    description: 'The panel is ACTIVE again: sellable, and back on the monitor’s schedule.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_disabled',
    description:
      'The panel is DISABLED. Says what that does and does not mean — no new sales, ' +
      'and every service already on it keeps running — because the opposite reading ' +
      'invites an administrator to go looking for services that were never stopped.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_not_validated',
    description:
      'Enabling was refused because no successful connection test vouches for this ' +
      'panel as it is NOW. Names the remedy, which is the Test button on the same ' +
      'screen. Reached by a button drawn before a credential was replaced, and by a ' +
      'panel nobody has ever tested.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_archive_button',
    description:
      'ASKS to archive. Its callback opens the confirmation and changes nothing, which ' +
      'is the ask-then-act pair `bot.admin.service_terminate_ask` established: the ' +
      'destructive callback is produced in exactly one place.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_archive_ask',
    description:
      'The confirmation screen for archiving a panel. Says what archiving does — out ' +
      'of the catalogue, off the monitor’s schedule, out of every list, and its name ' +
      'released — and what it does NOT do, which is end anything already on it. The ' +
      'count of services still there is part of the question rather than a detail, ' +
      'because it is the number an administrator is deciding against.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'services',
        type: 'NUMBER',
        description:
          'How many services are still on this panel. None of them is ended by ' +
          'archiving, and the copy says so beside the figure.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.panel_archive_confirm_button',
    description: 'The second tap, and the only button in this section that archives a panel.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_archived',
    description:
      'The panel is ARCHIVED, and its name is free for another. Says that restoring it ' +
      'is the Web Admin’s, because a restore may need a new name and a name is not ' +
      'typed into a chat on this surface.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.panel_unavailable',
    description:
      'The tapped action cannot be taken on this panel right now — the status moved, ' +
      'the credentials do not satisfy the provider’s shape, the probe budget is spent, ' +
      'or the write lost a race. ONE sentence for all of them on this surface, for the ' +
      'reason `bot.admin.service_unavailable` gives: the administrator’s next step is ' +
      'the Web Admin, where the reason is named, and the audit row and the operational ' +
      'log carry the distinction. Reached by a button drawn before the panel moved.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_button',
    description: 'Opens the panel\u2019s username-policy section from its detail view.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_section',
    description:
      'The panel\u2019s whole username policy, READ BACK before anything is edited: ' +
      'which of the two customer choices are on, which automatic preset is saved, its ' +
      'prefix or template, and a preview rendered from synthetic values. Every value ' +
      'is shown because a setting an operator can write and cannot read is the ' +
      'write-only settings screen this product exists to replace. It also states the ' +
      'two commands that set a prefix and a template, because those carry their ' +
      'argument rather than capturing the next message.',
    format: 'TELEGRAM_HTML',
    placeholders: [
      {
        token: 'panel',
        type: 'STRING',
        description: 'The panel\u2019s name.',
        required: true,
        repeatable: false,
      },
      {
        token: 'custom',
        type: 'STRING',
        description: 'A mark for the custom choice.',
        required: true,
        repeatable: false,
      },
      {
        token: 'automatic',
        type: 'STRING',
        description: 'A mark for the automatic choice.',
        required: true,
        repeatable: false,
      },
      /*
       * The four presets are marks, not a rendered name, and that is a constraint of
       * this surface rather than a preference: the runtime builds a reply as a key
       * and a bag of values, and has no translator to turn a preset's key into the
       * word for it. Passing the enum name would put `PREFIX_RANDOM` in front of a
       * Persian-speaking operator. The names therefore live in this body and the
       * runtime passes only which one is selected — the same arrangement the two
       * mode marks above already use.
       */
      {
        token: 'random',
        type: 'STRING',
        description: 'A mark when RANDOM is selected.',
        required: true,
        repeatable: false,
      },
      {
        token: 'prefixRandom',
        type: 'STRING',
        description: 'A mark when PREFIX_RANDOM is selected.',
        required: true,
        repeatable: false,
      },
      {
        token: 'telegramIdRandom',
        type: 'STRING',
        description: 'A mark when TELEGRAM_ID_RANDOM is selected.',
        required: true,
        repeatable: false,
      },
      {
        token: 'customTemplate',
        type: 'STRING',
        description: 'A mark when CUSTOM_TEMPLATE is selected.',
        required: true,
        repeatable: false,
      },
      {
        token: 'prefix',
        type: 'STRING',
        description: 'The saved prefix, or a mark for none.',
        required: true,
        repeatable: false,
      },
      {
        token: 'template',
        type: 'STRING',
        description: 'The saved template, or a mark for none.',
        required: true,
        repeatable: false,
      },
      {
        token: 'preview',
        type: 'STRING',
        description:
          'One name this policy would produce, rendered from SYNTHETIC values. It ' +
          'consumes no randomness that reaches a customer and reserves nothing.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.username_custom_button',
    description: 'Turns the customer\u2019s own-name choice on or off for this panel.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_automatic_button',
    description: 'Turns the generated-name choice on or off for this panel.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_strategy_random',
    description:
      'Selects the preset that draws twelve random characters. There is no button for ' +
      'CUSTOM_TEMPLATE beside these three, and the asymmetry is deliberate: the other ' +
      'three either need no configuration or have a default, and a template does not ' +
      'exist until somebody writes one \u2014 so `/panel_template` is how that preset ' +
      'is selected, in the same message that supplies the template.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_strategy_prefix_random',
    description: 'Selects and names the preset that puts a saved prefix before random characters.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_strategy_telegram_id_random',
    description: 'Selects and names the preset that uses the customer\u2019s Telegram id.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.username_refused',
    description:
      'The username policy was refused and NOTHING was written \u2014 both choices off, ' +
      'a prefix or template that cannot render a legal name, or a preset with no ' +
      'configuration behind it. The reason is passed in, because an operator fixing one ' +
      'problem per round trip is an operator who gives up.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'reason',
        type: 'STRING',
        description: 'Why it was refused, in words, from the shared validator.',
        required: true,
        repeatable: false,
      },
    ],
  },
  /*
   * The customers section, WP2.
   *
   * Eleven keys, and what they do NOT carry is the point. A customer row is a person,
   * so nothing here renders a wallet balance, an order, a service or a subscription:
   * those are four other permissions and four other surfaces, and a message an
   * administrator can forward is the worst place to put any of them in bulk. What the
   * section answers is the one question a support conversation asks — "who is this
   * Telegram account to us, and should the bot still talk to them".
   */
  /*
   * WP3 — browsing services, and reaching the customer from one.
   *
   * Six keys. The services section was a QUEUE and nothing else: the ten things needing
   * attention, with its `nextCursor` dropped deliberately because the eleventh
   * unreconciled service is not a thing an operator scrolls to. That stays. What these
   * add is the other half — a browsable, paged inventory, so a service that is
   * perfectly healthy is reachable from a phone at all — and one button, so the person
   * a service belongs to is one tap away instead of a UUID an operator cannot read.
   */
  {
    key: 'bot.admin.services_browse_button',
    description:
      'Opens the browsable list from the services section. Beside the queue, never ' +
      'instead of it: a queue answers "what needs me" and an inventory answers "where ' +
      'is this one", and collapsing them loses the first.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_browse',
    description:
      'Introduces the browsable list: one button per service, newest first, and a ' +
      'further page when the server says there is one. No counts — the rule ' +
      '`bot.admin.panels_section` states, that a figure here goes stale between the ' +
      'render and the tap. It also names the lookup command, because paging to the ' +
      'four-hundredth service is forty taps and the name a customer quotes is one ' +
      'message.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_browse_none',
    description:
      'No service on this installation, or none left beyond this page. Says nobody is ' +
      'here rather than that nobody exists, because it is reachable with a cursor.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_more_button',
    description:
      'The next page of services, carrying the keyset cursor the server minted. Drawn ' +
      'only when the page says there is more AND the cursor fits Telegram’s ' +
      '64-byte callback limit; a cursor that cannot be carried is a list that ends, ' +
      'which is the safe direction.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.services_back_button',
    description: 'Returns from one service to the services section.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_customer_button',
    description:
      'Opens the customer this service belongs to. Drawn only for an administrator who ' +
      'holds `users.view`, and the customer screen charges that key again server-side ' +
      '— the button decides what is advertised, never what is allowed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_ambiguous',
    description:
      'The typed name belongs to more than one service in this tenant, so the lookup ' +
      'answers with the matches instead of picking one. `services_panel_provider_' +
      'username_key` is unique per PANEL, not per tenant, and two panels of one tenant ' +
      'may point at different machines — so one name legitimately names two accounts. ' +
      'Choosing the newest silently would put suspend and terminate buttons on an ' +
      'arbitrary one of them, which is the wrong customer’s service under a right ' +
      'answer’s heading. No action is offered on this screen: it only routes to a ' +
      'detail, and the detail names the panel and the customer.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.service_usage',
    description:
      'The lookup command was sent without a readable argument. Repeats the syntax, ' +
      'which now accepts EITHER the internal id or the provider username, rather than ' +
      'opening a prompt for the missing one: a prompt that outlives its question ' +
      'swallows the next unrelated message (INCIDENT-FIN-001).',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customers_button',
    description:
      'Opens the customers section of the management panel. Drawn only for an ' +
      'administrator who holds `users.view`, and the section charges that key again ' +
      'server-side — the button decides what is advertised, never what is allowed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customers_section',
    description:
      'Introduces the customer list: one button per customer, oldest first, a further ' +
      'page when the server says there is one, and the exact syntax of the lookup ' +
      'command. No counts, for the reason `bot.admin.panels_section` gives — a figure ' +
      'here goes stale between the render and the tap. The lookup is a COMMAND ' +
      'carrying its argument rather than a prompt that captures the next message: ' +
      'INCIDENT-FIN-001 is a captured prompt swallowing an ordinary message and ' +
      'overwriting a production gateway setting.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customers_none',
    description:
      'No customer has ever contacted this installation. States it rather than ' +
      'rendering an empty list, because an empty list of buttons is indistinguishable ' +
      'from a list that failed to load.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customers_more_button',
    description:
      'The next page of customers, carrying the keyset cursor the server minted. The ' +
      'same rule `bot.admin.panels_more_button` states: drawn only when the page says ' +
      'there is more, and a cursor that cannot be carried is a list that ends.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customers_back_button',
    description: 'Returns from one customer to the first page of the list.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customer_detail',
    description:
      'One customer, as an administrator sees them in Telegram. Carries the numeric ' +
      'Telegram id (which is the handle a support conversation quotes), the Telegram ' +
      'username, the name Telegram reported, the status from the frozen vocabulary, ' +
      'the operator note recorded with a block, and when they were first and last ' +
      'heard from. It carries NO wallet balance, no order, no service, no ' +
      'subscription reference and no provider username: each of those is a different ' +
      'permission, and this message is forwardable.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'telegramId',
        type: 'STRING',
        description: 'The numeric Telegram account id — this customer’s identity here.',
        required: true,
        repeatable: false,
      },
      {
        token: 'username',
        type: 'STRING',
        description:
          'The Telegram username, or a dash. Not an identifier: a customer may change ' +
          'it at will, which is why the id above is what an operator quotes.',
        required: true,
        repeatable: false,
      },
      {
        token: 'name',
        type: 'STRING',
        description: 'The name Telegram reported, or a dash. Also not an identifier.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description: 'ACTIVE or BLOCKED, from `CUSTOMER_STATUSES`. There is no third.',
        required: true,
        repeatable: false,
      },
      {
        token: 'reason',
        type: 'STRING',
        description:
          'The operator note recorded when this customer was blocked, or a dash. An ' +
          'operator note, never shown to the customer, and cleared by an unblock so a ' +
          'stale reason cannot read as current.',
        required: true,
        repeatable: false,
      },
      {
        token: 'firstSeen',
        type: 'DATETIME',
        description: 'When this installation first heard from them.',
        required: true,
        repeatable: false,
      },
      {
        token: 'lastSeen',
        type: 'DATETIME',
        description:
          'When it last did. Written on every contact, and never allowed to move ' +
          'backwards — see `drizzle-customer.repository.ts`.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.customer_gone',
    description:
      'ONE answer for an id that is unknown, malformed, or another tenant’s — the rule ' +
      '`bot.admin.panel_gone` states. Nobody holding an id may learn whether it names ' +
      'anything on this installation.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customer_block_button',
    description:
      'Blocks this customer. Drawn only for an administrator who holds `users.block`, ' +
      'and `CustomerService.block` charges that key again inside the writing ' +
      'transaction — the missing button is a courtesy, never the enforcement.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customer_unblock_button',
    description: 'Lifts a block. The same permission and the same machinery, reversed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.customer_status_changed',
    description:
      'Names the status the customer now HOLDS rather than the button that was ' +
      'pressed, so a redelivered update reads as the state it found instead of ' +
      'claiming a second change. The same property `bot.admin.admin_status_changed` ' +
      'has, for the same reason.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'telegramId',
        type: 'STRING',
        description: 'Which customer, by the id an operator quotes.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description: 'ACTIVE or BLOCKED — what holds now.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.customer_usage',
    description:
      'The lookup command was sent without a readable Telegram id. Repeats the syntax ' +
      'rather than opening a prompt for the missing argument, which is the whole ' +
      'reason it is a command: a prompt that outlives its question swallows the next ' +
      'unrelated message (INCIDENT-FIN-001).',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  /*
   * WP5 — the categories section of the Telegram management panel.
   *
   * Every write here is `ProductCategoryService`, the same service the Web Admin's
   * `/product-categories` routes call, so these keys are the WORDS for outcomes that
   * service decides and never a second statement of its rules. Text an operator
   * authors — a name, an emoji — travels as a COMMAND carrying its argument, never as
   * a prompt that captures the next message (INCIDENT-FIN-001).
   */
  {
    key: 'bot.admin.categories_button',
    description:
      'Opens the categories section. Drawn for an administrator who holds ' +
      '`catalog.view`; every write inside it charges `catalog.edit` in the service.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.categories_section',
    description:
      'Introduces the operator category list: one button per category in the order ' +
      'customers see them, each labelled with its status and visibility, and the exact ' +
      'syntax of the command that creates one. Every category is listed here, empty ' +
      'or hidden or inactive — this is the operator list, not the customer one.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.categories_none',
    description:
      'This tenant has no category at all. Names the create command, because a ' +
      'product cannot be sold until it is filed under one.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.categories_next_button',
    description: 'The next page of the category list. Drawn only when one exists.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.categories_previous_button',
    description: 'The previous page of the category list. Drawn only past the first.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.categories_back_button',
    description: 'Returns to the category list.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_detail',
    description:
      'One category as an operator sees it, and the syntax of the two commands that ' +
      'edit its text. The product count is EVERY product filed under it, active or ' +
      'not — the number that decides whether it may be deleted — and is read when the ' +
      'screen is drawn; the delete re-counts under a lock rather than trusting it.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'id',
        type: 'STRING',
        description:
          'The category id, printed so an operator can copy it into the rename and ' +
          'emoji commands. Not a secret: it names a row this administrator can read.',
        required: true,
        repeatable: false,
      },
      {
        token: 'name',
        type: 'STRING',
        description: 'The name customers see.',
        required: true,
        repeatable: false,
      },
      {
        token: 'emoji',
        type: 'STRING',
        description: 'The emoji shown before the name, or a dash when there is none.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description:
          'ACTIVE or INACTIVE. INACTIVE means nothing in it can be bought, including ' +
          'by a direct link, and is re-checked when an order is confirmed.',
        required: true,
        repeatable: false,
      },
      {
        token: 'visibility',
        type: 'STRING',
        description:
          'VISIBLE or HIDDEN. HIDDEN means unlisted but still orderable by direct ' +
          'reference — a different question from status.',
        required: true,
        repeatable: false,
      },
      {
        token: 'products',
        type: 'NUMBER',
        description: 'How many products are filed under it, whatever their status.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.category_gone',
    description:
      'ONE answer for a category id that is unknown, malformed or another tenant’s — ' +
      'the rule `bot.admin.panel_gone` states.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_activate_button',
    description: 'Makes the category ACTIVE. Drawn only for `catalog.edit`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_deactivate_button',
    description:
      'Makes the category INACTIVE: nothing in it can be bought, including by a direct ' +
      'link. Drawn only for `catalog.edit`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_show_button',
    description: 'Lists the category to customers again. Drawn only for `catalog.edit`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_hide_button',
    description:
      'Unlists the category. Its products stay orderable by direct reference. Drawn ' +
      'only for `catalog.edit`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_up_button',
    description: 'Moves the category one place earlier. Not drawn for the first one.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_down_button',
    description: 'Moves the category one place later. Not drawn for the last one.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_delete_button',
    description:
      'Asks before deleting. Opens a confirmation rather than acting, the ask-then-act ' +
      'shape every destructive admin action on this surface has.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_delete_ask',
    description:
      'The confirmation before a delete. Drawn only for an empty category; the delete ' +
      'itself re-counts under a lock and refuses if a product arrived in between.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'name',
        type: 'STRING',
        description: 'The category about to be deleted.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.category_delete_confirm_button',
    description: 'Deletes the category. Produced by the confirmation screen alone.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_deleted',
    description:
      'The category was deleted. Orders placed under it keep its name, because an ' +
      'order carries a snapshot rather than a reference.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'name',
        type: 'STRING',
        description: 'The name it had.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.category_not_empty',
    description:
      'The delete was refused because the category still holds products. The count ' +
      'is the one the service took under the category lock, not the one on the screen ' +
      'the operator tapped from.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'products',
        type: 'NUMBER',
        description: 'How many products are still filed under it.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.category_usage',
    description:
      'A category command was sent without a readable argument, or the service refused ' +
      'the name or emoji it carried. Repeats the syntax of all three commands rather ' +
      'than opening a prompt for what was missing (INCIDENT-FIN-001).',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_products_button',
    description:
      'Opens the product list from which a product is moved into another category. ' +
      'Drawn only for `catalog.edit`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_products',
    description:
      'Introduces the product list for reassignment. Each button names the product and ' +
      'the category it is in now; a dash means it is in none, which is a product no ' +
      'customer can buy until it is filed.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_products_none',
    description: 'There is no product on this page — none at all, or the list ended.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_products_more_button',
    description: 'The next page of products. Drawn only when the server says one exists.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_pick',
    description:
      'Asks which category to move one product into. The buttons are every category ' +
      'except the one it is in now.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'product',
        type: 'STRING',
        description: 'The product title.',
        required: true,
        repeatable: false,
      },
      {
        token: 'category',
        type: 'STRING',
        description: 'The category it is in now, or a dash when it is in none.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.category_pick_none',
    description: 'There is no OTHER category to move this product into. Names the create command.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.category_moved',
    description:
      'A product now lives in another category. Orders already placed keep the ' +
      'category they were bought under, because an order carries a snapshot.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'product',
        type: 'STRING',
        description: 'The product title.',
        required: true,
        repeatable: false,
      },
      {
        token: 'category',
        type: 'STRING',
        description: 'The category it is in now.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.product_gone',
    description:
      'ONE answer for a product id that is unknown, malformed or another tenant’s — ' +
      'the rule `bot.admin.panel_gone` states.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.section',
    description:
      'The administrator section: the roster, and the exact syntax of the two commands ' +
      'it accepts. Commands rather than a prompt that captures the next message: ' +
      'INCIDENT-FIN-001 is a captured prompt swallowing an ordinary message and ' +
      'overwriting a production gateway setting, and a command carries its argument in ' +
      'the same message. The roster is EVERY administrator rather than only the ' +
      'Telegram-bound ones, because an administrator an operator most needs to find on ' +
      'this surface \u2014 one to disable \u2014 is exactly the one who may hold no binding.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'shown',
        type: 'NUMBER',
        description:
          'How many administrators the buttons below carry. A Telegram inline ' +
          'keyboard has a size limit, so the rows are bounded; the count is printed ' +
          'rather than left implicit because a silently truncated list reads exactly ' +
          'like a complete one.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'NUMBER',
        description:
          'How many there are. Equal to `shown` unless the bound was reached, which ' +
          'is what tells an operator to finish the job in the Web Admin rather than ' +
          'conclude the roster ends here.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.admins_none',
    description:
      'No administrator on this installation has Telegram access yet. Names where one is ' +
      'created \u2014 the Web Admin \u2014 because this product will not invent an administrator ' +
      'with no credentials in order to keep a menu shorter.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.admin_detail',
    description:
      'One administrator, as another administrator sees them in Telegram. Carries the ' +
      'username, the display name, the status from the frozen vocabulary, the role keys ' +
      'and whether a Telegram account is bound. It carries NO password, no hash, no ' +
      'masked stand-in for one, no session, and no IP or user agent from a session row: ' +
      'a credential must never cross this surface, and a forwardable message naming ' +
      'where an administrator signs in from is most of the way to finding them.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'username',
        type: 'STRING',
        description: 'The administrator, by the name they sign in with.',
        required: true,
        repeatable: false,
      },
      {
        token: 'displayName',
        type: 'STRING',
        description: 'The name an operator gave them, which is not an identifier.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description:
          'ACTIVE or DISABLED, as the frozen vocabulary spells it. There is no third ' +
          'status and no deletion: `audit_logs` references administrators and refuses ' +
          'DELETE, so disabling is this product\u2019s answer.',
        required: true,
        repeatable: false,
      },
      {
        token: 'roles',
        type: 'STRING',
        description:
          'The role KEYS, joined. Keys rather than display names because `/role` takes a ' +
          'key, so what is shown is what can be typed back.',
        required: true,
        repeatable: false,
      },
      {
        token: 'telegram',
        type: 'STRING',
        description:
          'Whether a Telegram account is bound, and which numeric id when one is \u2014 the ' +
          'id is not a secret and is what `/link` and a revocation both name.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.admin_enable_button',
    description:
      'Returns a disabled administrator to ACTIVE. Their roles and their Telegram ' +
      'binding were never removed by disabling, so this restores exactly what they had.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.admin_disable_button',
    description:
      'Disables an administrator: every permission empties and every live session stops ' +
      'being one on the next request. Refused for the caller themselves and for the ' +
      'last remaining owner, by the same service the Web Admin calls.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.admin_status_changed',
    description:
      'The administrator\u2019s status is now what the button asked for. Names the status ' +
      'rather than the button pressed, so a replayed tap reads as the state it found ' +
      'rather than as a second change.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'username',
        type: 'STRING',
        description: 'The administrator whose status this is.',
        required: true,
        repeatable: false,
      },
      {
        token: 'status',
        type: 'STRING',
        description: 'ACTIVE or DISABLED, as the frozen vocabulary spells it.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.admin_gone',
    description:
      'The administrator behind that button is not one this caller may see. ONE answer ' +
      'for unknown, another tenant\u2019s and malformed alike \u2014 telling them apart would ' +
      'let anybody holding an id learn whether it names anything.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.revoke_button',
    description:
      'Removes one administrator\u2019s Telegram access from their detail screen. Their ' +
      'account, their roles and their Web Admin sign-in are untouched: this ends a ' +
      'CHANNEL, not an identity.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.admins_back_button',
    description: 'Returns from one administrator to the roster.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.linked',
    description: 'A Telegram account is now bound to that administrator.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'username',
        type: 'STRING',
        description: 'The administrator\u2019s username.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.revoked',
    description: 'That administrator no longer has Telegram access.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'username',
        type: 'STRING',
        description: 'The administrator\u2019s username.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.roles_set',
    description: 'That administrator\u2019s roles are now these.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'username',
        type: 'STRING',
        description: 'The administrator\u2019s username.',
        required: true,
        repeatable: false,
      },
      {
        token: 'roles',
        type: 'STRING',
        description: 'The role keys now held, already joined.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.admin.usage',
    description:
      'The command was not in the shape it accepts. Reprints the syntax rather than ' +
      'guessing: every argument here names either an administrator or a Telegram ' +
      'account, and a guess would bind the wrong one.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.refused',
    description:
      'The action was refused. ONE sentence for every refusal an administrator can reach ' +
      'here \u2014 no permission, an unknown administrator, a Telegram account already bound, ' +
      'a privilege they do not hold themselves \u2014 because the distinctions belong to the ' +
      'audit row and the error code, and a Telegram reply enumerating them would tell ' +
      'whoever holds that chat which case they hit.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.admin.receipt_awaiting',
    description:
      'Sent to each administrator with Telegram access who may decide a receipt, when one ' +
      'is filed. Carries the reference and the amount so a reviewer knows what is ' +
      'waiting, and no media: the files are in the queue, which is the durable record \u2014 ' +
      'this is the poke.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'reference',
        type: 'STRING',
        description: 'The payment reference the customer quoted.',
        required: true,
        repeatable: false,
      },
      {
        token: 'total',
        type: 'MONEY',
        description: 'The payable amount.',
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
      'The invoice: heading, invoice id, payable amount, the destination lines, then ' +
      'the tenant-editable instructions. Carries the destination the payment was ' +
      'ISSUED against. ' +
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
    key: 'bot.request_unavailable',
    description:
      'The truthful generic refusal, for the causes a customer can neither act on nor ' +
      'be told apart: the installation has stopped accepting work, a row the command ' +
      'needs is not there, or a financial refusal arrived without the figure that ' +
      'makes its own reply renderable. It exists because an UNMAPPED refusal code ' +
      'makes `refusal` rethrow and the webhook swallow it, which answers the customer ' +
      'with silence — the F5R-12 class. Says nothing was charged, because in every ' +
      'case that reaches it the transaction rolled back.',
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
      'The label on the button a customer presses to say they have sent the transfer AND ' +
      'to start sending its receipt. A key rather than a literal, for the reason ' +
      '`bot.payment.wallet_button` gives. It sits beside `bot.payment.cancel_button` on ' +
      'the instructions message and is the opposite action, so the two labels must be ' +
      'impossible to confuse at a glance. ' +
      'The Payment UX addendum fixes the seeded label as one button naming both halves, ' +
      'not two buttons: the tap records the customer\u2019s claim and opens the upload ' +
      'window in one transaction, so a label naming only one of them would describe half ' +
      'of what the tap does. It still settles nothing \u2014 ' +
      '`bot.payment.receipt_prompt` is the answer, and confirmation remains an ' +
      'operator\u2019s under `receipts.review`.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.receipt_prompt',
    description:
      'The answer to that tap. It has to carry two facts at once and neither may be ' +
      'dropped: the claim is on record and a person will check it, AND the customer may ' +
      'now send the receipt image or file. The minutes are a token rather than a number ' +
      'in the sentence, so `RECEIPT_CAPTURE_MINUTES` and the text cannot disagree. ' +
      'Nothing here says the payment was received \u2014 the caution ' +
      '`bot.payment.received_for_review` records applies word for word.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'minutes',
        type: 'NUMBER',
        description:
          'How long the upload window stays open, in minutes. The lesser of ' +
          '`RECEIPT_CAPTURE_MINUTES` and what is left of the payment\u2019s own deadline.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.payment.receipt_received',
    description:
      'The answer to a receipt that was filed. It confirms the FILE arrived and says a ' +
      'reviewer will look at it \u2014 it must not say the payment is confirmed, for the ' +
      'reason `bot.payment.received_for_review` gives at length. It is also the answer to ' +
      'a redelivered upload of the same file, because the customer\u2019s situation is ' +
      'identical either way and a second sentence for a Telegram retry would be a ' +
      'difference they cannot act on.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.receipt_not_expected',
    description:
      'The answer to an image or a document sent when no upload window is open. It names ' +
      'the situation and the remedy \u2014 open an invoice and tap the button \u2014 ' +
      'rather than silently consuming the file. `INCIDENT-FIN-001` is the alternative: a ' +
      'message swallowed by a prompt nobody remembered asking.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.receipt_expired',
    description:
      'The answer to a file that arrived after its window closed. Distinct from ' +
      '`bot.payment.receipt_not_expected` because the customer did what they were asked ' +
      'and the remedy is to tap the button again, which that sentence does not say.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.payment.receipt_limit',
    description:
      'The answer to a receipt beyond `PAYMENT_RECEIPT_MAX_PER_PAYMENT`. It says the ones ' +
      'already sent are what the reviewer sees, because a customer who is not told that ' +
      'sends more.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'limit',
        type: 'NUMBER',
        description: 'How many receipts one payment may hold.',
        required: true,
        repeatable: false,
      },
    ],
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
    key: 'bot.service.list_more',
    description:
      'The label on the button that shows a customer the next page of their services. ' +
      'Phase 6A. Before it, the list was a BOUND rather than a page: a customer with ' +
      'more than twenty services saw twenty and was told nothing about the rest, ' +
      'because the surface discarded the cursor the repository already returned. A ' +
      'label rather than a heading, so it carries no placeholders \u2014 a count would ' +
      'go stale between the render and the tap, and the number a customer wants is not ' +
      '"how many remain" but "is there more".',
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
    key: 'bot.service.rotate_button',
    description:
      "The button on a customer's service that asks for a new subscription link (WP6-C). " +
      'Drawn only while customer_link_rotation is on, the service is ACTIVE and its panel ' +
      'can rotate a link.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.rotate_ask',
    description:
      'The confirmation screen before a customer rotates their link. Says a new link will ' +
      'be issued and has to be put into their apps, and how long until they may ask again. ' +
      'Deliberately says NOTHING about the old link: that it stops working is not proven ' +
      '(OQ-RP-07), and a customer told so would stop worrying about a link that may still ' +
      'work.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'cooldownHours',
        type: 'NUMBER',
        description:
          'services.link_rotation_cooldown_hours, as it stands when the screen is drawn.',
        required: true,
        repeatable: false,
      },
    ],
  },
  {
    key: 'bot.service.rotate_confirm_button',
    description: 'The button on the rotation confirmation screen that asks for the new link.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.service.rotate_cooldown',
    description:
      "The refusal a customer sees when they rotated this service's link too recently. " +
      'Names the instant another rotation will be accepted, from the refusal itself, so it ' +
      "is the server's answer and not a figure the surface computed.",
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'availableAt',
        type: 'DATETIME',
        description: 'The first instant another rotation of this service will be accepted.',
        required: true,
        repeatable: false,
      },
    ],
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
  /*
   * The six reminders (Phase 6C). Each carries NO placeholder, deliberately.
   *
   * The customer notification lane has no payload — ADR 0030 §1 — so a single
   * "expires in {days} days" is not available, and inventing one would give a
   * background loop the ability to send a customer any string in the catalogue.
   * «سه روز» inside the sentence is the same information with none of that.
   *
   * Each one also says what to DO, because a reminder that only states a fact makes
   * the customer go and find the renew button themselves. The three usage sentences
   * deliberately do not name a figure: the percentage is the threshold that fired,
   * and a number rendered here would go stale the moment the next byte moves.
   */
  {
    key: 'bot.service.expiry_first',
    description:
      'The tenant\u2019s FIRST expiry threshold was crossed \u2014 three days by default, and ' +
      'whatever reminders.expiry_first_days says otherwise. Named for the slot rather than ' +
      'the number, because the number is a setting an operator moves.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'days',
        type: 'DURATION_DAYS',
        description:
          'Whole days left when the reminder was raised, from the snapshot on the ' +
          'service_reminders row rather than re-read at send time.',
        required: false,
        repeatable: true,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'The deadline the reminder was raised against.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.service.expiry_second',
    description: 'The second, more urgent threshold. One day by default.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'days',
        type: 'DURATION_DAYS',
        description:
          'Whole days left when the reminder was raised, from the snapshot on the ' +
          'service_reminders row rather than re-read at send time.',
        required: false,
        repeatable: true,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'The deadline the reminder was raised against.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.service.expired',
    description:
      'The service reached its own deadline. A statement of fact and an invitation to ' +
      'renew \u2014 never a claim that anything was deleted, because expiry is a Nexa-side ' +
      'lifecycle transition and the panel account is dealt with separately. Carries no ' +
      '`days`: zero days left is the fact the sentence already states.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'expiresAt',
        type: 'DATETIME',
        description: 'The deadline the reminder was raised against.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.service.usage_first',
    description:
      'The tenant\u2019s first usage threshold, eighty percent by default. The figures are ' +
      'PLACEHOLDERS and they are a SNAPSHOT: `service_reminders` recorded what the panel ' +
      'had last reported when the reminder was raised, so the sentence says what was true ' +
      'then rather than a number re-read at send time that would disagree with it.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'usedTraffic',
        type: 'BYTES',
        description:
          'What the panel had last reported when the reminder was raised. A SNAPSHOT: ' +
          'never a figure re-read at send time, which could disagree with the threshold ' +
          'the sentence names, and never zero standing in for a figure nobody has read.',
        required: false,
        repeatable: true,
      },
      {
        token: 'totalTraffic',
        type: 'BYTES',
        description: 'The allowance the reminder was raised against.',
        required: false,
        repeatable: true,
      },
      {
        token: 'usagePercent',
        type: 'NUMBER',
        description: 'The whole-percent figure the two above work out to.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.service.usage_second',
    description: 'The second usage threshold, ninety-five percent by default.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'usedTraffic',
        type: 'BYTES',
        description:
          'What the panel had last reported when the reminder was raised. A SNAPSHOT: ' +
          'never a figure re-read at send time, which could disagree with the threshold ' +
          'the sentence names, and never zero standing in for a figure nobody has read.',
        required: false,
        repeatable: true,
      },
      {
        token: 'totalTraffic',
        type: 'BYTES',
        description: 'The allowance the reminder was raised against.',
        required: false,
        repeatable: true,
      },
      {
        token: 'usagePercent',
        type: 'NUMBER',
        description: 'The whole-percent figure the two above work out to.',
        required: false,
        repeatable: true,
      },
    ],
  },
  {
    key: 'bot.service.usage_final',
    description:
      'The final usage threshold, a hundred percent by default. Says the traffic ran out ' +
      'and offers more; it does NOT say the service stopped, because whether a panel cuts ' +
      'a customer off at the limit is the provider\u2019s behaviour and not a fact this ' +
      'installation observed.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'service',
        type: 'STRING',
        description: 'The account name on the panel, which is what the customer sees.',
        /*
         * REQUIRED, and the only one of the four that is.
         *
         * A customer with three services who is told "one of them expires soon" has been
         * given a puzzle rather than a warning. The figures below are optional because a
         * short message without them is still a true, useful sentence; a message without
         * the name is not.
         */
        required: true,
        repeatable: true,
      },
      {
        token: 'usedTraffic',
        type: 'BYTES',
        description:
          'What the panel had last reported when the reminder was raised. A SNAPSHOT: ' +
          'never a figure re-read at send time, which could disagree with the threshold ' +
          'the sentence names, and never zero standing in for a figure nobody has read.',
        required: false,
        repeatable: true,
      },
      {
        token: 'totalTraffic',
        type: 'BYTES',
        description: 'The allowance the reminder was raised against.',
        required: false,
        repeatable: true,
      },
      {
        token: 'usagePercent',
        type: 'NUMBER',
        description: 'The whole-percent figure the two above work out to.',
        required: false,
        repeatable: true,
      },
    ],
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
    key: 'bot.discount.enter_button',
    description:
      'The button on a new-purchase summary that opens the discount-code window (WP8 ' +
      'P11). A label, not a claim that any code will apply.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.discount.remove_button',
    description: 'The button that takes an entered code off a draft and re-quotes it.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.discount.ask',
    description:
      'Asks for the code once the window is open. It names the window, so a customer ' +
      'knows their next message is read as a code — the one thing that keeps an ' +
      'ordinary message from being swallowed by a prompt they did not know was waiting.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.discount.no_longer_valid',
    description:
      'Shown at confirmation when a discount the summary included no longer holds. ' +
      'Nothing was charged and the order was not re-priced; the customer starts again ' +
      'and sees the quote as it now stands.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.referral.invite',
    description:
      "The customer's own referral link and code, for sharing, and how many people have " +
      'joined through it (WP9 F12). Whoever opens the link as a NEW customer is attributed ' +
      'to this one for good; the text promises no amount, because the rate belongs to the ' +
      'orders the referred customer has not placed yet. Never rendered before WP9, so the ' +
      'two tokens it gained change no message a customer has seen.',
    format: 'PLAIN_TEXT',
    placeholders: [
      {
        token: 'referralCode',
        type: 'STRING',
        description: "The customer's derived referral code.",
        required: true,
        repeatable: false,
      },
      {
        token: 'referralLink',
        type: 'STRING',
        description: 'The t.me deep link that carries the code to /start.',
        required: true,
        repeatable: false,
      },
      {
        token: 'referredCount',
        type: 'NUMBER',
        description: 'How many customers have been attributed to this one.',
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
    key: 'bot.referral.button',
    description:
      'The button on the wallet screen that shows the customer their referral link. Drawn ' +
      'only while the referral program is running.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.unavailable',
    description:
      'Shown when a trial cannot be issued — unconfigured, the customer\u2019s limit reached, or the ' +
      'configured product is unavailable. One message, for the reason the discount ' +
      'rejection gives.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.issued',
    description:
      'Confirms that a trial service is being created. Says nothing about the link: it ' +
      'arrives on its own, through the same delivery a purchase uses, once the panel has ' +
      'answered.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.button',
    description:
      'The button on the catalogue that takes a trial. Drawn only when this customer can ' +
      'take one right now — the flag is on, a product is configured and available, and ' +
      'they are under their limit — and decided again on the server when tapped.',
    format: 'PLAIN_TEXT',
    placeholders: [],
  },
  {
    key: 'bot.trial.not_delivered',
    description:
      'A trial could not be created on its panel. Says the trial was given back, so it ' +
      'does not count against the customer. Deliberately says nothing about money, ' +
      'because none moved.',
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
