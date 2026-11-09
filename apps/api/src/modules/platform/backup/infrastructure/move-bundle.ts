import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { MOVE_ERROR_CODES, NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import {
  extractSevenZipEntry,
  listSevenZipEntries,
  sealSevenZipEntries,
  type SevenZipOptions,
} from './seven-zip.js';

/**
 * Phase 6B PR-4 (ADR-0039 § 8): the server-move bundle — its format, its seal and its open.
 *
 * `nexa-move.7z` is ONE 7z, AES-256 with encrypted headers, sealed with the bundle password:
 *
 * ```
 * move-manifest.json          format "nexa.move-bundle", formatVersion 1
 * checklist.fa.txt            the steps on the new server, filled in
 * installation/<file>.7z      a fresh, VERIFIED installation backup (trigger MOVE)
 * hosted/<tenantId>.7z        a fresh, VERIFIED tenant archive of every non-PURGED hosted bot
 * ```
 *
 * Every member is itself sealed with the SAME bundle password (its own key bundle wrapped by
 * it), so the bundle needs one secret and carries no list of passwords. The manifest names
 * every member with its kind, tenant, size and SHA-256; the open refuses any entry the format
 * never writes, any member the manifest does not name, and any member whose bytes differ.
 * `/etc/nexa/nexa.env` never travels: the manifest names the secret keys the old server had
 * set, never their values.
 */

export const MOVE_BUNDLE_FORMAT = 'nexa.move-bundle';
export const MOVE_BUNDLE_FORMAT_VERSION = 1;
export const MOVE_MANIFEST_ENTRY = 'move-manifest.json';
export const MOVE_CHECKLIST_ENTRY = 'checklist.fa.txt';
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
const CHECKLIST_MAX_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALLATION_MEMBER = /^installation\/nexa-backup-[0-9]{8}-[0-9]{4}-[0-9a-f]{8}\.7z$/;
const HOSTED_MEMBER = /^hosted\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.7z$/;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;

/**
 * The non-secret configuration the bundle carries by VALUE: what the operator types again on
 * the new server, so it is recorded to be compared, never applied by anything.
 */
export const MOVE_ENVIRONMENT_VALUES = [
  'WEB_ADMIN_ORIGINS',
  'HOSTED_BOTS_CNAME_TARGET',
  'HOSTED_BOTS_SERVER_IPS',
  'TELEGRAM_WEBHOOK_ENABLED',
  'BACKUP_SCHEDULE_ENABLED',
  'BACKUP_DAILY_TIME',
  'BACKUP_TELEGRAM_CHAT_ID',
  'BACKUP_OFFSITE_ENDPOINT',
  'BACKUP_OFFSITE_REGION',
  'BACKUP_OFFSITE_BUCKET',
  'BACKUP_OFFSITE_PREFIX',
] as const;

/**
 * The secrets the operator RE-ENTERS on the new server, carried by NAME only (when the old one
 * had them set). Never the keyring (`SECRETS_*`: the new server makes its own and the members'
 * key bundles carry what their secrets need), never the webhook secret (re-registered).
 */
export const MOVE_ENVIRONMENT_SECRET_NAMES = [
  'BACKUP_TELEGRAM_BOT_TOKEN',
  'BACKUP_OFFSITE_ACCESS_KEY_ID',
  'BACKUP_OFFSITE_SECRET_ACCESS_KEY',
] as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const uuidSchema = z.string().regex(UUID);

export const moveBundleManifestSchema = z
  .object({
    format: z.literal(MOVE_BUNDLE_FORMAT),
    formatVersion: z.literal(MOVE_BUNDLE_FORMAT_VERSION),
    createdAt: z.string().datetime(),
    source: z
      .object({
        installationId: uuidSchema,
        release: z.string().min(1).max(200),
        image: z.string().max(400).nullable(),
      })
      .strict(),
    migrations: z
      .object({
        count: z.number().int().positive(),
        lastTag: z.string().min(1).max(200),
        lastHash: z.string().min(1).max(200),
        lastWhen: z.number().int(),
      })
      .strict(),
    members: z
      .array(
        z
          .object({
            path: z.string().max(200),
            kind: z.enum(['INSTALLATION', 'HOSTED']),
            tenantId: uuidSchema,
            runId: uuidSchema,
            bytes: z.number().int().positive(),
            sha256: sha256Schema,
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
    domains: z
      .object({
        owner: z.array(z.string().regex(HOSTNAME)).max(50),
        cnameTarget: z.string().regex(HOSTNAME).nullable(),
        serverIps: z.array(z.string().max(64)).max(50),
      })
      .strict(),
    bots: z
      .array(
        z
          .object({
            tenantId: uuidSchema,
            kind: z.enum(['INSTALLATION', 'HOSTED']),
            username: z.string().max(64).nullable(),
            telegramBotId: z
              .string()
              .regex(/^[0-9]{1,20}$/)
              .nullable(),
            domain: z.string().regex(HOSTNAME).nullable(),
            state: z.string().max(40).nullable(),
          })
          .strict(),
      )
      .max(10_000),
    environment: z
      .object({
        values: z.partialRecord(z.enum(MOVE_ENVIRONMENT_VALUES), z.string().max(4096)),
        secretNames: z.array(z.enum(MOVE_ENVIRONMENT_SECRET_NAMES)).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const installation = manifest.members.filter((member) => member.kind === 'INSTALLATION');
    if (installation.length !== 1 || !INSTALLATION_MEMBER.test(installation[0]?.path ?? '')) {
      ctx.addIssue({ code: 'custom', message: 'exactly one installation member' });
    }
    const seen = new Set<string>();
    for (const member of manifest.members) {
      if (seen.has(member.path)) ctx.addIssue({ code: 'custom', message: 'a member twice' });
      seen.add(member.path);
      if (member.kind === 'HOSTED' && member.path !== `hosted/${member.tenantId}.7z`) {
        ctx.addIssue({ code: 'custom', message: 'a hosted member not named by its tenant' });
      }
    }
  });
export type MoveBundleManifest = z.infer<typeof moveBundleManifestSchema>;
export type MoveBundleMember = MoveBundleManifest['members'][number];
export type MoveBundleBot = MoveBundleManifest['bots'][number];

function malformed(detail: string): NexaError {
  return new NexaError({
    kind: 'VALIDATION',
    code: MOVE_ERROR_CODES.BUNDLE_MALFORMED,
    message: `This is not a move bundle this release reads: ${detail}`,
  });
}

export async function sha256OfFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/** Whether an entry name is one the format writes. */
export function isMoveBundleEntry(entry: string): boolean {
  return (
    entry === MOVE_MANIFEST_ENTRY ||
    entry === MOVE_CHECKLIST_ENTRY ||
    entry === 'installation' ||
    entry === 'hosted' ||
    INSTALLATION_MEMBER.test(entry) ||
    HOSTED_MEMBER.test(entry)
  );
}

/**
 * Seals `directory` (manifest, checklist, `installation/`, `hosted/`) into `bundlePath` with
 * the bundle password, through the archiver's memory-bounded 7-Zip.
 */
export async function sealMoveBundle(input: {
  readonly directory: string;
  readonly bundlePath: string;
  readonly password: string;
  readonly sevenZip: SevenZipOptions;
}): Promise<{ readonly sha256: string; readonly bytes: number }> {
  const entries = [MOVE_MANIFEST_ENTRY, MOVE_CHECKLIST_ENTRY, 'installation'];
  const hosted = await readdir(join(input.directory, 'hosted')).catch(() => []);
  if (hosted.length > 0) entries.push('hosted');
  await sealSevenZipEntries({
    directory: input.directory,
    entries,
    archivePath: input.bundlePath,
    password: input.password,
    options: input.sevenZip,
  });
  return sha256OfFile(input.bundlePath);
}

export interface OpenedMoveBundle {
  readonly manifest: MoveBundleManifest;
  readonly directory: string;
  /** Each member's extracted file, by its manifest path. */
  memberPath(member: MoveBundleMember): string;
}

/**
 * Opens the bundle with `password` into `directory` (0700): refuses any entry the format never
 * writes, reads and validates the manifest, then extracts every member it names through a
 * SHA-256 that must equal the manifest's, cut off at its declared size. A wrong password is
 * `backup.archive_auth_failed`, from the 7-Zip layer.
 */
export async function openMoveBundle(input: {
  readonly bundlePath: string;
  readonly password: string;
  readonly directory: string;
  readonly sevenZip: SevenZipOptions;
  /** Free bytes of the work volume, or null when unknown; the members must fit with 1 GiB. */
  readonly freeBytes: () => Promise<number | null>;
}): Promise<OpenedMoveBundle> {
  const entries = await listSevenZipEntries({
    archivePath: input.bundlePath,
    password: input.password,
    options: input.sevenZip,
  });
  for (const entry of entries) {
    if (!isMoveBundleEntry(entry)) throw malformed('it holds an entry the format never writes');
  }
  if (!entries.includes(MOVE_MANIFEST_ENTRY)) throw malformed('it has no manifest');
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const extract = (entry: string, maxBytes: number) =>
    mkdir(dirname(join(input.directory, entry)), { recursive: true, mode: 0o700 }).then(() =>
      extractSevenZipEntry({
        archivePath: input.bundlePath,
        password: input.password,
        entry,
        destination: join(input.directory, entry),
        options: input.sevenZip,
        maxBytes,
      }),
    );
  await extract(MOVE_MANIFEST_ENTRY, MANIFEST_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(input.directory, MOVE_MANIFEST_ENTRY), 'utf8'));
  } catch {
    throw malformed('the manifest is not JSON');
  }
  const manifest = moveBundleManifestSchema.safeParse(parsed);
  if (!manifest.success) throw malformed('the manifest does not match the format');
  const named = new Set(manifest.data.members.map((member) => member.path));
  for (const entry of entries) {
    if ((INSTALLATION_MEMBER.test(entry) || HOSTED_MEMBER.test(entry)) && !named.has(entry)) {
      throw malformed('a member is not in the manifest');
    }
  }
  const declared = manifest.data.members.reduce((sum, member) => sum + member.bytes, 0);
  const free = await input.freeBytes();
  if (free !== null && declared + 1024 ** 3 > free) {
    throw new NexaError({
      kind: 'PRECONDITION_FAILED',
      code: PLATFORM_ERROR_CODES.BACKUP_DISK_INSUFFICIENT,
      message: 'There is not enough free disk space to open this move bundle.',
      details: { declaredBytes: declared, freeBytes: free },
    });
  }
  if (entries.includes(MOVE_CHECKLIST_ENTRY)) {
    await extract(MOVE_CHECKLIST_ENTRY, CHECKLIST_MAX_BYTES);
  }
  for (const member of manifest.data.members) {
    if (!entries.includes(member.path)) throw malformed(`the member ${member.path} is missing`);
    const got = await extract(member.path, member.bytes);
    if (got.sha256 !== member.sha256 || got.bytes !== member.bytes) {
      throw new NexaError({
        kind: 'VALIDATION',
        code: MOVE_ERROR_CODES.MEMBER_CHECKSUM_MISMATCH,
        message: 'A member of the move bundle does not match its manifest.',
        details: { member: member.path },
      });
    }
  }
  return {
    manifest: manifest.data,
    directory: input.directory,
    memberPath: (member) => join(input.directory, member.path),
  };
}

/**
 * Re-reads an opened bundle's manifest from `directory` and re-hashes every member: the second
 * step of `move import` runs in a new process, after the installation restore, and reads only
 * bytes it has checked itself.
 */
export async function reopenMoveBundle(directory: string): Promise<OpenedMoveBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, MOVE_MANIFEST_ENTRY), 'utf8'));
  } catch {
    throw malformed('the opened manifest is not readable');
  }
  const manifest = moveBundleManifestSchema.safeParse(parsed);
  if (!manifest.success) throw malformed('the opened manifest does not match the format');
  for (const member of manifest.data.members) {
    const got = await sha256OfFile(join(directory, member.path)).catch(() => null);
    if (got === null || got.sha256 !== member.sha256 || got.bytes !== member.bytes) {
      throw new NexaError({
        kind: 'VALIDATION',
        code: MOVE_ERROR_CODES.MEMBER_CHECKSUM_MISMATCH,
        message: 'A member of the opened move bundle changed on disk.',
        details: { member: member.path },
      });
    }
  }
  return {
    manifest: manifest.data,
    directory,
    memberPath: (member) => join(directory, member.path),
  };
}

// ---------------------------------------------------------------------------
// The Persian checklist
// ---------------------------------------------------------------------------

const toFa = (value: number): string =>
  String(value).replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)] ?? digit);

/**
 * The steps on the new server, in order (ADR-0039 § 8), filled in with this move's names:
 * DNS for the owner's names and every hosted domain, `botctl move verify`, the webhooks, the
 * secrets to re-enter, and only then the roles. Plain text, the operator's — never a customer's.
 */
export function moveChecklistFa(input: {
  readonly ownerDomains: readonly string[];
  readonly serverAddresses: readonly string[];
  readonly cnameTarget: string | null;
  readonly hostedDomains: readonly { readonly domain: string; readonly username: string | null }[];
  readonly bots: readonly { readonly kind: string; readonly username: string | null }[];
  readonly secretNames: readonly string[];
}): string {
  const lines: string[] = [];
  const address =
    input.serverAddresses.length > 0 ? input.serverAddresses.join('، ') : 'نشانی IP سرور جدید';
  lines.push('چک‌لیست انتقال نکسا به سرور جدید');
  lines.push('');
  lines.push('۱. رکوردهای DNS را عوض کنید:');
  for (const domain of input.ownerDomains) {
    lines.push(`   - ${domain}  →  رکورد A/AAAA به ${address}`);
  }
  if (input.hostedDomains.length === 0) {
    lines.push('   - (ربات میزبانی‌شده‌ای نیست)');
  }
  for (const hosted of input.hostedDomains) {
    const target = input.cnameTarget ?? address;
    const who = hosted.username === null ? '' : ` (@${hosted.username})`;
    lines.push(`   - ${hosted.domain}${who}  →  CNAME به ${target}`);
  }
  lines.push('');
  lines.push('۲. صبر کنید تا DNS به این سرور برسد و هر چند دقیقه اجرا کنید:');
  lines.push('     sudo botctl move verify');
  lines.push('');
  lines.push('۳. وقتی همهٔ دامنه‌ها «آماده» شدند، وب‌هوک ربات‌ها را ثبت کنید:');
  lines.push('     sudo botctl telegram register');
  const hostedBots = input.bots.filter((bot) => bot.kind === 'HOSTED');
  if (hostedBots.length > 0) {
    lines.push(
      `   و برای ${toFa(hostedBots.length)} ربات میزبانی‌شده، در «میزبانی‌ها» روی کارت هر ربات ` +
        'مراحل فعال‌سازی (DNS ← SSL ← وب‌هوک) را دوباره بزنید:',
    );
    for (const bot of hostedBots) lines.push(`     - @${bot.username ?? '؟'}`);
  }
  lines.push('   سپس دوباره: sudo botctl move verify');
  lines.push('');
  if (input.secretNames.length > 0) {
    lines.push('۴. این مقدارهای محرمانه را در /etc/nexa/nexa.env سرور جدید دوباره وارد کنید:');
    for (const name of input.secretNames) lines.push(`     - ${name}`);
  } else {
    lines.push('۴. مقدار محرمانه‌ای برای ورود دوباره نیست.');
  }
  lines.push('');
  lines.push('۵. وقتی همه‌چیز آماده بود، نقش‌های پس‌زمینه را روشن کنید:');
  lines.push('     sudo botctl roles enable provisioner monitor');
  lines.push('');
  lines.push('۶. سرور قدیمی را فقط بعد از همهٔ این‌ها خاموش کنید. تا آن وقت آن را روشن نکنید');
  lines.push('   (همان توکن‌ها با سرور جدید مسابقه می‌دهند). راه برگشت: sudo botctl move abort');
  return `${lines.join('\n')}\n`;
}
