/**
 * The one error type the `.nxpkg` reader throws.
 *
 * Four codes, as `docs/legacy-migration/nxpkg-importer.md` §1 names them:
 *
 *   - `NXPKG_CONTAINER_INVALID` — not a package, a malformed public header, or an
 *     authenticated package whose content is structurally invalid (manifest, a record);
 *   - `NXPKG_WRONG_KEY` — the secret does not match the header's `key_check`, the wrong
 *     KIND of secret was given, or the key file text is malformed;
 *   - `NXPKG_TAMPERED` — any authentication or integrity failure after the key matched:
 *     a chunk tag, order, truncation, trailing bytes, the payload ZIP, a checksum;
 *   - `NXPKG_UNSUPPORTED_VERSION` — container major, header `format_version`,
 *     `package_schema_version` major or `payload_format` this reader does not know.
 *
 * `reason` is a short fixed token (never interpolated from input) so a test or an operator
 * can tell two TAMPERED causes apart. The message is a constant per code. Neither ever
 * carries key material, a passphrase, a file path inside the package or a record value;
 * that is why there is no `cause` and no free-text detail.
 */
export const NXPKG_ERROR_CODES = [
  'NXPKG_CONTAINER_INVALID',
  'NXPKG_WRONG_KEY',
  'NXPKG_TAMPERED',
  'NXPKG_UNSUPPORTED_VERSION',
] as const;

export type NxpkgErrorCode = (typeof NXPKG_ERROR_CODES)[number];

const MESSAGES: Readonly<Record<NxpkgErrorCode, string>> = {
  NXPKG_CONTAINER_INVALID: 'The file is not a valid NEXA migration package.',
  NXPKG_WRONG_KEY: 'The package key or passphrase is not correct for this package.',
  NXPKG_TAMPERED: 'The package failed authentication or integrity verification.',
  NXPKG_UNSUPPORTED_VERSION: 'This package version is not supported by this importer.',
};

export class NxpkgError extends Error {
  override readonly name = 'NxpkgError';
  readonly code: NxpkgErrorCode;
  readonly reason: string;

  constructor(code: NxpkgErrorCode, reason: string) {
    super(`${MESSAGES[code]} [${code}: ${reason}]`);
    this.code = code;
    this.reason = reason;
  }

  toJSON(): { name: string; code: NxpkgErrorCode; reason: string; message: string } {
    return { name: this.name, code: this.code, reason: this.reason, message: this.message };
  }
}

export const containerInvalid = (reason: string): NxpkgError =>
  new NxpkgError('NXPKG_CONTAINER_INVALID', reason);
export const wrongKey = (reason: string): NxpkgError => new NxpkgError('NXPKG_WRONG_KEY', reason);
export const tampered = (reason: string): NxpkgError => new NxpkgError('NXPKG_TAMPERED', reason);
export const unsupportedVersion = (reason: string): NxpkgError =>
  new NxpkgError('NXPKG_UNSUPPORTED_VERSION', reason);
