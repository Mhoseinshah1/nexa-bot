import { describe, expect, it } from 'vitest';
import {
  assertOutsideTransaction,
  currentTransactionLabel,
  withinTransaction,
} from '../../apps/api/src/infrastructure/transaction-boundary';

/**
 * The rule: no external side effect inside a database transaction.
 *
 * A transaction holds a pooled connection and row locks for its whole duration,
 * so an outbound call inside one ties the pool's availability to somebody else's
 * server — a panel that stops answering becomes every unrelated write in the
 * installation timing out. And a transaction can roll back while a sent request
 * cannot, which leaves an external side effect with no record that it happened.
 *
 * The property held across all nineteen `uow.run` call sites before this existed,
 * and nothing enforced it. These cases are about the MECHANISM; that each real
 * sink calls it is asserted by `scripts/check-boundaries.sh`, which can see a
 * file the runtime never reaches in a test.
 */
describe('the transaction boundary', () => {
  it('permits an external call with no transaction open', () => {
    // The overwhelmingly common case, and it must cost nothing and refuse
    // nothing. A guard that was wrong in this direction would break every send.
    expect(() => assertOutsideTransaction('A probe')).not.toThrow();
    expect(currentTransactionLabel()).toBeUndefined();
  });

  it('refuses an external call inside a transaction, naming the sink and the scope', async () => {
    await withinTransaction('tenant:01900000-0000-7000-8000-000000000001', async () => {
      // Both halves of the message matter to whoever reads the failure: which
      // sink was called, and which transaction it was called inside. "A network
      // call inside a transaction" sends an operator through nineteen call sites.
      expect(() => assertOutsideTransaction('A panel HTTP request')).toThrow(
        /A panel HTTP request was called inside a database transaction \(tenant:01900000-0000-7000-8000-000000000001\)/,
      );
    });
  });

  it('throws rather than logging', async () => {
    /*
     * Stated as its own case because it is the decision, not a detail.
     *
     * A logged violation is a violation that ships: a line in a log nobody reads
     * while production holds a connection open across a socket read. Throwing
     * turns it into a loud failure on the FIRST request that does it — in a test,
     * in staging, or at worst on one request rather than on the whole pool.
     */
    await withinTransaction('system:relay', async () => {
      let threw = false;
      try {
        assertOutsideTransaction('A send');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  it('still refuses after an await inside the transaction', async () => {
    // The property this needs from AsyncLocalStorage, and the reason a plain
    // module-level boolean would not do: the context has to survive the
    // continuation. Every real violation is `await`-shaped — a repository read,
    // then a send — so a guard that only held before the first await would miss
    // all of them.
    await withinTransaction('tenant:a', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(() => assertOutsideTransaction('A send')).toThrow(/tenant:a/);
    });
  });

  it('does not leak the context to work that merely started inside', async () => {
    /*
     * A promise created inside the transaction and awaited outside it keeps the
     * context, and that is correct — the callback really is a continuation of
     * the transaction. What must NOT happen is the reverse: code running after
     * the transaction has returned seeing a label.
     *
     * That is the state a module-level flag gets wrong in production rather than
     * in a test: two concurrent requests, one in a transaction, and the other's
     * perfectly legitimate send refused.
     */
    await withinTransaction('tenant:a', async () => {
      expect(currentTransactionLabel()).toBe('tenant:a');
    });
    expect(currentTransactionLabel()).toBeUndefined();
    expect(() => assertOutsideTransaction('A send')).not.toThrow();
  });

  it('keeps the labels of two concurrent transactions apart', async () => {
    // One process runs many requests at once. A shared flag would make the
    // guard's answer depend on what an unrelated request happened to be doing.
    const seen: string[] = [];
    await Promise.all([
      withinTransaction('tenant:a', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(currentTransactionLabel() ?? 'none');
      }),
      withinTransaction('tenant:b', async () => {
        seen.push(currentTransactionLabel() ?? 'none');
      }),
    ]);
    expect(seen.sort()).toEqual(['tenant:a', 'tenant:b']);
  });
});
