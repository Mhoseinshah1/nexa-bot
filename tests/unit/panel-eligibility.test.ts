import { describe, expect, it } from 'vitest';
import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PANEL_HEALTH_STATES,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  type PanelHealthState,
} from '@nexa/contracts';
import {
  connectionIdentityOf,
  decideEligibility,
  isConfirmedUnusable,
  validationAuthorisesEnable,
  type EligibilityInput,
} from '../../apps/api/src/modules/platform/panels/application/panel-eligibility';

/**
 * Whether a panel may be SOLD onto, and whether it may be ENABLED.
 *
 * Both are pure decisions over facts the caller assembles, so they are asserted
 * here rather than against a database: what a row looks like is
 * `panels-capacity.test.ts`'s question, and what the rule CONCLUDES from one is
 * this file's.
 *
 * The cases are arranged around the two ways this rule can be wrong, because
 * they cost different things. Too strict empties a working shop — a blip, a
 * stopped monitor, a fresh install nobody has probed — and the installation
 * sells nothing while every panel is fine. Too lax takes a customer's money for
 * a service that cannot be created. Most of what follows is the first kind,
 * because it is the kind a test is needed to notice.
 */

const NOW = new Date('2026-09-18T12:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - PANEL_HEALTH_FRESH_FOR_MS - 1);

const base: EligibilityInput = {
  status: 'ACTIVE',
  health: null,
  maxServices: null,
  used: 0,
  now: NOW,
};

const withHealth = (
  state: PanelHealthState,
  unusableStreak: number,
  checkedAt: Date = FRESH,
): EligibilityInput => ({ ...base, health: { state, checkedAt, unusableStreak } });

describe('whether a panel may be sold onto', () => {
  // -------------------------------------------------------------------------
  // Status: somebody's decision, and it always wins
  // -------------------------------------------------------------------------

  it('refuses an archived panel, whatever else is true of it', () => {
    /*
     * Archived is finished, and the name has been released. A product still
     * pointing at one is a configuration an operator has to fix, and selling it
     * would take money for a panel this installation has stopped addressing.
     */
    const decision = decideEligibility({ ...base, status: 'ARCHIVED' });
    expect(decision).toEqual({ eligible: false, reason: 'ARCHIVED' });
  });

  it('refuses a disabled panel even when it is healthy and empty', () => {
    /*
     * The case that makes this a DECISION rather than a measurement. A disabled
     * panel may be answering every probe perfectly — an operator disabled it to
     * drain it, or to do maintenance nobody has started yet — and selling onto
     * it anyway would override the instruction they gave.
     */
    const decision = decideEligibility({
      ...withHealth('HEALTHY', 0),
      status: 'DISABLED',
      maxServices: 100,
      used: 0,
    });
    expect(decision).toEqual({ eligible: false, reason: 'DISABLED' });
  });

  it("reports the operator's decision rather than a measurement taken about it", () => {
    /*
     * A disabled panel that is ALSO full and ALSO unreachable. Reporting
     * `AT_CAPACITY` would send an operator to raise a number that would change
     * nothing, and `UNHEALTHY` would send them to fix a panel they had
     * deliberately switched off. The order in `decideEligibility` is what makes
     * the answer the one they can act on.
     */
    const decision = decideEligibility({
      ...withHealth('UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES),
      status: 'DISABLED',
      maxServices: 1,
      used: 5,
    });
    expect(decision).toEqual({ eligible: false, reason: 'DISABLED' });
  });

  // -------------------------------------------------------------------------
  // Health: the hysteresis, and everything it must NOT react to
  // -------------------------------------------------------------------------

  it('keeps selling through failures below the threshold', () => {
    /*
     * The rule that stops every blip becoming an outage of the shop. A restart
     * or a moment of packet loss is one or two failed probes, and the panel
     * that produced them will very likely serve the next customer.
     */
    for (let streak = 0; streak < PANEL_UNHEALTHY_AFTER_FAILURES; streak += 1) {
      expect(decideEligibility(withHealth('UNREACHABLE', streak)), `streak ${streak}`).toEqual({
        eligible: true,
      });
    }
  });

  it('stops selling at the threshold, and stays stopped above it', () => {
    for (const streak of [PANEL_UNHEALTHY_AFTER_FAILURES, PANEL_UNHEALTHY_AFTER_FAILURES + 9]) {
      expect(decideEligibility(withHealth('UNREACHABLE', streak)), `streak ${streak}`).toEqual({
        eligible: false,
        reason: 'UNHEALTHY',
      });
    }
  });

  it('refuses on either unusable state, and on neither usable one', () => {
    /*
     * `DEGRADED` is the row this case exists for. That state means the
     * credentials were accepted and the panel answered — only the follow-up
     * diagnostic read failed — so the next create will very likely work.
     * Treating it as unusable would decline business over a reading we could
     * not take, which is the opposite of the failure this rule prevents.
     */
    const verdicts = Object.fromEntries(
      PANEL_HEALTH_STATES.map((state) => [
        state,
        decideEligibility(withHealth(state, PANEL_UNHEALTHY_AFTER_FAILURES)).eligible,
      ]),
    );
    expect(verdicts).toEqual({
      HEALTHY: true,
      DEGRADED: true,
      UNREACHABLE: false,
      AUTH_FAILED: false,
    });
  });

  it('keeps selling when nobody has ever probed the panel', () => {
    /*
     * `UNCHECKED` is the absence of evidence, not evidence of absence. A fresh
     * installation whose monitor has not run yet must be able to sell;
     * otherwise the shop opens empty and stays that way until a background
     * process nobody has heard of has succeeded once.
     */
    expect(decideEligibility({ ...base, health: null })).toEqual({ eligible: true });
  });

  it('keeps selling when the failing evidence is too old to believe', () => {
    /*
     * The rule that stops a stopped monitor closing every shop in the
     * installation, and it is not hypothetical: only a probe can overwrite a
     * health row, so a monitor that is down leaves the last row frozen. Without
     * the freshness bound a panel that failed three times before an outage of
     * OUR OWN machinery would never sell again, however healthy it had become.
     */
    expect(
      decideEligibility(withHealth('UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES, STALE)),
    ).toEqual({ eligible: true });
  });

  it('becomes eligible again on one fresh probe that is not unusable', () => {
    /*
     * Recovery is the negation of the refusal and has no separate rule: a probe
     * that concludes anything but `UNREACHABLE` or `AUTH_FAILED` resets the
     * streak, and a zero streak is below the threshold. Asserted so that a
     * future release cannot add a second, slower path back to selling.
     */
    const down = withHealth('UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);
    expect(decideEligibility(down).eligible).toBe(false);
    expect(
      decideEligibility({
        ...down,
        health: { ...down.health!, state: 'HEALTHY', unusableStreak: 0 },
      }),
    ).toEqual({
      eligible: true,
    });
  });

  it('measures freshness inclusively at the boundary', () => {
    const exactly = new Date(NOW.getTime() - PANEL_HEALTH_FRESH_FOR_MS);
    const health = { state: 'UNREACHABLE' as const, checkedAt: exactly, unusableStreak: 3 };
    expect(isConfirmedUnusable(health, NOW), 'exactly at the bound is still believed').toBe(true);
    expect(
      isConfirmedUnusable({ ...health, checkedAt: new Date(exactly.getTime() - 1) }, NOW),
      'one millisecond past it is not',
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Capacity
  // -------------------------------------------------------------------------

  it('treats a null cap as unlimited', () => {
    expect(decideEligibility({ ...base, maxServices: null, used: 10_000 })).toEqual({
      eligible: true,
    });
  });

  it('sells the last slot and refuses the one after it', () => {
    expect(decideEligibility({ ...base, maxServices: 3, used: 2 })).toEqual({ eligible: true });
    expect(decideEligibility({ ...base, maxServices: 3, used: 3 })).toEqual({
      eligible: false,
      reason: 'AT_CAPACITY',
    });
  });

  it('refuses new business when the cap was lowered below current usage', () => {
    /*
     * A cap lowered under what a panel already carries. The verdict is
     * `AT_CAPACITY` — new sales stop — and NOTHING here terminates anything: a
     * limit that could delete a customer's service because somebody mistyped a
     * number is an outage with a form field. Usage falling back under the cap
     * is what reopens it, and `panels-capacity.test.ts` proves the services
     * themselves are untouched.
     */
    expect(decideEligibility({ ...base, maxServices: 2, used: 9 })).toEqual({
      eligible: false,
      reason: 'AT_CAPACITY',
    });
  });

  it('reports health before capacity, because one of them is a business decision', () => {
    /*
     * A panel that is both full and confirmed down. "At capacity" reads as
     * something an operator fixes by raising a number, and raising it here
     * would produce a second refusal from a panel that cannot be reached.
     */
    expect(
      decideEligibility({
        ...withHealth('AUTH_FAILED', PANEL_UNHEALTHY_AFTER_FAILURES),
        maxServices: 1,
        used: 5,
      }),
    ).toEqual({ eligible: false, reason: 'UNHEALTHY' });
  });
});

describe('whether a stored validation may enable a panel', () => {
  const IDENTITY = connectionIdentityOf({
    providerType: 'marzban',
    baseUrl: 'https://panel.example.test',
    activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
    usernameSetAt: new Date('2026-09-18T10:00:00.000Z'),
    passwordSetAt: new Date('2026-09-18T10:00:00.000Z'),
    apiTokenSetAt: null,
  });

  const validation = (
    over: Partial<Parameters<typeof validationAuthorisesEnable>[0] & object> = {},
  ) => ({
    state: 'HEALTHY' as PanelHealthState,
    checkedAt: FRESH,
    validatedIdentity: IDENTITY,
    ...over,
  });

  it('authorises on a fresh usable probe against the current identity', () => {
    expect(validationAuthorisesEnable(validation(), IDENTITY, NOW)).toBe(true);
  });

  it('authorises on DEGRADED, because the credentials were accepted', () => {
    /*
     * What enabling needs to know is that this address and these credentials
     * reach that panel. A degraded probe establishes exactly that and fails
     * only on the diagnostic read afterwards.
     */
    expect(validationAuthorisesEnable(validation({ state: 'DEGRADED' }), IDENTITY, NOW)).toBe(true);
  });

  it('refuses on either unusable conclusion', () => {
    for (const state of ['UNREACHABLE', 'AUTH_FAILED'] as PanelHealthState[]) {
      expect(validationAuthorisesEnable(validation({ state }), IDENTITY, NOW), state).toBe(false);
    }
  });

  it('refuses a panel nobody has ever tested', () => {
    expect(validationAuthorisesEnable(null, IDENTITY, NOW)).toBe(false);
  });

  it('refuses a validation taken before the credentials were replaced', () => {
    /*
     * The case the whole mechanism exists for. An operator tests, the test goes
     * green, they then fix a password — and the green test must stop counting,
     * because it was taken against a configuration that no longer exists.
     */
    const afterPasswordChange = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      usernameSetAt: new Date('2026-09-18T10:00:00.000Z'),
      passwordSetAt: new Date('2026-09-18T11:30:00.000Z'),
      apiTokenSetAt: null,
    });
    expect(afterPasswordChange).not.toBe(IDENTITY);
    expect(validationAuthorisesEnable(validation(), afterPasswordChange, NOW)).toBe(false);
  });

  it('refuses a validation taken against a different address or inbound', () => {
    const elsewhere = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://other.example.test',
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      usernameSetAt: new Date('2026-09-18T10:00:00.000Z'),
      passwordSetAt: new Date('2026-09-18T10:00:00.000Z'),
      apiTokenSetAt: null,
    });
    const otherInbound = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS WS'] } },
      usernameSetAt: new Date('2026-09-18T10:00:00.000Z'),
      passwordSetAt: new Date('2026-09-18T10:00:00.000Z'),
      apiTokenSetAt: null,
    });
    expect(validationAuthorisesEnable(validation(), elsewhere, NOW)).toBe(false);
    expect(validationAuthorisesEnable(validation(), otherInbound, NOW)).toBe(false);
  });

  it('refuses a stale validation', () => {
    expect(validationAuthorisesEnable(validation({ checkedAt: STALE }), IDENTITY, NOW)).toBe(false);
  });

  it('refuses a health row written before the column existed', () => {
    /*
     * `validated_identity` is nullable because older rows have no value for it,
     * and a null authorises NOTHING. An upgrade must not silently bless a
     * validation nobody can attribute to a configuration — that is the
     * fail-closed direction, and the other one would enable every panel in the
     * installation on the strength of whatever the monitor last wrote.
     */
    expect(validationAuthorisesEnable(validation({ validatedIdentity: null }), IDENTITY, NOW)).toBe(
      false,
    );
  });

  it('does not treat a re-saved identical configuration as a change', () => {
    /*
     * Activation is an object, and a round trip through the operator's form can
     * reorder its keys. A test they did not invalidate must keep authorising,
     * so the identity is built over sorted keys rather than over whatever order
     * the JSON happened to arrive in.
     */
    const one = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: { inboundTags: { vless: ['VLESS TCP'] }, proxyProtocols: ['vless'] },
      usernameSetAt: new Date('2026-09-18T10:00:00.000Z'),
      passwordSetAt: new Date('2026-09-18T10:00:00.000Z'),
      apiTokenSetAt: null,
    });
    expect(one).toBe(IDENTITY);
  });

  it('folds an absent credential and one set at the Unix epoch to one identity', () => {
    /*
     * A KNOWN collision, asserted so it is a recorded property rather than a
     * surprise. `?.getTime() ?? 0` cannot tell "never set" from "set at
     * 1970-01-01", so removing a credential whose timestamp was the epoch would
     * not invalidate a validation.
     *
     * Left as it is because the timestamps are written by `Clock.now()` on a
     * running installation, so the colliding value is not reachable by any path
     * that exists — and the alternative, a sentinel string, would put a second
     * spelling of "absent" into a function whose whole job is to compare two
     * spellings of the same configuration. If a future path can produce an
     * epoch timestamp, this case is where it will fail and say why.
     */
    const never = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: null,
      usernameSetAt: null,
      passwordSetAt: null,
      apiTokenSetAt: null,
    });
    const epoch = connectionIdentityOf({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: null,
      usernameSetAt: null,
      passwordSetAt: null,
      apiTokenSetAt: new Date(0),
    });
    expect(never).toBe(epoch);
  });
});
