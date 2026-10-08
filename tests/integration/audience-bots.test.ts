import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  audienceOptionsResponseSchema,
  type ActorContext,
  canonicalAudienceDefinition,
  type Clock,
} from '@nexa/contracts';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import type {
  BroadcastDeliverRequest,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import { DrizzleBroadcastRepository } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Roadmap C3 — the audience by the bot a customer is reached through, an existing primitive
 * (`customers.first_bot_instance_id`, the bot a broadcast freezes onto each recipient). One
 * predicate in the one audience builder, so the preview, a broadcast's frozen recipients, a
 * mass action and a campaign all read it the same way.
 */

class StoppedClock implements Clock {
  private readonly at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
}

describe('the audience by bot (roadmap C3)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let fixtures: AudienceFixtures;
  let n = 0;
  const key = () => `aud-bot-${(n += 1)}-${Date.now()}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-audbot', roleKeys: ['owner'] }),
    );
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
  });

  async function audience() {
    return {
      one: await fixtures.customer({ telegramUserId: '640001', botInstanceId: SEED_IDS.botA1 }),
      two: await fixtures.customer({ telegramUserId: '640002', botInstanceId: SEED_IDS.botA2 }),
      three: await fixtures.customer({ telegramUserId: '640003', botInstanceId: SEED_IDS.botA2 }),
      none: await fixtures.customer({ telegramUserId: '640004', botInstanceId: null }),
    };
  }

  it('selects the customers of the named bots only; no bot, and another tenant’s bot, select nobody', async () => {
    const ids = await audience();
    const count = async (definition: unknown) =>
      (await ctx.container.audience.evaluate(tenantA, definition)).customers;
    expect(await count({ version: 1 })).toBe(4);
    expect(await count({ version: 1, botInstanceIds: [SEED_IDS.botA2] })).toBe(2);
    expect(await count({ version: 1, botInstanceIds: [SEED_IDS.botA1, SEED_IDS.botA2] })).toBe(3);
    expect(await count({ version: 1, botInstanceIds: [SEED_IDS.botB1] })).toBe(0);
    // Combined with another dimension, both hold.
    expect(
      await count({ version: 1, botInstanceIds: [SEED_IDS.botA2], customerIds: [ids.two] }),
    ).toBe(1);
    const sample = await ctx.container.audience.sampleOf(
      tenantA,
      canonicalAudienceDefinition({ version: 1, botInstanceIds: [SEED_IDS.botA1] }),
      new Date(),
    );
    expect(sample.map((row) => row.id)).toEqual([ids.one]);
  });

  it('freezes a broadcast to the bot’s customers and sends through that bot only', async () => {
    await audience();
    const sends: BroadcastDeliverRequest[] = [];
    const transport: BroadcastTransport = {
      render: async (_scope, request) => ({
        ok: true,
        rendered: {
          contentKind: request.contentKind,
          text: request.body,
          buttons: request.buttons,
          source: request.source,
        },
      }),
      deliver: async (_scope, request): Promise<BroadcastSendResult> => {
        sends.push(request);
        return { outcome: 'SENT', messageId: sends.length };
      },
      pin: async () => ({ outcome: 'PINNED' }),
    };
    const draft = await ctx.container.broadcasts.create(tenantA, owner, {
      idempotencyKey: key(),
      title: 'bot two',
      contentKind: 'TEXT',
      body: 'سلام',
      buttons: [],
      audience: { version: 1, botInstanceIds: [SEED_IDS.botA2] },
    });
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, draft.id);
    expect(preview.customers).toBe(2);
    await ctx.container.broadcasts.launch(tenantA, owner, draft.id, {
      idempotencyKey: key(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: draft.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    await new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(ctx.container.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(ctx.container.database.db, async () => 'IRT'),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      clock: new StoppedClock(),
      ids: ctx.container.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
    }).pass(tenantA);
    expect(sends.map((s) => s.chatId).sort()).toEqual(['640002', '640003']);
    expect(new Set(sends.map((s) => s.botInstanceId))).toEqual(new Set([SEED_IDS.botA2]));
    const stored = await ctx.container.database.db.execute<{ definition: unknown }>(
      sql`SELECT audience_definition AS definition FROM broadcasts WHERE id = ${draft.id}::uuid`,
    );
    expect(stored.rows[0]?.definition).toMatchObject({ botInstanceIds: [SEED_IDS.botA2] });
  });

  it('offers the tenant’s own bots by name and status, never a token, and nobody else’s', async () => {
    const options = await ctx.container.audience.options(tenantA, owner);
    const parsed = audienceOptionsResponseSchema.parse({
      currency: options.currency,
      resellerTiers: [...options.resellerTiers],
      products: [...options.products],
      panels: [...options.panels],
      tags: [...options.tags],
      bots: [...options.bots],
    });
    expect(parsed.bots.map((bot) => bot.id).sort()).toEqual(
      [SEED_IDS.botA1, SEED_IDS.botA2].sort(),
    );
    for (const bot of options.bots) {
      expect(Object.keys(bot).sort()).toEqual(['id', 'status', 'username']);
    }
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-audbot-b',
        roleKeys: ['owner'],
      }),
    );
    const other = await ctx.container.audience.options(tenantB, ownerB);
    expect(other.bots.map((bot) => bot.id)).toEqual([SEED_IDS.botB1]);
  });
});
