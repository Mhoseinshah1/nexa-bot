import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';
import type { ProviderFailureKind } from './provider.js';

/**
 * Services and the operations that change them.
 *
 * ## Two aggregates, because there are two lifetimes
 *
 * A **Service** is Nexa's record of what a customer is entitled to. It outlives every
 * order: a renewal is a new order and a new operation against the SAME service, which
 * `operation.ts` already states.
 *
 * An **Operation** is one attempt at one external effect. It is short-lived, it may be
 * retried, and its id is DERIVED from the idempotency key — so two replicas racing a
 * retry agree on the id with no lookup and no coordination. That derivation is what
 * makes the unknown-outcome handling below possible at all.
 *
 * ## The provider is not the authority, and is not ignored either
 *
 * The canonical service is Nexa's. The provider holds external reality that must be
 * RECONCILED. Both halves of that sentence are load-bearing: treating the provider as
 * authoritative means a panel outage deletes a customer's entitlement, and treating it
 * as irrelevant means Nexa bills for something that does not exist.
 */

export const SERVICE_STATES = [
  /** The order is settled and nothing has been asked of a provider yet. */
  'PENDING_PROVISION',
  /** A provider holds a user for this service and it is usable. */
  'ACTIVE',
  /** Usable, but the provider side is switched off by an operator or by policy. */
  'SUSPENDED',
  /** Its window closed or its traffic ran out. Renewable. */
  'EXPIRED',
  /** Deliberately ended. Terminal. */
  'TERMINATED',
  /**
   * Provisioning was attempted and this installation does not know whether a provider
   * user exists. Never retried blindly; resolved by reconciliation.
   */
  'UNRECONCILED',
] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];
export const serviceStateSchema = z.enum(SERVICE_STATES);

export const SERVICE_TERMINAL_STATES = ['TERMINATED'] as const;

export const SERVICE_EVENTS = [
  'PROVISIONED',
  'PROVISION_LOST_TRACK',
  'RECONCILED_ACTIVE',
  'RECONCILED_ABSENT',
  'SUSPEND',
  'RESUME',
  'EXPIRE',
  'RENEW',
  'TERMINATE',
] as const;
export type ServiceEvent = (typeof SERVICE_EVENTS)[number];

/**
 * The service machine.
 *
 * `UNRECONCILED` is reachable from provisioning and from nothing else, and it leaves
 * only by reconciliation — to `ACTIVE` when a provider user was found, or back to
 * `PENDING_PROVISION` when it provably was not, which is the only state from which a
 * fresh create is safe. A transition straight from `UNRECONCILED` to a second create
 * is exactly the duplicate this state exists to prevent, so the graph does not have
 * one.
 *
 * `EXPIRED` is not terminal: renewal is the product. `TERMINATED` is, and it is the
 * only state with no way out — a terminated service that could come back would make
 * "terminate" a word an operator could not rely on.
 */
export const SERVICE_MACHINE: StateMachineDefinition<ServiceState, ServiceEvent> = {
  name: 'service',
  initial: 'PENDING_PROVISION',
  states: SERVICE_STATES,
  terminal: SERVICE_TERMINAL_STATES,
  transitions: [
    { from: 'PENDING_PROVISION', to: 'ACTIVE', on: 'PROVISIONED' },
    { from: 'PENDING_PROVISION', to: 'UNRECONCILED', on: 'PROVISION_LOST_TRACK' },
    { from: 'PENDING_PROVISION', to: 'TERMINATED', on: 'TERMINATE' },
    {
      from: 'UNRECONCILED',
      to: 'ACTIVE',
      on: 'RECONCILED_ACTIVE',
      guard: 'providerUserAdopted',
    },
    {
      from: 'UNRECONCILED',
      to: 'PENDING_PROVISION',
      on: 'RECONCILED_ABSENT',
      guard: 'providerUserProvablyAbsent',
    },
    { from: 'UNRECONCILED', to: 'TERMINATED', on: 'TERMINATE' },
    { from: 'ACTIVE', to: 'SUSPENDED', on: 'SUSPEND' },
    { from: 'ACTIVE', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'ACTIVE', to: 'TERMINATED', on: 'TERMINATE' },
    { from: 'SUSPENDED', to: 'ACTIVE', on: 'RESUME' },
    { from: 'SUSPENDED', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'SUSPENDED', to: 'TERMINATED', on: 'TERMINATE' },
    { from: 'EXPIRED', to: 'ACTIVE', on: 'RENEW' },
    { from: 'EXPIRED', to: 'TERMINATED', on: 'TERMINATE' },
  ],
};

/**
 * What an operation is trying to do.
 *
 * Each member maps onto one or more `PROVIDER_CAPABILITIES`, and a tenant whose panel
 * lacks the capability gets a refusal naming it rather than a silent no-op. The
 * mapping is declared in `OPERATION_REQUIRED_CAPABILITIES` below so a surface can tell
 * a customer which buttons are real on their panel.
 */
export const OPERATION_TYPES = [
  'PROVISION',
  'RENEW',
  'ADD_TRAFFIC',
  'ADD_TIME',
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'SYNC_USAGE',
  'ROTATE_SUBSCRIPTION',
  'RECONCILE',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];
export const operationTypeSchema = z.enum(OPERATION_TYPES);

/**
 * The capability each operation needs on the panel it runs against.
 *
 * `RECONCILE` needs none: it reads, and reading a user is how both adapters already
 * establish health. `SYNC_USAGE` needs `READ_USAGE` because a usage figure invented
 * from an expiry date is the kind of number the legacy system's reports are made of.
 */
export const OPERATION_REQUIRED_CAPABILITIES: Readonly<Record<OperationType, readonly string[]>> = {
  PROVISION: ['CREATE_USER'],
  RENEW: ['RENEW_USER'],
  ADD_TRAFFIC: ['ADD_VOLUME'],
  ADD_TIME: ['ADD_TIME'],
  SUSPEND: ['DISABLE_USER'],
  RESUME: ['ENABLE_USER'],
  TERMINATE: ['DELETE_USER'],
  SYNC_USAGE: ['READ_USAGE'],
  ROTATE_SUBSCRIPTION: ['ROTATE_SUBSCRIPTION_LINK'],
  RECONCILE: [],
};

export const OPERATION_STATES = [
  /** Recorded, committed, and not yet attempted. The provider has not been called. */
  'PLANNED',
  /** A worker has claimed it and a provider call is in flight or about to be. */
  'IN_FLIGHT',
  'SUCCEEDED',
  /** The provider definitively refused or the request never left. Safe to retry. */
  'FAILED',
  /**
   * The call may have taken effect. NOT safe to retry as the same mutation; the next
   * step is a read.
   */
  'UNKNOWN',
  /** Abandoned by an operator, after reconciliation established what happened. */
  'ABANDONED',
] as const;
export type OperationState = (typeof OPERATION_STATES)[number];
export const operationStateSchema = z.enum(OPERATION_STATES);

export const OPERATION_TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'ABANDONED'] as const;

export const OPERATION_EVENTS = [
  'CLAIM',
  'SUCCEED',
  'FAIL',
  'LOSE_TRACK',
  'RECONCILE_SUCCEEDED',
  'RECONCILE_FAILED',
  'ABANDON',
  'RELEASE',
] as const;
export type OperationEvent = (typeof OPERATION_EVENTS)[number];

/**
 * The operation machine.
 *
 * `RELEASE` takes a claimed operation back to `PLANNED`, and it is the transition a
 * crashed worker's lease expiry uses. It exists because the alternative — leaving a
 * crashed operation `IN_FLIGHT` for ever — means an operator has to decide whether a
 * provider was called, which is precisely the question nobody can answer after the
 * fact. A release is only legal when the claim's lease has expired AND no provider
 * call was recorded as started, which is what the guard names.
 */
export const OPERATION_MACHINE: StateMachineDefinition<OperationState, OperationEvent> = {
  name: 'provisioning_operation',
  initial: 'PLANNED',
  states: OPERATION_STATES,
  terminal: OPERATION_TERMINAL_STATES,
  transitions: [
    { from: 'PLANNED', to: 'IN_FLIGHT', on: 'CLAIM' },
    { from: 'PLANNED', to: 'ABANDONED', on: 'ABANDON' },
    { from: 'IN_FLIGHT', to: 'SUCCEEDED', on: 'SUCCEED' },
    { from: 'IN_FLIGHT', to: 'FAILED', on: 'FAIL' },
    { from: 'IN_FLIGHT', to: 'UNKNOWN', on: 'LOSE_TRACK' },
    { from: 'IN_FLIGHT', to: 'PLANNED', on: 'RELEASE', guard: 'leaseExpiredAndCallNeverStarted' },
    { from: 'UNKNOWN', to: 'SUCCEEDED', on: 'RECONCILE_SUCCEEDED', guard: 'providerStateRead' },
    { from: 'UNKNOWN', to: 'FAILED', on: 'RECONCILE_FAILED', guard: 'providerStateRead' },
    { from: 'UNKNOWN', to: 'ABANDONED', on: 'ABANDON' },
  ],
};

/**
 * Which provider failures are safe to retry as the same mutation.
 *
 * Derived from the EXISTING taxonomy in `provider.ts` rather than a new one, per the
 * audit. The division is not "transient versus permanent": it is **did the request
 * certainly not take effect**.
 *
 * - `UNREACHABLE`, `TLS_FAILED`, `BLOCKED_TARGET`, `AUTHENTICATION_FAILED`,
 *   `AUTHENTICATION_REQUIRES_INTERACTION` — the request never reached an authenticated
 *   endpoint, so nothing happened. Safe.
 * - `RATE_LIMITED` — the panel refused to process it, explicitly. Safe, after the
 *   retry-after it supplied.
 * - `TIMEOUT` — the request may have been received and processed. **NOT safe.** This is
 *   the one that costs a customer a duplicate account if it is classified by how it
 *   feels rather than by what it means.
 * - `PROVIDER_ERROR` and anything else — a 5xx may have committed a write before
 *   failing to answer. NOT safe.
 */
export const SAFE_TO_REPLAY_FAILURE_KINDS: readonly ProviderFailureKind[] = [
  'UNREACHABLE',
  'TLS_FAILED',
  'BLOCKED_TARGET',
  'AUTHENTICATION_FAILED',
  'AUTHENTICATION_REQUIRES_INTERACTION',
  'RATE_LIMITED',
] as unknown as readonly ProviderFailureKind[];

/**
 * Classifies a provider failure into the operation state it produces.
 *
 * Pure and total, so the decision is testable without a provider and identical in every
 * worker. A mutation whose outcome is not certainly "nothing happened" becomes
 * `UNKNOWN`, and `UNKNOWN` is never retried as the same mutation.
 *
 * A non-mutating operation is always `FAILED` rather than `UNKNOWN`: a read that did not
 * answer changed nothing by definition, so there is nothing to reconcile.
 */
export function failureOutcome(kind: ProviderFailureKind, mutating: boolean): OperationState {
  if (!mutating) return 'FAILED';
  return (SAFE_TO_REPLAY_FAILURE_KINDS as readonly string[]).includes(kind) ? 'FAILED' : 'UNKNOWN';
}

/** Whether this operation type changes provider-side state. */
export function isMutatingOperation(type: OperationType): boolean {
  return type !== 'SYNC_USAGE' && type !== 'RECONCILE';
}

/**
 * The mutations whose provider-side effect is IDEMPOTENT — replaying one changes
 * nothing the first one did not already do.
 *
 * A different question from `isMutatingOperation`, and the one that decides whether an
 * uncertain outcome may simply be tried again.
 *
 * `PROVISION` is the reason `failureOutcome` exists: a create whose answer was lost may
 * have taken effect, and repeating it costs the customer a second account and the
 * operator a second bill. So it becomes `UNKNOWN`, and `UNKNOWN` is resolved by a READ
 * — `RECONCILE` asks the panel whether the account is there.
 *
 * These three are not like that, and the difference was MEASURED against a real panel
 * rather than reasoned about (`docs/real-panel-acceptance.md`):
 *
 *   - a repeated disable answers 200 and leaves the account disabled;
 *   - a repeated enable answers 200 and leaves it active;
 *   - a repeated delete answers 404, which is the outcome the operation asked for.
 *
 * So an uncertain suspend is retried as the same suspend. That is not merely more
 * convenient than `UNKNOWN` — it is the only thing that WORKS, because `UNKNOWN` is
 * resolved by `RECONCILE`, `RECONCILE` calls `lookupUser`, and `lookupUser` answers
 * whether an account EXISTS and not what state it is in. An uncertain suspend routed to
 * reconciliation would sit in `UNKNOWN` for ever with nothing able to decide it, which
 * is the dead end `UNRECONCILED` had in Phase 4D and that 4D-R1 was written to remove.
 *
 * The obvious hazard — a suspend replayed against a service somebody resumed in between
 * — cannot arise from inside this system, and the reason is structural rather than
 * lucky. `OPERATION_LEGAL_FROM.RESUME` is `['SUSPENDED']`, and a service whose suspend
 * did not complete is still `ACTIVE`, so there is nothing to resume. An operator who
 * re-enables the account on the panel directly is outside what this installation models,
 * and is outside what any classification here could protect.
 *
 * Adding a type to this list is a claim about a wire contract. It needs the same
 * evidence the three above have: a panel, run twice.
 */
export const IDEMPOTENT_MUTATIONS = [
  'SUSPEND',
  'RESUME',
  'TERMINATE',
] as const satisfies readonly OperationType[];

export function isIdempotentMutation(type: OperationType): boolean {
  return (IDEMPOTENT_MUTATIONS as readonly string[]).includes(type);
}

/**
 * The operation state one provider failure produces, for one operation type.
 *
 * The single place the two axes above are combined, so no caller has to remember to ask
 * both. `failureOutcome` answers "did the request certainly not take effect" and stays
 * exactly as it was — this does not re-derive it and must not.
 *
 *   a READ                  -> FAILED. There is nothing to be uncertain about.
 *   an IDEMPOTENT mutation  -> FAILED. Uncertain, and retrying it is the resolution.
 *   anything else           -> `failureOutcome`, which yields UNKNOWN unless the
 *                              failure kind proves nothing happened.
 *
 * `FAILED` is not "give up": `PROVIDER_FAILURE_RETRYABLE` still decides whether the
 * operation is planned again with a backoff or becomes terminal, and the attempt
 * ceiling still applies. What `FAILED` says here is that the next attempt may be the
 * same mutation, which for these three is true and for a create is not.
 */
export function operationFailureOutcome(
  kind: ProviderFailureKind,
  type: OperationType,
): OperationState {
  if (!isMutatingOperation(type)) return 'FAILED';
  if (isIdempotentMutation(type)) return 'FAILED';
  return failureOutcome(kind, true);
}

/**
 * How long a worker's claim on an operation is good for.
 *
 * A bound, not a policy: the configured lease is an operator setting. The floor is
 * above the provider HTTP timeout plus its retries, because a lease that can expire
 * while a call is still in flight would let a second worker start the same mutation —
 * the exact duplicate the claim exists to prevent.
 */
export const OPERATION_LEASE_SECONDS_MIN = 60;
export const OPERATION_LEASE_SECONDS_MAX = 3600;

/**
 * How many times a PLANNED operation may be attempted before it stops on its own.
 *
 * A ceiling rather than a retry policy. An operation that has failed this many times is
 * not going to succeed by being tried again, and the thing an operator needs is the
 * record, not another attempt.
 */
export const OPERATION_MAX_ATTEMPTS = 5;

/**
 * How stale a service's usage figure may get before a `SYNC_USAGE` is planned for it.
 *
 * A BOUND, not a cadence: the cadence is `provisioning.usage_sync_minutes`, an operator
 * setting, because how often a tenant wants to poll somebody else's panel depends on
 * how many services they have on it and what that panel tolerates.
 *
 * The floor exists because every sync is an outbound request against the tenant's ONE
 * probe budget — the same bucket the monitor and provisioning spend from — so a cadence
 * of seconds would starve the operator's own panel work with reads nobody asked for.
 * The ceiling exists because the figure this refreshes is what a customer is told when
 * they ask how much traffic they have left, and a number a day old is the kind the
 * legacy reports were made of.
 */
export const USAGE_SYNC_MINUTES_MIN = 15;
export const USAGE_SYNC_MINUTES_MAX = 1440;

/**
 * How many services one tick may plan a usage sync for.
 *
 * Bounded for the same reason the monitor's discovery is: a tenant with ten thousand
 * services must not turn one tick into ten thousand rows, and the next tick picks up
 * where this one stopped because the query orders by how stale the figure is.
 */
export const USAGE_SYNC_PLAN_LIMIT = 50;

/**
 * The provider-side username this installation assigns.
 *
 * Deterministic from the service id, which is the property that makes adoption possible:
 * after an unknown outcome, a reconcile can ASK the provider for this exact name. A
 * random or customer-chosen name would leave nothing to ask for, and the only remaining
 * move would be a blind create.
 *
 * Lowercase hex of the service id with the dashes removed, prefixed. No customer text
 * enters it: a username built from a Telegram display name would carry Persian
 * characters, emoji and somebody's real name onto a third party's panel.
 */
export const PROVIDER_USERNAME_PREFIX = 'nx';

export function providerUsernameFor(serviceId: string): string {
  const compact = serviceId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error('a provider username is derived from a UUID service id');
  }
  return `${PROVIDER_USERNAME_PREFIX}${compact}`;
}

/**
 * Whether the customer has actually been told about their service.
 *
 * A SEPARATE axis from `ServiceState`, and that separation is the whole point. A
 * service whose provider user exists is `ACTIVE` whether or not Telegram accepted the
 * message announcing it — folding the two together would mean a failed send made a
 * real, paid-for, provider-side account look unprovisioned, and the obvious "fix" for
 * that is to provision it again.
 *
 * Four values, because there are four genuinely different operator situations:
 *
 * - `PENDING` — not yet announced, or announced and DEFINITELY refused. Retryable, and
 *   the only value a background sweep will act on.
 * - `DELIVERED` — Telegram accepted it.
 * - `UNCONFIRMED` — the send outcome was `UNKNOWN`: a timeout, a 5xx, a 429, or a 2xx
 *   whose body would not parse. The customer MAY have it. Never retried automatically —
 *   the customer messenger's own port already states the reason, that a retried "your
 *   service is ready" is a customer wondering which one is true. Re-delivery from here
 *   is a deliberate act by an operator or by the customer opening their service.
 * - `FAILED` — definitely refused `DELIVERY_MAX_ATTEMPTS` times. Not retried
 *   automatically either, because something is wrong that another attempt will not fix
 *   — the customer has blocked the bot, or the bot's token is dead.
 *
 * `PENDING` covering "refused once" rather than a fifth value is deliberate: a definite
 * refusal changed nothing, so the situation is identical to never having tried.
 */
export const SERVICE_DELIVERY_STATES = ['PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED'] as const;
export type ServiceDeliveryState = (typeof SERVICE_DELIVERY_STATES)[number];
export const serviceDeliveryStateSchema = z.enum(SERVICE_DELIVERY_STATES);

/** The states a background sweep may act on. Everything else needs a person. */
export const DELIVERY_AUTO_RETRY_STATES: readonly ServiceDeliveryState[] = ['PENDING'];

/**
 * How many definite refusals before a delivery stops being retried on its own.
 *
 * Lower than `OPERATION_MAX_ATTEMPTS` on purpose. A provider create is worth persisting
 * with because the customer has paid and nothing else can produce the thing they bought;
 * a Telegram send that has been refused three times is being refused for a reason that
 * a fourth attempt does not change, and the remaining attempts would be spent messaging
 * somebody who has blocked the bot.
 */
export const DELIVERY_MAX_ATTEMPTS = 3;

/**
 * How long a subscription reference is, and what it is made of.
 *
 * Thirty-two lowercase hex characters — sixteen RANDOM bytes, and the randomness is the
 * point. `subscriptionRefFor` and `providerClientIdFor` used to live here, deriving both
 * from the service id through the same unkeyed `Hasher` that mints operation ids, and
 * claiming in their own docblocks that neither was derivable from the username.
 *
 * Both claims were false. `providerUsernameFor` is a reversible ENCODING of the service
 * id rather than a hash, so a name read off a panel's client list recovered the id; and
 * the id itself travels in `operational_events.context`, in `audit_logs.entity_id` and
 * in `outbox_messages.aggregate_id`. Anybody who could read an audit log could compute
 * the link that serves a customer's configuration with no authentication, and the VLESS
 * client id that configuration authenticates with.
 *
 * The recoverability the derivation existed for is kept by STORING both values, written
 * in the settling transaction before any provider call — see `services.subscription_ref`.
 * A value committed before the call survives a lost answer exactly as well as one that
 * can be recomputed, and cannot be recomputed by anybody else.
 *
 * `providerUsernameFor` stays derived. It is an identifier, not a capability, and being
 * askable-for by name after a lost write is the whole reason it exists.
 */
export const SUBSCRIPTION_REF_LENGTH = 32;
export const SUBSCRIPTION_REF_BYTES = 16;
