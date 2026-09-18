import {
  SERVICE_OPERATOR_ACTIONS,
  type OperationType,
  type ServiceActionAvailability,
  type ServiceActionBlocker,
  type ServiceOperatorAction,
  type ServiceState,
} from '@nexa/contracts';
import { OPERATION_LEGAL_FROM } from './provision-executor.js';
import type { PanelOperability, PanelOperabilityRefusal } from './ports.js';

/**
 * What an operator may do to a service right now, decided in ONE place.
 *
 * Phase 6A. Seven actions, three authorities — the service's state, the panel's
 * capabilities, and whether an operation of that type is already open — and before this
 * file the answer was computed nowhere: the Web Admin had no writes at all, and the
 * customer surface had its own three-line version for its own three actions.
 *
 * ## Pure, and that is the point
 *
 * It takes facts and returns verdicts. No repository, no guard, no clock. The gathering
 * is the caller's (`ServiceAdminService.detail`), which means this can be exhausted over
 * every state in a unit test — and it is, because the failure mode being avoided is a
 * surface that offers an action the request then refuses. That mismatch is not a
 * cosmetic defect: a button that always fails is how the legacy panel told an operator
 * a receipt could be approved by somebody who could not approve it.
 *
 * ## It is NOT the authorization, and it is not the state check either
 *
 * Every write path re-checks its permission, its legal states, its panel operability and
 * its open-operation guard inside its own transaction. This exists so the screen can say
 * *which* of those refused, in advance. `docs/conventions.md` states the rule it must not
 * be read as satisfying: never by not drawing a button.
 */

/**
 * The operation each action plans, or `null` where it plans none.
 *
 * `RESEND_CONFIG` is the null: it sends a message and writes a delivery row, and no
 * provider is called. Keeping it in the same list as the six that DO plan an operation
 * is deliberate — it is an action an operator takes on a service from the same screen,
 * and giving it a separate vocabulary would mean a second availability mechanism for one
 * button.
 *
 * `RETRY_PROVISION` maps to `PROVISION`, which is what it plans.
 */
export const SERVICE_ACTION_OPERATION: Readonly<
  Record<ServiceOperatorAction, OperationType | null>
> = {
  SYNC_USAGE: 'SYNC_USAGE',
  RESEND_CONFIG: null,
  RETRY_PROVISION: 'PROVISION',
  RECONCILE: 'RECONCILE',
  SUSPEND: 'SUSPEND',
  RESUME: 'RESUME',
  TERMINATE: 'TERMINATE',
};

/**
 * The states a resend is possible from — `ProvisioningService.isDeliverable`'s live set.
 *
 * Written here rather than imported from that static so this file stays free of the
 * service class, and asserted against it in `tests/unit/service-actions.test.ts`: if the
 * two ever disagree the test fails rather than the screen offering a resend the delivery
 * service refuses.
 */
export const RESEND_LEGAL_FROM: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];

/** Where a customer's configuration would be sent, reduced to what this decision needs. */
export type ServiceContactPresence = 'PRESENT' | 'ABSENT';

export interface ServiceActionFacts {
  readonly state: ServiceState;
  /** Whether a configuration exists to send. `subscriptionUrl !== null`. */
  readonly hasConfiguration: boolean;
  /**
   * Whether there is somewhere to send it. A BLOCKED customer counts as ABSENT: the
   * block is exactly an instruction not to message them, and a resend that ignored it
   * would be the surface overriding an operator's own decision.
   */
  readonly contact: ServiceContactPresence;
  /** The operation types with an open row for this service. */
  readonly openOperations: readonly OperationType[];
  /**
   * The panel's verdict per operation type, from `decideOperability`. A type absent from
   * the map is treated as not operable rather than as operable — fail closed, the rule
   * `OPERATION_REQUIRED_CAPABILITIES` exists to serve.
   */
  readonly operability: Readonly<Partial<Record<OperationType, PanelOperability>>>;
}

/**
 * The panel reason, mapped to the blocker an operator can act on.
 *
 * `CAPABILITY_UNSUPPORTED` is its own blocker because it is the one that no amount of
 * fixing the panel row will change: 3X-UI has no `DISABLE_USER`, so suspend is not a
 * misconfiguration, it is the truth about that provider. The other five are all "go and
 * fix this panel", and the panel screen already says which.
 */
function blockerFor(reason: PanelOperabilityRefusal): ServiceActionBlocker {
  return reason === 'CAPABILITY_UNSUPPORTED' ? 'CAPABILITY' : 'PANEL_NOT_OPERABLE';
}

/**
 * One action's verdict.
 *
 * The ORDER of the three checks is deliberate and matches what a person can do about
 * each. State first: an action that is illegal from this state stays illegal however the
 * panel is configured, and telling an operator to fix a capability for a terminated
 * service would send them to the wrong screen. Then the panel, because that is a
 * configuration answer. `IN_PROGRESS` last, because it is the only transient one and
 * reporting it over a real blocker would promise that waiting helps.
 */
function evaluate(
  action: ServiceOperatorAction,
  facts: ServiceActionFacts,
): ServiceActionAvailability {
  const type = SERVICE_ACTION_OPERATION[action];
  const legalFrom = type === null ? RESEND_LEGAL_FROM : OPERATION_LEGAL_FROM[type];
  if (!legalFrom.includes(facts.state)) {
    return { action, available: false, blocker: 'STATE' };
  }

  if (type === null) {
    // Delivery's own two refusals, in the order `DeliveryService` applies them: there is
    // nothing to send before there is nobody to send it to.
    if (!facts.hasConfiguration) {
      return { action, available: false, blocker: 'NO_CONFIGURATION' };
    }
    if (facts.contact === 'ABSENT') {
      return { action, available: false, blocker: 'NO_CONTACT' };
    }
    return { action, available: true, blocker: null };
  }

  const verdict = facts.operability[type];
  // Absent is refused, not permitted. A caller that forgot to ask about a type must not
  // thereby offer it.
  if (verdict === undefined) {
    return { action, available: false, blocker: 'PANEL_NOT_OPERABLE' };
  }
  if (!verdict.ok) {
    return { action, available: false, blocker: blockerFor(verdict.reason) };
  }

  if (facts.openOperations.includes(type)) {
    return { action, available: false, blocker: 'IN_PROGRESS' };
  }
  return { action, available: true, blocker: null };
}

/**
 * Every action, available or not, in the frozen order of `SERVICE_OPERATOR_ACTIONS`.
 *
 * The full list rather than the available subset, for the reason the contract's docblock
 * gives: a surface handed only what it may do cannot distinguish an action that is
 * blocked from one this release does not have, and that is the distinction an operator
 * opened the screen to make.
 */
export function evaluateServiceActions(
  facts: ServiceActionFacts,
): readonly ServiceActionAvailability[] {
  return SERVICE_OPERATOR_ACTIONS.map((action) => evaluate(action, facts));
}

/**
 * The operation types whose operability a caller has to ask the panel about.
 *
 * Derived from the same table the evaluator reads, so adding an action cannot leave its
 * panel question unasked — which would make it permanently `PANEL_NOT_OPERABLE` through
 * the fail-closed branch above, a safe failure and a confusing one.
 */
export const SERVICE_ACTION_OPERATION_TYPES: readonly OperationType[] = [
  ...new Set(
    SERVICE_OPERATOR_ACTIONS.map((action) => SERVICE_ACTION_OPERATION[action]).filter(
      (type): type is OperationType => type !== null,
    ),
  ),
];
