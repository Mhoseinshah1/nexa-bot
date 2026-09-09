import { z } from 'zod';
import type { Branded } from './ids.js';

/**
 * The identity of one logical external mutation.
 *
 * ## Why a fifth identifier
 *
 * Four already exist and not one of them is the right thing to put on a provider
 * user, a payment or a Telegram delivery:
 *
 * - A **UUIDv7 primary key** is minted per ROW, inside the transaction, so a
 *   retried command mints a new one. It identifies a record, not an intent.
 * - **`CorrelationId`** is minted per REQUEST. `correlation.middleware.ts` honours
 *   an inbound header and nothing in `apps/web` ever sends one; every background
 *   tick mints a fresh value. It changes on retry, which is exactly what a trace
 *   id should do and exactly what an operation id must not.
 * - **`causationId`** is declared on the outbox writer and has no producer
 *   anywhere. A column with no writer is not an identity.
 * - The **idempotency key** is the only retry-stable value this codebase has, and
 *   it is the right INPUT — see `operationIdFrom` — but it is a client-chosen
 *   opaque string stored in exactly one table. No audit row, outbox message,
 *   operational event or notification carries it, so it cannot join anything, and
 *   the value an operator is handed on failure is a 36-character UUID.
 *
 * So the join key across a mutation's audit row, its event and its operational
 * event is currently the one identifier that changes on retry. That is the gap.
 *
 * ## What an OperationId is
 *
 * 16 lowercase hexadecimal characters — 64 bits — **derived from the idempotency
 * key**, not generated. Derivation rather than generation is the whole design:
 *
 * - A generated id would have to be stored somewhere to survive a retry, and the
 *   place it would be stored is the idempotency row, which means a retry that
 *   misses the row (a different scope, a lost write) gets a new operation id
 *   silently.
 * - A derived id needs no storage at all. The same key always yields the same
 *   operation id, in any process, after any restart, with no lookup — so two
 *   replicas racing the same retry agree without talking to each other.
 *
 * 64 bits rather than 128 because this value is meant to be QUOTED: into a
 * provider-side note whose budget is 500 characters, into a Telegram message an
 * operator reads on a phone, into a support conversation. A 36-character UUID is
 * not quoted, it is copied and pasted wrongly. 64 bits of a SHA-256 over a
 * namespaced key is far past any collision that matters here — an installation
 * would need on the order of four billion operations before a coincidence became
 * likely, and the consequence of one would be two unrelated rows sharing a label,
 * not a wrong write, because nothing resolves an entity BY operation id.
 *
 * ## What it is not
 *
 * Not a secret and not a capability. It appears in provider notes, operational
 * events and operator-facing messages, and it grants nothing: every write path
 * still takes a `ScopeContext` and an `ActorContext` and checks a permission.
 *
 * Not an `OrderId` and not a `ServiceId`. Those identify commercial and customer
 * entities whose lifetimes are long; this identifies one attempt at one external
 * effect. A renewal is a NEW order and a NEW operation against the SAME service.
 */
export type OperationId = Branded<string, 'OperationId'>;

/** 64 bits, lowercase hex. Quotable, and that is the reason for the size. */
export const OPERATION_ID_LENGTH = 16;

export const operationIdSchema = z
  .string()
  .regex(new RegExp(`^[0-9a-f]{${OPERATION_ID_LENGTH}}$`), 'must be an operation id')
  .transform((value) => value as OperationId);

/**
 * The namespaces an operation id may be derived under.
 *
 * A namespace is part of the hash input, so the same idempotency key used by two
 * different kinds of operation yields two different ids. Without it, a key reused
 * across surfaces — which `scopeRef` already has to defend against for the same
 * reason — would make one operation look like a retry of another.
 *
 * Frozen, because a namespace is part of an identity that gets written into
 * provider-side notes and operational events. Adding one is a contract change;
 * renaming one makes every id derived under the old name unreachable.
 */
export const OPERATION_NAMESPACES = [
  /** A provider-side mutation: create, update, delete a panel user. */
  'provider',
  /** A payment gateway interaction. */
  'payment',
  /** An outbound Telegram effect whose duplication a customer would see. */
  'telegram',
  /** A backup run's externally visible effects. */
  'backup',
] as const;
export type OperationNamespace = (typeof OPERATION_NAMESPACES)[number];

/**
 * Derives the operation id for an idempotency key under a namespace.
 *
 * Pure, total, and deliberately NOT dependent on a clock, a random source or a
 * database. Those are the three things that would make a retry produce a
 * different answer, which is the one property this function exists to have.
 *
 * The hash is supplied rather than imported, because `packages/contracts`
 * depends on nothing — it is the frozen specification and `node:crypto` is a
 * runtime. The caller passes a `Hasher`; `apps/api` binds it to SHA-256 once.
 * That also makes this testable without a platform.
 *
 * The input is `<namespace>:<key>` with a separator that cannot appear in a
 * namespace, so `('provider', 'a:b')` and `('provider:a', 'b')` cannot collide —
 * the namespace list is frozen and contains no colon.
 */
export function operationIdFrom(
  namespace: OperationNamespace,
  idempotencyKey: string,
  hash: Hasher,
): OperationId {
  if (idempotencyKey === '') {
    throw new Error('an operation id cannot be derived from an empty idempotency key');
  }
  const digest = hash(`${namespace}:${idempotencyKey}`);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    // A hasher that returned something other than lowercase SHA-256 hex would
    // produce ids that do not match `operationIdSchema`, and the first place that
    // would surface is a provider note or an operational event — long after the
    // operation it was supposed to identify. Refused here instead.
    throw new Error('an operation id hasher must return 64 lowercase hex characters');
  }
  return digest.slice(0, OPERATION_ID_LENGTH) as OperationId;
}

/**
 * A hex SHA-256 of a UTF-8 string.
 *
 * A port, not an import: this package depends on nothing, so the algorithm is
 * named in the type and supplied by the composition root.
 */
export type Hasher = (input: string) => string;
