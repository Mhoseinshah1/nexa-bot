import { describe, expect, it } from 'vitest';
import { parseKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * The keyring, and the boot it refuses.
 *
 * A misconfigured keyring makes every stored secret unreadable, so every
 * problem with it is a boot failure rather than a first-read failure — an
 * installation that starts and then cannot resolve a bot token has already
 * told the operator it was fine.
 */
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const problems = (input: Parameters<typeof parseKeyring>[0]): readonly string[] => {
  const result = parseKeyring(input);
  if (result.ok) throw new Error('the keyring was accepted');
  return result.problems;
};

describe('the secret keyring', () => {
  it('accepts several decryption keys and one active key', () => {
    const result = parseKeyring({
      SECRETS_KEYS: `old-2026:${KEY_A},new-2027:${KEY_B}`,
      SECRETS_ACTIVE_KEY_ID: 'new-2027',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyring.activeKeyId).toBe('new-2027');
    expect([...result.keyring.keys.keys()]).toEqual(['old-2026', 'new-2027']);
  });

  it('needs no explicit active key when there is only one', () => {
    const result = parseKeyring({ SECRETS_KEYS: `only:${KEY_A}` });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyring.activeKeyId).toBe('only');
  });

  it('refuses to guess the active key when there is more than one', () => {
    // Falling back to the first entry would make the encryption key depend on
    // the order somebody typed them in during a rotation.
    expect(problems({ SECRETS_KEYS: `a:${KEY_A},b:${KEY_B}` }).join(' ')).toContain(
      'SECRETS_ACTIVE_KEY_ID is required',
    );
  });

  it('refuses an active key that names no configured key', () => {
    expect(
      problems({ SECRETS_KEYS: `a:${KEY_A}`, SECRETS_ACTIVE_KEY_ID: 'b' }).join(' '),
    ).toContain('names no configured key');
  });

  it('refuses a duplicate key id rather than taking the last one', () => {
    // Last-wins means an operator appending a rotated key under a name already
    // in use silently replaces the key existing rows need.
    expect(problems({ SECRETS_KEYS: `a:${KEY_A},a:${KEY_B}` }).join(' ')).toContain(
      'appears more than once',
    );
  });

  it('refuses malformed entries, wrong-sized keys and all-zero keys', () => {
    expect(problems({ SECRETS_KEYS: 'no-separator' }).join(' ')).toContain('is not an id:key pair');
    expect(problems({ SECRETS_KEYS: 'a b:' + KEY_A }).join(' ')).toContain('must be 1-64');
    expect(problems({ SECRETS_KEYS: 'a:c2hvcnQ=' }).join(' ')).toContain('exactly 32 bytes');
    expect(
      problems({ SECRETS_KEYS: `a:${Buffer.alloc(32, 0).toString('base64')}` }).join(' '),
    ).toContain('all zero bytes');
    expect(problems({ SECRETS_KEYS: 'a:!!!not-base64!!!' }).join(' ')).toContain('valid base64');
  });

  it('refuses an empty configuration', () => {
    expect(problems({}).join(' ')).toContain('no secret keys are configured');
  });

  it('reports every problem at once', () => {
    // The config schema's existing contract: an operator fixing one line at a
    // time across four restarts is how a five-minute edit takes an hour.
    expect(problems({ SECRETS_KEYS: `a:c2hvcnQ=,a b:${KEY_A}` }).length).toBeGreaterThan(1);
  });

  it('never puts key material in a problem message', () => {
    for (const message of problems({ SECRETS_KEYS: `a:${KEY_A},a:${KEY_B}` })) {
      expect(message).not.toContain(KEY_A);
      expect(message).not.toContain(KEY_B);
    }
  });

  describe('the installations that already exist', () => {
    it('aliases a legacy single KEK into a one-entry keyring', () => {
      // Every host installed before this release has these two and nothing
      // else. Adopting v2 must not require a reinstall or a hand-edit.
      const result = parseKeyring({ SECRETS_KEK: KEY_A, SECRETS_KEK_ID: 'install-20260903' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.keyring.activeKeyId).toBe('install-20260903');
      expect(
        result.keyring.keys.get('install-20260903')?.equals(Buffer.from(KEY_A, 'base64')),
      ).toBe(true);
    });

    it('prefers SECRETS_KEYS when both spellings are present', () => {
      const result = parseKeyring({
        SECRETS_KEYS: `new:${KEY_B}`,
        SECRETS_KEK: KEY_A,
        SECRETS_KEK_ID: 'old',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect([...result.keyring.keys.keys()]).toEqual(['new']);
    });

    it('refuses half a legacy pair', () => {
      expect(problems({ SECRETS_KEK: KEY_A }).join(' ')).toContain('SECRETS_KEK_ID is not');
      expect(problems({ SECRETS_KEK_ID: 'only' }).join(' ')).toContain('SECRETS_KEK is not');
    });
  });
});
