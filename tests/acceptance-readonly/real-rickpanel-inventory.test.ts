import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFE_HTTP, SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { runInventoryAcceptance } from './inventory-acceptance';

/**
 * Item C1 — the READ-ONLY inventory against a REAL RickPanel
 * (`docs/rickpanel-inventory-acceptance.md`).
 *
 * `pnpm test:acceptance:inventory`. Not in `pnpm verify`, not in CI, and NOT part of
 * `pnpm test:acceptance`: that suite creates and deletes accounts and must only ever see a
 * disposable panel, while this one is meant for a production-like panel and must only ever
 * read. Separate variables, so pointing one at a panel never arms the other.
 *
 * Without the variables it FAILS rather than skips: a skipped acceptance reports the same
 * green as a passing one, and C1 is unproven until this has run.
 */

const ENV = {
  url: 'NEXA_INVENTORY_RICKPANEL_URL',
  username: 'NEXA_INVENTORY_RICKPANEL_USERNAME',
  password: 'NEXA_INVENTORY_RICKPANEL_PASSWORD',
  known: 'NEXA_INVENTORY_KNOWN_USERNAME',
  pageSize: 'NEXA_INVENTORY_PAGE_SIZE',
  drift: 'NEXA_INVENTORY_DRIFT_TOLERANCE',
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. C1 reads a REAL RickPanel and will not pretend to have read one. ` +
        'See docs/rickpanel-inventory-acceptance.md.',
    );
  }
  return value.trim();
}

function optionalInt(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a count`);
  return parsed;
}

describe('C1: real RickPanel read-only inventory', () => {
  it('walks, re-walks, looks up, and writes nothing', async () => {
    const baseUrl = required(ENV.url);
    const pageSize = optionalInt(ENV.pageSize);
    const report = await runInventoryAcceptance({
      target: {
        baseUrl,
        credentials: {
          shape: 'USERNAME_PASSWORD',
          username: required(ENV.username),
          password: required(ENV.password),
        },
      },
      http: new SafeHttpClient({
        ...DEFAULT_SAFE_HTTP,
        allowLoopback: false,
        maxResponseBytes: 2 * 1024 * 1024,
      }).forBase(baseUrl),
      knownUsername: required(ENV.known),
      ...(pageSize === undefined ? {} : { pageSize }),
      driftTolerance: optionalInt(ENV.drift) ?? 0,
    });

    // AGGREGATE ONLY. No username, link, token or id is in this object by construction.
    console.log(`C1 evidence ${JSON.stringify(report, null, 2)}`);

    expect(report.refusedWrites).toBe(0);
    for (const check of report.checks) {
      expect({ check: check.name, pass: check.pass }).toEqual({ check: check.name, pass: true });
    }
  });
});
