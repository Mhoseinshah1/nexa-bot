import { describe, expect, it } from 'vitest';
import { PANEL_CAPACITY_WARNING_PERCENT } from '@nexa/contracts';
import {
  CAPACITY_FULL_CODE,
  CAPACITY_RECOVERED_CODE,
  CAPACITY_WARNING_CODE,
  capacityAlertFor,
} from '../../apps/api/src/modules/platform/panels/application/panel-capacity-alerts';
import { capacityOf } from '../../apps/api/src/modules/platform/panels/application/panel-capacity';

/**
 * Which condition a panel's occupancy earns, and which row it closes.
 *
 * A pure decision, tested as one: every branch costs a line here and an order,
 * a product and a customer in an integration test. The monitor's half — that a
 * tick reads the real counts and the real open rows, records what this decides,
 * dedupes it and resolves it — is `panel-monitor.test.ts`; that the counts are
 * real is `panel-capacity.test.ts`.
 *
 * The third argument is what a panel already has OPEN, and it is why this is
 * a transition table rather than a threshold test. `recoversCode` closes one
 * code, three states need two closes, and the difference between those two
 * facts is an ERROR row standing for ever on a panel that has since drained.
 */
describe('a panel capacity condition', () => {
  const PANEL = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
  /** The occupancy, built by the same function the repository builds it with. */
  const at = (cap: number | null, services: number, reservations = 0) =>
    capacityOf(cap, services, reservations);
  /** Nothing open: a panel nobody has said anything about yet. */
  const QUIET: readonly string[] = [];

  describe('what the occupancy earns', () => {
    it('says nothing about an uncapped panel, whatever is on it', () => {
      /*
       * `null` is unlimited. There is no threshold to cross, so there is no
       * condition — and a recovery here would open a row whose own recovery
       * never comes, because nothing can ever say this panel came back under a
       * line it does not have.
       */
      expect(capacityAlertFor(PANEL, at(null, 0), QUIET)).toBeNull();
      expect(capacityAlertFor(PANEL, at(null, 10_000), QUIET)).toBeNull();
    });

    it('says nothing about a capped panel that is comfortably below the line', () => {
      /*
       * SILENCE is the steady state, and it is the difference between an
       * operations log an operator reads and one they scroll past: a tick that
       * recorded an INFO row for every healthy panel would produce a log whose
       * every page is panels that are fine, ten minutes apart, for ever.
       */
      expect(capacityAlertFor(PANEL, at(10, 1), QUIET)).toBeNull();
    });

    it('is FULL when every slot is taken, and says so as an ERROR', () => {
      // ERROR because the product is now refusing money: `decideEligibility`
      // answers AT_CAPACITY, the catalogue hides the plan and a confirmation is
      // refused — all correct, all invisible unless somebody is told.
      const alert = capacityAlertFor(PANEL, at(4, 4), QUIET);
      expect(alert?.code).toBe(CAPACITY_FULL_CODE);
      expect(alert?.severity).toBe('ERROR');
      expect(alert?.context).toMatchObject({ used: 4, maxServices: 4 });
    });

    it('is FULL when a cap was lowered below what is already on the panel', () => {
      /*
       * Lowering a cap below current usage is accepted and terminates nothing —
       * the owner's rule — so `used > cap` is a state this decision must handle
       * rather than one it can assume away. `available` is floored at zero by
       * `capacityOf`; the condition is decided from `used` against the cap.
       */
      expect(capacityAlertFor(PANEL, at(2, 9), QUIET)?.code).toBe(CAPACITY_FULL_CODE);
    });

    it('counts an unexpired HOLD toward full, not only a service', () => {
      // The whole point of the reservation design: between a confirmation and a
      // payment there is no service, and a count that ignored holds would call a
      // full panel roomy and sell the last slot twice.
      const alert = capacityAlertFor(PANEL, at(3, 1, 2), QUIET);
      expect(alert?.code).toBe(CAPACITY_FULL_CODE);
      expect(alert?.context).toMatchObject({ services: 1, reservations: 2, used: 3 });
    });

    it('WARNS at the threshold and not before it', () => {
      /*
       * The threshold is a percentage of the cap, rounded UP. At 80% a cap of 10
       * warns at 8 and says nothing at 7 — and the pair is asserted together,
       * because a test of only the warning side passes for a rule that warns
       * always.
       */
      expect(PANEL_CAPACITY_WARNING_PERCENT).toBe(80);
      expect(capacityAlertFor(PANEL, at(10, 8), QUIET)?.code).toBe(CAPACITY_WARNING_CODE);
      expect(capacityAlertFor(PANEL, at(10, 8), QUIET)?.severity).toBe('WARN');
      expect(capacityAlertFor(PANEL, at(10, 7), QUIET)).toBeNull();
    });

    it('never reports a cap of one as nearly full, because that panel is full', () => {
      // The rounding edge. `ceil(1 * 80 / 100)` is 1, which is also the cap — so
      // the full branch has to answer first, and this is what says it does.
      expect(capacityAlertFor(PANEL, at(1, 1), QUIET)?.code).toBe(CAPACITY_FULL_CODE);
      expect(capacityAlertFor(PANEL, at(1, 0), QUIET)).toBeNull();
    });
  });

  describe('which row it closes', () => {
    it('closes the warning a panel has just passed, when it fills', () => {
      // At most ONE capacity row open per panel: the condition being entered
      // closes the one being left. Leaving the warning open beside the full row
      // would show an operator two rows for one panel, and the drain that
      // follows can only close one of them.
      const alert = capacityAlertFor(PANEL, at(10, 10), [CAPACITY_WARNING_CODE]);
      expect(alert?.code).toBe(CAPACITY_FULL_CODE);
      expect(alert?.recoversCode).toBe(CAPACITY_WARNING_CODE);
      expect(alert?.recoversDedupeKey).toBe(`${CAPACITY_WARNING_CODE}:${PANEL}`);
    });

    it('closes the full row when the panel drops back into the warning band', () => {
      // The same rule in the other direction, which is the one a "the alert
      // only escalates" implementation gets wrong: the ERROR must stop being
      // open the moment it stops being true.
      const alert = capacityAlertFor(PANEL, at(10, 9), [CAPACITY_FULL_CODE]);
      expect(alert?.code).toBe(CAPACITY_WARNING_CODE);
      expect(alert?.recoversCode).toBe(CAPACITY_FULL_CODE);
    });

    it('closes the last recovery when a condition returns', () => {
      /*
       * Every recovery for a panel shares one dedupe key, and an open row is
       * only INCREMENTED rather than reopened — so a condition that did not
       * close the standing recovery would leave it there, and the next recovery
       * would collapse into it. A panel that filled, drained, filled and
       * drained again would announce the first recovery and then go quiet.
       */
      const alert = capacityAlertFor(PANEL, at(10, 8), [CAPACITY_RECOVERED_CODE]);
      expect(alert?.code).toBe(CAPACITY_WARNING_CODE);
      expect(alert?.recoversCode).toBe(CAPACITY_RECOVERED_CODE);
    });

    it('never points a repeat of a condition at its own code', () => {
      /*
       * A condition that is still true is a REPEAT: the recorder increments the
       * open row's counter. Naming its own code would then resolve the row it
       * had just reopened, and the panel would read as recovered while it was
       * still full — every ten minutes, for as long as it stayed full.
       */
      const alert = capacityAlertFor(PANEL, at(4, 4), [CAPACITY_FULL_CODE]);
      expect(alert?.code).toBe(CAPACITY_FULL_CODE);
      expect(alert?.recoversCode).toBeUndefined();
      expect(alert?.recoversDedupeKey).toBeUndefined();
    });

    it('recovers a drained panel, closing whichever condition it had', () => {
      // One recovery code for both conditions, because what a recovery must do
      // is close the OPEN row — and which one that is comes from the open set,
      // not from the recovery's own name.
      const fromFull = capacityAlertFor(PANEL, at(10, 1), [CAPACITY_FULL_CODE]);
      expect(fromFull?.code).toBe(CAPACITY_RECOVERED_CODE);
      expect(fromFull?.severity).toBe('INFO');
      expect(fromFull?.recoversCode).toBe(CAPACITY_FULL_CODE);

      const fromWarning = capacityAlertFor(PANEL, at(10, 1), [CAPACITY_WARNING_CODE]);
      expect(fromWarning?.code).toBe(CAPACITY_RECOVERED_CODE);
      expect(fromWarning?.recoversCode).toBe(CAPACITY_WARNING_CODE);
    });

    it('recovers a panel whose CAP was removed, rather than going quiet', () => {
      /*
       * Removing the cap is an operator's own remedy for a full panel, and it
       * is the one direction "uncapped means silence" gets wrong: the ERROR was
       * raised about a limit that no longer exists, and nothing else would ever
       * close it — an uncapped panel has no threshold to fall back under.
       */
      const alert = capacityAlertFor(PANEL, at(null, 40), [CAPACITY_FULL_CODE]);
      expect(alert?.code).toBe(CAPACITY_RECOVERED_CODE);
      expect(alert?.recoversCode).toBe(CAPACITY_FULL_CODE);
      expect(alert?.message).toContain('no longer capped');
    });

    it('does not record a recovery when there is nothing standing to close', () => {
      /*
       * The recovery is CONDITIONAL, and this is the assertion that says so. A
       * recovery recorded on every quiet tick would increment one INFO row for
       * ever — and, worse, would be open when the next real condition arrived,
       * which is the state the test above shows collapsing two events into one.
       */
      expect(capacityAlertFor(PANEL, at(10, 1), [CAPACITY_RECOVERED_CODE])).toBeNull();
      expect(capacityAlertFor(PANEL, at(null, 40), [CAPACITY_RECOVERED_CODE])).toBeNull();
      expect(capacityAlertFor(PANEL, at(10, 1), QUIET)).toBeNull();
    });
  });

  it('keys every row to ONE panel and condition', () => {
    // The format IS the identity: a recovery computed differently from the
    // condition it names resolves nothing, silently, and the operations view
    // keeps an open ERROR for a panel that is fine.
    const other = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';
    const mine = capacityAlertFor(PANEL, at(2, 2), [CAPACITY_WARNING_CODE]);
    const theirs = capacityAlertFor(other, at(2, 2), [CAPACITY_WARNING_CODE]);
    expect(mine?.dedupeKey).toBe(`${CAPACITY_FULL_CODE}:${PANEL}`);
    expect(theirs?.dedupeKey).not.toBe(mine?.dedupeKey);
    expect(mine?.recoversDedupeKey).toBe(`${CAPACITY_WARNING_CODE}:${PANEL}`);
  });

  it('carries no address, credential or provider text in its context', () => {
    // The context reaches the operations log and the alerts page. Four numbers
    // and a panel id is all a capacity condition knows and all it may carry.
    const alert = capacityAlertFor(PANEL, at(5, 5), QUIET);
    expect(Object.keys(alert?.context ?? {}).sort()).toEqual([
      'maxServices',
      'reservations',
      'services',
      'used',
    ]);
  });
});
