/**
 * Decrypt-only keys an installation still holds from a Recovery Kit it imported
 * before the kit was removed (SFR A1, owner decision 2026-11-08: backups are
 * self-contained, so a restore needs only the backup file and its password).
 *
 * Nothing imports a key any more. The rows stay, read-only, for one reason: an
 * installation that restored another server's backup with a kit BEFORE v0.9.10
 * (when a restore did not yet re-encrypt every secret under the active key) can
 * still hold live bot tokens and credentials sealed under such a key. Dropping
 * them would make those unreadable. `botctl secrets rewrap` moves every secret
 * onto the active key; a later release drops the table.
 */

/** Where a stored key came from. A closed set pinned by a CHECK constraint. */
export const INSTALLATION_KEY_SOURCES = ['RECOVERY_KIT'] as const;
export type InstallationKeySource = (typeof INSTALLATION_KEY_SOURCES)[number];
