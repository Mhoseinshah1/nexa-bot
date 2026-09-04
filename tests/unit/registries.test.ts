import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_TYPES,
  type ProviderCapability,
  type ProviderType,
} from '@nexa/contracts';
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
      const zeroIsRejected =
        !setting.schema.safeParse(0).success &&
        !setting.schema.safeParse('').success &&
        !setting.schema.safeParse(null).success;
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
        : // DISABLES and LITERAL are claims about the key's empty state,
          // which is `0`, `''` or absent depending on what the value is.
          parses(0) || parses('') || parses(null);
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

  it('registers no flag for a feature that does not exist', () => {
    // Every registered key must be one this phase actually implements. A switch
    // that turns nothing on is worse than an absent feature.
    expect([...FEATURE_FLAGS].map((f) => f.key).sort()).toEqual([
      'ops_notifications',
      'template_overrides',
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
    expect([...IMPLEMENTED_PROVIDER_TYPES].sort()).toEqual(['marzban', 'sanaei']);
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
      marzban: ['HEALTH_CHECK'],
      sanaei: ['HEALTH_CHECK'],
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

  it('offers a service operation through no adapter yet', () => {
    // The other half of the same rule, stated where it cannot be satisfied by
    // editing a descriptor: no adapter in this release implements the service
    // surface at all, so there is nothing a capability could have described.
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      const adapter = providerAdapter(type) as unknown as Partial<Record<string, unknown>>;
      expect(typeof adapter['createUser'], `${type}.createUser`).toBe('undefined');
      expect(typeof adapter['readUsage'], `${type}.readUsage`).toBe('undefined');
    }
  });
});
