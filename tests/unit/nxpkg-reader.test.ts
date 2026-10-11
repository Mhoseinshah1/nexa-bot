import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NxpkgError,
  canonicalJson,
  encodeKeyFile,
  openNxpkg,
  parseKeyFile,
  readNxpkgHeader,
  type NxpkgOpenOptions,
  type NxpkgPackage,
  type NxpkgSecret,
} from '../../apps/api/src/infrastructure/nxpkg';
import {
  dropChunk,
  flipByte,
  headerJson,
  headerLength,
  listChunks,
  replaceHeaderJson,
  swapChunks,
} from '../support/nxpkg/tamper';
import {
  newRawKey,
  writeNxpkg,
  zipStream,
  type WriteNxpkgOptions,
  type ZipMember,
} from '../support/nxpkg/writer';

/**
 * The `.nxpkg` reader (`apps/api/src/infrastructure/nxpkg`).
 *
 * Part 1 opens the two packages the PYTHON converter wrote (`tests/fixtures/nxpkg`,
 * synthetic) and compares everything with what the Python reader saw. Part 2 round-trips
 * the test writer. Part 3 is tampering: every way a package can be wrong, with the code it
 * must produce — and a check that no error ever carries a secret or a record value.
 */
const FIXTURES = join(__dirname, '../fixtures/nxpkg');
const KEY_FILE_TEXT = readFileSync(join(FIXTURES, 'synthetic-keyfile.nxkey'), 'utf8');

interface PackageFacts {
  header_sha256: string;
  file_sha256: string;
  payload_sha256: string;
  payload_size: number;
  chunks: number;
  import_id: string;
  source_fingerprint: string;
  package_schema_version: string;
  files: Record<string, { sha256: string; size: number; records: number | null }>;
  jsonl_canonical_digests: Record<string, string>;
}
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  passphrase: string;
  keyfile: PackageFacts;
  passphrase_package: PackageFacts;
};

let root: string;
let workDir: string;
const LIMITS = {
  maxPayloadBytes: 64 * 1024 * 1024,
  maxFiles: 1000,
  maxFileBytes: 32 * 1024 * 1024,
};
const opts = (over: Partial<NxpkgOpenOptions> = {}): NxpkgOpenOptions => ({
  workDir,
  ...LIMITS,
  ...over,
});

/** Every secret or record value a test used; none may appear in any thrown error. */
const SECRETS = new Set<string>();
const RECORD_SENTINEL = 'RECORD-VALUE-SENTINEL-7f3a';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nxpkg-reader-'));
  workDir = join(root, 'work');
  SECRETS.add(KEY_FILE_TEXT.trim());
  SECRETS.add(parseKeyFile(KEY_FILE_TEXT).toString('hex'));
  SECRETS.add(parseKeyFile(KEY_FILE_TEXT).toString('base64'));
  SECRETS.add(expected.passphrase);
  SECRETS.add(RECORD_SENTINEL);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
const out = (name: string): string => join(root, `${n++}-${name}.nxpkg`);

async function expectError(
  p: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<NxpkgError> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected ${code}`).toBeInstanceOf(NxpkgError);
  const err = caught as NxpkgError;
  expect(err.code).toBe(code);
  if (reason !== undefined) expect(err.reason).toBe(reason);
  assertNoSecrets(err);
  return err;
}

function assertNoSecrets(err: unknown): void {
  const views = [
    inspect(err, { showHidden: true, depth: 10 }),
    JSON.stringify(err),
    String((err as Error).stack),
  ].join('\n');
  for (const s of SECRETS) expect(views.includes(s), 'error leaks a secret or value').toBe(false);
}

function workDirIsEmpty(): boolean {
  try {
    return readdirSync(workDir).length === 0;
  } catch {
    return true;
  }
}

async function collect(pkg: NxpkgPackage, rel: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for await (const r of pkg.iterJsonl(rel)) rows.push(r);
  return rows;
}

// --------------------------------------------------------------------------- part 1

describe('packages written by the Python converter', () => {
  const cases: [string, string, () => NxpkgSecret, PackageFacts][] = [
    [
      'key file',
      'synthetic-keyfile.nxpkg',
      () => ({ keyFileText: KEY_FILE_TEXT }),
      expected.keyfile,
    ],
    [
      'passphrase (given in NFD; NFC-normalised as Python does)',
      'synthetic-passphrase.nxpkg',
      () => ({ passphrase: expected.passphrase.normalize('NFD') }),
      expected.passphrase_package,
    ],
  ];

  it.each(cases)('opens and verifies the %s package', async (_label, file, secret, facts) => {
    expect(expected.passphrase.normalize('NFD')).not.toBe(expected.passphrase);
    const path = join(FIXTURES, file);
    const header = await readNxpkgHeader(path);
    expect(header.headerSha256).toBe(facts.header_sha256);
    expect(header.header.created_by.name).toBe('mirza2nexa');

    const pkg = await openNxpkg(path, secret(), opts());
    try {
      expect(pkg.headerSha256).toBe(facts.header_sha256);
      expect(pkg.fileSha256).toBe(facts.file_sha256);
      expect(pkg.fileSha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
      expect(pkg.payloadSha256).toBe(facts.payload_sha256);
      expect(pkg.payloadSize).toBe(facts.payload_size);
      expect(pkg.chunks).toBe(facts.chunks);
      expect(pkg.manifest.import_id).toBe(facts.import_id);
      expect(pkg.manifest.source_fingerprint).toBe(facts.source_fingerprint);
      expect(pkg.manifest.package_schema).toBe('nexa.migration.mirza');
      expect(pkg.manifest.package_schema_version).toBe(facts.package_schema_version);
      const files = Object.fromEntries(pkg.files().map(({ path: p, ...e }) => [p, e]));
      expect(files).toEqual(facts.files);
      expect(pkg.has('records/customers.jsonl')).toBe(true);
      expect(pkg.has('records/nope.jsonl')).toBe(false);
      expect(pkg.has('../manifest.json')).toBe(false);

      // Every JSONL file: parse with the TS reader, re-encode canonically, compare with the
      // digest Python computed the same way. Proves parse + canonical round-trip agree.
      for (const [rel, digest] of Object.entries(facts.jsonl_canonical_digests)) {
        const h = createHash('sha256');
        let count = 0;
        for await (const rec of pkg.iterJsonl(rel)) {
          h.update(canonicalJson(rec)).update('\n');
          count++;
        }
        expect(h.digest('hex'), rel).toBe(digest);
        expect(count, rel).toBe(facts.files[rel]?.records);
      }
      // Contract 1.4.0: the source snapshot the NXPKG source adapter reads.
      expect(pkg.manifest.package_schema_version).toBe('1.4.0');
      for (const rel of [
        'source/catalog.json',
        'source/tables/user.jsonl',
        'source/tables/invoice.jsonl',
        'source/tables/product.jsonl',
      ]) {
        expect(pkg.has(rel), rel).toBe(true);
      }
      const catalog = (await pkg.readJson('source/catalog.json')) as Record<string, unknown>;
      expect(catalog['format']).toBe('m2n.source-catalog.v1');
      expect(catalog['synthetic_marker']).not.toBeNull();
      const snap = catalog['snapshot_tables'] as Record<string, { file: string; rows: number }>;
      for (const t of ['user', 'invoice', 'product']) {
        expect(snap[t]?.file).toBe(`source/tables/${t}.jsonl`);
        // One header line ({format, table, primary_key, columns}), then one {c: [...]} per row.
        expect(snap[t]?.rows).toBe((facts.files[`source/tables/${t}.jsonl`]?.records ?? 0) - 1);
      }
      const coverage = await pkg.readJson('reports/coverage.json');
      expect(typeof coverage).toBe('object');
      expect(await pkg.readJson('manifest.json')).toEqual(pkg.manifest);

      // The private work dir: 0700, the decrypted payload 0600.
      const dirs = readdirSync(workDir);
      expect(dirs).toHaveLength(1);
      const dir = join(workDir, dirs[0] as string);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, 'payload.zip')).mode & 0o777).toBe(0o600);
    } finally {
      await pkg.close();
    }
    expect(workDirIsEmpty()).toBe(true);
    await pkg.close(); // idempotent
  });

  it('refuses the wrong kind of secret for each Python package', async () => {
    await expectError(
      openNxpkg(
        join(FIXTURES, 'synthetic-keyfile.nxpkg'),
        { passphrase: expected.passphrase },
        opts(),
      ),
      'NXPKG_WRONG_KEY',
      'key_file_required',
    );
    await expectError(
      openNxpkg(
        join(FIXTURES, 'synthetic-passphrase.nxpkg'),
        { keyFileText: KEY_FILE_TEXT },
        opts(),
      ),
      'NXPKG_WRONG_KEY',
      'passphrase_required',
    );
    expect(workDirIsEmpty()).toBe(true);
  });
});

// --------------------------------------------------------------------------- part 2

const RECORDS = Array.from({ length: 500 }, (_, i) => ({
  id: i,
  name: `کاربر ${i} \u{1F600}`,
  balance: { amount: String(i * 1000), unit: 'toman' },
  note: i === 7 ? RECORD_SENTINEL : null,
}));

/** Incompressible, so a 4 KiB chunk size really yields several chunks. */
const NOISE = randomBytes(20_000);

function baseFiles(): WriteNxpkgOptions['files'] {
  return {
    'blobs/noise.bin': NOISE,
    'records/customers.jsonl': { records: RECORDS },
    'records/empty.jsonl': Buffer.alloc(0),
    'reports/summary.json': { json: { customers: RECORDS.length, ok: true } },
    'source/catalog.json': { json: { tables: ['user'] } },
  };
}

describe('the test writer round-trips through the reader', () => {
  it.each([
    ['raw key, one chunk', {}],
    ['raw key, many 4 KiB chunks', { chunkSize: 4096 }],
    ['ZIP64 local records', { zip64: true as const, chunkSize: 4096 }],
    ['ZIP64 everywhere', { zip64: 'full' as const }],
  ] as [string, Partial<WriteNxpkgOptions>][])('%s', async (_label, extra) => {
    const k = newRawKey();
    SECRETS.add(k.keyFileText);
    const w = await writeNxpkg(out('rt'), {
      files: baseFiles(),
      secret: { rawKey: k.rawKey },
      ...extra,
    });
    expect(w.keyFileText).toBe(k.keyFileText);
    const pkg = await openNxpkg(w.path, { keyFileText: k.keyFileText }, opts());
    try {
      expect(pkg.payloadSha256).toBe(w.payloadSha256);
      expect(pkg.headerSha256).toBe(w.headerSha256);
      expect(pkg.manifest.package_schema_version).toBe('1.4.0');
      expect(await collect(pkg, 'records/customers.jsonl')).toEqual(RECORDS);
      expect(await collect(pkg, 'records/empty.jsonl')).toEqual([]);
      expect(await pkg.readJson('reports/summary.json')).toEqual({ customers: 500, ok: true });
      expect(pkg.files().map((f) => f.path)).toEqual([
        'blobs/noise.bin',
        'manifest.json',
        'records/customers.jsonl',
        'records/empty.jsonl',
        'reports/summary.json',
        'source/catalog.json',
      ]);
      if (extra.chunkSize) expect(pkg.chunks).toBeGreaterThan(3);
    } finally {
      await pkg.close();
    }
  });

  it('carries a contract 1.4.0 source snapshot given as files', async () => {
    const k = newRawKey();
    SECRETS.add(k.keyFileText);
    // The converter's shape: a header line, then one {c: [cells as MySQL text]} per row.
    const users = [
      {
        format: 'm2n.source-table.v1',
        table: 'user',
        primary_key: 'id',
        columns: ['id', 'Balance'],
      },
      { c: ['1001', '5000'] },
    ];
    const w = await writeNxpkg(out('snapshot'), {
      files: {
        ...baseFiles(),
        'source/catalog.json': {
          json: {
            format: 'm2n.source-catalog.v1',
            synthetic_marker: 'test-writer',
            snapshot_tables: {
              user: {
                file: 'source/tables/user.jsonl',
                rows: 1,
                primary_key: 'id',
                columns: ['id', 'Balance'],
              },
            },
          },
        },
        'source/tables/user.jsonl': { records: users },
      },
      secret: { rawKey: k.rawKey },
    });
    const files = w.manifest['files'] as Record<string, { records: number | null }>;
    expect(files['source/tables/user.jsonl']?.records).toBe(2);
    const pkg = await openNxpkg(w.path, { keyFileText: k.keyFileText }, opts());
    try {
      expect(await collect(pkg, 'source/tables/user.jsonl')).toEqual(users);
      expect(await pkg.readJson('source/catalog.json')).toMatchObject({
        synthetic_marker: 'test-writer',
      });
    } finally {
      await pkg.close();
    }
  });

  it('passphrase package (scrypt N = 2^10)', async () => {
    const passphrase = 'writer-passphrase-0042';
    SECRETS.add(passphrase);
    const w = await writeNxpkg(out('pp'), { files: baseFiles(), secret: { passphrase } });
    expect(w.keyFileText).toBeNull();
    const pkg = await openNxpkg(w.path, { passphrase }, opts());
    expect(await collect(pkg, 'records/customers.jsonl')).toHaveLength(500);
    await pkg.close();
  });

  it('key file text is whitespace-tolerant and checksummed, like parse_key_file', () => {
    const k = newRawKey();
    const text = k.keyFileText;
    expect(parseKeyFile(`  ${text.slice(0, 20)}\n\t${text.slice(20)}\u3000\n`)).toEqual(k.rawKey);
    expect(encodeKeyFile(parseKeyFile(text))).toBe(text);
    // Python's str.split() whitespace (C0 separators and NEL included), not JavaScript's \s:
    // U+FEFF is whitespace to JS and not to Python.
    const pyWhitespace = [0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0x2028, 0x202f, 0x3000];
    const sep = String.fromCharCode(...pyWhitespace);
    expect(parseKeyFile(text.split('').join(sep))).toEqual(k.rawKey);
    expect(() => parseKeyFile(`${text}\ufeff`)).toThrow(NxpkgError);
    const typo = text.slice(0, -2) + (text.endsWith('A') ? 'BB' : 'AA');
    let err: unknown;
    try {
      parseKeyFile(typo);
    } catch (e) {
      err = e;
    }
    expect((err as NxpkgError).code).toBe('NXPKG_WRONG_KEY');
    expect((err as NxpkgError).reason).toBe('bad_key_file');
    SECRETS.add(text);
    assertNoSecrets(err);
  });
});

// --------------------------------------------------------------------------- part 3

describe('tampering and limits', () => {
  let good: { path: string; bytes: Buffer; keyFileText: string };

  beforeAll(async () => {
    const k = newRawKey();
    SECRETS.add(k.keyFileText);
    const w = await writeNxpkg(out('good'), {
      files: baseFiles(),
      secret: { rawKey: k.rawKey },
      chunkSize: 4096,
    });
    good = { path: w.path, bytes: readFileSync(w.path), keyFileText: k.keyFileText };
    expect(listChunks(good.bytes).length).toBeGreaterThan(3);
  });

  const variant = (bytes: Buffer): string => {
    const p = out('variant');
    writeFileSync(p, bytes);
    return p;
  };
  const open = (path: string, over: Partial<NxpkgOpenOptions> = {}) =>
    openNxpkg(path, { keyFileText: good.keyFileText }, opts(over));
  const build = async (o: Partial<WriteNxpkgOptions>) => {
    const k = newRawKey();
    SECRETS.add(k.keyFileText);
    const w = await writeNxpkg(out('built'), {
      files: baseFiles(),
      secret: { rawKey: k.rawKey },
      ...o,
    });
    return openNxpkg(w.path, { keyFileText: k.keyFileText }, opts());
  };

  it('the untampered package opens', async () => {
    const pkg = await open(good.path);
    await pkg.close();
  });

  describe('container and header', () => {
    it('not a package', async () => {
      await expectError(
        open(variant(Buffer.from('PK\x03\x04 not an nxpkg'))),
        'NXPKG_CONTAINER_INVALID',
        'not_nxpkg',
      );
      await expectError(
        open(variant(flipByte(good.bytes, 0))),
        'NXPKG_CONTAINER_INVALID',
        'not_nxpkg',
      );
    });

    it('unknown container major', async () => {
      const b = Buffer.from(good.bytes);
      b[6] = 2;
      await expectError(open(variant(b)), 'NXPKG_UNSUPPORTED_VERSION', 'container_major');
    });

    it('header format_version 2 (canonical, otherwise valid)', async () => {
      const h = JSON.parse(headerJson(good.bytes).toString('utf8')) as Record<string, unknown>;
      h['format_version'] = 2;
      const b = replaceHeaderJson(good.bytes, canonicalJson(h));
      await expectError(open(variant(b)), 'NXPKG_UNSUPPORTED_VERSION', 'header_format_version');
    });

    it('a header that is valid but not canonical', async () => {
      const h = JSON.parse(headerJson(good.bytes).toString('utf8')) as unknown;
      const b = replaceHeaderJson(good.bytes, Buffer.from(JSON.stringify(h, null, 1)));
      await expectError(open(variant(b)), 'NXPKG_CONTAINER_INVALID', 'header_not_canonical');
    });

    it('an unknown header key, an out-of-range chunk size, a length past the file', async () => {
      const h = JSON.parse(headerJson(good.bytes).toString('utf8')) as Record<string, unknown>;
      await expectError(
        open(variant(replaceHeaderJson(good.bytes, canonicalJson({ ...h, extra: 1 })))),
        'NXPKG_CONTAINER_INVALID',
        'header_key_set',
      );
      await expectError(
        open(variant(replaceHeaderJson(good.bytes, canonicalJson({ ...h, chunk_size: 100 })))),
        'NXPKG_CONTAINER_INVALID',
        'header_chunk_size',
      );
      const b = Buffer.from(good.bytes);
      b.writeUInt32BE(16 * 1024 + 1, 7);
      await expectError(open(variant(b)), 'NXPKG_CONTAINER_INVALID', 'header_length');
      await expectError(
        open(variant(good.bytes.subarray(0, 40))),
        'NXPKG_CONTAINER_INVALID',
        'header_truncated',
      );
    });

    it('an edited but well-formed header field fails chunk authentication (AAD)', async () => {
      const h = JSON.parse(headerJson(good.bytes).toString('utf8')) as Record<string, unknown>;
      h['created_by'] = { name: 'nexa-test-writer', version: '9.9.9' };
      const b = replaceHeaderJson(good.bytes, canonicalJson(h));
      await expectError(open(variant(b)), 'NXPKG_TAMPERED', 'chunk_authentication_failed');
    });

    it('an edited key_check reads as a wrong key, before any decryption', async () => {
      const h = JSON.parse(headerJson(good.bytes).toString('utf8')) as Record<string, unknown>;
      h['key_check'] = Buffer.alloc(16, 7).toString('base64');
      const b = replaceHeaderJson(good.bytes, canonicalJson(h));
      await expectError(open(variant(b)), 'NXPKG_WRONG_KEY', 'key_check_mismatch');
    });

    it('a flipped byte inside the header JSON never opens', async () => {
      const hl = headerLength(good.bytes);
      for (let off = 11; off < hl; off += 7) {
        await expect(open(variant(flipByte(good.bytes, off)))).rejects.toBeInstanceOf(NxpkgError);
      }
    });
  });

  describe('secrets', () => {
    it('wrong key, wrong passphrase, malformed key file', async () => {
      const other = newRawKey();
      SECRETS.add(other.keyFileText);
      await expectError(
        openNxpkg(good.path, { keyFileText: other.keyFileText }, opts()),
        'NXPKG_WRONG_KEY',
        'key_check_mismatch',
      );
      const passphrase = 'correct-horse-battery';
      const wrong = 'correct-horse-battery!';
      SECRETS.add(passphrase);
      SECRETS.add(wrong);
      const w = await writeNxpkg(out('pp'), { files: baseFiles(), secret: { passphrase } });
      await expectError(
        openNxpkg(w.path, { passphrase: wrong }, opts()),
        'NXPKG_WRONG_KEY',
        'key_check_mismatch',
      );
      await expectError(
        openNxpkg(good.path, { keyFileText: 'nxkey1:short' }, opts()),
        'NXPKG_WRONG_KEY',
        'bad_key_file',
      );
      await expectError(
        openNxpkg(
          good.path,
          { keyFileText: good.keyFileText.replace('nxkey1:', 'nxkey2:') },
          opts(),
        ),
        'NXPKG_WRONG_KEY',
        'bad_key_file',
      );
      expect(workDirIsEmpty()).toBe(true);
    });
  });

  describe('STREAM body', () => {
    it('a flipped byte in a ciphertext body or a tag', async () => {
      const chunks = listChunks(good.bytes);
      const c1 = chunks[1]!;
      await expectError(
        open(variant(flipByte(good.bytes, c1.offset + 4 + 10))),
        'NXPKG_TAMPERED',
        'chunk_authentication_failed',
      );
      const last = chunks[chunks.length - 1]!;
      await expectError(
        open(variant(flipByte(good.bytes, last.offset + 4 + last.length - 1))),
        'NXPKG_TAMPERED',
        'chunk_authentication_failed',
      );
      expect(workDirIsEmpty()).toBe(true);
    });

    it('a chunk length out of range', async () => {
      const c0 = listChunks(good.bytes)[0]!;
      const b = Buffer.from(good.bytes);
      b.writeUInt32BE(4096 + 17, c0.offset);
      await expectError(open(variant(b)), 'NXPKG_TAMPERED', 'chunk_length_out_of_range');
      b.writeUInt32BE(15, c0.offset);
      await expectError(open(variant(b)), 'NXPKG_TAMPERED', 'chunk_length_out_of_range');
    });

    it('truncation: final chunk dropped, cut mid-chunk, cut mid-length', async () => {
      const chunks = listChunks(good.bytes);
      const last = chunks[chunks.length - 1]!;
      await expectError(
        open(variant(good.bytes.subarray(0, last.offset))),
        'NXPKG_TAMPERED',
        'truncated_final_chunk_missing',
      );
      await expectError(
        open(variant(good.bytes.subarray(0, last.offset + 10))),
        'NXPKG_TAMPERED',
        'truncated_chunk',
      );
      await expectError(
        open(variant(good.bytes.subarray(0, last.offset + 2))),
        'NXPKG_TAMPERED',
        'truncated_chunk_length',
      );
      await expectError(
        open(variant(good.bytes.subarray(0, good.bytes.length - 1))),
        'NXPKG_TAMPERED',
      );
    });

    it('a dropped middle chunk', async () => {
      await expectError(
        open(variant(dropChunk(good.bytes, 1))),
        'NXPKG_TAMPERED',
        'chunk_authentication_failed',
      );
    });

    it('reordered chunks', async () => {
      await expectError(
        open(variant(swapChunks(good.bytes, 0, 1))),
        'NXPKG_TAMPERED',
        'chunk_authentication_failed',
      );
      await expectError(
        open(variant(swapChunks(good.bytes, 1, 2))),
        'NXPKG_TAMPERED',
        'chunk_authentication_failed',
      );
    });

    it('appended bytes, and an appended copy of the final chunk', async () => {
      await expectError(
        open(variant(Buffer.concat([good.bytes, Buffer.from([0])]))),
        'NXPKG_TAMPERED',
        'trailing_data',
      );
      const last = listChunks(good.bytes).at(-1)!;
      const copy = good.bytes.subarray(last.offset);
      await expectError(
        open(variant(Buffer.concat([good.bytes, copy]))),
        'NXPKG_TAMPERED',
        'trailing_data',
      );
    });

    it('a chunk from another package with the same key does not authenticate', async () => {
      const k = parseKeyFile(good.keyFileText);
      const other = await writeNxpkg(out('other'), {
        files: baseFiles(),
        secret: { rawKey: k },
        chunkSize: 4096,
      });
      const ob = readFileSync(other.path);
      const oc = listChunks(ob)[0]!;
      const gc = listChunks(good.bytes)[0]!;
      const mixed = Buffer.concat([
        good.bytes.subarray(0, gc.offset),
        ob.subarray(oc.offset, oc.offset + 4 + oc.length),
        good.bytes.subarray(gc.offset + 4 + gc.length),
      ]);
      await expectError(open(variant(mixed)), 'NXPKG_TAMPERED', 'chunk_authentication_failed');
    });
  });

  describe('payload contract (authenticated, still wrong)', () => {
    it('package_schema_version major 2, payload_format zip-v2', async () => {
      await expectError(
        build({ manifest: { package_schema_version: '2.0.0' } }),
        'NXPKG_UNSUPPORTED_VERSION',
        'package_schema_major',
      );
      await expectError(
        build({ transformManifest: (m) => ({ ...m, payload_format: 'zip-v2' }) }),
        'NXPKG_UNSUPPORTED_VERSION',
        'payload_format',
      );
      await expectError(
        build({ manifest: { package_schema_version: '1.4' } }),
        'NXPKG_CONTAINER_INVALID',
        'manifest_package_schema_version',
      );
    });

    it('a manifest missing a field or naming another schema', async () => {
      await expectError(
        build({ transformManifest: ({ import_id: _drop, ...m }) => m }),
        'NXPKG_CONTAINER_INVALID',
        'manifest_missing_field',
      );
      await expectError(
        build({ manifest: { package_schema: 'other' } }),
        'NXPKG_CONTAINER_INVALID',
        'manifest_package_schema',
      );
      await expectError(
        build({ manifest: { compatibility: { target: 'x', min_importer_version: '1.0.0' } } }),
        'NXPKG_CONTAINER_INVALID',
        'manifest_compatibility_target',
      );
    });

    it('checksum mismatch, size mismatch, record-count mismatch', async () => {
      const edit = (rel: string, field: string, value: unknown) => (c: Record<string, unknown>) => {
        const files = structuredClone(c['files']) as Record<string, Record<string, unknown>>;
        files[rel]![field] = value;
        return { ...c, files };
      };
      await expectError(
        build({ transformChecksums: edit('records/customers.jsonl', 'sha256', 'a'.repeat(64)) }),
        'NXPKG_TAMPERED',
        'checksum_mismatch',
      );
      await expectError(
        build({ transformChecksums: edit('reports/summary.json', 'size', 3) }),
        'NXPKG_TAMPERED',
        'size_mismatch',
      );
      await expectError(
        build({ transformChecksums: edit('records/customers.jsonl', 'records', 499) }),
        'NXPKG_TAMPERED',
        'record_count_mismatch',
      );
      await expectError(
        build({ transformChecksums: edit('records/customers.jsonl', 'records', null) }),
        'NXPKG_TAMPERED',
        'record_count_mismatch',
      );
      await expectError(
        build({ transformChecksums: edit('records/customers.jsonl', 'size', -1) }),
        'NXPKG_TAMPERED',
        'file_entry_size',
      );
      await expectError(
        build({ transformChecksums: (c) => ({ ...c, algorithm: 'md5' }) }),
        'NXPKG_TAMPERED',
        'checksums_algorithm',
      );
    });

    it('manifest.files disagreeing with checksums.json', async () => {
      await expectError(
        build({
          transformManifest: (m) => {
            const files = structuredClone(m['files']) as Record<string, Record<string, unknown>>;
            files['records/empty.jsonl']!['records'] = null;
            return { ...m, files };
          },
        }),
        'NXPKG_TAMPERED',
        'manifest_files_differ_from_checksums',
      );
    });

    it('an extra entry, a missing entry, a missing checksums.json', async () => {
      await expectError(
        build({
          transformEntries: (m) => [...m, { name: 'zz/extra.json', source: Buffer.from('{}') }],
        }),
        'NXPKG_TAMPERED',
        'zip_entries_differ_from_checksums',
      );
      await expectError(
        build({ transformEntries: (m) => m.filter((e) => e.name !== 'source/catalog.json') }),
        'NXPKG_TAMPERED',
        'zip_entries_differ_from_checksums',
      );
      await expectError(
        build({ transformEntries: (m) => m.filter((e) => e.name !== 'checksums.json') }),
        'NXPKG_TAMPERED',
        'manifest_or_checksums_missing',
      );
    });

    it.each([
      ['../evil.jsonl', 'zip_unsafe_name'],
      ['/etc/passwd', 'zip_unsafe_name'],
      ['records\\..\\evil', 'zip_unsafe_name'],
      ['records/../../evil', 'zip_unsafe_name'],
      ['records/', 'zip_unsafe_name'],
      ['records//x', 'zip_unsafe_name'],
      ['records/x.', 'zip_unsafe_name'],
      ['C:/evil', 'zip_unsafe_name'],
    ])('ZIP entry name %j', async (name, reason) => {
      await expectError(
        build({
          transformEntries: (m) =>
            m.map((e) => (e.name === 'records/empty.jsonl' ? { ...e, name } : e)),
        }),
        'NXPKG_TAMPERED',
        reason,
      );
    });

    it('a duplicate entry', async () => {
      await expectError(
        build({
          transformEntries: (m) => [
            ...m,
            m.find((e) => e.name === 'source/catalog.json') as ZipMember,
          ],
        }),
        'NXPKG_TAMPERED',
        'zip_duplicate_name',
      );
    });

    it('a symlink, a directory attribute, a non-Unix entry', async () => {
      const set = (over: Partial<ZipMember>) =>
        build({
          transformEntries: (m) =>
            m.map((e) => (e.name === 'records/empty.jsonl' ? { ...e, ...over } : e)),
        });
      await expectError(
        set({ externalAttr: 0o120777 * 0x10000 }),
        'NXPKG_TAMPERED',
        'zip_entry_type',
      );
      await expectError(
        set({ externalAttr: 0o100644 * 0x10000 + 0x10 }),
        'NXPKG_TAMPERED',
        'zip_entry_type',
      );
      await expectError(set({ madeBy: 20 }), 'NXPKG_TAMPERED', 'zip_entry_type');
    });

    it('an unexpected compression method', async () => {
      await expectError(
        build({
          transformEntries: (m) =>
            m.map((e) => (e.name === 'reports/summary.json' ? { ...e, method: 12 } : e)),
        }),
        'NXPKG_TAMPERED',
        'zip_compression_method',
      );
    });

    it('declared size or CRC lying about the content', async () => {
      const lie = (over: Partial<ZipMember>) =>
        build({
          transformEntries: (m) =>
            m.map((e) => (e.name === 'records/customers.jsonl' ? { ...e, ...over } : e)),
        });
      await expectError(lie({ sizeOverride: 10 }), 'NXPKG_TAMPERED');
      await expectError(lie({ crcOverride: 12345 }), 'NXPKG_TAMPERED', 'zip_entry_crc');
    });

    it('a payload that is not a ZIP, or a ZIP with a trailing byte', async () => {
      await expectError(
        build({ rawPayload: Buffer.from('not a zip at all, but authenticated') }),
        'NXPKG_TAMPERED',
      );
      const parts: Buffer[] = [];
      for await (const p of zipStream([{ name: 'a.json', source: Buffer.from('{}') }]))
        parts.push(p);
      await expectError(
        build({ rawPayload: Buffer.concat([...parts, Buffer.from('x')]) }),
        'NXPKG_TAMPERED',
        'zip_eocd',
      );
      await expectError(
        build({ rawPayload: Buffer.concat([Buffer.from('x'), ...parts]) }),
        'NXPKG_TAMPERED',
      );
    });
  });

  describe('limits', () => {
    it('too many files, a file too large, a payload too large', async () => {
      await expectError(open(good.path, { maxFiles: 6 }), 'NXPKG_TAMPERED', 'too_many_files');
      await expectError(
        open(good.path, { maxFileBytes: 19_999 }),
        'NXPKG_TAMPERED',
        'file_too_large',
      );
      await expectError(
        open(good.path, { maxPayloadBytes: 1000 }),
        'NXPKG_CONTAINER_INVALID',
        'payload_too_large',
      );
      const ok = await open(good.path, { maxFiles: 7 });
      await ok.close();
      expect(workDirIsEmpty()).toBe(true);
    });

    it('rejects nonsense limits before touching the file', async () => {
      await expect(open(good.path, { maxFiles: 0 })).rejects.toThrow(RangeError);
      await expect(open(good.path, { maxTotalBytes: 0 })).rejects.toThrow(RangeError);
      await expect(open(good.path, { maxCompressionRatio: -1 })).rejects.toThrow(RangeError);
    });

    it('bounds the SUM of the uncompressed sizes across entries (a bomb spread thin)', async () => {
      // Each file is under maxFileBytes; together (the 20 000-byte noise and the rest) they
      // are over this cumulative cap.
      await expectError(
        open(good.path, { maxTotalBytes: 20_000 }),
        'NXPKG_TAMPERED',
        'zip_total_too_large',
      );
      const ok = await open(good.path, { maxTotalBytes: 64 * 1024 * 1024 });
      await ok.close();
      expect(workDirIsEmpty()).toBe(true);
    });

    it('refuses an entry that inflates past the compression ratio, above the floor only', async () => {
      const k = newRawKey();
      SECRETS.add(k.keyFileText);
      // 2 MiB of one byte deflates to about 2 KiB: a ratio near 1000:1.
      const w = await writeNxpkg(out('bomb'), {
        files: { 'blobs/spaces.bin': Buffer.alloc(2 * 1024 * 1024, 0x20) },
        secret: { rawKey: k.rawKey },
      });
      const secret = { keyFileText: k.keyFileText };
      await expectError(
        openNxpkg(w.path, secret, opts()),
        'NXPKG_TAMPERED',
        'zip_compression_ratio',
      );
      // Below the floor it is not asked; with a ratio cap above it, it opens.
      const floor = await openNxpkg(w.path, secret, opts({ ratioFloorBytes: 4 * 1024 * 1024 }));
      await floor.close();
      const lax = await openNxpkg(w.path, secret, opts({ maxCompressionRatio: 5000 }));
      await lax.close();
      expect(workDirIsEmpty()).toBe(true);
    });
  });

  describe('records', () => {
    it('a float or a non-object record fails the read, not the open', async () => {
      const pkg = await build({
        files: {
          'records/a.jsonl': `{"a":1}\n{"amount":1.0,"v":"${RECORD_SENTINEL}"}\n`,
          'records/b.jsonl': '[1,2]\n',
          'reports/c.json': '{"x":1e2}',
        },
      });
      try {
        const rows: unknown[] = [];
        const err = await expectError(
          (async () => {
            for await (const r of pkg.iterJsonl('records/a.jsonl')) rows.push(r);
          })(),
          'NXPKG_CONTAINER_INVALID',
          'invalid_record',
        );
        expect(rows).toEqual([{ a: 1 }]);
        assertNoSecrets(err);
        await expectError(
          collect(pkg, 'records/b.jsonl'),
          'NXPKG_CONTAINER_INVALID',
          'invalid_record',
        );
        await expectError(
          pkg.readJson('reports/c.json'),
          'NXPKG_CONTAINER_INVALID',
          'invalid_json_file',
        );
        await expectError(
          pkg.readJson('reports/missing.json'),
          'NXPKG_CONTAINER_INVALID',
          'missing_file',
        );
      } finally {
        await pkg.close();
      }
    });

    it('a JSONL file without its final newline is refused at open', async () => {
      await expectError(
        build({ files: { 'records/a.jsonl': '{"a":1}\n{"a":2}' } }),
        'NXPKG_TAMPERED',
        'jsonl_not_newline_terminated',
      );
    });

    it('plaintext changed on disk after verification is detected on read', async () => {
      const pkg = await open(good.path);
      try {
        const dir = join(workDir, readdirSync(workDir)[0] as string);
        const zipPath = join(dir, 'payload.zip');
        const z = readFileSync(zipPath);
        // Flip a byte inside customers.jsonl's compressed data (its first local header).
        const at = z.indexOf('records/customers.jsonl') + 'records/customers.jsonl'.length + 40;
        writeFileSync(zipPath, flipByte(z, at));
        await expectError(collect(pkg, 'records/customers.jsonl'), 'NXPKG_TAMPERED');
      } finally {
        await pkg.close();
      }
    });
  });
});
