import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordHasher } from '@nexa/contracts';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt.
 *
 * Why scrypt and not Argon2id: Argon2id is the first recommendation, and every
 * Node binding for it is either a native build (which turns a CI runner's
 * toolchain into a dependency of being able to log in) or a prebuilt binary
 * from a single maintainer. scrypt is memory-hard, is in Node's standard
 * library, and OWASP accepts it at these parameters. The stored value names its
 * algorithm, so moving to Argon2id later is a new branch in `verify` plus a
 * rehash on next login — not a migration and not a forced password reset.
 *
 * Parameters: N = 2^17, r = 8, p = 1 — the OWASP minimum for scrypt, costing
 * about 128 MiB and a fraction of a second per hash. `maxmem` is raised
 * accordingly; Node's default 32 MiB would reject our own parameters.
 *
 * The fast profile exists because a suite that hashes at production cost spends
 * minutes doing nothing else. It is selected by an explicit config key that the
 * config schema REFUSES in production — the same shape as AUTH_MODE. Inferring
 * it from NODE_ENV would mean a self-hosted install left on `development`
 * silently stored every password at a thousandth of the intended cost.
 */

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** OWASP minimum for scrypt. Do not lower these for production. */
export const PRODUCTION_SCRYPT: ScryptParams = { N: 131_072, r: 8, p: 1 };

/** Deliberately weak. Config refuses to select this when NODE_ENV=production. */
export const FAST_SCRYPT: ScryptParams = { N: 1_024, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';

function memoryFor(params: ScryptParams): number {
  // scrypt needs roughly 128 * N * r bytes; give it headroom rather than
  // discovering the limit as an exception on the login path.
  return 256 * params.N * params.r;
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly params: ScryptParams = PRODUCTION_SCRYPT) {}

  async hash(plaintext: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await this.derive(plaintext, salt, this.params);
    return [
      PREFIX,
      this.params.N,
      this.params.r,
      this.params.p,
      salt.toString('base64'),
      derived.toString('base64'),
    ].join('$');
  }

  async verify(plaintext: string, encoded: string): Promise<boolean> {
    const parsed = parse(encoded);
    // A malformed stored value is a false, never a throw: a corrupted row must
    // fail one login, not take down the endpoint for everyone.
    if (parsed === null) {
      await this.spendDummyWork();
      return false;
    }

    try {
      const derived = await this.derive(plaintext, parsed.salt, parsed.params);
      if (derived.length !== parsed.digest.length) return false;
      return timingSafeEqual(derived, parsed.digest);
    } catch (error) {
      // The backstop behind `parse`'s validation. OpenSSL enforces constraints
      // of its own — memory floors, internal limits — and a stored value that
      // satisfies our checks but not its own must still fail ONE login rather
      // than returning a 500 that says the account exists and its row is odd.
      void error;
      return false;
    }
  }

  needsRehash(encoded: string): boolean {
    const parsed = parse(encoded);
    if (parsed === null) return true;
    return (
      parsed.params.N < this.params.N ||
      parsed.params.r < this.params.r ||
      parsed.params.p < this.params.p
    );
  }

  /**
   * Spends a real hash against a value nothing can match.
   *
   * Without this, "no such username" returns as fast as the database can say
   * no, while "wrong password" takes as long as a hash — and the difference is
   * a username oracle that no amount of identical error text hides.
   */
  async spendDummyWork(): Promise<void> {
    await this.derive('dummy-verification-work', DUMMY_SALT, this.params);
  }

  private async derive(plaintext: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
    return scryptAsync(Buffer.from(plaintext, 'utf8'), salt, KEY_LENGTH, {
      ...params,
      maxmem: memoryFor(params),
    });
  }
}

const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 7);

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly digest: Buffer;
}

/**
 * Bounds on the parameters a stored hash may name.
 *
 * `N` must be a power of two — scrypt requires it, and `scrypt$3$…` otherwise
 * reaches OpenSSL and throws, turning one administrator's login into a 500 that
 * incidentally confirms their account exists. The upper bounds stop a corrupted
 * or imported row from asking for gigabytes: the parameters are read from the
 * database, so they are only as trustworthy as everything that can write there.
 */
const MAX_N = 2 ** 22;
const MAX_R = 32;
const MAX_P = 16;

function isPowerOfTwo(value: number): boolean {
  return value >= 2 && (value & (value - 1)) === 0;
}

function parse(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  if (!isPowerOfTwo(N) || N > MAX_N) return null;
  if (r < 1 || r > MAX_R) return null;
  if (p < 1 || p > MAX_P) return null;

  try {
    const salt = Buffer.from(parts[4] as string, 'base64');
    const digest = Buffer.from(parts[5] as string, 'base64');
    if (salt.length === 0 || digest.length === 0) return null;
    return { params: { N, r, p }, salt, digest };
  } catch (error) {
    // Buffer.from does not normally throw, but a decode failure here must be a
    // failed verification rather than an unhandled rejection on the login path.
    void error;
    return null;
  }
}

/**
 * Chooses the cost profile from validated configuration.
 *
 * The config schema is what stops `fast` reaching production; this function
 * only maps an already-legal value, so there is no second place for the rule
 * to be stated differently.
 */
export function scryptParamsFor(profile: 'production' | 'fast'): ScryptParams {
  return profile === 'fast' ? FAST_SCRYPT : PRODUCTION_SCRYPT;
}
