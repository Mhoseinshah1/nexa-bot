import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BotInstanceId } from '@nexa/contracts';
import { DrizzleTelegramMessageStateRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-telegram-message-state.repository';
import { WIZARD_CLAIM_LEASE_MS } from '../../apps/api/src/modules/commerce/messaging/application/telegram-message-state';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * R2 finding F5: the two conditional writes the wizard's whole race argument rests on, each
 * pinned against the real PostgreSQL statement.
 *
 *   - `claimWizard` takes a message only while no other turn's lease is live
 *     (`busy_until IS NULL OR busy_until <= now`): two turns on one message never both pass,
 *     and a lease that ran out (a turn that died) is taken over.
 *   - `landWizard` lands only on the `version` its claim took: a wizard the gateway worker
 *     moved between a turn's claim and its landing keeps the worker's screen.
 *
 * Driven through the repository with explicit clocks, so the lease boundary is exact and
 * the two claims are two concurrent autocommit statements on one row.
 */
const BOT = SEED_IDS.botA1 as BotInstanceId;
const REF = { botInstanceId: BOT, chatId: '910910', messageId: 9001 };

describe('the wizard state writes are conditional', () => {
  let ctx: TestContext;
  let repo: DrizzleTelegramMessageStateRepository;
  let auto: TransactionScope;
  const t0 = new Date('2026-09-29T10:00:00.000Z');
  const lease = (from: Date) => new Date(from.getTime() + WIZARD_CLAIM_LEASE_MS);

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    repo = new DrizzleTelegramMessageStateRepository(ctx.container.database.db);
    // No transaction: each statement autocommits, as two turns' statements would.
    auto = { tx: ctx.container.database.db, scope: tenantA } as TransactionScope;
    await repo.adoptWizard(
      tenantA,
      {
        id: ctx.container.ids.uuid(),
        ref: REF,
        kind: 'ORDER',
        step: 'INVOICE_PENDING',
        subjectId: null,
        paymentId: ctx.container.ids.uuid(),
      },
      t0,
      auto,
    );
  });

  const claim = (now: Date) =>
    repo.claimWizard(
      tenantA,
      { ref: REF, kind: 'ORDER', from: ['INVOICE_PENDING', 'INVOICE'] },
      now,
      lease(now),
      auto,
    );

  it('claimWizard: two concurrent claims of one wizard — exactly one wins', async () => {
    const [a, b] = await Promise.all([claim(t0), claim(t0)]);
    expect([a, b].filter((won) => won !== null)).toHaveLength(1);
  });

  it('claimWizard: a claim while another turn holds the lease is refused; after the lease it is taken over', async () => {
    const first = await claim(t0);
    expect(first).not.toBeNull();
    // Before the first turn lands or releases: refused, even at the lease's last instant.
    expect(await claim(new Date(t0.getTime() + WIZARD_CLAIM_LEASE_MS - 1))).toBeNull();
    // The first turn died: once its lease ran out the message is not frozen.
    const takeover = await claim(lease(t0));
    expect(takeover).not.toBeNull();
    expect(takeover?.version).toBe((first?.version ?? 0) + 1);
  });

  it('landWizard: a wizard the worker moved between a claim and its landing keeps the worker’s screen', async () => {
    const claimed = await claim(t0);
    if (claimed === null) throw new Error('no claim');
    // The gateway worker commits the attempt's end and moves the message (bumping version).
    const moved = await repo.moveWizards(
      tenantA,
      { paymentId: claimed.paymentId ?? '' },
      ['INVOICE_PENDING'],
      'NOTICE',
      new Date(t0.getTime() + 1),
      auto,
    );
    expect(moved).toHaveLength(1);

    const landed = await repo.landWizard(
      tenantA,
      claimed.id,
      claimed.version,
      { kind: 'ORDER', step: 'INVOICE', subjectId: null, paymentId: claimed.paymentId },
      new Date(t0.getTime() + 2),
      null,
      auto,
    );
    expect(landed).toBe(false);
    expect((await repo.findWizard(tenantA, REF))?.step).toBe('NOTICE');
  });
});
