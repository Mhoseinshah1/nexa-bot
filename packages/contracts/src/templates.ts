import type { Money } from './money.js';

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
