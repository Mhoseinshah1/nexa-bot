import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { runSubscriptionAcceptance } from '../acceptance-readonly/subscription-acceptance';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';

/**
 * The C3 read-only step (`tests/acceptance-readonly/subscription-acceptance.ts`) run
 * against the FAKE panel. It proves the mechanics — every check can fail, nothing but a
 * read is sent, the report carries no username, link, token or body — and is NOT
 * evidence that a real RickPanel serves a pre-existing account's subscription.
 */

let panel: FakeRickpanel;
let target: ProviderTarget;

const client = (base: string) =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 512 * 1024,
    maxRetries: 0,
  }).forBase(base);

const run = (knownUsername = 'LegacyUser7') =>
  runSubscriptionAcceptance({
    target,
    http: client(panel.baseUrl),
    subscriptionHttp: (origin) => client(origin),
    knownUsername,
  });

const failed = (report: Awaited<ReturnType<typeof run>>) =>
  report.checks.filter((c) => !c.pass).map((c) => c.name);

beforeEach(async () => {
  panel = await startFakeRickpanel();
  target = {
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
  };
  // An account the panel holds that NEXA never created, with a mixed-case name.
  panel.seedUser('LegacyUser7', { subToken: 'legacy-sub-token-0001' });
});
afterEach(async () => {
  await panel.close();
});

describe('C3 read-only subscription step', () => {
  it('reads the account, fetches its own link once by GET, and changes nothing', async () => {
    const before = structuredClone(panel.users.get('LegacyUser7'));
    const report = await run();
    expect(failed(report)).toEqual([]);
    expect(report).toMatchObject({
      recordBefore: 'FOUND',
      recordAfter: 'FOUND',
      linkPresent: true,
      linkOnPanelOrigin: true,
      fetch: { status: 200, contentType: 'text/plain; charset=utf-8', failure: null },
      changedWriteFields: [],
      refusedWrites: 0,
    });
    expect(report.fetch.bytes).toBeGreaterThan(0);
    // The panel's own telemetry of a client fetch is reported by name, not as a failure.
    expect(report.changedTelemetryFields).toEqual(['sub_updated_at']);

    // The panel, as the independent observer: two logins, two user reads, one fetch, and
    // nothing that writes.
    expect(
      panel.requests.map((r) => `${r.method} ${r.path.split('/').slice(0, 3).join('/')}`),
    ).toEqual([
      'POST /api/admin',
      'GET /api/user',
      'GET /sub/LegacyUser7',
      'POST /api/admin',
      'GET /api/user',
    ]);
    expect(report.requests).toBe(panel.requests.length);
    expect(panel.subscriptionReads()).toBe(1);
    expect(panel.putCalls() + panel.createCalls() + panel.revokeCalls()).toBe(0);
    const after = panel.users.get('LegacyUser7');
    expect(after).toEqual(before);
  });

  it('prints nothing but aggregates: no username, link, token or body', async () => {
    const text = JSON.stringify(await run());
    expect(text).not.toMatch(/LegacyUser7|legacyuser7/u);
    expect(text).not.toMatch(/legacy-sub-token|\/sub\/|http:|vless|password/iu);
    // The body the fake serves is base64; no fragment of it either.
    const body = Buffer.from('vless://legacy-sub-token-0001@node.example.test:443').toString(
      'base64',
    );
    expect(text).not.toContain(body.slice(0, 12));
  });

  it('fails when the record carries no link — and never builds one', async () => {
    panel.omitSubscriptionLink = true;
    const report = await run();
    expect(report.linkPresent).toBe(false);
    expect(report.fetch.failure).toBe('NO_LINK');
    expect(panel.subscriptionReads()).toBe(0);
    expect(failed(report)).toEqual([
      "the panel's record carries a subscription link",
      'the subscription link answers 2xx to a GET',
      'the subscription body is non-empty',
    ]);
  });

  it('fails when the link does not serve, or serves nothing', async () => {
    panel.subscriptionMode = 'missing';
    expect(failed(await run())).toEqual([
      'the subscription link answers 2xx to a GET',
      'the subscription body is non-empty',
    ]);
    panel.subscriptionMode = 'empty';
    expect(failed(await run())).toEqual(['the subscription body is non-empty']);
  });

  it('fails when a write-relevant field moved between the two reads', async () => {
    // Something changes the account while the step runs (an operator, a renewal): the
    // step must not report "unchanged". Simulated by rotating the token before the fetch.
    const original = panel.users.get('LegacyUser7');
    if (original === undefined) throw new Error('seeded');
    const report = await runSubscriptionAcceptance({
      target,
      http: client(panel.baseUrl),
      subscriptionHttp: (origin) => {
        original.status = 'disabled';
        return client(origin);
      },
      knownUsername: 'LegacyUser7',
    });
    expect(report.changedWriteFields).toEqual(['status']);
    expect(failed(report)).toEqual(['no write-relevant field changed']);
  });

  it('fails for an account the panel does not hold, sent exactly as spelled', async () => {
    const report = await run('legacyuser7');
    expect(report.recordBefore).toBe('NOT_FOUND');
    expect(failed(report)).toContain('known account read by GET');
    expect(panel.subscriptionReads()).toBe(0);
  });
});
