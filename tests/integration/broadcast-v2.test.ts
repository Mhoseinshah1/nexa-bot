import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BROADCAST_ERROR_CODES,
  BROADCAST_LEASE_MS,
  broadcastOutcome,
  canonicalAudienceDefinition,
  type ActorContext,
  type AudienceDefinitionInput,
  type BroadcastPurpose,
  type Clock,
  type TenantContext,
} from '@nexa/contracts';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import type {
  BroadcastDeliverRequest,
  BroadcastPinResult,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import { DrizzleBroadcastRepository } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import { audienceCustomersQuery } from '../../apps/api/src/modules/commerce/audience/infrastructure/audience-sql';
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
 * Broadcast V2 (program §19, `docs/broadcast-v2.md`) against the real tables and the real
 * dispatcher, with Telegram scripted per chat:
 *
 * - segmentation by every new dimension — tags (program §8) and has / has-no active service —
 *   alone and combined with the existing reseller/customer segment, inside one tenant;
 * - the global marketing opt-out policy still decided at the SEND, ON and OFF, on such an
 *   audience;
 * - two dispatcher replicas running at once never deliver one recipient twice;
 * - "retry failed" re-queues only Telegram's refusals — never an UNKNOWN outcome, never an
 *   unreachable chat, never a delivered one;
 * - the failures-by-reason report sums, per state, to the recipient rows' own counts, and the
 *   derived outcome reads them;
 * - permissions and tenant isolation on the new read.
 */

class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

/** Telegram, scripted per chat, answering after `latencyMs` so concurrent passes overlap. */
class ScriptedTransport implements BroadcastTransport {
  readonly delivered: string[] = [];
  private readonly scripts = new Map<string, BroadcastSendResult[]>();
  latencyMs = 0;

  script(chatId: string, ...results: BroadcastSendResult[]): void {
    this.scripts.set(chatId, results);
  }

  async render(_scope: unknown, request: BroadcastRenderRequest): Promise<BroadcastRenderResult> {
    return {
      ok: true,
      rendered: {
        contentKind: request.contentKind,
        text: request.body,
        buttons: request.buttons,
        source: request.source,
      },
    };
  }

  async pin(): Promise<BroadcastPinResult> {
    return { outcome: 'PINNED' };
  }

  async deliver(_scope: unknown, request: BroadcastDeliverRequest): Promise<BroadcastSendResult> {
    this.delivered.push(request.chatId);
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    return this.scripts.get(request.chatId)?.shift() ?? { outcome: 'SENT', messageId: 1 };
  }
}

describe('Broadcast V2', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let a: AudienceFixtures;
  let b: AudienceFixtures;
  let clock: StoppedClock;
  let transport: ScriptedTransport;
  let key = 0;
  const idem = () => `bv2-${String((key += 1))}-key`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-bv2', roleKeys: ['owner'] }),
    );
    a = new AudienceFixtures(ctx, tenantA.tenantId as string);
    b = new AudienceFixtures(ctx, tenantB.tenantId as string);
    clock = new StoppedClock();
    transport = new ScriptedTransport();
  });

  /** A dispatcher wired as production wires it: the container's own opt-out switch. */
  const dispatcher = () =>
    new BroadcastDispatcher({
      repository: new DrizzleBroadcastRepository(ctx.container.database.db),
      transport,
      facts: new DrizzleRecipientFactsReader(ctx.container.database.db, async () => 'IRT'),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      clock,
      ids: ctx.container.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
      marketingOptOut: {
        honoured: (scope: TenantContext, tx?: unknown) =>
          ctx.container.featureFlagResolver.isEnabled(scope, 'customer_marketing_opt_out', tx),
      },
    });

  let seq = 0;
  const customer = (fixtures: AudienceFixtures = a, bot: string = SEED_IDS.botA1) =>
    fixtures.customer({
      telegramUserId: `6${String(100_000 + (seq += 1))}`,
      botInstanceId: bot,
      firstName: `c${String(seq)}`,
    });
  const chatOf = async (customerId: string) =>
    (
      await ctx.container.database.db.execute<{ telegram_user_id: string }>(
        sql`SELECT telegram_user_id FROM customers WHERE id = ${customerId}::uuid`,
      )
    ).rows[0]?.telegram_user_id as string;

  /** The ids a definition selects in tenant A at the clock's instant, sorted. */
  async function members(input: Omit<AudienceDefinitionInput, 'version'>): Promise<string[]> {
    const result = await ctx.container.database.db.execute<{ customer_id: string }>(
      sql`SELECT x.customer_id FROM (${audienceCustomersQuery({
        tenantId: tenantA.tenantId as string,
        definition: canonicalAudienceDefinition({ version: 1, ...input }),
        asOf: ctx.container.clock.now(),
      })}) x ORDER BY x.customer_id`,
    );
    return result.rows.map((row) => row.customer_id);
  }
  const sorted = (...ids: string[]) => [...ids].sort();

  async function launch(
    audience: Omit<AudienceDefinitionInput, 'version'>,
    purpose: BroadcastPurpose = 'MARKETING',
  ) {
    const created = await ctx.container.broadcasts.create(tenantA, owner, {
      idempotencyKey: idem(),
      title: 'V2',
      contentKind: 'TEXT',
      body: 'سلام',
      buttons: [],
      purpose,
      audience: { version: 1, ...audience },
    });
    const preview = await ctx.container.broadcasts.preview(tenantA, owner, created.id);
    const launched = await ctx.container.broadcasts.launch(tenantA, owner, created.id, {
      idempotencyKey: idem(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: created.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    return { id: launched.id, preview };
  }

  async function recipientStates(broadcastId: string): Promise<Record<string, string>> {
    const result = await ctx.container.database.db.execute<{ chat_id: string; state: string }>(
      sql`SELECT chat_id, state FROM broadcast_recipients WHERE broadcast_id = ${broadcastId}::uuid`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.chat_id, row.state]));
  }

  async function setOptOutPolicy(enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(
      tenantA,
      'customer_marketing_opt_out',
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_marketing_opt_out',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: idem(),
      reason: 'Broadcast V2 integration test.',
    });
  }

  // --- Segmentation ---------------------------------------------------------------------

  describe('segmentation', () => {
    it('selects by tags: any of, none of, both, archived tags included, other tenants never', async () => {
      const vip = await a.tag('VIP');
      const risk = await a.tag('Risk');
      const legacy = await a.tag('Legacy', true);
      const foreign = await b.tag('VIP');
      const [p, q, r, s] = [await customer(), await customer(), await customer(), await customer()];
      await a.tagCustomer(p, vip);
      await a.tagCustomer(q, vip);
      await a.tagCustomer(q, risk);
      await a.tagCustomer(r, legacy);
      const outsider = await customer(b, SEED_IDS.botB1);
      await b.tagCustomer(outsider, foreign);

      expect(await members({ tags: { anyOf: [vip] } })).toEqual(sorted(p, q));
      expect(await members({ tags: { anyOf: [vip, legacy] } })).toEqual(sorted(p, q, r));
      expect(await members({ tags: { noneOf: [vip] } })).toEqual(sorted(r, s));
      expect(await members({ tags: { anyOf: [vip], noneOf: [risk] } })).toEqual([p]);
      // An archived tag still selects the customers that carry it.
      expect(await members({ tags: { anyOf: [legacy] } })).toEqual([r]);
      // Another tenant's tag id selects nobody here, and excludes nobody either.
      expect(await members({ tags: { anyOf: [foreign] } })).toEqual([]);
      expect(await members({ tags: { noneOf: [foreign] } })).toEqual(sorted(p, q, r, s));
    });

    it('selects by has / has no service active at asOf', async () => {
      const panel = await a.panel();
      const now = ctx.container.clock.now();
      const [live, open, lapsed, suspended, none] = [
        await customer(),
        await customer(),
        await customer(),
        await customer(),
        await customer(),
      ];
      await a.service({
        customerId: live,
        panelId: panel,
        expiresAt: new Date(now.getTime() + 86_400_000),
      });
      await a.service({ customerId: open, panelId: panel, expiresAt: null });
      // ACTIVE in the row, but its expiry is already behind asOf: not active.
      await a.service({
        customerId: lapsed,
        panelId: panel,
        expiresAt: new Date(now.getTime() - 60_000),
      });
      await a.service({ customerId: suspended, panelId: panel, state: 'SUSPENDED' });

      expect(await members({ activeService: 'HAS' })).toEqual(sorted(live, open));
      expect(await members({ activeService: 'NONE' })).toEqual(sorted(lapsed, suspended, none));
      expect(await members({ activeService: 'ANY' })).toEqual(
        sorted(live, open, lapsed, suspended, none),
      );
    });

    it('combines the new dimensions with the reseller/customer segment', async () => {
      const panel = await a.panel();
      const tier = await a.tier('Gold');
      const vip = await a.tag('VIP');
      const [reseller, ordinary, idle] = [await customer(), await customer(), await customer()];
      await a.reseller(reseller, tier);
      for (const id of [reseller, ordinary, idle]) await a.tagCustomer(id, vip);
      await a.service({ customerId: reseller, panelId: panel, expiresAt: null });
      await a.service({ customerId: ordinary, panelId: panel, expiresAt: null });

      expect(
        await members({
          tags: { anyOf: [vip] },
          activeService: 'HAS',
          segment: { ordinary: true, resellerTierIds: [] },
        }),
      ).toEqual([ordinary]);
      expect(
        await members({
          tags: { anyOf: [vip] },
          activeService: 'HAS',
          segment: { ordinary: false, resellerTierIds: [tier] },
        }),
      ).toEqual([reseller]);
      expect(await members({ tags: { anyOf: [vip] }, activeService: 'NONE' })).toEqual([idle]);
    });

    it('offers the tenant’s tags in the builder options, archived ones marked', async () => {
      await a.tag('Beta');
      await a.tag('Alpha', true);
      await b.tag('Foreign');
      const options = await ctx.container.audience.options(tenantA, owner);
      expect(options.tags.map((tag) => [tag.label, tag.archived])).toEqual([
        ['Beta', false],
        ['Alpha', true],
      ]);
    });
  });

  // --- Delivery -------------------------------------------------------------------------

  describe('delivery', () => {
    it('freezes a tag audience and honours the opt-out policy at the send, ON and OFF', async () => {
      const vip = await a.tag('VIP');
      const [x, y, z] = [await customer(), await customer(), await customer()];
      await a.tagCustomer(x, vip);
      await a.tagCustomer(y, vip);
      await a.optOutOfMarketing(y);

      /*
       * Since #143 the opt-out is decided at ONE point, the SEND's stamp: the count and the
       * frozen rows include every member, and the stamp resolves an opted-out one SKIPPED
       * while the installation honours the policy (ON, the default).
       */
      const on = await launch({ tags: { anyOf: [vip] } });
      expect(on.preview.customers).toBe(2);
      // The estimate beside the count: one would be skipped if nothing changes before the send.
      expect(on.preview.optedOut).toBe(1);
      await dispatcher().pass(tenantA);
      expect(await recipientStates(on.id)).toEqual({
        [await chatOf(x)]: 'SENT',
        [await chatOf(y)]: 'SKIPPED',
      });

      // OFF at the send: the stored preference stands but is not honoured.
      await setOptOutPolicy(false);
      const off = await launch({ tags: { anyOf: [vip] } });
      // No estimate while the send would not honour the opt-out.
      expect(off.preview.optedOut).toBeNull();
      clock.advance(1_001);
      await dispatcher().pass(tenantA);
      expect(Object.values(await recipientStates(off.id))).toEqual(['SENT', 'SENT']);

      // Launched while OFF, ON again before it goes: the SEND decides, so it is skipped.
      const flipped = await launch({ tags: { anyOf: [vip] } });
      await setOptOutPolicy(true);
      clock.advance(1_001);
      await dispatcher().pass(tenantA);
      expect(await recipientStates(flipped.id)).toEqual({
        [await chatOf(x)]: 'SENT',
        [await chatOf(y)]: 'SKIPPED',
      });
      // A service announcement is not marketing: the policy never touches it.
      const notice = await launch({ tags: { anyOf: [vip] } }, 'SERVICE_ANNOUNCEMENT');
      expect(notice.preview.customers).toBe(2);
      expect(notice.preview.optedOut).toBeNull();
      clock.advance(1_001);
      await dispatcher().pass(tenantA);
      expect(Object.values(await recipientStates(notice.id))).toEqual(['SENT', 'SENT']);
      // Nobody outside the tag was ever messaged.
      expect(transport.delivered).not.toContain(await chatOf(z));
    });

    it('never delivers one recipient twice when two dispatcher replicas run at once', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 30; index += 1) ids.push(await customer());
      const { id } = await launch({}, 'SERVICE_ANNOUNCEMENT');
      transport.latencyMs = 15;
      const one = dispatcher();
      const two = dispatcher();
      let claimed = 0;
      for (let round = 0; round < 6; round += 1) {
        const [first, second] = await Promise.all([one.pass(tenantA), two.pass(tenantA)]);
        claimed += first.claimed + second.claimed;
        clock.advance(1_001);
      }
      const chats = await Promise.all(ids.map(chatOf));
      expect([...transport.delivered].sort()).toEqual([...chats].sort());
      expect(new Set(transport.delivered).size).toBe(transport.delivered.length);
      expect(claimed).toBe(30);
      expect(Object.values(await recipientStates(id)).every((state) => state === 'SENT')).toBe(
        true,
      );
      expect((await ctx.container.broadcasts.get(tenantA, owner, id)).state).toBe('COMPLETED');
    }, 60_000);

    it('reports failures by reason that sum to the counts, and retries only the refusals', async () => {
      const ids: string[] = [];
      for (let index = 0; index < 7; index += 1) ids.push(await customer());
      const chats = await Promise.all(ids.map(chatOf));
      const [sent1, sent2, refusedA, refusedB, blocked, unknown, optedOut] = chats as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const { id } = await launch({});
      // Opted out after the launch: counted and materialised, skipped by the stamp.
      await a.optOutOfMarketing(ids[6] as string);
      transport.script(refusedA, { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
      transport.script(refusedB, { outcome: 'REFUSED', errorCode: 'telegram.rejected.400' });
      transport.script(blocked, { outcome: 'UNREACHABLE', errorCode: 'telegram.rejected.403' });
      transport.script(unknown, { outcome: 'UNKNOWN', errorCode: 'telegram.timeout' });
      await dispatcher().pass(tenantA);

      const done = await ctx.container.broadcasts.get(tenantA, owner, id);
      expect(done.state).toBe('COMPLETED');
      const counts = (await ctx.container.broadcasts.counts(tenantA, owner, [id])).get(id);
      expect(counts).toMatchObject({
        total: 7,
        sent: 2,
        failed: 2,
        unreachable: 1,
        unconfirmed: 1,
        skipped: 1,
      });
      const reasons = await ctx.container.broadcasts.failureReasons(tenantA, owner, id);
      expect(reasons).toEqual([
        { state: 'FAILED', errorCode: 'telegram.rejected.400', count: 2 },
        { state: 'SKIPPED', errorCode: 'broadcast.marketing_opted_out', count: 1 },
        { state: 'UNCONFIRMED', errorCode: 'telegram.timeout', count: 1 },
        { state: 'UNREACHABLE', errorCode: 'telegram.rejected.403', count: 1 },
      ]);
      // Per state, the reasons sum to the rows' own counts.
      const byState = (state: string) =>
        reasons.filter((row) => row.state === state).reduce((sum, row) => sum + row.count, 0);
      expect(byState('FAILED')).toBe(counts?.failed);
      expect(byState('UNREACHABLE')).toBe(counts?.unreachable);
      expect(byState('UNCONFIRMED')).toBe(counts?.unconfirmed);
      expect(byState('SKIPPED')).toBe(counts?.skipped);
      expect(broadcastOutcome(done.state, counts as never)).toBe('PARTIAL');

      // Retry: only Telegram's refusals go again. The UNKNOWN outcome may have arrived and is
      // never resent; the unreachable chat and the opted-out customer are not retried either.
      const reopened = await ctx.container.broadcasts.retryFailed(tenantA, owner, id);
      expect(reopened.state).toBe('SENDING');
      clock.advance(1_001);
      await dispatcher().pass(tenantA);
      const times = (chat: string) => transport.delivered.filter((one) => one === chat).length;
      expect([times(refusedA), times(refusedB)]).toEqual([2, 2]);
      expect([times(unknown), times(blocked), times(sent1), times(sent2)]).toEqual([1, 1, 1, 1]);
      expect(times(optedOut)).toBe(0);
      expect(await recipientStates(id)).toMatchObject({
        [refusedA]: 'SENT',
        [refusedB]: 'SENT',
        [unknown]: 'UNCONFIRMED',
        [blocked]: 'UNREACHABLE',
        [optedOut]: 'SKIPPED',
      });
    });

    it('holds a rate-limited recipient and reports nothing as a failure for it', async () => {
      const [only] = [await customer()];
      const chat = await chatOf(only);
      const { id } = await launch({}, 'SERVICE_ANNOUNCEMENT');
      transport.script(chat, { outcome: 'RATE_LIMITED', retryAfterMs: 20_000 });
      await dispatcher().pass(tenantA);
      expect(await recipientStates(id)).toEqual({ [chat]: 'PENDING' });
      expect(await ctx.container.broadcasts.failureReasons(tenantA, owner, id)).toEqual([]);
      clock.advance(5_000);
      await dispatcher().pass(tenantA);
      expect(transport.delivered).toEqual([chat]);
      clock.advance(BROADCAST_LEASE_MS);
      await dispatcher().pass(tenantA);
      expect(await recipientStates(id)).toEqual({ [chat]: 'SENT' });
    });
  });

  // --- Access ---------------------------------------------------------------------------

  describe('access', () => {
    it('charges broadcasts.view for the failure report and keeps it inside the tenant', async () => {
      await customer();
      const { id } = await launch({}, 'SERVICE_ANNOUNCEMENT');
      const technical = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'tech-bv2',
          roleKeys: ['technical'],
        }),
      );
      await expect(
        ctx.container.broadcasts.failureReasons(tenantA, technical, id),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-bv2-b', roleKeys: ['owner'] }),
      );
      await expect(
        ctx.container.broadcasts.failureReasons(tenantB, ownerB, id),
      ).rejects.toMatchObject({ code: BROADCAST_ERROR_CODES.NOT_FOUND });
    });

    it('refuses an audience naming a tag in both lists, before anything is stored', async () => {
      const vip = await a.tag('VIP');
      await expect(
        ctx.container.broadcasts.create(tenantA, owner, {
          idempotencyKey: idem(),
          title: 'bad',
          contentKind: 'TEXT',
          body: 'x',
          buttons: [],
          audience: { version: 1, tags: { anyOf: [vip], noneOf: [vip] } },
        }),
      ).rejects.toMatchObject({ code: 'audience.definition_invalid' });
      const rows = await ctx.container.database.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM broadcasts`,
      );
      expect(rows.rows[0]?.n).toBe(0);
    });
  });
});
