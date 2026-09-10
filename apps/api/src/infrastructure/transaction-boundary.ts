import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether the current call is running inside a business transaction, and a
 * refusal for the things that must not be.
 *
 * The rule is one of this codebase's oldest: **no network call inside a database
 * transaction.** A transaction holds a connection out of the pool and row locks
 * for as long as it runs, so an outbound call inside one ties the pool's
 * availability to somebody else's server. A panel that stops answering becomes a
 * pool exhausted by transactions waiting on a socket, and the symptom is every
 * unrelated write in the installation timing out.
 *
 * Worse than slow: a transaction can roll back, and a sent request cannot. An
 * external side effect inside a transaction is a side effect with no record that
 * it happened — the opposite of the outbox, which exists precisely so the record
 * and the effect cannot disagree.
 *
 * The property HELD everywhere before this file existed — all nineteen `uow.run`
 * call sites were followed to their leaves and none reaches a network sink — and
 * nothing enforced it. The rule was documented in four places and checked in
 * none, which by this repository's own standard is a rule awaiting its silent
 * reversion. The outbox relay is the case that makes it urgent rather than
 * theoretical: it runs consumers INSIDE the claim transaction, by design, and is
 * safe today only because the one consumer in existence writes to the ops log. A
 * future consumer that sends is a one-line mistake with nothing in its way.
 *
 * Two mechanisms, because neither covers the other:
 *
 * - `scripts/check-boundaries.sh` refuses a network or subprocess import in the
 *   domain and application layers. It catches the mistake at build time and
 *   cannot see a sink reached through an injected port.
 * - this guard refuses at RUNTIME, inside the sink itself, wherever the call
 *   came from. It cannot see a violation no test exercises.
 */
const transactionLabel = new AsyncLocalStorage<string>();

/**
 * Marks `fn` as running inside a business transaction.
 *
 * Called by the unit of work, which is the only thing that should call it. The
 * label names the scope so a refusal can say which transaction it came from —
 * "a network call inside a transaction" sends an operator looking through
 * nineteen call sites.
 */
export function withinTransaction<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return transactionLabel.run(label, fn);
}

/** The label of the innermost business transaction, if there is one. */
export function currentTransactionLabel(): string | undefined {
  return transactionLabel.getStore();
}

/**
 * Refuses an external side effect that is running inside a transaction.
 *
 * THROWS rather than logs. A logged violation is a violation that ships: the
 * one state this must not reach is production holding a connection open across a
 * socket read, and an error at the sink turns that into a loud failure on the
 * first request that does it — in a test, in staging, or at worst on one request
 * rather than on the whole pool.
 *
 * `what` names the sink, because the stack will be full of framework frames and
 * the useful sentence is "the Telegram transport sent inside the
 * tenant:... transaction".
 */
export function assertOutsideTransaction(what: string): void {
  const label = transactionLabel.getStore();
  if (label === undefined) return;
  throw new Error(
    `${what} was called inside a database transaction (${label}). ` +
      'A transaction holds a pooled connection and row locks for its whole duration, ' +
      'and a sent request cannot be rolled back with it. ' +
      'Commit first and do the external work afterwards, or write an outbox message.',
  );
}
