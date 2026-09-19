/**
 * Panels — a tenant's connections to the provider software it sells access to.
 *
 * A panel is configuration plus a credential plus a last-known health, and the
 * three have deliberately different lifetimes. Configuration changes when an
 * operator edits it. A credential changes when an operator replaces it, and is
 * never read back out. Health changes on every probe, which is why it is not
 * part of the panel row at all — see `panel_health` in the schema.
 *
 * The legacy system had none of these separations. Its per-panel setters were
 * write-only ("the only way to read one is to overwrite it", `UNK-XUI-009`),
 * its panel credentials sat in plaintext, and a panel that stopped answering
 * produced an alert with no deduplication, no back-off, and no record of when
 * it had last worked (`UNK-XUI-016/017`).
 */

/**
 * A panel's lifecycle.
 *
 * `ARCHIVED` rather than a delete. Phase 4 attaches services, orders and
 * traffic records to a panel, and a row those will reference must not be
 * removable — a hard delete would either orphan them or cascade into deleting a
 * customer's service history because an operator tidied a list. Archiving keeps
 * the referent, takes the panel out of every list and every probe, and is
 * reversible.
 *
 * `DISABLED` is the operator saying "stop using this for now". `ARCHIVED` is
 * "this is finished". Both stop probing; only `ARCHIVED` releases the name.
 */
export const PANEL_STATUSES = ['ACTIVE', 'DISABLED', 'ARCHIVED'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

/**
 * What a probe can CONCLUDE about a panel. Exactly these four are storable.
 *
 * `DEGRADED` is not a hedge. It is the specific, reachable state where the
 * credentials were accepted — so the panel is up and the configuration is
 * right — but the follow-up call that reads the panel's own status failed or
 * returned something unreadable. An operator needs that distinguished from
 * `UNREACHABLE`, because the remedy is different and because a degraded panel
 * may still be serving customers.
 */
export const PANEL_HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNREACHABLE', 'AUTH_FAILED'] as const;
export type PanelHealthState = (typeof PANEL_HEALTH_STATES)[number];

/**
 * What an OPERATOR sees, which is the four probe outcomes plus two states no
 * probe can produce.
 *
 * `UNCHECKED` is the absence of a health row, not a stored value: a panel that
 * has never been probed has nothing to store, and inventing a row to hold
 * "nothing has happened yet" is how a never-checked panel starts looking like a
 * checked one. `DISABLED` is projected from the panel's status for the same
 * reason — storing it would mean re-enabling a panel required a health write,
 * and the health of a panel nobody is probing is not a fact about the panel.
 */
export const PANEL_HEALTH_VIEWS = [
  ...PANEL_HEALTH_STATES,
  'DISABLED',
  'UNCHECKED',
] as const satisfies readonly string[];
export type PanelHealthView = (typeof PANEL_HEALTH_VIEWS)[number];

/**
 * Which credential a panel has configured. Reported; never valued.
 *
 * The Web Admin needs to render "Password: configured — [Replace]" and must
 * never receive the password to do it. A masked placeholder like `********` is
 * worse than nothing: an edit form populated with one will happily submit it
 * back as if it were the real value, which is how a password becomes the
 * literal string of asterisks.
 */
export const PANEL_CREDENTIAL_KINDS = ['USERNAME', 'PASSWORD', 'API_TOKEN'] as const;
export type PanelCredentialKind = (typeof PANEL_CREDENTIAL_KINDS)[number];

/**
 * How a panel's name is bounded.
 *
 * Names are operator-chosen labels, unique per tenant among panels that are not
 * archived. They are not identifiers: nothing resolves a panel by name.
 */
export const PANEL_NAME_MIN_LENGTH = 1;
export const PANEL_NAME_MAX_LENGTH = 120;

/** A panel's base URL, bounded so a pathological value cannot reach the parser. */
export const PANEL_BASE_URL_MAX_LENGTH = 2048;

/**
 * Why the background monitor stepped back from a panel without probing it.
 *
 * Scheduling metadata, and deliberately NOT a health state. A panel with no
 * credential has told us nothing about itself; writing `UNREACHABLE` for it
 * would be Nexa inventing a provider answer, and an operator reading that would
 * go looking at a network that is fine.
 *
 * It exists because "no probe happened" still has to change the schedule. The
 * first Phase 3C design kept the next-probe time on the health row, so a panel
 * that could never be probed had no row, was rediscovered every tick for ever,
 * and occupied its tenant's fairness slot while doing nothing at all. Each of
 * these defers the panel; none of them writes health.
 *
 *   `CREDENTIALS_MISSING`  nothing to authenticate with — set a credential
 *   `TARGET_BLOCKED`       the address resolves somewhere this installation
 *                          refuses to call — correct it, or the policy
 *   `STATUS_NOT_PROBEABLE` no longer ACTIVE; the loop is not to touch it
 *   `COOLDOWN`             a probe of this exact configuration just ran
 *   `BUDGET_EXHAUSTED`     the tenant's outbound capacity is spent
 *   `NOT_AUTHORIZED`       the job may not act for this tenant
 *   `CAPABILITY_UNSUPPORTED` the adapter does not perform health checks
 *
 * `COOLDOWN` and `BUDGET_EXHAUSTED` are the transient pair and earn a short
 * deferral; every other reason is stable and earns a long one, because retrying
 * a stable refusal on the healthy cadence is a busy loop that starves the panels
 * a probe could actually help. `deferralIntervalMs` is where that split lives,
 * and its switch is exhaustive — a reason added here without a decision there
 * does not compile.
 */
export const MONITOR_DEFERRAL_REASONS = [
  'CREDENTIALS_MISSING',
  'TARGET_BLOCKED',
  'STATUS_NOT_PROBEABLE',
  'COOLDOWN',
  'BUDGET_EXHAUSTED',
  'NOT_AUTHORIZED',
  /**
   * The adapter does not declare the capability being asked of it.
   *
   * Vacuous today — both registered providers declare `HEALTH_CHECK` — and that
   * is exactly when the gate is cheap to install. `supports()` exists on both
   * adapters with NO production caller, so the capability array is published to
   * the Web Admin as a promise the product makes while nothing on the server
   * consults it.
   *
   * A deferral reason rather than a health state, and rather than a failure kind.
   * Health is what a provider SAID about a panel; an adapter that cannot ask has
   * nothing to report, so writing `UNHEALTHY` here would be inventing provider
   * truth. And it is STABLE, not transient: a provider that cannot health-check
   * this minute cannot next minute either, so it earns the long deferral for the
   * same reason `CREDENTIALS_MISSING` does — retrying it on the healthy cadence
   * is a busy loop that starves the panels a probe could help.
   */
  'CAPABILITY_UNSUPPORTED',
  /**
   * The loop failed before it could decide anything about the panel.
   *
   * A credential whose envelope will not parse, or one sealed under a key the
   * installation no longer holds, throws before the refusal path and before the
   * persist path — so the row stayed due, and was the earliest due row on the
   * next tick, and the one after that. It is a SCHEDULER reason and never a
   * health state: nothing was asked of the provider, so there is nothing to
   * report about it.
   */
  'INTERNAL_ERROR',
] as const;
export type MonitorDeferralReason = (typeof MONITOR_DEFERRAL_REASONS)[number];

/**
 * How long a health result stays fresh, by default.
 *
 * Freshness is a presentation question — "is this answer still worth
 * believing" — so it is a constant the surface applies rather than a column.
 * A stored `staleAt` would freeze one policy into every historical row.
 */
export const PANEL_HEALTH_FRESH_FOR_MS = 15 * 60 * 1000;

/**
 * The largest page of panels one request may ask for, and the default.
 *
 * A bound rather than a suggestion: the response is built in memory and
 * serialised on the event loop, so "how many" is a resource decision and not
 * the caller's alone.
 */
export const PANEL_PAGE_MAX = 200;
export const PANEL_PAGE_DEFAULT = 50;

/**
 * How many consecutive failing probes make a panel ineligible to sell onto.
 *
 * Phase 6B, and the number is the whole point: ONE failed probe is not a
 * verdict. A panel that answers a single request badly — a restart, a moment of
 * packet loss, an upstream hiccup — is a panel that will very likely serve the
 * next customer, and removing its products from the catalogue on that evidence
 * turns every blip into an outage of the shop.
 *
 * Three is the smallest count that cannot be one bad moment. Below it the
 * catalogue tracks noise; far above it the installation keeps taking money for
 * something it cannot deliver, which is the failure this threshold exists to
 * stop.
 *
 * It is a count and not a duration because the monitor's cadence already backs
 * off: three consecutive failures is three DECISIONS by the probe lane, not
 * three ticks of a clock, so a panel that is only probed rarely is not declared
 * unhealthy faster than one that is probed often.
 */
export const PANEL_UNHEALTHY_AFTER_FAILURES = 3;

/**
 * The health states that make a panel unusable, as opposed to merely worrying.
 *
 * `DEGRADED` is deliberately ABSENT, and the definition of that state at
 * `PANEL_HEALTH_STATES` is the reason: the credentials were accepted and the
 * panel is up, and only the follow-up status read failed. Such a panel "may
 * still be serving customers" and will very likely accept a create. Refusing to
 * sell onto it would be this installation declining business over a diagnostic
 * it could not read.
 *
 * `UNREACHABLE` and `AUTH_FAILED` are different in kind. One means nothing
 * answered; the other means something answered and refused us. In both the very
 * next provisioning call is known to fail, and taking a customer's money first
 * is the thing 6B exists to stop.
 */
export const PANEL_UNUSABLE_HEALTH_STATES: readonly PanelHealthState[] = [
  'UNREACHABLE',
  'AUTH_FAILED',
];

/**
 * Why a panel may not take new business right now.
 *
 * Separate from `PanelOperabilityRefusal`, which answers a different question,
 * and the separation is load-bearing. Operability asks "can this OPERATION run
 * against this panel" and is checked at the moment of the provider call;
 * eligibility asks "may we SELL onto this panel" and is checked before a
 * customer is charged. A panel can be eligible and inoperable — a fresh one
 * whose credentials are missing — and it can be operable and ineligible, which
 * is exactly the case this vocabulary adds: full, or failing every probe.
 */
export const PANEL_INELIGIBILITY_REASONS = [
  /** Archived. The panel is finished and its name has been released. */
  'ARCHIVED',
  /** The operator said stop using this for now. Their decision, not a measurement. */
  'DISABLED',
  /**
   * `PANEL_UNHEALTHY_AFTER_FAILURES` consecutive failing probes, measured
   * recently enough to still be believed.
   *
   * All three qualifiers matter. Consecutive, so one blip is not a verdict.
   * Failing rather than degraded, so a panel that is up but undiagnosable keeps
   * selling. Recent, so a health row nobody has refreshed — a stopped monitor,
   * a restored database — stops being evidence instead of freezing the
   * catalogue shut. A panel nobody has ever probed is NOT this: `UNCHECKED` is
   * the absence of evidence and a fresh installation must be able to sell.
   */
  'UNHEALTHY',
  /**
   * The panel is at its operator-set cap.
   *
   * Counted as live services plus reservations nobody has released yet, so two
   * customers reaching for the last slot cannot both be sold it.
   */
  'AT_CAPACITY',
] as const;
export type PanelIneligibilityReason = (typeof PANEL_INELIGIBILITY_REASONS)[number];

/**
 * How long a capacity reservation is held before it expires on its own.
 *
 * A reservation is taken before the customer pays and released when they do,
 * when they do not, or when the order is cancelled or rejected. This bound is
 * what makes the fourth case — the one nobody tells us about — recoverable: a
 * customer who abandons a checkout must not hold somebody else's slot for ever.
 *
 * Longer than the order-expiry window it shadows, deliberately. The release is
 * driven by the order lifecycle; this is the BACKSTOP for a release that never
 * ran, and a backstop that fires before the thing it backs up would hand the
 * slot away while the customer was still paying.
 */
export const PANEL_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
