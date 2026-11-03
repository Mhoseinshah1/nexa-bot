import { afterEach, describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_FILES_MAX_COUNT,
  SUBSCRIPTION_FILE_MAX_BYTES,
  panelDeliversConnectionFiles,
  type ProviderHttpClient,
  type ProviderHttpRequest,
  type ProviderServiceTarget,
  type ProviderUserRef,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { toHealthRecord } from '../../apps/api/src/modules/platform/panels/application/probe-core';
import { CustomPanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/custom-panel.adapter';
import {
  HEADER,
  canonicalResponse,
  parseAnnouncedCapabilities,
  sha256Hex,
  sign,
} from '../../apps/api/src/modules/platform/providers/infrastructure/custom-panel-protocol';
import { safeFileName } from '../../apps/api/src/modules/platform/providers/infrastructure/subscription-files';
import {
  BRIDGE_SECRET,
  bridgeTls,
  startFakeCustomBridge,
  type FakeCustomBridge,
} from '../support/fake-custom-bridge';

/**
 * v0.9.5 PR-3: the custom bridge's connection files (protocol v1.1, §5.1 and §5.10).
 *
 * The guards are reached from an in-memory client that signs exactly what it is told to
 * answer, so each refusal is a one-line fact about the adapter: the size bound and the
 * type bound are the two the round names, and each is mutation-checked (revert the
 * guard in `parseAccountFiles`, see the named case fail). The capability half runs
 * against the fake bridge over real HTTPS: one that announces `files` and one that does
 * not, which must keep working exactly as a v1.0 bridge did.
 */

const REF: ProviderUserRef = {
  username: 'nx7k2m9p4qwe',
  subscriptionRef: 'unused',
  clientId: '5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c',
};
const target: ProviderServiceTarget = {
  baseUrl: 'https://bridge.example.com/nexa/',
  credentials: { shape: 'OPAQUE_TOKEN', token: BRIDGE_SECRET },
  activation: {},
};
const adapter = new CustomPanelAdapter();

const b64 = (bytes: number, fill = 0x61): string => Buffer.alloc(bytes, fill).toString('base64');
const file = (over: Record<string, unknown> = {}) => ({
  name: 'nx7k2m9p4qwe.json',
  contentType: 'application/json',
  contentBase64: b64(16),
  ...over,
});

/** A client whose every answer is SIGNED for the request's own nonce. */
function signedAnswer(
  status: number,
  body: unknown,
  options: { readonly signed?: boolean } = {},
): { client: ProviderHttpClient; sent: ProviderHttpRequest[] } {
  const sent: ProviderHttpRequest[] = [];
  const client: ProviderHttpClient = {
    send: (request) => {
      sent.push(request);
      const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
      const nonce = request.headers?.[HEADER.nonce] ?? '';
      const signature = sign(
        BRIDGE_SECRET,
        canonicalResponse({ status, nonce, bodySha256: sha256Hex(bodyText) }),
      );
      return Promise.resolve({
        ok: true,
        status,
        headers: options.signed === false ? {} : { [HEADER.bridgeSignature]: signature },
        bodyText,
        setCookie: [],
      });
    },
  };
  return { client, sent };
}

const filesAnswer = (files: unknown[], over: Record<string, unknown> = {}) => ({
  username: REF.username,
  nexaRef: REF.clientId,
  files,
  ...over,
});

const fetchWith = async (status: number, body: unknown, options?: { signed?: boolean }) => {
  const { client, sent } = signedAnswer(status, body, options);
  const outcome = await adapter.fetchSubscriptionFiles(target, client, REF);
  return { outcome, sent };
};

describe('GET v1/accounts/{username}/files — the adapter (§5.10)', () => {
  it('asks by the service’s OWN username, signed, with no body', async () => {
    const { outcome, sent } = await fetchWith(200, filesAnswer([file()]));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('GET');
    expect(sent[0]?.path).toBe(`v1/accounts/${REF.username}/files`);
    expect(sent[0]?.body).toBeUndefined();
    expect(sent[0]?.headers?.[HEADER.signature]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(outcome.ok && outcome.found && outcome.files).toHaveLength(1);
  });

  it('decodes a file into name, type and bytes, with no caption and nothing refused', async () => {
    const { outcome } = await fetchWith(200, filesAnswer([file({ contentBase64: b64(5) })]));
    if (!outcome.ok || !outcome.found) throw new Error('expected files');
    expect(outcome.failed).toBe(0);
    expect(outcome.files[0]?.fileName).toBe('nx7k2m9p4qwe.json');
    expect(outcome.files[0]?.mediaType).toBe('application/json');
    expect(Buffer.from(outcome.files[0]!.bytes).toString('utf8')).toBe('aaaaa');
    expect(outcome.files[0]?.caption).toBeNull();
  });

  // ----- the two mutation-checked guards -------------------------------------------

  it('SIZE REFUSAL: a file one byte over SUBSCRIPTION_FILE_MAX_BYTES is refused, the rest sent', async () => {
    const { outcome } = await fetchWith(
      200,
      filesAnswer([
        file({ name: 'big.json', contentBase64: b64(SUBSCRIPTION_FILE_MAX_BYTES + 1) }),
        file({ name: 'small.json' }),
      ]),
    );
    if (!outcome.ok || !outcome.found) throw new Error('expected files');
    expect(outcome.files.map((one) => one.fileName)).toEqual(['small.json']);
    expect(outcome.failed).toBe(1);
  });

  it('SIZE: exactly SUBSCRIPTION_FILE_MAX_BYTES is accepted (the bound is inclusive)', async () => {
    const { outcome } = await fetchWith(
      200,
      filesAnswer([file({ contentBase64: b64(SUBSCRIPTION_FILE_MAX_BYTES) })]),
    );
    expect(outcome.ok && outcome.found && outcome.failed).toBe(0);
  });

  it('TYPE REFUSAL: a contentType outside the closed set is refused, never mapped or sent', async () => {
    const { outcome } = await fetchWith(
      200,
      filesAnswer([
        file({ name: 'run.exe', contentType: 'application/x-msdownload' }),
        file({ name: 'page.html', contentType: 'text/html' }),
        file({ name: 'params.json', contentType: 'application/json; charset=utf-8' }),
        file({ name: 'upper.json', contentType: 'Application/JSON' }),
        file({ name: 'none.json', contentType: undefined }),
        file({ name: 'ok.yaml', contentType: 'text/yaml' }),
      ]),
    );
    if (!outcome.ok || !outcome.found) throw new Error('expected files');
    expect(outcome.files.map((one) => [one.fileName, one.mediaType])).toEqual([
      ['ok.yaml', 'text/yaml'],
    ]);
    expect(outcome.failed).toBe(5);
  });

  // ----- the other bounds ------------------------------------------------------------

  it('the running total: files past 20 MiB in order are refused', async () => {
    const four = b64(4 * 1024 * 1024);
    const { outcome } = await fetchWith(
      200,
      filesAnswer(
        Array.from({ length: 6 }, (_, i) => file({ name: `f${String(i)}`, contentBase64: four })),
      ),
    );
    if (!outcome.ok || !outcome.found) throw new Error('expected files');
    expect(outcome.files).toHaveLength(5);
    expect(outcome.failed).toBe(1);
  });

  it('bad Base64, an empty file and a non-string content are refused one by one', async () => {
    const { outcome } = await fetchWith(
      200,
      filesAnswer([
        file({ contentBase64: 'not base64!' }),
        file({ contentBase64: 'YWJj' + '\n' }),
        file({ contentBase64: '' }),
        file({ contentBase64: 42 }),
        file(),
      ]),
    );
    expect(outcome.ok && outcome.found && [outcome.files.length, outcome.failed]).toEqual([1, 4]);
  });

  it('more than SUBSCRIPTION_FILES_MAX_COUNT entries is MALFORMED, never truncated', async () => {
    const many = Array.from({ length: SUBSCRIPTION_FILES_MAX_COUNT + 1 }, () => file());
    expect((await fetchWith(200, filesAnswer(many))).outcome).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 200,
    });
    const exactly = Array.from({ length: SUBSCRIPTION_FILES_MAX_COUNT }, () => file());
    const fine = (await fetchWith(200, filesAnswer(exactly))).outcome;
    expect(fine.ok && fine.found && fine.files).toHaveLength(SUBSCRIPTION_FILES_MAX_COUNT);
  });

  it.each([
    ['no files array', { username: REF.username, nexaRef: REF.clientId }],
    ['files not an array', filesAnswer([], { files: {} })],
    ['an entry that is not an object', filesAnswer([file(), 'x'])],
    ['another username', filesAnswer([file()], { username: 'someone-else' })],
    ['not JSON', 'this is not json'],
  ])('%s is MALFORMED, nothing returned', async (_, body) => {
    expect((await fetchWith(200, body)).outcome).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 200,
    });
  });

  it('an answer bound to ANOTHER nexaRef, or to none, is refused: no customer gets another’s files', async () => {
    for (const nexaRef of ['00000000-0000-4000-8000-000000000000', null]) {
      expect((await fetchWith(200, filesAnswer([file()], { nexaRef }))).outcome).toEqual({
        ok: false,
        failure: 'PROVIDER_REFUSED',
        status: 409,
      });
    }
  });

  it('an UNSIGNED 200 with perfect files is never success', async () => {
    expect((await fetchWith(200, filesAnswer([file()]), { signed: false })).outcome).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 200,
    });
  });

  it('a signed 404 ACCOUNT_NOT_FOUND is found:false; a signed 501 is unsupported', async () => {
    expect((await fetchWith(404, { error: { code: 'ACCOUNT_NOT_FOUND' } })).outcome).toEqual({
      ok: true,
      found: false,
    });
    expect((await fetchWith(501, { error: { code: 'UNSUPPORTED_OPERATION' } })).outcome).toEqual({
      ok: false,
      failure: 'UNSUPPORTED_CAPABILITY',
      status: 501,
    });
    expect((await fetchWith(429, { error: { code: 'RATE_LIMITED' } })).outcome).toEqual({
      ok: false,
      failure: 'RATE_LIMITED',
      status: 429,
    });
  });

  it('cleans every name: paths, control characters, direction overrides, quotes', async () => {
    const { outcome } = await fetchWith(
      200,
      filesAnswer([
        file({ name: '../../etc/passwd' }),
        file({ name: 'C:\\Users\\x\\conf.json' }),
        file({ name: 'invoice\u202Enosj.exe' }),
        file({ name: '\u2066a\u2069b\u200E\u200F.json' }),
        file({ name: 'a\u0000b\u001fc\u007f.json' }),
        file({ name: '"<x>|*?:`\'.json' }),
        file({ name: '..' }),
        file({ name: 42 }),
      ]),
    );
    if (!outcome.ok || !outcome.found) throw new Error('expected files');
    expect(outcome.files.map((one) => one.fileName)).toEqual([
      'passwd',
      'conf.json',
      'invoicenosj.exe',
      'ab.json',
      'abc.json',
      'x.json',
      'subscription-7',
      'subscription-8',
    ]);
  });

  it('safeFileName itself strips every direction mark (shared with RickPanel)', () => {
    for (const mark of ['\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E']) {
      expect(safeFileName(`a${mark}b.txt`, 0)).toBe('ab.txt');
    }
    for (const mark of ['\u2066', '\u2067', '\u2068', '\u2069']) {
      expect(safeFileName(`a${mark}b.txt`, 0)).toBe('ab.txt');
    }
  });
});

describe('health announces `files` (§5.1)', () => {
  it('reads the capabilities leniently: known values only, anything malformed is none', () => {
    expect(parseAnnouncedCapabilities(['files'])).toEqual(['SUBSCRIPTION_FILES']);
    expect(parseAnnouncedCapabilities(['files', 'files', 'teleport'])).toEqual([
      'SUBSCRIPTION_FILES',
    ]);
    expect(parseAnnouncedCapabilities(undefined)).toEqual([]);
    expect(parseAnnouncedCapabilities([])).toEqual([]);
    expect(parseAnnouncedCapabilities('files')).toEqual([]);
    expect(parseAnnouncedCapabilities(['files', 1])).toEqual([]);
    expect(parseAnnouncedCapabilities({ files: true })).toEqual([]);
  });

  it('a failed probe announces nothing; a successful one stores what it announced', () => {
    const context = { checkedAt: new Date(0), latencyMs: 1, previousLastHealthyAt: null };
    expect(
      toHealthRecord(
        {
          ok: true,
          providerVersion: null,
          degraded: false,
          announcedCapabilities: ['SUBSCRIPTION_FILES'],
        },
        context,
      ).announcedCapabilities,
    ).toEqual(['SUBSCRIPTION_FILES']);
    expect(
      toHealthRecord({ ok: true, providerVersion: null, degraded: false }, context)
        .announcedCapabilities,
    ).toEqual([]);
    expect(
      toHealthRecord({ ok: false, failure: 'TIMEOUT', status: null }, context)
        .announcedCapabilities,
    ).toEqual([]);
  });

  it('a custom panel delivers files only while announced; RickPanel always; Marzban never', () => {
    expect(panelDeliversConnectionFiles('custom', ['SUBSCRIPTION_FILES'])).toBe(true);
    expect(panelDeliversConnectionFiles('custom', [])).toBe(false);
    expect(panelDeliversConnectionFiles('custom', null)).toBe(false);
    expect(panelDeliversConnectionFiles('rickpanel', null)).toBe(true);
    expect(panelDeliversConnectionFiles('marzban', ['SUBSCRIPTION_FILES'])).toBe(false);
  });
});

describe('a bridge with and without the capability (fake bridge over HTTPS)', () => {
  const tls = bridgeTls();
  let bridge: FakeCustomBridge | null = null;
  afterEach(async () => {
    await bridge?.close();
    bridge = null;
  });
  const http = (base: string) =>
    new SafeHttpClient({
      allowLoopback: true,
      totalTimeoutMs: 3_000,
      maxResponseBytes: 256 * 1024,
      maxRetries: 0,
      caCertificates: [tls.ca],
    }).forBase(base);
  const at = (base: string): ProviderServiceTarget => ({ ...target, baseUrl: base });

  it('WITH `files`: health announces it and the account’s own file comes back', async () => {
    bridge = await startFakeCustomBridge({ tls, files: true });
    bridge.seed({ username: REF.username, nexaRef: REF.clientId });
    const probe = await adapter.probe(at(bridge.baseUrl), http(bridge.baseUrl));
    expect(probe).toMatchObject({ ok: true, announcedCapabilities: ['SUBSCRIPTION_FILES'] });
    const fetched = await adapter.fetchSubscriptionFiles(
      at(bridge.baseUrl),
      http(bridge.baseUrl),
      REF,
    );
    if (!fetched.ok || !fetched.found) throw new Error('expected files');
    expect(fetched.files.map((one) => one.fileName)).toEqual([`${REF.username}.json`]);
    expect(
      Buffer.from(fetched.files[0]!.bytes).equals(bridge.defaultFile(REF.username).bytes),
    ).toBe(true);
    expect(bridge.count('files')).toBe(1);
  });

  it('WITHOUT it (a v1.0 bridge): health is the v1.0 answer, nothing announced, still healthy', async () => {
    bridge = await startFakeCustomBridge({ tls });
    const probe = await adapter.probe(at(bridge.baseUrl), http(bridge.baseUrl));
    expect(probe).toEqual({
      ok: true,
      providerVersion: '1.4.2',
      degraded: false,
      announcedCapabilities: [],
    });
    // Asked anyway (the service never does), its unknown route is a signed refusal —
    // never files, and never success.
    const fetched = await adapter.fetchSubscriptionFiles(
      at(bridge.baseUrl),
      http(bridge.baseUrl),
      REF,
    );
    expect(fetched.ok).toBe(false);
  });

  it('another account’s files are never served for this service’s name', async () => {
    bridge = await startFakeCustomBridge({ tls, files: true });
    // The name is held by an account bound to someone else.
    bridge.seed({ username: REF.username, nexaRef: '00000000-0000-4000-8000-000000000000' });
    expect(
      await adapter.fetchSubscriptionFiles(at(bridge.baseUrl), http(bridge.baseUrl), REF),
    ).toEqual({ ok: false, failure: 'PROVIDER_REFUSED', status: 409 });
  });
});
