/**
 * The feature flag registry.
 *
 * A feature flag answers exactly one question: is this feature on for this
 * tenant. Its stored value is a boolean, and the schema gives it nowhere else to
 * put anything — no nested JSON, no parameters, no fourth shape. A feature's
 * CONFIGURATION lives in the settings registry, which already has schemas,
 * defaults, validation and declared zero semantics.
 *
 * That split is the whole point. CBR-011 finds four shapes behind the legacy
 * capability screen — scalar, menu of scalars, subsystem, CRUD collection — and
 * concludes that "modelling capabilities as a flat `map[string]bool` cannot
 * represent" three of them. The answer is not to widen the flag; it is to notice
 * that three of those four are settings wearing a toggle's clothes.
 *
 * Two further findings are answered by structure rather than by care:
 *
 *   - A flag and its parameter live on different screens. `⚠️ اعلان کاهش موجودی`
 *     is the flag; `⚠️ مبلغ هشدار موجودی` is its threshold, one menu up
 *     (CBR-007). Here the link is declared in both directions and asserted
 *     symmetric by a test, so a surface can show the whole chain at once.
 *   - Forced-join has no toggle at all: it "is enabled by adding at least one
 *     channel and can be disabled only by removing every channel" (GSR-004). An
 *     emergent enable state cannot be audited and cannot be switched off without
 *     deleting data. Every gate here has an explicit flag.
 *
 * See docs/adr/0019-feature-flags.md.
 */

/**
 * How much a toggle changes.
 *
 * The legacy capability screen renders the whole-bot kill switch identically to
 * the dice toggle (CBR-009). Blast radius is therefore declared, and a
 * `TENANT_WIDE` flag goes through the confirmation protocol in
 * docs/adr/0010-destructive-operations.md — the operator states what they are
 * turning off and the audit row carries the reason.
 *
 * This is not a second permission. `settings.destructive` is for bulk
 * mutations, and turning a feature off is not one.
 */
export const FLAG_BLAST_RADII = ['LOCAL', 'TENANT_WIDE'] as const;
export type FlagBlastRadius = (typeof FLAG_BLAST_RADII)[number];

export interface FeatureFlagDefinition {
  readonly key: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly blastRadius: FlagBlastRadius;
  /**
   * The settings that parameterise this feature.
   *
   * The other half of `SettingDefinition.configures`. Both halves are declared
   * and checked against each other, because the legacy pair drifted apart by
   * living on two screens with nothing connecting them.
   */
  readonly configuredBy: readonly string[];
}

/**
 * Registered flags.
 *
 * A flag exists here only when the code behind it is written and reachable.
 * Publishing a flag for a Phase 3 or Phase 5 feature would put a switch on an
 * administrator's screen that turns nothing on — which is worse than the feature
 * being absent, because an absent feature is understood and a dead switch is a
 * bug report.
 */
export const FEATURE_FLAGS = [
  {
    key: 'ops_notifications',
    description:
      'Project operational events at or above the configured severity into the operations ' +
      'destination. Off by default: a destination has to be configured and tested first, and a ' +
      'flag that is on before its configuration exists is the inert-setting trap in reverse.',
    defaultEnabled: false,
    // Turning this off means nobody is told when things fail. That is worth
    // saying out loud before it happens.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [
      'ops.notifications.telegram_chat_id',
      'ops.notifications.telegram_topic_id',
      'ops.notifications.min_severity',
      'ops.notifications.max_attempts',
      'ops.notifications.max_per_minute',
    ],
  },
  {
    key: 'opslog_retention',
    description:
      'Run the retention sweep over resolved operational events. Turning it off freezes history ' +
      'while an incident is being investigated, without changing the retention window itself.',
    defaultEnabled: true,
    blastRadius: 'LOCAL',
    configuredBy: ['opslog.retention_days'],
  },
  {
    key: 'template_overrides',
    description:
      'Apply this tenant’s template overrides when rendering. Off falls every message back to ' +
      'the built-in default without deleting an override or losing a revision — the recovery a ' +
      'legacy operator did not have, since that surface has no reset control at all (UNK-TXT-008).',
    defaultEnabled: true,
    // Every customer-facing message changes at once.
    blastRadius: 'TENANT_WIDE',
    configuredBy: [],
  },
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]['key'];

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = FEATURE_FLAGS.map(
  (f) => f.key as FeatureFlagKey,
);

const FLAG_BY_KEY = new Map<string, FeatureFlagDefinition>(FEATURE_FLAGS.map((f) => [f.key, f]));

export function featureFlagDefinition(key: FeatureFlagKey): FeatureFlagDefinition {
  const found = FLAG_BY_KEY.get(key);
  if (!found) {
    throw new Error(`Unknown feature flag: ${key}. Feature flags are a frozen contract.`);
  }
  return found;
}

/** Unknown keys fail closed. */
export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
  return FLAG_BY_KEY.has(value);
}

/** Where a resolved flag value came from. Same shape, same reason, as a setting. */
export const FEATURE_FLAG_SOURCES = ['DEFAULT', 'TENANT'] as const;
export type FeatureFlagSource = (typeof FEATURE_FLAG_SOURCES)[number];
