import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { readGuard, runInventoryAcceptance } from '../acceptance-readonly/inventory-acceptance';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';

/**
 * The C1 procedure (`tests/acceptance-readonly/inventory-acceptance.ts`) run against the
 * FAKE panel. This proves the runbook's mechanics — the checks fire, the report is
 * aggregate-only, the write guard refuses — and is NOT evidence about a real RickPanel.
 */

let panel: FakeRickpanel;
let target: ProviderTarget;

const http = () =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 512 * 1024,
    maxRetries: 0,
  }).forBase(panel.baseUrl);

beforeEach(async () => {
  panel = await startFakeRickpanel();
  target = {
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
  };
  for (let i = 0; i < 23; i += 1) panel.seedUser(`acct${String(i).padStart(2, '0')}`);
});
afterEach(async () => {
  await panel.close();
});

describe('C1 procedure', () => {
  it('passes every check on a well-behaved panel, and reports aggregates only', async () => {
    const report = await runInventoryAcceptance({
      target,
      http: http(),
      knownUsername: 'acct07',
      pageSize: 5,
    });
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.first).toMatchObject({
      reportedTotal: 23,
      distinctUsernames: 23,
      pages: 5,
      firstPageRows: 5,
      lastPageRows: 3,
      states: { active: 23 },
    });
    expect(report.refusedWrites).toBe(0);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/acct\d\d/i);
    expect(text).not.toMatch(/token|sub_|subscription|password/i);
  });

  it('fails the stability check when the panel changes between the walks', async () => {
    let walks = 0;
    panel.beforeListPage = (offset) => {
      if (offset === 0) {
        walks += 1;
        if (walks === 2) panel.seedUser('latecomer');
      }
    };
    const report = await runInventoryAcceptance({ target, http: http(), knownUsername: 'acct01' });
    expect(report.countDrift).toBe(1);
    expect(report.checks.find((c) => c.name === 'count stable within tolerance')?.pass).toBe(false);
    const tolerant = await runInventoryAcceptance({
      target,
      http: http(),
      knownUsername: 'acct01',
      driftTolerance: 1,
    });
    expect(tolerant.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it('fails the lookup check for a name the panel does not hold', async () => {
    const report = await runInventoryAcceptance({ target, http: http(), knownUsername: 'nobody' });
    expect(report.knownLookup).toBe('NOT_FOUND');
    expect(report.checks.find((c) => c.name.startsWith('known username found'))?.pass).toBe(false);
  });

  it('the guard refuses, without sending, anything that is not a read', async () => {
    const guard = readGuard(http());
    for (const method of ['PUT', 'DELETE', 'POST'] as const) {
      const result = await guard.client.send({ method, path: 'api/user/acct01' });
      expect(result).toMatchObject({ ok: false, failure: 'BLOCKED_TARGET' });
    }
    expect(guard.refused()).toBe(3);
    expect(guard.sent()).toBe(0);
    expect(panel.requests).toHaveLength(0);
  });
});
