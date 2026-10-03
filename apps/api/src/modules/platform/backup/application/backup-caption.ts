import { BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES, type BackupManifest } from '@nexa/contracts';

/**
 * What the operations group is told about a backup.
 *
 * Identity, time, size, the checksum that makes the artifact verifiable, and the
 * verification result. No token, no connection string, no database URL, no key id — the
 * key id names a KEK an operator holds and would be a hint nobody needs in a chat, and the
 * checksum is a digest, which is not one.
 *
 * A Persian headline for the people reading the group (spec §1.1), then the technical
 * lines exactly as Backup V1 wrote them, left-to-right and machine-readable, because an
 * operator matching an archive to a run compares ids and digests, not prose. Well inside
 * Telegram's 1024-character caption ceiling.
 */
export function backupCaption(input: {
  readonly id: string;
  readonly manifest: BackupManifest;
  readonly archiveBytes: number;
  readonly tableCount: number;
}): string {
  return [
    '💾 بکاپ رمزنگاری‌شدهٔ Nexa — بازیابی آزمایشی آن موفق بود.',
    '',
    'NEXA BACKUP',
    `Backup: ${input.id}`,
    `Taken: ${input.manifest.createdAt}`,
    `Database: ${input.manifest.databaseName} (PostgreSQL ${input.manifest.postgresVersion})`,
    `Dump: ${String(input.manifest.dumpBytes)} bytes`,
    `Archive: ${String(input.archiveBytes)} bytes`,
    `SHA-256: ${input.manifest.checksum}`,
    `Verified: restored into an empty database, ${String(input.tableCount)} tables`,
  ].join('\n');
}

/**
 * The notice posted INSTEAD of a document that is above Telegram's bot ceiling.
 *
 * ADR-0011's third compensating control, and spec §13.1: the archive stays on the
 * server, the topic is told so in a sentence nobody can read as "delivered", and where it
 * is. Never a truncated document, never silence.
 */
export function backupRetainedNotice(input: {
  readonly caption: string;
  readonly retainedHint: string;
  readonly archiveBytes: number;
}): string {
  const limitMiB = Math.floor(BACKUP_TELEGRAM_DOCUMENT_MAX_BYTES / (1024 * 1024));
  return [
    `⚠️ فایل این بکاپ (${String(input.archiveBytes)} بایت) از سقف ارسال فایل ربات تلگرام ` +
      `(${String(limitMiB)} مگابایت) بزرگ‌تر است؛ فایل ارسال نشد و فقط روی سرور نگه داشته شد.`,
    '',
    input.caption,
    '',
    `RETAINED: ${input.retainedHint}`,
    'The archive is larger than Telegram accepts from a bot, so it stays on the server.',
  ].join('\n');
}
