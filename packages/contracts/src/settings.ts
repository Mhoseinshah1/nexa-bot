import { z } from 'zod';
import { OPERATIONAL_SEVERITIES } from './ports.js';

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
}

const telegramChatIdSchema = z
  .string()
  // Empty means "not configured". A group id is negative and long; a channel or
  // user id is positive. Both forms are accepted because the legacy destination
  // accepted both, and neither is validated further here: whether the bot can
  // actually post to it is a question only a test-send can answer.
  .regex(/^$|^-?\d{1,32}$/, 'A Telegram chat id is a signed integer, or empty when not configured.')
  .max(32);

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
