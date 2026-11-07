import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, header-signed, for the off-site backup copy (Phase 6A D0).
 *
 * Pure: no clock, no network, no environment. The caller passes the instant and the
 * payload's SHA-256, and gets back the headers to send. Kept to the one shape the off-site
 * uploader needs — a header-signed request with a known payload hash — rather than a general
 * SDK, because the whole client is two requests (PutObject, and the same for the test object)
 * and an AWS SDK would add hundreds of transitive packages to the image that holds every
 * secret this installation has. `tests/unit/s3-sigv4.test.ts` pins it to AWS's published
 * test vectors.
 *
 * Nothing here ever builds a List, Get or Delete request: the uploader is write-only by
 * construction, and the bucket policy in `docs/backup.md` makes it write-only on the server.
 */

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4Request {
  readonly method: string;
  /** The host header's value, exactly as it is sent (`bucket.s3.example.com`, `127.0.0.1:9000`). */
  readonly host: string;
  /** The path as it is SENT, already URI-encoded per segment (`canonicalUriOf`). */
  readonly path: string;
  /** Query parameters, unencoded. Sorted and encoded here. */
  readonly query?: Readonly<Record<string, string>>;
  /** Every header to sign except host, x-amz-date and x-amz-content-sha256 (added here). */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  readonly payloadSha256: string;
  readonly region: string;
  readonly service: string;
  readonly now: Date;
  /**
   * Whether `x-amz-content-sha256` is sent and signed. S3 requires it; the generic SigV4
   * vectors (service `service`) do not carry it. Default true.
   */
  readonly contentSha256Header?: boolean;
}

export interface SignedRequest {
  /** Every header to send, lower-case names, `authorization` included. */
  readonly headers: Readonly<Record<string, string>>;
  /** Exposed for the tests that pin the intermediate strings to the vectors. */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

/** RFC 3986 encoding as SigV4 defines it: unreserved characters kept, everything else %XX. */
export function sigv4Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** An object key as a canonical (and sent) path: each segment encoded, the slashes kept. */
export function canonicalUriOf(segments: readonly string[]): string {
  return `/${segments
    .flatMap((segment) => segment.split('/'))
    .map(sigv4Encode)
    .join('/')}`;
}

/** `20130524T000000Z` */
export function amzDateOf(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

export function signingKeyOf(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function signRequest(request: SigV4Request, credentials: SigV4Credentials): SignedRequest {
  const amzDate = amzDateOf(request.now);
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = canonicalHeaderValue(value);
  }
  headers.host = request.host;
  headers['x-amz-date'] = amzDate;
  if (request.contentSha256Header !== false) {
    headers['x-amz-content-sha256'] = request.payloadSha256;
  }
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name] ?? ''}\n`).join('');
  const canonicalQuery = Object.entries(request.query ?? {})
    .map(([key, value]) => [sigv4Encode(key), sigv4Encode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonicalRequest = [
    request.method.toUpperCase(),
    request.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    request.payloadSha256,
  ].join('\n');
  const scope = `${date}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [SIGV4_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac(
    'sha256',
    signingKeyOf(credentials.secretAccessKey, date, request.region, request.service),
  )
    .update(stringToSign, 'utf8')
    .digest('hex');
  return {
    headers: {
      ...headers,
      authorization:
        `${SIGV4_ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}
