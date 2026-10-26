import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResult,
  ProviderServiceTarget,
  ServiceId,
} from '@nexa/contracts';
import { CustomPanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/custom-panel.adapter';
import {
  ACCOUNT_STATUSES,
  CUSTOM_ENDPOINTS,
  CUSTOM_ERROR_CODES,
  EMPTY_BODY_SHA256,
  canonicalRequest,
  canonicalResponse,
  responseSignatureValid,
  sha256Hex,
  sign,
} from '../../apps/api/src/modules/platform/providers/infrastructure/custom-panel-protocol';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';

/**
 * `docs/protocols/custom-panel.md` IS the specification of the `custom` provider, and
 * this suite reads it (R10 C2).
 *
 * The adapter's contract tests run against a mock bridge written in this repository, so
 * on their own they prove only that two pieces of Nexa's code agree with each other —
 * the circularity `provider-wire-routes.test.ts` names for the real panels. This file
 * breaks it the one way available without a real bridge: the DOCUMENT a third party
 * builds from is parsed, and its endpoint table, its status table, its error-code table
 * and its three signature vectors are compared with the constants the adapter uses —
 * and the vectors are reproduced by the ADAPTER itself, with its clock and nonce pinned.
 * Editing the protocol without the document, or the document without the protocol, fails
 * here.
 */

const DOC = readFileSync(join(__dirname, '../../docs/protocols/custom-panel.md'), 'utf8');

/** The text of one `## n.` or `### n.n` section, up to the next heading of any level. */
function section(heading: string): string {
  const start = DOC.indexOf(heading);
  if (start < 0) throw new Error(`the protocol document has no section "${heading}"`);
  const rest = DOC.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The table rows of a section, as trimmed cells (header and separator excluded). */
function rows(text: string): string[][] {
  return text
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|(?=(?:[^`]*`[^`]*`)*[^`]*$)/)
        .map((cell) => cell.trim()),
    );
}

const backticked = (cell: string): string | null => /`([^`]+)`/.exec(cell)?.[1] ?? null;

describe('the protocol document and the adapter agree', () => {
  it('§1 — every operation, its method and its path', () => {
    const table = rows(section('## 1. Overview')).map((cells) => ({
      method: cells[2],
      path: `/${backticked(cells[3] ?? '') ?? ''}`,
    }));
    expect(table).toHaveLength(9);
    expect(table).toEqual(CUSTOM_ENDPOINTS.map((one) => ({ method: one.method, path: one.path })));
  });

  it('§4.2 — the account statuses', () => {
    const statuses = rows(section('### 4.2 `AccountStatus`')).map((cells) =>
      backticked(cells[0] ?? ''),
    );
    expect(statuses).toEqual([...ACCOUNT_STATUSES]);
  });

  it('§7.2 — every error code, its one status and Nexa’s reading', () => {
    const table = Object.fromEntries(
      rows(section('### 7.2 Codes')).map((cells) => [
        backticked(cells[0] ?? ''),
        { status: Number(cells[1]), reading: backticked(cells[3] ?? '') },
      ]),
    );
    expect(table).toEqual(CUSTOM_ERROR_CODES);
  });
});

/** §3.5, read out of the document rather than copied into this file. */
const vectors = (() => {
  const text = section('### 3.5 Test vectors');
  const grab = (pattern: RegExp): string => {
    const match = pattern.exec(text);
    if (match?.[1] === undefined) throw new Error(`§3.5 lost ${String(pattern)}`);
    return match[1];
  };
  const a = text.slice(text.indexOf('**Vector A'), text.indexOf('**Vector B'));
  const b = text.slice(text.indexOf('**Vector B'), text.indexOf('**Vector C'));
  const c = text.slice(text.indexOf('**Vector C'));
  const inA = (pattern: RegExp) => pattern.exec(a)?.[1] ?? '';
  const inB = (pattern: RegExp) => pattern.exec(b)?.[1] ?? '';
  const inC = (pattern: RegExp) => pattern.exec(c)?.[1] ?? '';
  return {
    secret: grab(/Secret: `([^`]+)`/),
    a: {
      timestamp: inA(/timestamp `(\d+)`/),
      nonce: inA(/nonce\s+`([0-9a-f]{32})`/),
      body: inA(/```\n(.+)\n```/),
      bodySha: inA(/body SHA-256: `([0-9a-f]{64})`/),
      canonical: inA(/canonical string:\s+`([^`]+)`/).replace(/\\n/g, '\n'),
      signature: inA(/X-Nexa-Signature: (v1=[0-9a-f]{64})/),
    },
    b: {
      path: inB(/`GET ([^`]+)`/),
      timestamp: inB(/timestamp `(\d+)`/),
      nonce: inB(/nonce\s+`([0-9a-f]{32})`/),
      signature: inB(/X-Nexa-Signature: (v1=[0-9a-f]{64})/),
    },
    c: {
      status: Number(inC(/Status `(\d{3})`/)),
      body: inC(/body\s+`(\{[^`]+\})`/),
      bodySha: inC(/SHA-256\s+`([0-9a-f]{64})`/),
      signature: inC(/X-Nexa-Bridge-Signature: (v1=[0-9a-f]{64})/),
    },
  };
})();

describe('§3.5 — the signature vectors', () => {
  it('reads all three vectors out of the document', () => {
    expect(vectors.secret.length).toBeGreaterThanOrEqual(32);
    expect(vectors.a.body.startsWith('{"operationId"')).toBe(true);
    expect(vectors.b.path).toBe('/v1/accounts/nx7k2m9p4qwe');
    expect(vectors.c.status).toBe(404);
  });

  it('A — the body hash, the six-line canonical string and the signature', () => {
    expect(sha256Hex(vectors.a.body)).toBe(vectors.a.bodySha);
    const canonical = canonicalRequest({
      method: 'POST',
      protocolPath: '/v1/accounts',
      timestamp: vectors.a.timestamp,
      nonce: vectors.a.nonce,
      bodySha256: vectors.a.bodySha,
    });
    expect(canonical).toBe(vectors.a.canonical);
    expect(canonical.endsWith('\n')).toBe(false);
    expect(sign(vectors.secret, canonical)).toBe(vectors.a.signature);
  });

  it('B — a GET signs the hash of the empty body', () => {
    expect(sha256Hex('')).toBe(EMPTY_BODY_SHA256);
    expect(
      sign(
        vectors.secret,
        canonicalRequest({
          method: 'GET',
          protocolPath: vectors.b.path,
          timestamp: vectors.b.timestamp,
          nonce: vectors.b.nonce,
          bodySha256: EMPTY_BODY_SHA256,
        }),
      ),
    ).toBe(vectors.b.signature);
  });

  it('C — the signed 404 answering B verifies, and only for B’s nonce', () => {
    expect(sha256Hex(vectors.c.body)).toBe(vectors.c.bodySha);
    expect(
      sign(
        vectors.secret,
        canonicalResponse({ status: 404, nonce: vectors.b.nonce, bodySha256: vectors.c.bodySha }),
      ),
    ).toBe(vectors.c.signature);
    const answer = { status: 404, nonce: vectors.b.nonce, bodyText: vectors.c.body };
    expect(responseSignatureValid(vectors.secret, answer, vectors.c.signature)).toBe(true);
    // Another request's nonce, another status, another body, another secret: all refused.
    expect(
      responseSignatureValid(
        vectors.secret,
        { ...answer, nonce: vectors.a.nonce },
        vectors.c.signature,
      ),
    ).toBe(false);
    expect(
      responseSignatureValid(vectors.secret, { ...answer, status: 200 }, vectors.c.signature),
    ).toBe(false);
    expect(
      responseSignatureValid(vectors.secret, { ...answer, bodyText: '{}' }, vectors.c.signature),
    ).toBe(false);
    expect(responseSignatureValid('another-secret', answer, vectors.c.signature)).toBe(false);
    expect(responseSignatureValid(vectors.secret, answer, undefined)).toBe(false);
    expect(responseSignatureValid(vectors.secret, answer, 'v1=zz')).toBe(false);
  });
});

describe('the ADAPTER reproduces the vectors (clock and nonce pinned)', () => {
  /** A client that records what it was asked to send and answers from a script. */
  const recording = (answer: (request: ProviderHttpRequest) => ProviderHttpResult) => {
    const sent: ProviderHttpRequest[] = [];
    const client: ProviderHttpClient = {
      send: (request) => {
        sent.push(request);
        return Promise.resolve(answer(request));
      },
    };
    return { sent, client };
  };
  const target: ProviderServiceTarget = {
    baseUrl: 'https://bridge.example.com/nexa/',
    credentials: { shape: 'OPAQUE_TOKEN', token: vectors.secret },
    activation: {},
  };
  const pinned = (nonce: string) =>
    new CustomPanelAdapter({
      clock: new FixedClock(new Date(Number(vectors.a.timestamp) * 1000)),
      nonce: () => nonce,
    });

  it('A — the create it sends is vector A, byte for byte, with vector A’s signature', async () => {
    const body = JSON.parse(vectors.a.body) as Record<string, unknown>;
    const { sent, client } = recording(() => ({
      ok: true,
      status: 500,
      headers: {},
      bodyText: '',
      setCookie: [],
    }));
    await pinned(vectors.a.nonce).createUser(target, client, {
      username: body['username'] as string,
      subscriptionRef: 'unused',
      clientId: body['nexaRef'] as string,
      serviceId: '11111111-2222-4333-8444-555555555555' as ServiceId,
      volumeBytes: BigInt(body['trafficLimitBytes'] as string),
      durationDays: 30,
      expiresAt: new Date(body['expiresAt'] as string),
      deviceLimit: body['deviceLimit'] as number,
      operationId: body['operationId'] as string,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.path).toBe('v1/accounts');
    expect(sent[0]?.body).toEqual({ kind: 'json-text', text: vectors.a.body });
    expect(sent[0]?.headers).toEqual({
      'x-nexa-protocol': '1',
      'x-nexa-timestamp': vectors.a.timestamp,
      'x-nexa-nonce': vectors.a.nonce,
      'x-nexa-signature': vectors.a.signature,
    });
  });

  it('B + C — its lookup signs vector B, and reads vector C as ABSENT only while signed', async () => {
    const ref = {
      username: 'nx7k2m9p4qwe',
      subscriptionRef: 'unused',
      clientId: '5f0c9a7e-2b1d-4e6f-8a3c-9d2e1f0a7b6c',
    };
    const answerC = (signature: string | null) =>
      recording(() => ({
        ok: true,
        status: vectors.c.status,
        headers: signature === null ? {} : { 'x-nexa-bridge-signature': signature },
        bodyText: vectors.c.body,
        setCookie: [],
      }));

    const signed = answerC(vectors.c.signature);
    expect(await pinned(vectors.b.nonce).lookupUser(target, signed.client, ref)).toEqual({
      ok: true,
      found: false,
    });
    expect(signed.sent[0]?.headers?.['x-nexa-signature']).toBe(vectors.b.signature);
    expect(signed.sent[0]?.body).toBeUndefined();

    // The very same bytes without the signature are NOT absence.
    const unsigned = answerC(null);
    expect(await pinned(vectors.b.nonce).lookupUser(target, unsigned.client, ref)).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
    // Nor is vector C replayed as the answer to a request with another nonce.
    const replayed = answerC(vectors.c.signature);
    expect(await pinned(vectors.a.nonce).lookupUser(target, replayed.client, ref)).toEqual({
      ok: false,
      failure: 'MALFORMED_RESPONSE',
      status: 404,
    });
  });
});
