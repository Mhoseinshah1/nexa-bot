import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NxpkgError,
  deriveDecisionsKey,
  parseStrictJson,
  readNxpkgHeader,
  verifyDecisionsExport,
} from '../../apps/api/src/infrastructure/nxpkg';
import { newRawKey, signDecisionsExport, writeNxpkg } from '../support/nxpkg/writer';

/**
 * The ownership-decisions export: key derivation (HKDF info `nxpkg-v1/ownership-decisions`,
 * secret verified against `key_check` first) and the HMAC over canonical JSON, against a
 * document the PYTHON converter sealed and signed (`tests/fixtures/nxpkg`, synthetic).
 */
const FIXTURES = join(__dirname, '../fixtures/nxpkg');
const PKG = join(FIXTURES, 'synthetic-keyfile.nxpkg');
const PP_PKG = join(FIXTURES, 'synthetic-passphrase.nxpkg');
const KEY_FILE_TEXT = readFileSync(join(FIXTURES, 'synthetic-keyfile.nxkey'), 'utf8');
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  passphrase: string;
  decisions_key_hex: string;
  passphrase_decisions_key_hex: string;
  keyfile: { header_sha256: string; import_id: string; source_fingerprint: string };
  decisions_summary: Record<string, number>;
};
const doc = (): Record<string, unknown> =>
  parseStrictJson(readFileSync(join(FIXTURES, 'ownership-decisions.json'))) as Record<
    string,
    unknown
  >;

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nxpkg-decisions-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('ownership-decisions export written by the Python converter', () => {
  it('derives the same key from the package path and from a header already read', async () => {
    const fromPath = await deriveDecisionsKey(PKG, { keyFileText: KEY_FILE_TEXT });
    expect(fromPath.toString('hex')).toBe(expected.decisions_key_hex);
    const fromHeader = await deriveDecisionsKey(await readNxpkgHeader(PKG), {
      keyFileText: KEY_FILE_TEXT,
    });
    expect(fromHeader.equals(fromPath)).toBe(true);
    const pp = await deriveDecisionsKey(PP_PKG, { passphrase: expected.passphrase });
    expect(pp.toString('hex')).toBe(expected.passphrase_decisions_key_hex);
  });

  it('verifies the Python signature, and the document is bound to this package', async () => {
    const key = await deriveDecisionsKey(PKG, { keyFileText: KEY_FILE_TEXT });
    const d = doc();
    expect(verifyDecisionsExport(d, key)).toBe(true);
    expect(d['schema']).toBe('m2n.ownership_decisions.v1');
    expect(d['package_header_sha256']).toBe(expected.keyfile.header_sha256);
    expect(d['import_id']).toBe(expected.keyfile.import_id);
    expect(d['source_fingerprint']).toBe(expected.keyfile.source_fingerprint);
    expect(d['sealed']).toBe(true);
    expect(d['matches_seal']).toBe(true);
    expect((d['audit'] as { ok: boolean }).ok).toBe(true);
    expect(d['admin_attestation_is_proof']).toBe(false);
    expect(d['summary']).toEqual(expected.decisions_summary);
  });

  it('any change to the document, or another key, fails verification', async () => {
    const key = await deriveDecisionsKey(PKG, { keyFileText: KEY_FILE_TEXT });
    const entries = (d: Record<string, unknown>) => d['entries'] as Record<string, unknown>[];

    const promoted = doc();
    const e0 = entries(promoted)[0] as Record<string, unknown>;
    e0['class'] = e0['class'] === 'PROVEN' ? 'PENDING' : 'PROVEN';
    expect(verifyDecisionsExport(promoted, key)).toBe(false);

    const reheaded = { ...doc(), package_header_sha256: '0'.repeat(64) };
    expect(verifyDecisionsExport(reheaded, key)).toBe(false);

    const added = { ...doc(), note: 'x' };
    expect(verifyDecisionsExport(added, key)).toBe(false);

    const otherKey = Buffer.from(key);
    otherKey[0] = (otherKey[0] as number) ^ 1;
    expect(verifyDecisionsExport(doc(), otherKey)).toBe(false);
  });

  it('a missing or malformed authentication block never verifies, never throws', async () => {
    const key = await deriveDecisionsKey(PKG, { keyFileText: KEY_FILE_TEXT });
    const auth = doc()['authentication'] as Record<string, unknown>;
    const withAuth = (a: unknown) => ({ ...doc(), authentication: a });
    for (const bad of [
      undefined,
      null,
      [],
      'x',
      { ...auth, alg: 'HMAC-SHA512' },
      { ...auth, mac: 42 },
      { ...auth, mac: `${auth['mac'] as string}=` },
      { ...auth, mac: (auth['mac'] as string).slice(0, -4) },
      { ...auth, mac: '!!!!' },
    ]) {
      expect(verifyDecisionsExport(withAuth(bad), key)).toBe(false);
    }
    expect(verifyDecisionsExport(null, key)).toBe(false);
    expect(verifyDecisionsExport([doc()], key)).toBe(false);
    // A value canonical JSON cannot encode (Python would raise) is a refusal, not a crash.
    expect(verifyDecisionsExport({ ...doc(), x: 1.5 }, key)).toBe(false);
  });

  it('a wrong secret is refused before any key is derived', async () => {
    const other = newRawKey();
    let err: unknown;
    try {
      await deriveDecisionsKey(PKG, { keyFileText: other.keyFileText });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NxpkgError);
    expect((err as NxpkgError).code).toBe('NXPKG_WRONG_KEY');
    const view = inspect(err, { showHidden: true, depth: 10 }) + JSON.stringify(err);
    expect(view.includes(other.keyFileText)).toBe(false);
    expect(view.includes(other.rawKey.toString('hex'))).toBe(false);

    await expect(
      deriveDecisionsKey(PP_PKG, { passphrase: 'not-the-passphrase' }),
    ).rejects.toMatchObject({ code: 'NXPKG_WRONG_KEY', reason: 'key_check_mismatch' });
    await expect(
      deriveDecisionsKey(PKG, { passphrase: expected.passphrase }),
    ).rejects.toMatchObject({
      code: 'NXPKG_WRONG_KEY',
      reason: 'key_file_required',
    });
  });
});

describe('the TS test signer agrees with the verifier', () => {
  it('signs a document for a TS-written package', async () => {
    const k = newRawKey();
    const w = await writeNxpkg(join(root, 'p.nxpkg'), {
      files: { 'records/a.jsonl': '{"a":1}\n' },
      secret: { rawKey: k.rawKey },
    });
    const key = await deriveDecisionsKey(w.path, { keyFileText: k.keyFileText });
    const signed = signDecisionsExport(
      { schema: 'm2n.ownership_decisions.v1', package_header_sha256: w.headerSha256, entries: [] },
      key,
    );
    expect(verifyDecisionsExport(signed, key)).toBe(true);
    // Re-signing an already signed document ignores the old block, as Python's does.
    expect(signDecisionsExport(signed, key)).toEqual(signed);
    // The key is not the package's encryption key nor its key check: a different HKDF info.
    expect(key.equals(k.rawKey)).toBe(false);
  });
});
