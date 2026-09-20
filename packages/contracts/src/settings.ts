import { z } from 'zod';
import { OPERATIONAL_SEVERITIES } from './ports.js';
import { ORDER_EXPIRY_MINUTES_MAX, ORDER_EXPIRY_MINUTES_MIN } from './commerce.js';
import { USAGE_SYNC_MINUTES_MAX, USAGE_SYNC_MINUTES_MIN } from './provisioning.js';
import {
  EXPIRY_REMINDER_DAYS_MAX,
  EXPIRY_REMINDER_DAYS_MIN,
  USAGE_REMINDER_PERCENT_MAX,
  USAGE_REMINDER_PERCENT_MIN,
} from './service-reminders.js';
import { moneySchema, salesCurrencyCodeSchema } from './money.js';
import {
  PAYMENT_AMOUNT_MAX_MINOR,
  PAYMENT_WINDOW_MINUTES_MAX,
  PAYMENT_WINDOW_MINUTES_MIN,
  TOPUP_PRESETS_MAX,
} from './payment.js';

/**
 * The settings registry.
 *
 * Tenant-scoped operational configuration an administrator may change while the
 * process runs. Every key is declared here; a key that is not declared does not
 * exist, is not readable, is not writable and is not storable. There is no
 * `Map<string, unknown>` anywhere in this design, on purpose.
 *
 * Four legacy defects shape the fields below, and each is a documented
 * observation rather than a guess:
 *
 *   - **Settings are write-only.** Seven of twelve nested settings screens never
 *     print the value they are about to replace (BC-SB-003): "an admin cannot
 *     read the current configuration without overwriting it… it converts a read
 *     into a write". The forced-join channel list is worse — the only screen
 *     that lists the channels is the DELETE flow (GSR-006).
 *   - **A prompt swallows the next message, whatever it is** (CBR-012). That is
 *     the mechanism behind INCIDENT-FIN-001, where a typed menu label became the
 *     value and overwrote a production tutorial text that had never been read.
 *   - **`0` means whatever the screen decides.** Two settings in the entire
 *     product document their zero semantics; elsewhere `0` means unlimited, or
 *     disabled, or "this condition does not apply", or is simply unknown
 *     (`UNK-GS-004`, `UNK-GTL-006`).
 *   - **A success message does not mean a write happened** (SOURCE_BUG-002).
 *
 * See docs/adr/0017-settings-registry.md.
 */

/**
 * What zero, empty or absent means for a key.
 *
 * Mandatory. The two legacy settings whose zero semantics are documented are the
 * only two an operator can reason about; making this optional would reproduce
 * the defect for every author who forgot to think about it.
 */
export const ZERO_MEANINGS = [
  /** Zero or empty switches the behaviour off. */
  'DISABLES',
  /** Zero means no ceiling. */
  'UNLIMITED',
  /**
   * Zero, empty or absent is an ordinary permitted value. What it DOES is in
   * the key's own description — this says only that it is not a sentinel that
   * switches the feature off or removes a limit.
   */
  'LITERAL',
  /** Zero or empty cannot occur: the schema forbids it. */
  'NOT_APPLICABLE',
] as const;
export type ZeroMeaning = (typeof ZERO_MEANINGS)[number];

/**
 * Whether a change takes effect immediately.
 *
 * Declared only where it is genuinely true. A `RESTART_REQUIRED` marker on a
 * value that actually applies at once teaches operators to ignore the marker.
 */
export const SETTING_MUTABILITIES = ['RUNTIME', 'RESTART_REQUIRED'] as const;
export type SettingMutability = (typeof SETTING_MUTABILITIES)[number];

/**
 * How freely a value may be shown.
 *
 * There is deliberately no `SECRET`. A credential belongs in a table that is
 * envelope-encrypted, never returned by an API and never logged — the mechanism
 * `bot_instances.token_ciphertext` already uses. `SENSITIVE` marks a value that
 * is not a credential but should not be broadcast, such as an operations chat
 * id; it is still fully readable through the settings surface, because a
 * setting nobody can read is the defect this registry exists to prevent.
 */
export const SETTING_CLASSIFICATIONS = ['PUBLIC', 'SENSITIVE'] as const;
export type SettingClassification = (typeof SETTING_CLASSIFICATIONS)[number];

/**
 * Whether anything in THIS release reads the value.
 *
 * `ACTIVE` means a consumer exists and a change to the value changes what the
 * installation does. `PLANNED` means the key is stored, versioned, validated
 * and audited like any other, and nothing reads it yet.
 *
 * Declared rather than inferred, and required rather than optional, because
 * the alternative is the legacy failure in its purest form: a settings screen
 * that accepts a value, answers "saved", and changes nothing an operator can
 * observe (SOURCE_BUG-002). A surface can only warn about that if the registry
 * says so, and a surface that decides for itself which keys are inert holds a
 * second copy of this knowledge that goes stale on the release a consumer
 * lands.
 *
 * A key moves from PLANNED to ACTIVE in the commit that introduces its
 * consumer. That is a one-word contract change and it is meant to be one, so
 * that shipping the consumer and telling operators about it cannot come apart.
 */
export const SETTING_CONSUMERS = ['ACTIVE', 'PLANNED'] as const;
export type SettingConsumer = (typeof SETTING_CONSUMERS)[number];

export interface SettingDefinition<TSchema extends z.ZodType = z.ZodType> {
  readonly key: string;
  readonly description: string;
  readonly schema: TSchema;
  readonly defaultValue: z.infer<TSchema>;
  /** What `0`, empty or absent means for THIS key. */
  readonly zeroMeaning: ZeroMeaning;
  readonly mutability: SettingMutability;
  readonly classification: SettingClassification;
  /**
   * The feature flag this setting parameterises, if any.
   *
   * Declared so a surface can show the flag and its configuration together. The
   * legacy pair `⚠️ اعلان کاهش موجودی` (the flag) and `⚠️ مبلغ هشدار موجودی`
   * (the threshold) sit on different screens one menu apart, and the finding
   * records the result: the flag is off, "so the setting is inert until the
   * capability is enabled. A rebuild should either grey the field out or say so
   * on the screen" (GSR-008).
   */
  readonly configures: string | null;
  /** Whether anything in this release reads the value. */
  readonly consumer: SettingConsumer;
}

const telegramChatIdSchema = z
  .string()
  // Empty means "not configured". A group id is negative and long; a channel or
  // user id is positive. Both forms are accepted because the legacy destination
  // accepted both, and neither is validated further here: whether the bot can
  // actually post to it is a question only a test-send can answer.
  .regex(/^$|^-?\d{1,32}$/, 'A Telegram chat id is a signed integer, or empty when not configured.')
  .max(32);

/**
 * A public Telegram @handle.
 *
 * Telegram usernames are 5-32 characters, letters, digits and underscore, and
 * begin with a letter. Validated HERE rather than at the surface because the
 * registry is the only place that gets to say what a valid value is — a
 * surface-side check is a second opinion that the API would not enforce.
 *
 * Whether the account exists, and whether the bot can reach it, is a question
 * only a live call can answer. This rejects what is definitely wrong; it does
 * not claim the rest is definitely right.
 */
const telegramHandleSchema = z
  .string()
  .trim()
  .regex(
    /^@[A-Za-z][A-Za-z0-9_]{4,31}$/,
    'A Telegram handle is @ followed by 5 to 32 letters, digits or underscores, starting with a letter.',
  );

/** No duplicates: the same destination twice is a mistake, never an intent. */
function unique<T>(of: (item: T) => string) {
  return (items: readonly T[]): boolean => new Set(items.map(of)).size === items.length;
}

export const SETTINGS = [
  {
    key: 'ops.notifications.telegram_chat_id',
    description:
      'The Telegram chat that receives operational notifications. Empty means no destination is ' +
      'configured and nothing is sent.',
    schema: telegramChatIdSchema,
    defaultValue: '',
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    // Not a credential — knowing it grants nothing without the bot token — but
    // it identifies an internal operations channel and is not broadcast.
    classification: 'SENSITIVE',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
  },
  {
    key: 'ops.notifications.telegram_topic_id',
    description:
      'The forum topic within that chat. Absent posts to the group itself. The legacy log group ' +
      'required forum topics and no topic id was ever captured anywhere (UNK-GS-002), which is ' +
      'why this is explicit configuration with a test-send rather than an assumption.',
    schema: z.number().int().positive().nullable(),
    defaultValue: null,
    // Absent is permitted, is the default, and means something — "post to the
    // group itself". It is therefore LITERAL and not NOT_APPLICABLE, which
    // claims the schema forbids it. This was the one key in the registry whose
    // absence carried a behaviour and it declared that its absence could not
    // happen; the registries test now checks null as well as 0 and '', which is
    // why it stopped passing against the mis-declaration.
    zeroMeaning: 'LITERAL',
    mutability: 'RUNTIME',
    classification: 'SENSITIVE',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
  },
  {
    key: 'ops.notifications.min_severity',
    description:
      'Operational events at or above this severity are projected to the operations destination. ' +
      'Severity routes; a topic does not. The legacy log group routes by topic and has no ' +
      'severity at all (LGR-BR-081).',
    schema: z.enum(OPERATIONAL_SEVERITIES),
    defaultValue: 'ERROR',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
  },
  {
    key: 'ops.notifications.max_attempts',
    description:
      'How many times one notification may be attempted before it is abandoned as failed. ' +
      'Bounded on purpose: a permanently wrong destination retried forever is a slow version of ' +
      'the legacy log group posting the same error sixty times in a day (BUG-LGR-028).',
    schema: z.number().int().min(1).max(10),
    defaultValue: 5,
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
  },
  {
    key: 'ops.notifications.max_per_minute',
    description:
      'The ceiling on outbound operational notifications per minute. No phase of the ' +
      'investigation found any rate-limit handling in the legacy system — no 429, no queue, no ' +
      'back-off — and no phase had code access, so that is NOT_EXPOSED rather than absent. It is ' +
      'built here regardless.',
    schema: z.number().int().min(1).max(60),
    defaultValue: 20,
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
  },
  {
    key: 'sales.currency',
    description:
      'The currency this tenant sells in. Every amount the admin renders takes its unit from ' +
      'the value it belongs to, and this is what a new amount is denominated in. It exists ' +
      'because the alternative is a hardcoded Toman: an installation that prices in Rial would ' +
      'then be shown Toman labels over Rial figures, which is a factor of ten. A product ' +
      'priced in any other currency is refused when it is written.',
    // The same list the picker offers and the server refuses against, so the
    // three cannot drift. See SALES_CURRENCY_CODES for why it is narrower than
    // the money catalogue.
    schema: salesCurrencyCodeSchema,
    defaultValue: 'IRT',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    /*
     * ACTIVE since Phase 4B. `ProductService` reads it inside the write and refuses a
     * price in any other currency — the setting had been PLANNED, and a declared
     * setting nothing enforces is a setting an operator believes.
     *
     * Changing it does NOT re-price existing products, and that is deliberate rather
     * than an omission: every stored amount carries its own currency, so a product
     * priced before the change still renders in the unit it was priced in. The
     * alternative — reinterpreting stored amounts under a new unit — is the factor of
     * ten this setting exists to prevent.
     */
    consumer: 'ACTIVE',
  },
  {
    key: 'support.accounts',
    description:
      'The support accounts offered to customers, in the order they are offered. A list rather ' +
      'than one handle because support is more than one person; order is meaningful and is ' +
      'stored, not a rendering choice.',
    schema: z
      .array(telegramHandleSchema)
      .max(10)
      .refine(
        unique((handle: string) => handle.toLowerCase()),
        {
          message: 'The same support account is listed twice.',
        },
      ),
    defaultValue: [],
    // An empty list is not "no limit" and not a sentinel: it means no support
    // contact is offered at all.
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'PLANNED',
  },
  {
    key: 'telegram.channels',
    description:
      'The channels shown to customers, in order, each flagged as required membership or ' +
      'optional. The legacy product could only LIST its forced-join channels from inside the ' +
      'delete flow (GSR-006), so reading the configuration meant starting to destroy it.',
    schema: z
      .array(
        z.object({
          handle: telegramHandleSchema,
          /**
           * Required membership, or merely offered.
           *
           * Not optional and not defaulted. A missing flag would have to be
           * read as one of the two, and reading it as "required" gates every
           * customer out of the bot while reading it as "optional" silently
           * drops a gate the operator meant to set.
           */
          mandatory: z.boolean(),
        }),
      )
      .max(10)
      .refine(
        unique((channel: { handle: string }) => channel.handle.toLowerCase()),
        {
          message: 'The same channel is listed twice.',
        },
      ),
    defaultValue: [],
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'PLANNED',
  },
  {
    key: 'sales.order_expiry_minutes',
    description:
      'How long an unpaid order is held before it may be expired. The window is an operator ' +
      'setting because a tenant selling to a different market wants a different one, and the ' +
      'research fixes no number: ORDER_EXPIRY_MINUTES_MIN and _MAX in commerce.ts are the ' +
      'bounds a configured value is checked against, so a misconfiguration cannot create an ' +
      'order that never expires or one that expires before a customer can open a payment page. ' +
      'A DRAFT carries the same deadline and cannot be confirmed past it, which is what stops a ' +
      'customer holding a stale price open indefinitely.',
    // Bounded by the CONTRACT's own constants rather than by numbers retyped here.
    // Two copies of a bound drift; `commerce.ts` owns these.
    schema: z.number().int().min(ORDER_EXPIRY_MINUTES_MIN).max(ORDER_EXPIRY_MINUTES_MAX),
    // Sixty minutes. Inside the bounds, and the one number the repository already
    // records an opinion about: `web.planned_payments_expiry` says the payment window
    // is at most an hour. That is a PAYMENT decision and this is the order's own
    // window, but a default longer than the payment deadline would be a default that
    // guarantees a stranded order.
    defaultValue: 60,
    // Zero is outside the schema entirely — the minimum is five — so it can never be
    // stored and does not need a meaning.
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'ACTIVE',
  },
  {
    key: 'sales.payment_window_minutes',
    description:
      'How long a PENDING payment is held open before the sweep expires it, together with ' +
      'the order it was against. Separate from sales.order_expiry_minutes, which bounds a ' +
      'DRAFT\u2019s price hold: a customer holding a quote and a customer holding bank details ' +
      'and an amount are in different situations, and only the second one has been told to go ' +
      'and transfer money. PAYMENT_WINDOW_MINUTES_MIN and _MAX in payment.ts are the bounds a ' +
      'configured value is checked against, and the maximum is the owner\u2019s: at most one ' +
      'hour, after which the payment and the order must be expired or cancelled.',
    // Bounded by the CONTRACT's own constants rather than by numbers retyped here,
    // for the reason `sales.order_expiry_minutes` gives: two copies of a bound drift.
    schema: z.number().int().min(PAYMENT_WINDOW_MINUTES_MIN).max(PAYMENT_WINDOW_MINUTES_MAX),
    // The ceiling, as the default. The owner fixed an hour as the MAXIMUM, so a shorter
    // window is a tenant's choice to make and a longer one is not available to them;
    // defaulting below the ceiling would be this file inventing a policy under it.
    defaultValue: 60,
    // Zero is outside the schema entirely \u2014 the minimum is five \u2014 so it can never
    // be stored and does not need a meaning. Turning expiry OFF is deliberately not
    // expressible: a payment nothing closes is the defect this key exists to close, and
    // `payments.expires_at` is already carried onto every manual transfer.
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'ACTIVE',
  },
  {
    key: 'provisioning.usage_sync_minutes',
    description:
      'How stale a service\u2019s traffic figure may get before this installation asks its panel ' +
      'for a fresh one. The figure is what a customer is told when they ask how much traffic ' +
      'they have left, and it is written once at provisioning and then never again unless ' +
      'something refreshes it. An operator setting rather than a constant because every sync ' +
      'is an outbound request against the tenant\u2019s ONE probe budget \u2014 the same bucket ' +
      'the panel monitor and provisioning spend from \u2014 so how often a tenant wants to poll ' +
      'depends on how many services sit on that panel and what the panel tolerates. ' +
      'USAGE_SYNC_MINUTES_MIN and _MAX in provisioning.ts are the bounds a configured value is ' +
      'checked against.',
    // Bounded by the CONTRACT's own constants rather than by numbers retyped here,
    // for the reason `sales.order_expiry_minutes` gives: two copies of a bound drift.
    schema: z.number().int().min(USAGE_SYNC_MINUTES_MIN).max(USAGE_SYNC_MINUTES_MAX),
    // Four hours. Six reads a day per service is a figure an operator can explain to a
    // customer without being a load an ordinary panel notices, and it is well inside
    // the floor that keeps these reads from crowding out an operator's own panel work.
    defaultValue: 240,
    // Zero is outside the schema entirely \u2014 the minimum is fifteen \u2014 so it can
    // never be stored and does not need a meaning. Turning the sweep OFF is not
    // expressible here on purpose: a usage figure nothing refreshes is the defect this
    // key exists to close, and a tenant that does not want the reads should not be
    // selling metered services.
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'ACTIVE',
  },
  {
    key: 'wallet.topup.minimum',
    description:
      'The smallest wallet top-up accepted, as an explicit amount and currency. A per-gateway ' +
      'override is intended to take precedence over this default, and cannot be expressed yet: ' +
      'no payment gateway is registered anywhere in this system, so there is nothing for an ' +
      'override to be keyed by. Zero means no minimum.',
    // Money, not a number. An amount without a currency is the defect that runs
    // through the whole legacy financial surface: no exchange rate exists on
    // any of its seven gateways and Toman is implicit everywhere.
    // NON-NEGATIVE, unlike the generic money type. `moneySchema` accepts a
    // signed integer because a balance or a debit legitimately goes below
    // zero; a smallest ACCEPTED top-up cannot, and this key's own description
    // defines zero as the only no-minimum sentinel. Without the refinement
    // `{ amountMinor: '-1' }` validated, stored and reported as a legitimate
    // minimum.
    schema: moneySchema.refine(
      (money) => BigInt(money.amountMinor) >= 0n,
      'A minimum top-up cannot be negative; zero means no minimum.',
    ),
    defaultValue: { amountMinor: '0', currency: 'IRT' },
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    // ACTIVE from 5B, which is where the consumer landed: `WalletTopupService.request`
    // reads it inside the transaction that would create the payment and refuses with
    // `TOPUP_BELOW_MINIMUM`. Until then this key was configurable and inert, which is
    // the shape `GSR-008` names — a field an operator fills in that nothing obeys.
    consumer: 'ACTIVE',
  },
  {
    key: 'wallet.topup.presets',
    description:
      'The top-up amounts a customer may choose, in the order they are offered. Each is an ' +
      'explicit amount and currency, and every one must be in the currency this installation ' +
      'sells in — an amount a wallet cannot be credited in is money that can never be spent. ' +
      'An empty list means top-up is not offered at all and the button is not drawn. There is ' +
      'no free-entry amount: a prompt that captures the next message is what swallowed an ' +
      'ordinary message and overwrote a production gateway setting in INCIDENT-FIN-001.',
    // A LIST of money, bounded at both ends of each element and in length.
    //
    // The length bound is not decoration: these render as Telegram buttons, and a
    // keyboard is the one place where "the operator may configure as many as they
    // like" becomes a message Telegram refuses to send. Eight is above every
    // top-up menu in `docs/research/`.
    //
    // Each amount must be POSITIVE. `moneySchema` accepts a signed integer because a
    // balance legitimately goes below zero; an amount a customer is asked to transfer
    // cannot, and zero would be a button that invoices nothing. The minimum key's own
    // refinement makes the same argument for the same reason.
    schema: z
      .array(
        moneySchema
          .refine(
            (money) => BigInt(money.amountMinor) > 0n,
            'A top-up preset must be a positive amount.',
          )
          /*
           * And bounded ABOVE by the same ceiling a payment is.
           *
           * A preset is not decoration: `requestWalletTopup` copies it verbatim into
           * `payments.amount`, a `bigint` column, and renders it as a real Telegram
           * button first. Without this, an operator can save a preset larger than
           * PostgreSQL can store, and the customer meets it as a button that 500s —
           * the defect landing on the person who did not configure it. Above
           * `PAYMENT_AMOUNT_MAX_MINOR` but inside the column, it is instead a payment
           * the product's own safety rail would refuse at the tap, which is the same
           * button that cannot work. Both are refused here, where the operator is
           * looking at the field.
           */
          .refine(
            (money) => BigInt(money.amountMinor) <= PAYMENT_AMOUNT_MAX_MINOR,
            `A top-up preset must be at most ${PAYMENT_AMOUNT_MAX_MINOR.toString()} minor units.`,
          ),
      )
      .max(TOPUP_PRESETS_MAX)
      // Duplicates are refused rather than de-duplicated: two identical buttons are a
      // mistake an operator wants told about, and silently collapsing them would make
      // the screen disagree with what was saved.
      .refine(
        (presets) =>
          new Set(presets.map((money) => `${money.amountMinor}:${money.currency}`)).size ===
          presets.length,
        'Each top-up preset must be distinct.',
      ),
    // Empty, so top-up is OFF until an operator chooses the amounts. A default list
    // would be this file inventing prices for every installation that upgrades.
    defaultValue: [],
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'ACTIVE',
  },
  /*
   * The five reminder thresholds.
   *
   * CBR-003 and CBR-011: six of Mirza's twelve configurable capabilities are crons, and
   * every one of them is «a flag plus a single scalar prompt». The owner confirmed the
   * shape, so these are settings and their on/off switches are feature flags — the split
   * `features.ts` already makes, applied to the case the research describes.
   *
   * BC-SB-003 is the defect this registry exists to prevent and these keys inherit the
   * cure for free: every settings surface in this product prints the current value
   * before it asks for a new one. Mirza's own کرون زمان
   * screen happens to be one of the five that DO echo (3روز); the volume
   * threshold beside it is one of the seven that do not, «so an admin cannot read the
   * current configuration without overwriting it».
   *
   * Each bound is the CONTRACT's own constant rather than a number retyped here, for the
   * reason the two window keys above give: two copies of a bound drift. What no per-key
   * schema can express is the RELATION between them — first further out than second,
   * usage strictly increasing — and that is `refuseReminderThresholds`, enforced by a
   * `SettingChangeGuard` on each of the five inside the write's own transaction.
   */
  {
    key: 'reminders.expiry_first_days',
    description:
      'How many days before a service expires the FIRST warning is sent. Must be greater ' +
      'than reminders.expiry_second_days; the pair is checked as a combination when either ' +
      'is written, so a value that would put the two warnings in the wrong order is refused ' +
      'rather than stored. Inert while the service_expiry_reminders flag is off, and ' +
      'preserved across turning it off and on again.',
    schema: z.number().int().min(EXPIRY_REMINDER_DAYS_MIN).max(EXPIRY_REMINDER_DAYS_MAX),
    defaultValue: 3,
    configures: 'service_expiry_reminders',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    consumer: 'ACTIVE',
  },
  {
    key: 'reminders.expiry_second_days',
    description:
      'How many days before expiry the SECOND, more urgent warning is sent. Must be less ' +
      'than reminders.expiry_first_days. One day by default, which is the floor: a shorter ' +
      'warning is one a fifteen-minute sweep may deliver after the service has lapsed.',
    schema: z.number().int().min(EXPIRY_REMINDER_DAYS_MIN).max(EXPIRY_REMINDER_DAYS_MAX),
    defaultValue: 1,
    configures: 'service_expiry_reminders',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    consumer: 'ACTIVE',
  },
  {
    key: 'reminders.usage_first_percent',
    description:
      'The first traffic-usage threshold, in percent of the allowance. The three usage ' +
      'thresholds must be strictly increasing and distinct; the trio is checked as a ' +
      'combination when any one of them is written. A service with an unlimited allowance ' +
      'is never warned, whatever these say.',
    schema: z.number().int().min(USAGE_REMINDER_PERCENT_MIN).max(USAGE_REMINDER_PERCENT_MAX),
    defaultValue: 80,
    configures: 'service_usage_reminders',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    consumer: 'ACTIVE',
  },
  {
    key: 'reminders.usage_second_percent',
    description:
      'The second traffic-usage threshold, in percent. Must be greater than ' +
      'reminders.usage_first_percent and less than reminders.usage_final_percent.',
    schema: z.number().int().min(USAGE_REMINDER_PERCENT_MIN).max(USAGE_REMINDER_PERCENT_MAX),
    defaultValue: 95,
    configures: 'service_usage_reminders',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    consumer: 'ACTIVE',
  },
  {
    key: 'reminders.usage_final_percent',
    description:
      'The last traffic-usage threshold, in percent. A hundred by default — the moment ' +
      'the allowance is gone. The message says the traffic ran out and offers more; it does ' +
      'not claim the service stopped, because whether a panel cuts a customer off at the ' +
      'limit is the provider’s behaviour and not a fact this installation observed.',
    schema: z.number().int().min(USAGE_REMINDER_PERCENT_MIN).max(USAGE_REMINDER_PERCENT_MAX),
    defaultValue: 100,
    configures: 'service_usage_reminders',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    consumer: 'ACTIVE',
  },
] as const satisfies readonly SettingDefinition[];

export type SettingKey = (typeof SETTINGS)[number]['key'];

export const SETTING_KEYS: readonly SettingKey[] = SETTINGS.map((s) => s.key as SettingKey);

const SETTING_BY_KEY = new Map<string, SettingDefinition>(SETTINGS.map((s) => [s.key, s]));

export function settingDefinition(key: SettingKey): SettingDefinition {
  const found = SETTING_BY_KEY.get(key);
  if (!found) {
    throw new Error(`Unknown setting key: ${key}. Settings are a frozen contract.`);
  }
  return found;
}

/** Unknown keys fail closed: this is the only way to widen a string into a key. */
export function isSettingKey(value: string): value is SettingKey {
  return SETTING_BY_KEY.has(value);
}

/**
 * Where a resolved value came from.
 *
 * Returned with every read. `docs/conventions.md` requires that a settings
 * surface can state its value, its resolved source and what zero means; the
 * absence of a tenant row is the answer to the second, and it is not stored as a
 * flag beside the value where the two could disagree.
 */
export const SETTING_SOURCES = ['DEFAULT', 'TENANT'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

/**
 * Parses a stored or submitted value against its declaration.
 *
 * Returns the parsed value or the issue paths — never a coerced value, and never
 * a partial write. Exported from the frozen package so the web editor and the
 * service validate identically.
 */
export function parseSettingValue(
  key: SettingKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  const result = settingDefinition(key).schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}
