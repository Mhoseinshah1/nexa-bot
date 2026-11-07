import { describe, expect, it } from 'vitest';
import { HOSTING_ACTIVATION_ERROR_CODES as CODES } from '@nexa/contracts';
import {
  judgeDns,
  normaliseHost,
  parseHostedDomain,
} from '../../apps/api/src/modules/platform/hosting/domain/hosted-domain';
import {
  activationLinkState,
  digestsEqual,
  generateActivationToken,
  hashActivationToken,
} from '../../apps/api/src/modules/platform/hosting/domain/activation-link';
import { DomainCheckBudget } from '../../apps/api/src/surfaces/web/hosted-activation.controller';

const RESERVED = new Set(['admin.owner.com']);

describe('hosted domains (phase 6A PR-4)', () => {
  it('normalises a Host header and refuses what could never be a hosted domain', () => {
    expect(normaliseHost('Bots.Alpha-Store.COM')).toBe('bots.alpha-store.com');
    expect(normaliseHost('bots.alpha-store.com:8443')).toBe('bots.alpha-store.com');
    expect(normaliseHost('bots.alpha-store.com.')).toBe('bots.alpha-store.com');
    for (const bad of [
      undefined,
      null,
      '',
      '1.2.3.4',
      '[::1]:3000',
      'nodots',
      'a..b.com',
      '-a.com',
      'a_b.com',
      'a b.com',
      'x.com:abc',
      'x'.repeat(300),
    ]) {
      expect(normaliseHost(bad as string | null | undefined)).toBeNull();
    }
  });

  it('parses a typed domain: bare names only, not the server’s own, not never-public ones', () => {
    expect(parseHostedDomain('Bots.Alpha-Store.com', RESERVED)).toEqual({
      ok: true,
      domain: 'bots.alpha-store.com',
    });
    for (const bad of [
      'https://bots.alpha-store.com',
      'bots.alpha-store.com/x',
      'user@bots.com',
      'bots.com:443',
      'localhost',
      'box.local',
      'x.internal',
      '10.0.0.1',
    ]) {
      expect(parseHostedDomain(bad, RESERVED)).toEqual({
        ok: false,
        code: CODES.DOMAIN_INVALID,
      });
    }
    expect(parseHostedDomain('ADMIN.owner.com.', RESERVED)).toEqual({
      ok: false,
      code: CODES.DOMAIN_RESERVED,
    });
  });

  it('judges DNS: the owner’s CNAME, or EVERY address ours — never a mix', () => {
    const expected = { hostname: 'admin.owner.com', addresses: ['203.0.113.10', '2001:db8::1'] };
    expect(judgeDns({ cname: ['admin.owner.com'], addresses: [] }, expected)).toBe('POINTED');
    expect(judgeDns({ cname: [], addresses: ['203.0.113.10'] }, expected)).toBe('POINTED');
    expect(judgeDns({ cname: [], addresses: ['2001:DB8::1', '203.0.113.10'] }, expected)).toBe(
      'POINTED',
    );
    expect(judgeDns({ cname: ['other.com'], addresses: ['198.51.100.1'] }, expected)).toBe(
      'NOT_POINTED',
    );
    expect(judgeDns({ cname: [], addresses: ['203.0.113.10', '198.51.100.1'] }, expected)).toBe(
      'NOT_POINTED',
    );
    expect(judgeDns({ cname: [], addresses: [] }, expected)).toBe('NOT_POINTED');
    // Nothing configured to compare with is never "pointed".
    expect(
      judgeDns(
        { cname: ['admin.owner.com'], addresses: ['203.0.113.10'] },
        { hostname: null, addresses: [] },
      ),
    ).toBe('NOT_POINTED');
  });

  it('activation tokens: 256 random bits, prefixed, hashed with a domain separator, compared in constant time', () => {
    const a = generateActivationToken();
    const b = generateActivationToken();
    expect(a).toMatch(/^nxact_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashActivationToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashActivationToken(a)).toBe(hashActivationToken(a));
    expect(hashActivationToken(a)).not.toBe(hashActivationToken(b));
    expect(hashActivationToken(a)).not.toContain(a);
    expect(digestsEqual(hashActivationToken(a), hashActivationToken(a))).toBe(true);
    expect(digestsEqual(hashActivationToken(a), hashActivationToken(b))).toBe(false);
    expect(digestsEqual('ab', 'abc')).toBe(false);
  });

  it('a link is ACTIVE, USED, or EXPIRED (a revoked one reads as expired)', () => {
    const now = new Date('2026-11-05T12:00:00Z');
    const later = new Date('2026-11-06T12:00:00Z');
    expect(activationLinkState({ usedAt: null, revokedAt: null, expiresAt: later }, now)).toBe(
      'ACTIVE',
    );
    expect(activationLinkState({ usedAt: now, revokedAt: null, expiresAt: later }, now)).toBe(
      'USED',
    );
    expect(activationLinkState({ usedAt: null, revokedAt: now, expiresAt: later }, now)).toBe(
      'EXPIRED',
    );
    // Expiry is exclusive: at the instant itself it is over.
    expect(activationLinkState({ usedAt: null, revokedAt: null, expiresAt: now }, now)).toBe(
      'EXPIRED',
    );
  });

  it('the certificate question’s budget is per minute and resets', () => {
    let at = 0;
    const budget = new DomainCheckBudget(() => at, 3);
    expect([1, 2, 3, 4, 5].map(() => budget.admit())).toEqual([true, true, true, false, false]);
    at += 60_000;
    expect(budget.admit()).toBe(true);
  });
});
