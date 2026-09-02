import {
  errors,
  PLATFORM_ERROR_CODES,
  type IdempotencyNamespace,
  type IdempotencyStore,
  type ScopeContext,
} from '@nexa/contracts';

/**
 * Stores a command's result against its key, or refuses to be the second one.
 *
 * `IdempotencyStore.find` runs BEFORE the work and can only see requests that
 * have already committed. Two submissions of the same key at the same time
 * therefore both find nothing, both do the work, and meet for the first time at
 * this insert. Treating the losing insert as a no-op — which is what ignoring
 * the answer does — leaves an idempotency key that stops a sequential replay
 * and nothing else, which is not the case a double-clicked button produces.
 *
 * The loser throws, so its whole transaction rolls back and only the winner's
 * work is committed. The client's retry then finds the stored record and gets
 * the ordinary replay.
 *
 * A CONFLICT rather than an error: nothing is broken, two requests simply
 * claimed one key, and the answer to "which won" is knowable a moment later.
 */
export async function rememberOnce<TResult>(
  store: IdempotencyStore,
  scope: ScopeContext,
  namespace: IdempotencyNamespace,
  key: string,
  requestHash: string,
  result: TResult,
  tx?: unknown,
): Promise<void> {
  const stored = await store.remember(scope, namespace, key, requestHash, result, tx);
  if (stored) return;

  throw errors.conflict(
    PLATFORM_ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
    `Another request using idempotency key "${key}" completed first. ` +
      'Retry to read its result.',
    { key },
  );
}
