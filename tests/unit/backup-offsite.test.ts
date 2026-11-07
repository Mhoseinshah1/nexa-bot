import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalUriOf,
  EMPTY_PAYLOAD_SHA256,
  signRequest,
  sigv4Encode,
} from '../../apps/api/src/modules/platform/backup/infrastructure/s3-sigv4';
import {
  buildPutObjectRequest,
  normalisedPrefix,
  S3OffsiteUploader,
  type S3OffsiteOptions,
} from '../../apps/api/src/modules/platform/backup/infrastructure/s3-offsite-uploader';
import type { BackupArchivePart } from '../../apps/api/src/modules/platform/backup/application/ports';
import { offsiteTestReport, parseArgs, UsageError } from '../../apps/api/src/backup.cli';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * Phase 6A D0: the write-only off-site copy. The signer is pinned to AWS's own published
 * Signature Version 4 examples; the uploader is driven against a local fake S3 that checks
 * every request the way a real store would (method, payload digest, Content-MD5, lock headers).
 */

const AWS_DOC_KEYS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const S3_EXAMPLE_DATE = new Date('2013-05-24T00:00:00Z');

describe('SigV4 against the AWS test vectors', () => {
  it('get-vanilla (the SigV4 test suite)', () => {
    const signed = signRequest(
      {
        method: 'GET',
        host: 'example.amazonaws.com',
        path: '/',
        headers: {},
        payloadSha256: EMPTY_PAYLOAD_SHA256,
        region: 'us-east-1',
        service: 'service',
        now: new Date('2015-08-30T12:36:00Z'),
        contentSha256Header: false,
      },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
    );
    expect(signed.canonicalRequest).toBe(
      'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n' +
        EMPTY_PAYLOAD_SHA256,
    );
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('S3 PUT Object (the S3 documentation example, an encoded `$` in the key)', () => {
    const signed = signRequest(
      {
        method: 'PUT',
        host: 'examplebucket.s3.amazonaws.com',
        path: canonicalUriOf(['test$file.text']),
        headers: {
          date: 'Fri, 24 May 2013 00:00:00 GMT',
          'x-amz-storage-class': 'REDUCED_REDUNDANCY',
        },
        payloadSha256: createHash('sha256').update('Welcome to Amazon S3.').digest('hex'),
        region: 'us-east-1',
        service: 's3',
        now: S3_EXAMPLE_DATE,
      },
      AWS_DOC_KEYS,
    );
    expect(signed.canonicalRequest.split('\n')[1]).toBe('/test%24file.text');
    expect(signed.signature).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
    expect(signed.headers.authorization).toContain(
      'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
    );
  });

  it('S3 GET Object with a Range header, and the query-string ordering of the list example', () => {
    const get = signRequest(
      {
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/test.txt',
        headers: { range: 'bytes=0-9' },
        payloadSha256: EMPTY_PAYLOAD_SHA256,
        region: 'us-east-1',
        service: 's3',
        now: S3_EXAMPLE_DATE,
      },
      AWS_DOC_KEYS,
    );
    expect(get.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    // The signer's canonical query, pinned by the vector; the uploader never sends a query.
    const list = signRequest(
      {
        method: 'GET',
        host: 'examplebucket.s3.amazonaws.com',
        path: '/',
        query: { prefix: 'J', 'max-keys': '2' },
        headers: {},
        payloadSha256: EMPTY_PAYLOAD_SHA256,
        region: 'us-east-1',
        service: 's3',
        now: S3_EXAMPLE_DATE,
      },
      AWS_DOC_KEYS,
    );
    expect(list.signature).toBe('34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });

  it('encodes as RFC 3986 asks, keeping the slashes of a key', () => {
    expect(sigv4Encode("a b!'()*~._-")).toBe('a%20b%21%27%28%29%2A~._-');
    expect(canonicalUriOf(['bucket', 'nexa/2026/a b.7z.001'])).toBe(
      '/bucket/nexa/2026/a%20b.7z.001',
    );
  });
});

const OPTIONS: S3OffsiteOptions = {
  endpoint: 'https://s3.eu-central-1.amazonaws.com',
  region: 'eu-central-1',
  bucket: 'nexa-backups',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
  prefix: 'nexa/',
  retentionDays: 30,
  pathStyle: true,
  timeoutMs: 10_000,
  clock: { now: () => new Date('2026-11-04T10:00:00.000Z') },
};
const OBJECT = {
  key: 'b1/archive.7z',
  bytes: 3,
  sha256: createHash('sha256').update('abc').digest('hex'),
  md5: createHash('md5').update('abc').digest('base64'),
  contentType: 'application/octet-stream',
  now: new Date('2026-11-04T10:00:00.000Z'),
};

describe('the one request the uploader can build', () => {
  it('is a PUT under COMPLIANCE lock with the retain-until signed, when a retention is set', () => {
    const lockedUntil = new Date('2026-12-04T10:00:00.000Z');
    const built = buildPutObjectRequest(OPTIONS, { ...OBJECT, lockedUntil });
    expect(built.method).toBe('PUT');
    expect(built.url.href).toBe(
      'https://s3.eu-central-1.amazonaws.com/nexa-backups/nexa/b1/archive.7z',
    );
    expect(built.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
    expect(built.headers['x-amz-object-lock-retain-until-date']).toBe('2026-12-04T10:00:00.000Z');
    expect(built.headers['content-md5']).toBe(OBJECT.md5);
    expect(built.headers['x-amz-content-sha256']).toBe(OBJECT.sha256);
    // Signed, so nothing between here and the store can drop the lock and keep the signature.
    expect(built.headers.authorization).toContain(
      'SignedHeaders=content-length;content-md5;content-type;host;x-amz-content-sha256;' +
        'x-amz-date;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date',
    );
  });

  it('sends no lock headers without a retention, and virtual-hosted when asked', () => {
    const built = buildPutObjectRequest(
      { ...OPTIONS, pathStyle: false },
      { ...OBJECT, lockedUntil: null },
    );
    expect(built.url.href).toBe(
      'https://nexa-backups.s3.eu-central-1.amazonaws.com/nexa/b1/archive.7z',
    );
    expect(built.headers['x-amz-object-lock-mode']).toBeUndefined();
    expect(built.headers['x-amz-object-lock-retain-until-date']).toBeUndefined();
  });

  it('normalises the prefix', () => {
    expect(normalisedPrefix('')).toBe('');
    expect(normalisedPrefix('/nexa')).toBe('nexa/');
    expect(normalisedPrefix('a/b//')).toBe('a/b/');
  });
});

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Buffer;
}

/** A fake S3 that answers like a real one: 400 on a bad digest, a scripted error per key. */
class FakeS3 {
  readonly received: Received[] = [];
  readonly objects = new Map<string, Buffer>();
  /** key suffix → [status, code] to answer instead of storing. */
  readonly refuse = new Map<string, [number, string]>();
  private server: Server | null = null;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = req.url ?? '';
        this.received.push({ method: req.method ?? '', url, headers: req.headers, body });
        const error = (status: number, code: string): void => {
          res.writeHead(status, { 'content-type': 'application/xml' });
          res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>no</Message></Error>`);
        };
        if (req.method !== 'PUT') return error(405, 'MethodNotAllowed');
        if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=')) {
          return error(403, 'AccessDenied');
        }
        if (
          createHash('sha256').update(body).digest('hex') !== req.headers['x-amz-content-sha256']
        ) {
          return error(400, 'XAmzContentSHA256Mismatch');
        }
        if (createHash('md5').update(body).digest('base64') !== req.headers['content-md5']) {
          return error(400, 'BadDigest');
        }
        for (const [suffix, [status, code]] of this.refuse) {
          if (url.endsWith(suffix)) return error(status, code);
        }
        this.objects.set(decodeURIComponent(url), body);
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

describe('uploading to a local fake S3', () => {
  let s3: FakeS3;
  let dir: string;
  let archivePath: string;
  let parts: BackupArchivePart[];
  const content = Buffer.from('0123456789abcdefghij', 'utf8');
  const now = new Date('2026-11-04T10:00:00.000Z');

  const digest = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
  const uploader = (overrides: Partial<S3OffsiteOptions> = {}): S3OffsiteUploader =>
    new S3OffsiteUploader({
      ...OPTIONS,
      endpoint: `http://127.0.0.1:${String(s3.port)}`,
      ...overrides,
    });

  beforeEach(async () => {
    s3 = new FakeS3();
    await s3.start();
    dir = await mkdtemp(join(tmpdir(), 'nexa-offsite-'));
    archivePath = join(dir, 'archive.7z');
    await writeFile(archivePath, content);
    parts = [
      {
        partNumber: 1,
        start: 0,
        end: 12,
        bytes: 12,
        sha256: digest(content.subarray(0, 12)),
        filename: 'a.7z.001',
      },
      {
        partNumber: 2,
        start: 12,
        end: 20,
        bytes: 8,
        sha256: digest(content.subarray(12, 20)),
        filename: 'a.7z.002',
      },
    ];
  });

  afterEach(async () => {
    await s3.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('PUTs every part byte for byte, then the index, each under COMPLIANCE lock — and nothing else', async () => {
    const outcome = await uploader().upload({
      backupId: 'b1',
      archivePath,
      parts,
      index: { backupId: 'b1' },
      now,
    });
    expect(outcome).toEqual({
      kind: 'UPLOADED',
      objects: 3,
      bytes: expect.any(Number),
      lockedUntil: new Date('2026-12-04T10:00:00.000Z'),
    });
    // Write-only: every request was a PUT. No list, no read, no delete, ever.
    expect(s3.received.map((r) => r.method)).toEqual(['PUT', 'PUT', 'PUT']);
    expect(s3.received.map((r) => r.url)).toEqual([
      '/nexa-backups/nexa/b1/a.7z.001',
      '/nexa-backups/nexa/b1/a.7z.002',
      '/nexa-backups/nexa/b1/index.json',
    ]);
    for (const request of s3.received) {
      expect(request.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
      expect(request.headers['x-amz-object-lock-retain-until-date']).toBe(
        '2026-12-04T10:00:00.000Z',
      );
    }
    expect(
      Buffer.concat([
        s3.objects.get('/nexa-backups/nexa/b1/a.7z.001')!,
        s3.objects.get('/nexa-backups/nexa/b1/a.7z.002')!,
      ]),
    ).toEqual(content);
  });

  it('signs EACH put at the time it is sent, so a long upload never outlives SigV4’s 15 minutes', async () => {
    // Twenty minutes pass per request: a signature from the upload's start would be 40
    // minutes stale by the index, past the skew S3 allows.
    let at = now.getTime();
    const clock = { now: () => new Date((at += 20 * 60_000)) };
    const outcome = await uploader({ clock }).upload({
      backupId: 'b1',
      archivePath,
      parts,
      index: {},
      now,
    });
    expect(outcome.kind).toBe('UPLOADED');
    expect(s3.received.map((r) => r.headers['x-amz-date'])).toEqual([
      '20261104T102000Z',
      '20261104T104000Z',
      '20261104T110000Z',
    ]);
  });

  it('reports a refusal by status and provider code, keeps what landed, and never touches the archive', async () => {
    s3.refuse.set('a.7z.002', [403, 'AccessDenied']);
    const before = await stat(archivePath);
    const outcome = await uploader().upload({ backupId: 'b1', archivePath, parts, index: {}, now });
    expect(outcome).toEqual({
      kind: 'FAILED',
      uploaded: 1,
      expected: 3,
      detail: 'part 2: HTTP 403 AccessDenied',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-example');
    expect(s3.received.map((r) => r.method)).toEqual(['PUT', 'PUT']);
    expect(await readFile(archivePath)).toEqual(content);
    expect((await stat(archivePath)).mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses to send a part whose bytes no longer match the verified digest', async () => {
    const tampered = parts.map((part) =>
      part.partNumber === 2 ? { ...part, sha256: 'f'.repeat(64) } : part,
    );
    const outcome = await uploader().upload({
      backupId: 'b1',
      archivePath,
      parts: tampered,
      index: {},
      now,
    });
    expect(outcome.kind).toBe('FAILED');
    expect(s3.received).toHaveLength(1);
  });

  it('is an outcome, not a throw, when the store cannot be reached', async () => {
    await s3.stop();
    const outcome = await uploader().upload({ backupId: 'b1', archivePath, parts, index: {}, now });
    expect(outcome.kind).toBe('FAILED');
    expect(outcome.kind === 'FAILED' && outcome.detail).toMatch(/^part 1: network: /);
    await s3.start();
  });

  it('sends no lock headers with a retention of 0', async () => {
    await uploader({ retentionDays: 0 }).upload({
      backupId: 'b1',
      archivePath,
      parts,
      index: {},
      now,
    });
    expect(s3.received).toHaveLength(3);
    for (const request of s3.received) {
      expect(request.headers['x-amz-object-lock-mode']).toBeUndefined();
    }
  });

  it('is off, and sends nothing, when it is not configured', async () => {
    const off = uploader({ endpoint: '', bucket: '', accessKeyId: '', secretAccessKey: '' });
    expect(off.configured).toBe(false);
    expect(await off.upload({ backupId: 'b1', archivePath, parts, index: {}, now })).toEqual({
      kind: 'NOT_CONFIGURED',
    });
    expect(await off.testUpload(now)).toEqual({ kind: 'NOT_CONFIGURED' });
    expect(s3.received).toEqual([]);
  });

  it('the test upload writes one small object under offsite-test/, locked for one day', async () => {
    const outcome = await uploader().testUpload(now);
    expect(outcome).toMatchObject({
      kind: 'UPLOADED',
      objects: 1,
      lockedUntil: new Date('2026-11-05T10:00:00.000Z'),
    });
    expect(s3.received).toHaveLength(1);
    expect(s3.received[0]!.method).toBe('PUT');
    expect(s3.received[0]!.url).toMatch(
      /^\/nexa-backups\/nexa\/offsite-test\/[0-9TZ]+-[0-9a-f]{8}\.txt$/,
    );
    expect(s3.received[0]!.headers['x-amz-object-lock-mode']).toBe('COMPLIANCE');
  });
});

describe('botctl backup offsite test: the Persian report', () => {
  const facts = { bucket: 'nexa-backups', retentionDays: 30 };

  it('says it is off, with exit 3, when nothing is configured', () => {
    const report = offsiteTestReport({ kind: 'NOT_CONFIGURED' }, facts);
    expect(report.exitCode).toBe(3);
    expect(report.text).toContain('خاموش است');
  });

  it('names the bucket and the lock on success, and reminds of the delete-denying policy', () => {
    const report = offsiteTestReport(
      { kind: 'UPLOADED', objects: 1, bytes: 40, lockedUntil: new Date('2026-11-05T10:00:00Z') },
      facts,
    );
    expect(report.exitCode).toBe(0);
    expect(report.text).toContain('موفق بود');
    expect(report.text).toContain('«nexa-backups»');
    expect(report.text).toContain('COMPLIANCE');
    expect(report.text).toContain('DeleteObject');
  });

  it('explains a refused key and a bucket without object lock', () => {
    const denied = offsiteTestReport(
      { kind: 'FAILED', uploaded: 0, expected: 1, detail: 'HTTP 403 AccessDenied' },
      facts,
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.text).toContain('ناموفق بود: HTTP 403 AccessDenied');
    expect(denied.text).toContain('PutObject');
    const unlocked = offsiteTestReport(
      { kind: 'FAILED', uploaded: 0, expected: 1, detail: 'HTTP 400 InvalidRequest' },
      facts,
    );
    expect(unlocked.text).toContain('Object Lock');
  });

  it('takes no arguments, so a credential never travels on a command line', () => {
    expect(parseArgs(['offsite-test']).command).toBe('offsite-test');
    expect(() => parseArgs(['offsite-test', '--secret', 'x'])).toThrow(UsageError);
  });
});

describe('the off-site configuration', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
    SECRETS_KEK_ID: 'dev-1',
    TRUSTED_PROXY_IPS: '127.0.0.1,::1',
  };
  const full = {
    BACKUP_OFFSITE_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
    BACKUP_OFFSITE_REGION: 'eu-central-1',
    BACKUP_OFFSITE_BUCKET: 'nexa-backups',
    BACKUP_OFFSITE_ACCESS_KEY_ID: 'AKID',
    BACKUP_OFFSITE_SECRET_ACCESS_KEY: 'secret',
  };

  it('is off by default', () => {
    const parsed = configSchema.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.BACKUP_OFFSITE_ENDPOINT).toBe('');
    expect(parsed.success && parsed.data.BACKUP_OFFSITE_RETENTION_DAYS).toBe(0);
  });

  it('takes all five values together, and refuses any partial set without echoing a value', () => {
    expect(configSchema.safeParse({ ...base, ...full }).success).toBe(true);
    for (const key of Object.keys(full)) {
      const parsed = configSchema.safeParse({ ...base, ...full, [key]: '' });
      expect(parsed.success, key).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).not.toContain('secret"');
    }
  });

  it('refuses an endpoint with a path, a query or credentials', () => {
    for (const endpoint of [
      'https://s3.example.com/bucket',
      'https://u:p@s3.example.com',
      'ftp://s3.example.com',
      'https://s3.example.com/?x=1',
    ]) {
      expect(
        configSchema.safeParse({ ...base, ...full, BACKUP_OFFSITE_ENDPOINT: endpoint }).success,
        endpoint,
      ).toBe(false);
    }
  });
});
