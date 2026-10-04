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
    const report = await runInventoryAcceptance({
      target,
      http: http(),
      knownUsername: 'acct01',
      maxAttempts: 1,
    });
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

  it('walks a fresh pair after drift, reports every attempt, and judges only the last', async () => {
    // Program Item 2: "drift => retry/document". The panel changes once, before walk 2.
    let walks = 0;
    panel.beforeListPage = (offset) => {
      if (offset === 0) {
        walks += 1;
        if (walks === 2) panel.seedUser('latecomer');
      }
    };
    const report = await runInventoryAcceptance({ target, http: http(), knownUsername: 'acct01' });
    expect(report.attempts.map((a) => a.setDrift)).toEqual([1, 0]);
    expect(report.attempts.map((a) => a.countDrift)).toEqual([1, 0]);
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.first.distinctUsernames).toBe(24);
  });

  it('never calls a panel complete while it keeps drifting', async () => {
    let added = 0;
    panel.beforeListPage = (offset) => {
      if (offset === 0) panel.seedUser(`drifter${String((added += 1))}`);
    };
    const report = await runInventoryAcceptance({
      target,
      http: http(),
      knownUsername: 'acct01',
      maxAttempts: 3,
    });
    expect(report.attempts).toHaveLength(3);
    expect(report.attempts.every((a) => a.setDrift === 1)).toBe(true);
    const failed = report.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toContain('two consecutive walks identical (indexable)');
    expect(failed).toContain("the matcher's listAll reports a complete inventory");
    expect(report.matcherInventory).toBe('WALKS_DIFFER');
  });

  it("exercises the matcher's own listAll and requires it to agree with the walks", async () => {
    const report = await runInventoryAcceptance({ target, http: http(), knownUsername: 'acct03' });
    expect(report.matcherInventory).toBe('COMPLETE');
    expect(report.matcherAgreesWithWalks).toBe(true);
    // A panel that changes only during listAll's walks is caught by it, not by the pair.
    let walks = 0;
    panel.beforeListPage = (offset) => {
      if (offset === 0 && (walks += 1) === 4) panel.seedUser('only-in-listall');
    };
    const late = await runInventoryAcceptance({ target, http: http(), knownUsername: 'acct03' });
    expect(late.matcherInventory).toBe('WALKS_DIFFER');
    expect(late.checks.find((c) => c.name === 'listAll returns exactly the walked set')?.pass).toBe(
      false,
    );
  });

  it('matches the known account by its EXACT provider spelling, never a lowercase fold', async () => {
    panel.seedUser('Mixed07');
    const exact = await runInventoryAcceptance({ target, http: http(), knownUsername: 'Mixed07' });
    expect(exact.knownInInventory).toBe(true);
    expect(exact.checks.filter((c) => !c.pass)).toEqual([]);
    const folded = await runInventoryAcceptance({ target, http: http(), knownUsername: 'mixed07' });
    expect(folded.knownInInventory).toBe(false);
  });

  it('every request the panel itself saw was a read, and the report counts them exactly', async () => {
    const report = await runInventoryAcceptance({
      target,
      http: http(),
      knownUsername: 'acct07',
      pageSize: 5,
    });
    // The panel is the independent observer: no method but GET, and POST only to the
    // token exchange.
    const methods = panel.requests.map((r) =>
      r.method === 'POST' && r.path === '/api/admin/token' ? 'TOKEN' : r.method,
    );
    expect(new Set(methods)).toEqual(new Set(['TOKEN', 'GET']));
    expect(panel.requests).toHaveLength(report.requests);
    expect(report.requestsByKind).toEqual({
      loginExchange: methods.filter((m) => m === 'TOKEN').length,
      listPage: panel.listCalls(),
      readUser: 2,
      otherRead: 0,
    });
    // Four walks of five pages each (one pair, then listAll's two).
    expect(report.requestsByKind.listPage).toBe(20);
    expect(panel.putCalls() + panel.createCalls() + panel.revokeCalls()).toBe(0);
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
