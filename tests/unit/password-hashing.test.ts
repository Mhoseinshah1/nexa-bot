import { describe, expect, it } from 'vitest';
import {
  FAST_SCRYPT,
  PRODUCTION_SCRYPT,
  ScryptPasswordHasher,
  scryptParamsFor,
} from '../../apps/api/src/infrastructure/crypto/password-hasher';

// The suite hashes many times; production parameters cost ~128 MiB and a
// meaningful fraction of a second each. One test below pays that price on
// purpose, to prove the production profile actually works.
const hasher = new ScryptPasswordHasher(FAST_SCRYPT);

describe('password hashing', () => {
  it('never stores the plaintext', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    expect(encoded).not.toContain('correct');
    expect(encoded).not.toContain('staple');
  });

  it('round-trips the correct password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery staple', encoded)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const encoded = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify('correct horse battery stapler', encoded)).toBe(false);
    expect(await hasher.verify('', encoded)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without a per-hash salt, two admins with the same password are visibly
    // the same row, and one cracked hash is every account using that password.
    const a = await hasher.hash('same-password-for-both');
    const b = await hasher.hash('same-password-for-both');
    expect(a).not.toBe(b);
    expect(await hasher.verify('same-password-for-both', a)).toBe(true);
    expect(await hasher.verify('same-password-for-both', b)).toBe(true);
  });

  it('records its algorithm and parameters in the stored value', async () => {
    // This is what makes raising the cost — or replacing scrypt entirely — a
    // rehash on next login instead of a migration and a forced reset.
    const encoded = await hasher.hash('whatever');
    const [algorithm, N, r, p] = encoded.split('$');
    expect(algorithm).toBe('scrypt');
    expect(Number(N)).toBe(FAST_SCRYPT.N);
    expect(Number(r)).toBe(FAST_SCRYPT.r);
    expect(Number(p)).toBe(FAST_SCRYPT.p);
  });

  it('asks for a rehash when the stored cost is below current policy', async () => {
    const weak = await new ScryptPasswordHasher(FAST_SCRYPT).hash('shared');
    const strict = new ScryptPasswordHasher({ N: 4096, r: 8, p: 1 });
    expect(strict.needsRehash(weak)).toBe(true);
    // And not when it already meets policy.
    expect(new ScryptPasswordHasher(FAST_SCRYPT).needsRehash(weak)).toBe(false);
  });

  it('treats a malformed stored value as a failed verification, not a crash', async () => {
    // A corrupted row must fail one login, not take the endpoint down for
    // everyone — and must never verify as true.
    for (const broken of ['', 'not-a-hash', 'scrypt$1$2', 'argon2$x$y$z$w$v', 'scrypt$0$0$0$a$b']) {
      expect(await hasher.verify('anything', broken)).toBe(false);
      expect(hasher.needsRehash(broken)).toBe(true);
    }
  });

  it('spends work for a username that does not exist', async () => {
    // Equalising the timing of "no such user" and "wrong password" is what
    // stops the login endpoint being a username oracle regardless of how
    // identical the error text is.
    await expect(hasher.spendDummyWork()).resolves.toBeUndefined();
  });

  it('verifies a password hashed at production cost', async () => {
    // Deliberately slow, and deliberately present: the fast profile is a test
    // affordance, and a suite that only ever exercises it would not notice
    // production parameters failing outright.
    const production = new ScryptPasswordHasher(PRODUCTION_SCRYPT);
    const encoded = await production.hash('a production strength password');
    expect(await production.verify('a production strength password', encoded)).toBe(true);
    expect(await production.verify('wrong', encoded)).toBe(false);
    expect(production.needsRehash(encoded)).toBe(false);
  });

  it('maps the config profile to parameters, and production never gets the cheap one', () => {
    expect(scryptParamsFor('production')).toEqual(PRODUCTION_SCRYPT);
    expect(scryptParamsFor('fast')).toEqual(FAST_SCRYPT);
    expect(PRODUCTION_SCRYPT.N).toBeGreaterThanOrEqual(131_072);
  });
});
