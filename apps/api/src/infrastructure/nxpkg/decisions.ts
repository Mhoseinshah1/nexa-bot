import { createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { b64dValidate, deriveAuxKey, type NxpkgHeaderInfo, type NxpkgSecret } from './crypto.js';
import { readNxpkgHeader } from './reader.js';

/**
 * Authentication of the converter's ownership-decisions export
 * (`ownership-decisions.json`, schema `m2n.ownership_decisions.v1`) — a port of
 * `sign_export` / `verify_export` / `decisions_key` in the converter's
 * `mirza2nexa/ownership_review.py` (its `docs/OWNERSHIP_REVIEW.md` §6).
 *
 *   key = HKDF-SHA256(package master secret, info = "nxpkg-v1/ownership-decisions")
 *   mac = HMAC-SHA256(key, canonical_json(doc without "authentication"))
 *   doc.authentication = {alg: "HMAC-SHA256", key: "<description>", mac: base64(mac)}
 *
 * This proves only that a holder of the package secret produced the document. What the
 * importer must check on top of it — `import_id`, `source_fingerprint`,
 * `package_header_sha256`, `sealed`, `matches_seal`, `audit.ok`, every entry's binding — is
 * the importer's job (`docs/legacy-migration/nxpkg-importer.md` §7), not this module's.
 */

export const HKDF_INFO_DECISIONS = Buffer.from('nxpkg-v1/ownership-decisions', 'ascii');
export const DECISIONS_AUTH_ALG = 'HMAC-SHA256';

/**
 * Python `decisions_key`: read the package header (or take one already read), verify the
 * secret against its `key_check` — a wrong secret throws `NXPKG_WRONG_KEY` — and derive the
 * export's MAC key. The returned buffer is secret: never log it, zero it when done.
 */
export async function deriveDecisionsKey(
  headerOrPath: string | NxpkgHeaderInfo,
  secret: NxpkgSecret,
): Promise<Buffer> {
  const info =
    typeof headerOrPath === 'string' ? await readNxpkgHeader(headerOrPath) : headerOrPath;
  return deriveAuxKey(info.header, HKDF_INFO_DECISIONS, secret);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bodyOf(doc: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (k !== 'authentication') body[k] = v;
  return body;
}

/** The MAC Python's `sign_export` computes, over the document minus `authentication`. */
export function decisionsMac(doc: Record<string, unknown>, key: Uint8Array): Buffer {
  return createHmac('sha256', key)
    .update(canonicalJson(bodyOf(doc)))
    .digest();
}

/**
 * Python `verify_export`. False — never a throw — for anything that does not verify: a
 * missing or malformed `authentication`, another algorithm, a MAC that is not valid
 * base64, a document canonical JSON cannot encode (a float, say), or a wrong MAC.
 */
export function verifyDecisionsExport(doc: unknown, key: Uint8Array): boolean {
  if (!isPlainObject(doc)) return false;
  const auth = doc['authentication'];
  if (!isPlainObject(auth)) return false;
  if (auth['alg'] !== DECISIONS_AUTH_ALG || typeof auth['mac'] !== 'string') return false;
  const mac = b64dValidate(auth['mac']);
  if (mac === null) return false;
  let expected: Buffer;
  try {
    expected = decisionsMac(doc, key);
  } catch {
    return false;
  }
  return mac.length === expected.length && timingSafeEqual(mac, expected);
}
