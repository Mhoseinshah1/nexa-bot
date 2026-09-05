import type {
  MonitorDeferralReason,
  PanelHealthState,
  PanelStatus,
  ProviderFailureKind,
  ProviderType,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A panel, as the application sees it.
 *
 * Note what is NOT here: no ciphertext, no key id, no credential of any kind.
 * A repository method that returned one would put it within reach of a
 * response builder, and a response builder that has it will eventually send it.
 * The only way to reach a credential is `PanelCredentialReader`, which is a
 * different port with a different consumer.
 */
export interface PanelRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  readonly status: PanelStatus;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Which credentials a panel has, and when each was last replaced. Never the values. */
export interface PanelCredentialSummary {
  readonly usernameSetAt: Date | null;
  readonly passwordSetAt: Date | null;
  readonly apiTokenSetAt: Date | null;
}

export interface PanelHealthRecord {
  readonly state: PanelHealthState;
  readonly checkedAt: Date;
  readonly latencyMs: number;
  readonly failure: ProviderFailureKind | null;
  readonly statusCode: number | null;
  readonly providerVersion: string | null;
  readonly lastHealthyAt: Date | null;
}

/**
 * What a probe result did to the stored health row.
 *
 * `STALE_IGNORED` is not an error and not a no-op the caller may ignore. A
 * probe runs outside the transaction that stores it, so a slow one can finish
 * after a faster later one — an operator's manual test overtaking a background
 * probe still on the wire. The storage refuses to move `checked_at` backwards,
 * and the CALLER has to know that happened: announcing a transition to
 * `AUTH_FAILED` that was never stored would tell an operator their panel is
 * broken while the row in front of them says `HEALTHY`.
 */
export type HealthWriteOutcome = 'APPLIED' | 'STALE_IGNORED';

/**
 * The monitor's bookkeeping for one panel. Never health, never a secret.
 *
 * Separate from `PanelHealthRecord` because they answer different questions and
 * have different writers. Health is the last thing a provider said. This is
 * when the loop may look again and why it last stepped back — including for
 * panels no provider has ever answered for, which is precisely the case a
 * schedule kept on the health row could not represent.
 */
export interface PanelScheduleRecord {
  readonly nextEligibleAt: Date;
  readonly consecutiveFailures: number;
  readonly deferredReason: MonitorDeferralReason | null;
}

/** A panel with everything a surface may see about it. */
export interface PanelView {
  readonly panel: PanelRecord;
  readonly credentials: PanelCredentialSummary;
  /** Null when this panel has never been probed. Absence IS the state. */
  readonly health: PanelHealthRecord | null;
}

export interface CreatePanelInput {
  readonly id: string;
  readonly name: string;
  readonly providerType: ProviderType;
  readonly baseUrl: string;
  /**
   * From the `Clock` port, not the database's `now()`.
   *
   * `panels.updated_at` is not decoration: the monitor's discovery compares it
   * against the last probe's `checked_at` to decide that a panel was
   * reconfigured and is due again. `checked_at` comes from the clock, so if
   * this came from the database the comparison would straddle two clocks —
   * and any skew between the application and PostgreSQL would make every
   * panel either permanently due or permanently not.
   */
  readonly at: Date;
}

export interface UpdatePanelInput {
  readonly name?: string;
  readonly baseUrl?: string;
}

/**
 * What a credential write says about ONE credential.
 *
 * Three states, and the difference between the first two is the whole point:
 *
 *   `undefined` — not mentioned. Leave whatever is stored.
 *   `null`      — remove it. A deliberate act.
 *   a value     — replace it.
 *
 * An operator editing a panel's name must not erase its password by not
 * mentioning it, and an operator who means to remove a credential must be able
 * to say so. A shape that could not tell those apart would have to pick one,
 * and either choice is a data-loss bug for the other case.
 */
export type CredentialWrite = string | null | undefined;

export interface PanelCredentialWrite {
  readonly username: CredentialWrite;
  readonly password: CredentialWrite;
  readonly apiToken: CredentialWrite;
}

/**
 * Panels, always within a tenant.
 *
 * EVERY method takes a `TenantContext` and every query filters on it. Not one
 * of them resolves a panel by id alone — a panel id is a UUID an operator can
 * see, and "the caller knows the id" is not an authorization decision. A method
 * that took only an id would be one call site away from a cross-tenant read,
 * and the call site that made that mistake would look exactly like the ones
 * that did not.
 */
export interface PanelRepository {
  /**
   * Reads take an OPTIONAL transaction, and a caller inside one must pass it.
   *
   * Not a convenience: a read on the pool from inside a transaction holds one
   * connection while asking for another, which deadlocks the pool under
   * concurrency rather than merely being slow.
   */
  list(
    scope: TenantContext,
    options: { includeArchived: boolean },
    tx?: TransactionScope,
  ): Promise<PanelView[]>;
  find(scope: TenantContext, panelId: string, tx?: TransactionScope): Promise<PanelView | null>;
  create(scope: TenantContext, input: CreatePanelInput, tx: TransactionScope): Promise<PanelRecord>;
  /** Returns null when no panel of this tenant has that id. */
  update(
    scope: TenantContext,
    panelId: string,
    input: UpdatePanelInput,
    /** From the `Clock` port. See `CreatePanelInput.at`. */
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelRecord | null>;
  setStatus(
    scope: TenantContext,
    panelId: string,
    status: PanelStatus,
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelRecord | null>;
  /** Whether a LIVE panel of this tenant already uses the name. */
  nameTaken(
    scope: TenantContext,
    name: string,
    exceptPanelId: string | null,
    tx?: TransactionScope,
  ): Promise<boolean>;
  /**
   * Stores a probe result, and says whether it was actually applied.
   *
   * Refuses to move `checked_at` backwards, so a slow probe finishing after a
   * faster later one is discarded rather than replacing a fresh verdict with a
   * stale one. The return value is not decoration: the caller announces
   * transitions, and announcing one for a result the database threw away would
   * tell an operator something the row in front of them contradicts.
   */
  recordHealth(
    scope: TenantContext,
    panelId: string,
    health: PanelHealthRecord,
    tx: TransactionScope,
  ): Promise<HealthWriteOutcome>;
  /** The monitor's bookkeeping for one panel, or null if it has no schedule row. */
  readSchedule(
    scope: TenantContext,
    panelId: string,
    tx?: TransactionScope,
  ): Promise<PanelScheduleRecord | null>;
  /**
   * Moves a panel's next eligible moment, and the tenant's lower bound with it.
   *
   * One call for every reason the loop steps away from a panel: a probe that
   * produced health, a deferral that did not, and an operator edit that makes
   * it due at once. `deferredReason` is null exactly when a probe happened.
   *
   * The tenant's rotation row is updated in the same statement, downward only
   * (`LEAST`), which is what keeps the fairness bound a lower bound and never a
   * missed tenant.
   */
  scheduleNext(
    scope: TenantContext,
    panelId: string,
    next: {
      readonly nextEligibleAt: Date;
      readonly consecutiveFailures: number;
      readonly deferredReason: MonitorDeferralReason | null;
      readonly at: Date;
    },
    tx: TransactionScope,
  ): Promise<void>;
  /**
   * Makes a panel eligible immediately, or never.
   *
   * `'ELIGIBLE_NOW'` is what an operator edit earns — a replaced credential, a
   * corrected address, a re-enabled panel — so a fix is measured now rather
   * than after a backoff the fix invalidated. `'SUSPENDED'` is what leaving
   * `ACTIVE` earns, and it is the discovery query's real status filter: a
   * `DISABLED` panel is not skipped by the scan, it is outside the range the
   * scan reads.
   *
   * Called inside the transaction that changes the panel, so the schedule can
   * never disagree with the row it describes.
   */
  setScheduleEligibility(
    scope: TenantContext,
    panelId: string,
    eligibility: 'ELIGIBLE_NOW' | 'SUSPENDED',
    at: Date,
    tx: TransactionScope,
  ): Promise<void>;
  /**
   * Take the right to probe this panel, or report that somebody else holds it.
   *
   * True means this caller may make the network call. False means a probe of
   * the SAME configuration started AFTER `notClaimedSince` — either it is still
   * running or it finished recently enough that repeating it would be a way to
   * hammer the provider, and the caller must return the stored result instead
   * of making another.
   *
   * A `notClaimedSince` of `at` itself therefore always grants the claim, which
   * is how a suite that is testing something else asks for no throttling at
   * all. Nothing in production can produce that: the cooldown is floored well
   * above zero at both the schema and the container.
   *
   * Deliberately NOT inside the caller's transaction, and deliberately one
   * statement. The point is that a second request finds the claim immediately;
   * a claim held open in an uncommitted transaction would be invisible to it,
   * and every concurrent probe would proceed. Whether the claim is granted must
   * be decided by the database, not by the process, because two API containers
   * share the panel and nothing else.
   *
   * `configuration` is an opaque digest. A claim taken under one configuration
   * never blocks a probe of a different one: replacing a credential or an
   * address is exactly when an operator needs an answer now.
   */
  claimProbe(
    scope: TenantContext,
    panelId: string,
    configuration: string,
    at: Date,
    notClaimedSince: Date,
    tx?: TransactionScope,
  ): Promise<boolean>;
  /**
   * Take one unit of this tenant's outbound-probe capacity, or report that
   * none is left and when one will be.
   *
   * A token bucket per tenant, in the database, computed and taken in ONE
   * statement under the row lock — so every API process shares the same
   * bound and two of them racing for the last token cannot both get it. The
   * bucket knows nothing about panels or configurations: it is the bound the
   * per-panel cooldown cannot provide, precisely because that cooldown is
   * reset by a configuration change on purpose.
   *
   * Run inside the same transaction as `claimProbe`, after it. If this is
   * refused the caller rolls the transaction back, so a panel claim is never
   * left recorded for a probe that did not happen; and because the claim runs
   * first, a request the cooldown merely replays never reaches here and never
   * spends capacity.
   */
  /**
   * Takes one token from the tenant's bucket, atomically.
   *
   * `reserve` is the number of tokens the caller must leave behind: 0 for an
   * operator, positive for the background monitor, so background work cannot
   * spend a tenant's last capacity and lock an operator out of their own
   * "Test connection" button. One bucket, one bound, two floors.
   */
  takeProbeBudget(
    scope: TenantContext,
    bucket: ProbeBudget,
    at: Date,
    tx: TransactionScope,
    reserve?: number,
  ): Promise<{ permitted: true; remaining: number } | { permitted: false; retryAfterMs: number }>;
}

/** One panel the monitor may consider, named with the tenant that owns it. */
export interface DuePanel {
  readonly tenantId: string;
  readonly panelId: string;
}

/**
 * Finding the panels a background probe is due for, across every tenant.
 *
 * A SEPARATE port from `PanelRepository`, and the only deliberately
 * cross-tenant read in this module. Every method on that repository takes a
 * `TenantContext` and filters on it; making one of them optional-tenant would
 * put a cross-tenant read one forgotten argument away from every call site that
 * lists panels.
 *
 * What it returns is a pair of identifiers. No name, no address, no credential,
 * no health. The monitor takes each `tenantId`, builds a `TenantContext` from
 * it, and does everything else through the ordinary tenant-scoped repository —
 * so the cross-tenant surface is two queries returning two columns, and nothing
 * downstream of them is cross-tenant at all.
 *
 * **Why two calls and not one.** The work a tick does must be bounded by the
 * batch size, not by how many panels are due on the installation. The first
 * Phase 3C design ranked every due panel with a window function and then took
 * fifty; on a hundred thousand due panels that is a hundred thousand rows
 * ranked and sorted, every thirty seconds, to probe fifty. Claiming the tenants
 * first turns the second query into one bounded index range scan PER CLAIMED
 * TENANT, and the per-tenant share is computed from how many were actually
 * claimed — so a single-tenant installation still gets the whole batch, and a
 * hundred-tenant one still gets fairness.
 */
export interface PanelMonitorRepository {
  /**
   * Takes a turn for up to `limit` tenants that have at least one eligible
   * panel, least recently served first.
   *
   * Atomic and exclusive: the claim moves `last_served_at` under
   * `FOR UPDATE SKIP LOCKED`, so two monitor replicas take DISJOINT tenant sets
   * instead of both working the same one. That is what makes fairness a
   * property of the installation rather than of one process.
   *
   * Every claimed tenant's turn is spent whether or not it turns out to have
   * work — the bound is a lower bound, so a claim that finds nothing is the
   * price of never missing a tenant, and `refreshTenantBounds` repairs it.
   */
  claimTenants(now: Date, limit: number): Promise<string[]>;
  /**
   * The eligible panels of already-claimed tenants: at most `perTenant` each,
   * at most `batchSize` in total, earliest first.
   *
   * One index range scan per tenant, each stopped by `perTenant`. Nothing here
   * reads a row it does not return.
   */
  dueForTenants(
    tenantIds: readonly string[],
    now: Date,
    perTenant: number,
    batchSize: number,
  ): Promise<DuePanel[]>;
  /**
   * Recomputes the claimed tenants' lower bounds from their own schedules.
   *
   * The self-healing half of keeping the bound cheap. Writes move it down with
   * a `LEAST` and never up, so it drifts earlier than the truth; this puts it
   * back, one index-ordered lookup per tenant. Without it a tenant whose panels
   * are all far in the future would be claimed on every tick for ever, spending
   * a fairness slot to discover it has nothing to do.
   */
  refreshTenantBounds(tenantIds: readonly string[]): Promise<void>;
  /**
   * Creates the scheduler rows for any panel that has none.
   *
   * Migration 0022's backfill runs exactly once, and that is not enough. A
   * failed update can apply 0022 and then roll the APPLICATION back without
   * rolling the database back — which is the supported shape, because
   * `botctl rollback` deliberately never restores the database. The older
   * release knows nothing about `panel_monitor_schedule`, so any panel it
   * creates has no row; rolling forward again does not re-run a migration
   * already in the journal. The discovery scan reads only the schedule, so
   * that panel is silently never monitored — until some later operator edit
   * happens to write its row.
   *
   * Idempotent and safe to run from every replica: it inserts only what is
   * missing. Run at startup, which is exactly when the rollback-and-forward
   * sequence ends.
   */
  reconcileSchedules(now: Date): Promise<number>;
  /**
   * Tenants whose ACTIVE panel population exceeds what their bucket can keep fresh.
   *
   * The freshness window is a promise with two bounds: the cadence must fit
   * inside it (checked at boot) and the tenant's probe bucket must be able to
   * complete that many probes per interval (this). Only the first was ever
   * checked, so an installation with hundreds of panels under one tenant
   * reported most of them stale while every configuration validated.
   *
   * One grouped aggregate over ACTIVE panels, run once at startup rather than
   * per tick — the supported population changes when panels are added, not
   * every thirty seconds.
   */
  overCapacityTenants(
    sustainablePerTenant: number,
  ): Promise<{ tenantId: string; panels: number }[]>;
}

/** The tenant-wide bound on real outbound probes: a bucket's size and refill. */
export interface ProbeBudget {
  /** Tokens the bucket holds when full; also the largest burst. */
  readonly capacity: number;
  /** Tokens added per millisecond, continuously. `capacity / window` for "N per window". */
  readonly refillPerMs: number;
}

/**
 * Reading and writing the encrypted half.
 *
 * A separate port from `PanelRepository` deliberately. The repository is used
 * by every read path; this one is used by exactly two callers — the probe,
 * which needs the values, and the credential write, which replaces them. A
 * single port carrying both would put `readCredentials` in scope everywhere a
 * panel is listed.
 */
export interface PanelCredentialStore {
  /**
   * The decrypted credentials for one panel, or null when none are set.
   *
   * The only function in the codebase that produces a panel credential in
   * plaintext. It is never called from a surface, never logged, and its result
   * never enters a response, an audit payload or a health record.
   */
  read(
    scope: TenantContext,
    panelId: string,
  ): Promise<{ username: string | null; password: string | null; apiToken: string | null } | null>;
  /** Applies a partial write. Absent fields are left alone; nulls are removed. */
  write(
    scope: TenantContext,
    panelId: string,
    write: PanelCredentialWrite,
    at: Date,
    tx: TransactionScope,
  ): Promise<PanelCredentialSummary>;
}
