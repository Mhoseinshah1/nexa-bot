import { describe, expect, it } from 'vitest';
import {
  ipThrottleSubject,
  matchesTrustedEntry,
  trustProxyOption,
} from '../../apps/api/src/infrastructure/trusted-proxy';

describe('trustProxy option', () => {
  it('trusts nothing when no upstream is configured', () => {
    // The safe default: X-Forwarded-For is ignored and the client IP is the
    // socket address, which nobody can forge over TCP.
    expect(trustProxyOption([])).toBe(false);
  });

  it('passes the configured upstreams through as a list', () => {
    expect(trustProxyOption(['127.0.0.1', '10.0.0.0/8'])).toEqual(['127.0.0.1', '10.0.0.0/8']);
  });

  it('never produces `true`', () => {
    // `true` believes the header from whoever connected, so a client reaching
    // the port directly could choose its own IP for throttling and audit.
    for (const input of [[], ['127.0.0.1'], ['::1', '10.0.0.0/8']]) {
      expect(trustProxyOption(input)).not.toBe(true);
    }
  });
});

describe('trusted entry matching', () => {
  it('matches an exact address', () => {
    expect(matchesTrustedEntry('10.1.2.3', '10.1.2.3')).toBe(true);
    expect(matchesTrustedEntry('10.1.2.4', '10.1.2.3')).toBe(false);
  });

  it('matches inside a CIDR range and not outside it', () => {
    expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(matchesTrustedEntry('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(matchesTrustedEntry('192.168.1.55', '192.168.1.0/24')).toBe(true);
    expect(matchesTrustedEntry('192.168.2.55', '192.168.1.0/24')).toBe(false);
  });

  it('compares bits, not string prefixes', () => {
    // `10.1.1.10` starts with the text `10.1.1.1`, and a substring test would
    // quietly widen every configured range.
    expect(matchesTrustedEntry('10.1.1.10', '10.1.1.1')).toBe(false);
    expect(matchesTrustedEntry('192.168.1.1', '192.168.1.10/32')).toBe(false);
    // A non-byte-aligned prefix is honoured properly.
    expect(matchesTrustedEntry('10.0.127.1', '10.0.0.0/17')).toBe(true);
    expect(matchesTrustedEntry('10.0.128.1', '10.0.0.0/17')).toBe(false);
  });

  it('handles IPv6, including the compressed form', () => {
    expect(matchesTrustedEntry('::1', '::1')).toBe(true);
    expect(matchesTrustedEntry('fd00::1', 'fd00::/8')).toBe(true);
    expect(matchesTrustedEntry('fe00::1', 'fd00::/8')).toBe(false);
  });

  it('rejects nonsense rather than matching it', () => {
    expect(matchesTrustedEntry('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(matchesTrustedEntry('10.1.2.3', 'garbage/8')).toBe(false);
    expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/-1')).toBe(false);
    expect(matchesTrustedEntry('10.1.2.3', '10.0.0.0/99')).toBe(false);
    // Address families do not cross.
    expect(matchesTrustedEntry('::1', '10.0.0.0/8')).toBe(false);
  });
});

describe('per-IP throttle subject', () => {
  it('uses a real client address', () => {
    expect(ipThrottleSubject('203.0.113.7', ['127.0.0.1'])).toBe('203.0.113.7');
  });

  it('skips an absent or unparseable address', () => {
    for (const value of [null, undefined, '', 'unknown', 'not-an-ip']) {
      expect(ipThrottleSubject(value, [])).toBeNull();
    }
  });

  it('skips our own proxy, rather than throttling everyone as one subject', () => {
    // This is the misconfiguration case: running behind Caddy with the header
    // not believed, so every request appears to come from the proxy. Counting
    // failures against that address would lock out the whole installation on
    // one attacker's attempts.
    expect(ipThrottleSubject('127.0.0.1', ['127.0.0.1'])).toBeNull();
    expect(ipThrottleSubject('10.0.0.5', ['10.0.0.0/8'])).toBeNull();
    // A genuine client behind that same proxy is still throttled normally.
    expect(ipThrottleSubject('203.0.113.7', ['10.0.0.0/8'])).toBe('203.0.113.7');
  });
});
