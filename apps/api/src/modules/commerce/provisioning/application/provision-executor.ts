import {
  failureOutcome,
  isMutatingOperation,
  OPERATION_MAX_ATTEMPTS,
  providerUsernameFor,
  UNLIMITED_DURATION_DAYS,
  type OperationState,
  type OperationType,
  type ProviderAdapter,
  type ProviderFailureKind,
  type ProviderServiceTarget,
  type ProviderUserRef,
  type ServiceState,
} from '@nexa/contracts';
import type { PanelOperabilityRefusal } from './ports.js';

/**
 * What one attempt did, as a value rather than as a thrown error.
 *
 * `REFUSED` is separate from `FAILED` on purpose. A refusal means nothing was
 * contacted — the panel is disabled, its credentials are unset, its activation is
 * incomplete — and an operator's remedy is a configuration screen. A failure means the
 * panel was contacted and said no. Collapsing them is how the legacy system produced
 * `کد خطا : 0` for a DNS failure, a wrong password and an HTTP 500 alike.
 */
/**
 * Every reason a tick can decline to contact a provider.
 *
 * `PanelOperabilityRefusal` covers the six that are about the PANEL and that an
 * operator fixes on a configuration screen. The four added here are about this
 * installation rather than about the panel, and they are listed separately instead of
 * being folded into that enum because the operator's answer to each differs — and for
 * two of them the answer is "nothing, wait".
 */
export type ExecutionRefusal =
  | PanelOperabilityRefusal
  /** The stored address is one the installation's URL policy now refuses to dial. */
  | 'PANEL_NOT_REACHABLE'
  /** The tenant's outbound bound had no capacity. Not a fault; try again shortly. */
  | 'BUDGET_EXHAUSTED'
  /** An operator stopped this tenant. Unattended work must not outlive that decision. */
  | 'TENANT_STOPPED'
  /** The operation names a service that does not exist. Abandoned, not retried. */
  | 'SERVICE_ABSENT'
  /**
   * The lease was gone by the time this worker went to stamp the call.
   *
   * Not a fault and not a panel problem: this process stalled long enough for its claim
   * to expire, and the row is now either another worker's or about to be released by the
   * next sweep. The remedy is to do nothing at all — no provider call, no transition, no
   * attempt spent — because anything else would be this worker racing the one that
   * legitimately holds the operation.
   */
  | 'LEASE_LOST';

export type ExecutionResult =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'REFUSED';
      readonly operationId: string;
      readonly reason: ExecutionRefusal;
    }
  | {
      readonly kind: 'ATTEMPTED';
      readonly operationId: string;
      readonly serviceId: string;
      readonly outcome: OperationState;
      readonly failureKind: ProviderFailureKind | null;
    };

/**
 * How long to wait before a failed operation may be claimed again.
 *
 * Exponential on the attempt count with a ceiling, and the ceiling matters more than
 * the curve: without one, the fifth attempt of a long-lived operation would be hours
 * out, which is indistinguishable from never for a customer waiting for a config.
 *
 * Pure, so the schedule is testable without a clock and identical in every replica.
 */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CEILING_MS = 15 * 60_000;

export function backoffMs(attempts: number): number {
  if (attempts <= 1) return BACKOFF_BASE_MS;
  const doubled = BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 10);
  return Math.min(doubled, BACKOFF_CEILING_MS);
}

/**
 * The three identities one service has on a panel, assembled together.
 *
 * Together because they must agree: a create that used one subscription reference and a
 * reconcile that used another would adopt an account and hand the customer a link to a
 * different one.
 *
 * Only the USERNAME is derived, and only it should be. It appears in an operator's
 * client list and its recoverability is what lets a reconcile ask the panel for a
 * service by name after a lost write. The other two are CAPABILITIES — anybody holding
 * the subscription reference can fetch the customer's configuration unauthenticated,
 * and the client id is what that configuration authenticates with — so they are random,
 * and stored in the settling transaction before any provider call. That gives the same
 * recoverability without making them computable from an id that travels through the
 * audit log, the operations log and the outbox.
 */
export function providerRefFor(service: {
  readonly id: string;
  readonly subscriptionRef: string;
  readonly providerClientId: string;
}): ProviderUserRef {
  return {
    username: providerUsernameFor(service.id),
    subscriptionRef: service.subscriptionRef,
    clientId: service.providerClientId,
  };
}

export function expiryFor(now: Date, durationDays: number): Date | null {
  if (durationDays === UNLIMITED_DURATION_DAYS || durationDays <= 0) return null;
  return new Date(now.getTime() + durationDays * 86_400_000);
}

/**
 * Turns one provider outcome into the operation state it produces.
 *
 * Delegates to `failureOutcome`, which is pure, total and already written. This phase
 * must not re-derive that table: the division it encodes is not transient-versus-
 * permanent but "did the request certainly not take effect", and a second copy would be
 * a second place for `TIMEOUT` to be optimistically reclassified as retryable — which
 * costs a customer a duplicate account.
 */
export function outcomeFor(
  failure: ProviderFailureKind,
  operationType: Parameters<typeof isMutatingOperation>[0],
): OperationState {
  return failureOutcome(failure, isMutatingOperation(operationType));
}

/**
 * A bounded, redacted diagnostic for an operation row.
 *
 * NEVER a provider response body. `docs/open-questions.md` records customer- and
 * provider-supplied text reaching an operational projection as the Phase 4 hazard, and
 * a panel's error message is text a third party chose. The kind and the status are ours
 * — a closed vocabulary and a number — and between them they name the remedy, which is
 * the whole job of this column.
 */
export function failureNote(failure: ProviderFailureKind, status: number | null): string {
  return status === null ? failure : `${failure} (HTTP ${String(status)})`;
}

/**
 * Whether an attempt that failed may be planned again, or has run out of attempts.
 *
 * The ceiling is checked against the attempts the claim ALREADY counted, because the
 * claim and the increment are one statement. An operation at the ceiling becomes
 * terminal `FAILED` rather than `PLANNED` with a far-future retry: a row that will
 * never be claimed again but says `PLANNED` is a row an operator reads as pending work.
 */
export function exhausted(attempts: number): boolean {
  return attempts >= OPERATION_MAX_ATTEMPTS;
}

/**
 * The operation types this release can actually perform.
 *
 * The audit for this phase calls the dispatch "the single most dangerous edit", and
 * this constant is the mechanism that makes it safe: an operation whose type is not
 * here is refused BEFORE a panel is contacted, with a reason an operator can act on,
 * rather than falling through to whichever call the executor happens to make last.
 *
 * It is a list rather than a `default:` in a switch because a list is checkable. The
 * executor asserts against it early, `tests/unit/registries.test.ts` asserts that every
 * member has a branch, and adding a member without writing that branch fails a test
 * instead of producing a silent create on somebody's panel.
 *
 * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` are commerce — each needs a new paid order
 * against an existing service — and are Phase 4F. `SUSPEND`, `RESUME` and `TERMINATE`
 * need adapter methods no provider declares yet. `ROTATE_SUBSCRIPTION` has neither.
 */
export const PERFORMABLE_OPERATION_TYPES = [
  'PROVISION',
  'RECONCILE',
  'SYNC_USAGE',
] as const satisfies readonly OperationType[];

export function isPerformableOperation(type: OperationType): boolean {
  return (PERFORMABLE_OPERATION_TYPES as readonly string[]).includes(type);
}

/**
 * The service states a given operation type may legally be attempted from.
 *
 * `SERVICE_MACHINE`'s edges, read BEFORE anything is spent rather than discovered
 * afterwards by a conditional UPDATE that quietly did nothing. It used to be one
 * ternary — RECONCILE from `UNRECONCILED`, everything else from `PENDING_PROVISION` —
 * which is a shape that answers confidently for a type nobody has thought about: a
 * `SYNC_USAGE` would have been declared legal only from `PENDING_PROVISION`, which is
 * the one state where there is no account to read.
 *
 * `SYNC_USAGE` takes `ACTIVE` alone. A suspended service is not consuming and an
 * expired one has stopped; refreshing either would spend a tenant's outbound budget to
 * re-read a figure that cannot have moved, and the operator-facing question about those
 * two is their state, not their traffic.
 */
export const OPERATION_LEGAL_FROM: Readonly<Record<OperationType, readonly ServiceState[]>> = {
  PROVISION: ['PENDING_PROVISION'],
  RECONCILE: ['UNRECONCILED'],
  SYNC_USAGE: ['ACTIVE'],
  // Not performable in this release. Empty rather than absent, so that a type reaching
  // here is refused by the state check as well as by `isPerformableOperation` — two
  // independent refusals, because this is the edit that must not fail open.
  RENEW: [],
  ADD_TRAFFIC: [],
  ADD_TIME: [],
  SUSPEND: [],
  RESUME: [],
  TERMINATE: [],
  ROTATE_SUBSCRIPTION: [],
};

/**
 * The provider call for one operation, and nothing else.
 *
 * Deliberately separated from everything that touches the database so that the rule
 * this phase must not break is visible in the type: this function receives a target and
 * an adapter and returns a result, and it cannot be handed a transaction.
 *
 * `PROVISION` is the only type this release executes, and this function performs only
 * that one — it does not switch on the operation type and must not grow a switch.
 * `RECONCILE` is a READ and is handled by `reconcileCall` below; every other member of
 * `OPERATION_TYPES` arrives with the phase that implements it, and the executor refuses
 * an operation it cannot perform before it reaches here, at `decideOperability`, with a
 * reason an operator can act on rather than an exception from inside a provider call.
 *
 * The docblock used to promise a throw for an unknown type. There is no such throw and
 * never was: the body calls `createUser` unconditionally, so a future type routed
 * through here would silently create a user on somebody's panel. It is written down
 * rather than quietly fixed because the next author to add an operation type is the
 * person that sentence would have misled.
 */
export async function provisionCall(
  adapter: ProviderAdapter,
  target: ProviderServiceTarget,
  http: Parameters<ProviderAdapter['createUser']>[1],
  input: {
    readonly serviceId: string;
    readonly ref: ProviderUserRef;
    readonly volumeBytes: bigint | null;
    readonly durationDays: number | null;
    readonly expiresAt: Date | null;
    readonly deviceLimit: number | null;
  },
): ReturnType<ProviderAdapter['createUser']> {
  return adapter.createUser(target, http, {
    username: input.ref.username,
    subscriptionRef: input.ref.subscriptionRef,
    clientId: input.ref.clientId,
    serviceId: input.serviceId as never,
    volumeBytes: input.volumeBytes,
    durationDays: input.durationDays,
    expiresAt: input.expiresAt,
    deviceLimit: input.deviceLimit,
  });
}

/**
 * One service's usage, read back from its panel. A READ, and only a read.
 *
 * Its own function beside `provisionCall` for the reason that one's docblock gives:
 * neither switches on the operation type, so a type routed through the wrong one cannot
 * quietly do the other one's work. This calls `readUsage` and nothing else, and it
 * cannot be handed a transaction.
 *
 * `readUsage` reports an account the panel does not have as `PROVIDER_ERROR` rather than
 * as zero usage, which is what this caller needs: a service Nexa believes is ACTIVE
 * whose account has been deleted on the panel is a real divergence an operator has to
 * see, and zero bytes used is what a brand new account looks like.
 */
export async function usageSyncCall(
  adapter: ProviderAdapter,
  target: ProviderServiceTarget,
  http: Parameters<ProviderAdapter['readUsage']>[1],
  ref: ProviderUserRef,
): ReturnType<ProviderAdapter['readUsage']> {
  return adapter.readUsage(target, http, ref);
}

/**
 * What a reconcile established, translated into the service transition it justifies.
 *
 * The one place `UNRECONCILED` is allowed to leave, and the guards
 * `SERVICE_MACHINE` names are the two branches here:
 *
 * - `providerUserAdopted` — the panel HAS the account, so the service becomes `ACTIVE`
 *   with whatever the panel says about it. The create did happen; the answer was lost.
 * - `providerUserProvablyAbsent` — the panel answered and does not have it, which is
 *   the ONLY thing that makes a fresh create legal. Back to `PENDING_PROVISION`.
 *
 * A lookup that failed produces neither. It leaves the service exactly where it was,
 * because "this installation still does not know" is not a finding.
 */
export type ReconcileVerdict =
  | {
      readonly kind: 'ADOPT';
      readonly providerUserId: string | null;
      readonly subscriptionUrl: string | null;
      readonly expiresAt: Date | null;
      readonly usedBytes: bigint | null;
    }
  | { readonly kind: 'ABSENT' }
  | {
      readonly kind: 'UNDECIDED';
      readonly failure: ProviderFailureKind;
      readonly status: number | null;
    };

export async function reconcileCall(
  adapter: ProviderAdapter,
  target: ProviderServiceTarget,
  http: Parameters<ProviderAdapter['lookupUser']>[1],
  ref: ProviderUserRef,
): Promise<ReconcileVerdict> {
  const found = await adapter.lookupUser(target, http, ref);
  if (!found.ok) return { kind: 'UNDECIDED', failure: found.failure, status: found.status };
  if (!found.found) return { kind: 'ABSENT' };
  return {
    kind: 'ADOPT',
    providerUserId: found.providerUserId,
    subscriptionUrl: found.delivery.kind === 'SUBSCRIPTION_LINK' ? found.delivery.url : null,
    expiresAt: found.usage?.expiresAt ?? null,
    usedBytes: found.usage?.usedBytes ?? null,
  };
}

/**
 * The service state one operation outcome produces.
 *
 * A pure function over the two machines, so the mapping is one table rather than a
 * branch in a loop. `SUCCEEDED` provisions; `UNKNOWN` loses track; `FAILED` leaves the
 * service exactly where it was, in `PENDING_PROVISION`, so a later attempt is legal.
 *
 * That last row is the one worth stating: a definitively failed create changed nothing
 * on the panel, so the service has not moved and must not be marked as anything other
 * than still owed.
 */
export function serviceEventFor(
  outcome: OperationState,
): 'PROVISIONED' | 'PROVISION_LOST_TRACK' | null {
  if (outcome === 'SUCCEEDED') return 'PROVISIONED';
  if (outcome === 'UNKNOWN') return 'PROVISION_LOST_TRACK';
  return null;
}
