import { createCipheriv, randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { botInstances, tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import { dependenciesOn, report, rewrapColumn, statusOf } from '../../apps/api/src/secrets.cli';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';
import { createTestContext, resetDatabase, type TestContext } from './harness';

/**
 * Re-encryption, against a real database.
 *
 * The rewrap is the operation that makes rotation finishable: a keyring lets an
 * old key keep working, and this is what stops "keeps working" from meaning
 * "forever". Its three claimed properties — bounded, resumable, idempotent —
 * are only claims until a real table with real concurrent writers is walked, so
 * that is what happens here.
 */
const KEY_OLD = Buffer.alloc(32, 7).toString('base64');
const KEY_NEW = Buffer.alloc(32, 9).toString('base64');

const TENANT = '0192f100-0000-7000-8000-00000000aaaa';

const ring = (entries: Record<string, string>, active: string): SecretKeyring => ({
  activeKeyId: active,
  keys: new Map(Object.entries(entries).map(([id, key]) => [id, Buffer.from(key, 'base64')])),
});

/** A v1 value, produced exactly as the previous release produced them. */
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

describe('secret rewrap', () => {
  let ctx: TestContext;
  const column = SECRET_COLUMNS[0]!;
  const args = { command: 'rewrap' as const, batch: 2, max: Number.MAX_SAFE_INTEGER, keyId: null };

  /** The container's cipher, replaced so the suite decides the keyring. */
  const withKeyring = (keys: Record<string, string>, active: string, acceptV1 = true) => {
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(
      ring(keys, active),
      acceptV1,
    );
  };

  const bot = (n: number) => `0192f100-0000-7000-8000-0000000000${n.toString().padStart(2, '0')}`;

  const seedRows = async (
    count: number,
    make: (n: number) => { ciphertext: string; keyId: string },
  ) => {
    await ctx.container.database.db.insert(tenants).values({
      id: TENANT,
      kind: 'PRIMARY',
      parentTenantId: null,
      slug: 'rewrap',
      displayName: 'Rewrap',
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

  const rows = async () =>
    ctx.container.database.db.select().from(botInstances).orderBy(botInstances.id);

  const status = async () => statusOf(ctx.container, column);

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('re-encrypts v1 rows to v2 under the active key, and says what it did', async () => {
    withKeyring({ old: KEY_OLD }, 'old');
    await seedRows(3, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));

    const before = await status();
    expect(before.byVersion.get('v1')).toBe(3);

    const result = await rewrapColumn(ctx.container, column, args, 'old');
    expect(result).toEqual({ scanned: 3, rewrapped: 3, skipped: 0 });

    const after = await status();
    expect(after.byVersion.get('v2')).toBe(3);
    expect(after.byVersion.get('v1')).toBeUndefined();
    // And the values survived. This is the assertion that would catch a rewrap
    // that "succeeded" by writing something unreadable.
    for (const [index, row] of (await rows()).entries()) {
      expect(
        ctx.container.cipher.decrypt(
          { keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext },
          { purpose: 'bot_instance.token', tenantId: TENANT, entityId: row.id },
        ),
      ).toBe(`token-${index + 1}`);
    }
  });

  it('moves rows to a new active key while the old one still decrypts', async () => {
    withKeyring({ old: KEY_OLD }, 'old');
    await seedRows(2, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));

    // The rotation: both keys present, the new one active.
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await rewrapColumn(ctx.container, column, args, 'new');

    const after = await status();
    expect(after.byKeyId.get('new')).toBe(2);
    expect(after.byKeyId.get('old')).toBeUndefined();
  });

  it('is bounded by --max and resumes from where the data is, not from a cursor it saved', async () => {
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await seedRows(5, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));

    const partial = await rewrapColumn(ctx.container, column, { ...args, max: 2 }, 'new');
    expect(partial.rewrapped).toBe(2);

    // The mixed state an interruption leaves. Every row still reads.
    const mixed = await status();
    expect(mixed.byVersion.get('v1')).toBe(3);
    expect(mixed.byVersion.get('v2')).toBe(2);
    for (const row of await rows()) {
      expect(() =>
        ctx.container.cipher.decrypt(
          { keyId: row.tokenKeyId, ciphertext: row.tokenCiphertext },
          { purpose: 'bot_instance.token', tenantId: TENANT, entityId: row.id },
        ),
      ).not.toThrow();
    }

    // Resumed by re-running from the beginning: there is no saved cursor to
    // lose, which is what makes a killed run safe.
    const rest = await rewrapColumn(ctx.container, column, args, 'new');
    expect(rest.rewrapped).toBe(3);
    expect(rest.skipped).toBe(2);
    expect((await status()).byVersion.get('v2')).toBe(5);
  });

  it('performs zero writes once it has converged', async () => {
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await seedRows(3, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));
    await rewrapColumn(ctx.container, column, args, 'new');

    const converged = (await rows()).map((row) => row.tokenCiphertext);
    const again = await rewrapColumn(ctx.container, column, args, 'new');
    expect(again).toEqual({ scanned: 3, rewrapped: 0, skipped: 3 });
    // Not merely "reported zero": the bytes are identical.
    expect((await rows()).map((row) => row.tokenCiphertext)).toEqual(converged);
  });

  it('does not touch updated_at', async () => {
    // Re-encrypting a stored value is cryptographic maintenance, not a change
    // to the bot instance. A timestamp that moved would tell every reader of
    // that column otherwise.
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await seedRows(2, (n) => ({ ciphertext: v1(`token-${n}`, KEY_OLD, 'old'), keyId: 'old' }));
    const before = (await rows()).map((row) => row.updatedAt.getTime());

    await rewrapColumn(ctx.container, column, args, 'new');
    expect((await rows()).map((row) => row.updatedAt.getTime())).toEqual(before);
  });

  it('does not clobber a business write that landed first', async () => {
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await seedRows(1, () => ({ ciphertext: v1('original', KEY_OLD, 'old'), keyId: 'old' }));

    // A replacement token, written the way a real feature would: v2, active
    // key, correct context. The rewrap must leave it alone rather than
    // overwrite it with a re-encryption of the value it replaced.
    const replacement = ctx.container.cipher.encrypt('replaced', {
      purpose: 'bot_instance.token',
      tenantId: TENANT,
      entityId: bot(1),
    });
    await ctx.container.database.db
      .update(botInstances)
      .set({ tokenCiphertext: replacement.ciphertext, tokenKeyId: replacement.keyId })
      .where(eq(botInstances.id, bot(1)));

    const result = await rewrapColumn(ctx.container, column, args, 'new');
    expect(result.rewrapped).toBe(0);
    const [row] = await rows();
    expect(
      ctx.container.cipher.decrypt(
        { keyId: row!.tokenKeyId, ciphertext: row!.tokenCiphertext },
        { purpose: 'bot_instance.token', tenantId: TENANT, entityId: bot(1) },
      ),
    ).toBe('replaced');
  });

  it('writes an audit row per rewrap, and no plaintext into it', async () => {
    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    await seedRows(1, () => ({
      ciphertext: v1('a-real-looking-token', KEY_OLD, 'old'),
      keyId: 'old',
    }));
    await rewrapColumn(ctx.container, column, args, 'new');

    const audits = await ctx.container.database.db.execute(
      `SELECT action, entity_type, before, after FROM audit_logs WHERE action = 'secret.rewrap'` as never,
    );
    const list = audits as unknown as { rows: { after: Record<string, unknown> }[] };
    expect(list.rows).toHaveLength(1);
    expect(JSON.stringify(list.rows[0])).not.toContain('a-real-looking-token');
    expect(list.rows[0]!.after).toMatchObject({ keyId: 'new', version: 'v2' });
  });
});

describe('secret status and retire-check', () => {
  let ctx: TestContext;
  const column = SECRET_COLUMNS[0]!;

  const seedOne = async (ciphertext: string, keyId: string) => {
    await ctx.container.database.db.insert(tenants).values({
      id: TENANT,
      kind: 'PRIMARY',
      parentTenantId: null,
      slug: 'status',
      displayName: 'Status',
      status: 'ACTIVE',
      locale: 'fa',
      displayTimezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
    await ctx.container.database.db.insert(botInstances).values({
      id: '0192f100-0000-7000-8000-000000000001',
      tenantId: TENANT,
      username: 'bot_1',
      status: 'ACTIVE',
      tokenCiphertext: ciphertext,
      tokenKeyId: keyId,
    });
  };

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('refuses to call a key retirable while rows still name it', async () => {
    await seedOne(v1('token', KEY_OLD, 'old'), 'old');
    const status = await statusOf(ctx.container, column);
    expect(dependenciesOn([status], 'old')).toBe(1);
    expect(report([status]).healthy).toBe(true);
  });

  it('reports zero dependencies once nothing names the key', async () => {
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(
      ring({ old: KEY_OLD, new: KEY_NEW }, 'new'),
      true,
    );
    await seedOne(v1('token', KEY_OLD, 'old'), 'old');
    await rewrapColumn(
      ctx.container,
      column,
      { command: 'rewrap', batch: 10, max: Number.MAX_SAFE_INTEGER, keyId: null },
      'new',
    );
    const status = await statusOf(ctx.container, column);
    expect(dependenciesOn([status], 'old')).toBe(0);
    expect(dependenciesOn([status], 'new')).toBe(1);
  });

  it('fails closed when a row records a key its envelope does not name', async () => {
    // The bookkeeping contradiction retirement must never look past: the
    // dependency count reads the COLUMN, so a row whose column lies could let a
    // key be retired while a ciphertext still needs it.
    await seedOne(v1('token', KEY_OLD, 'old'), 'new');
    const status = await statusOf(ctx.container, column);
    expect(status.mismatched).toBe(1);
    const { healthy, text } = report([status]);
    expect(healthy, 'a lying key-id column was reported as healthy').toBe(false);
    expect(text).toContain('MISMATCH');
    // And the count it would have trusted is the wrong one, which is the point.
    expect(dependenciesOn([status], 'old')).toBe(0);
  });
});
