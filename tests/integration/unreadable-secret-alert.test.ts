import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PLATFORM_ERROR_CODES, type BotInstanceId } from '@nexa/contracts';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * NEXA-FIX-RESTORE-SECRETS §2.6, through the real container: the bot token path every loop
 * reads (`container.botInstances`) goes through the reporting cipher, and the real recorder
 * and condition reader turn a token that stopped decrypting into ONE open Web Admin
 * condition, however many times it is read, and close it once the token is re-entered.
 *
 * The unreadable value is a well-formed envelope sealed for another row — the same
 * `platform.secret_auth_failed` a restore onto a key with the same id and other material
 * produces. Synthetic data only.
 */

const BOT = SEED_IDS.botA1 as BotInstanceId;

describe('an unreadable bot token on a running installation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function storeToken(entityId: string): Promise<void> {
    const sealed = ctx.container.cipher.encrypt('123456:AAunreadable-test-token', {
      purpose: 'bot_instance.token',
      tenantId: tenantA.tenantId,
      entityId,
    });
    await ctx.container.database.db.execute(sql`
      UPDATE bot_instances
         SET token_ciphertext = ${sealed.ciphertext}, token_key_id = ${sealed.keyId}
       WHERE id = ${BOT}`);
  }

  async function events(): Promise<
    {
      code: string;
      dedupe_key: string | null;
      occurrence_count: number;
      resolved: boolean;
      context: Record<string, unknown> | null;
    }[]
  > {
    const result = await ctx.container.database.db.execute(sql`
      SELECT code, dedupe_key, occurrence_count, resolved_at IS NOT NULL AS resolved, context
        FROM operational_events
       WHERE tenant_id = ${tenantA.tenantId} AND code LIKE 'secrets.%'
       ORDER BY first_seen_at, id`);
    return result.rows as never;
  }

  it('opens one condition for many reads, and closes it when the token is re-entered', async () => {
    // Sealed for ANOTHER row: authenticates nowhere but there.
    await storeToken('01900000-0000-7000-8000-00000000ffff');
    for (let read = 0; read < 25; read += 1) {
      await expect(
        ctx.container.botInstances.tokenForBotInstance(tenantA, BOT),
      ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED });
    }
    await vi.waitFor(async () => expect(await events()).toHaveLength(1));
    // Give any stray per-read recording time to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await events()).toEqual([
      {
        code: 'secrets.read_failed',
        dedupe_key: 'secrets.read_failed:BOT_TOKEN',
        occurrence_count: 1,
        resolved: false,
        // Survives the recorder's redaction: the alerts page reads `kind`, and a process that
        // did not raise it closes it only by reading a secret on `unreadable`.
        context: expect.objectContaining({
          kind: 'BOT_TOKEN',
          unreadable: [`bot_instance.token|${BOT}`],
        }),
      },
    ]);

    // The owner re-enters it (here: sealed for the right row). The next read closes it.
    await storeToken(BOT);
    await expect(ctx.container.botInstances.tokenForBotInstance(tenantA, BOT)).resolves.toBe(
      '123456:AAunreadable-test-token',
    );
    await vi.waitFor(async () => {
      const rows = await events();
      expect(rows.map((row) => [row.code, row.resolved])).toEqual([
        ['secrets.read_failed', true],
        ['secrets.read_ok', false],
      ]);
    });
  });
});
