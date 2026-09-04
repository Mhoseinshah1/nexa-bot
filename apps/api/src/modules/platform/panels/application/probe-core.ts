import { createHash } from 'node:crypto';
import { errors, PANEL_ERROR_CODES } from '@nexa/contracts';
import type {
  Clock,
  PanelHealthState,
  PanelStatus,
  ProviderConnectionAdapter,
  ProviderCredentials,
  ProviderProbeOutcome,
  ProviderType,
  TenantContext,
  UnitOfWork,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  checkUrl,
  type UrlPolicyOptions,
  type UrlPolicyRefusal,
} from '../../../../infrastructure/net/url-policy.js';

import type { SafeHttpClient } from '../../../../infrastructure/net/safe-http.js';
import { scheduleAfterProbe, type MonitorCadence } from '../domain/monitor-cadence.js';
import type {
  PanelCredentialStore,
  PanelHealthRecord,
  PanelRepository,
  PanelView,
  ProbeBudget,
} from './ports.js';

/**
 * Probing a panel: the one implementation.
 *
 * An operator pressing "Test connection" and the background monitor reaching
 * the same panel are the SAME operation with different callers. Everything that
 * makes a probe safe lives here and only here — which credential is resolved
 * and how, which adapter operates the provider, the address policy applied to
 * the stored URL, the per-panel claim, the tenant budget, the normalization of
 * whatever came back, and the check that the panel has not been reconfigured
 * underneath the answer.
 *
 * The alternative was a second implementation in the monitor, and it is worth
 * naming what that would have cost. Every one of those steps is a rule with a
 * documented reason: a token that is present and wrong is never retried as a
 * password; a private address is deliberately reachable and only a
 * never-a-panel destination is refused; redirects are never followed. A copy
 * starts identical and diverges at the first fix applied to one side, and the
 * side that would silently keep the old behaviour is the unattended one that
 * dials panels on a timer.
 *
 * What is NOT here is what genuinely differs: authorization, idempotency,
 * auditing, and what to do with a refusal. Those are the callers' business, and
 * both callers do them — differently, because an operator has a session and a
 * job has a run id.
 */
export interface ProbeCoreDeps {
  readonly repository: PanelRepository;
  readonly credentials: PanelCredentialStore;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly http: SafeHttpClient;
  readonly urlPolicy: UrlPolicyOptions;
  readonly adapters: (type: ProviderType) => ProviderConnectionAdapter;
  readonly probeCooldownMs: number;
  readonly probeBudget: ProbeBudget;
  readonly cadence: MonitorCadence;
}

/** Why no outbound call was made. Every one of these is a decision, not an error. */
export type ProbeRefusal =
  | { readonly kind: 'STATUS_NOT_PROBEABLE'; readonly status: PanelStatus }
  | { readonly kind: 'CREDENTIALS_MISSING' }
  | { readonly kind: 'TARGET_BLOCKED'; readonly refusal: UrlPolicyRefusal }
  | { readonly kind: 'COOLDOWN' }
  | { readonly kind: 'BUDGET_EXHAUSTED'; readonly retryAfterMs: number };

export type ProbeAttempt =
  | { readonly probed: false; readonly refusal: ProbeRefusal }
  | {
      readonly probed: true;
      /** The configuration the probe measured, for the recheck at persist time. */
      readonly configuration: string;
      readonly health: PanelHealthRecord;
    };

export interface ProbeOptions {
  /**
   * Which panel statuses this caller may probe.
   *
   * Data rather than a branch on who is asking. An operator passes
   * `['ACTIVE', 'DISABLED']`: they disable a panel precisely because something
   * is wrong with it, and "re-enable it to find out whether you should" is a
   * bad answer. The monitor passes `['ACTIVE']`, because `DISABLED` means the
   * operator said stop using this for now and unattended dialling is exactly
   * what that forbids.
   *
   * The monitor's discovery query already filters to `ACTIVE`. This is the
   * second half of that: a panel disabled between discovery and the probe is
   * refused here, so the rule survives the race rather than depending on the
   * query having been recent.
   */
  readonly probeableStatuses: readonly PanelStatus[];
  /**
   * Tokens of the tenant's budget this caller must leave behind.
   *
   * Zero for an operator. Positive for the monitor, so background work cannot
   * spend a tenant's last capacity and lock an operator out of their own panel.
   */
  readonly budgetReserve: number;
}

/**
 * Everything up to and including the network call, with nothing persisted.
 *
 * The probe is OUTSIDE any transaction, deliberately: a network call inside one
 * holds a database connection for the length of somebody else's timeout, which
 * at pool exhaustion is an outage caused by a panel being slow.
 */
export async function attemptProbe(
  deps: ProbeCoreDeps,
  tenant: TenantContext,
  before: PanelView,
  options: ProbeOptions,
): Promise<ProbeAttempt> {
  const panelId = before.panel.id;

  if (!options.probeableStatuses.includes(before.panel.status)) {
    return {
      probed: false,
      refusal: { kind: 'STATUS_NOT_PROBEABLE', status: before.panel.status },
    };
  }

  const stored = await deps.credentials.read(tenant, panelId);
  // The adapter is resolved BEFORE anything is spent, and it refuses a provider
  // type it cannot operate. A panel that cannot be operated does not get a
  // probe attempt, a claim or a budget token.
  const provider = deps.adapters(before.panel.providerType);
  const target = toProviderCredentials(stored, provider.descriptor.credentialShape);
  if (target === null) return { probed: false, refusal: { kind: 'CREDENTIALS_MISSING' } };

  // What this probe is ABOUT to test, captured before the network call. Every
  // field a probe depends on is here: the address it dials and the three
  // credential timestamps, which move whenever a credential is replaced or
  // removed. `updatedAt` covers the address and the status.
  const configuration = configurationOf(before);

  // The address is judged again, as written, before any capacity is spent. It
  // was judged at create and at update, but the policy can have changed
  // underneath a stored panel — an installation's data subnet, say — and a
  // refusal that costs nothing is the right answer to that.
  const verdict = checkUrl(before.panel.baseUrl, deps.urlPolicy);
  if (!verdict.allowed) {
    return { probed: false, refusal: { kind: 'TARGET_BLOCKED', refusal: verdict.refusal } };
  }

  // Two bounds, taken together in one SHORT transaction — no network inside it
  // — and in this order:
  //
  //   1. the per-panel claim, which is configuration-aware: a corrected address
  //      or credential may be retested at once;
  //   2. the tenant-wide budget, which is configuration-BLIND: however many
  //      times a panel is reconfigured, the tenant's real outbound probes stay
  //      under one bound.
  //
  // A request the cooldown merely replays stops at step 1 and spends no budget.
  // A request the budget refuses rolls the transaction back, so no claim is
  // left recorded for a probe that never happened. Both together decide once,
  // atomically, whether ONE outbound call may be made — and committing before
  // the call is what stops two processes from both making it. That is the same
  // mechanism that makes two monitor replicas safe: neither of them decides,
  // the database does.
  const startedAt = deps.clock.now();
  const permission = await deps.uow
    .run(tenant, async (tx) => {
      const claimed = await deps.repository.claimProbe(
        tenant,
        panelId,
        configurationFingerprint(before),
        startedAt,
        new Date(startedAt.getTime() - deps.probeCooldownMs),
        tx,
      );
      if (!claimed) return { kind: 'cooldown' as const };
      const budget = await deps.repository.takeProbeBudget(
        tenant,
        deps.probeBudget,
        startedAt,
        tx,
        options.budgetReserve,
      );
      if (!budget.permitted) throw new ProbeBudgetExhausted(budget.retryAfterMs);
      return { kind: 'permitted' as const };
    })
    .catch((error: unknown) => {
      if (error instanceof ProbeBudgetExhausted) return { kind: 'limited' as const, error };
      throw error;
    });

  if (permission.kind === 'cooldown') return { probed: false, refusal: { kind: 'COOLDOWN' } };
  if (permission.kind === 'limited') {
    return {
      probed: false,
      refusal: { kind: 'BUDGET_EXHAUSTED', retryAfterMs: permission.error.retryAfterMs },
    };
  }

  const outcome = await provider.probe(
    { baseUrl: before.panel.baseUrl, credentials: target },
    deps.http.forBase(before.panel.baseUrl),
  );
  const finishedAt = deps.clock.now();

  return {
    probed: true,
    configuration,
    health: toHealthRecord(outcome, {
      panelId,
      cadence: deps.cadence,
      checkedAt: finishedAt,
      latencyMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      previous: before.health,
    }),
  };
}

/**
 * Stores a probe result, refusing if the panel changed while it was in flight.
 *
 * Runs INSIDE the caller's transaction, and re-reads inside it. Anything that
 * changed the panel or its credentials during the probe makes this answer
 * describe a configuration that no longer exists, and health is what an
 * operator trusts when deciding whether their fix worked. Writing it anyway
 * would report the OLD configuration's verdict against the new one.
 */
export async function persistProbeResult(
  deps: Pick<ProbeCoreDeps, 'repository'>,
  tenant: TenantContext,
  panelId: string,
  configuration: string,
  health: PanelHealthRecord,
  tx: TransactionScope,
): Promise<PanelView> {
  const current = await deps.repository.find(tenant, panelId, tx);
  if (current === null) {
    throw errors.notFound(PANEL_ERROR_CODES.PANEL_NOT_FOUND, 'No such panel.');
  }
  if (configurationOf(current) !== configuration) {
    throw errors.conflict(
      PANEL_ERROR_CODES.PANEL_CONFIGURATION_CHANGED,
      'This panel changed while the connection test was running. Run the test again.',
    );
  }
  await deps.repository.recordHealth(tenant, panelId, health, tx);
  return current;
}

/** Thrown inside the permission transaction to roll it back; never escapes this module. */
class ProbeBudgetExhausted extends Error {
  constructor(readonly retryAfterMs: number) {
    super('probe budget exhausted');
  }
}

/**
 * Everything a probe's answer depends on, as one comparable value.
 *
 * A timestamp tuple rather than a stored version column: all four already move
 * for exactly the reasons that invalidate a probe, so there is nothing new to
 * maintain and no column that can be forgotten on a write path added later.
 * `updatedAt` moves for the address and the status; the three credential
 * timestamps move when a credential is replaced or removed.
 */
export function configurationOf(view: PanelView): string {
  return [
    view.panel.baseUrl,
    view.panel.status,
    view.panel.updatedAt.getTime(),
    view.credentials.usernameSetAt?.getTime() ?? 0,
    view.credentials.passwordSetAt?.getTime() ?? 0,
    view.credentials.apiTokenSetAt?.getTime() ?? 0,
  ].join('|');
}

/**
 * The same identity, as an opaque token safe to keep in a row.
 *
 * A digest, so a claim row holds nothing readable — not the panel's address,
 * not its status. There is no credential VALUE in the input to hash in the
 * first place: `configurationOf` reads the three set-at timestamps, which move
 * when a credential is replaced and say nothing about what it is. A design that
 * fingerprinted the credentials themselves would put a verifier for a panel
 * password in a table that is not the credential table.
 */
export function configurationFingerprint(view: PanelView): string {
  return createHash('sha256').update(configurationOf(view)).digest('hex');
}

/**
 * Stored credentials, as the shape this provider declares it needs.
 *
 * Returns null when the panel has nothing usable, so the caller refuses before
 * contacting anything. Sending an empty password to find out would be one more
 * failed login on the operator's own panel.
 */
export function toProviderCredentials(
  stored: { username: string | null; password: string | null; apiToken: string | null } | null,
  shape: string,
): ProviderCredentials | null {
  if (stored === null) return null;
  if (shape === 'USERNAME_PASSWORD') {
    return stored.username !== null && stored.password !== null
      ? { shape: 'USERNAME_PASSWORD', username: stored.username, password: stored.password }
      : null;
  }
  if (shape === 'OPAQUE_TOKEN') {
    return stored.apiToken !== null ? { shape: 'OPAQUE_TOKEN', token: stored.apiToken } : null;
  }
  if (shape === 'TOKEN_OR_USERNAME_PASSWORD') {
    // A provider that genuinely accepts either — 3X-UI v3.7.0 authenticates its
    // API with a scoped Bearer token OR a session login. The order is a
    // decision, not a preference:
    //
    // A configured API token WINS, and a rejected one is never retried as a
    // username and password. An operator who configured token-only access,
    // possibly a least-privilege monitor token, must see that token auth is
    // broken rather than have Nexa quietly authenticate with the more powerful
    // credential they deliberately did not point at this job. Falling back
    // would also mean a token typo silently escalating every future probe.
    //
    // Narrowing HERE rather than in the adapter is what makes that structural:
    // the adapter is handed one shape and cannot see the other, so no adapter
    // can implement the fallback even by accident. A deliberate fallback, if
    // one is ever wanted, is a product policy and a change to this function.
    if (stored.apiToken !== null) return { shape: 'OPAQUE_TOKEN', token: stored.apiToken };
    return stored.username !== null && stored.password !== null
      ? { shape: 'USERNAME_PASSWORD', username: stored.username, password: stored.password }
      : null;
  }
  return { shape: 'NONE' };
}

/**
 * A probe outcome as a stored health row.
 *
 * `lastHealthyAt` is carried forward across failures on purpose: "unreachable,
 * last worked four minutes ago" and "unreachable, last worked in March" are the
 * same state and completely different problems.
 *
 * The schedule is computed here rather than by the monitor, so that an
 * operator's manual test also moves the panel's next background probe. A manual
 * test is a real probe with a real answer; a monitor that re-dialled the panel
 * a second later would be asking a question that was just answered — and
 * against a rejected credential it would be asking it on the operator's behalf,
 * which is how a failed login becomes a lockout.
 */
export function toHealthRecord(
  outcome: ProviderProbeOutcome,
  context: {
    panelId: string;
    cadence: MonitorCadence;
    checkedAt: Date;
    latencyMs: number;
    previous: Pick<PanelHealthRecord, 'lastHealthyAt' | 'consecutiveFailures'> | null;
  },
): PanelHealthRecord {
  const failure = outcome.ok ? null : outcome.failure;
  const schedule = scheduleAfterProbe(context.cadence, context.panelId, {
    checkedAt: context.checkedAt,
    failure,
    previousConsecutiveFailures: context.previous?.consecutiveFailures ?? 0,
  });

  if (outcome.ok) {
    const state: PanelHealthState = outcome.degraded ? 'DEGRADED' : 'HEALTHY';
    return {
      state,
      checkedAt: context.checkedAt,
      latencyMs: context.latencyMs,
      failure: null,
      statusCode: null,
      providerVersion: outcome.providerVersion,
      // A degraded panel authenticated, so it answered. It counts as having
      // worked — an operator watching `lastHealthyAt` freeze while the panel is
      // plainly responding would be reading a broken clock.
      lastHealthyAt: context.checkedAt,
      consecutiveFailures: schedule.consecutiveFailures,
      nextProbeAt: schedule.nextProbeAt,
    };
  }
  return {
    // Both authentication kinds are AUTH_FAILED health: the panel answered and
    // did not authenticate. The FAILURE column carries which, so an operator
    // sees "replace the credentials" and "this panel wants a second factor,
    // configure an API token" as the different jobs they are.
    state:
      outcome.failure === 'AUTHENTICATION_FAILED' ||
      outcome.failure === 'AUTHENTICATION_REQUIRES_INTERACTION'
        ? 'AUTH_FAILED'
        : 'UNREACHABLE',
    checkedAt: context.checkedAt,
    latencyMs: context.latencyMs,
    failure: outcome.failure,
    statusCode: outcome.status,
    providerVersion: null,
    lastHealthyAt: context.previous?.lastHealthyAt ?? null,
    consecutiveFailures: schedule.consecutiveFailures,
    nextProbeAt: schedule.nextProbeAt,
  };
}
