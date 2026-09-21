import { describe, expect, it } from 'vitest';
import {
  ProvisionerService,
  refusalIsPermanent,
  RETRYABLE_REFUSALS,
} from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import {
  backoffMs,
  type ExecutionRefusal,
} from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';
import { OPERATION_MAX_ATTEMPTS } from '@nexa/contracts';

/**
 * Which refusals are answered at once, and which are waited out.
 *
 * The seven-minute half of order `01a0c54b`. The panel had no activation, which
 * is a fact about a row in our own database that no amount of waiting changes —
 * and the provisioner backed off and re-read it four more times before giving
 * the customer their money back.
 *
 * Asserted as a PARTITION rather than as a list of cases, so a refusal added in
 * a later release has to be classified deliberately: an unlisted one fails the
 * exhaustiveness case below rather than silently inheriting five attempts.
 */

/** Every member of the union, written out. The exhaustiveness check below is what keeps it honest. */
const ALL_REFUSALS: readonly ExecutionRefusal[] = [
  'PANEL_DISABLED',
  'PANEL_ABSENT',
  'PROVIDER_NOT_OPERABLE',
  'CAPABILITY_UNSUPPORTED',
  'CREDENTIALS_MISSING',
  'ACTIVATION_INCOMPLETE',
  'PANEL_NOT_REACHABLE',
  'BUDGET_EXHAUSTED',
  'TENANT_STOPPED',
  'SERVICE_ABSENT',
  'LEASE_LOST',
];

describe('how a refusal is classified', () => {
  it('answers ACTIVATION_INCOMPLETE at once instead of over seven minutes', () => {
    /*
     * THE REGRESSION, named. Nothing was contacted: `decideOperability` read the
     * panel row, found no activation, and returned. The next attempt reads the
     * same row.
     *
     * The arithmetic that made this worth fixing is below — five attempts on
     * this backoff curve is 450 seconds, which is the "roughly seven minutes"
     * the production report measured.
     */
    expect(refusalIsPermanent('ACTIVATION_INCOMPLETE')).toBe(true);

    const spent = [1, 2, 3, 4]
      .map((attempt) => backoffMs(attempt))
      .reduce((total, wait) => total + wait, 0);
    expect(OPERATION_MAX_ATTEMPTS).toBe(5);
    expect(spent).toBe(450_000);
  });

  it('answers every operator-configuration refusal at once', () => {
    /*
     * All four, and `PANEL_DISABLED` is the one worth stating. "They might
     * re-enable it" is the tempting objection and it is the system
     * second-guessing an instruction somebody gave: refunding now and telling
     * them a paid order hit a disabled panel reaches them while they are still
     * at the keyboard.
     */
    for (const reason of [
      'ACTIVATION_INCOMPLETE',
      'CREDENTIALS_MISSING',
      'PANEL_DISABLED',
      'PANEL_ABSENT',
    ] as const) {
      expect(refusalIsPermanent(reason), reason).toBe(true);
    }
  });

  it('answers the two that are statements about code at once', () => {
    for (const reason of ['PROVIDER_NOT_OPERABLE', 'CAPABILITY_UNSUPPORTED'] as const) {
      expect(refusalIsPermanent(reason), reason).toBe(true);
    }
  });

  it('still waits out the five that can genuinely change on their own', () => {
    /*
     * `PANEL_NOT_REACHABLE` is the URL policy refusing an address, which a DNS
     * change flips. The other four are about US rather than the panel —
     * `holdOff` refunds their attempt so they do not even count against the
     * ceiling — or terminalise by their own path.
     */
    for (const reason of RETRYABLE_REFUSALS) {
      expect(refusalIsPermanent(reason), reason).toBe(false);
    }
  });

  it('classifies every refusal, into exactly one of the two groups', () => {
    /*
     * The case that makes this file a rule rather than eleven examples. A
     * refusal added later and forgotten would not appear in `RETRYABLE_REFUSALS`
     * and would default to `false` in `refusalIsPermanent` — five attempts, and
     * nobody deciding that. This fails instead.
     *
     * The `ALL_REFUSALS` list is checked against the union by the compiler: a
     * member added to `ExecutionRefusal` and not to this array makes the
     * `satisfies` below fail to typecheck.
     */
    const deterministic = ALL_REFUSALS.filter((reason) => refusalIsPermanent(reason));
    const retryable = ALL_REFUSALS.filter((reason) => !refusalIsPermanent(reason));

    expect(deterministic).toHaveLength(6);
    expect([...retryable].sort()).toEqual([...RETRYABLE_REFUSALS].sort());
    expect(deterministic.length + retryable.length).toBe(ALL_REFUSALS.length);
  });
});

/**
 * A compile-time proof that `ALL_REFUSALS` is the whole union.
 *
 * `Exclude` of every listed member leaves `never` only when nothing is missing,
 * so adding a refusal to `ExecutionRefusal` without adding it here is a type
 * error in this file rather than a silent five-attempt default in production.
 */
type Unlisted = Exclude<ExecutionRefusal, (typeof ALL_REFUSALS)[number]>;
const _exhaustive: Unlisted extends never ? true : never = true;
void _exhaustive;

/**
 * What the per-operation log line claims about the row, and who decides it.
 *
 * Requirement 9 of the hotfix added a `terminal` field to the provisioner's
 * one-line-per-operation record, computed as
 * `refusalIsPermanent(reason) || exhausted(attempts)`. Codex C3 on PR #58 showed
 * a computed answer is wrong in both directions, because the classification of a
 * REASON and the fate of a ROW are different facts:
 *
 *   - `SERVICE_ABSENT` is retryable-classified and both of its paths transition
 *     the row to `ABANDONED` first, so the line said "will retry" about a row
 *     that never can. Proven end to end in
 *     `tests/integration/provisioning.test.ts` › "reports an abandoned operation
 *     as terminal".
 *   - `holdOff` sets `attempts = GREATEST(attempts - 1, 0)`, and the count was
 *     read before that, so a hold-off at the ceiling said "terminal" about a row
 *     the next tick will pick up.
 *
 * This pins the three shapes the service now chooses between. It is a contract
 * test on the helpers, not on the wiring: which shape each call site uses is a
 * separate question, and only the `ABANDONED` one is reachable end to end — see
 * the note in `docs/hotfix-activation-falsification.md`.
 */
describe('the three shapes a refusal can be reported as', () => {
  /** Only the four fields these helpers read. */
  const operation = {
    id: 'operation-1',
    serviceId: 'service-1',
    orderId: 'order-1',
    panelId: 'panel-1',
    attempts: 1,
  };

  type Shapes = {
    refused(op: typeof operation, reason: ExecutionRefusal): { readonly terminal: boolean };
    refusedAbandoned(
      op: typeof operation,
      reason: ExecutionRefusal,
    ): { readonly terminal: boolean };
    refusedAndHeld(op: typeof operation, reason: ExecutionRefusal): { readonly terminal: boolean };
  };

  /* The helpers are private to the service and carry no state, so they are read
   * off the prototype rather than through an instance nothing here could build. */
  const shapes = ProvisionerService.prototype as unknown as Shapes;

  it('a row transitioned to ABANDONED is terminal however its reason is classified', () => {
    expect(refusalIsPermanent('SERVICE_ABSENT')).toBe(false);
    expect(shapes.refusedAbandoned.call(shapes, operation, 'SERVICE_ABSENT').terminal).toBe(true);
  });

  it('a row whose attempt was given back is never terminal, at any attempt count', () => {
    for (let attempts = 0; attempts <= OPERATION_MAX_ATTEMPTS + 1; attempts += 1) {
      const result = shapes.refusedAndHeld.call(
        shapes,
        { ...operation, attempts },
        'TENANT_STOPPED',
      );
      expect(result.terminal).toBe(false);
    }
  });

  it('the ordinary accounted refusal still answers from the classification', () => {
    expect(shapes.refused.call(shapes, operation, 'ACTIVATION_INCOMPLETE').terminal).toBe(true);
    expect(shapes.refused.call(shapes, operation, 'PANEL_NOT_REACHABLE').terminal).toBe(false);
    const atCeiling = { ...operation, attempts: OPERATION_MAX_ATTEMPTS };
    expect(shapes.refused.call(shapes, atCeiling, 'PANEL_NOT_REACHABLE').terminal).toBe(true);
  });
});
