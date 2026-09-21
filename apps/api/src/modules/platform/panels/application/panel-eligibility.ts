import {
  PANEL_ACTIVATION_SCHEMAS,
  PANEL_HEALTH_FRESH_FOR_MS,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  PANEL_UNUSABLE_HEALTH_STATES,
  isProviderType,
  providerDescriptor,
  shapeIsSatisfiedBy,
  supportsCapability,
  type PanelHealthState,
  type PanelIneligibilityReason,
  type PanelStatus,
} from '@nexa/contracts';

/**
 * Everything the decision reads. A struct rather than a `PanelView`, because
 * eligibility is asked in the middle of an order transaction that holds no
 * panel repository — the caller assembles these four facts from what it has.
 */
export interface EligibilityInput {
  readonly status: PanelStatus;
  /** Null when the panel has never been probed. NOT a failure. */
  readonly health: {
    readonly state: PanelHealthState;
    readonly checkedAt: Date;
    readonly unusableStreak: number;
    /**
     * The connection identity this probe ran against, or null for a row written
     * before the column existed.
     *
     * Optional on this interface so the two capacity-only callers below — which
     * pass `maxServices: null` precisely to reach a decision capacity cannot
     * change — are not made to assemble a field they do not use.
     */
    readonly validatedIdentity?: string | null;
  } | null;
  /** The cap, or null for no limit. */
  readonly maxServices: number | null;
  /** Services that occupy a slot, plus reservations nobody has released. */
  readonly used: number;
  readonly now: Date;
  /**
   * WHAT THIS PANEL WOULD HAVE TO DO, AND WHETHER IT COULD.
   *
   * REQUIRED, and it was optional for about an hour while this was written. That
   * is the wrong default and the reason is the whole incident: a caller that
   * forgot it would compile, run, and silently decide sales the old way. Deny by
   * default means a new decision point fails to BUILD rather than failing to
   * check.
   */
  readonly provisioning: ProvisioningInput;
}

/**
 * Everything the provisionability half reads. Assembled from a `PanelView`,
 * which already carries all of it.
 *
 * A credential SUMMARY, never a value — the same signature discipline
 * `decideOperability` documents: a function that could not receive a secret is a
 * stronger guarantee than a rule about not passing one.
 */
export interface ProvisioningInput {
  readonly providerType: string;
  /** Exactly as stored. Validated here, never trusted. */
  readonly activation: unknown;
  readonly credentials: {
    readonly usernameSetAt: Date | null;
    readonly passwordSetAt: Date | null;
    readonly apiTokenSetAt: Date | null;
  } | null;
  /**
   * Whether this release has an adapter implementing the SERVICE half for this
   * provider type.
   *
   * Passed rather than imported, exactly as `OperabilityInput` does it and for
   * the same reason: the registry is infrastructure and this is the application
   * layer. It is also the honest seam — "a descriptor exists" and "code exists
   * that can create a user" are different statements.
   */
  readonly serviceAdapterExists: boolean;
  /**
   * The identity a probe would have to have validated for this panel to count
   * as tested: `connectionIdentityOf(panel)`, computed by the caller.
   */
  readonly currentIdentity: string;
}

export type PanelEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: PanelIneligibilityReason };

const ELIGIBLE: PanelEligibility = { eligible: true };

/**
 * Whether this panel may be SOLD onto right now.
 *
 * A different question from `decideOperability`, which asks whether ONE
 * operation may run against a panel at the moment of the provider call. This is
 * asked before a customer is charged, and the two still disagree in both
 * directions: a full panel is operable and ineligible, and a panel whose adapter
 * cannot SUSPEND is eligible and inoperable for that one operation.
 *
 * ## What this evaluator got wrong, and what it cost
 *
 * It used to ask only whether the panel was switched on, reachable and not full.
 * Order `01a0c54b` on v0.2.8 was sold onto a panel that was all three and had no
 * Marzban activation configured: the customer paid, the provisioner discovered
 * `ACTIVATION_INCOMPLETE` five times over seven minutes, and the order was
 * refunded. `docs/hotfix-activation-audit.md` reconstructs it.
 *
 * Every one of those facts WAS checked — by `decideOperability`, after the money
 * had moved. So this now asks the provisionability half too, and the separation
 * that survives is the useful one: operability still answers about a specific
 * OPERATION and still ignores health; eligibility still answers about a SALE and
 * still ignores the capabilities a sale does not need.
 *
 * ## The order is the argument
 *
 * `ARCHIVED` and `DISABLED` first, because they are DECISIONS. An operator who
 * archived a panel is not asking to be told it is also at capacity, and a
 * measurement must never be reported in place of somebody's own instruction.
 *
 * Then provisionability, and it comes BEFORE health deliberately. These are
 * facts about our own row — certain, and fixable on a form the operator already
 * has open. Health is a MEASUREMENT, and one that can be stale or wrong. Telling
 * an operator their panel is unreachable when what is missing is an inbound tag
 * sends them to tcpdump instead of to the field.
 *
 * `PROVISION_UNSUPPORTED` leads that group because it is a statement about CODE:
 * no operator action fixes it, so it must not be reported as configuration.
 *
 * `UNVALIDATED` comes AFTER health, and the other three come before it, because
 * it is the only one of the four that depends on a probe having run. A panel
 * confirmed down is better described as down than as untested.
 *
 * Capacity last: "at capacity" reads as a business condition an operator
 * resolves by raising a number, and it is the only reason here that resolves
 * itself.
 *
 * ## What is NOT a reason
 *
 * A panel nobody has probed is not `UNHEALTHY`. `UNCHECKED` is the absence of
 * evidence, not evidence of absence.
 *
 * It IS `UNVALIDATED`, which is a different statement with a different remedy:
 * one button, on the panel's own page. The old docblock argued the opposite —
 * "a fresh installation whose monitor has not run yet must be able to sell" —
 * and that sentence is how order `01a0c54b` happened. A panel is CREATED
 * `ACTIVE` (`DrizzlePanelRepository.create`), so under that rule a brand-new row
 * with no credentials, no activation and no probe was immediately sellable. The
 * remedy was never the monitor: it is the operator pressing Test Connection,
 * which they must do anyway before enabling a panel they have disabled.
 *
 * A panel whose health is STALE is eligible, and this is the rule that keeps a
 * stopped monitor from closing every shop in the installation. Old evidence
 * stops being evidence; it does not become worse evidence. **`UNVALIDATED` is
 * deliberately written not to re-introduce that**: it asks WHAT was validated,
 * never WHEN. A probe from last month against an unchanged configuration still
 * proves the address and credentials reach that panel.
 *
 * A `DEGRADED` panel is eligible. `PANEL_UNUSABLE_HEALTH_STATES` says why: the
 * credentials were accepted and the panel answered, so the next create will very
 * likely work, and only the diagnostic read failed.
 */
export function decideEligibility(input: EligibilityInput): PanelEligibility {
  if (input.status === 'ARCHIVED') return { eligible: false, reason: 'ARCHIVED' };
  if (input.status !== 'ACTIVE') return { eligible: false, reason: 'DISABLED' };

  const provisioning = input.provisioning;
  if (!canProvision(provisioning)) {
    return { eligible: false, reason: 'PROVISION_UNSUPPORTED' };
  }
  if (!credentialsPresent(provisioning)) {
    return { eligible: false, reason: 'CREDENTIALS_MISSING' };
  }
  if (activationIssues(provisioning.providerType, provisioning.activation).length > 0) {
    return { eligible: false, reason: 'ACTIVATION_INCOMPLETE' };
  }

  if (isConfirmedUnusable(input.health, input.now)) {
    return { eligible: false, reason: 'UNHEALTHY' };
  }
  if (!connectionValidated(input.health, provisioning)) {
    return { eligible: false, reason: 'UNVALIDATED' };
  }
  if (input.maxServices !== null && input.used >= input.maxServices) {
    return { eligible: false, reason: 'AT_CAPACITY' };
  }
  return ELIGIBLE;
}

/**
 * Whether this release could create a user on this provider at all.
 *
 * BOTH halves, and neither implies the other. A descriptor may declare
 * `CREATE_USER` in a release whose adapter registry has no service adapter for
 * it — Marzban spent three releases in exactly that state — and an adapter may
 * exist for a provider whose descriptor does not declare the capability, which
 * `CLAUDE.md` requires: a capability is declared AFTER the acceptance proves it,
 * so an implemented-but-unproven create is refused rather than offered.
 */
function canProvision(input: ProvisioningInput): boolean {
  if (!isProviderType(input.providerType) || !input.serviceAdapterExists) return false;
  const descriptor = providerDescriptor(input.providerType);
  if (descriptor === null) return false;
  return supportsCapability(descriptor, 'CREATE_USER');
}

/** Whether the credentials this provider's shape requires are all set. */
function credentialsPresent(input: ProvisioningInput): boolean {
  if (!isProviderType(input.providerType)) return false;
  const descriptor = providerDescriptor(input.providerType);
  if (descriptor === null) return false;
  return shapeIsSatisfiedBy(descriptor.credentialShape, {
    username: input.credentials?.usernameSetAt != null,
    password: input.credentials?.passwordSetAt != null,
    apiToken: input.credentials?.apiTokenSetAt != null,
  });
}

/**
 * Whether this panel has been CONTACTED with the configuration it has now.
 *
 * Two conditions, and the two that are NOT here matter more than the two that
 * are:
 *
 *   - a probe exists at all. A panel nobody ever contacted has not been tested,
 *     and since `DrizzlePanelRepository.create` writes `status: 'ACTIVE'`, this
 *     is the condition that stops a row created seconds ago being sold onto.
 *   - it ran against the CURRENT identity. `connectionIdentityOf` is provider,
 *     address, activation and the three credential timestamps, so changing any
 *     of them invalidates the evidence at once. That is the mechanism: a panel
 *     whose inbound tags were cleared after its last probe stops counting as
 *     tested, which is the shape of the incident this fixes.
 *
 * ## Why it does NOT check the probe's state, and why that is not a shortcut
 *
 * The first version of this function required the last probe to be
 * non-`UNUSABLE`, on the reasoning that a "successful connection test" means a
 * success. Two existing tests killed it, and both were right:
 *
 *   - **hysteresis.** One or two fresh `UNREACHABLE` probes must not stop a
 *     panel selling; that rule exists so a dropped packet is not an outage of
 *     the shop, and `PANEL_UNHEALTHY_AFTER_FAILURES` is where the line is. A
 *     state check here moved that line to one.
 *   - **the stale-failure case.** A failure too old to be believed as a verdict
 *     is handled by `isConfirmedUnusable`, and reading it here as "never
 *     validated" is the same evidence counted twice.
 *
 * So the division of labour is: this asks WHETHER WE HAVE TRIED this exact
 * configuration, and the health lane — with its streak and its freshness bound —
 * asks whether what we learned is bad enough to stop.
 *
 * ## What this therefore does not catch, stated rather than implied
 *
 * `panel_health` is latest-state-only and `recordHealth` writes
 * `validated_identity` on FAILURES too, so the row cannot distinguish "a probe
 * succeeded against this identity" from "a probe was attempted against it". A
 * panel whose every probe has failed once or twice is still sellable here. That
 * is not a new hole — it is exactly the hysteresis window that has always
 * existed — and closing it would need a durable "last succeeded for identity X",
 * which is a schema change and not a hotfix.
 *
 * A NULL `validatedIdentity` — a health row written before the column existed —
 * counts as not contacted. Fail-closed, and the remedy is the connection-test
 * button, which writes the column. The upgrade window that opens is stated in
 * `docs/hotfix-activation-audit.md` rather than hidden.
 */
export function connectionValidated(
  health: EligibilityInput['health'],
  input: ProvisioningInput,
): boolean {
  if (health === null) return false;
  const validated = health.validatedIdentity;
  if (validated === null || validated === undefined) return false;
  return validated === input.currentIdentity;
}

/**
 * Which activation fields this provider's schema rejected, as IT names them.
 *
 * The schema's own paths rather than a sentence, so the Web Admin can point at
 * the input that is wrong. `marzbanActivationSchema` already produces
 * `inboundTags.vless` for a protocol with no tags, which is exactly the string a
 * form needs.
 *
 * An unset activation reports the provider's required top-level fields rather
 * than "activation". Zod given `null` produces one issue at the root, and "the
 * activation is invalid" is the message that sends an operator looking for a
 * screen they have already found.
 *
 * Exported because the surface reports it and the evaluator decides on it, and
 * those two must not be able to disagree about what is missing.
 */
export function activationIssues(providerType: string, activation: unknown): readonly string[] {
  if (!isProviderType(providerType)) return ['providerType'];
  const parsed = PANEL_ACTIVATION_SCHEMAS[providerType].safeParse(activation);
  if (parsed.success) return [];
  if (activation === null || activation === undefined) {
    return Object.keys(PANEL_ACTIVATION_SCHEMAS[providerType].def.shape);
  }
  const paths = parsed.error.issues.map((issue) =>
    issue.path.length === 0 ? 'activation' : issue.path.join('.'),
  );
  return [...new Set(paths)];
}

/**
 * Whether the health row is recent enough, and bad enough for long enough, to
 * stop this panel taking business.
 *
 * All three conditions, and dropping any one of them breaks a different case.
 * Without the STATE check a degraded panel stops selling. Without the STREAK a
 * single dropped packet does. Without the FRESHNESS a health row from before a
 * restore — or from before the monitor was stopped for an afternoon — keeps a
 * working panel shut for ever, because nothing will ever overwrite a row that
 * only a probe can overwrite.
 *
 * Exported because the recovery rule is the negation of it and the two must not
 * be able to drift: a panel becomes eligible again exactly when this stops
 * holding, which one fresh non-unusable probe achieves by resetting the streak.
 */
export function isConfirmedUnusable(
  health: EligibilityInput['health'],
  now: Date,
  freshForMs: number = PANEL_HEALTH_FRESH_FOR_MS,
): boolean {
  if (health === null) return false;
  if (!PANEL_UNUSABLE_HEALTH_STATES.includes(health.state)) return false;
  if (health.unusableStreak < PANEL_UNHEALTHY_AFTER_FAILURES) return false;
  return now.getTime() - health.checkedAt.getTime() <= freshForMs;
}

/**
 * The parts of a panel a successful connection test actually vouches for.
 *
 * Base URL, provider, activation and WHEN each credential was last set. A test
 * proves those four worked together; it proves nothing about a different
 * address, a different inbound or a password replaced since.
 *
 * Deliberately NOT `configurationFingerprint`, which exists to cancel an
 * in-flight probe whose panel changed under it and therefore includes `status`
 * and `updatedAt`. Both move when a panel is enabled, so a validation keyed on
 * that digest would be invalidated by the very act it authorises — and every
 * routine re-enable after maintenance would demand a fresh test for no reason.
 *
 * The three credential timestamps rather than the credentials: a value here
 * would put a verifier for a panel password in a column that is not the
 * credential table. A replaced password moves its timestamp, which is all this
 * needs to know.
 *
 * Activation is serialised with sorted keys so that re-saving the same
 * configuration in a different key order does not read as a change. A test an
 * operator did not invalidate must not stop authorising.
 */
export function connectionIdentityOf(input: {
  readonly providerType: string;
  readonly baseUrl: string;
  readonly activation: unknown;
  readonly usernameSetAt: Date | null;
  readonly passwordSetAt: Date | null;
  readonly apiTokenSetAt: Date | null;
}): string {
  return [
    input.providerType,
    input.baseUrl,
    stableJson(input.activation),
    input.usernameSetAt?.getTime() ?? 0,
    input.passwordSetAt?.getTime() ?? 0,
    input.apiTokenSetAt?.getTime() ?? 0,
  ].join('|');
}

/** JSON with object keys in a fixed order, so equal values compare equal. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, held]) => held !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, held]) => `${JSON.stringify(key)}:${stableJson(held)}`).join(',')}}`;
}

/**
 * Whether a stored health row may authorise ENABLING this panel.
 *
 * Three conditions, and each one is a way an operator could otherwise enable a
 * panel that does not work:
 *
 *   - the probe concluded something USABLE. `DEGRADED` counts, for the reason
 *     `PANEL_UNUSABLE_HEALTH_STATES` gives: the credentials were accepted and
 *     the panel answered. What enabling needs to know is that this address and
 *     these credentials reach that panel, which a degraded probe establishes.
 *   - it ran against the CURRENT identity. Fix a password after a green test
 *     and the green test stops counting, which is the whole point.
 *   - it is recent. `PANEL_HEALTH_FRESH_FOR_MS` is reused rather than a second
 *     number invented: "is this answer still worth believing" is one question,
 *     and an installation with two freshness policies has one nobody can state.
 *
 * A row written before `validated_identity` existed has NULL there and
 * authorises nothing. That is the fail-closed direction: an upgrade must not
 * silently bless a validation nobody can attribute to a configuration.
 */
export function validationAuthorisesEnable(
  health: {
    readonly state: PanelHealthState;
    readonly checkedAt: Date;
    readonly validatedIdentity: string | null;
  } | null,
  currentIdentity: string,
  now: Date,
  freshForMs: number = PANEL_HEALTH_FRESH_FOR_MS,
): boolean {
  if (health === null) return false;
  if (PANEL_UNUSABLE_HEALTH_STATES.includes(health.state)) return false;
  if (health.validatedIdentity === null) return false;
  if (health.validatedIdentity !== currentIdentity) return false;
  return now.getTime() - health.checkedAt.getTime() <= freshForMs;
}

/**
 * The provisionability half, assembled from a panel row and its credential
 * summary.
 *
 * Exported and used by BOTH readers — `PanelSalesGate`, which decides sales, and
 * `PanelService`, which reports the state to an operator. A second assembly
 * would be a second opinion about what "could this panel deliver" reads from,
 * and the two would disagree on the day one of them gained a field: the screen
 * would say sellable and the confirmation would refuse, which is the failure
 * this whole hotfix exists to stop, inverted.
 *
 * Takes the panel and credentials separately rather than a `PanelView`, so this
 * module does not have to import the repository's view type to answer a question
 * about four fields.
 */
export function provisioningInputFor(input: {
  readonly providerType: string;
  readonly baseUrl: string;
  readonly activation: unknown;
  readonly credentials: {
    readonly usernameSetAt: Date | null;
    readonly passwordSetAt: Date | null;
    readonly apiTokenSetAt: Date | null;
  };
  readonly serviceAdapterExists: boolean;
}): ProvisioningInput {
  return {
    providerType: input.providerType,
    activation: input.activation,
    credentials: input.credentials,
    serviceAdapterExists: input.serviceAdapterExists,
    currentIdentity: connectionIdentityOf({
      providerType: input.providerType,
      baseUrl: input.baseUrl,
      activation: input.activation,
      usernameSetAt: input.credentials.usernameSetAt,
      passwordSetAt: input.credentials.passwordSetAt,
      apiTokenSetAt: input.credentials.apiTokenSetAt,
    }),
  };
}
