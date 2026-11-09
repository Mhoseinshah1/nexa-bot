/**
 * Phase 6B PR-4 (ADR-0039 § 8): every refusal of a server move — `botctl move export`,
 * `move import` and `move verify`. Operator-facing (the CLI prints them with a Persian line),
 * never shown to a customer. Crypto failures of a member reuse `backup.archive_auth_failed` /
 * `backup.archive_malformed`; a full disk reuses `backup.disk_insufficient`.
 */
export const MOVE_ERROR_CODES = {
  /** Not a move bundle this release reads: an unknown entry, no manifest, a bad manifest. */
  BUNDLE_MALFORMED: 'move.bundle_malformed',
  /** A member's bytes are not the ones the manifest names (SHA-256 or size). */
  MEMBER_CHECKSUM_MISMATCH: 'move.member_checksum_mismatch',
  /** The bundle's migration head is NEWER than this release: «اول نکسای مقصد را به‌روز کنید». */
  HEAD_NEWER: 'move.head_newer',
  /** Same migration index, other content: the two servers ran different code. */
  HEAD_DIVERGED: 'move.head_diverged',
  /** The new server already runs a business (a hosted tenant, a customer, an order, a wallet entry). */
  TARGET_NOT_FRESH: 'move.target_not_fresh',
  /** An export member (installation backup or hosted archive) did not reach a verified success. */
  MEMBER_FAILED: 'move.member_failed',
  /** The installation member's restore (the recovery executor) did not succeed. */
  INSTALLATION_RESTORE_FAILED: 'move.installation_restore_failed',
  /** A hosted member does not match its tenant in the restored installation (counts or digest). */
  HOSTED_MISMATCH: 'move.hosted_mismatch',
  /** A hosted member's tenant is not in the restored installation. */
  HOSTED_MISSING: 'move.hosted_missing',
  /** The bundle password is shorter than a backup password may be, or the two entries differ. */
  PASSWORD_REFUSED: 'move.password_refused',
} as const;
export type MoveErrorCode = (typeof MOVE_ERROR_CODES)[keyof typeof MOVE_ERROR_CODES];
