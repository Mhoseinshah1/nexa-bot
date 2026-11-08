import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  type BotInstanceId,
  type SecretCipher,
  type SecretContext,
} from '@nexa/contracts';
import {
  ReportingSecretCipher,
  UnreadableSecretReporter,
} from '../../apps/api/src/modules/platform/opslog/application/unreadable-secret-reporter';
import { DrizzleOperationalEventRecorder } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-events';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
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

  /*
   * Codex on #424: two processes reporting two unreadable secrets of one kind at once both
   * read the old context and wrote their own list, so the last write dropped the other row,
   * and repairing the listed one closed the alert over a secret still broken. The list is
   * now merged, and the close decided, under the recorder's row lock.
   */
  it('keeps both rows of two concurrent reports listed, and closes only when both read', async () => {
    const quiet = { warn: () => undefined, info: () => undefined };
    const inner: SecretCipher = {
      encrypt: () => ({ keyId: 'k', ciphertext: 'good' }),
      decrypt(secret) {
        if (secret.ciphertext.startsWith('good')) return 'plain';
        throw new NexaError({
          kind: 'INTERNAL',
          code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
          message: 'A stored secret failed authenticated decryption.',
        });
      },
      mask: () => '****',
    };
    // Two processes: their own reporter each, one database.
    const processes = [0, 1].map(() => {
      const reporter = new UnreadableSecretReporter({
        recorder: new DrizzleOperationalEventRecorder(
          ctx.applicationDatabase.db,
          ctx.container.ids,
          ctx.container.clock,
        ),
        conditions: new DrizzleOperationalConditionReader(ctx.applicationDatabase.db),
        clock: ctx.container.clock,
        logger: quiet,
      });
      return { reporter, cipher: new ReportingSecretCipher(inner, reporter) };
    });
    const [a, b] = processes as [(typeof processes)[0], (typeof processes)[0]];
    const panel = (entityId: string): SecretContext => ({
      purpose: 'panel.password',
      tenantId: tenantA.tenantId,
      entityId,
    });
    const x = panel('01900000-0000-7000-8000-0000000000e1');
    const y = panel('01900000-0000-7000-8000-0000000000e2');
    const listed = async (): Promise<{ open: boolean; unreadable: unknown }> => {
      const result = await ctx.container.database.db.execute(sql`
        SELECT resolved_at IS NULL AS open, context->'unreadable' AS unreadable
          FROM operational_events
         WHERE tenant_id = ${tenantA.tenantId}
           AND dedupe_key = 'secrets.read_failed:PANEL_CREDENTIALS'`);
      return result.rows[0] as never;
    };

    // At once: A meets X, B meets Y.
    expect(() => a.cipher.decrypt({ keyId: 'k', ciphertext: 'bad-x' }, x)).toThrow();
    expect(() => b.cipher.decrypt({ keyId: 'k', ciphertext: 'bad-y' }, y)).toThrow();
    await Promise.all([a.reporter.settle(), b.reporter.settle()]);
    expect(await listed()).toEqual({
      open: true,
      unreadable: [`panel.password|${x.entityId}`, `panel.password|${y.entityId}`].sort(),
    });

    // Y is re-entered and B reads it: X is still listed, so the alert stays open.
    for (let read = 0; read < 3; read += 1) {
      b.cipher.decrypt({ keyId: 'k', ciphertext: 'good-y' }, y);
      await b.reporter.settle();
    }
    expect(await listed()).toMatchObject({ open: true });

    // A recovery that names only Y is withheld by the store itself, whatever its caller
    // believed about the list.
    const recorder = new DrizzleOperationalEventRecorder(
      ctx.applicationDatabase.db,
      ctx.container.ids,
      ctx.container.clock,
    );
    const withheld = await recorder.record(tenantA, {
      code: 'secrets.read_ok',
      severity: 'INFO',
      message: 'Stored PANEL_CREDENTIALS secrets read again.',
      recoversCode: 'secrets.read_failed',
      recoversDedupeKey: 'secrets.read_failed:PANEL_CREDENTIALS',
      recoversListed: { key: 'unreadable', read: [`panel.password|${y.entityId}`] },
    });
    expect(withheld.withheld).toBe(true);
    expect(await listed()).toEqual({ open: true, unreadable: [`panel.password|${x.entityId}`] });

    // X is re-entered too: reading it closes the alert.
    for (let read = 0; read < 3; read += 1) {
      b.cipher.decrypt({ keyId: 'k', ciphertext: 'good-x' }, x);
      await b.reporter.settle();
    }
    expect(await listed()).toMatchObject({ open: false });
  });
});
