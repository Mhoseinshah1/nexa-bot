import { createHash } from 'node:crypto';
import { operationIdFrom, type Hasher, type OperationId } from '@nexa/contracts';
import type { OperationNamespace } from '@nexa/contracts';

/**
 * The `Hasher` `packages/contracts` asks for, bound once.
 *
 * `operation.ts` declares the algorithm in the type and leaves the implementation to
 * the composition root, because that package *"depends on nothing — it is the frozen
 * specification and `node:crypto` is a runtime."* This is the whole of that binding.
 *
 * Lowercase hex is not a style choice: `operationIdFrom` refuses a digest that is not
 * 64 lowercase hex characters, because an id that fails `operationIdSchema` would
 * first surface in a provider note or an operational event, long after the operation
 * it was meant to identify.
 */
export const sha256Hex: Hasher = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * A retry-stable identity for one logical money movement.
 *
 * DERIVED from the idempotency key, never generated. `operation.ts` states the
 * property that rests on: a derived id needs no storage, so the same key yields the
 * same id *"in any process, after any restart, with no lookup — so two replicas racing
 * the same retry agree without talking to each other."*
 *
 * A generated reference would have to be stored to survive a retry, and the only place
 * to store it is the idempotency row — so a retry that missed that row would mint a
 * second reference and move the money twice.
 */
export function operationIdFor(namespace: OperationNamespace, idempotencyKey: string): OperationId {
  return operationIdFrom(namespace, idempotencyKey, sha256Hex);
}
