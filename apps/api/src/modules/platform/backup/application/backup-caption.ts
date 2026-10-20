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

/** Mebibytes, one decimal, for a person reading the group: `42.3 مگ`. Never money. */
export function mebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگ`;
}

/** What one part of a backup is captioned with (E4). Its OWN SHA-256 travels with it. */
export function backupPartCaption(input: {
  readonly id: string;
  readonly takenAt: string;
  readonly partNumber: number;
  readonly partCount: number;
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sevenZip: boolean;
  readonly totalBytes: number;
  readonly dumpChecksum: string;
  readonly restoreCommand: string;
  /** What the verification restored, and against which server (single part only). */
  readonly tableCount: number;
  readonly postgresVersion: string;
  /** The headline instead of «بکاپ» (E1's «آرشیو ربات قبلی»). */
  readonly title?: string;
}): string {
  const title = input.title ?? 'بکاپ';
  if (input.partCount === 1) {
    // One file: the caption IS the summary (L31), so no second message is posted.
    return [
      `💾 ${title} — ${input.takenAt}`,
      `📦 ${input.filename} · ${mebibytes(input.bytes)}`,
      '✅ رمزگذاری و بازیابی آزمایشی موفق',
      ...(input.sevenZip ? ['🔐 با 7-Zip و رمز بکاپ باز می‌شود.'] : []),
      '',
      `Backup: ${input.id}`,
      `PostgreSQL ${input.postgresVersion}; verified: restored into an empty database, ${String(input.tableCount)} tables`,
      `SHA-256 (file): ${input.sha256}`,
      `SHA-256 (dump): ${input.dumpChecksum}`,
      `Restore: ${input.restoreCommand}`,
    ].join('\n');
  }
  return [
    `💾 ${title} — ${input.takenAt} — بخش ${String(input.partNumber)} از ${String(input.partCount)}`,
    `📦 ${input.filename} · ${mebibytes(input.bytes)}`,
    '',
    `Backup: ${input.id}`,
    `Part: ${String(input.partNumber)}/${String(input.partCount)}`,
    `SHA-256: ${input.sha256}`,
  ].join('\n');
}

/** The ceiling the summary is kept under: Telegram's message limit is 4096 characters. */
const SUMMARY_MAX_CHARS = 3800;

/**
 * The ONE summary message after every part of a split archive arrived (E4): date, total
 * size, part count, SHA-256 per part, and how to restore — the owner's sentence, word for
 * word, and the `botctl` command. Above the message ceiling the per-part digests are left
 * to each part's own caption (where they always are) and the summary says so.
 */
export function backupSummaryMessage(input: {
  readonly id: string;
  readonly takenAt: string;
  readonly totalBytes: number;
  readonly parts: readonly { readonly filename: string; readonly sha256: string }[];
  readonly sevenZip: boolean;
  readonly dumpChecksum: string;
  readonly restoreInstruction: string;
  readonly restoreCommand: string;
  readonly title?: string;
}): string {
  const head = [
    `💾 ${input.title ?? 'بکاپ'} — ${input.takenAt}`,
    `📦 حجم کل: ${mebibytes(input.totalBytes)} · ${String(input.parts.length)} بخش`,
    '✅ رمزگذاری و بازیابی آزمایشی موفق',
    '',
  ];
  const restore = [
    '',
    `♻️ بازیابی: ${input.sevenZip ? input.restoreInstruction : 'همهٔ بخش‌ها را به ترتیب پشت هم بچسبانید (cat) تا فایل ‎.nxb ساخته شود.'}`,
    `botctl: ${input.restoreCommand}`,
    '',
    `Backup: ${input.id}`,
    `SHA-256 (dump): ${input.dumpChecksum}`,
  ];
  const lines = input.parts.map((part) => `${part.filename}\n${part.sha256}`);
  const full = [...head, 'SHA-256 هر بخش:', ...lines, ...restore].join('\n');
  if (full.length <= SUMMARY_MAX_CHARS) return full;
  return [...head, 'SHA-256 هر بخش در کپشن همان بخش آمده است.', ...restore].join('\n');
}
