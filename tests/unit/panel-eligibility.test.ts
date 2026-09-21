import { describe, expect, it } from 'vitest';
import {
  PANEL_HEALTH_FRESH_FOR_MS,
  PROVIDER_TYPES,
  PANEL_HEALTH_STATES,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  type PanelHealthState,
} from '@nexa/contracts';
import {
  activationIssues,
  connectionIdentityOf,
  decideEligibility,
  isConfirmedUnusable,
  provisioningInputFor,
  validationAuthorisesEnable,
  type EligibilityInput,
  type ProvisioningInput,
} from '../../apps/api/src/modules/platform/panels/application/panel-eligibility';
import { decideOperability } from '../../apps/api/src/modules/commerce/provisioning/application/panel-operability';

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

/**
 * A panel that could actually deliver: Marzban, both credentials set, an
 * activation that parses, and a service adapter in this release.
 *
 * Every case below starts from one, because the question each of them asks is
 * "what ELSE stops this selling". A fixture missing any of these four would make
 * every assertion in the file pass for the wrong reason — which is exactly what
 * the old fixture did, by not carrying them at all.
 */
const CREDENTIALS = {
  usernameSetAt: new Date('2026-09-01T00:00:00.000Z'),
  passwordSetAt: new Date('2026-09-01T00:00:00.000Z'),
  apiTokenSetAt: null,
};

const PROVISIONING: ProvisioningInput = provisioningInputFor({
  providerType: 'marzban',
  baseUrl: 'https://panel.example.test',
  activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP'] } },
  credentials: CREDENTIALS,
  serviceAdapterExists: true,
});

const base: EligibilityInput = {
  status: 'ACTIVE',
  /*
   * A probe that validated THIS configuration, because an unprobed panel is no
   * longer sellable and that is the point of the change. `health: null` is its
   * own case below rather than the default every other case inherits.
   */
  health: {
    state: 'HEALTHY',
    checkedAt: FRESH,
    unusableStreak: 0,
    validatedIdentity: PROVISIONING.currentIdentity,
  },
  maxServices: null,
  used: 0,
  now: NOW,
  provisioning: PROVISIONING,
};

const withHealth = (
  state: PanelHealthState,
  unusableStreak: number,
  checkedAt: Date = FRESH,
): EligibilityInput => ({
  ...base,
  health: { state, checkedAt, unusableStreak, validatedIdentity: PROVISIONING.currentIdentity },
});

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

  it('refuses a panel nobody has ever probed, as UNVALIDATED and not as UNHEALTHY', () => {
    /*
     * THIS ASSERTION IS THE INVERSE OF WHAT IT USED TO BE, DELIBERATELY.
     *
     * It used to read "keeps selling when nobody has ever probed the panel", on
     * the argument that `UNCHECKED` is the absence of evidence and a fresh
     * installation must be able to sell. The first half is still true and is
     * why the reason here is `UNVALIDATED` rather than `UNHEALTHY`. The second
     * half is how order `01a0c54b` happened: `DrizzlePanelRepository.create`
     * writes `status: 'ACTIVE'`, so under the old rule a panel created seconds
     * ago — no credentials, no activation, never contacted — was immediately
     * sellable.
     *
     * The remedy was never "wait for the monitor". It is the operator pressing
     * Test Connection, which they must do anyway before they can enable a panel
     * they have disabled, and which is one button on the panel's own page.
     */
    expect(decideEligibility({ ...base, health: null })).toEqual({
      eligible: false,
      reason: 'UNVALIDATED',
    });
  });

  it('keeps selling on evidence that is old but SUCCEEDED', () => {
    /*
     * The rule that stops a stopped monitor closing every shop in the
     * installation, and it is not hypothetical: only a probe can overwrite a
     * health row, so a monitor that is down leaves the last row frozen.
     *
     * This is the case that rule is actually about, and it is asserted
     * explicitly now because the hotfix below narrows its neighbour. A panel
     * whose last probe SUCCEEDED against the configuration it still has goes on
     * selling however old that probe is: old evidence stops being evidence, it
     * does not become counter-evidence, and `UNVALIDATED` asks WHAT was
     * validated rather than WHEN.
     */
    expect(decideEligibility(withHealth('HEALTHY', 0, STALE))).toEqual({ eligible: true });
  });

  it('keeps selling when the failing evidence is too old to believe', () => {
    /*
     * The rule that stops a stopped monitor closing every shop in the
     * installation, and it is not hypothetical: only a probe can overwrite a
     * health row, so a monitor that is down leaves the last row frozen. Without
     * the freshness bound a panel that failed three times before an outage of
     * OUR OWN machinery would never sell again, however healthy it had become.
     *
     * UNCHANGED by the provisionability hotfix, and that is worth saying because
     * one draft of it broke this case. `connectionValidated` asks only whether a
     * probe has run against the configuration the panel HAS NOW; whether what
     * that probe learned is bad enough to stop selling stays entirely the health
     * lane's question, with its streak and its freshness bound. Reading the
     * probe's STATE in both places counted the same evidence twice and moved
     * `PANEL_UNHEALTHY_AFTER_FAILURES` to one.
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
  // Provisionability: could this panel actually produce what is being sold
  // -------------------------------------------------------------------------

  it('refuses a panel whose activation does not parse, however healthy it is', () => {
    /*
     * THE PRODUCTION INCIDENT, as one assertion.
     *
     * Order `01a0c54b` on v0.2.8: the panel was ACTIVE, the probe said HEALTHY,
     * there was free capacity, and the Marzban activation was absent. The
     * customer paid 10,000 toman, the provisioner refused `ACTIVATION_INCOMPLETE`
     * five times over seven minutes, and the order was refunded.
     *
     * Every fact in this fixture is a fact from that order. If this assertion
     * ever goes back to `{ eligible: true }`, that order happens again.
     */
    const decision = decideEligibility({
      ...base,
      maxServices: 100,
      used: 0,
      provisioning: provisioningInputFor({
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        activation: null,
        credentials: CREDENTIALS,
        serviceAdapterExists: true,
      }),
    });
    expect(decision).toEqual({ eligible: false, reason: 'ACTIVATION_INCOMPLETE' });
  });

  it('refuses a Marzban panel configured for a protocol it names no inbound for', () => {
    /*
     * The narrower half of the same defect, and the one a schema catches where a
     * "is activation null" check would not. `marzbanActivationSchema` refuses a
     * record that names `vmess` in `proxyProtocols` and gives tags only for
     * `vless`, because Marzban computes `excluded_inbounds` as every inbound for
     * a requested protocol that is not listed — so the vmess half of that
     * customer's subscription would carry nothing, behind a 200 and a URL.
     */
    const decision = decideEligibility({
      ...base,
      provisioning: provisioningInputFor({
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        activation: { proxyProtocols: ['vless', 'vmess'], inboundTags: { vless: ['VLESS_TCP'] } },
        credentials: CREDENTIALS,
        serviceAdapterExists: true,
      }),
    });
    expect(decision).toEqual({ eligible: false, reason: 'ACTIVATION_INCOMPLETE' });
  });

  it('refuses a panel whose credentials are not set', () => {
    /*
     * The case the OLD docblock offered as the worked example of a panel that is
     * "eligible and inoperable", which was the defect described as the design. A
     * panel nobody can authenticate against cannot deliver anything.
     */
    const decision = decideEligibility({
      ...base,
      provisioning: provisioningInputFor({
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP'] } },
        credentials: { usernameSetAt: null, passwordSetAt: null, apiTokenSetAt: null },
        serviceAdapterExists: true,
      }),
    });
    expect(decision).toEqual({ eligible: false, reason: 'CREDENTIALS_MISSING' });
  });

  it('refuses a provider this release has no service adapter for', () => {
    /*
     * A statement about CODE, so it comes FIRST among the four: no operator
     * action fixes it, and reporting it as configuration would send somebody to a
     * form that cannot help them.
     */
    const decision = decideEligibility({
      ...base,
      provisioning: { ...PROVISIONING, serviceAdapterExists: false },
    });
    expect(decision).toEqual({ eligible: false, reason: 'PROVISION_UNSUPPORTED' });
  });

  it('stops counting a connection test the moment the configuration changes', () => {
    /*
     * The mechanism, asserted directly rather than inferred. The panel was
     * probed, that probe validated the identity it had then, and an operator has
     * since changed the activation — so the evidence no longer describes the
     * panel and the verdict is `UNVALIDATED` rather than a stale `true`.
     *
     * This is the case that separates the fix from a one-off: it holds for an
     * address change, a password rotation and an activation edit alike, because
     * `connectionIdentityOf` covers all three.
     */
    const changed = provisioningInputFor({
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_WS'] } },
      credentials: CREDENTIALS,
      serviceAdapterExists: true,
    });
    expect(changed.currentIdentity).not.toBe(PROVISIONING.currentIdentity);
    expect(decideEligibility({ ...base, provisioning: changed })).toEqual({
      eligible: false,
      reason: 'UNVALIDATED',
    });
  });

  it('reports configuration before health, because one is certain and one is measured', () => {
    /*
     * A panel that is BOTH unreachable and unconfigured. `UNHEALTHY` would send
     * an operator to tcpdump; `ACTIVATION_INCOMPLETE` sends them to the field
     * they have to fill in either way. The configuration is a fact about our own
     * row; the health is a measurement that can be stale or simply wrong.
     */
    const decision = decideEligibility({
      ...withHealth('UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES),
      provisioning: provisioningInputFor({
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        activation: null,
        credentials: CREDENTIALS,
        serviceAdapterExists: true,
      }),
    });
    expect(decision).toEqual({ eligible: false, reason: 'ACTIVATION_INCOMPLETE' });
  });

  it("names the schema's own field paths, so a form can point at the input", () => {
    /*
     * Paths rather than a sentence, and the evaluator and the surface read the
     * SAME function — `activationIssues` — so a screen cannot list one set of
     * missing fields while the sale is refused for another.
     */
    expect(activationIssues('marzban', null)).toEqual(['proxyProtocols', 'inboundTags']);
    expect(
      activationIssues('marzban', {
        proxyProtocols: ['vless', 'vmess'],
        inboundTags: { vless: ['VLESS_TCP'] },
      }),
    ).toEqual(['inboundTags.vmess']);
    expect(
      activationIssues('marzban', {
        proxyProtocols: ['vless'],
        inboundTags: { vless: ['VLESS_TCP'] },
      }),
    ).toEqual([]);
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

/**
 * The sale and the provisioner must read ONE activation the same way.
 *
 * These two evaluators are deliberately different questions — `decideOperability`
 * ignores health, `decideEligibility` ignores capabilities — and the separation is
 * recorded as a rule. What they may never disagree about is whether a given stored
 * activation is usable at all, because that disagreement has exactly one shape: the
 * sale says yes, the money moves, and the provisioner says no.
 *
 * Codex C1 on PR #58 found it in the provider this hotfix added.
 * `activationIssues` answered an unset activation with the provider's required
 * field NAMES, and `rickpanelActivationSchema` is `z.object({}).strict()`, so that
 * list was EMPTY — no issues, therefore sellable — while `decideOperability` asked
 * zod, which rejects `null` whatever the schema is. A RickPanel with no activation
 * row was sellable and not operable simultaneously, which is order `01a0c54b`
 * reached through a second door.
 *
 * So this asserts AGREEMENT rather than either answer, across every provider type
 * and every shape of stored activation. Written this way it cannot be satisfied by
 * a matching pair of hardcoded expectations, and a provider added later is covered
 * the day its type joins `PROVIDER_TYPES`.
 */
describe('the sale and the provisioner agree about one activation', () => {
  const CREDENTIALLED = {
    usernameSetAt: new Date('2026-09-01T00:00:00.000Z'),
    passwordSetAt: new Date('2026-09-01T00:00:00.000Z'),
    apiTokenSetAt: new Date('2026-09-01T00:00:00.000Z'),
  };

  /**
   * Every shape a `panels.activation` column can actually hold, plus the two
   * spellings of absent. `undefined` is not reachable from a row and is included
   * because a caller assembling the struct by hand can produce it.
   */
  const ACTIVATIONS: readonly (readonly [string, unknown])[] = [
    ['unset (null)', null],
    ['unset (undefined)', undefined],
    ['empty object', {}],
    ['a Marzban activation', { proxyProtocols: ['vless'], inboundTags: { vless: ['T'] } }],
    ['a 3X-UI activation', { subscriptionDomain: 'sub.example.test', inboundId: 1 }],
    ['a foreign key', { proxyProtocols: ['vless'] }],
    ['not an object', 'vless'],
  ];

  for (const providerType of PROVIDER_TYPES) {
    for (const [label, activation] of ACTIVATIONS) {
      it(`${providerType}: ${label} is complete to both or to neither`, () => {
        const sellable = activationIssues(providerType, activation).length === 0;
        const operable = decideOperability({
          panel: {
            status: 'ACTIVE',
            providerType,
            baseUrl: 'https://panel.example.test',
            archivedAt: null,
            activation,
          },
          credentials: CREDENTIALLED,
          type: 'PROVISION',
          serviceAdapterExists: true,
        });
        const operableOnActivation = operable.ok || operable.reason !== 'ACTIVATION_INCOMPLETE';
        expect(operableOnActivation).toBe(sellable);
      });
    }
  }

  /**
   * The specific row the incident would be reached through, asserted on its own so
   * the reason is named rather than inferred from an agreement that could also be
   * reached by both sides refusing.
   */
  it('a RickPanel with no activation is sellable AND operable, because it needs none', () => {
    expect(activationIssues('rickpanel', null)).toEqual([]);
    const operable = decideOperability({
      panel: {
        status: 'ACTIVE',
        providerType: 'rickpanel',
        baseUrl: 'https://panel.example.test',
        archivedAt: null,
        activation: null,
      },
      credentials: CREDENTIALLED,
      type: 'PROVISION',
      serviceAdapterExists: true,
    });
    expect(operable.ok).toBe(true);
  });

  /**
   * And the other half: a provider that DOES require fields is refused by both, with
   * the missing names coming from the schema's own issues. Without this, normalising
   * `null` to `{}` could be "fixed" by making everything complete.
   */
  it('a Marzban with no activation is refused by both, naming its fields', () => {
    expect(activationIssues('marzban', null)).toEqual(['proxyProtocols', 'inboundTags']);
    const operable = decideOperability({
      panel: {
        status: 'ACTIVE',
        providerType: 'marzban',
        baseUrl: 'https://panel.example.test',
        archivedAt: null,
        activation: null,
      },
      credentials: CREDENTIALLED,
      type: 'PROVISION',
      serviceAdapterExists: true,
    });
    expect(operable).toEqual({ ok: false, reason: 'ACTIVATION_INCOMPLETE' });
  });

  /** An activation an operator set is never repaired into one that parses. */
  it('a present but invalid activation is refused, not normalised', () => {
    expect(activationIssues('rickpanel', { proxyProtocols: ['vless'] })).not.toEqual([]);
    expect(activationIssues('marzban', { proxyProtocols: [] })).toContain('proxyProtocols');
  });
});
