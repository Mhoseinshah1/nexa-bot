import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFE_HTTP, SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { runSubscriptionAcceptance } from './subscription-acceptance';

/**
 * Item C3 — an adopted account stays usable with ZERO provider mutation, against a REAL
 * RickPanel (`docs/c3-subscription-ref-rickpanel.md`, "Manual acceptance").
 *
 * Runs in `pnpm test:acceptance:inventory` beside C1, with the SAME variables: one known
 * account, read, its own link fetched once by GET, read again. Read-only twice over —
 * the panel is reached only through the inventory's three fixed reads, and both clients
 * sit behind a guard that refuses anything but a GET or the login exchange.
 *
 * Without the variables it FAILS rather than skips, like C1.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. C3 reads a REAL RickPanel and will not pretend to have read one. ` +
        'See docs/c3-subscription-ref-rickpanel.md.',
    );
  }
  return value.trim();
}

const client = (base: string) =>
  new SafeHttpClient({
    ...DEFAULT_SAFE_HTTP,
    allowLoopback: false,
    maxResponseBytes: 2 * 1024 * 1024,
  }).forBase(base);

describe('C3: an existing account is usable with zero provider mutation', () => {
  it('reads it, fetches its own subscription link once by GET, and changes nothing', async () => {
    const baseUrl = required('NEXA_INVENTORY_RICKPANEL_URL');
    const report = await runSubscriptionAcceptance({
      target: {
        baseUrl,
        credentials: {
          shape: 'USERNAME_PASSWORD',
          username: required('NEXA_INVENTORY_RICKPANEL_USERNAME'),
          password: required('NEXA_INVENTORY_RICKPANEL_PASSWORD'),
        },
      },
      http: client(baseUrl),
      subscriptionHttp: client,
      knownUsername: required('NEXA_INVENTORY_KNOWN_USERNAME'),
    });

    // AGGREGATE ONLY: status, content type, byte count and field NAMES. No username,
    // link, token or body is in this object by construction.
    console.log(`C3 evidence ${JSON.stringify(report, null, 2)}`);

    expect(report.refusedWrites).toBe(0);
    for (const check of report.checks) {
      expect({ check: check.name, pass: check.pass }).toEqual({ check: check.name, pass: true });
    }
  });
});
