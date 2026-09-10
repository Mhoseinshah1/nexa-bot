import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemContext, systemJobActor } from '@nexa/contracts';
import { outboxMessages } from '../../apps/api/src/infrastructure/persistence/schema';
import type { EventConsumer } from '../../apps/api/src/modules/platform/eventing/application/event-consumer';
import { OutboxRelay } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { panelUrlPolicy } from '../../apps/api/src/infrastructure/net/installation-policy';
import { createTestContext, testConfig, type TestContext } from './harness';

/**
 * The no-network-inside-a-transaction rule, through the REAL unit of work and the
 * REAL HTTP client.
 *
 * `tests/unit/transaction-boundary.test.ts` covers the mechanism in isolation and
 * `scripts/check-boundaries.sh` covers which files call it. Neither proves the
 * two are connected: the unit test never touches `DrizzleUnitOfWork`, and the
 * boundary script only reads source. This file is the one that fails if
 * `uow.run` stops marking its callback, or if `SafeHttpClient.send` stops asking.
 *
 * Against a real database, because a fake transaction is not a transaction: the
 * property is about an async context surviving the real driver's callback, which
 * is exactly what a stub would paper over.
 */
describe('the transaction boundary, end to end', () => {
  let context: TestContext;
  let http: SafeHttpClient;

  beforeAll(async () => {
    context = await createTestContext();
    // Loopback is allowed HERE only, so the destination below is one the policy
    // would really dial. Without it `127.0.0.1` is refused as a blocked target
    // before any socket opens, and the "permits it outside a transaction" case
    // would be satisfied by the policy rather than by the guard standing down.
    const config = testConfig({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    http = new SafeHttpClient({
      ...panelUrlPolicy(config),
      totalTimeoutMs: 1_000,
      maxResponseBytes: 1_024,
      maxRetries: 0,
    });
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  const scope = systemContext('SYSTEM_JOB');

  it('refuses a panel request made inside a real transaction', async () => {
    /*
     * The destination is deliberately one this client WOULD dial — loopback is
     * allowed in this file's configuration — so the refusal below is the
     * transaction guard and not the URL policy declining a blocked target.
     *
     * The two are easy to tell apart, which is the other half of the design: a
     * policy refusal RETURNS `{ ok: false, failure: 'BLOCKED_TARGET' }`, and the
     * guard THROWS. So `rejects` can only be the guard.
     */
    await expect(
      context.container.uow.run(scope, async () => {
        await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
      }),
    ).rejects.toThrow(/inside a database transaction/);
  });

  it('names the scope the transaction was opened with', async () => {
    // The message has to identify WHICH transaction, or an operator reading it
    // goes looking through every `uow.run` in the codebase.
    await expect(
      context.container.uow.run(scope, async () => {
        await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
      }),
    ).rejects.toThrow(/system:SYSTEM_JOB/);
  });

  it('permits the same request outside a transaction', async () => {
    /*
     * The other direction, and the one that matters most: a guard that refused
     * everywhere would pass the two cases above while breaking every probe in
     * production.
     *
     * Port 9 is the discard port and nothing is listening, so the socket is
     * really opened and really refused — `UNREACHABLE`, which `send` RETURNS
     * rather than throws. Reaching that outcome at all is the assertion: it can
     * only be reached by code the guard let through.
     *
     * `127.0.0.2` rather than `127.0.0.1`, and the distinction is not cosmetic:
     * the policy denies the DATABASE's own host by name, so `127.0.0.1` comes
     * back `BLOCKED_TARGET` in this environment and the case would have been
     * satisfied by the policy refusing to let a panel be the database. That is a
     * rule worth having and the wrong one to be testing here.
     */
    const result = await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('UNREACHABLE');
  });

  it('refuses after an await inside the transaction, not only before one', async () => {
    // Every realistic violation is await-shaped: read a row, then send. A guard
    // that lost the context across the first await would miss all of them while
    // passing the first case in this file.
    await expect(
      context.container.uow.run(scope, async (tx) => {
        await tx.tx.execute('SELECT 1' as never);
        await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
      }),
    ).rejects.toThrow(/inside a database transaction/);
  });

  it("refuses a consumer that sends from inside the RELAY's claim transaction", async () => {
    /*
     * The case item D exists for, and the one its first fix missed.
     *
     * `transaction-boundary.ts` names the relay as "the case that makes this
     * urgent rather than theoretical: it runs consumers INSIDE the claim
     * transaction, by design". But `withinTransaction` was called only by the unit
     * of work, and the relay opens its transaction on the database handle
     * directly — so the guard's store was empty exactly there, and a consumer that
     * sent was permitted. The rule was enforced everywhere except where it was
     * needed.
     *
     * Driven through the REAL relay and the REAL HTTP client. A consumer is the
     * only thing in this codebase that runs arbitrary code inside somebody else's
     * transaction, so nothing else can stand in for it.
     *
     * The failure is recorded against the message rather than thrown out of
     * `processBatch` — a consumer failure rolls back to its savepoint and the
     * batch continues, which is the relay's own design. So the assertion is on
     * `failed` and on the message's `last_error`, not on a rejection.
     */
    await context.container.uow.run(scope, async (tx) => {
      await context.container.outbox.write(tx, systemJobActor('tx-boundary', 'corr-tx' as never), {
        eventType: 'SystemPinged',
        aggregateType: 'System',
        aggregateId: 'system',
        payload: { source: 'test' },
      });
    });

    const sending: EventConsumer = {
      name: 'test.sends-inside-the-relay-transaction',
      subscribesTo: ['SystemPinged'],
      async handle() {
        // A destination this client WOULD dial, so a refusal can only be the
        // guard: the URL policy RETURNS a failure and the guard THROWS.
        await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
      },
    };
    const relay = new OutboxRelay(
      context.container.database.db,
      [sending],
      context.container.clock,
      context.container.logger,
      { batchSize: 10, pollIntervalMs: 50, maxLagMs: 300_000 },
    );

    const result = await relay.processBatch();
    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const [message] = await context.container.database.db.select().from(outboxMessages);
    expect(message?.publishedAt).toBeNull();
    expect(message?.lastError).toMatch(/inside a database transaction/);
    // And it names the relay, not a tenant: the batch spans tenants, so a label
    // naming one of them would name the wrong one.
    expect(message?.lastError).toMatch(/system:relay/);
  });

  it('leaves the context clean once the transaction has returned', async () => {
    // A guard that leaked would refuse a legitimate send made by the next
    // request on the same connection — a failure that only appears under load.
    await context.container.uow.run(scope, async (tx) => {
      await tx.tx.execute('SELECT 1' as never);
    });
    const result = await http.send('http://127.0.0.2:9/', { method: 'GET', path: '/status' });
    expect(result.ok).toBe(false);
  });
});
