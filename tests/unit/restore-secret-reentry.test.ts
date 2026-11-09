import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SecretPurpose } from '@nexa/contracts';
import {
  normalisedUnreadable,
  sameUnreadable,
} from '../../apps/api/src/modules/platform/recovery/application/recovery.service';
import { withinAcknowledged } from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';
import { unreadableRefusalFa } from '../../apps/api/src/backup.cli';
import { heldKeyLines, verifyReport } from '../../apps/api/src/secrets.cli';
import { InstallationKeyring } from '../../apps/api/src/infrastructure/crypto/installation-keyring';
import { kekFingerprint } from '../../apps/api/src/infrastructure/crypto/kek';
import type { SecretTrialReport } from '../../apps/api/src/infrastructure/crypto/secret-trial';

/** NEXA-FIX-RESTORE-SECRETS §2.3/§2.5: the rules a refused restore and the CLI rest on. */

const e = (purpose: SecretPurpose, count: number) => ({ purpose, count });

describe('the acknowledged list must be the recorded one, exactly', () => {
  const recorded = normalisedUnreadable([e('panel.password', 1), e('bot_instance.token', 2)]);

  it('accepts the same purposes and counts in any order', () => {
    expect(
      sameUnreadable(
        normalisedUnreadable([e('bot_instance.token', 2), e('panel.password', 1)]),
        recorded,
      ),
    ).toBe(true);
  });

  it.each([
    ['a different count', [e('bot_instance.token', 3), e('panel.password', 1)]],
    ['a missing purpose', [e('bot_instance.token', 2)]],
    [
      'an extra purpose',
      [e('bot_instance.token', 2), e('panel.password', 1), e('panel.username', 1)],
    ],
    // The same total, split differently across a duplicated purpose.
    [
      'a split purpose',
      [e('bot_instance.token', 1), e('bot_instance.token', 1), e('panel.password', 1)],
    ],
    ['the same total on other purposes', [e('bot_instance.token', 1), e('panel.password', 2)]],
  ])('refuses %s', (_name, list) => {
    expect(sameUnreadable(normalisedUnreadable(list), recorded)).toBe(false);
  });
});

describe('the executor clears only within what was acknowledged', () => {
  const acknowledged = [e('bot_instance.token', 2), e('panel.password', 1)];

  it('allows the same or fewer per purpose (a key imported since)', () => {
    expect(withinAcknowledged(acknowledged, acknowledged)).toBe(true);
    expect(withinAcknowledged([e('bot_instance.token', 1)], acknowledged)).toBe(true);
    expect(withinAcknowledged([], acknowledged)).toBe(true);
  });

  it('refuses more of a purpose, or a purpose never acknowledged', () => {
    expect(withinAcknowledged([e('bot_instance.token', 3)], acknowledged)).toBe(false);
    expect(withinAcknowledged([e('backup.archive_password', 1)], acknowledged)).toBe(false);
  });
});

const trial = (unreadable: number): SecretTrialReport => ({
  byPurpose: [
    { purpose: 'bot_instance.token', readable: 1, unreadable },
    { purpose: 'backup.archive_password', readable: 1, unreadable: 0 },
  ],
  unreadable: Array.from({ length: unreadable }, (_, n) => ({
    purpose: 'bot_instance.token' as const,
    table: 'bot_instances',
    column: 'token_ciphertext',
    entityId: `bot-${String(n)}`,
    tenantId: 't',
  })),
  readableTotal: 2,
  unreadableTotal: unreadable,
});

describe('botctl output', () => {
  it('`secrets verify` exits 0 only when nothing is unreadable, naming the place in Persian', () => {
    expect(verifyReport(trial(0)).exitCode).toBe(0);
    const bad = verifyReport(trial(2));
    expect(bad.exitCode).toBe(1);
    expect(bad.text).toContain('دوباره وارد کنید در: ربات‌ها');
    expect(verifyReport(trial(0)).text).not.toContain('دوباره وارد کنید در');
  });

  it('`botctl restore` refuses in Persian, with kinds, counts and the one way on — never a kit', () => {
    const text = unreadableRefusalFa(trial(2), false);
    expect(text).toContain('توکن ربات (bot_instance.token): 2');
    expect(text).toContain('«ادامه؛ این‌ها را دوباره وارد می‌کنم»');
    expect(text).not.toMatch(/[A-Z]{4,}/);
    // SFR A1: the kit is removed — never offered; an old archive is told why.
    expect(text).not.toContain('«بارگذاری کیت بازیابی سرور قبلی»');
    expect(text).not.toContain('--kit');
    expect(text).toContain('کیت بازیابی حذف شده است');
    expect(unreadableRefusalFa(trial(2), true)).not.toContain('کیت بازیابی');
  });

  it('`secrets status` lists every held key with its fingerprint, source and whether it is active', () => {
    const ours = randomBytes(32);
    const theirs = randomBytes(32);
    const keyring = new InstallationKeyring({
      activeKeyId: 'install-20261107',
      keys: new Map([['install-20261107', ours]]),
      format: 'canonical',
    });
    keyring.replaceImported(new Map([['install-20261107', theirs]]));
    const lines = heldKeyLines(keyring).join('\n');
    expect(lines).toContain(`install-20261107  ${kekFingerprint(ours)}  configured  active`);
    expect(lines).toContain(`install-20261107  ${kekFingerprint(theirs)}  imported  -`);
    expect(lines).not.toContain(ours.toString('base64'));
    expect(lines).not.toContain(theirs.toString('hex'));
  });
});
