/**
 * `.nxpkg` — the Mirza2Nexa converter's encrypted migration package, read strictly.
 * See `reader.ts` for what `openNxpkg` verifies and `errors.ts` for the error codes.
 */
export {
  canonicalJson,
  canonicalJsonString,
  compareCodePoints,
  parseStrictJson,
} from './canonical-json.js';
export {
  encodeKeyFile,
  normalizePassphrase,
  parseKeyFile,
  type NxpkgHeader,
  type NxpkgHeaderInfo,
  type NxpkgKdf,
  type NxpkgSecret,
} from './crypto.js';
export {
  DECISIONS_AUTH_ALG,
  HKDF_INFO_DECISIONS,
  decisionsMac,
  deriveDecisionsKey,
  verifyDecisionsExport,
} from './decisions.js';
export { NXPKG_ERROR_CODES, NxpkgError, type NxpkgErrorCode } from './errors.js';
export {
  CHECKSUMS_NAME,
  MANIFEST_NAME,
  PACKAGE_SCHEMA,
  PAYLOAD_FORMAT,
  compareSemverCore,
  isSafeRelpath,
  type NxpkgFileEntry,
  type NxpkgManifest,
} from './manifest.js';
export {
  MAX_META_JSON,
  openNxpkg,
  readNxpkgHeader,
  type NxpkgFileInfo,
  type NxpkgOpenOptions,
  type NxpkgPackage,
} from './reader.js';
