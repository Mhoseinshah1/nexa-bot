import { describe, expect, it } from 'vitest';
import {
  decidePlacement,
  type PlacementCandidate,
} from '../../apps/api/src/modules/platform/panels/application/panel-placement';

/**
 * Phase C3: the placement decision, as a pure function.
 *
 * Same members, same strategy, same answer — whatever order the members arrive in.
 * Every case names the rule that separated the winner, because that rule is the
 * explanation an operator is shown.
 */

const HOME = '01a00000-0000-7000-8000-00000000000a';
const B = '01a00000-0000-7000-8000-00000000000b';
const C = '01a00000-0000-7000-8000-00000000000c';

function member(panelId: string, overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    panelId,
    panelName: panelId.slice(-1),
    providerType: 'marzban',
    verdict: { eligible: true },
    healthy: true,
    used: 0,
    maxServices: 10,
    entitled: true,
    ...overrides,
  };
}

const decide = (
  members: PlacementCandidate[],
  strategy: 'LEAST_USED' | 'LOWEST_UTILISATION' = 'LEAST_USED',
) => decidePlacement({ homePanelId: HOME, homeProviderType: 'marzban', strategy, members });

describe('automatic panel placement', () => {
  it('prefers a healthy panel over an eligible but unhealthy one, whatever the load', () => {
    const decision = decide([
      member(HOME, { healthy: false, used: 0 }),
      member(B, { healthy: true, used: 9 }),
    ]);
    expect(decision.chosenPanelId).toBe(B);
    expect(decision.decidedBy).toBe('HEALTH');
  });

  it('never chooses a panel the evaluator refused, and says why it was left out', () => {
    const decision = decide([
      member(HOME, { used: 9 }),
      member(B, { used: 0, verdict: { eligible: false, reason: 'DRAINING' } }),
      member(C, { used: 0, verdict: { eligible: false, reason: 'UNHEALTHY' } }),
    ]);
    expect(decision.chosenPanelId).toBe(HOME);
    expect(decision.decidedBy).toBe('SOLE_CANDIDATE');
    expect(decision.candidates.filter((row) => row.excluded !== null)).toEqual([
      expect.objectContaining({ panelId: B, excluded: 'INELIGIBLE', ineligibleReason: 'DRAINING' }),
      expect.objectContaining({
        panelId: C,
        excluded: 'INELIGIBLE',
        ineligibleReason: 'UNHEALTHY',
      }),
    ]);
  });

  it('LEAST_USED: fewest occupied slots first', () => {
    const decision = decide([member(HOME, { used: 5 }), member(B, { used: 4 })]);
    expect(decision.chosenPanelId).toBe(B);
    expect(decision.decidedBy).toBe('LOAD');
  });

  it('LOWEST_UTILISATION: the smallest share of the cap, compared exactly', () => {
    // 5/10 = 0.5 against 9/20 = 0.45: B, though it has more services.
    const decision = decide(
      [member(HOME, { used: 5, maxServices: 10 }), member(B, { used: 9, maxServices: 20 })],
      'LOWEST_UTILISATION',
    );
    expect(decision.chosenPanelId).toBe(B);
    // 1/3 and 2/6 are EQUAL shares: no float may separate them, so the home wins.
    const equal = decide(
      [member(B, { used: 2, maxServices: 6 }), member(HOME, { used: 1, maxServices: 3 })],
      'LOWEST_UTILISATION',
    );
    expect(equal.chosenPanelId).toBe(HOME);
    expect(equal.decidedBy).toBe('HOME_PREFERENCE');
  });

  it('LOWEST_UTILISATION ranks an uncapped panel after every capped one', () => {
    const decision = decide(
      [member(HOME, { used: 0, maxServices: null }), member(B, { used: 9, maxServices: 10 })],
      'LOWEST_UTILISATION',
    );
    expect(decision.chosenPanelId).toBe(B);
  });

  it('equal candidates: the home first, then the lowest id', () => {
    const withHome = decide([member(C), member(B), member(HOME)]);
    expect(withHome.chosenPanelId).toBe(HOME);
    expect(withHome.decidedBy).toBe('HOME_PREFERENCE');
    // Home not eligible: B and C equal, B has the lower id.
    const withoutHome = decide([
      member(C),
      member(B),
      member(HOME, { verdict: { eligible: false, reason: 'AT_CAPACITY' } }),
    ]);
    expect(withoutHome.chosenPanelId).toBe(B);
    expect(withoutHome.decidedBy).toBe('PANEL_ID');
  });

  it('is deterministic: the same members in any order give the same decision', () => {
    const members = [
      member(HOME, { used: 3 }),
      member(B, { used: 3 }),
      member(C, { used: 2, healthy: false }),
    ];
    const first = decide(members);
    for (const order of [
      [members[2]!, members[0]!, members[1]!],
      [members[1]!, members[2]!, members[0]!],
    ]) {
      expect(decide(order)).toEqual(first);
    }
  });

  it('with nothing eligible, keeps the home and says so — never a silent placement', () => {
    const decision = decide([
      member(HOME, { verdict: { eligible: false, reason: 'AT_CAPACITY' } }),
      member(B, { verdict: { eligible: false, reason: 'DRAINING' } }),
    ]);
    expect(decision.chosenPanelId).toBe(HOME);
    expect(decision.decidedBy).toBe('NO_ELIGIBLE_CANDIDATE');
    expect(decision.candidates.every((row) => row.rank === null)).toBe(true);
  });

  it('excludes another provider and a panel the customer is not entitled to', () => {
    const decision = decide([
      member(HOME, { used: 9 }),
      member(B, { used: 0, providerType: 'sanaei' }),
      member(C, { used: 0, entitled: false }),
    ]);
    expect(decision.chosenPanelId).toBe(HOME);
    expect(
      decision.candidates.map((row) => [row.panelId, row.excluded]).filter(([, e]) => e !== null),
    ).toEqual([
      [B, 'PROVIDER_MISMATCH'],
      [C, 'NOT_ENTITLED'],
    ]);
  });

  it('ranks every eligible member and marks the home', () => {
    const decision = decide([member(HOME, { used: 2 }), member(B, { used: 1 })]);
    expect(decision.candidates.map((row) => [row.panelId, row.rank, row.home])).toEqual([
      [B, 1, false],
      [HOME, 2, true],
    ]);
  });
});
