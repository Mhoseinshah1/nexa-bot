import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { botInstances, tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';
import {
  report,
  rewrapColumn,
  statusOf,
  trialOf,
  verifyReport,
} from '../../apps/api/src/secrets.cli';
import { createTestContext, resetDatabase, type TestContext } from './harness';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.5 and the `secrets rewrap` fix, against a real database.
 *
 * The incident's shape: every row names the active key's id and is sealed under OTHER
 * bytes. `secrets status` counted ids and said all was well; `rewrap` skipped every row
 * by id. Here the same shape is built on purpose.
 */
const ID = 'install-20261107';
const OURS = randomBytes(32);
const THEIRS = randomBytes(32);
const TENANT = '0192f100-0000-7000-8000-00000000bbbb';
const bot = (n: number) => `0192f100-0000-7000-8000-0000000001${n.toString().padStart(2, '0')}`;

/** Our key active; optionally THEIR key held too, under the SAME id (an imported kit). */
const ring = (withTheirs: boolean): SecretKeyring => ({
  activeKeyId: ID,
  keys: new Map([[ID, OURS]]),
  format: 'canonical',
  candidatesFor: (keyId) => (keyId !== ID ? [] : withTheirs ? [OURS, THEIRS] : [OURS]),
});
const sealedBy = (material: Buffer) =>
  new AesGcmSecretCipher(
    { activeKeyId: ID, keys: new Map([[ID, material]]), format: 'canonical' },
    false,
  );

describe('secrets verify, status and rewrap read keys by their bytes', () => {
  let ctx: TestContext;
  const column = SECRET_COLUMNS[0]!;
  const args = { command: 'rewrap' as const, batch: 10, max: Number.MAX_SAFE_INTEGER, keyId: null };
  const useCipher = (withTheirs: boolean) => {
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(ring(withTheirs), false);
  };

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await resetDatabase(ctx.container.database.db);
    await ctx.container.database.db.insert(tenants).values({
      id: TENANT,
      kind: 'PRIMARY',
      parentTenantId: null,
      slug: 'verify',
      displayName: 'Verify',
      status: 'ACTIVE',
      locale: 'fa',
      displayTimezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
    // One row ours, two sealed under THEIR bytes with OUR id — the incident.
    for (const [n, material] of [
      [1, OURS],
      [2, THEIRS],
      [3, THEIRS],
    ] as const) {
      const sealed = sealedBy(material).encrypt(`token-${n}`, {
        purpose: 'bot_instance.token',
        tenantId: TENANT,
        entityId: bot(n),
      });
      await ctx.container.database.db.insert(botInstances).values({
        id: bot(n),
        tenantId: TENANT,
        username: `verify_bot_${n}`,
        status: 'ACTIVE',
        tokenCiphertext: sealed.ciphertext,
        tokenKeyId: sealed.keyId,
      });
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('`secrets verify` reports readable and unreadable per kind, with the place to re-enter, and fails', async () => {
    useCipher(false);
    const trial = await trialOf(ctx.container);
    const verified = verifyReport(trial);
    expect(verified.exitCode).toBe(1);
    expect(verified.text).toContain('bot_instance.token  (توکن ربات)');
    expect(verified.text).toMatch(
      /bot_instance\.token[^\n]*\n {2}readable {4}1\n {2}unreadable {2}2\n/,
    );
    expect(verified.text).toContain('دوباره وارد کنید در: ربات‌ها');
    expect(verified.text).not.toMatch(/token-\d/);
  });

  it('`secrets status` gains an unreadable line from the same check, and is unhealthy', async () => {
    useCipher(false);
    const status = await statusOf(ctx.container, column);
    // Every row names OUR id: the id count alone says "fine".
    expect(status.byKeyId.get(ID)).toBe(3);
    expect(report([status]).healthy).toBe(true);
    const withTrial = report([status], await trialOf(ctx.container));
    expect(withTrial.healthy).toBe(false);
    expect(withTrial.text).toContain('  unreadable  2');
    expect(withTrial.text).toContain('ربات‌ها');
  });

  it('`secrets verify` passes once everything reads', async () => {
    useCipher(true);
    const verified = verifyReport(await trialOf(ctx.container));
    expect(verified.exitCode).toBe(0);
  });

  it('`secrets rewrap` re-seals a same-id row sealed under other bytes, readable by an imported key', async () => {
    useCipher(true);
    const result = await rewrapColumn(ctx.container, column, args, ID);
    // The two foreign rows are rewritten even though they already named the active id;
    // ours is current by its BYTES and is left alone.
    expect(result).toEqual({ scanned: 3, rewrapped: 2, skipped: 1 });
    // Now everything reads under the active key alone.
    useCipher(false);
    const after = await trialOf(ctx.container);
    expect(after.unreadableTotal).toBe(0);
    expect(after.readableTotal).toBe(3);
    // Idempotent: nothing left to do.
    useCipher(true);
    expect(await rewrapColumn(ctx.container, column, args, ID)).toEqual({
      scanned: 3,
      rewrapped: 0,
      skipped: 3,
    });
  });
});
