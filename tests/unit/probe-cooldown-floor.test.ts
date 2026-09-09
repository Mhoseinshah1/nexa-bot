import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_REQUESTS_PER_PROBE, PROVIDER_DESCRIPTORS } from '@nexa/contracts';

/**
 * The per-panel probe cooldown must outlast a probe.
 *
 * The cooldown exists so a second probe cannot start while the first is still
 * on the wire. It was floored on `timeout * (1 + retries)` — ONE request's
 * budget — because `SafeHttpClient` starts its deadline per request and a probe
 * was assumed to be one request.
 *
 * It is not. Marzban's probe is a token exchange and a status read. 3X-UI's
 * session probe is a CSRF token, a two-factor pre-check, a login and a status
 * read. At the shipped defaults that made the floor ten seconds while a session
 * probe could occupy forty, so a second probe of the same panel could be granted
 * while the first login sequence was still running — against a panel that counts
 * failed logins per address and username. The cooldown's whole purpose is to
 * avoid locking an operator out of their own panel on Nexa's behalf, and it was
 * understating the work it bounded by a factor of four.
 */
describe('the probe cooldown floor', () => {
  it('covers the longest probe any registered provider can make', () => {
    // Derived, not restated. A hand-written constant here would be a second
    // copy that a new adapter silently falsifies.
    const worst = Math.max(...PROVIDER_DESCRIPTORS.map((d) => d.maxRequestsPerProbe));
    expect(MAX_REQUESTS_PER_PROBE).toBe(worst);
  });

  it('counts more than one request, which is the whole point', () => {
    // The bug was a floor of exactly one request's budget. If this ever returns
    // to 1 — because a descriptor lost its count, or the derivation broke — the
    // race is open again and silently so.
    expect(MAX_REQUESTS_PER_PROBE).toBeGreaterThan(1);
  });

  /**
   * Each declared count, with the path that justifies it.
   *
   * `sends` is the number of `http.send(` CALL SITES in the adapter, which is
   * an upper bound rather than the answer: Sanaei has five because its bearer
   * mode and its session mode each end in a status read, and those are
   * alternatives rather than additions. Its longest path is four. Recording
   * both numbers is the point — a reader comparing a declared 4 against a
   * grep that says 5 would otherwise conclude one of them is wrong.
   */
  const EXPECTED: Readonly<Record<string, { longestPath: number; sends: number; file: string }>> = {
    marzban: {
      longestPath: 2,
      sends: 2,
      file: 'apps/api/src/modules/platform/providers/infrastructure/marzban.adapter.ts',
    },
    sanaei: {
      longestPath: 4,
      sends: 5,
      file: 'apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter.ts',
    },
  };

  it('declares, for every provider, the length of its longest probe path', () => {
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const expected = EXPECTED[descriptor.key];
      expect(expected, `${descriptor.key} has no row in this test`).toBeDefined();
      expect(descriptor.maxRequestsPerProbe).toBe(expected?.longestPath);
    }
    // Both directions, so a provider added without a row fails rather than
    // being skipped — the failure mode this repository keeps finding.
    expect(Object.keys(EXPECTED).sort()).toEqual(PROVIDER_DESCRIPTORS.map((d) => d.key).sort());
  });

  it('never declares more requests than the adapter has call sites', () => {
    // Read from the SOURCE, because the declared number is arithmetic only the
    // adapter's flow justifies, and an adapter that grows a request without
    // raising its count reopens the race with nothing to object. A count above
    // the call-site total cannot be right either — it would be a longer
    // cooldown bought with a number nothing supports.
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      const expected = EXPECTED[descriptor.key];
      if (expected === undefined) continue;
      const source = readFileSync(join(__dirname, '../..', expected.file), 'utf8');
      const sends = [...source.matchAll(/http\.send\(/g)].length;
      expect(sends, `${descriptor.key}'s call-site count changed`).toBe(expected.sends);
      expect(descriptor.maxRequestsPerProbe).toBeLessThanOrEqual(sends);
    }
  });
});
