import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTarget } from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import {
  RICKPANEL_DOCUMENTED_MODIFY_FIELDS,
  TELEMETRY_FIELDS,
  WRITE_FIELDS,
  classifySubscription,
  reportableMediaType,
  runSubscriptionAcceptance,
} from '../acceptance-readonly/subscription-acceptance';
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

const run = (knownUsername = 'LegacyUser7', allowedOrigins: readonly string[] = []) =>
  runSubscriptionAcceptance({
    target,
    http: client(panel.baseUrl),
    subscriptionHttp: (origin) => client(origin),
    knownUsername,
    allowedOrigins,
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
      fetch: {
        status: 200,
        contentType: 'text/plain',
        format: 'BASE64_SHARE_LINKS',
        entries: 1,
        failure: null,
      },
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
      'the served body is a recognised subscription format',
    ]);
  });

  it('fails when the link does not serve, or serves nothing', async () => {
    panel.subscriptionMode = 'missing';
    expect(failed(await run())).toEqual([
      'the subscription link answers 2xx to a GET',
      'the subscription body is non-empty',
      'the served body is a recognised subscription format',
    ]);
    panel.subscriptionMode = 'empty';
    expect(failed(await run())).toEqual([
      'the subscription body is non-empty',
      'the served body is a recognised subscription format',
    ]);
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

  // ---- Codex review of PR #178 -------------------------------------------------------

  it('R1: a 2xx page that is not a subscription (a login or WAF page) is not "served"', async () => {
    panel.subscriptionMode = 'html';
    panel.subscriptionContentType = 'text/html; charset=utf-8';
    const report = await run();
    expect(report.fetch).toMatchObject({ status: 200, format: 'UNRECOGNISED', entries: 0 });
    expect(report.fetch.bytes).toBeGreaterThan(0);
    expect(failed(report)).toEqual(['the served body is a recognised subscription format']);
    expect(JSON.stringify(report)).not.toMatch(/Sign in|login|<form/iu);
  });

  it('R2: a 2xx record for a DIFFERENT account is not the known account', async () => {
    for (const other of ['someone-else', 'legacyuser7']) {
      panel.userReadExtras['username'] = other;
      const report = await run();
      expect(report.recordBefore, other).toBe('WRONG_ACCOUNT');
      expect(failed(report), other).toContain('known account read by GET');
      expect(report.linkPresent).toBe(false);
    }
    expect(panel.subscriptionReads()).toBe(0);
  });

  it('R3: a change to auto_delete_in_days (a documented modify field) is a write-field change', async () => {
    panel.userReadExtras['auto_delete_in_days'] = null;
    const report = await runSubscriptionAcceptance({
      target,
      http: client(panel.baseUrl),
      subscriptionHttp: (origin) => {
        panel.userReadExtras['auto_delete_in_days'] = 7;
        return client(origin);
      },
      knownUsername: 'LegacyUser7',
    });
    expect(report.changedWriteFields).toEqual(['auto_delete_in_days']);
    expect(failed(report)).toEqual(['no write-relevant field changed']);
  });

  it('R4: the content type is reported as an allowlisted media type, never verbatim', async () => {
    panel.subscriptionContentType = 'text/plain; charset=utf-8; token=leaked-secret-value';
    const plain = await run();
    expect(plain.fetch.contentType).toBe('text/plain');
    expect(JSON.stringify(plain)).not.toContain('leaked-secret-value');
    panel.subscriptionContentType = 'application/x-leaked-secret-value';
    const other = await run();
    expect(other.fetch.contentType).toBe('OTHER');
    expect(JSON.stringify(other)).not.toContain('leaked-secret-value');
  });

  it("R6: a link off the panel's origin is refused without sending, unless that origin is allowed", async () => {
    const elsewhere = 'http://127.0.0.9:9';
    panel.userReadExtras['subscription_url'] = `${elsewhere}/sub/LegacyUser7/legacy-sub-token-0001`;
    const dialled: string[] = [];
    const report = await runSubscriptionAcceptance({
      target,
      http: client(panel.baseUrl),
      subscriptionHttp: (origin) => {
        dialled.push(origin);
        return client(origin);
      },
      knownUsername: 'LegacyUser7',
    });
    expect(dialled).toEqual([]);
    expect(report.linkOnPanelOrigin).toBe(false);
    expect(report.fetch).toMatchObject({ status: null, failure: 'ORIGIN_NOT_ALLOWED' });
    expect(failed(report)).toContain('the subscription link answers 2xx to a GET');
    expect(JSON.stringify(report)).not.toContain('127.0.0.9');

    // The operator's explicit allowance is the only way to another origin: the fake's
    // own origin, named explicitly, is fetched.
    panel.userReadExtras['subscription_url'] =
      `${panel.baseUrl}/sub/LegacyUser7/legacy-sub-token-0001`;
    const allowed = await run('LegacyUser7', [new URL(panel.baseUrl).origin]);
    expect(failed(allowed)).toEqual([]);
  });

  it('fails for an account the panel does not hold, sent exactly as spelled', async () => {
    const report = await run('legacyuser7');
    expect(report.recordBefore).toBe('NOT_FOUND');
    expect(failed(report)).toContain('known account read by GET');
    expect(panel.subscriptionReads()).toBe(0);
  });
});

describe('C3 pure pieces', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('classifies the subscription formats clients import, and nothing else', () => {
    const links =
      'vless://a@h:443?x=1#one\nvmess://eyJ2IjoyfQ==\ntrojan://p@h:443\nss://YWVz@h:8388';
    expect(classifySubscription(b64(links))).toEqual({ format: 'BASE64_SHARE_LINKS', entries: 4 });
    expect(classifySubscription(links)).toEqual({ format: 'PLAIN_SHARE_LINKS', entries: 4 });
    expect(classifySubscription(JSON.stringify({ outbounds: [{}, {}] }))).toEqual({
      format: 'JSON_CONFIG',
      entries: 2,
    });
    expect(
      classifySubscription(JSON.stringify([{ outbounds: [{}] }, { outbounds: [{}] }])),
    ).toEqual({ format: 'JSON_CONFIG', entries: 2 });
    expect(
      classifySubscription('port: 7890\nproxies:\n  - name: a\n    type: vless\n  - { name: b }\n'),
    ).toEqual({ format: 'CLASH_YAML', entries: 2 });
    for (const page of [
      '',
      '   ',
      '<!doctype html><title>Login</title>',
      b64('<html>Access denied</html>'),
      'Forbidden',
      JSON.stringify({ detail: 'Not Found' }),
      JSON.stringify([]),
      'https://example.test/a\nhttps://example.test/b',
      `${links}\n<p>trailing page</p>`,
      'proxies:\n',
    ]) {
      expect(classifySubscription(page), page).toEqual({ format: 'UNRECOGNISED', entries: 0 });
    }
  });

  it('reduces the content type to an allowlisted media type', () => {
    expect(reportableMediaType('Text/Plain; charset=utf-8; token=abc')).toBe('text/plain');
    expect(reportableMediaType('application/json')).toBe('application/json');
    expect(reportableMediaType('application/x-abc-token')).toBe('OTHER');
    expect(reportableMediaType(undefined)).toBeNull();
  });

  it('covers every documented RickPanel modify field: a write field or reported telemetry', () => {
    const covered = new Set<string>([...WRITE_FIELDS, ...TELEMETRY_FIELDS]);
    for (const field of RICKPANEL_DOCUMENTED_MODIFY_FIELDS) expect(covered, field).toContain(field);
    expect(WRITE_FIELDS).toContain('auto_delete_in_days');
    expect(RICKPANEL_DOCUMENTED_MODIFY_FIELDS).toHaveLength(12);
  });
});
