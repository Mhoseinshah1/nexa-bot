import { z } from 'zod';
import { uuidV7Schema, type Branded } from './ids.js';
import { BUSINESS_HANDOFF_REASONS } from './business-chats.js';
import type { StateMachineDefinition } from './state-machine.js';
import {
  CUSTOMER_NOTIFICATION_STATES,
  type CustomerNotificationState,
} from './customer-notifications.js';

/**
 * WP-A7 — the support ticket system shared by Telegram and the Web Admin
 * (`docs/wp-a7-tickets-audit.md`).
 *
 * A ticket is a customer's conversation with support about one subject. Its messages are
 * DURABLE ROWS and the source of truth for the conversation: Telegram is how a message
 * reaches the other side, never where it lives. An administrator's reply is written as a
 * `ticket_messages` row and, in the same transaction, a `TICKET_REPLY` row on the customer
 * notification lane that names that message — so a Telegram send that fails, is rate-limited
 * or is never attempted loses nothing: the message is still in the ticket, and the lane
 * retries it on its own schedule.
 */

export type TicketId = Branded<string, 'TicketId'>;
export type TicketMessageId = Branded<string, 'TicketMessageId'>;
export type TicketCategoryId = Branded<string, 'TicketCategoryId'>;

// --- Status and its machine ------------------------------------------------------------

/**
 * Where a ticket is.
 *
 * - `OPEN` — filed by the customer; nobody from support has answered yet.
 * - `WAITING_FOR_CUSTOMER` — support answered; the next word is the customer's.
 * - `WAITING_FOR_SUPPORT` — the customer answered support; the next word is support's.
 * - `CLOSED` — finished. Nothing more is written into it until support reopens it.
 */
export const TICKET_STATUSES = [
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_SUPPORT',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const ticketStatusSchema = z.enum(TICKET_STATUSES);

/** The statuses in which a ticket still accepts messages, and counts against the open limit. */
export const TICKET_ACTIVE_STATUSES = [
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_SUPPORT',
] as const satisfies readonly TicketStatus[];

/**
 * What moves a ticket.
 *
 * - `SUPPORT_REPLY` / `CUSTOMER_REPLY` — a message from that side. A reply that finds the
 *   ticket already where it would move it (support answering twice) is a message and no
 *   transition; a reply to a `CLOSED` ticket is refused.
 * - `SET_WAITING_FOR_CUSTOMER` / `SET_WAITING_FOR_SUPPORT` — an operator's own triage.
 * - `CLOSE` — by the customer or by support.
 * - `REOPEN` — by support only; a reopened ticket waits for support.
 */
export type TicketEvent =
  | 'SUPPORT_REPLY'
  | 'CUSTOMER_REPLY'
  | 'SET_WAITING_FOR_CUSTOMER'
  | 'SET_WAITING_FOR_SUPPORT'
  | 'CLOSE'
  | 'REOPEN';

/**
 * Every edge, and nothing else. Every status write is a conditional UPDATE naming the
 * status it moves FROM, so two operators and a customer acting at once each either win
 * their edge or are told the ticket moved.
 */
export const TICKET_MACHINE: StateMachineDefinition<TicketStatus, TicketEvent> = {
  name: 'Ticket',
  initial: 'OPEN',
  states: TICKET_STATUSES,
  // None: a CLOSED ticket can be reopened, so no status is a dead end by design.
  terminal: [],
  transitions: [
    { from: 'OPEN', to: 'WAITING_FOR_CUSTOMER', on: 'SUPPORT_REPLY' },
    { from: 'WAITING_FOR_SUPPORT', to: 'WAITING_FOR_CUSTOMER', on: 'SUPPORT_REPLY' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'WAITING_FOR_SUPPORT', on: 'CUSTOMER_REPLY' },
    { from: 'OPEN', to: 'WAITING_FOR_CUSTOMER', on: 'SET_WAITING_FOR_CUSTOMER' },
    { from: 'WAITING_FOR_SUPPORT', to: 'WAITING_FOR_CUSTOMER', on: 'SET_WAITING_FOR_CUSTOMER' },
    { from: 'OPEN', to: 'WAITING_FOR_SUPPORT', on: 'SET_WAITING_FOR_SUPPORT' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'WAITING_FOR_SUPPORT', on: 'SET_WAITING_FOR_SUPPORT' },
    { from: 'OPEN', to: 'CLOSED', on: 'CLOSE' },
    { from: 'WAITING_FOR_CUSTOMER', to: 'CLOSED', on: 'CLOSE' },
    { from: 'WAITING_FOR_SUPPORT', to: 'CLOSED', on: 'CLOSE' },
    { from: 'CLOSED', to: 'WAITING_FOR_SUPPORT', on: 'REOPEN' },
  ],
};

/**
 * The status a ticket has after a message from `sender`, or `null` when the ticket
 * refuses messages (it is `CLOSED`). A reply that has no edge from where the ticket is
 * leaves the status as it was: support answering twice is still waiting for the customer.
 */
export function ticketStatusAfterMessage(
  from: TicketStatus,
  sender: 'CUSTOMER' | 'ADMIN',
): TicketStatus | null {
  if (from === 'CLOSED') return null;
  const on: TicketEvent = sender === 'ADMIN' ? 'SUPPORT_REPLY' : 'CUSTOMER_REPLY';
  return TICKET_MACHINE.transitions.find((t) => t.from === from && t.on === on)?.to ?? from;
}

/** The events an operator's status change may take. Replies are not status changes. */
const MANUAL_EVENTS: ReadonlySet<TicketEvent> = new Set<TicketEvent>([
  'SET_WAITING_FOR_CUSTOMER',
  'SET_WAITING_FOR_SUPPORT',
  'CLOSE',
  'REOPEN',
]);

/**
 * The edge an operator's "set the status to `to`" takes from `from`, or `null` when there
 * is none — which the service refuses as `TICKET_TRANSITION_INVALID`. `from === to` is not
 * an edge either; the service answers it as "nothing changed" before asking.
 */
export function ticketManualEvent(from: TicketStatus, to: TicketStatus): TicketEvent | null {
  return (
    TICKET_MACHINE.transitions.find(
      (t) => t.from === from && t.to === to && MANUAL_EVENTS.has(t.on),
    )?.on ?? null
  );
}

// --- Priority, senders, system events ----------------------------------------------------

/** Operator-facing triage. A customer never chooses it; a new ticket is `NORMAL`. */
export const TICKET_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES);
export const TICKET_DEFAULT_PRIORITY: TicketPriority = 'NORMAL';

/** Who wrote a message. `SYSTEM` is the conversation recording a status fact, never text. */
export const TICKET_MESSAGE_SENDERS = ['CUSTOMER', 'ADMIN', 'SYSTEM'] as const;
export type TicketMessageSender = (typeof TICKET_MESSAGE_SENDERS)[number];

/**
 * What a `SYSTEM` message records. A closed set, rendered by a template on each surface,
 * so the history reads "closed by support" in Persian without a string being stored.
 */
export const TICKET_SYSTEM_EVENTS = [
  'CLOSED_BY_CUSTOMER',
  'CLOSED_BY_SUPPORT',
  'REOPENED_BY_SUPPORT',
  /** TB7: the support AI handed a Telegram Business conversation to a person, here. */
  'ESCALATED_FROM_BUSINESS_CHAT',
] as const;
export type TicketSystemEvent = (typeof TICKET_SYSTEM_EVENTS)[number];

// --- Text ------------------------------------------------------------------------------

/**
 * The longest message, in code points after trimming. Below Telegram's 4,096 so an
 * administrator's reply always fits the notification that carries it with its heading.
 */
export const TICKET_MESSAGE_MAX_LENGTH = 3000;

/** The ticket's subject: the first line of its first message, cut to this many code points. */
export const TICKET_SUBJECT_MAX_LENGTH = 80;

/**
 * A message's text as it is stored: trimmed, C0/C1 control characters other than a newline
 * and a tab removed, `null` when nothing is left. Length is judged by the caller against
 * `TICKET_MESSAGE_MAX_LENGTH`, in code points, as the database CHECK counts it.
 */
export function normalizeTicketText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = Array.from(raw)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code === 0x0a || code === 0x09) return true;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join('');
  const trimmed = cleaned.trim();
  return trimmed === '' ? null : trimmed;
}

/** Whether a normalized text is within the message bound. */
export function isTicketTextWithinBound(text: string): boolean {
  return Array.from(text).length <= TICKET_MESSAGE_MAX_LENGTH;
}

/** The subject a ticket is listed by: the first non-empty line, bounded, or `null`. */
export function ticketSubjectOf(text: string | null): string | null {
  if (text === null) return null;
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  if (line === undefined) return null;
  const points = Array.from(line.trim());
  return points.length <= TICKET_SUBJECT_MAX_LENGTH
    ? line.trim()
    : `${points.slice(0, TICKET_SUBJECT_MAX_LENGTH - 1).join('')}…`;
}

// --- Attachments -----------------------------------------------------------------------

/**
 * What a customer may attach: a photo or a document, the two shapes a Telegram message
 * carries a file in that this installation reads. The bytes stay at Telegram — the project's
 * file pattern (`payment-receipts.ts`): a row holds the binding and Telegram's two ids, and
 * the Web Admin fetches the bytes through the API, which holds the bot token.
 */
export const TICKET_ATTACHMENT_KINDS = ['PHOTO', 'DOCUMENT'] as const;
export type TicketAttachmentKind = (typeof TICKET_ATTACHMENT_KINDS)[number];

/**
 * The largest attachment accepted: ten megabytes, Telegram's own ceiling on a photo, and
 * under the twenty megabytes the API will ever download (`PAYMENT_RECEIPT_MAX_BYTES`).
 */
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The documents accepted, by declared MIME type AND file-name extension — both must agree.
 * An allow-list rather than a deny-list: anything not here is refused, which is what keeps
 * an executable, a script, an archive, an HTML page or an SVG out whatever it is renamed to.
 */
export const TICKET_DOCUMENT_TYPES: readonly {
  readonly mimeType: string;
  readonly extensions: readonly string[];
}[] = [
  { mimeType: 'application/pdf', extensions: ['pdf'] },
  { mimeType: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { mimeType: 'image/png', extensions: ['png'] },
  { mimeType: 'image/webp', extensions: ['webp'] },
  { mimeType: 'text/plain', extensions: ['txt'] },
];

/** Why an attachment was refused. Nothing is written for any of them. */
export const TICKET_ATTACHMENT_REFUSALS = ['TOO_LARGE', 'TYPE_NOT_ALLOWED'] as const;
export type TicketAttachmentRefusal = (typeof TICKET_ATTACHMENT_REFUSALS)[number];

/** The longest file name stored; a longer one is cut, never refused. */
export const TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH = 200;

/**
 * Whether a file may be attached, and if not why — the ONE rule both the bot and the
 * service ask.
 *
 * A PHOTO is Telegram's own re-encoded JPEG and is accepted on its size alone, with an
 * unknown size accepted because Telegram bounds a photo at ten megabytes itself. A DOCUMENT
 * must declare its size, its MIME type and a file name whose last extension belongs to that
 * type; a document missing any of the three is refused as not allowed rather than trusted.
 */
export function ticketAttachmentRefusal(file: {
  readonly kind: TicketAttachmentKind;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSize: bigint | null;
}): TicketAttachmentRefusal | null {
  if (file.fileSize !== null && file.fileSize > BigInt(TICKET_ATTACHMENT_MAX_BYTES)) {
    return 'TOO_LARGE';
  }
  if (file.kind === 'PHOTO') return null;
  if (file.fileSize === null || file.mimeType === null || file.fileName === null) {
    return 'TYPE_NOT_ALLOWED';
  }
  const mime = file.mimeType.trim().toLowerCase();
  const allowed = TICKET_DOCUMENT_TYPES.find((type) => type.mimeType === mime);
  if (allowed === undefined) return 'TYPE_NOT_ALLOWED';
  const dot = file.fileName.lastIndexOf('.');
  if (dot < 0) return 'TYPE_NOT_ALLOWED';
  const extension = file.fileName
    .slice(dot + 1)
    .trim()
    .toLowerCase();
  return allowed.extensions.includes(extension) ? null : 'TYPE_NOT_ALLOWED';
}

// --- Support's attachments (HF-A7) -----------------------------------------------------

/**
 * What support may attach to a reply from the Web Admin: a closed allow-list, each type
 * with the Telegram shape it is sent as, the file-name extensions it may carry, the one
 * extension it is SENT with, and its own size bound.
 *
 * The bytes travel the other way from a customer's file, so the rule is stricter than
 * `TICKET_DOCUMENT_TYPES`: the declared MIME type, the file name's last extension AND the
 * bytes' own signature must all name the same type (`ticketReplyFileRefusal`). Anything not
 * here — an executable, a script, an archive, an installer, HTML, SVG, an Office document —
 * is refused whatever it is called.
 *
 * - `image/jpeg` and `image/png` go as a PHOTO, bounded at five megabytes (Telegram's own
 *   photo ceiling is ten; a screenshot is far below either).
 * - `application/pdf` goes as a DOCUMENT, bounded at ten megabytes — the customer's own
 *   attachment bound (`TICKET_ATTACHMENT_MAX_BYTES`), and half of the twenty Telegram lets a
 *   bot download again, which is how the Web Admin reads a delivered file back.
 * - `text/plain` goes as a DOCUMENT, bounded at one megabyte, and only when it is valid
 *   UTF-8 with no control characters, no `#!` interpreter line and no leading markup.
 *
 * WEBP is deliberately absent: Telegram may present a `.webp` document as a sticker, and
 * nothing here has verified what `sendPhoto` does with one.
 */
export const TICKET_REPLY_FILE_TYPES = [
  {
    mimeType: 'image/jpeg',
    kind: 'PHOTO',
    extension: 'jpg',
    extensions: ['jpg', 'jpeg'],
    maxBytes: 5 * 1024 * 1024,
  },
  {
    mimeType: 'image/png',
    kind: 'PHOTO',
    extension: 'png',
    extensions: ['png'],
    maxBytes: 5 * 1024 * 1024,
  },
  {
    mimeType: 'application/pdf',
    kind: 'DOCUMENT',
    extension: 'pdf',
    extensions: ['pdf'],
    maxBytes: 10 * 1024 * 1024,
  },
  {
    mimeType: 'text/plain',
    kind: 'DOCUMENT',
    extension: 'txt',
    extensions: ['txt'],
    maxBytes: 1024 * 1024,
  },
] as const satisfies readonly {
  readonly mimeType: string;
  readonly kind: TicketAttachmentKind;
  readonly extension: string;
  readonly extensions: readonly string[];
  readonly maxBytes: number;
}[];
export type TicketReplyFileType = (typeof TICKET_REPLY_FILE_TYPES)[number];
export type TicketReplyFileMimeType = TicketReplyFileType['mimeType'];
export const TICKET_REPLY_FILE_MIME_TYPES: readonly TicketReplyFileMimeType[] =
  TICKET_REPLY_FILE_TYPES.map((type) => type.mimeType);

/** The largest file of any allowed type. The HTTP schema and the table's CHECK use it. */
export const TICKET_REPLY_FILE_MAX_BYTES = Math.max(
  ...TICKET_REPLY_FILE_TYPES.map((type) => type.maxBytes),
);

/**
 * How many bytes of support's files one tenant may hold UNDELIVERED at once.
 *
 * A file is kept in the database only until Telegram has it: the delivery stamps Telegram's
 * own `file_id` and clears the bytes in the same transaction. What is left is what Telegram
 * has not accepted yet — a queue behind a rate limit, a customer who blocked the bot, an
 * outage — and this is the ceiling on it, so the staging table is never an unbounded blob
 * store. A reply whose file would cross it is refused (`ticket.attachment_storage_full`)
 * and writes nothing.
 */
export const TICKET_REPLY_FILE_STAGED_MAX_BYTES = 100 * 1024 * 1024;

/**
 * How long an undelivered file's bytes are kept. After this the bytes are cleared whatever
 * the delivery did; the message, the file's name, type, size and digest stay in the ticket.
 * A delivery still waiting then finds no bytes and fails rather than send something else.
 */
export const TICKET_REPLY_FILE_RETENTION_DAYS = 7;

/**
 * Why support's file was refused. Nothing is written for any of them.
 *
 * - `EMPTY` — no bytes.
 * - `TYPE_NOT_ALLOWED` — the declared type is not on the list, or the name's last extension
 *   does not belong to it.
 * - `TOO_LARGE` — over the type's own bound.
 * - `NAME_NOT_ALLOWED` — an earlier part of the name is an executable or script extension
 *   (`invoice.exe.pdf`): refused rather than trusted to the last dot.
 * - `CONTENT_MISMATCH` — the bytes are not what the type and the name say: a program renamed
 *   `x.pdf`, a script renamed `x.txt`, a PNG declared as JPEG.
 */
export const TICKET_REPLY_FILE_REFUSALS = [
  'EMPTY',
  'TYPE_NOT_ALLOWED',
  'TOO_LARGE',
  'NAME_NOT_ALLOWED',
  'CONTENT_MISMATCH',
] as const;
export type TicketReplyFileRefusal = (typeof TICKET_REPLY_FILE_REFUSALS)[number];

/**
 * Extensions that run something, install something or render active content. A name that
 * carries one ANYWHERE before its last extension is refused (`NAME_NOT_ALLOWED`); as the
 * last extension it is already refused by the allow-list.
 */
export const TICKET_REPLY_DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'exe msi msp msc bat cmd com scr pif cpl dll sys lnk reg inf hta gadget ' +
    'application appx msix sh bash zsh csh ksh fish command run bin elf out so dylib ' +
    'app dmg pkg deb rpm appimage snap flatpak js mjs cjs jse vbs vbe wsf wsh ws ps1 ' +
    'psm1 psd1 py pyc pyw pl rb php phtml lua tcl awk jar class war ear apk xapk ' +
    'apks aab ipa html htm xhtml shtml svg svgz xml xsl swf iso img vhd vhdx vmdk ' +
    'docm xlsm pptm dotm xlam'
  ).split(' '),
);

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Whether the bytes are plain text a customer can safely open: valid UTF-8, no NUL, no C0
 * control other than a tab, a line feed, a form feed and a carriage return, no DEL or C1
 * control, and neither an interpreter line (`#!`) nor markup (`<` first) at the start.
 * Decoded by hand rather than through `TextDecoder`, so the rule is the same in the API and
 * the browser whatever their runtimes provide.
 */
function isPlainText(bytes: Uint8Array): boolean {
  let index = 0;
  // A UTF-8 byte-order mark is allowed and skipped.
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) index = 3;
  let firstVisible: number | null = null;
  while (index < bytes.byteLength) {
    const lead = bytes[index] ?? 0;
    if (lead < 0x80) {
      if (lead === 0x7f) return false;
      if (lead < 0x20 && lead !== 0x09 && lead !== 0x0a && lead !== 0x0c && lead !== 0x0d) {
        return false;
      }
      if (firstVisible === null && lead > 0x20) firstVisible = index;
      index += 1;
      continue;
    }
    // Multi-byte: the lead byte decides the length; overlongs and surrogates are refused.
    let length: number;
    let min: number;
    let codePoint: number;
    if (lead >= 0xc2 && lead <= 0xdf) {
      length = 2;
      min = 0x80;
      codePoint = lead & 0x1f;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      length = 3;
      min = 0x800;
      codePoint = lead & 0x0f;
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      length = 4;
      min = 0x10000;
      codePoint = lead & 0x07;
    } else {
      return false;
    }
    if (index + length > bytes.byteLength) return false;
    for (let offset = 1; offset < length; offset += 1) {
      const next = bytes[index + offset] ?? 0;
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min || codePoint > 0x10ffff) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    // C1 controls are not text either.
    if (codePoint <= 0x9f) return false;
    if (firstVisible === null) firstVisible = index;
    index += length;
  }
  if (firstVisible === null) return false;
  const first = bytes[firstVisible];
  // `<` first: HTML, SVG, XML, a PHP opening tag — markup, not text.
  if (first === 0x3c) return false;
  // `#!` first: an interpreter line, which is a script whatever it is named.
  if (first === 0x23 && bytes[firstVisible + 1] === 0x21) return false;
  return true;
}

/**
 * The allowed type the bytes THEMSELVES are, by signature, or `null` — never by what the
 * caller declared. JPEG `FF D8 FF`, PNG's eight-byte signature, PDF `%PDF-` at offset zero,
 * and plain text by `isPlainText`. A Windows program (`MZ`), an ELF or Mach-O binary, a ZIP
 * (and so a JAR, an APK or an Office document) and a script with an interpreter line are
 * none of these, and answer `null`.
 */
export function sniffTicketReplyFile(bytes: Uint8Array): TicketReplyFileMimeType | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (isPlainText(bytes)) return 'text/plain';
  return null;
}

/** The allowed type a declared MIME type names, or `undefined`. */
export function ticketReplyFileTypeOf(mimeType: string): TicketReplyFileType | undefined {
  const declared = mimeType.trim().toLowerCase();
  return TICKET_REPLY_FILE_TYPES.find((type) => type.mimeType === declared);
}

/** The dot-separated parts of a file name's last path segment, lowercased. */
function nameParts(fileName: string): string[] {
  const base = fileName.split(/[/\\]/u).pop() ?? '';
  return base
    .trim()
    .toLowerCase()
    .split('.')
    .map((part) => part.trim());
}

/**
 * Whether support may send this file, and if not why — the ONE rule the Web Admin asks
 * before uploading and the API asks before storing. Nothing about it is trusted to the
 * browser: the API decodes the bytes and asks again.
 *
 * Declared type, size, name and bytes, in that order: the declared type must be on the
 * allow-list, the bytes within that type's bound, the name's last extension one of the
 * type's and no earlier part of it an executable's, and the bytes' own signature the
 * declared type.
 */
export function ticketReplyFileRefusal(file: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): TicketReplyFileRefusal | null {
  if (file.bytes.byteLength === 0) return 'EMPTY';
  const type = ticketReplyFileTypeOf(file.mimeType);
  if (type === undefined) return 'TYPE_NOT_ALLOWED';
  if (file.bytes.byteLength > type.maxBytes) return 'TOO_LARGE';
  const parts = nameParts(file.fileName);
  if (parts.length < 2) return 'TYPE_NOT_ALLOWED';
  const extension = parts[parts.length - 1] ?? '';
  if (!(type.extensions as readonly string[]).includes(extension)) return 'TYPE_NOT_ALLOWED';
  if (parts.slice(1, -1).some((part) => TICKET_REPLY_DANGEROUS_EXTENSIONS.has(part))) {
    return 'NAME_NOT_ALLOWED';
  }
  if (sniffTicketReplyFile(file.bytes) !== type.mimeType) return 'CONTENT_MISMATCH';
  return null;
}

/**
 * The name support's file is stored and SENT under: the last path segment, control
 * characters, quotes and shell or path punctuation replaced, bounded, and ending in the
 * type's own extension whatever it ended in before — so the customer's device is told the
 * type the bytes were verified to be. An empty stem becomes `file`.
 */
export function ticketReplyFileNameOf(raw: string, type: TicketReplyFileType): string {
  const base = raw.split(/[/\\]/u).pop() ?? '';
  const cleaned = Array.from(base)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return !(code < 0x20 || (code >= 0x7f && code <= 0x9f));
    })
    .join('')
    .replace(/["'`<>|:*?]/gu, '_')
    .trim();
  const dot = cleaned.lastIndexOf('.');
  const stem = (dot >= 0 ? cleaned.slice(0, dot) : cleaned).replace(/^\.+/u, '').trim();
  const suffix = `.${type.extension}`;
  const room = TICKET_ATTACHMENT_FILE_NAME_MAX_LENGTH - suffix.length;
  const bounded = Array.from(stem === '' ? 'file' : stem)
    .slice(0, room)
    .join('')
    .trim();
  return `${bounded === '' ? 'file' : bounded}${suffix}`;
}

// --- Rails -----------------------------------------------------------------------------

/** How many tickets one customer may have open at once. A rail against a loop, not a policy. */
export const TICKET_OPEN_MAX_PER_CUSTOMER = 5;
/** How many messages one ticket may hold. A rail, for the same reason. */
export const TICKET_MESSAGES_MAX_PER_TICKET = 500;
/** How many tickets the customer's list in the bot shows (newest first). */
export const TICKET_CUSTOMER_LIST_LIMIT = 10;
/** How many of the latest messages the bot's conversation view shows. */
export const TICKET_VIEW_MESSAGE_COUNT = 6;
/** The bound on one message's text inside the bot's conversation view. */
export const TICKET_VIEW_MESSAGE_EXCERPT = 450;

// --- Categories ------------------------------------------------------------------------

export const TICKET_CATEGORY_TITLE_MAX_LENGTH = 64;
export const TICKET_CATEGORY_SORT_MAX = 100_000;
/** How many categories a tenant may define; a bot keyboard is not a directory. */
export const TICKET_CATEGORY_MAX = 30;

/** A category title as stored: trimmed, 1..64 code points, or `null`. */
export function normalizeTicketCategoryTitle(raw: unknown): string | null {
  const text = normalizeTicketText(raw);
  if (text === null || text.includes('\n')) return null;
  return Array.from(text).length <= TICKET_CATEGORY_TITLE_MAX_LENGTH ? text : null;
}

// --- HTTP ------------------------------------------------------------------------------

export const TICKET_PAGE_MAX = 100;

export const ticketCategoryViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TicketCategoryView = z.infer<typeof ticketCategoryViewSchema>;

export const ticketCategoryListResponseSchema = z.object({
  categories: z.array(ticketCategoryViewSchema),
});
export type TicketCategoryListResponse = z.infer<typeof ticketCategoryListResponseSchema>;

export const ticketCategoryCreateRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  title: z.string().max(TICKET_CATEGORY_TITLE_MAX_LENGTH * 4),
  sortOrder: z.number().int().min(0).max(TICKET_CATEGORY_SORT_MAX),
});
export type TicketCategoryCreateRequest = z.infer<typeof ticketCategoryCreateRequestSchema>;

export const ticketCategoryUpdateRequestSchema = z
  .object({
    title: z
      .string()
      .max(TICKET_CATEGORY_TITLE_MAX_LENGTH * 4)
      .optional(),
    sortOrder: z.number().int().min(0).max(TICKET_CATEGORY_SORT_MAX).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined || body.sortOrder !== undefined || body.isActive !== undefined,
    { message: 'Name at least one field to change.' },
  );
export type TicketCategoryUpdateRequest = z.infer<typeof ticketCategoryUpdateRequestSchema>;

export const ticketCategoryResponseSchema = z.object({
  category: ticketCategoryViewSchema,
  /** False when the write landed on the values already stored. */
  changed: z.boolean(),
});
export type TicketCategoryResponse = z.infer<typeof ticketCategoryResponseSchema>;

export const ticketSummarySchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  categoryId: z.string(),
  categoryTitle: z.string(),
  subject: z.string().nullable(),
  customerId: z.string(),
  customerTelegramUserId: z.string().nullable(),
  customerUsername: z.string().nullable(),
  customerDisplayName: z.string().nullable(),
  assignedAdminId: z.string().nullable(),
  assignedAdminUsername: z.string().nullable(),
  serviceId: z.string().nullable(),
  orderId: z.string().nullable(),
  paymentId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  lastMessageAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/**
 * How far an administrator's reply got to the customer: the customer notification lane's
 * OWN state (`CUSTOMER_NOTIFICATION_STATES`) for the `TICKET_REPLY` row that names the
 * message, projected rather than copied — one vocabulary, one row that decides it. `null`
 * for a message that is never pushed (the customer's own, a system fact).
 */
export type TicketDeliveryState = CustomerNotificationState;

export const ticketAttachmentViewSchema = z.object({
  kind: z.enum(TICKET_ATTACHMENT_KINDS),
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  /** Bytes. A number, not a string: an attachment is bounded far below 2^53. */
  fileSize: z.number().int().nonnegative().nullable(),
});
export type TicketAttachmentView = z.infer<typeof ticketAttachmentViewSchema>;

export const ticketMessageViewSchema = z.object({
  id: z.string(),
  senderType: z.enum(TICKET_MESSAGE_SENDERS),
  authorAdminId: z.string().nullable(),
  authorAdminUsername: z.string().nullable(),
  body: z.string().nullable(),
  systemEvent: z.enum(TICKET_SYSTEM_EVENTS).nullable(),
  attachment: ticketAttachmentViewSchema.nullable(),
  delivery: z.enum(CUSTOMER_NOTIFICATION_STATES).nullable(),
  /**
   * HF-A7: how far support's FILE got — the `TICKET_REPLY_ATTACHMENT` row's own state, beside
   * the text's `delivery`. The two are separate sends and each has its own outcome. `null`
   * for a message that sent no file.
   */
  attachmentDelivery: z.enum(CUSTOMER_NOTIFICATION_STATES).nullable(),
  createdAt: z.iso.datetime(),
});
export type TicketMessageView = z.infer<typeof ticketMessageViewSchema>;

/**
 * TB7 — where a ticket came from. `BOT`: the customer opened it in the NEXA bot (every ticket
 * before TB7). `BUSINESS_CHAT`: the support agent escalated a Telegram Business conversation.
 */
export const TICKET_ORIGINS = ['BOT', 'BUSINESS_CHAT'] as const;
export type TicketOrigin = (typeof TICKET_ORIGINS)[number];

/** TB7 — a handoff that opened or linked this ticket, with the AI's operator-facing note. */
export const ticketEscalationViewSchema = z.object({
  conversationId: z.string(),
  reason: z.enum(BUSINESS_HANDOFF_REASONS),
  summary: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TicketEscalationView = z.infer<typeof ticketEscalationViewSchema>;

export const ticketDetailResponseSchema = z.object({
  ticket: ticketSummarySchema.extend({ origin: z.enum(TICKET_ORIGINS) }),
  /** TB7: the business-chat handoffs attached to this ticket, newest first. */
  escalations: z.array(ticketEscalationViewSchema),
  messages: z.array(ticketMessageViewSchema),
  customer: z.object({
    id: z.string(),
    telegramUserId: z.string(),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    status: z.string(),
  }),
});
export type TicketDetailResponse = z.infer<typeof ticketDetailResponseSchema>;

/**
 * The inbox's filters. `customer` is a customer's internal id, their numeric Telegram id
 * or their Telegram username (with or without `@`) — what an operator actually holds.
 * `assigned` is an administrator's id, `me`, or `none`. `from`/`to` bound `createdAt` as a
 * half-open interval `[from, to)`.
 */
export const ticketListQuerySchema = z
  .object({
    status: ticketStatusSchema.optional(),
    categoryId: uuidV7Schema.optional(),
    customer: z.string().trim().min(1).max(64).optional(),
    assigned: z.union([z.enum(['me', 'none']), uuidV7Schema]).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    limit: z.coerce.number().int().positive().max(TICKET_PAGE_MAX).optional(),
    before: z.iso.datetime().optional(),
    beforeId: uuidV7Schema.optional(),
  })
  .refine((query) => (query.before === undefined) === (query.beforeId === undefined), {
    message: 'before and beforeId must be supplied together.',
    path: ['beforeId'],
  })
  .refine(
    (query) =>
      query.from === undefined ||
      query.to === undefined ||
      new Date(query.from).getTime() < new Date(query.to).getTime(),
    { message: 'from must be before to.', path: ['to'] },
  );
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketListResponseSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  nextCursor: z.object({ at: z.iso.datetime(), id: z.string() }).nullable(),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/**
 * Support's file on a reply (HF-A7): its name, its declared type, and its bytes as base64 —
 * the tenant media upload's shape. Bounded here by the DECODED size of the largest allowed
 * type; the API decodes the bytes and judges them with `ticketReplyFileRefusal`, which holds
 * each type to its own bound and to its own signature.
 */
export const ticketReplyAttachmentSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  contentBase64: z
    .string()
    .min(4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
    .refine((value) => value.length % 4 === 0, { message: 'padded base64' })
    .refine((value) => Math.floor((value.length * 3) / 4) <= TICKET_REPLY_FILE_MAX_BYTES + 3, {
      message: `at most ${TICKET_REPLY_FILE_MAX_BYTES} bytes`,
    }),
});
export type TicketReplyAttachment = z.infer<typeof ticketReplyAttachmentSchema>;

export const ticketReplyRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  text: z.string().max(TICKET_MESSAGE_MAX_LENGTH * 4),
  /** Optional: a reply is always its text, and may carry one file beside it. */
  attachment: ticketReplyAttachmentSchema.optional(),
});
export type TicketReplyRequest = z.infer<typeof ticketReplyRequestSchema>;

export const ticketReplyResponseSchema = z.object({
  ticket: ticketSummarySchema,
  message: ticketMessageViewSchema,
});
export type TicketReplyResponse = z.infer<typeof ticketReplyResponseSchema>;

/** A target status. Close, reopen and triage are all this one command. */
export const ticketStatusRequestSchema = z.object({ status: ticketStatusSchema });
export type TicketStatusRequest = z.infer<typeof ticketStatusRequestSchema>;

/** A target assignee: an administrator's id, or `null` to unassign. */
export const ticketAssignRequestSchema = z.object({ adminId: uuidV7Schema.nullable() });
export type TicketAssignRequest = z.infer<typeof ticketAssignRequestSchema>;

export const ticketPriorityRequestSchema = z.object({ priority: ticketPrioritySchema });
export type TicketPriorityRequest = z.infer<typeof ticketPriorityRequestSchema>;

/** The linked context, as a whole: each id must be the ticket's customer's own, or `null`. */
export const ticketLinksRequestSchema = z.object({
  serviceId: uuidV7Schema.nullable(),
  orderId: uuidV7Schema.nullable(),
  paymentId: uuidV7Schema.nullable(),
});
export type TicketLinksRequest = z.infer<typeof ticketLinksRequestSchema>;

export const ticketMutationResponseSchema = z.object({
  ticket: ticketSummarySchema,
  /** False when the ticket already stood where the command would have moved it. */
  changed: z.boolean(),
});
export type TicketMutationResponse = z.infer<typeof ticketMutationResponseSchema>;

export const ticketAssigneesResponseSchema = z.object({
  admins: z.array(z.object({ id: z.string(), username: z.string(), displayName: z.string() })),
});
export type TicketAssigneesResponse = z.infer<typeof ticketAssigneesResponseSchema>;

export const TICKET_ROUTES = {
  list: '/tickets',
  assignees: '/tickets/assignees',
  detail: (id: string) => `/tickets/${encodeURIComponent(id)}`,
  reply: (id: string) => `/tickets/${encodeURIComponent(id)}/messages`,
  status: (id: string) => `/tickets/${encodeURIComponent(id)}/status`,
  assign: (id: string) => `/tickets/${encodeURIComponent(id)}/assignee`,
  priority: (id: string) => `/tickets/${encodeURIComponent(id)}/priority`,
  links: (id: string) => `/tickets/${encodeURIComponent(id)}/links`,
  attachment: (id: string) => `/ticket-messages/${encodeURIComponent(id)}/attachment`,
  categories: '/ticket-categories',
  category: (id: string) => `/ticket-categories/${encodeURIComponent(id)}`,
} as const;
