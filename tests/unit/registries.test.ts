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
      const zeroIsRejected =
        !setting.schema.safeParse(0).success && !setting.schema.safeParse('').success;
      expect(
        zeroIsRejected,
        `${setting.key} claims zero cannot occur, but the schema allows it`,
      ).toBe(true);
    }
  });

  it('accepts zero where the declaration says zero means something', () => {
    const retention = settingDefinition('opslog.retention_days');
    expect(retention.zeroMeaning).toBe('UNLIMITED');
    expect(retention.schema.safeParse(0).success).toBe(true);
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
      'opslog_retention',
      'template_overrides',
    ]);
  });
});
