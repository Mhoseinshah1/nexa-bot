import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson, parseStrictJson } from '../../../../infrastructure/nxpkg/canonical-json.js';
import {
  deriveAuxKey,
  type NxpkgHeader,
  type NxpkgSecret,
} from '../../../../infrastructure/nxpkg/crypto.js';
import {
  HKDF_INFO_DECISIONS,
  verifyDecisionsExport,
} from '../../../../infrastructure/nxpkg/decisions.js';
import { NxpkgImportRefused } from '../application/nxpkg-panel-binding.js';
import {
  NXPKG_OWNERSHIP_BASIS,
  NXPKG_OWNERSHIP_CLASSES,
  type NxpkgOwnershipClass,
  type NxpkgOwnershipEntry,
  type NxpkgOwnershipRecordFacts,
  type VerifiedOwnershipDecisions,
} from '../application/nxpkg-ownership.js';

/**
 * Mirza `.nxpkg` importer — verification of the converter's `ownership-decisions.json`
 * (`docs/legacy-migration/nxpkg-importer.md` §7; converter `NEXA_IMPORTER_DESIGN.md` §8.1,
 * `OWNERSHIP_REVIEW.md` §6).
 *
 * Refused (`DECISIONS_INVALID`, one fixed sentence each, no value) unless ALL hold:
 *
 * 1. strict JSON, `schema == m2n.ownership_decisions.v1`, no field outside the export's;
 * 2. the HMAC verifies under `HKDF-SHA256(package master key, "nxpkg-v1/ownership-decisions")`
 *    — the package secret is checked against the header's `key_check` first;
 * 3. `import_id`, `source_fingerprint` equal the manifest's, `package_header_sha256` equals
 *    the SHA-256 of THIS package's header bytes;
 * 4. `sealed`, `matches_seal`, `audit.ok` are true, `sealed_divergence` is 0,
 *    `admin_attestation_is_proof` is false, and `entries_digest` is both the SHA-256 of the
 *    canonical entries and the `sealed_digest`;
 * 5. every entry has exactly the export's fields, a known class with ITS basis, a unique key,
 *    and the summary's counts are the entries' counts;
 * 6. entries and `records/service_ownership.jsonl` are the same set of keys, and each entry's
 *    `binding` is `sha256(canonical_json(record))` of its record (the decision was made on
 *    this very record) with the same `invoice_key`.
 *
 * The verified document is evidence only: `application/nxpkg-ownership.ts` decides what it
 * may hold back from adoption, and nothing here recomputes a class.
 */

export const OWNERSHIP_DECISIONS_SCHEMA = 'm2n.ownership_decisions.v1';
export const NXPKG_OWNERSHIP_RECORDS_PATH = 'records/service_ownership.jsonl';

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'review_version',
  'import_id',
  'source_fingerprint',
  'package_header_sha256',
  'sealed',
  'sealed_at',
  'sealed_digest',
  'entries_digest',
  'matches_seal',
  'sealed_divergence',
  'audit',
  'summary',
  'admin_attestation_is_proof',
  'rules',
  'entries',
  'authentication',
]);
const ENTRY_KEYS = [
  'basis',
  'batch_id',
  'binding',
  'class',
  'invoice_key',
  'key',
  'review_state',
  'stale',
];
const REVIEW_STATES: ReadonlySet<string> = new Set([
  'PENDING',
  'ADMIN_APPROVED_UNVERIFIED',
  'REJECTED',
]);
const SHA256 = /^[0-9a-f]{64}$/u;

/** What verification reads of an opened package. `NxpkgPackage` is one. */
export interface NxpkgDecisionsTarget {
  readonly header: NxpkgHeader;
  readonly headerSha256: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  has(rel: string): boolean;
  iterJsonl(rel: string): AsyncIterable<Record<string, unknown>>;
}

const refuse = (problem: string): NxpkgImportRefused =>
  new NxpkgImportRefused('DECISIONS_INVALID', [problem]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The ownership records' facts the hold needs, and their bindings, streamed once. */
export async function readOwnershipRecords(
  pkg: Pick<NxpkgDecisionsTarget, 'has' | 'iterJsonl'>,
): Promise<{
  readonly facts: readonly NxpkgOwnershipRecordFacts[];
  readonly bindings: ReadonlyMap<
    string,
    { readonly binding: string; readonly invoiceKey: string | null }
  >;
}> {
  const facts: NxpkgOwnershipRecordFacts[] = [];
  const bindings = new Map<string, { binding: string; invoiceKey: string | null }>();
  if (!pkg.has(NXPKG_OWNERSHIP_RECORDS_PATH)) return { facts, bindings };
  for await (const record of pkg.iterJsonl(NXPKG_OWNERSHIP_RECORDS_PATH)) {
    const key = record['idempotency_key'];
    const invoiceKey = record['invoice_key'];
    const decision = record['ownership_decision'];
    const finalOwner = record['final_owner_telegram_user_id'];
    if (
      record['record_type'] !== 'legacy_service_ownership' ||
      typeof key !== 'string' ||
      key === '' ||
      !(invoiceKey === null || typeof invoiceKey === 'string') ||
      !(decision === null || typeof decision === 'string') ||
      !(finalOwner === null || typeof finalOwner === 'string')
    ) {
      throw new NxpkgImportRefused('NXPKG_CONTAINER_INVALID', [
        'a service ownership record is malformed',
      ]);
    }
    if (bindings.has(key)) {
      throw new NxpkgImportRefused('NXPKG_CONTAINER_INVALID', [
        'two service ownership records share one key',
      ]);
    }
    bindings.set(key, { binding: sha256Hex(canonicalJson(record)), invoiceKey });
    facts.push({ key, invoiceKey, decision, finalOwner });
  }
  return { facts, bindings };
}

export async function verifyOwnershipDecisions(
  docBytes: Uint8Array | string,
  pkg: NxpkgDecisionsTarget,
  packageSecret: NxpkgSecret,
): Promise<VerifiedOwnershipDecisions> {
  let doc: unknown;
  try {
    doc = parseStrictJson(docBytes);
  } catch {
    throw refuse('the ownership decisions file is not strict JSON');
  }
  if (!isObject(doc) || doc['schema'] !== OWNERSHIP_DECISIONS_SCHEMA) {
    throw refuse('the file is not an m2n.ownership_decisions.v1 export');
  }
  if (Object.keys(doc).some((k) => !TOP_LEVEL_KEYS.has(k))) {
    throw refuse('the export carries a field the converter never writes');
  }

  // 2. Authenticity, before anything in it is believed.
  const key = await deriveAuxKey(pkg.header, HKDF_INFO_DECISIONS, packageSecret);
  try {
    if (!verifyDecisionsExport(doc, key)) {
      throw refuse('the export is unsigned, or its HMAC does not verify under this package key');
    }
  } finally {
    key.fill(0);
  }

  // 3. Bound to this package.
  if (doc['import_id'] !== pkg.manifest['import_id']) {
    throw refuse('the export was made for another import (import_id)');
  }
  if (doc['source_fingerprint'] !== pkg.manifest['source_fingerprint']) {
    throw refuse('the export was made for another source (source_fingerprint)');
  }
  const headerSha = doc['package_header_sha256'];
  if (
    typeof headerSha !== 'string' ||
    !SHA256.test(headerSha) ||
    !sameHex(headerSha, pkg.headerSha256)
  ) {
    throw refuse('the export was made for another package (package_header_sha256)');
  }

  // 4. Sealed, unchanged since, and its audit chain intact.
  if (doc['sealed'] !== true) throw refuse('the decisions are not sealed');
  if (doc['matches_seal'] !== true) throw refuse('the decisions changed after they were sealed');
  if (doc['sealed_divergence'] !== 0) {
    throw refuse('the package records changed after the decisions were sealed');
  }
  const audit = doc['audit'];
  if (!isObject(audit) || audit['ok'] !== true)
    throw refuse('the review audit chain does not verify');
  if (doc['admin_attestation_is_proof'] !== false) {
    throw refuse('the export claims an admin attestation is proof of ownership');
  }
  const entries = doc['entries'];
  if (!Array.isArray(entries)) throw refuse('the export has no entries');
  const digest = sha256Hex(canonicalJson(entries));
  if (doc['entries_digest'] !== digest || doc['sealed_digest'] !== digest) {
    throw refuse('the entries are not the sealed entries');
  }

  // 5. Every entry well-formed; the summary is the entries'.
  const byKey = new Map<string, NxpkgOwnershipEntry>();
  const counts: Record<NxpkgOwnershipClass, number> = {
    PROVEN: 0,
    ADMIN_APPROVED_UNVERIFIED: 0,
    PENDING: 0,
    REJECTED: 0,
    QUARANTINED: 0,
  };
  let stale = 0;
  const bindingOf = new Map<string, string>();
  for (const raw of entries) {
    if (!isObject(raw)) throw refuse('an entry is not an object');
    const keys = Object.keys(raw).sort();
    if (keys.length !== ENTRY_KEYS.length || keys.some((k, i) => k !== ENTRY_KEYS[i])) {
      throw refuse('an entry has an unexpected set of fields');
    }
    const cls = raw['class'];
    if (!(NXPKG_OWNERSHIP_CLASSES as readonly unknown[]).includes(cls)) {
      throw refuse('an entry has an unknown class');
    }
    const klass = cls as NxpkgOwnershipClass;
    if (raw['basis'] !== NXPKG_OWNERSHIP_BASIS[klass])
      throw refuse("an entry's basis is not its class's");
    const entryKey = raw['key'];
    const invoiceKey = raw['invoice_key'];
    const batch = raw['batch_id'];
    const binding = raw['binding'];
    if (
      typeof entryKey !== 'string' ||
      entryKey === '' ||
      !(invoiceKey === null || typeof invoiceKey === 'string') ||
      !(batch === null || typeof batch === 'string') ||
      typeof binding !== 'string' ||
      !SHA256.test(binding) ||
      typeof raw['stale'] !== 'boolean' ||
      typeof raw['review_state'] !== 'string' ||
      !REVIEW_STATES.has(raw['review_state'])
    ) {
      throw refuse('an entry is malformed');
    }
    if (byKey.has(entryKey)) throw refuse('two entries share one key');
    counts[klass] += 1;
    if (raw['stale']) stale += 1;
    byKey.set(entryKey, {
      key: entryKey,
      invoiceKey,
      class: klass,
      basis: raw['basis'],
      batchId: batch,
      stale: raw['stale'],
    });
    bindingOf.set(entryKey, binding);
  }
  const summary = doc['summary'];
  if (
    !isObject(summary) ||
    summary['items'] !== entries.length ||
    NXPKG_OWNERSHIP_CLASSES.some((c) => summary[c] !== counts[c])
  ) {
    throw refuse("the summary is not the entries' counts");
  }

  // 6. Bound to the package's own ownership records, one for one.
  const { bindings } = await readOwnershipRecords(pkg);
  if (bindings.size !== byKey.size) {
    throw refuse('the entries and the package ownership records are not the same set');
  }
  for (const [entryKey, entry] of byKey) {
    const record = bindings.get(entryKey);
    if (record === undefined) throw refuse('an entry names a record the package does not hold');
    if (
      !sameHex(record.binding, bindingOf.get(entryKey) ?? '') ||
      record.invoiceKey !== entry.invoiceKey
    ) {
      throw refuse('an entry was decided on another record than the package holds (binding)');
    }
  }

  return {
    summary: { items: entries.length, ...counts, stale },
    entriesDigest: digest,
    auditHead: typeof audit['head'] === 'string' ? audit['head'] : null,
    entries: byKey,
  };
}
