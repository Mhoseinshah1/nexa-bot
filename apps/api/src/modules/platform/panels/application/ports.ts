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
  ): Promise<boolean>;
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
