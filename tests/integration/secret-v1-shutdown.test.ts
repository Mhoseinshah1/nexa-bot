import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { botInstances, tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import {
  evidenceFrom,
  rewrapColumn,
  shutdownVerdict,
  statusOf,
} from '../../apps/api/src/secrets.cli';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';
import { createTestContext, resetDatabase, type TestContext } from './harness';

/**
 * The v1 shutdown gate, against real rows.
 *
 * `tests/unit/secret-v1-shutdown.test.ts` proves the RULE: given this evidence,
 * ready or not. It cannot prove the evidence is true, and a gate that judges
 * correctly on a miscounted table is a gate that says "ready" to an
 * installation holding v1 ciphertext. So the counting is exercised here, on a
 * real table, through the same `statusOf` the operator's command uses.
 */
const KEY_OLD = Buffer.alloc(32, 4).toString('base64');
const KEY_NEW = Buffer.alloc(32, 6).toString('base64');
const TENANT = '0192f100-0000-7000-8000-00000000bbbb';

const ring = (entries: Record<string, string>, active: string): SecretKeyring => ({
  activeKeyId: active,
  keys: new Map(Object.entries(entries).map(([id, key]) => [id, Buffer.from(key, 'base64')])),
  format: 'canonical',
});

/** A v1 value, produced exactly as the pre-keyring release produced them. */
function v1(plaintext: string, kekBase64: string, keyId: string): string {
  const kek = Buffer.from(kekBase64, 'base64');
  const dataKey = randomBytes(32);
  const wrapIv = randomBytes(12);
  const wrap = createCipheriv('aes-256-gcm', kek, wrapIv);
  const wrapped = Buffer.concat([wrap.update(dataKey), wrap.final()]);
  const wrapTag = wrap.getAuthTag();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b = (buffer: Buffer) => buffer.toString('base64url');
  return ['v1', keyId, b(wrapIv), b(wrapped), b(wrapTag), b(iv), b(body), b(tag)].join('.');
}

describe('the v1 shutdown gate, against real rows', () => {
  let ctx: TestContext;
  const column = SECRET_COLUMNS[0]!;
  const args = { command: 'rewrap' as const, batch: 10, max: Number.MAX_SAFE_INTEGER, keyId: null };

  const bot = (n: number) => `0192f100-0000-7000-8000-0000000000b${n}`;

  const seedRows = async (
    count: number,
    make: (n: number) => { ciphertext: string; keyId: string },
  ) => {
    await ctx.container.database.db.insert(tenants).values({
      id: TENANT,
      kind: 'PRIMARY',
      parentTenantId: null,
      slug: 'shutdown',
      displayName: 'Shutdown',
      status: 'ACTIVE',
      locale: 'fa',
      displayTimezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
    for (let n = 1; n <= count; n += 1) {
      const secret = make(n);
      await ctx.container.database.db.insert(botInstances).values({
        id: bot(n),
        tenantId: TENANT,
        username: `bot_${n}`,
        status: 'ACTIVE',
        tokenCiphertext: secret.ciphertext,
        tokenKeyId: secret.keyId,
      });
    }
  };

  /** The evidence the real command gathers, from the real table. */
  const evidence = async (keyring: SecretKeyring) =>
    evidenceFrom([await statusOf(ctx.container, column)], keyring);

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('an installation with no secret rows at all is ready', async () => {
    // The state the production staging host is in today: zero ciphertext rows,
    // so there is nothing that could be made unreadable.
    const verdict = shutdownVerdict(await evidence(ring({ k: KEY_NEW }, 'k')));
    expect(verdict.blockers).toEqual([]);
    expect(verdict.ready).toBe(true);
  });

  it('one remaining v1 row blocks the shutdown', async () => {
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(
      ring({ old: KEY_OLD }, 'old'),
      true,
    );
    await seedRows(3, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));

    const verdict = shutdownVerdict(await evidence(ring({ old: KEY_OLD }, 'old')));
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('3 row(s) still hold a v1 envelope');
  });

  it('a key-id mismatch blocks the shutdown even with no v1 rows', async () => {
    // The row is v2 and perfectly readable. What is wrong is that the COLUMN
    // names a different key from the envelope, and retirement counts the
    // column — so this is exactly the state that could strand ciphertext.
    const cipher = new AesGcmSecretCipher(ring({ a: KEY_OLD, b: KEY_NEW }, 'a'), false);
    (ctx.container as { cipher: unknown }).cipher = cipher;
    await seedRows(1, (n) => {
      const secret = cipher.encrypt(`token-${n}`, {
        purpose: 'bot_instance.token',
        tenantId: TENANT,
        entityId: bot(n),
      });
      return { ciphertext: secret.ciphertext, keyId: 'b' };
    });

    const gathered = await evidence(ring({ a: KEY_OLD, b: KEY_NEW }, 'a'));
    expect(gathered.v1Rows).toBe(0);
    expect(gathered.mismatchedRows).toBe(1);
    expect(shutdownVerdict(gathered).blockers.join(' ')).toContain(
      'record a key id that is not the one inside',
    );
  });

  it('rewrap clears the blocker, and only then is the shutdown ready', async () => {
    // The whole operator sequence, end to end: v1 rows -> not ready -> rewrap
    // -> ready. Asserting the ready state alone would pass on a gate that
    // always said ready.
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(
      ring({ old: KEY_OLD }, 'old'),
      true,
    );
    await seedRows(4, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));

    expect(shutdownVerdict(await evidence(ring({ old: KEY_OLD }, 'old'))).ready).toBe(false);

    const result = await rewrapColumn(ctx.container, column, args, 'old');
    expect(result.rewrapped).toBe(4);

    const after = await evidence(ring({ old: KEY_OLD }, 'old'));
    expect(after.v1Rows).toBe(0);
    expect(after.mismatchedRows).toBe(0);
    expect(shutdownVerdict(after).ready).toBe(true);
  });

  it('after the shutdown, v2 still decrypts with its context and v1 is refused', async () => {
    // Both halves matter. "v1 is refused" alone is satisfied by a cipher that
    // refuses everything.
    const keyring = ring({ old: KEY_OLD }, 'old');
    const accepting = new AesGcmSecretCipher(keyring, true);
    (ctx.container as { cipher: unknown }).cipher = accepting;
    await seedRows(2, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));
    await rewrapColumn(ctx.container, column, args, 'old');

    const refusing = new AesGcmSecretCipher(keyring, false);
    const rows = await ctx.container.database.db
      .select()
      .from(botInstances)
      .orderBy(botInstances.id);

    for (const [index, row] of rows.entries()) {
      const context = {
        purpose: 'bot_instance.token' as const,
        tenantId: TENANT,
        entityId: row.id,
      };
      expect(
        refusing.decrypt({ keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext }, context),
      ).toBe(`token-${index + 1}`);
      // And a v1 value, presented to the same cipher, is refused.
      expect(() =>
        refusing.decrypt({ keyId: 'old', ciphertext: v1('x', KEY_OLD, 'old') }, context),
      ).toThrow(/v1 acceptance is disabled/);
    }
  });

  it('a v1 row is still refused when it is presented with the right context', async () => {
    // The refusal is about the VERSION, not about a failed authentication. A
    // v1 value that would have decrypted perfectly is the case that proves it.
    const keyring = ring({ old: KEY_OLD }, 'old');
    const accepting = new AesGcmSecretCipher(keyring, true);
    const refusing = new AesGcmSecretCipher(keyring, false);
    const context = { purpose: 'bot_instance.token' as const, tenantId: TENANT, entityId: bot(1) };
    const value = v1('a-real-token', KEY_OLD, 'old');

    expect(accepting.decrypt({ keyId: 'old', ciphertext: value }, context)).toBe('a-real-token');
    expect(() => refusing.decrypt({ keyId: 'old', ciphertext: value }, context)).toThrow(
      /v1 acceptance is disabled/,
    );
  });
});
