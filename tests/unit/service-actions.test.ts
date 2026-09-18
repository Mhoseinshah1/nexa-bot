import { describe, expect, it } from 'vitest';
import {
  SERVICE_ACTION_BLOCKERS,
  SERVICE_OPERATOR_ACTIONS,
  SERVICE_STATES,
  type OperationType,
  type ServiceActionBlocker,
  type ServiceOperatorAction,
  type ServiceState,
} from '@nexa/contracts';
import {
  evaluateServiceActions,
  RESEND_LEGAL_FROM,
  SERVICE_ACTION_OPERATION,
  SERVICE_ACTION_OPERATION_TYPES,
  type ServiceActionFacts,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-actions.js';
import { OPERATION_LEGAL_FROM } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor.js';
import { ProvisioningService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioning.service.js';
import type {
  PanelOperability,
  PanelOperabilityRefusal,
  ServiceRecord,
} from '../../apps/api/src/modules/commerce/provisioning/application/ports.js';

/**
 * The action matrix, exhausted.
 *
 * This is the file that makes `service-actions.ts` worth extracting. The evaluator is
 * pure, so every state × every blocker can be asserted here in milliseconds — and the
 * failure it exists to prevent is not a crash but a LIE: a surface that offers an
 * action the write path then refuses, or names a reason that sends the operator to the
 * wrong screen.
 *
 * Two agreements are asserted rather than assumed, because both are copies:
 * `RESEND_LEGAL_FROM` against `ProvisioningService.isDeliverable`, and every mapped
 * action's legal states against `OPERATION_LEGAL_FROM`. A copy that drifts is exactly
 * how a button outlives the rule it was drawn from.
 */

type Operability = Readonly<Partial<Record<OperationType, PanelOperability>>>;

/** A panel that can do everything asked of it. Each case turns on the one it is about. */
const YES: PanelOperability = {
  ok: true,
  providerType: 'marzban',
  baseUrl: 'https://panel.example.test',
  activation: {
    proxyProtocols: ['vless'],
    inboundTags: { vless: ['VLESS TCP REALITY'] },
  },
};

const operable = (): Operability =>
  Object.fromEntries(SERVICE_ACTION_OPERATION_TYPES.map((type) => [type, YES]));

/** One type refused, the rest fine. */
const refusing = (type: OperationType, reason: PanelOperabilityRefusal): Operability => ({
  ...operable(),
  [type]: { ok: false, reason },
});

const factsFor = (
  state: ServiceState,
  over: Partial<ServiceActionFacts> = {},
): ServiceActionFacts => ({
  state,
  hasConfiguration: true,
  contact: 'PRESENT',
  openOperations: [],
  operability: operable(),
  ...over,
});

const verdict = (
  state: ServiceState,
  action: ServiceOperatorAction,
  over: Partial<ServiceActionFacts> = {},
): { available: boolean; blocker: ServiceActionBlocker | null } => {
  const found = evaluateServiceActions(factsFor(state, over)).find(
    (entry) => entry.action === action,
  );
  if (found === undefined) throw new Error(`${action} was not evaluated`);
  return { available: found.available, blocker: found.blocker };
};

describe('service action availability', () => {
  it('answers every action, in the contract order, on every state', () => {
    /*
     * The FULL list, always, for the reason the contract's docblock gives: a surface
     * handed only what it may do cannot tell a blocked action from one this release
     * does not have, and that is the distinction an operator opened the screen for.
     */
    for (const state of SERVICE_STATES) {
      const answers = evaluateServiceActions(factsFor(state));
      expect(
        answers.map((entry) => entry.action),
        state,
      ).toEqual([...SERVICE_OPERATOR_ACTIONS]);
    }
  });

  it('never reports a blocker beside an available action, nor an available action without one', () => {
    /* `blocker` is null EXACTLY when `available` is true — the contract says so. */
    for (const state of SERVICE_STATES) {
      for (const openOperations of [[], [...SERVICE_ACTION_OPERATION_TYPES]] as OperationType[][]) {
        for (const hasConfiguration of [true, false]) {
          for (const contact of ['PRESENT', 'ABSENT'] as const) {
            for (const entry of evaluateServiceActions(
              factsFor(state, { openOperations, hasConfiguration, contact }),
            )) {
              expect(
                entry.blocker === null,
                `${state}/${entry.action} available=${entry.available} blocker=${String(entry.blocker)}`,
              ).toBe(entry.available);
              if (entry.blocker !== null) {
                expect(SERVICE_ACTION_BLOCKERS).toContain(entry.blocker);
              }
            }
          }
        }
      }
    }
  });

  it('agrees with OPERATION_LEGAL_FROM about which states each mapped action is legal from', () => {
    /*
     * The evaluator reads that table rather than a second copy of it, and this is what
     * proves it: for each of the six actions that plan an operation, an operable panel
     * with nothing open must produce exactly the executor's own legal set.
     */
    for (const action of SERVICE_OPERATOR_ACTIONS) {
      const type = SERVICE_ACTION_OPERATION[action];
      if (type === null) continue;
      const allowed = SERVICE_STATES.filter((state) => verdict(state, action).available);
      expect([...allowed].sort(), action).toEqual([...OPERATION_LEGAL_FROM[type]].sort());
    }
  });

  it('keeps RESEND_LEGAL_FROM identical to what ProvisioningService will actually deliver', () => {
    /*
     * `RESEND_LEGAL_FROM` is a copy, written here so this file need not hold the
     * service class. A copy with no test is a copy that drifts, and the drift is
     * invisible: the screen offers a resend and `DeliveryService` refuses it.
     *
     * Asserted through the real static, per state, with a configuration present — the
     * `subscriptionUrl !== null` half is the `NO_CONFIGURATION` blocker below.
     */
    for (const state of SERVICE_STATES) {
      const deliverable = ProvisioningService.isDeliverable({
        state,
        subscriptionUrl: 'https://sub.example.test/abc',
      } as ServiceRecord);
      expect(RESEND_LEGAL_FROM.includes(state), state).toBe(deliverable);
      expect(verdict(state, 'RESEND_CONFIG').available, state).toBe(deliverable);
    }
  });

  it('reports STATE before any question about the panel', () => {
    /*
     * The ordering is the rule. A TERMINATED service whose panel also cannot disable
     * users must be refused for being terminated: telling an operator to go and fix a
     * capability for a service that can never be suspended again sends them to the
     * wrong screen, and they will fix the panel and come back.
     */
    expect(verdict('TERMINATED', 'SUSPEND', { operability: {} })).toEqual({
      available: false,
      blocker: 'STATE',
    });
  });

  it('refuses an operation type whose panel verdict was never asked for', () => {
    /*
     * Fail CLOSED. A caller that forgot to ask the panel about a type must not thereby
     * offer it — the opposite default would make a gathering bug into an offered
     * action, and the action behind that button deletes accounts.
     */
    expect(verdict('ACTIVE', 'SUSPEND', { operability: {} })).toEqual({
      available: false,
      blocker: 'PANEL_NOT_OPERABLE',
    });
  });

  it('separates a capability the provider does not have from a panel that needs fixing', () => {
    /*
     * The one distinction an operator can act on. 3X-UI has no `DISABLE_USER`, so
     * suspend is not a misconfiguration — no amount of editing the panel row will
     * produce it — while the other five refusals are all "go and fix this panel", and
     * the panel screen already says which.
     */
    expect(
      verdict('ACTIVE', 'SUSPEND', {
        operability: refusing('SUSPEND', 'CAPABILITY_UNSUPPORTED'),
      }),
    ).toEqual({ available: false, blocker: 'CAPABILITY' });

    for (const reason of [
      'PANEL_DISABLED',
      'PANEL_ABSENT',
      'PROVIDER_NOT_OPERABLE',
      'CREDENTIALS_MISSING',
      'ACTIVATION_INCOMPLETE',
    ] satisfies PanelOperabilityRefusal[]) {
      expect(
        verdict('ACTIVE', 'SUSPEND', { operability: refusing('SUSPEND', reason) }),
        reason,
      ).toEqual({ available: false, blocker: 'PANEL_NOT_OPERABLE' });
    }
  });

  it('reports IN_PROGRESS only for the type that is open, and only when nothing else refuses', () => {
    /*
     * Last of the three, because it is the only transient one: reporting "wait" over a
     * real blocker promises that waiting helps. And per TYPE — an open `SYNC_USAGE`
     * says nothing about whether a service can be suspended.
     */
    expect(verdict('ACTIVE', 'SYNC_USAGE', { openOperations: ['SYNC_USAGE'] })).toEqual({
      available: false,
      blocker: 'IN_PROGRESS',
    });
    expect(verdict('ACTIVE', 'SUSPEND', { openOperations: ['SYNC_USAGE'] })).toEqual({
      available: true,
      blocker: null,
    });
    /* A panel that cannot do it at all is reported as such, open operation or not. */
    expect(
      verdict('ACTIVE', 'SUSPEND', {
        openOperations: ['SUSPEND'],
        operability: refusing('SUSPEND', 'PANEL_DISABLED'),
      }),
    ).toEqual({ available: false, blocker: 'PANEL_NOT_OPERABLE' });
  });

  it('gives delivery its own two refusals, nothing to send before nobody to send it to', () => {
    /*
     * `DeliveryService`'s own order. Both are real: a service whose create succeeded
     * but whose subscription is absent has nothing to send, and a BLOCKED customer is
     * an operator's own instruction not to message them — a resend that ignored it
     * would be this surface undoing a decision made on another screen.
     */
    expect(verdict('ACTIVE', 'RESEND_CONFIG', { hasConfiguration: false })).toEqual({
      available: false,
      blocker: 'NO_CONFIGURATION',
    });
    expect(verdict('ACTIVE', 'RESEND_CONFIG', { contact: 'ABSENT' })).toEqual({
      available: false,
      blocker: 'NO_CONTACT',
    });
    expect(
      verdict('ACTIVE', 'RESEND_CONFIG', { hasConfiguration: false, contact: 'ABSENT' }),
    ).toEqual({ available: false, blocker: 'NO_CONFIGURATION' });
  });

  it('never asks a panel about a resend, and never asks delivery about an operation', () => {
    /*
     * The two axes stay apart. A resend touches no provider, so a wholly inoperable
     * panel must not block it; an operation sends no message, so a missing contact must
     * not block that.
     */
    expect(verdict('ACTIVE', 'RESEND_CONFIG', { operability: {} })).toEqual({
      available: true,
      blocker: null,
    });
    expect(verdict('ACTIVE', 'SUSPEND', { hasConfiguration: false, contact: 'ABSENT' })).toEqual({
      available: true,
      blocker: null,
    });
  });

  it('asks the panel about every type an action can plan, and about nothing else', () => {
    /*
     * `SERVICE_ACTION_OPERATION_TYPES` is what `ServiceAdminService.detail` gathers. It
     * is DERIVED from the action table so a new action cannot leave its panel question
     * unasked — which would make it permanently `PANEL_NOT_OPERABLE` through the
     * fail-closed branch, a safe failure and a baffling one.
     */
    const planned = SERVICE_OPERATOR_ACTIONS.map(
      (action) => SERVICE_ACTION_OPERATION[action],
    ).filter((type): type is OperationType => type !== null);
    expect([...SERVICE_ACTION_OPERATION_TYPES].sort()).toEqual([...new Set(planned)].sort());
    expect(SERVICE_ACTION_OPERATION_TYPES).not.toContain('RENEW');
  });

  it('offers a PENDING_PROVISION service its retry and its terminate and nothing else', () => {
    /*
     * The shape of the screen an operator actually arrives at: a paid order whose
     * create has not happened. Asserted as the whole matrix rather than action by
     * action, because the defect being guarded is an EXTRA button, and a per-action
     * assertion cannot see one.
     */
    expect(
      evaluateServiceActions(factsFor('PENDING_PROVISION', { hasConfiguration: false })),
    ).toEqual([
      { action: 'SYNC_USAGE', available: false, blocker: 'STATE' },
      { action: 'RESEND_CONFIG', available: false, blocker: 'STATE' },
      { action: 'RETRY_PROVISION', available: true, blocker: null },
      { action: 'RECONCILE', available: false, blocker: 'STATE' },
      { action: 'SUSPEND', available: false, blocker: 'STATE' },
      { action: 'RESUME', available: false, blocker: 'STATE' },
      { action: 'TERMINATE', available: true, blocker: null },
    ]);
  });

  it('offers a TERMINATED service nothing at all', () => {
    /* Terminal means terminal. Seven refusals, every one of them `STATE`. */
    const answers = evaluateServiceActions(factsFor('TERMINATED'));
    expect(answers.filter((entry) => entry.available)).toEqual([]);
    expect(new Set(answers.map((entry) => entry.blocker))).toEqual(new Set(['STATE']));
  });

  it('offers an UNRECONCILED service its reconcile and its terminate, and no second create', () => {
    /*
     * The rule 4D bought with a stranded service: a lost create is RECONCILED, never
     * provisioned again. `RETRY_PROVISION` is refused here by `OPERATION_LEGAL_FROM`,
     * and `retryProvisioning` refuses it again with `RECONCILE_FIRST`.
     */
    const available = evaluateServiceActions(factsFor('UNRECONCILED'))
      .filter((entry) => entry.available)
      .map((entry) => entry.action);
    expect(available).toEqual(['RECONCILE', 'TERMINATE']);
  });
});
