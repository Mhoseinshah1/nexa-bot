import {
  OPERATION_MAX_ATTEMPTS,
  operationFailureOutcome,
  UNLIMITED_DURATION_DAYS,
  type CanApplyAllowance,
  type CanDeleteUser,
  type CanDisableUser,
  type CanEnableUser,
  type CanRotateSubscription,
  type OperationState,
  type OperationType,
  type ProviderAdapter,
  type ProviderFailureKind,
  type ProviderServiceTarget,
  type ProviderAllowancePlan,
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

/**
 * What a tick did, and enough about it to write one log line.
 *
 * `orderId`, `panelId`, `attempt` and `terminal` were added by the hotfix for
 * order `01a0c54b`, whose report says in as many words: "Provisioner logs
 * contained no useful per-operation failure entry". They were not missing
 * because logging was forgotten — `ProvisionerLoop` has a logger and uses it —
 * but because a refusal RETURNS A VALUE, and the value did not carry the four
 * things somebody debugging a stuck order actually needs.
 *
 * Every field here is an ID or an enum. None of them is a credential, a
 * subscription URL, a token or a provider's response body, and that is a
 * property of the type rather than a rule about the logger: a shape with nowhere
 * to put a secret cannot leak one.
 */
export type ExecutionResult =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'REFUSED';
      readonly operationId: string;
      readonly reason: ExecutionRefusal;
      /** Null only for a refusal reached before the operation was read. */
      readonly serviceId?: string | null;
      readonly orderId?: string | null;
      readonly panelId?: string | null;
      readonly attempt?: number;
      /**
       * Whether this refusal ended the operation, rather than scheduling it again.
       *
       * The single most useful bit in the line: it separates "this is over, the
       * customer has their money back" from "this will be tried again shortly",
       * which the reason alone no longer tells you now that six refusals are
       * deterministic and five are not.
       */
      readonly terminal?: boolean;
    }
  | {
      readonly kind: 'ATTEMPTED';
      readonly operationId: string;
      readonly serviceId: string;
      readonly outcome: OperationState;
      readonly failureKind: ProviderFailureKind | null;
      readonly orderId?: string | null;
      readonly panelId?: string | null;
      readonly attempt?: number;
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
 * ALL THREE ARE READ FROM THE ROW. None is recomputed here, and the username was.
 *
 * It used to be `providerUsernameFor(service.id)` while `services.provider_username` sat
 * stored beside it and unread on this path. The two agreed only because generation was a
 * deterministic function of the service id — an identity that stops holding the moment a
 * username is customer-chosen or template-rendered. At that point the row would record
 * one name and the panel be asked to create another: `services_panel_provider_username_key`
 * guarding a value nobody sent, a reconcile asking for a name that was never created, and
 * a customer shown a username their account does not have. No test caught it, because
 * every test asserted the identity that was about to stop holding
 * (`docs/phase6c-audit.md` A-4).
 *
 * What reconciliation actually needs is that the name was COMMITTED BEFORE the provider
 * call, not that it can be recomputed — the same argument migration 0045 already made for
 * `subscription_ref`, which was derived for the same stated reason and is now stored. A
 * value written in the settling transaction survives a lost answer exactly as well.
 *
 * The other two remain what they were: CAPABILITIES. Anybody holding the subscription
 * reference can fetch the customer's configuration unauthenticated, and the client id is
 * what that configuration authenticates with, so both are random rather than computable
 * from an id that travels through the audit log, the operations log and the outbox.
 */
export function providerRefFor(service: {
  readonly providerUsername: string;
  readonly subscriptionRef: string;
  readonly providerClientId: string;
}): ProviderUserRef {
  return {
    username: service.providerUsername,
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
 * Delegates to `operationFailureOutcome`, which is pure, total and already written.
 * This phase must not re-derive that table: the division it encodes is not
 * transient-versus-permanent but "did the request certainly not take effect", and a
 * second copy would be a second place for `TIMEOUT` to be optimistically reclassified
 * as retryable — which costs a customer a duplicate account.
 *
 * It used to call `failureOutcome(failure, isMutatingOperation(type))` directly. The
 * contract now combines both axes in one function, because a third axis joined them:
 * whether the mutation is IDEMPOTENT, which decides whether an uncertain outcome may be
 * retried as itself instead of waiting for a read. Asking one function rather than two
 * is what stops a caller answering one and forgetting the other.
 */
export function outcomeFor(
  failure: ProviderFailureKind,
  operationType: OperationType,
): OperationState {
  return operationFailureOutcome(failure, operationType);
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
 * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` joined in Phase 4F, once there was an order
 * behind each of them and a panel that could apply one. `ROTATE_SUBSCRIPTION` joined
 * with RickPanel's `rotateSubscription` and the operator-only decision recorded in
 * `docs/rickpanel-rotate-audit.md`; a panel without the method and the capability is
 * refused by `decideOperability` before it is dialled, as for every type here.
 *
 * `SUSPEND`, `RESUME` and `TERMINATE` joined the list once Marzban could perform them.
 * Membership here is NOT a claim that every panel can: `decideOperability` checks each
 * type's required capability against the panel's own descriptor, so the same operation
 * against a 3X-UI-backed service is refused with `CAPABILITY_UNSUPPORTED` before
 * anything is dialled. This list says "the executor has a branch for it"; the
 * descriptor says "this panel can do it"; both have to be true.
 */
export const PERFORMABLE_OPERATION_TYPES = [
  'PROVISION',
  'RECONCILE',
  'SYNC_USAGE',
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'ROTATE_SUBSCRIPTION',
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
  /*
   * Transcribed from `SERVICE_MACHINE`, one edge at a time, and deliberately not
   * computed from it.
   *
   * A derivation would track the machine automatically, which sounds like the safer
   * option and is the opposite: a future edge added for one reason — say
   * `EXPIRED -> ACTIVE on RENEW` gaining a sibling — would silently become a state the
   * provisioner is willing to suspend from, with no commit and no review anywhere near
   * the executor. Writing them out means adding a state here is a decision somebody
   * made.
   *
   * `SUSPEND` from `ACTIVE` and `RESUME` from `SUSPENDED` are each one edge, and each
   * is the only edge that reaches its target on that event.
   */
  SUSPEND: ['ACTIVE'],
  RESUME: ['SUSPENDED'],
  /*
   * `TERMINATE` from every state that is not already terminal, because
   * `SERVICE_MACHINE` has an edge to `TERMINATED` from each of them. That is the point
   * of terminate: a service an operator or a customer has decided to end must be
   * endable whatever went wrong on the way, including one stuck in `UNRECONCILED`
   * after a lost create. `TERMINATED` itself is absent — it is terminal, and a second
   * terminate is refused here rather than turned into a second DELETE against a panel.
   */
  TERMINATE: ['PENDING_PROVISION', 'UNRECONCILED', 'ACTIVE', 'SUSPENDED', 'EXPIRED'],
  /*
   * `RENEW` from the two states a renewal means something in, and from nowhere else.
   *
   * `EXPIRED` is `SERVICE_MACHINE`'s own `EXPIRED -> ACTIVE on RENEW` — the edge frozen
   * since Phase 0 that this phase finally gives a caller. `ACTIVE` is not an edge at
   * all: renewing a live service buys it more time and leaves it exactly where it is,
   * which is why `recordAllowance` exists beside `transition` rather than inside it.
   *
   * `SUSPENDED` is deliberately ABSENT, and that is a measurement rather than a
   * preference. The pinned Marzban leaves a `disabled` account disabled through both an
   * expiry and a data limit (`scripts/marzban-allowance-check.sh`, row 6), so a renewal
   * there would take the customer's money and change nothing they could see. A
   * suspended service is resumed first.
   */
  RENEW: ['ACTIVE', 'EXPIRED'],
  /*
   * The two quantity purchases, from `ACTIVE` alone.
   *
   * Not from `EXPIRED`, and the two reasons are different. Extra traffic on a service
   * whose window has closed buys an allowance nothing can spend — the legacy system
   * says the same thing about its own extra-volume flow, that the purchase is bounded
   * by the existing expiry and does not extend it (`TBR-009`). And extra TIME on an
   * expired service would be a renewal in all but name, needing the machine's
   * `EXPIRED -> ACTIVE` edge under a different event; the honest way to bring an expired
   * service back is `RENEW`, which is the edge that exists.
   */
  ADD_TRAFFIC: ['ACTIVE'],
  ADD_TIME: ['ACTIVE'],
  /*
   * A new link for an account that exists and is certain: ACTIVE, and SUSPENDED
   * deliberately — the ordinary response to a leaked link is to suspend first and
   * rotate second. The delivery sweep claims only ACTIVE services, so a suspended
   * customer is sent the new link when they are resumed, not while they are paused.
   * `docs/rickpanel-rotate-audit.md` D2.
   */
  ROTATE_SUBSCRIPTION: ['ACTIVE', 'SUSPENDED'],
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
 * The three management calls, each its own function beside `provisionCall`.
 *
 * Three, not one with a parameter, for the reason `provisionCall`'s docblock gives
 * about itself: a function that switches on the operation type is a function a
 * mis-routed type can make do the wrong thing, and the wrong thing here is deleting a
 * customer's account instead of pausing it. Each of these calls exactly one adapter
 * method and cannot be handed a transaction.
 *
 * The adapter arrives ALREADY NARROWED — `CanDisableUser`, `CanEnableUser`,
 * `CanDeleteUser` — so the method is present by type rather than by a check inside.
 * `canDisableUser` and its siblings are the only way to produce those types, and each
 * requires the declared capability as well as the method, so a caller cannot reach
 * these functions with an adapter that does not advertise the operation.
 */
export async function suspendCall(
  adapter: CanDisableUser,
  target: ProviderServiceTarget,
  http: Parameters<CanDisableUser['suspendUser']>[1],
  ref: ProviderUserRef,
): ReturnType<CanDisableUser['suspendUser']> {
  return adapter.suspendUser(target, http, ref);
}

export async function resumeCall(
  adapter: CanEnableUser,
  target: ProviderServiceTarget,
  http: Parameters<CanEnableUser['resumeUser']>[1],
  ref: ProviderUserRef,
): ReturnType<CanEnableUser['resumeUser']> {
  return adapter.resumeUser(target, http, ref);
}

/**
 * The rotation call. The adapter settles its own ambiguity by reading the account back
 * against `previousUrl`, so what returns is either a link the panel holds now or a
 * failure that provably changed nothing — `ProviderAdapter.rotateSubscription`.
 */
export async function rotateCall(
  adapter: CanRotateSubscription,
  target: ProviderServiceTarget,
  http: Parameters<CanRotateSubscription['rotateSubscription']>[1],
  ref: ProviderUserRef,
  previousUrl: string | null,
): ReturnType<CanRotateSubscription['rotateSubscription']> {
  return adapter.rotateSubscription(target, http, ref, previousUrl);
}

/**
 * The commercial call: make this account's allowance read as the plan says.
 *
 * ONE function for three operation types, which is the opposite of the three above and
 * the same asymmetry `ProviderAdapter.applyAllowance` carries, for the same reason: the
 * three differ in what they BOUGHT, not in what they ask the panel to do. The
 * difference is already expressed — in the target, computed once when the order
 * settled, which this function only passes along.
 *
 * It cannot switch on the operation type and must not grow a branch that does. The
 * plan is the whole of the instruction, and a function that re-derived any part of it
 * from the type would be a second place where a renewal's arithmetic lives.
 *
 * The adapter arrives already narrowed, so the method is present by type. The three
 * predicates that produce that type — `canRenewUser`, `canAddVolume`, `canAddTime` —
 * each require their own declared capability, so the caller cannot reach here with an
 * adapter that does not advertise the specific operation being performed.
 */
export async function allowanceCall(
  adapter: CanApplyAllowance,
  target: ProviderServiceTarget,
  http: Parameters<CanApplyAllowance['applyAllowance']>[1],
  ref: ProviderUserRef,
  plan: ProviderAllowancePlan,
): ReturnType<CanApplyAllowance['applyAllowance']> {
  return adapter.applyAllowance(target, http, ref, plan);
}

export async function terminateCall(
  adapter: CanDeleteUser,
  target: ProviderServiceTarget,
  http: Parameters<CanDeleteUser['terminateUser']>[1],
  ref: ProviderUserRef,
): ReturnType<CanDeleteUser['terminateUser']> {
  return adapter.terminateUser(target, http, ref);
}

/**
 * Which service state each management operation moves a service INTO, on success.
 *
 * A table rather than a branch, and only for the two that have exactly one target.
 * `TERMINATE` is absent because its target is `TERMINATED` from any of five states, so
 * the `from` is the service's own current state and is read at the call site.
 */
export const MANAGEMENT_TARGET_STATE: Readonly<Record<'SUSPEND' | 'RESUME', ServiceState>> = {
  SUSPEND: 'SUSPENDED',
  RESUME: 'ACTIVE',
};

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
