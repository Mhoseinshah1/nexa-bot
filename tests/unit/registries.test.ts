import { describe, expect, it } from 'vitest';
import {
  failureOutcome,
  isIdempotentMutation,
  isMutatingOperation,
  isServiceAdapter,
  operationFailureOutcome,
  OPERATION_REQUIRED_CAPABILITIES,
  OPERATION_TYPES,
  PROVIDER_CAPABILITIES,
  PROVIDER_TYPES,
  SERVICE_MACHINE,
  SERVICE_STATES,
  type ProviderCapability,
  type ProviderType,
} from '@nexa/contracts';
import {
  isPerformableOperation,
  OPERATION_LEGAL_FROM,
  PERFORMABLE_OPERATION_TYPES,
} from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';
import {
  IMPLEMENTED_PROVIDER_TYPES,
  providerAdapter,
} from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import type { ZeroMeaning } from '@nexa/contracts';
import {
  FEATURE_FLAGS,
  SETTINGS,
  featureFlagDefinition,
  isFeatureFlagKey,
  isSettingKey,
  parseSettingValue,
  settingDefinition,
  type FeatureFlagKey,
  type SettingKey,
} from '@nexa/contracts';

/**
 * Whether a zero meaning is UNLIMITED, asked of the whole vocabulary.
 *
 * A parameter rather than an inline `===`, because TypeScript narrows
 * `setting.zeroMeaning` to the members today's registry happens to declare —
 * no setting says UNLIMITED yet — and then reports the comparison as
 * unreachable. That would be an argument for deleting a guard which exists
 * precisely for the setting nobody has added, so the check is asked of
 * `ZeroMeaning` instead, where every member is live.
 */
const meansUnlimited = (meaning: ZeroMeaning): boolean => meaning === 'UNLIMITED';

/**
 * Every shape an "empty state" can take in this registry.
 *
 * `0`, `''` and `null` were the whole list while every setting held a scalar.
 * They stopped being it when the registry gained a LIST — whose empty state is
 * `[]` and not any of the three — and a MONEY, whose zero is an amount of zero
 * in some currency. A key declaring DISABLES for `[]` would have failed the
 * check below against a schema that models its empty state perfectly well.
 *
 * The check keeps its teeth: it still demands that a key declaring a meaning
 * for emptiness have SOME value its own schema accepts as empty. Widening the
 * vocabulary is not the same as accepting anything, and a key whose schema
 * admits no empty state at all still fails.
 */
const ZERO_STATES: readonly unknown[] = [
  0,
  '',
  null,
  [],
  { amountMinor: '0', currency: 'IRT' },
  { amountMinor: '0', currency: 'IRR' },
];

describe('the settings registry', () => {
  it('parses every declared default with its own schema', () => {
    // A malformed default cannot ship: it would be returned by every read until
    // somebody overwrote it, which in the legacy system is the only way to find
    // out what a setting says (BC-SB-003).
    for (const setting of SETTINGS) {
      const result = setting.schema.safeParse(setting.defaultValue);
      expect(result.success, `${setting.key} default does not parse`).toBe(true);
    }
  });

  it('declares what zero or empty means for every key', () => {
    for (const setting of SETTINGS) {
      expect(setting.zeroMeaning, setting.key).toBeTruthy();
    }
  });

  it('marks NOT_APPLICABLE only where the schema really does forbid zero or empty', () => {
    for (const setting of SETTINGS) {
      if (setting.zeroMeaning !== 'NOT_APPLICABLE') continue;
      // `null` too. Leaving it out is how a key whose ABSENCE is its most
      // interesting state came to declare that its absence cannot occur, with
      // this test passing against the mis-declaration.
      const zeroIsRejected = ZERO_STATES.every(
        (candidate) => !setting.schema.safeParse(candidate).success,
      );
      expect(
        zeroIsRejected,
        `${setting.key} claims zero cannot occur, but the schema allows it`,
      ).toBe(true);
    }
  });

  it('accepts a zero state wherever the declaration says one is possible', () => {
    // The other half of the rule above, and the half that was missing. The
    // NOT_APPLICABLE test proves a key that CLAIMS zero cannot occur really
    // forbids it; without this, a key claiming DISABLES, UNLIMITED or LITERAL
    // could declare a meaning for a state its own schema rejects — a registry
    // describing behaviour that no value can ever produce, which is exactly
    // what a settings screen is for reading.
    // Each declaration names a SPECIFIC state, and the assertion checks that
    // one. Accepting any of `0`, `''` or `null` would let a key declaring
    // UNLIMITED — a statement about the NUMBER zero — pass because its schema
    // happens to accept an empty string.
    for (const setting of SETTINGS) {
      const zeroMeaning = setting.zeroMeaning;
      if (zeroMeaning === 'NOT_APPLICABLE') continue;

      const parses = (value: unknown) => setting.schema.safeParse(value).success;
      const accepted = meansUnlimited(zeroMeaning)
        ? // "Zero means no limit" is a claim about the number.
          parses(0)
        : // DISABLES and LITERAL are claims about the key's empty state, and
          // which value that IS depends on the shape the key holds: `0`, `''`,
          // absent, an empty list, or a zero amount.
          ZERO_STATES.some(parses);
      expect(
        accepted,
        `${setting.key} declares ${zeroMeaning} for a zero state its schema rejects`,
      ).toBe(true);
    }
  });

  it('accepts empty where the declaration says empty means something', () => {
    // The destination is the one key here whose zero case carries a meaning:
    // empty is "not configured", and nothing is sent.
    const destination = settingDefinition('ops.notifications.telegram_chat_id');
    expect(destination.zeroMeaning).toBe('DISABLES');
    expect(destination.schema.safeParse('').success).toBe(true);
  });

  it('fails closed on an unknown key', () => {
    expect(isSettingKey('ops.notifications.telegram_chat_id')).toBe(true);
    expect(isSettingKey('anything.else')).toBe(false);
    expect(() => settingDefinition('anything.else' as SettingKey)).toThrow(/frozen contract/);
  });

  it('rejects rather than coerces a value of the wrong type', () => {
    const result = parseSettingValue('ops.notifications.max_attempts', '5');
    expect(result.ok).toBe(false);
  });

  it('rejects a value outside its declared bounds', () => {
    expect(parseSettingValue('ops.notifications.max_attempts', 0).ok).toBe(false);
    expect(parseSettingValue('ops.notifications.max_attempts', 11).ok).toBe(false);
    expect(parseSettingValue('ops.notifications.max_attempts', 5).ok).toBe(true);
  });

  it('rejects a chat id that is not an integer, and accepts empty as "not configured"', () => {
    expect(parseSettingValue('ops.notifications.telegram_chat_id', '@mygroup').ok).toBe(false);
    expect(parseSettingValue('ops.notifications.telegram_chat_id', '-1001234567890').ok).toBe(true);
    expect(parseSettingValue('ops.notifications.telegram_chat_id', '').ok).toBe(true);
  });

  it('holds no credential', () => {
    // Secrets are envelope-encrypted rows, never settings. Checked rather than
    // remembered: the legacy system types panel tokens into a chat message.
    const forbidden = /password|secret|token|api[_.]?key|credential|kek/i;
    for (const setting of SETTINGS) {
      expect(forbidden.test(setting.key), setting.key).toBe(false);
    }
    expect(SETTINGS.every((s) => s.classification !== ('SECRET' as never))).toBe(true);
  });
});

describe('the feature flag registry', () => {
  it('fails closed on an unknown key', () => {
    expect(isFeatureFlagKey('ops_notifications')).toBe(true);
    expect(isFeatureFlagKey('payments')).toBe(false);
    expect(() => featureFlagDefinition('payments' as FeatureFlagKey)).toThrow(/frozen contract/);
  });

  it('links flags and their settings symmetrically', () => {
    // The legacy flag and its threshold sit on two screens with nothing
    // connecting them, and the flag being off silently makes the value inert
    // (CBR-007, GSR-008). Both halves are declared here, so they cannot drift.
    for (const flag of FEATURE_FLAGS) {
      for (const key of flag.configuredBy) {
        expect(isSettingKey(key), `${flag.key} names a setting that does not exist: ${key}`).toBe(
          true,
        );
        expect(settingDefinition(key as SettingKey).configures, key).toBe(flag.key);
      }
    }
    for (const setting of SETTINGS) {
      if (setting.configures === null) continue;
      expect(isFeatureFlagKey(setting.configures), setting.key).toBe(true);
      expect(
        featureFlagDefinition(setting.configures as FeatureFlagKey).configuredBy,
        `${setting.configures} does not list ${setting.key}`,
      ).toContain(setting.key);
    }
  });

  it('stores a boolean and nothing else', () => {
    // CBR-011's four capability shapes are settings shapes. If a flag could hold
    // configuration, this registry would become the string map it exists to
    // avoid.
    for (const flag of FEATURE_FLAGS) {
      expect(typeof flag.defaultEnabled, flag.key).toBe('boolean');
      expect(Object.keys(flag).sort()).toEqual([
        'blastRadius',
        'configuredBy',
        'defaultEnabled',
        'description',
        'key',
      ]);
    }
  });

  it('asks for a typed confirmation before offering every customer a free trial', () => {
    // Codex, PR #64: the trials flag reaches every customer of the tenant at once, the
    // reach the reminder flags have, and LOCAL let it flip with one press and no reason.
    expect(featureFlagDefinition('trials').blastRadius).toBe('TENANT_WIDE');
  });

  it('asks for a typed confirmation before offering every customer a new link', () => {
    // WP6-C: like `trials`, the rotation flag offers a new action to every customer of
    // the tenant at once.
    expect(featureFlagDefinition('customer_link_rotation').blastRadius).toBe('TENANT_WIDE');
    expect(featureFlagDefinition('customer_link_rotation').defaultEnabled).toBe(false);
  });

  it('refuses a rotation cooldown of zero, which would be no rate rule at all', () => {
    const schema = settingDefinition('services.link_rotation_cooldown_hours').schema;
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(1).success).toBe(true);
    expect(schema.safeParse(720).success).toBe(true);
    expect(schema.safeParse(721).success).toBe(false);
    expect(settingDefinition('services.link_rotation_cooldown_hours').defaultValue).toBe(24);
  });

  it('registers no flag for a feature that does not exist', () => {
    // Every registered key must be one this phase actually implements. A switch
    // that turns nothing on is worse than an absent feature.
    expect([...FEATURE_FLAGS].map((f) => f.key).sort()).toEqual([
      // WP6-C. Off by default; the customer rotation path it switches on is reachable.
      'customer_link_rotation',
      'ops_notifications',
      // The three reminder switches. `service_expired_notice` is a flag rather than a
      // sixth threshold because it is not a number: it fires at zero days and what an
      // operator decides about it is whether it is sent at all.
      'service_expired_notice',
      'service_expiry_reminders',
      'service_usage_reminders',
      'template_overrides',
      // WP6-A. Off by default; the trial path it switches on is reachable.
      'trials',
    ]);
  });
});

/**
 * The provider registry.
 *
 * Here, beside the settings and feature registries, because it is one: a map
 * from a declared identifier to the code that implements it, and the thing
 * every surface reads to decide what an operator may configure.
 *
 * It had no test of its own, and falsification found the hole — removing
 * `sanaei` from the adapter map left this file 14/14 green, so the only thing
 * standing between a deleted registration and a release was a provider-specific
 * suite. `IMPLEMENTED_PROVIDER_TYPES` is what the providers endpoint lists, so
 * a silent removal is an operator losing a provider with nothing red.
 */
describe('the provider registry', () => {
  it('implements exactly the provider types this release claims', () => {
    // Written as an EXACT list rather than a subset. A subset assertion passes
    // when a registration disappears, which is the failure this exists to
    // catch; and it passes when one appears, which should be a deliberate
    // edit here rather than a silent widening of what operators can configure.
    expect([...IMPLEMENTED_PROVIDER_TYPES].sort()).toEqual(['marzban', 'rickpanel', 'sanaei']);
  });

  it('resolves every implemented type to an adapter that declares that type', () => {
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      const adapter = providerAdapter(type);
      // The adapter's OWN descriptor key, not the lookup key: a map entry
      // pointing at another provider's adapter would satisfy the first
      // assertion and operate somebody's panel with the wrong protocol.
      expect(adapter.descriptor.key, type).toBe(type);
      expect(adapter.supports('HEALTH_CHECK'), type).toBe(true);
    }
  });

  it('declares no provider type it cannot operate', () => {
    // The Phase 3A state — a type in the contract with no adapter — was real
    // and is allowed by the registry's type. What must not happen is a surface
    // advertising one, so this states the current position: every declared
    // type is implemented.
    expect([...PROVIDER_TYPES].sort()).toEqual([...IMPLEMENTED_PROVIDER_TYPES].sort());
  });

  /**
   * The capability invariant, written generically ON PURPOSE.
   *
   * `capabilities` means "the operations this release can execute for this
   * provider", and for one release it did not: Sanaei listed what its adapter
   * did while Marzban listed what its panel could do in a later phase, so the
   * same field on the same endpoint meant two different things. Per-provider
   * assertions would have caught neither, because each provider's own test
   * agreed with its own descriptor.
   *
   * So this iterates the registry rather than naming providers. A THIRD
   * provider added with an aspirational list fails here without anyone
   * remembering to write a test for it, which is the only version of this rule
   * that survives the next phase.
   */
  it('lets no provider advertise an operation this release cannot execute', () => {
    // PER PROVIDER, and exhaustive over `ProviderType` — not one shared list.
    //
    // Both entries read `['HEALTH_CHECK']` today, which is exactly why the
    // shape matters: a single global set would say "every provider has the
    // same capabilities", and that is a claim about the future that is already
    // false in principle. Marzban and 3X-UI are separate products with
    // separate APIs, and Phase 4 will implement an operation for one of them
    // before the other — `{ marzban: ['HEALTH_CHECK', 'CREATE_USER'], sanaei:
    // ['HEALTH_CHECK'] }` has to be expressible without touching Sanaei's
    // entry, and with a global set it would not be.
    //
    // `Record<ProviderType, …>` rather than a partial map, so a provider added
    // to the contract without a decision about what it can execute is a
    // compile error here rather than a silent inheritance of somebody else's
    // list.
    //
    // A capability joins an entry in the same commit as the operation behind
    // it. This test is what makes that a deliberate edit rather than a
    // declaration somebody made in a descriptor.
    const EXECUTABLE_NOW: Record<ProviderType, readonly ProviderCapability[]> = {
      /*
       * The three management capabilities are Marzban's ALONE, and that asymmetry is a
       * scope decision rather than a statement about the panels. 3X-UI can plainly
       * disable and delete a client; how it does so has never been read out of the
       * v3.7.0 source or run against the binary, so this release does not claim it.
       * `docs/providers/sanaei-3xui.md` says so where an operator will find it.
       *
       * Each of Marzban's three was added by the commit that ran
       * `tests/acceptance/real-panel-marzban.test.ts` against a real v0.8.4, not by the
       * commit that wrote the methods.
       */
      marzban: [
        'HEALTH_CHECK',
        'CREATE_USER',
        'READ_USAGE',
        'DELIVER_SUBSCRIPTION_LINK',
        'DISABLE_USER',
        'ENABLE_USER',
        'DELETE_USER',
        /*
         * The three commercial ones, added by the commit that wrote the executor's
         * dispatch branches — so "can execute" means end to end, not "the adapter has a
         * method". `applyAllowance` and the real-panel acceptance both landed first, and
         * neither was enough on its own: an adapter that can perform an operation the
         * executor will not route to is an operation a customer is still refused.
         */
        'RENEW_USER',
        'ADD_VOLUME',
        'ADD_TIME',
      ],
      /*
       * RickPanel's ten, and the ONE place in this file where the rule above —
       * a capability joins this list in the commit that proved it against a real
       * panel — has a deliberate exception.
       *
       * No RickPanel has been contacted. `docs/rickpanel-adapter-audit.md` §4
       * records why the exception was taken rather than quietly made: declaring
       * nothing would leave `canProvision` false for every RickPanel, no
       * RickPanel sellable, and the production incident this release exists to
       * fix unfixed. `tests/acceptance/real-panel-rickpanel.test.ts` is what
       * turns these into evidence, and until it has run against a panel they
       * rest on a document and a fake.
       *
       * `LIMIT_DEVICES` is absent even so, and for the ordinary reason:
       * `RickpanelAdapter.createUser` does not send a device limit, because the
       * contract does not describe a field for one.
       */
      rickpanel: [
        'HEALTH_CHECK',
        'CREATE_USER',
        'READ_USAGE',
        'DELIVER_SUBSCRIPTION_LINK',
        'DISABLE_USER',
        'ENABLE_USER',
        'DELETE_USER',
        'RENEW_USER',
        'ADD_VOLUME',
        'ADD_TIME',
        // Measured on the owner's panel and proven per call by a read-back:
        // `docs/rickpanel-rotate-audit.md`. Marzban and 3X-UI stay without it.
        'ROTATE_SUBSCRIPTION_LINK',
      ],
      // `LIMIT_DEVICES` for Sanaei only, and the asymmetry is the whole point of this
      // map being per provider. `SanaeiAdapter.createUser` writes `limitIp` from the
      // order's frozen `deviceLimit`; `MarzbanAdapter.createUser` does not read the
      // field. Until this line the descriptors said the same thing about both, and the
      // provisioner sold Marzban customers a device limit that never reached the panel.
      sanaei: [
        'HEALTH_CHECK',
        'CREATE_USER',
        'READ_USAGE',
        'DELIVER_SUBSCRIPTION_LINK',
        'LIMIT_DEVICES',
      ],
    };

    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      const adapter = providerAdapter(type);
      const executable = EXECUTABLE_NOW[type];
      expect([...adapter.descriptor.capabilities].sort(), type).toEqual([...executable].sort());

      // And through `supports()`, which is what callers actually ask. Asserted
      // over the WHOLE vocabulary so a capability this provider must not claim
      // is checked explicitly rather than by omission.
      for (const capability of PROVIDER_CAPABILITIES) {
        expect(adapter.supports(capability), `${type}.supports(${capability})`).toBe(
          executable.includes(capability),
        );
      }
    }
  });

  it('backs every declared service capability with a method that exists', () => {
    // The other half of the same rule, stated where it cannot be satisfied by
    // editing a descriptor. Until Phase 4D no adapter implemented the service
    // surface at all, and this asserted exactly that. Now that both do, the
    // assertion inverts into its stronger form: a descriptor claiming CREATE_USER
    // must come with a `createUser` that a caller can invoke, and
    // `isServiceAdapter` — which `providerServiceAdapter` gates on — must agree.
    //
    // The direction matters. Checking only "the methods exist" would pass for an
    // adapter that had them and declared nothing, which is the harmless case;
    // checking the IMPLICATION catches the harmful one, a descriptor that
    // advertises an operation to an operator with no code behind it.
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      const adapter = providerAdapter(type);
      const claimed = adapter.descriptor.capabilities;
      const methods = adapter as unknown as Partial<Record<string, unknown>>;
      if (claimed.includes('CREATE_USER')) {
        expect(typeof methods['createUser'], `${type}.createUser`).toBe('function');
      }
      if (claimed.includes('READ_USAGE')) {
        expect(typeof methods['readUsage'], `${type}.readUsage`).toBe('function');
      }
      /*
       * The three management capabilities, on the same implication and for a sharper
       * reason: `suspendUser`, `resumeUser` and `terminateUser` are OPTIONAL on the
       * port, so a descriptor claiming one with no method behind it type-checks. The
       * executor would then call `undefined` inside a claimed operation — a TypeError,
       * which is not a `ProviderFailureKind`, so nothing classifies it and a mutating
       * operation cannot decide whether it took effect.
       */
      if (claimed.includes('DISABLE_USER')) {
        expect(typeof methods['suspendUser'], `${type}.suspendUser`).toBe('function');
      }
      if (claimed.includes('ENABLE_USER')) {
        expect(typeof methods['resumeUser'], `${type}.resumeUser`).toBe('function');
      }
      if (claimed.includes('DELETE_USER')) {
        expect(typeof methods['terminateUser'], `${type}.terminateUser`).toBe('function');
      }
      // `lookupUser` has no capability of its own — OPERATION_REQUIRED_CAPABILITIES
      // gives RECONCILE an empty list, because reading a user is how both adapters
      // already establish health. It is required of any adapter that can create,
      // because a create with no way to ask what happened afterwards is the
      // duplicate-account path this whole design exists to close.
      if (claimed.includes('CREATE_USER')) {
        expect(typeof methods['lookupUser'], `${type}.lookupUser`).toBe('function');
        expect(isServiceAdapter(adapter), `${type} is a service adapter`).toBe(true);
      }
    }
  });
});

// ===========================================================================
// The operation dispatch, which the Phase 4E audit calls the most dangerous
// edit in the phase
// ===========================================================================
describe('the operation dispatch cannot fail open', () => {
  /**
   * The property: an operation type this release cannot perform is refused before a
   * panel is contacted, not defaulted to the one call the executor used to make.
   *
   * `provisionCall` calls `createUser` unconditionally and its own docblock records
   * that a future type routed through it "would silently create a user on somebody's
   * panel". `PERFORMABLE_OPERATION_TYPES` is the list the executor checks against, and
   * these tests are what stop it drifting away from what the executor can actually do.
   */
  it('every performable type is a real operation type', () => {
    for (const type of PERFORMABLE_OPERATION_TYPES) {
      expect(OPERATION_TYPES).toContain(type);
    }
  });

  it('every performable type declares the states it is legal from', () => {
    // A performable type with an empty `OPERATION_LEGAL_FROM` would be refused by the
    // state check on every service that exists — a type that can never run, which is
    // the shape a half-finished addition takes.
    for (const type of PERFORMABLE_OPERATION_TYPES) {
      expect(OPERATION_LEGAL_FROM[type].length, `${type} is legal from nothing`).toBeGreaterThan(0);
    }
  });

  it('every type this release cannot perform is legal from NOTHING', () => {
    // The second, independent refusal. `isPerformableOperation` is the first; if a
    // future edit removes that check, a type with an empty legal-from list is still
    // ABANDONED by the state check rather than reaching `provisionCall`.
    for (const type of OPERATION_TYPES) {
      if (isPerformableOperation(type)) continue;
      expect(OPERATION_LEGAL_FROM[type], `${type} must be legal from nothing`).toEqual([]);
    }
  });

  it('names exactly the ten types this release performs, and no more', () => {
    // Pinned as a literal on purpose. Adding a type to the constant without writing its
    // branch fails here rather than on somebody's panel. `ROTATE_SUBSCRIPTION` joined
    // with RickPanel's `rotateSubscription`, in the commit that wrote its dispatch
    // branch (`docs/rickpanel-rotate-audit.md`). With it every member of
    // `OPERATION_TYPES` is performable; the refusal of an unperformable type stays for
    // the next member the contract gains.
    //
    // The three commercial types joined in 4F, in the commit that wrote their dispatch
    // branches — not in the one that wrote `applyAllowance`, and not in the one that
    // planned their operations.
    expect([...PERFORMABLE_OPERATION_TYPES].sort()).toEqual([
      'ADD_TIME',
      'ADD_TRAFFIC',
      'PROVISION',
      'RECONCILE',
      'RENEW',
      'RESUME',
      'ROTATE_SUBSCRIPTION',
      'SUSPEND',
      'SYNC_USAGE',
      'TERMINATE',
    ]);
  });

  it('gives each management type exactly the SERVICE_MACHINE edges it may take', () => {
    /*
     * Transcribed from the machine and asserted AGAINST it, which is different from
     * deriving one from the other: the derivation would track a future edge silently,
     * and the whole point is that a new state the provisioner is willing to suspend
     * from should be somebody's decision.
     *
     * So this checks the transcription is a SUBSET of what the machine allows — a
     * legal-from state with no edge would be an operation that can never move its
     * service, which is an operation that reports success and changes nothing.
     */
    const edges = (event: string): readonly string[] =>
      SERVICE_MACHINE.transitions
        .filter((transition) => transition.on === event)
        .map((transition) => transition.from);

    expect([...OPERATION_LEGAL_FROM['SUSPEND']].sort()).toEqual([...edges('SUSPEND')].sort());
    expect([...OPERATION_LEGAL_FROM['RESUME']].sort()).toEqual([...edges('RESUME')].sort());
    expect([...OPERATION_LEGAL_FROM['TERMINATE']].sort()).toEqual([...edges('TERMINATE')].sort());
  });

  it('never lets a terminated service be terminated again', () => {
    // A second TERMINATE would be a second DELETE against somebody's panel for a
    // service this installation already ended. `TERMINATED` is terminal in
    // SERVICE_MACHINE and must stay absent here.
    expect(OPERATION_LEGAL_FROM['TERMINATE']).not.toContain('TERMINATED');
  });

  it('classifies the three management types as idempotent mutations, and PROVISION not', () => {
    /*
     * The distinction measured against a real panel: a repeated disable is 200, a
     * repeated enable is 200, a repeated delete is 404 — all three outcomes the
     * operation asked for. A repeated create is a second account.
     *
     * The consequence is the row below: an uncertain suspend is FAILED, so it is
     * retried as the same suspend; an uncertain create is UNKNOWN, so it waits for a
     * read. Getting this backwards for PROVISION costs a customer a duplicate account;
     * getting it backwards for SUSPEND strands the operation for ever, because
     * `RECONCILE` reads whether an account EXISTS and never what state it is in.
     */
    for (const type of ['SUSPEND', 'RESUME', 'TERMINATE'] as const) {
      expect(isMutatingOperation(type), `${type} mutates`).toBe(true);
      expect(isIdempotentMutation(type), `${type} is idempotent`).toBe(true);
      expect(operationFailureOutcome('TIMEOUT', type)).toBe('FAILED');
      expect(operationFailureOutcome('PROVIDER_ERROR', type)).toBe('FAILED');
    }
    expect(isIdempotentMutation('PROVISION')).toBe(false);
    expect(operationFailureOutcome('TIMEOUT', 'PROVISION')).toBe('UNKNOWN');
    expect(operationFailureOutcome('PROVIDER_ERROR', 'PROVISION')).toBe('UNKNOWN');
    // And a kind that proves nothing happened is still FAILED for a create.
    expect(operationFailureOutcome('UNREACHABLE', 'PROVISION')).toBe('FAILED');
  });

  it('requires the capability each management operation actually needs', () => {
    expect(OPERATION_REQUIRED_CAPABILITIES['SUSPEND']).toEqual(['DISABLE_USER']);
    expect(OPERATION_REQUIRED_CAPABILITIES['RESUME']).toEqual(['ENABLE_USER']);
    expect(OPERATION_REQUIRED_CAPABILITIES['TERMINATE']).toEqual(['DELETE_USER']);
  });

  it('every legal-from state is a real service state', () => {
    for (const type of OPERATION_TYPES) {
      for (const state of OPERATION_LEGAL_FROM[type]) {
        expect(SERVICE_STATES, `${type} names ${state}`).toContain(state);
      }
    }
  });

  it('SYNC_USAGE is a read, so a failed one is never reconcilable', () => {
    // The rule `finishUsageSync` relies on: `failureOutcome` gives a non-mutating
    // operation `FAILED`, never `UNKNOWN`, so a usage read that did not answer leaves
    // nothing to reconcile and cannot move a working service to UNRECONCILED.
    expect(isMutatingOperation('SYNC_USAGE')).toBe(false);
    expect(failureOutcome('TIMEOUT', isMutatingOperation('SYNC_USAGE'))).toBe('FAILED');
    expect(failureOutcome('PROVIDER_ERROR', isMutatingOperation('SYNC_USAGE'))).toBe('FAILED');
  });

  it('SYNC_USAGE requires READ_USAGE, which is what a usage figure must come from', () => {
    expect(OPERATION_REQUIRED_CAPABILITIES['SYNC_USAGE']).toEqual(['READ_USAGE']);
  });
});
