import { describe, expect, it } from 'vitest';
import { isNexaError, OWNER_ROLE_KEY, type AdminId } from '@nexa/contracts';
import {
  assertNotSelf,
  assertOwnerSurvives,
  diffRoles,
  losesOwnerRole,
} from '../../apps/api/src/modules/platform/identity/domain/admin-protection';
import {
  generateSessionToken,
  hashSessionToken,
  tokenHashesMatch,
} from '../../apps/api/src/modules/platform/identity/application/session-token';

const alice = 'alice' as AdminId;
const bob = 'bob' as AdminId;

describe('last owner protection', () => {
  it('refuses to remove the only active owner', () => {
    expect(() => assertOwnerSurvives({ activeOwnerCount: 1, targetIsActiveOwner: true })).toThrow();
  });

  it('names a recoverable action rather than just refusing', () => {
    // An error that says "denied" and stops leaves the operator guessing. This
    // one says what to do instead.
    let caught: unknown;
    try {
      assertOwnerSurvives({ activeOwnerCount: 1, targetIsActiveOwner: true });
    } catch (error) {
      caught = error;
    }
    expect(isNexaError(caught)).toBe(true);
    expect((caught as Error).message).toMatch(/another active administrator/i);
    expect((caught as { details: { ownerRoleKey: string } }).details.ownerRoleKey).toBe(
      OWNER_ROLE_KEY,
    );
  });

  it('permits removing an owner while another active one remains', () => {
    expect(() =>
      assertOwnerSurvives({ activeOwnerCount: 2, targetIsActiveOwner: true }),
    ).not.toThrow();
  });

  it('does not block changes to an admin who is not an active owner', () => {
    expect(() =>
      assertOwnerSurvives({ activeOwnerCount: 1, targetIsActiveOwner: false }),
    ).not.toThrow();
  });

  it('refuses when the count is somehow already zero', () => {
    // Defensive: reaching zero means an earlier guard was bypassed, and the
    // right response is still to refuse rather than to let it go further.
    expect(() => assertOwnerSurvives({ activeOwnerCount: 0, targetIsActiveOwner: true })).toThrow();
  });
});

describe('self-modification', () => {
  it('refuses an admin changing themselves', () => {
    expect(() => assertNotSelf(alice, alice)).toThrow();
  });

  it('permits changing somebody else', () => {
    expect(() => assertNotSelf(alice, bob)).not.toThrow();
  });

  it('permits a system actor with no admin identity', () => {
    // Bootstrap has no acting admin. It is fenced by not being reachable from a
    // surface, not by this rule.
    expect(() => assertNotSelf(null, alice)).not.toThrow();
  });
});

describe('role diffing', () => {
  it('reports what was added and removed', () => {
    const delta = diffRoles(['support', 'finance'], ['finance', 'owner']);
    expect(delta.added).toEqual(['owner']);
    expect(delta.removed).toEqual(['support']);
    expect(delta.unchanged).toEqual(['finance']);
  });

  it('is stable regardless of input order, so an audit row is comparable', () => {
    expect(diffRoles(['b', 'a'], ['a', 'b'])).toEqual({
      added: [],
      removed: [],
      unchanged: ['a', 'b'],
    });
  });

  it('detects losing the owner role', () => {
    expect(losesOwnerRole(diffRoles(['owner'], ['support']))).toBe(true);
    expect(losesOwnerRole(diffRoles(['owner'], ['owner', 'support']))).toBe(false);
  });
});

describe('session tokens', () => {
  it('generates unguessable, distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
    // 32 bytes base64url.
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  it('carries no information about who holds it', () => {
    // Not a UUID and not derived from an admin id: a bearer credential must not
    // encode its subject.
    const token = generateSessionToken();
    expect(token).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/i);
  });

  it('hashes deterministically, and the hash is not the token', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toHaveLength(64);
  });

  it('compares hashes without leaking length or content', () => {
    const a = hashSessionToken('one');
    expect(tokenHashesMatch(a, a)).toBe(true);
    expect(tokenHashesMatch(a, hashSessionToken('two'))).toBe(false);
    expect(tokenHashesMatch(a, 'short')).toBe(false);
  });
});
