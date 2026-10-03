import { describe, expect, it } from 'vitest';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_MACHINE,
  TICKET_REPLY_FILE_MAX_BYTES,
  TICKET_REPLY_FILE_TYPES,
  TICKET_STATUSES,
  normalizeTicketCategoryTitle,
  normalizeTicketText,
  ticketAttachmentRefusal,
  ticketManualEvent,
  ticketReplyFileNameOf,
  ticketReplyFileRefusal,
  ticketStatusAfterMessage,
  ticketSubjectOf,
  sniffTicketReplyFile,
  validateStateMachine,
  type TicketStatus,
} from '@nexa/contracts';
import { intentOf, notificationButtons } from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * WP-A7 — the pure rules the ticket system rests on: the status machine and its edges, the
 * attachment allow-list, the text normaliser, and the bot's parsing of the desk's callbacks.
 * Each is asked of the ONE function every caller uses, so the bot, the service and the Web
 * Admin cannot disagree about them.
 */

const TICKET = '01900000-0000-7000-8000-00000000d001';

describe('the ticket status machine', () => {
  it('is a valid graph with no dead end and no unreachable status', () => {
    expect(validateStateMachine(TICKET_MACHINE)).toEqual([]);
  });

  it('moves on a message exactly as the brief reads: support answers, the customer answers back', () => {
    const table = Object.fromEntries(
      TICKET_STATUSES.map((from) => [
        from,
        [ticketStatusAfterMessage(from, 'ADMIN'), ticketStatusAfterMessage(from, 'CUSTOMER')],
      ]),
    );
    expect(table).toEqual({
      OPEN: ['WAITING_FOR_CUSTOMER', 'OPEN'],
      WAITING_FOR_CUSTOMER: ['WAITING_FOR_CUSTOMER', 'WAITING_FOR_SUPPORT'],
      WAITING_FOR_SUPPORT: ['WAITING_FOR_CUSTOMER', 'WAITING_FOR_SUPPORT'],
      // A closed ticket refuses a message from either side.
      CLOSED: [null, null],
    });
  });

  it('allows exactly these operator status changes and refuses every other', () => {
    const allowed: string[] = [];
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (from !== to && ticketManualEvent(from, to) !== null) allowed.push(`${from}->${to}`);
      }
    }
    expect(allowed.sort()).toEqual(
      [
        'OPEN->WAITING_FOR_CUSTOMER',
        'OPEN->WAITING_FOR_SUPPORT',
        'OPEN->CLOSED',
        'WAITING_FOR_CUSTOMER->WAITING_FOR_SUPPORT',
        'WAITING_FOR_CUSTOMER->CLOSED',
        'WAITING_FOR_SUPPORT->WAITING_FOR_CUSTOMER',
        'WAITING_FOR_SUPPORT->CLOSED',
        // A reopen waits for support; nothing returns a ticket to OPEN.
        'CLOSED->WAITING_FOR_SUPPORT',
      ].sort(),
    );
    const staying: TicketStatus[] = [...TICKET_STATUSES];
    for (const status of staying) expect(ticketManualEvent(status, status)).toBeNull();
    expect(ticketManualEvent('CLOSED', 'CLOSED')).toBeNull();
  });

  it('never lets an operator status change use a reply edge', () => {
    // OPEN -> WAITING_FOR_CUSTOMER exists as SUPPORT_REPLY and as the manual edge: the manual
    // change must take the manual one, so a reply is never inferred from a status change.
    expect(ticketManualEvent('OPEN', 'WAITING_FOR_CUSTOMER')).toBe('SET_WAITING_FOR_CUSTOMER');
    expect(ticketManualEvent('WAITING_FOR_CUSTOMER', 'WAITING_FOR_SUPPORT')).toBe(
      'SET_WAITING_FOR_SUPPORT',
    );
    expect(ticketManualEvent('CLOSED', 'WAITING_FOR_SUPPORT')).toBe('REOPEN');
  });
});

describe('the attachment rule', () => {
  const photo = (fileSize: bigint | null) => ({
    kind: 'PHOTO' as const,
    mimeType: null,
    fileName: null,
    fileSize,
  });
  const document = (fileName: string | null, mimeType: string | null, fileSize: bigint | null) => ({
    kind: 'DOCUMENT' as const,
    mimeType,
    fileName,
    fileSize,
  });
  const MAX = BigInt(TICKET_ATTACHMENT_MAX_BYTES);

  it('takes a photo on its size alone, and an unknown size because Telegram bounds it', () => {
    expect(ticketAttachmentRefusal(photo(90_000n))).toBeNull();
    expect(ticketAttachmentRefusal(photo(null))).toBeNull();
    expect(ticketAttachmentRefusal(photo(MAX))).toBeNull();
    expect(ticketAttachmentRefusal(photo(MAX + 1n))).toBe('TOO_LARGE');
  });

  it('takes the allow-listed documents when the type and the extension agree, in any case', () => {
    expect(ticketAttachmentRefusal(document('receipt.pdf', 'application/pdf', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('Receipt.PDF', 'Application/PDF', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('shot.jpeg', 'image/jpeg', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('shot.png', 'image/png', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('shot.webp', 'image/webp', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('log.txt', 'text/plain', 2048n))).toBeNull();
    expect(ticketAttachmentRefusal(document('big.pdf', 'application/pdf', MAX + 1n))).toBe(
      'TOO_LARGE',
    );
  });

  it('refuses executables, scripts, archives, markup and anything that does not declare itself', () => {
    for (const [name, mime] of [
      ['setup.exe', 'application/x-msdownload'],
      ['run.sh', 'application/x-sh'],
      ['app.apk', 'application/vnd.android.package-archive'],
      ['files.zip', 'application/zip'],
      ['page.html', 'text/html'],
      ['logo.svg', 'image/svg+xml'],
      // Renamed: the declared type is allowed, the last extension is not.
      ['invoice.pdf.exe', 'application/pdf'],
      // Mismatched: an allowed extension under another allowed type.
      ['photo.pdf', 'image/png'],
      ['noextension', 'application/pdf'],
    ] as const) {
      expect(ticketAttachmentRefusal(document(name, mime, 100n)), name).toBe('TYPE_NOT_ALLOWED');
    }
    expect(ticketAttachmentRefusal(document(null, 'application/pdf', 100n))).toBe(
      'TYPE_NOT_ALLOWED',
    );
    expect(ticketAttachmentRefusal(document('a.pdf', null, 100n))).toBe('TYPE_NOT_ALLOWED');
    expect(ticketAttachmentRefusal(document('a.pdf', 'application/pdf', null))).toBe(
      'TYPE_NOT_ALLOWED',
    );
  });
});

describe("support's file rule (HF-A7)", () => {
  const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
  const TEXT = new TextEncoder().encode('سلام\r\nتنظیمات اتصال:\tپورت ۴۴۳\n');
  const EXE = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  const ELF = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const SHELL = new TextEncoder().encode('#!/bin/sh\nrm -rf ~\n');
  const HTML = new TextEncoder().encode('  <script>alert(1)</script>');
  const refusal = (fileName: string, mimeType: string, bytes: Uint8Array) =>
    ticketReplyFileRefusal({ fileName, mimeType, bytes });

  it('takes each allowed type when its declared type, its extension and its bytes agree', () => {
    expect(refusal('screen.jpg', 'image/jpeg', JPEG)).toBeNull();
    expect(refusal('screen.JPEG', 'IMAGE/JPEG', JPEG)).toBeNull();
    expect(refusal('screen.png', 'image/png', PNG)).toBeNull();
    expect(refusal('guide.pdf', 'application/pdf', PDF)).toBeNull();
    expect(refusal('config.txt', 'text/plain', TEXT)).toBeNull();
  });

  it('refuses an executable, an archive or a script whatever it is renamed to', () => {
    // The spoofed extension: a Windows program, an ELF, a ZIP (so a JAR or an APK).
    expect(refusal('guide.pdf', 'application/pdf', EXE)).toBe('CONTENT_MISMATCH');
    expect(refusal('photo.jpg', 'image/jpeg', ELF)).toBe('CONTENT_MISMATCH');
    expect(refusal('notes.txt', 'text/plain', EXE)).toBe('CONTENT_MISMATCH');
    expect(refusal('notes.txt', 'text/plain', ZIP)).toBe('CONTENT_MISMATCH');
    // A script is text, and still refused: an interpreter line, or markup, first.
    expect(refusal('notes.txt', 'text/plain', SHELL)).toBe('CONTENT_MISMATCH');
    expect(refusal('notes.txt', 'text/plain', HTML)).toBe('CONTENT_MISMATCH');
    // Declared honestly, each is not on the list at all.
    for (const [name, type] of [
      ['setup.exe', 'application/x-msdownload'],
      ['setup.msi', 'application/x-msi'],
      ['run.bat', 'application/x-bat'],
      ['run.sh', 'application/x-sh'],
      ['app.js', 'text/javascript'],
      ['app.apk', 'application/vnd.android.package-archive'],
      ['lib.jar', 'application/java-archive'],
      ['page.html', 'text/html'],
      ['logo.svg', 'image/svg+xml'],
      ['bundle.zip', 'application/zip'],
    ] as const) {
      expect(refusal(name, type, EXE)).toBe('TYPE_NOT_ALLOWED');
    }
    // A type on the list with a name that is not: the extension must be the type's own.
    expect(refusal('setup.exe', 'application/pdf', PDF)).toBe('TYPE_NOT_ALLOWED');
    expect(refusal('guide.pdf.exe', 'application/pdf', PDF)).toBe('TYPE_NOT_ALLOWED');
    expect(refusal('guide', 'application/pdf', PDF)).toBe('TYPE_NOT_ALLOWED');
    // An executable's extension earlier in the name is refused rather than trusted to the dot.
    expect(refusal('invoice.exe.pdf', 'application/pdf', PDF)).toBe('NAME_NOT_ALLOWED');
    expect(refusal('photo.js.png', 'image/png', PNG)).toBe('NAME_NOT_ALLOWED');
    // A PNG declared as a JPEG is not a JPEG.
    expect(refusal('screen.jpg', 'image/jpeg', PNG)).toBe('CONTENT_MISMATCH');
  });

  it('holds each type to its own size bound, and refuses an empty file', () => {
    const over = (type: (typeof TICKET_REPLY_FILE_TYPES)[number], head: Uint8Array) => {
      const bytes = new Uint8Array(type.maxBytes + 1).fill(0x41);
      bytes.set(head);
      return bytes;
    };
    const [jpeg, png, pdf, text] = TICKET_REPLY_FILE_TYPES;
    expect(refusal('a.jpg', 'image/jpeg', over(jpeg, JPEG))).toBe('TOO_LARGE');
    expect(refusal('a.png', 'image/png', over(png, PNG))).toBe('TOO_LARGE');
    expect(refusal('a.pdf', 'application/pdf', over(pdf, PDF))).toBe('TOO_LARGE');
    expect(refusal('a.txt', 'text/plain', over(text, TEXT))).toBe('TOO_LARGE');
    const atBound = new Uint8Array(pdf.maxBytes).fill(0x41);
    atBound.set(PDF);
    expect(refusal('a.pdf', 'application/pdf', atBound)).toBeNull();
    expect(TICKET_REPLY_FILE_MAX_BYTES).toBe(pdf.maxBytes);
    expect(refusal('a.pdf', 'application/pdf', new Uint8Array(0))).toBe('EMPTY');
  });

  it('reads the type from the bytes alone, and calls invalid UTF-8 or a control character not text', () => {
    expect(sniffTicketReplyFile(JPEG)).toBe('image/jpeg');
    expect(sniffTicketReplyFile(PNG)).toBe('image/png');
    expect(sniffTicketReplyFile(PDF)).toBe('application/pdf');
    expect(sniffTicketReplyFile(TEXT)).toBe('text/plain');
    expect(sniffTicketReplyFile(EXE)).toBeNull();
    expect(sniffTicketReplyFile(Uint8Array.from([0x61, 0xc3]))).toBeNull(); // cut UTF-8
    expect(sniffTicketReplyFile(Uint8Array.from([0xc0, 0x80]))).toBeNull(); // overlong NUL
    expect(sniffTicketReplyFile(Uint8Array.from([0x61, 0x00, 0x62]))).toBeNull(); // NUL
    expect(sniffTicketReplyFile(Uint8Array.from([0x61, 0x1b, 0x62]))).toBeNull(); // ESC
    expect(sniffTicketReplyFile(Uint8Array.from([0x20, 0x0a]))).toBeNull(); // nothing visible
  });

  it('sends the file under a clean name ending in the type it was verified to be', () => {
    const [jpeg, , pdf] = TICKET_REPLY_FILE_TYPES;
    expect(ticketReplyFileNameOf('راهنما.PDF', pdf)).toBe('راهنما.pdf');
    expect(ticketReplyFileNameOf('C:\\Users\\x\\shot.jpeg', jpeg)).toBe('shot.jpg');
    expect(ticketReplyFileNameOf('../../"a"\n.pdf', pdf)).toBe('_a_.pdf');
    expect(ticketReplyFileNameOf('.pdf', pdf)).toBe('file.pdf');
    expect(Array.from(ticketReplyFileNameOf(`${'ب'.repeat(400)}.pdf`, pdf))).toHaveLength(200);
  });
});

describe('ticket text', () => {
  it('trims, drops control characters but keeps lines, and treats blank as nothing', () => {
    expect(normalizeTicketText('  سلام\u0007\r\nدنیا  ')).toBe('سلام\nدنیا');
    expect(normalizeTicketText(' \n\t ')).toBeNull();
    expect(normalizeTicketText(42)).toBeNull();
  });

  it('takes the first non-empty line as the subject, bounded', () => {
    expect(ticketSubjectOf('\n  اتصال قطع است  \nجزئیات')).toBe('اتصال قطع است');
    expect(Array.from(ticketSubjectOf('ا'.repeat(200)) ?? '')).toHaveLength(80);
    expect(ticketSubjectOf(null)).toBeNull();
  });

  it('refuses a category title that is blank, multi-line or too long', () => {
    expect(normalizeTicketCategoryTitle('  سایر ')).toBe('سایر');
    expect(normalizeTicketCategoryTitle('')).toBeNull();
    expect(normalizeTicketCategoryTitle('یک\nدو')).toBeNull();
    expect(normalizeTicketCategoryTitle('ب'.repeat(65))).toBeNull();
  });
});

describe("the bot's ticket desk vocabulary", () => {
  const tap = (data: string) => intentOf({ callback_query: { id: 'q', data } });

  it('reads /tickets and the seven callbacks, validating every id', () => {
    expect(intentOf({ message: { text: '/tickets' } }).intent).toBe('TICKETS');
    expect(tap('tkl:').intent).toBe('TICKETS');
    expect(tap('tkn:').intent).toBe('TICKET_NEW');
    expect(tap(`tkc:${TICKET}`)).toMatchObject({ intent: 'TICKET_CATEGORY', targetId: TICKET });
    expect(tap(`tkv:${TICKET}`)).toMatchObject({ intent: 'TICKET_VIEW', targetId: TICKET });
    expect(tap(`tkr:${TICKET}`)).toMatchObject({ intent: 'TICKET_REPLY', targetId: TICKET });
    expect(tap(`tkq:${TICKET}`)).toMatchObject({ intent: 'TICKET_CLOSE_ASK', targetId: TICKET });
    expect(tap(`tkx:${TICKET}`)).toMatchObject({ intent: 'TICKET_CLOSE', targetId: TICKET });
    for (const crafted of ['tkv:not-a-uuid', 'tkx:', `tkr:${TICKET}x`]) {
      expect(tap(crafted).intent, crafted).toBe('UNSUPPORTED');
    }
    // `/paysupport` is still the support screen Telegram requires.
    expect(intentOf({ message: { text: '/paysupport' } }).intent).toBe('SUPPORT');
  });

  it("gives support's reply its two buttons, derived from the subject and nothing stored", () => {
    expect(notificationButtons('TICKET_REPLY', { ticketId: TICKET })).toEqual([
      {
        label: { kind: 'TEMPLATE', key: 'bot.ticket.reply_button' },
        inline: 'tickets.reply',
        data: `tkr:${TICKET}`,
      },
      {
        label: { kind: 'TEMPLATE', key: 'bot.ticket.view_button' },
        inline: 'tickets.view',
        data: `tkv:${TICKET}`,
      },
    ]);
    expect(notificationButtons('TICKET_REPLY', {})).toEqual([]);
    expect(notificationButtons('PAYMENT_REJECTED', { ticketId: TICKET })).toEqual([]);
  });
});
