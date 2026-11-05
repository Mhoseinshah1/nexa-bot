import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Readable } from 'node:stream';
import type {
  BackupArchivePart,
  OffsiteBackupUploader,
  OffsiteUploadOutcome,
} from '../application/ports.js';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import { canonicalUriOf, signRequest } from './s3-sigv4.js';

/**
 * The off-site copy of a verified backup archive: S3 PutObject and nothing else (Phase 6A D0).
 *
 * WRITE-ONLY. This class can build exactly one kind of request — a PUT of a new object — so
 * the credentials it holds need `s3:PutObject` (and `s3:PutObjectRetention` for the lock
 * headers) and nothing more; the bucket policy in `docs/backup.md` denies every delete. A
 * server taken over by somebody else can add objects, never remove or shorten the history.
 *
 * OBJECT LOCK. With `retentionDays > 0` every object is sent with
 * `x-amz-object-lock-mode: COMPLIANCE` and a retain-until instant `retentionDays` after the
 * upload: in COMPLIANCE mode not even the bucket's root account can delete the version or
 * shorten its retention before then. A bucket without object lock enabled refuses the
 * headers, which `botctl backup offsite test` reports before the first real backup relies
 * on it. `Content-MD5` is always sent, because S3 requires it on a locked PUT.
 *
 * INTEGRITY. Each part is re-read and its SHA-256 compared with the digest the pipeline
 * recorded for it after verification, then sent with that digest as `x-amz-content-sha256`:
 * the store refuses the PUT if the bytes it received differ. What lands off-site is
 * byte-for-byte what VERIFY_RESTORE proved, or nothing.
 *
 * WHAT IT NEVER DOES. It never deletes, lists or reads an object, and never touches the
 * local archive: every failure is an outcome for the caller to report, and the archive
 * stays on disk under the local retention policy exactly as before.
 *
 * Its error details carry a status code and the provider's `<Code>` only — never the URL,
 * the key, a header or a signature.
 */

export interface S3OffsiteOptions {
  /** `https://s3.eu-central-1.amazonaws.com`, `http://127.0.0.1:9000`. Empty: off. */
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Prepended to every key; normalised to end in `/` when not empty. */
  readonly prefix: string;
  /** 0: no object-lock headers (the bucket's default retention, if any, still applies). */
  readonly retentionDays: number;
  /** Path-style (`host/bucket/key`, the default: MinIO, R2, B2) or virtual-hosted. */
  readonly pathStyle: boolean;
  readonly timeoutMs: number;
}

const DAY_MS = 86_400_000;
const ERROR_BODY_CAP = 8 * 1024;

interface PutResult {
  readonly ok: boolean;
  readonly detail: string;
}

export class S3OffsiteUploader implements OffsiteBackupUploader {
  constructor(private readonly options: S3OffsiteOptions) {}

  get configured(): boolean {
    const o = this.options;
    return (
      o.endpoint !== '' &&
      o.bucket !== '' &&
      o.region !== '' &&
      o.accessKeyId !== '' &&
      o.secretAccessKey !== ''
    );
  }

  async upload(input: {
    readonly backupId: string;
    readonly archivePath: string;
    readonly parts: readonly BackupArchivePart[];
    readonly index: Readonly<Record<string, unknown>>;
    readonly now: Date;
  }): Promise<OffsiteUploadOutcome> {
    // The longest external call after the Telegram upload; never inside a transaction.
    assertOutsideTransaction('An off-site backup upload');
    if (!this.configured) return { kind: 'NOT_CONFIGURED' };
    const lockedUntil = this.retainUntil(input.now, this.options.retentionDays);
    const expected = input.parts.length + 1;
    let uploaded = 0;
    let bytes = 0;
    for (const part of input.parts) {
      const digest = await rangeDigests(input.archivePath, part.start, part.end);
      if (digest.sha256 !== part.sha256) {
        return {
          kind: 'FAILED',
          uploaded,
          expected,
          detail: `part ${String(part.partNumber)} no longer matches its verified digest; not sent`,
        };
      }
      const result = await this.put({
        key: `${input.backupId}/${part.filename}`,
        bytes: part.bytes,
        sha256: digest.sha256,
        md5: digest.md5,
        contentType: 'application/octet-stream',
        body: () => createReadStream(input.archivePath, { start: part.start, end: part.end - 1 }),
        now: input.now,
        lockedUntil,
      });
      if (!result.ok) {
        return {
          kind: 'FAILED',
          uploaded,
          expected,
          detail: `part ${String(part.partNumber)}: ${result.detail}`,
        };
      }
      uploaded += 1;
      bytes += part.bytes;
    }
    // The index goes LAST: its presence says every part before it landed.
    const index = Buffer.from(`${JSON.stringify(input.index, null, 2)}\n`, 'utf8');
    const indexResult = await this.putBuffer(
      `${input.backupId}/index.json`,
      index,
      'application/json',
      input.now,
      lockedUntil,
    );
    if (!indexResult.ok) {
      return { kind: 'FAILED', uploaded, expected, detail: `index.json: ${indexResult.detail}` };
    }
    return { kind: 'UPLOADED', objects: expected, bytes: bytes + index.byteLength, lockedUntil };
  }

  async testUpload(now: Date): Promise<OffsiteUploadOutcome> {
    assertOutsideTransaction('An off-site backup test upload');
    if (!this.configured) return { kind: 'NOT_CONFIGURED' };
    // A one-day lock when a lock is configured: the test proves the bucket accepts the
    // headers every real archive will carry, and costs one small object for one day.
    const lockedUntil = this.retainUntil(now, this.options.retentionDays > 0 ? 1 : 0);
    const stamp = now.toISOString().replace(/[-:.]/g, '');
    const body = Buffer.from(`nexa off-site backup test ${now.toISOString()}\n`, 'utf8');
    const result = await this.putBuffer(
      `offsite-test/${stamp}-${randomBytes(4).toString('hex')}.txt`,
      body,
      'text/plain; charset=utf-8',
      now,
      lockedUntil,
    );
    return result.ok
      ? { kind: 'UPLOADED', objects: 1, bytes: body.byteLength, lockedUntil }
      : { kind: 'FAILED', uploaded: 0, expected: 1, detail: result.detail };
  }

  private retainUntil(now: Date, days: number): Date | null {
    return days > 0 ? new Date(now.getTime() + days * DAY_MS) : null;
  }

  private putBuffer(
    key: string,
    body: Buffer,
    contentType: string,
    now: Date,
    lockedUntil: Date | null,
  ): Promise<PutResult> {
    return this.put({
      key,
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      md5: createHash('md5').update(body).digest('base64'),
      contentType,
      body: () => body,
      now,
      lockedUntil,
    });
  }

  private async put(object: {
    readonly key: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly md5: string;
    readonly contentType: string;
    readonly body: () => Readable | Buffer;
    readonly now: Date;
    readonly lockedUntil: Date | null;
  }): Promise<PutResult> {
    const request = buildPutObjectRequest(this.options, object);
    return send(request, object.body, this.options.timeoutMs);
  }
}

export interface BuiltRequest {
  readonly url: URL;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The one request this client can make. Exported for the tests that pin its headers: the
 * method is a literal `PUT`, and the lock headers are present exactly when a lock is asked.
 */
export function buildPutObjectRequest(
  options: S3OffsiteOptions,
  object: {
    readonly key: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly md5: string;
    readonly contentType: string;
    readonly now: Date;
    readonly lockedUntil: Date | null;
  },
): BuiltRequest {
  const endpoint = new URL(options.endpoint);
  const key = `${normalisedPrefix(options.prefix)}${object.key}`;
  const host = options.pathStyle ? endpoint.host : `${options.bucket}.${endpoint.host}`;
  const path = options.pathStyle ? canonicalUriOf([options.bucket, key]) : canonicalUriOf([key]);
  const headers: Record<string, string> = {
    'content-length': String(object.bytes),
    'content-md5': object.md5,
    'content-type': object.contentType,
  };
  if (object.lockedUntil !== null) {
    headers['x-amz-object-lock-mode'] = 'COMPLIANCE';
    headers['x-amz-object-lock-retain-until-date'] = object.lockedUntil.toISOString();
  }
  const signed = signRequest(
    {
      method: 'PUT',
      host,
      path,
      headers,
      payloadSha256: object.sha256,
      region: options.region,
      service: 's3',
      now: object.now,
    },
    { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  );
  return {
    url: new URL(`${endpoint.protocol}//${host}${path}`),
    method: 'PUT',
    headers: signed.headers,
  };
}

/** `''` stays empty; anything else loses leading slashes and ends in exactly one `/`. */
export function normalisedPrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}

async function rangeDigests(
  path: string,
  start: number,
  end: number,
): Promise<{ sha256: string; md5: string }> {
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  if (end > start) {
    for await (const chunk of createReadStream(path, { start, end: end - 1 })) {
      sha256.update(chunk as Buffer);
      md5.update(chunk as Buffer);
    }
  }
  return { sha256: sha256.digest('hex'), md5: md5.digest('base64') };
}

function send(
  built: BuiltRequest,
  body: () => Readable | Buffer,
  timeoutMs: number,
): Promise<PutResult> {
  const requester = built.url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<PutResult>((resolve) => {
    let settled = false;
    const finish = (result: PutResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = requester(built.url, { method: built.method, headers: built.headers });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timed out after ${String(timeoutMs)} ms`));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, detail: `network: ${error.code ?? error.message}` });
    });
    req.on('response', (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on('data', (chunk: Buffer) => {
        if (length < ERROR_BODY_CAP) chunks.push(chunk);
        length += chunk.byteLength;
      });
      response.on('error', (error: NodeJS.ErrnoException) => {
        finish({ ok: false, detail: `network: ${error.code ?? error.message}` });
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) {
          finish({ ok: true, detail: `HTTP ${String(status)}` });
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8').slice(0, ERROR_BODY_CAP);
        const code = /<Code>([A-Za-z0-9._-]{1,64})<\/Code>/.exec(text)?.[1];
        finish({
          ok: false,
          detail: `HTTP ${String(status)}${code === undefined ? '' : ` ${code}`}`,
        });
      });
    });
    const payload = body();
    if (Buffer.isBuffer(payload)) {
      req.end(payload);
    } else {
      payload.on('error', (error: NodeJS.ErrnoException) => {
        req.destroy();
        finish({ ok: false, detail: `reading the archive: ${error.code ?? error.message}` });
      });
      payload.pipe(req);
    }
  });
}
