import { describe, expect, it } from 'vitest';
import {
  backupCodeSchema,
  BACKUP_CODE_COUNT,
  loginOutcomeResponseSchema,
  reauthenticateWithSecondFactorSchema,
  secondFactorProofSchema,
  TOTP_PARAMETERS,
  totpCodeSchema,
} from '@nexa/contracts';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  matchTotp,
  otpauthUri,
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  formatBackupCode,
  generateBackupCodes,
  hashBackupCode,
  normaliseBackupCode,
} from '../../apps/api/src/modules/platform/identity/application/backup-codes';
import { credentialFingerprint } from '../../apps/api/src/modules/platform/identity/application/second-factor-proof';
import { parseResetArgs } from '../../apps/api/src/admin-2fa-reset.cli';

/**
 * Phase D2's pure parts: RFC 6238 against the RFC's own vectors, the replay and skew
 * rules, backup-code generation and normalisation, and the recovery CLI's arguments.
 */

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII string "12345678901234567890".
const RFC_KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET = base32Encode(RFC_KEY);

describe('RFC 6238 / RFC 4226', () => {
  it('reproduces the RFC 6238 SHA-1 test vectors (8 digits)', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      expect(hotp(RFC_KEY, Math.floor(seconds / 30), 8), String(seconds)).toBe(expected);
    }
  });

  it('reproduces the RFC 4226 Appendix D HOTP values (6 digits)', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922'];
    expected.forEach((code, counter) => expect(hotp(RFC_KEY, counter)).toBe(code));
  });

  it('uses the authenticator-compatible parameters', () => {
    expect(TOTP_PARAMETERS).toMatchObject({ algorithm: 'SHA1', digits: 6, periodSeconds: 30 });
  });

  it('round-trips base32 and generates a 160-bit secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(base32Decode(base32Encode(RFC_KEY)).equals(RFC_KEY)).toBe(true);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('builds the otpauth URI with every parameter spelled out', () => {
    const uri = otpauthUri({ issuer: 'Nexa', account: 'owner', secret: RFC_SECRET });
    expect(uri.startsWith('otpauth://totp/Nexa:owner?')).toBe(true);
    const query = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(query.get('secret')).toBe(RFC_SECRET);
    expect(query.get('algorithm')).toBe('SHA1');
    expect(query.get('digits')).toBe('6');
    expect(query.get('period')).toBe('30');
    expect(query.get('issuer')).toBe('Nexa');
  });
});

describe('matching a presented code', () => {
  const at = new Date(1_111_111_111_000);
  const step = totpStepAt(at);

  it('accepts the current step and one either side, and nothing further', () => {
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step), at, null)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 1), at, null)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 1), at, null)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 2), at, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 2), at, null)).toBeNull();
  });

  it('refuses a step already used, and every step before it (replay)', () => {
    const code = totpForStep(RFC_SECRET, step);
    expect(matchTotp(RFC_SECRET, code, at, step)).toBeNull();
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step - 1), at, step - 1)).toBeNull();
    // A LATER step than the last one used is still fine.
    expect(matchTotp(RFC_SECRET, totpForStep(RFC_SECRET, step + 1), at, step)).toBe(step + 1);
  });

  it('refuses malformed input without throwing', () => {
    expect(matchTotp(RFC_SECRET, '12345', at, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, '1234567', at, null)).toBeNull();
    expect(matchTotp(RFC_SECRET, 'abcdef', at, null)).toBeNull();
  });
});

describe('backup codes', () => {
  it('generates a full, distinct set of 16-character Crockford codes', () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(BACKUP_CODE_COUNT);
    expect(new Set(codes).size).toBe(BACKUP_CODE_COUNT);
    for (const code of codes)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
  });

  it('forgives case, separators and the usual misreadings, and nothing else', () => {
    const [code] = generateBackupCodes(1);
    const canonical = normaliseBackupCode(code!)!;
    expect(canonical).toHaveLength(16);
    expect(normaliseBackupCode(code!.toLowerCase())).toBe(canonical);
    expect(normaliseBackupCode(code!.replace(/-/g, ' '))).toBe(canonical);
    expect(normaliseBackupCode('O0IL-0000-0000-0000')).toBe('0011000000000000');
    expect(normaliseBackupCode('UUUU-0000-0000-0000')).toBeNull();
    expect(normaliseBackupCode('0000-0000-0000')).toBeNull();
    expect(formatBackupCode(canonical)).toBe(code);
  });

  it('hashes bound to the tenant and the administrator, never the plain code', () => {
    const hash = hashBackupCode('t1', 'a1', 'ABCDEFGHJKMNPQRS');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('ABCDEFGHJKMNPQRS');
    expect(hashBackupCode('t1', 'a2', 'ABCDEFGHJKMNPQRS')).not.toBe(hash);
    expect(hashBackupCode('t2', 'a1', 'ABCDEFGHJKMNPQRS')).not.toBe(hash);
  });

  it('fingerprints a credential without carrying it', () => {
    const fingerprint = credentialFingerprint('scrypt$abc$def');
    expect(fingerprint).not.toContain('scrypt');
    expect(credentialFingerprint('scrypt$abc$deg')).not.toBe(fingerprint);
  });
});

describe('the wire schemas', () => {
  it('requires exactly one proof', () => {
    expect(secondFactorProofSchema.safeParse({ code: '123456' }).success).toBe(true);
    expect(secondFactorProofSchema.safeParse({ backupCode: 'ABCD-EFGH-JKMN-PQRS' }).success).toBe(
      true,
    );
    expect(secondFactorProofSchema.safeParse({}).success).toBe(false);
    expect(
      secondFactorProofSchema.safeParse({ code: '123456', backupCode: 'ABCD-EFGH-JKMN-PQRS' })
        .success,
    ).toBe(false);
    expect(reauthenticateWithSecondFactorSchema.safeParse({ code: '123456' }).success).toBe(false);
    expect(totpCodeSchema.parse(' 123 456 ')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345a').success).toBe(false);
    expect(backupCodeSchema.safeParse('short').success).toBe(false);
  });

  it('tells a challenge apart from a session in the login response', () => {
    const challenge = loginOutcomeResponseSchema.parse({
      secondFactorRequired: true,
      expiresAt: '2026-10-03T00:05:00.000Z',
    });
    expect('secondFactorRequired' in challenge).toBe(true);
    expect('admin' in challenge).toBe(false);
  });
});

describe('the recovery CLI arguments', () => {
  it('needs a username and a reason, and accepts --check without a reason', () => {
    expect(parseResetArgs(['--username', 'owner', '--reason', 'lost phone'])).toEqual({
      username: 'owner',
      reason: 'lost phone',
      tenantSlug: null,
      check: false,
    });
    expect(parseResetArgs(['--check', '--username', 'owner']).check).toBe(true);
    expect(() => parseResetArgs(['--username', 'owner'])).toThrow(/--reason/);
    expect(() => parseResetArgs(['--reason', 'x'])).toThrow(/--username/);
    expect(() => parseResetArgs(['--username'])).toThrow(/needs a value/);
  });

  it('refuses an unknown argument WITHOUT repeating it', () => {
    let message = '';
    try {
      parseResetArgs(['--username', 'owner', '--password', 'hunter2-secret']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Unknown argument/);
    expect(message).not.toContain('hunter2-secret');
    expect(message).not.toContain('--password');
  });
});
