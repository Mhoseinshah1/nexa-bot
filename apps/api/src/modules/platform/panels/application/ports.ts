import type {
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
  /**
   * Probes that have failed in a row, ending with this one. Zero on success.
   *
   * The backoff input. A counter and not a history: it says how long this has
   * been going on, and nothing about what the earlier failures were.
   */
  readonly consecutiveFailures: number;
  /**
   * The earliest the background monitor may probe this panel again.
   *
   * Written by every probe, the operator's included — a manual test is a real
   * probe with a real answer, and a monitor that re-dialled the panel a second
   * later would be asking a question that was just answered.
   */
  readonly nextProbeAt: Date;
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
  recordHealth(
    scope: TenantContext,
    panelId: string,
    health: PanelHealthRecord,
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

/**
 * Why a panel came up for a background probe. Reported, never branched on for
 * whether to probe — being in the result set IS the decision.
 */
export const MONITOR_DUE_REASONS = [
  /** No health row: this panel has never been probed. */
  'NEVER_CHECKED',
  /** Its address, status or a credential changed after the last probe. */
  'CONFIGURATION_CHANGED',
  /** Its scheduled next probe time has arrived. */
  'INTERVAL_ELAPSED',
] as const;
export type MonitorDueReason = (typeof MONITOR_DUE_REASONS)[number];

/** One panel the monitor may consider, named with the tenant that owns it. */
export interface DuePanel {
  readonly tenantId: string;
  readonly panelId: string;
  readonly reason: MonitorDueReason;
}

/**
 * Finding the panels a background probe is due for, across every tenant.
 *
 * A SEPARATE port from `PanelRepository`, and the only deliberately
 * cross-tenant read in this module. That separation is the whole point. Every
 * method on `PanelRepository` takes a `TenantContext` and filters on it, and
 * making one of them optional-tenant would put a cross-tenant read one
 * forgotten argument away from every call site that lists panels.
 *
 * What this port returns is a pair of identifiers and a reason — no name, no
 * address, no credential, no health. The monitor takes the `tenantId` from each
 * row, builds a `TenantContext` from it, and does everything else through the
 * ordinary tenant-scoped repository. So the cross-tenant surface is exactly one
 * query returning exactly two ids, and nothing downstream of it is cross-tenant
 * at all.
 */
export interface PanelMonitorRepository {
  /**
   * The next `limit` panels due for a background probe, most overdue first,
   * fairly distributed across tenants.
   *
   * Bounded, ordered and index-supported, because the alternative — select the
   * panels and filter them in JavaScript — is an unbounded read of every panel
   * on the installation on every tick, and it gets slower exactly as an
   * installation grows.
   *
   * ONLY `ACTIVE` panels. `DISABLED` means the operator said stop using this
   * for now and `ARCHIVED` means finished; neither is a panel to go on dialling
   * unattended. The filter is in the SQL and in the partial index the SQL uses,
   * so a `DISABLED` panel is not merely skipped — it is not in the index the
   * query reads.
   *
   * Fairness is a per-tenant `row_number()`, not `ORDER BY due_at LIMIT n`.
   * With the latter, one tenant holding a hundred overdue panels takes every
   * slot in every cycle and no other tenant is ever probed. With the former,
   * every tenant's most overdue panel is considered before any tenant's
   * second.
   *
   * There is no cursor parameter and that is deliberate: a probe advances the
   * panel's `next_probe_at`, so the schedule column IS the cursor. A panel that
   * was just probed drops out of the result set on its own, and the next tick
   * starts from a genuinely different head rather than paging over a set that
   * is moving underneath it.
   */
  dueForMonitoring(now: Date, limit: number): Promise<DuePanel[]>;
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
