/**
 * Every refusal of the tenant archive, export and restore. Crypto failures reuse
 * `backup.archive_auth_failed` / `backup.archive_malformed` (one answer for a wrong password
 * and a damaged byte).
 */
export const TENANT_ARCHIVE_ERROR_CODES = {
  /** The archive's migration head is NEWER than this install: «اول نکسای مقصد را به‌روز کنید». */
  HEAD_NEWER: 'tenant_archive.head_newer',
  /** Same migration index, other content: the two installs ran different code. */
  HEAD_DIVERGED: 'tenant_archive.head_diverged',
  /** The tenant id is already on this server. Never a merge. */
  TENANT_EXISTS: 'tenant_archive.tenant_exists',
  /** The archive's bot (username or Telegram id) belongs to another tenant here. */
  BOT_TAKEN: 'tenant_archive.bot_taken',
  /** The archive's domain is another hosted bot's here. */
  DOMAIN_TAKEN: 'tenant_archive.domain_taken',
  /** A globally unique key of the archive's rows is held by another tenant here. */
  UNIQUE_COLLISION: 'tenant_archive.unique_collision',
  /** The archive did not restore into scratch with the counts and checksums it claims. */
  VERIFICATION_FAILED: 'tenant_archive.verification_failed',
  /** A tenant with children is not archived (a subtree archive is a separate decision). */
  HAS_CHILD_TENANTS: 'tenant_archive.has_child_tenants',
  /** Only a HOSTED tenant is archived. */
  NOT_HOSTED: 'tenant_archive.not_hosted',
  /** A PURGED tenant is closed for good: not archived, not replaced. */
  PURGED: 'tenant_archive.purged',
  /** Replace needs the tenant rewrite allowance (ADR-0039 § 10), not built. */
  REPLACE_UNAVAILABLE: 'tenant_archive.replace_unavailable',
  /** A live table this release does not classify. */
  UNCLASSIFIED_TABLE: 'tenant_archive.unclassified_table',
  /** The export's connection bypasses row-level security. */
  RLS_BYPASSED: 'tenant_archive.rls_bypassed',
  /** Phase 6B PR-2: the owner withdrew a verified dry run («لغو») before confirming it. */
  RESTORE_CANCELLED: 'tenant_archive.restore_cancelled',
  /**
   * Phase 6B PR-2: a verified dry run nobody confirmed within a day; it held the installation's
   * one restore slot, so it is released (the upload is removed with it).
   */
  DRY_RUN_EXPIRED: 'tenant_archive.dry_run_expired',
} as const;
export type TenantArchiveErrorCode =
  (typeof TENANT_ARCHIVE_ERROR_CODES)[keyof typeof TENANT_ARCHIVE_ERROR_CODES];
