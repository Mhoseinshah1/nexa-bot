import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  formatProviderNote,
  isNexaProviderNote,
  OPERATION_ID_LENGTH,
  OPERATION_NAMESPACES,
  operationIdFrom,
  operationIdSchema,
  PROVIDER_FAILURE_DEFINITIVE,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
  PROVIDER_NOTE_MAX_LENGTH,
  providerFailureDefiniteness,
  type OperationId,
  type OrderId,
  type ServiceId,
} from '@nexa/contracts';

/** The hasher the composition root will bind. Named here so every case agrees. */
const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

/**
 * The correctness foundations Phase 4 needs, before Phase 4 exists.
 *
 * Four audit items (A, C, K, L) asked for contracts rather than features, and the
 * reason to declare them now is that each is a decision several future call sites
 * have to AGREE on. An operation id introduced alongside the first mutating
 * provider call would be designed around that call; Phase 4 has purchase, renewal,
 * add-volume and payment, and they need one answer between them.
 *
 * Every case here is about a property a later caller could break without
 * noticing, not about whether a function returns a string.
 */
describe('the operation identity', () => {
  it('is stable across retries, because it is DERIVED and not generated', () => {
    /*
     * THE property. A retried command must produce the same operation id, in a
     * different process, after a restart, with no storage and no lookup — which is
     * why this is a pure function of the idempotency key rather than a row.
     *
     * A generated id would have to be stored to survive a retry, and the place it
     * would be stored is the idempotency row, so a retry that missed that row
     * would silently get a new identity — and a new identity is how a provider
     * user gets created twice.
     */
    const key = 'tenant-a|panel-create|01a08000-0000-7000-8000-000000000001';
    expect(operationIdFrom('provider', key, sha256)).toBe(operationIdFrom('provider', key, sha256));
  });

  it('differs per namespace for the same key', () => {
    // A key reused across two kinds of operation must not make one look like a
    // retry of the other. `scopeRef` already has to defend the idempotency table
    // against exactly this, and for the same reason.
    const key = 'the-same-key';
    expect(operationIdFrom('provider', key, sha256)).not.toBe(
      operationIdFrom('payment', key, sha256),
    );
  });

  it('cannot be confused by a colon in the key', () => {
    // The namespace and the key are joined by `:`, so the join has to be
    // unambiguous. It is, because the namespace list is frozen and contains no
    // colon — this asserts the consequence rather than the list.
    expect(OPERATION_NAMESPACES.every((namespace) => !namespace.includes(':'))).toBe(true);
    expect(operationIdFrom('provider', 'a:b', sha256)).not.toBe(
      operationIdFrom('provider', 'a', sha256),
    );
  });

  it('is 16 lowercase hex characters, which is what makes it quotable', () => {
    // The size is a product decision, not an implementation detail: this value
    // goes into a provider note with a 500-character budget, into a Telegram
    // message read on a phone, and into support conversations. A 36-character
    // UUID is not quoted, it is mis-pasted.
    const id = operationIdFrom('provider', 'k', sha256);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id.length).toBe(OPERATION_ID_LENGTH);
    expect(operationIdSchema.parse(id)).toBe(id);
  });

  it('refuses an empty idempotency key', () => {
    // An empty key is not an identity, and hashing it would produce a perfectly
    // valid-looking id that every keyless caller shared.
    expect(() => operationIdFrom('provider', '', sha256)).toThrow(/empty idempotency key/);
  });

  it('refuses a hasher that does not return SHA-256 hex', () => {
    /*
     * The failure this prevents is slow and remote: a hasher returning base64, or
     * upper-case hex, yields ids that fail `operationIdSchema` — and the first
     * place that surfaces is a provider note or an operational event, long after
     * the operation it was meant to identify.
     */
    expect(() => operationIdFrom('provider', 'k', () => 'not-a-digest')).toThrow(
      /64 lowercase hex/,
    );
    expect(() => operationIdFrom('provider', 'k', (v) => sha256(v).toUpperCase())).toThrow(
      /64 lowercase hex/,
    );
  });

  it('rejects anything that is not the declared shape', () => {
    for (const bad of ['', 'XYZ', 'AAAAAAAAAAAAAAAA', 'abcdef', `${'a'.repeat(17)}`]) {
      expect(operationIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('definitive versus unknown provider outcomes', () => {
  it('classifies every failure kind, in both directions', () => {
    // Total, like the retryability map beside it. A kind with no entry would be
    // `undefined` at a decision point about whether to retry a MUTATION, and
    // `undefined` there reads as falsy, which is the dangerous answer.
    for (const kind of PROVIDER_FAILURE_KINDS) {
      expect(PROVIDER_FAILURE_DEFINITIVE[kind], kind).toBeDefined();
    }
    expect(Object.keys(PROVIDER_FAILURE_DEFINITIVE).sort()).toEqual(
      [...PROVIDER_FAILURE_KINDS].sort(),
    );
  });

  it('is a DIFFERENT axis from retryability', () => {
    /*
     * The point of the item. Retryability encodes a decision; definiteness is a
     * fact about the wire. If the two maps agreed everywhere, one of them would be
     * redundant and the new one would be decoration.
     *
     * `TIMEOUT` is the case that proves they differ: retryable, because trying
     * again could plausibly help — and UNKNOWN, because the deadline may have
     * fired after the request body was written. For a read that combination is
     * fine. For a create-user it is the difference between one user and two.
     */
    expect(PROVIDER_FAILURE_RETRYABLE.TIMEOUT).toBe(true);
    expect(PROVIDER_FAILURE_DEFINITIVE.TIMEOUT).toBe('UNKNOWN');
    // And the other direction: definitive but not retryable.
    expect(PROVIDER_FAILURE_DEFINITIVE.AUTHENTICATION_FAILED).toBe('DEFINITIVE');
    expect(PROVIDER_FAILURE_RETRYABLE.AUTHENTICATION_FAILED).toBe(false);
  });

  it('treats a refusal before the socket as definitive', () => {
    // `BLOCKED_TARGET` is the strongest guarantee available: the URL policy
    // refused before a connection was opened, so nothing happened on the other
    // side at all. Calling that ambiguous would block a retry that is certainly
    // safe.
    expect(PROVIDER_FAILURE_DEFINITIVE.BLOCKED_TARGET).toBe('DEFINITIVE');
    expect(PROVIDER_FAILURE_DEFINITIVE.TLS_FAILED).toBe('DEFINITIVE');
    expect(PROVIDER_FAILURE_DEFINITIVE.UNSUPPORTED_CAPABILITY).toBe('DEFINITIVE');
  });

  it('treats a lost response as unknown, including the overloaded kind', () => {
    // `UNREACHABLE` covers both "DNS resolved nothing", which is definitive, and a
    // socket error during the response phase, which is not. The client does not
    // record which, so the safe reading is the pessimistic one — and narrowing it
    // needs evidence, not a table edit.
    expect(PROVIDER_FAILURE_DEFINITIVE.UNREACHABLE).toBe('UNKNOWN');
  });

  it('lets evidence narrow an unknown outcome to definitive, and never the reverse', () => {
    /*
     * `requestSent: NOT_SENT` makes any kind definitive — nothing was written, so
     * nothing happened. That is the one direction evidence may move in.
     *
     * The reverse must NOT hold: a 429 is a 429 whether or not the request
     * arrived, and treating an answer as ambiguous would block a retry that is
     * safe and leave an operation unresolved for a human to reconcile by hand.
     */
    expect(providerFailureDefiniteness({ kind: 'TIMEOUT', requestSent: 'NOT_SENT' })).toBe(
      'DEFINITIVE',
    );
    expect(providerFailureDefiniteness({ kind: 'TIMEOUT', requestSent: 'SENT' })).toBe('UNKNOWN');
    expect(providerFailureDefiniteness({ kind: 'TIMEOUT', requestSent: 'UNRECORDED' })).toBe(
      'UNKNOWN',
    );
    // Definitive stays definitive under every piece of evidence.
    for (const sent of ['NOT_SENT', 'SENT', 'UNRECORDED'] as const) {
      expect(providerFailureDefiniteness({ kind: 'RATE_LIMITED', requestSent: sent }), sent).toBe(
        'DEFINITIVE',
      );
    }
  });
});

describe('the provider note format', () => {
  const facts = {
    telegramId: '123456789',
    serviceId: '01a08000-0000-7000-8000-0000000000aa' as ServiceId,
    orderId: '01a08000-0000-7000-8000-0000000000bb' as OrderId,
    operationId: 'deadbeefcafe0123' as OperationId,
  };

  it('puts the Telegram id first', () => {
    // The note is read by a human looking at somebody else's panel, trying to work
    // out whose account this is. The Telegram id is the answer to that question;
    // everything else answers a follow-up.
    expect(formatProviderNote(facts).startsWith('TG: 123456789')).toBe(true);
  });

  it('carries no NEXA prefix', () => {
    // Five characters of a 500-character budget for something the operator reading
    // it already knows and a machine would not use.
    expect(formatProviderNote(facts)).not.toMatch(/NEXA/);
  });

  it('stays inside the budget, and refuses rather than truncating', () => {
    // A truncated note ends in half an identifier, which looks like data. With the
    // real field widths this cannot happen, so a refusal means a caller passed
    // something unexpected — exactly when silence is wrong.
    expect(formatProviderNote(facts).length).toBeLessThanOrEqual(PROVIDER_NOTE_MAX_LENGTH);
    expect(() =>
      formatProviderNote({ ...facts, telegramId: '9'.repeat(PROVIDER_NOTE_MAX_LENGTH) }),
    ).toThrow(/at most 500 characters/);
  });

  it('names the LAST order and operation, not a history', () => {
    // A service is renewed many times; each is a new order and a new operation
    // against the same service. A 500-character field is not a log, and trying to
    // make it one is how it overflows.
    const note = formatProviderNote(facts);
    expect(note).toContain('LastOrder:');
    expect(note).toContain('LastOp:');
  });

  it('recognises its own note and refuses to claim somebody else', () => {
    /*
     * The READ half of read-before-write. The rule is that an operator's own note
     * is never silently overwritten, and recognition is by SHAPE because the note
     * deliberately has no marker.
     *
     * The conservative reading of anything ambiguous is "somebody else's": a
     * refusal costs one manual edit, and a wrong overwrite destroys a human's note
     * with no copy anywhere.
     */
    expect(isNexaProviderNote(formatProviderNote(facts))).toBe(true);
    // An empty field is not somebody else's note.
    expect(isNexaProviderNote('')).toBe(true);
    expect(isNexaProviderNote('   ')).toBe(true);
    // Everything a human would plausibly write is theirs.
    for (const theirs of [
      'do not delete - paid by bank transfer',
      'TG: 123456789',
      'TG: 1 | Service: x',
      'customer asked for a static ip',
      `${formatProviderNote(facts)} and my own note`,
    ]) {
      expect(isNexaProviderNote(theirs), theirs).toBe(false);
    }
  });
});
