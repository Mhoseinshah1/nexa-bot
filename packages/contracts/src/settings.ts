import { z } from 'zod';
import { OPERATIONAL_SEVERITIES } from './ports.js';
import { moneySchema } from './money.js';

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
      'then be shown Toman labels over Rial figures, which is a factor of ten.',
    // IRT and IRR only. The catalogue in money.ts carries USD, EUR and USDT
    // because a converted payment quote will need them; a STORE currency is a
    // different question, and widening this is a contract change to make when
    // there is a gateway that settles in one of them.
    schema: z.enum(['IRT', 'IRR']),
    defaultValue: 'IRT',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    // Nothing prices anything yet. The admin already renders it, which is why
    // it is here rather than waiting for the storefront.
    consumer: 'PLANNED',
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
    key: 'wallet.topup.minimum',
    description:
      'The smallest wallet top-up accepted, as an explicit amount and currency. A per-gateway ' +
      'override is intended to take precedence over this default, and cannot be expressed yet: ' +
      'no payment gateway is registered anywhere in this system, so there is nothing for an ' +
      'override to be keyed by. Zero means no minimum.',
    // Money, not a number. An amount without a currency is the defect that runs
    // through the whole legacy financial surface: no exchange rate exists on
    // any of its seven gateways and Toman is implicit everywhere.
    schema: moneySchema,
    defaultValue: { amountMinor: '0', currency: 'IRT' },
    zeroMeaning: 'DISABLES',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: null,
    consumer: 'PLANNED',
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
