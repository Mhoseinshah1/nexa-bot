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
 * Phase 0 ships the key/placeholder machinery and the Translator port. The
 * template management UI, revisions and preview are Phase 2.
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

export interface PlaceholderDefinition {
  readonly token: string;
  readonly type: PlaceholderType;
  readonly description: string;
}

export interface TemplateDefinition {
  /** Stable machine key. Never a display string. */
  readonly key: string;
  readonly description: string;
  readonly placeholders: readonly PlaceholderDefinition[];
}

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
    placeholders: [
      { token: 'correlationId', type: 'STRING', description: 'Correlation id of the update.' },
    ],
  },
  {
    key: 'bot.unknown_command',
    description: 'Shown when the bot receives a command it does not handle.',
    placeholders: [],
  },
  {
    key: 'error.internal',
    description: 'Generic failure message shown to a customer.',
    placeholders: [],
  },
  {
    key: 'error.permission_denied',
    description: 'Shown when an actor lacks a required permission.',
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

/** Values supplied for a template's declared placeholders. */
export type TemplateValues = Readonly<Record<string, string | number | bigint | Date>>;

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
