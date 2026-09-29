import { z } from 'zod';
import { MAX_DEVICE_LIMIT } from './catalog.js';
import { PANEL_HEALTH_VIEWS, PANEL_STATUSES } from './panels.js';
import {
  CREDENTIAL_SHAPES,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
  canAddTime,
  canAddVolume,
  canAdjustDeviceLimit,
  canChangeLocation,
  canDeleteUser,
  canDisableUser,
  canEnableUser,
  canFetchSubscriptionFiles,
  canRenewUser,
  canRotateSubscription,
  isServiceAdapter,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderConnectionAdapter,
} from './provider.js';
import { LINK_ROTATION_COOLDOWN_HOURS_MAX } from './provisioning.js';
import { isStorableInstant } from './time.js';
import { BYTES_PER_GB } from './traffic-input.js';

/**
 * Advanced provider settings (WP-A8): what a panel can do, what an operator has
 * decided customers may do with it, and what is wrong with it.
 *
 * Three things, kept apart because they have three different authorities:
 *
 *   - the CAPABILITY REGISTRY is code. It is derived from the adapter — its
 *     methods AND its descriptor's declarations, the pairing every `can*` guard in
 *     `provider.ts` already requires — and nothing an operator does can change it.
 *     There is deliberately no toggle that claims a capability exists.
 *   - the PANEL POLICY is the operator's. It may only RESTRICT: switch a customer
 *     action off on one panel, lengthen a cooldown, cap one purchase. It is accepted
 *     only for actions the registry says the panel supports, and a policy can never
 *     make an unsupported action available, because every reader asks the registry
 *     (through `decideOperability`) first and the policy second.
 *   - DIAGNOSTICS are a projection of what the probe lane already stored. No second
 *     probe exists for them; `probe-core.ts` remains the only implementation.
 */

// ---------------------------------------------------------------------------
// The capability registry
// ---------------------------------------------------------------------------

/**
 * The rows an operator is shown, in the order they are shown.
 *
 * Named for what a person does with a service, not for the provider capability
 * underneath: `DISABLE_ENABLE` is one row over two declarations, and
 * `CREATE_SERVICE` is a row whose method half is the whole service adapter.
 *
 * `LOCATION_CHANGE` is WP-A6's capability, gated by `canChangeLocation` (both location
 * methods AND the declaration). No provider declares it in this release, so the row reads
 * unsupported for every provider — which is the truth, and is better than leaving the row
 * out, because an operator looking for it should learn that it is absent rather than
 * wonder whether it is hidden. `docs/provider-capability-audit.md` says, per provider,
 * what declaring it would need.
 */
export const CAPABILITY_REGISTRY_ROWS = [
  'CREATE_SERVICE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'RESET_TRAFFIC',
  'DISABLE_ENABLE',
  'ROTATE_SUBSCRIPTION',
  'SUBSCRIPTION_FILES',
  'EXTRA_DEVICES',
  'LOCATION_CHANGE',
  'USAGE_READ',
  'TERMINATE',
] as const;
export type CapabilityRegistryRow = (typeof CAPABILITY_REGISTRY_ROWS)[number];

/**
 * Why a row reads unsupported. Null exactly when it is supported.
 *
 *   - `NOT_DECLARED` — the adapter HAS the method and its descriptor does not
 *     declare the capability. Implemented, not yet proven against a real panel, and
 *     therefore not offered: CLAUDE.md's "a capability is declared after the
 *     acceptance proves it" is what this row is reporting.
 *   - `NOT_IMPLEMENTED` — declared with no method behind it. An adapter defect, and
 *     every guard fails closed on it.
 *   - `NOT_SUPPORTED` — neither.
 *   - `NOT_IN_RELEASE` — this release has no capability for the row at all.
 */
export const CAPABILITY_GAPS = [
  'NOT_DECLARED',
  'NOT_IMPLEMENTED',
  'NOT_SUPPORTED',
  'NOT_IN_RELEASE',
] as const;
export type CapabilityGap = (typeof CAPABILITY_GAPS)[number];

interface RegistryRowSpec {
  /** The declarations the row needs, every one of them. */
  readonly declarations: readonly ProviderCapability[];
  /** Whether the adapter has the METHODS the row needs, whatever it declares. */
  readonly implemented: (adapter: ProviderConnectionAdapter) => boolean;
  /**
   * The verdict, from the existing guard wherever one exists — never a restatement
   * of it. A unit test asserts `guard === implemented && declared` for every row
   * over every registered adapter and over synthetic ones.
   */
  readonly guard: (adapter: ProviderConnectionAdapter) => boolean;
}

const asService = (adapter: ProviderConnectionAdapter): ProviderAdapter | null =>
  isServiceAdapter(adapter) ? adapter : null;

const hasMethod = (adapter: ProviderConnectionAdapter, name: keyof ProviderAdapter): boolean =>
  typeof (adapter as Partial<ProviderAdapter>)[name] === 'function';

const serviceGuard =
  (predicate: (adapter: ProviderAdapter) => boolean) =>
  (adapter: ProviderConnectionAdapter): boolean => {
    const service = asService(adapter);
    return service !== null && predicate(service);
  };

const REGISTRY_SPECS: Readonly<Record<CapabilityRegistryRow, RegistryRowSpec | null>> = {
  /*
   * No `canCreateUser` exists: `decideOperability` asks for the service half and the
   * declaration, and this is the same pair.
   */
  CREATE_SERVICE: {
    declarations: ['CREATE_USER'],
    implemented: (adapter) => isServiceAdapter(adapter),
    guard: serviceGuard((adapter) => adapter.supports('CREATE_USER')),
  },
  RENEW: {
    declarations: ['RENEW_USER'],
    implemented: (adapter) => isServiceAdapter(adapter) && hasMethod(adapter, 'applyAllowance'),
    guard: serviceGuard(canRenewUser),
  },
  ADD_TRAFFIC: {
    declarations: ['ADD_VOLUME'],
    implemented: (adapter) => isServiceAdapter(adapter) && hasMethod(adapter, 'applyAllowance'),
    guard: serviceGuard(canAddVolume),
  },
  ADD_TIME: {
    declarations: ['ADD_TIME'],
    implemented: (adapter) => isServiceAdapter(adapter) && hasMethod(adapter, 'applyAllowance'),
    guard: serviceGuard(canAddTime),
  },
  /*
   * `RESET_USAGE` is a declared VOCABULARY entry with no method on `ProviderAdapter`,
   * so nothing can implement it and the row is unsupported everywhere — including on
   * RickPanel, whose route exists and whose effect has not been measured
   * (`docs/rickpanel-rotate-audit.md`).
   */
  RESET_TRAFFIC: {
    declarations: ['RESET_USAGE'],
    implemented: () => false,
    guard: () => false,
  },
  DISABLE_ENABLE: {
    declarations: ['DISABLE_USER', 'ENABLE_USER'],
    implemented: (adapter) =>
      isServiceAdapter(adapter) &&
      hasMethod(adapter, 'suspendUser') &&
      hasMethod(adapter, 'resumeUser'),
    guard: serviceGuard((adapter) => canDisableUser(adapter) && canEnableUser(adapter)),
  },
  ROTATE_SUBSCRIPTION: {
    declarations: ['ROTATE_SUBSCRIPTION_LINK'],
    implemented: (adapter) => isServiceAdapter(adapter) && hasMethod(adapter, 'rotateSubscription'),
    guard: serviceGuard(canRotateSubscription),
  },
  SUBSCRIPTION_FILES: {
    declarations: ['SUBSCRIPTION_FILES'],
    implemented: (adapter) =>
      isServiceAdapter(adapter) && hasMethod(adapter, 'fetchSubscriptionFiles'),
    guard: serviceGuard(canFetchSubscriptionFiles),
  },
  EXTRA_DEVICES: {
    declarations: ['DEVICE_LIMIT_ADJUSTMENT'],
    implemented: (adapter) =>
      isServiceAdapter(adapter) &&
      hasMethod(adapter, 'readDeviceLimit') &&
      hasMethod(adapter, 'applyDeviceLimit'),
    guard: serviceGuard(canAdjustDeviceLimit),
  },
  /* WP-A6's capability. See `CAPABILITY_REGISTRY_ROWS`. */
  LOCATION_CHANGE: {
    declarations: ['LOCATION_CHANGE'],
    implemented: (adapter) =>
      isServiceAdapter(adapter) &&
      hasMethod(adapter, 'readLocation') &&
      hasMethod(adapter, 'applyLocation'),
    guard: serviceGuard(canChangeLocation),
  },
  USAGE_READ: {
    declarations: ['READ_USAGE'],
    implemented: (adapter) => isServiceAdapter(adapter),
    guard: serviceGuard((adapter) => adapter.supports('READ_USAGE')),
  },
  TERMINATE: {
    declarations: ['DELETE_USER'],
    implemented: (adapter) => isServiceAdapter(adapter) && hasMethod(adapter, 'terminateUser'),
    guard: serviceGuard(canDeleteUser),
  },
};

/** The declarations a row needs, for the technical view. Empty for a row with none. */
export function registryRowDeclarations(row: CapabilityRegistryRow): readonly ProviderCapability[] {
  return REGISTRY_SPECS[row]?.declarations ?? [];
}

export interface CapabilityRegistryEntry {
  readonly row: CapabilityRegistryRow;
  readonly supported: boolean;
  readonly gap: CapabilityGap | null;
}

/**
 * One adapter's registry, every row, in order.
 *
 * Derived on every call from the adapter instance, never stored: a registry read from
 * a row is a registry that can be stale, which is exactly what `panelSummarySchema`
 * says about `capabilities`.
 */
export function deriveCapabilityRegistry(
  adapter: ProviderConnectionAdapter,
): readonly CapabilityRegistryEntry[] {
  return CAPABILITY_REGISTRY_ROWS.map((row) => {
    const spec = REGISTRY_SPECS[row];
    if (spec === null) return { row, supported: false, gap: 'NOT_IN_RELEASE' as const };
    if (spec.guard(adapter)) return { row, supported: true, gap: null };
    const declared = spec.declarations.every((capability) => adapter.supports(capability));
    const implemented = spec.implemented(adapter);
    const gap: CapabilityGap =
      implemented && !declared
        ? 'NOT_DECLARED'
        : declared && !implemented
          ? 'NOT_IMPLEMENTED'
          : 'NOT_SUPPORTED';
    return { row, supported: false, gap };
  });
}

// ---------------------------------------------------------------------------
// The panel policy
// ---------------------------------------------------------------------------

/**
 * The registry rows a CUSTOMER can act on from Telegram, and therefore the only rows a
 * policy can name.
 *
 * Every other row is operator or system work — creating the service a customer paid
 * for, terminating one, a reset nothing implements — and a per-panel switch over those
 * would be a switch over the executor that delivers money already taken, which the
 * money rules forbid: a paid order is FULFILLED or REFUNDED, never held because a
 * setting changed.
 */
export const PANEL_CUSTOMER_ACTIONS = [
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'EXTRA_DEVICES',
  'DISABLE_ENABLE',
  'ROTATE_SUBSCRIPTION',
  'SUBSCRIPTION_FILES',
  'USAGE_READ',
  /*
   * HF-A6A8: a customer's move of their service to another location (WP-A6) — paid or
   * free, from the Telegram button through the quote, its confirmation and the free
   * request. Its switch is accepted, like every other entry, only for a panel whose
   * adapter both implements and declares `LOCATION_CHANGE`; the capability is still
   * asked first everywhere, so the switch can only take a move away.
   */
  'LOCATION_CHANGE',
] as const satisfies readonly CapabilityRegistryRow[];
export type PanelCustomerAction = (typeof PANEL_CUSTOMER_ACTIONS)[number];

export function isPanelCustomerAction(row: CapabilityRegistryRow): row is PanelCustomerAction {
  return (PANEL_CUSTOMER_ACTIONS as readonly string[]).includes(row);
}

/**
 * How a delivered service's link reaches the customer.
 *
 * Both are the SAME delivery card — the approved `bot.service.delivered` text and its
 * buttons — and differ only in whether the QR image of the link is sent with it. Both
 * paths already exist in `DeliveryService`; the text-only one is the second half of the
 * split the card takes when its caption is too long. Neither changes what the adapter
 * produces, so neither needs a capability beyond the subscription link every service
 * provider delivers.
 */
export const PANEL_DELIVERY_MODES = ['CARD_WITH_QR', 'CARD_TEXT'] as const;
export type PanelDeliveryMode = (typeof PANEL_DELIVERY_MODES)[number];

/** The longest extra cooldown a policy may add: the rotation setting's own ceiling. */
export const PANEL_POLICY_COOLDOWN_MINUTES_MAX = LINK_ROTATION_COOLDOWN_HOURS_MAX * 60;
/** The largest single traffic purchase a cap may name, in GB. */
export const PANEL_POLICY_MAX_TRAFFIC_GB = 100_000;
/** The longest single time purchase a cap may name, in days: ten years. */
export const PANEL_POLICY_MAX_DAYS = 3650;

const customerEnabled = z.boolean();
const cooldownMinutes = z.number().int().min(1).max(PANEL_POLICY_COOLDOWN_MINUTES_MAX).nullable();

/**
 * The per-panel policy, as stored and as written.
 *
 * `.strict()` at every level, for the reason `settings.ts` has a registry: a key that is
 * not declared does not exist, and an unknown one fails closed at the schema. Each
 * action names only the knobs that mean something for it — a cooldown where this
 * codebase already enforces one (a customer's rotation and refresh), a cap where one
 * purchase has a size — so an operator cannot set a field that nothing reads.
 *
 * An absent action is the default: offered, with no extra limit. A null limit is "no
 * limit beyond the ones that already apply", never zero.
 */
export const panelPolicySchema = z
  .object({
    delivery: z.object({ mode: z.enum(PANEL_DELIVERY_MODES) }).strict(),
    actions: z
      .object({
        RENEW: z.object({ customerEnabled }).strict().optional(),
        ADD_TRAFFIC: z
          .object({
            customerEnabled,
            /** The largest single add-traffic package offered on this panel, in GB. */
            maxTrafficGb: z.number().int().min(1).max(PANEL_POLICY_MAX_TRAFFIC_GB).nullable(),
          })
          .strict()
          .optional(),
        ADD_TIME: z
          .object({
            customerEnabled,
            /** The longest single add-time package offered on this panel, in days. */
            maxDays: z.number().int().min(1).max(PANEL_POLICY_MAX_DAYS).nullable(),
          })
          .strict()
          .optional(),
        EXTRA_DEVICES: z
          .object({
            customerEnabled,
            /** The highest device limit an account on this panel may be raised to. */
            maxDeviceLimit: z.number().int().min(1).max(MAX_DEVICE_LIMIT).nullable(),
          })
          .strict()
          .optional(),
        DISABLE_ENABLE: z.object({ customerEnabled }).strict().optional(),
        ROTATE_SUBSCRIPTION: z
          .object({
            customerEnabled,
            /**
             * A floor on the wait between a customer's rotations, in minutes. The
             * effective wait is the LONGER of this and
             * `services.link_rotation_cooldown_hours`: a panel may only lengthen it.
             */
            cooldownMinutes,
          })
          .strict()
          .optional(),
        SUBSCRIPTION_FILES: z.object({ customerEnabled }).strict().optional(),
        USAGE_READ: z
          .object({
            customerEnabled,
            /** A floor on the wait between a customer's refreshes, in minutes. */
            cooldownMinutes,
          })
          .strict()
          .optional(),
        /*
         * A switch and nothing else: the cooldown and the rolling limit of a move are
         * per LOCATION (`service_locations`), where WP-A6 put them, so a second copy here
         * would be a knob that disagrees with the one `LocationChangePolicy` reads.
         */
        LOCATION_CHANGE: z.object({ customerEnabled }).strict().optional(),
      })
      .strict(),
  })
  .strict();
export type PanelPolicy = z.infer<typeof panelPolicySchema>;

/** A panel nobody has configured: everything the adapter supports, no extra limit. */
export const DEFAULT_PANEL_POLICY: PanelPolicy = {
  delivery: { mode: 'CARD_WITH_QR' },
  actions: {},
};

/**
 * A stored policy, read.
 *
 * `readable: false` is a row that does not parse — written by a newer release, or by
 * hand — and it is a real state rather than an error. Every customer action on that
 * panel is refused until an operator saves the policy again, because a policy is a
 * RESTRICTION and the safe reading of an unreadable restriction is the strictest one.
 * Delivery falls back to the default card: a paid service is delivered whatever the
 * policy row says, and the card is what every panel sent before policies existed.
 */
export type ResolvedPanelPolicy =
  { readonly readable: true; readonly policy: PanelPolicy } | { readonly readable: false };

export function resolvePanelPolicy(stored: unknown): ResolvedPanelPolicy {
  if (stored === null || stored === undefined) {
    return { readable: true, policy: DEFAULT_PANEL_POLICY };
  }
  const parsed = panelPolicySchema.safeParse(stored);
  return parsed.success ? { readable: true, policy: parsed.data } : { readable: false };
}

export const CUSTOMER_POLICY_REFUSALS = ['POLICY_DISABLED', 'POLICY_UNREADABLE'] as const;
export type CustomerPolicyRefusal = (typeof CUSTOMER_POLICY_REFUSALS)[number];

export type CustomerActionVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: CustomerPolicyRefusal };

/**
 * Whether a panel's policy lets a customer take one action.
 *
 * ONLY the policy's half. The capability half is `decideOperability`'s, and every
 * caller asks that first, so this can refuse and can never grant.
 */
export function customerActionVerdict(
  resolved: ResolvedPanelPolicy,
  action: PanelCustomerAction,
): CustomerActionVerdict {
  if (!resolved.readable) return { allowed: false, reason: 'POLICY_UNREADABLE' };
  const entry = resolved.policy.actions[action];
  if (entry !== undefined && !entry.customerEnabled) {
    return { allowed: false, reason: 'POLICY_DISABLED' };
  }
  return { allowed: true };
}

/**
 * The wait a customer's repeated action is held to, in milliseconds: the longer of the
 * installation's own floor and this panel's. A panel can lengthen the wait, never
 * shorten it.
 */
export function effectiveCooldownMs(
  floorMs: number,
  resolved: ResolvedPanelPolicy,
  action: 'ROTATE_SUBSCRIPTION' | 'USAGE_READ',
): number {
  if (!resolved.readable) return floorMs;
  const minutes = resolved.policy.actions[action]?.cooldownMinutes ?? null;
  return minutes === null ? floorMs : Math.max(floorMs, minutes * 60_000);
}

/** The largest single traffic purchase on this panel, in bytes; null for no cap. */
export function policyMaxTrafficBytes(resolved: ResolvedPanelPolicy): bigint | null {
  if (!resolved.readable) return null;
  const gb = resolved.policy.actions.ADD_TRAFFIC?.maxTrafficGb ?? null;
  return gb === null ? null : BigInt(gb) * BYTES_PER_GB;
}

/** The longest single time purchase on this panel, in days; null for no cap. */
export function policyMaxDays(resolved: ResolvedPanelPolicy): number | null {
  if (!resolved.readable) return null;
  return resolved.policy.actions.ADD_TIME?.maxDays ?? null;
}

/** The highest device limit an account on this panel may reach; null for no cap. */
export function policyMaxDeviceLimit(resolved: ResolvedPanelPolicy): number | null {
  if (!resolved.readable) return null;
  return resolved.policy.actions.EXTRA_DEVICES?.maxDeviceLimit ?? null;
}

/** How a service on this panel is delivered. An unreadable policy delivers the default. */
export function deliveryModeOf(resolved: ResolvedPanelPolicy): PanelDeliveryMode {
  return resolved.readable ? resolved.policy.delivery.mode : DEFAULT_PANEL_POLICY.delivery.mode;
}

/**
 * The actions a policy names that the panel's adapter cannot perform.
 *
 * The write path refuses a policy naming any of them, so an operator cannot configure a
 * behaviour the product does not have. Stored rows are not rewritten when an adapter
 * loses a capability: such an entry can only restrict an action that is refused anyway.
 */
export function unsupportedPolicyActions(
  policy: PanelPolicy,
  registry: readonly CapabilityRegistryEntry[],
): readonly PanelCustomerAction[] {
  const supported = new Set(registry.filter((entry) => entry.supported).map((entry) => entry.row));
  return PANEL_CUSTOMER_ACTIONS.filter(
    (action) => policy.actions[action] !== undefined && !supported.has(action),
  );
}

// ---------------------------------------------------------------------------
// Provider-specific rules
// ---------------------------------------------------------------------------

/**
 * The fixed provider-side behaviour each adapter applies, stated so an operator can
 * read it rather than infer it.
 *
 * Not settings. Each value is what the adapter's own request body carries today, and a
 * unit test drives every adapter's create and pins the body against this table, so the
 * statement cannot drift from the request.
 *
 *   - `trafficReset` — every adapter sends "no periodic reset" (`data_limit_reset_strategy:
 *     'no_reset'` on Marzban and RickPanel, `reset: 0` on 3X-UI). It is not offered as a
 *     setting although Marzban has others (`day`, `week`, `month`, `year`): a panel that
 *     resets consumption on a period would give a customer more traffic than they bought,
 *     and would make every add-traffic target — which counts consumption — wrong.
 *   - `protocols` / `inbounds` — who chooses them: the operator through the activation
 *     (Marzban's protocols and tags, 3X-UI's inbound), or the panel itself (RickPanel,
 *     whose contract ignores both).
 *   - `subscriptionLink` — whether the link is the panel's own answer or is built from
 *     the configured subscription domain (3X-UI).
 *   - `deviceLimitOnCreate` — whether a product's device limit is written to the new
 *     account (3X-UI's `limitIp`) or not sent at all.
 */
export const PROVIDER_TRAFFIC_RESET_RULES = ['NEVER'] as const;
export const PROVIDER_PROTOCOL_RULES = [
  'OPERATOR_CHOSEN',
  'PANEL_ASSIGNED',
  'INBOUND_DEFINED',
] as const;
export const PROVIDER_INBOUND_RULES = [
  'OPERATOR_TAGS',
  'OPERATOR_INBOUND_ID',
  'PANEL_ASSIGNED',
] as const;
export const PROVIDER_SUBSCRIPTION_LINK_RULES = ['PANEL_ISSUED', 'SUBSCRIPTION_DOMAIN'] as const;
export const PROVIDER_DEVICE_LIMIT_RULES = ['FROM_PRODUCT', 'NOT_SENT'] as const;

export const providerRulesSchema = z.object({
  trafficReset: z.enum(PROVIDER_TRAFFIC_RESET_RULES),
  protocols: z.enum(PROVIDER_PROTOCOL_RULES),
  inbounds: z.enum(PROVIDER_INBOUND_RULES),
  subscriptionLink: z.enum(PROVIDER_SUBSCRIPTION_LINK_RULES),
  deviceLimitOnCreate: z.enum(PROVIDER_DEVICE_LIMIT_RULES),
});
export type ProviderRules = z.infer<typeof providerRulesSchema>;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * What an operator is told about a panel, one check at a time.
 *
 * Every verdict is computed from what is already stored — the latest health row, the
 * credential timestamps, the activation, the connection-validation identity and the
 * registry — so reading diagnostics never dials a panel.
 */
export const PANEL_DIAGNOSTIC_CHECKS = [
  'CONNECTIVITY',
  'CREDENTIALS',
  'AUTHENTICATION',
  'PROVIDER_STATUS',
  'CONFIGURATION',
  'CONNECTION_TEST',
  'FRESHNESS',
  'REQUIRED_CAPABILITIES',
] as const;
export type PanelDiagnosticCheck = (typeof PANEL_DIAGNOSTIC_CHECKS)[number];

export const DIAGNOSTIC_VERDICTS = ['PASS', 'WARN', 'FAIL', 'UNKNOWN'] as const;
export type DiagnosticVerdict = (typeof DIAGNOSTIC_VERDICTS)[number];

/** The overall reading, worst check first. */
export const PANEL_DIAGNOSTIC_OVERALL = [
  'OK',
  'DEGRADED',
  'ERROR',
  'NOT_CHECKED',
  'DISABLED',
] as const;
export type PanelDiagnosticOverall = (typeof PANEL_DIAGNOSTIC_OVERALL)[number];

/**
 * The provider capabilities a panel needs to be sold on and looked after: probed,
 * created on, delivered from and read back. Shown one by one.
 */
export const PANEL_REQUIRED_CAPABILITIES = [
  'HEALTH_CHECK',
  'CREATE_USER',
  'DELIVER_SUBSCRIPTION_LINK',
  'READ_USAGE',
] as const satisfies readonly ProviderCapability[];

// ---------------------------------------------------------------------------
// HTTP shapes
// ---------------------------------------------------------------------------

const isoTimestamp = z.iso.datetime().refine((v) => isStorableInstant(new Date(v)), {
  message: 'must be a storable instant',
});

export const capabilityRegistryEntrySchema = z.object({
  row: z.enum(CAPABILITY_REGISTRY_ROWS),
  supported: z.boolean(),
  gap: z.enum(CAPABILITY_GAPS).nullable(),
});

/**
 * Whether a customer on this panel is offered the action, and if not, the first reason.
 *
 * `TENANT_FEATURE_OFF` is a tenant-wide switch that also governs the action (a
 * customer's link rotation has `customer_link_rotation`). What this does NOT fold in is
 * the catalogue — whether any add-on is on sale — and the panel's own operability, which
 * `sellability` and the diagnostics already say, so one reason cannot hide the other.
 */
export const CUSTOMER_AVAILABILITY_BLOCKERS = [
  'UNSUPPORTED',
  'POLICY_DISABLED',
  'POLICY_UNREADABLE',
  'TENANT_FEATURE_OFF',
] as const;
export type CustomerAvailabilityBlocker = (typeof CUSTOMER_AVAILABILITY_BLOCKERS)[number];

export const panelCapabilityRowSchema = capabilityRegistryEntrySchema.extend({
  /** Null for a row no customer acts on. */
  customer: z
    .object({
      available: z.boolean(),
      blocker: z.enum(CUSTOMER_AVAILABILITY_BLOCKERS).nullable(),
    })
    .nullable(),
});
export type PanelCapabilityRow = z.infer<typeof panelCapabilityRowSchema>;

export const panelDiagnosticsSchema = z.object({
  overall: z.enum(PANEL_DIAGNOSTIC_OVERALL),
  checks: z.array(
    z.object({ check: z.enum(PANEL_DIAGNOSTIC_CHECKS), verdict: z.enum(DIAGNOSTIC_VERDICTS) }),
  ),
  /** The normalized failure of the latest probe, never a provider message. */
  failure: z.enum(PROVIDER_FAILURE_KINDS).nullable(),
  httpStatus: z.number().int().nullable(),
  providerVersion: z.string().nullable(),
  lastCheckedAt: isoTimestamp.nullable(),
  /** The last probe that concluded the panel was reachable and authenticated. */
  lastSuccessfulCheckAt: isoTimestamp.nullable(),
  stale: z.boolean(),
  requiredCapabilities: z.array(
    z.object({ capability: z.enum(PROVIDER_CAPABILITIES), available: z.boolean() }),
  ),
  missingActivationFields: z.array(z.string()),
});
export type PanelDiagnostics = z.infer<typeof panelDiagnosticsSchema>;

export const panelPolicyStateSchema = z.object({
  /** The policy in force: the stored one, or the default when none is stored. */
  policy: panelPolicySchema,
  /** False when a stored row does not parse; `policy` is then the default, shown for reference. */
  readable: z.boolean(),
  /** Zero when nothing has been stored. What a write must name as `expectedRevision`. */
  revision: z.number().int().nonnegative(),
  updatedAt: isoTimestamp.nullable(),
});

export const panelAdvancedResponseSchema = z.object({
  panelId: z.string(),
  providerType: z.enum(PROVIDER_TYPES),
  providerName: z.string(),
  status: z.enum(PANEL_STATUSES),
  health: z.enum(PANEL_HEALTH_VIEWS),
  registry: z.array(panelCapabilityRowSchema),
  policy: panelPolicyStateSchema,
  providerRules: providerRulesSchema,
  diagnostics: panelDiagnosticsSchema,
});
export type PanelAdvancedResponse = z.infer<typeof panelAdvancedResponseSchema>;

/**
 * Replacing a panel's policy. Whole, never a patch: the form sends the policy it shows,
 * and `expectedRevision` is the revision it was shown, so two operators editing one
 * panel cannot silently overwrite each other.
 */
export const updatePanelPolicyRequestSchema = z.object({
  policy: panelPolicySchema,
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(255),
});
export type UpdatePanelPolicyRequest = z.infer<typeof updatePanelPolicyRequestSchema>;

export const updatePanelPolicyResponseSchema = z.object({
  advanced: panelAdvancedResponseSchema,
  /** False for a save that stored what was already stored, or a replay. */
  changed: z.boolean(),
});
export type UpdatePanelPolicyResponse = z.infer<typeof updatePanelPolicyResponseSchema>;

/**
 * The Super Admin's read-only technical view (`panels.technical.view`).
 *
 * Raw identifiers — capability keys, the credential shape, failure kinds, the stored
 * activation and policy exactly as stored — for somebody debugging the integration.
 * No credential leaves here either: the three credential fields are the set-at
 * timestamps, as everywhere else, because the repository never selects a ciphertext.
 */
export const panelTechnicalResponseSchema = z.object({
  panelId: z.string(),
  providerType: z.enum(PROVIDER_TYPES),
  descriptor: z.object({
    canonicalName: z.string(),
    credentialShape: z.enum(CREDENTIAL_SHAPES),
    capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)),
    requiredActivationFields: z.array(z.string()),
    maxRequestsPerProbe: z.number().int().positive(),
  }),
  registry: z.array(
    capabilityRegistryEntrySchema.extend({
      declarations: z.array(z.enum(PROVIDER_CAPABILITIES)),
    }),
  ),
  storedActivation: z.unknown(),
  storedPolicy: z.unknown(),
  policyRevision: z.number().int().nonnegative(),
  health: z.object({
    storedState: z.string().nullable(),
    failure: z.enum(PROVIDER_FAILURE_KINDS).nullable(),
    statusCode: z.number().int().nullable(),
    providerVersion: z.string().nullable(),
    checkedAt: isoTimestamp.nullable(),
    lastHealthyAt: isoTimestamp.nullable(),
    unusableStreak: z.number().int().nonnegative(),
  }),
  credentialsSetAt: z.object({
    username: isoTimestamp.nullable(),
    password: isoTimestamp.nullable(),
    apiToken: isoTimestamp.nullable(),
  }),
});
export type PanelTechnicalResponse = z.infer<typeof panelTechnicalResponseSchema>;

export const PANEL_ADVANCED_ROUTES = {
  advanced: (id: string) => `/panels/${encodeURIComponent(id)}/advanced`,
  policy: (id: string) => `/panels/${encodeURIComponent(id)}/policy`,
  technical: (id: string) => `/panels/${encodeURIComponent(id)}/technical`,
} as const;
