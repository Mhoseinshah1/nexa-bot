import { describe, expect, it } from 'vitest';
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
      if (setting.zeroMeaning === 'NOT_APPLICABLE') continue;

      const parses = (value: unknown) => setting.schema.safeParse(value).success;
      const accepted =
        setting.zeroMeaning === 'UNLIMITED'
          ? // "Zero means no limit" is a claim about the number.
            parses(0)
          : // DISABLES and LITERAL are claims about the key's empty state,
            // which is `0`, `''` or absent depending on what the value is.
            parses(0) || parses('') || parses(null);
      expect(
        accepted,
        `${setting.key} declares ${setting.zeroMeaning} for a zero state its schema rejects`,
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
