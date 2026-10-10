import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { canonicalJson, parseStrictJson } from './canonical-json.js';
import { containerInvalid, unsupportedVersion, wrongKey, type NxpkgError } from './errors.js';

/**
 * The cryptographic envelope of a `.nxpkg` container, format v1 — a port of the converter's
 * `mirza2nexa/nxpkg/crypto.py` (normative text: `docs/NXPKG_FORMAT.md` in that repository).
 *
 *   MAGIC "NXPKG\0" (6) || major 0x01 (1) || header_len (4, BE) || header (canonical JSON)
 *   || { ct_len (4, BE) || AES-256-GCM(chunk_i) || tag (16) } for i = 0..N-1
 *
 * nonce_i = nonce_prefix (7) || i (4, BE) || last (1); AAD = SHA-256(header bytes) for every
 * chunk. Exactly the final chunk has last = 1; every non-final chunk is `chunk_size` bytes.
 *
 * Key schedule (HKDF-SHA256, empty salt):
 *   K_enc     = HKDF(master, "nxpkg-v1/aes-256-gcm-stream/" || nonce_prefix)
 *   K_check   = HKDF(master, "nxpkg-v1/key-check")
 *   key_check = HMAC-SHA256(K_check, "nxpkg-key-check-v1")[0:16]
 * master = scrypt(NFC(passphrase) UTF-8, salt, N, r, p, 32) or the 32 raw key-file bytes.
 */

export const MAGIC = Buffer.from('NXPKG\x00', 'latin1');
export const FORMAT_MAJOR = 1;
export const FORMAT_NAME = 'nxpkg';
export const CIPHER = 'AES-256-GCM-STREAM';
export const DEFAULT_CHUNK_SIZE = 1 << 20;
export const MIN_CHUNK_SIZE = 1 << 12;
export const MAX_CHUNK_SIZE = 1 << 24;
export const MAX_HEADER_LEN = 16 * 1024;
export const PREFIX_LEN = MAGIC.length + 1 + 4;
export const TAG_LEN = 16;
export const NONCE_PREFIX_LEN = 7;
export const SALT_LEN = 16;
export const KEY_LEN = 32;
export const MAX_CHUNKS = 2 ** 32 - 1;

export const SCRYPT_MIN_N = 1 << 10;
export const SCRYPT_MAX_N = 1 << 20;
/**
 * The scrypt memory this reader will spend (128·N·r). The converter writes N = 2^17, r = 8
 * (128 MiB) and its reader accepts N up to 2^20 with r up to 32 (4 GiB). 1 GiB admits every
 * package the converter's writer can produce (r is always 8) and refuses a header that would
 * make the importer allocate gigabytes before the key is even checked.
 */
export const SCRYPT_MAX_MEMORY = 1 << 30;

const KEY_CHECK_MSG = Buffer.from('nxpkg-key-check-v1', 'ascii');
export const HKDF_INFO_ENC = Buffer.from('nxpkg-v1/aes-256-gcm-stream/', 'ascii');
export const HKDF_INFO_CHECK = Buffer.from('nxpkg-v1/key-check', 'ascii');

const KEY_FILE_PREFIX = 'nxkey1:';
const HEADER_KEYS = [
  'chunk_size',
  'cipher',
  'created_by',
  'format',
  'format_version',
  'kdf',
  'key_check',
  'nonce_prefix',
] as const;

export type NxpkgKdf =
  { name: 'scrypt'; n: number; r: number; p: number; salt: string } | { name: 'raw-key' };

export interface NxpkgHeader {
  format: 'nxpkg';
  format_version: 1;
  cipher: 'AES-256-GCM-STREAM';
  chunk_size: number;
  kdf: NxpkgKdf;
  key_check: string;
  nonce_prefix: string;
  created_by: { name: string; version: string };
}

export interface NxpkgHeaderInfo {
  header: NxpkgHeader;
  /** MAGIC || major || length || header JSON — the bytes the AAD is computed over. */
  headerBytes: Buffer;
  /** Lowercase hex SHA-256 of `headerBytes` (the ownership export's `package_header_sha256`). */
  headerSha256: string;
}

/** The operator's package secret: the key file's text, or the passphrase. */
export type NxpkgSecret = { keyFileText: string } | { passphrase: string };

// --------------------------------------------------------------------------- base64

const STD_B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Python `b64d`: `base64.b64decode(validate=True)` AND the re-encoding equals the input, i.e.
 * canonical standard base64 with padding. Returns null instead of throwing.
 */
export function b64dCanonical(text: unknown, expectLen?: number): Buffer | null {
  if (typeof text !== 'string' || !STD_B64.test(text)) return null;
  const raw = Buffer.from(text, 'base64');
  if (raw.toString('base64') !== text) return null;
  if (expectLen !== undefined && raw.length !== expectLen) return null;
  return raw;
}

/** Python `base64.b64decode(s, validate=True)`: alphabet and padding checked, not canonicity. */
export function b64dValidate(text: string): Buffer | null {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  return Buffer.from(text, 'base64');
}

// --------------------------------------------------------------------------- user secrets

/** Every code point Python's `str.isspace()` accepts — what `"".join(text.split())` drops. */
const C0_SEPARATORS = `${String.fromCharCode(0x1c)}-${String.fromCharCode(0x1f)}`; // FS..US
const PY_WHITESPACE = new RegExp(
  `[\\t\\n\\v\\f\\r${C0_SEPARATORS} \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]`,
  'gu',
);

function keyFileChecksum(key: Uint8Array): Buffer {
  return createHash('sha256').update('nxkey1').update(key).digest().subarray(0, 4);
}

/** `nxkey1:` + base64url-no-padding(key || SHA-256("nxkey1" || key)[0:4]). */
export function encodeKeyFile(key: Uint8Array): string {
  if (key.length !== KEY_LEN) throw new RangeError('key must be 32 bytes');
  const body = Buffer.concat([key, keyFileChecksum(key)]).toString('base64url');
  return KEY_FILE_PREFIX + body;
}

/**
 * Python `parse_key_file`: whitespace-tolerant (Python's whitespace set), prefix, base64url,
 * 36 bytes, checksum. Python's non-validating base64 decoder also silently DISCARDS
 * characters outside the alphabet; this one refuses them instead. Every text the
 * converter's `encode_key_file` produces parses to the same 32 bytes in both.
 */
export function parseKeyFile(text: string): Buffer {
  if (typeof text !== 'string') throw wrongKey('bad_key_file');
  const s = text.replace(PY_WHITESPACE, '');
  if (!s.startsWith(KEY_FILE_PREFIX)) throw wrongKey('bad_key_file');
  let body = s.slice(KEY_FILE_PREFIX.length);
  const pad = /=*$/.exec(body)?.[0].length ?? 0;
  if (pad > 2) throw wrongKey('bad_key_file');
  body = body.slice(0, body.length - pad);
  if (!/^[A-Za-z0-9+/_-]*$/.test(body) || body.length % 4 === 1) throw wrongKey('bad_key_file');
  const raw = Buffer.from(body.replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
  if (raw.length !== KEY_LEN + 4) throw wrongKey('bad_key_file');
  const key = raw.subarray(0, KEY_LEN);
  if (!timingSafeEqual(raw.subarray(KEY_LEN), keyFileChecksum(key))) {
    throw wrongKey('bad_key_file');
  }
  return Buffer.from(key);
}

const LONE_SURROGATE = /\p{Cs}/u;

/** Python `normalize_passphrase`: NFC, then UTF-8 (a lone surrogate cannot be encoded). */
export function normalizePassphrase(passphrase: string): Buffer {
  if (typeof passphrase !== 'string' || LONE_SURROGATE.test(passphrase)) {
    throw wrongKey('passphrase_not_encodable');
  }
  return Buffer.from(passphrase.normalize('NFC'), 'utf8');
}

// --------------------------------------------------------------------------- key schedule

function hkdf(master: Uint8Array, info: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, KEY_LEN));
}

export function keyCheckOf(master: Uint8Array): Buffer {
  const checkKey = hkdf(master, HKDF_INFO_CHECK);
  return createHmac('sha256', checkKey).update(KEY_CHECK_MSG).digest().subarray(0, 16);
}

export function encryptionKeyOf(master: Uint8Array, noncePrefix: Uint8Array): Buffer {
  return hkdf(master, Buffer.concat([HKDF_INFO_ENC, noncePrefix]));
}

function scrypt(password: Buffer, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export function scryptMemory(n: number, r: number, p: number): number {
  return 128 * r * (n + 2) + 128 * r * p;
}

/** The 32-byte master secret, or a typed WRONG_KEY when the secret is of the wrong kind. */
export async function masterKey(kdf: NxpkgKdf, secret: NxpkgSecret): Promise<Buffer> {
  if (kdf.name === 'scrypt') {
    if (!('passphrase' in secret)) throw wrongKey('passphrase_required');
    const salt = b64dCanonical(kdf.salt, SALT_LEN);
    if (salt === null) throw containerInvalid('header_kdf_salt');
    const pw = normalizePassphrase(secret.passphrase);
    try {
      return await scrypt(pw, salt, {
        N: kdf.n,
        r: kdf.r,
        p: kdf.p,
        maxmem: scryptMemory(kdf.n, kdf.r, kdf.p) + (1 << 20),
      });
    } finally {
      pw.fill(0);
    }
  }
  if (!('keyFileText' in secret)) throw wrongKey('key_file_required');
  return parseKeyFile(secret.keyFileText);
}

export interface PackageKeys {
  encKey: Buffer;
  keyCheck: Buffer;
}

/** Derive K_enc and key_check, and refuse a secret whose key_check differs from the header's. */
export async function deriveVerifiedKeys(
  header: NxpkgHeader,
  secret: NxpkgSecret,
): Promise<PackageKeys> {
  const master = await masterKey(header.kdf, secret);
  try {
    verifyKeyCheck(header, master);
    const noncePrefix = b64dCanonical(header.nonce_prefix, NONCE_PREFIX_LEN);
    if (noncePrefix === null) throw containerInvalid('header_nonce_prefix');
    return { encKey: encryptionKeyOf(master, noncePrefix), keyCheck: keyCheckOf(master) };
  } finally {
    master.fill(0);
  }
}

function verifyKeyCheck(header: NxpkgHeader, master: Buffer): void {
  const expected = b64dCanonical(header.key_check, 16);
  if (expected === null) throw containerInvalid('header_key_check');
  if (!timingSafeEqual(keyCheckOf(master), expected)) throw wrongKey('key_check_mismatch');
}

/**
 * Python `derive_aux_key`: a key for a companion document of this package, from the same
 * secret under a distinct HKDF `info`. The secret is verified against `key_check` FIRST, so a
 * wrong secret is refused rather than yielding a MAC key that silently verifies nothing.
 */
export async function deriveAuxKey(
  header: NxpkgHeader,
  info: Uint8Array,
  secret: NxpkgSecret,
): Promise<Buffer> {
  const infoBuf = Buffer.from(info);
  if (
    infoBuf.length === 0 ||
    (infoBuf.length >= HKDF_INFO_ENC.length &&
      infoBuf.subarray(0, HKDF_INFO_ENC.length).equals(HKDF_INFO_ENC)) ||
    infoBuf.equals(HKDF_INFO_CHECK)
  ) {
    throw new RangeError('reserved hkdf info');
  }
  const master = await masterKey(header.kdf, secret);
  try {
    verifyKeyCheck(header, master);
    return hkdf(master, infoBuf);
  } finally {
    master.fill(0);
  }
}

// --------------------------------------------------------------------------- header

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sameKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(o).sort();
  const want = [...keys].sort();
  return own.length === want.length && own.every((k, i) => k === want[i]);
}

/** Python `validate_header`: exact key sets and ranges. */
export function validateHeader(h: unknown): asserts h is NxpkgHeader {
  const bad = (why: string): NxpkgError => containerInvalid(`header_${why}`);
  if (!isPlainObject(h) || !sameKeys(h, HEADER_KEYS)) throw bad('key_set');
  if (h['format'] !== FORMAT_NAME || h['cipher'] !== CIPHER) throw bad('format_cipher');
  if (!isInt(h['format_version'])) throw bad('format_version');
  if (h['format_version'] !== FORMAT_MAJOR) throw unsupportedVersion('header_format_version');
  const cs = h['chunk_size'];
  if (!isInt(cs) || cs < MIN_CHUNK_SIZE || cs > MAX_CHUNK_SIZE) throw bad('chunk_size');
  const kdf = h['kdf'];
  if (!isPlainObject(kdf)) throw bad('kdf');
  if (kdf['name'] === 'scrypt') {
    if (!sameKeys(kdf, ['name', 'n', 'r', 'p', 'salt'])) throw bad('kdf_keys');
    const { n, r, p } = kdf;
    if (!isInt(n) || !isInt(r) || !isInt(p)) throw bad('kdf_params');
    if (
      !(n >= SCRYPT_MIN_N && n <= SCRYPT_MAX_N && (n & (n - 1)) === 0) ||
      !(r >= 1 && r <= 32) ||
      !(p >= 1 && p <= 16)
    ) {
      throw bad('kdf_params_range');
    }
    if (128 * n * r > SCRYPT_MAX_MEMORY) throw bad('kdf_memory_limit');
    if (b64dCanonical(kdf['salt'], SALT_LEN) === null) throw bad('kdf_salt');
  } else if (kdf['name'] === 'raw-key') {
    if (!sameKeys(kdf, ['name'])) throw bad('kdf_keys');
  } else {
    throw bad('kdf_name');
  }
  if (b64dCanonical(h['key_check'], 16) === null) throw bad('key_check');
  if (b64dCanonical(h['nonce_prefix'], NONCE_PREFIX_LEN) === null) throw bad('nonce_prefix');
  const cb = h['created_by'];
  if (
    !isPlainObject(cb) ||
    !sameKeys(cb, ['name', 'version']) ||
    typeof cb['name'] !== 'string' ||
    typeof cb['version'] !== 'string'
  ) {
    throw bad('created_by');
  }
}

/**
 * Validate the 11-byte prefix. Returns the header JSON length. Python order: magic, then the
 * container major (UNSUPPORTED rather than INVALID, so a future package reads as such), then
 * the length range.
 */
export function parsePrefix(prefix: Buffer): number {
  if (prefix.length < PREFIX_LEN || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw containerInvalid('not_nxpkg');
  }
  if (prefix[MAGIC.length] !== FORMAT_MAJOR) throw unsupportedVersion('container_major');
  const hlen = prefix.readUInt32BE(MAGIC.length + 1);
  if (hlen === 0 || hlen > MAX_HEADER_LEN) throw containerInvalid('header_length');
  return hlen;
}

/** Parse + validate header JSON bytes; they must be exactly the canonical re-encoding. */
export function parseHeaderBody(body: Buffer): NxpkgHeader {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(body);
  } catch {
    throw containerInvalid('header_json');
  }
  validateHeader(parsed);
  if (!canonicalJson(parsed).equals(body)) throw containerInvalid('header_not_canonical');
  return parsed;
}

export function encodeHeader(header: NxpkgHeader): Buffer {
  const body = canonicalJson(header);
  if (body.length > MAX_HEADER_LEN) throw new RangeError('header too large');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_MAJOR]), len, body]);
}

export function headerInfo(header: NxpkgHeader, headerBytes: Buffer): NxpkgHeaderInfo {
  return {
    header,
    headerBytes,
    headerSha256: createHash('sha256').update(headerBytes).digest('hex'),
  };
}

// --------------------------------------------------------------------------- STREAM

export function chunkNonce(prefix: Uint8Array, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  Buffer.from(prefix).copy(n, 0, 0, NONCE_PREFIX_LEN);
  n.writeUInt32BE(counter, NONCE_PREFIX_LEN);
  n[11] = last ? 1 : 0;
  return n;
}

/** AES-256-GCM decrypt of one chunk; null when the tag does not authenticate. */
export function openChunk(key: Buffer, nonce: Buffer, aad: Buffer, ct: Buffer): Buffer | null {
  const body = ct.subarray(0, ct.length - TAG_LEN);
  const tag = ct.subarray(ct.length - TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  d.setAAD(aad);
  d.setAuthTag(tag);
  const out = d.update(body);
  try {
    const fin = d.final();
    return fin.length === 0 ? out : Buffer.concat([out, fin]);
  } catch {
    out.fill(0);
    return null;
  }
}

/** AES-256-GCM encrypt of one chunk: ciphertext || tag. */
export function sealChunk(key: Buffer, nonce: Buffer, aad: Buffer, pt: Uint8Array): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  c.setAAD(aad);
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
}
