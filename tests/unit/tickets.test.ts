import { describe, expect, it } from 'vitest';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_MACHINE,
  TICKET_STATUSES,
  normalizeTicketCategoryTitle,
  normalizeTicketText,
  ticketAttachmentRefusal,
  ticketManualEvent,
  ticketStatusAfterMessage,
  ticketSubjectOf,
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
      { label: { kind: 'TEMPLATE', key: 'bot.ticket.reply_button' }, data: `tkr:${TICKET}` },
      { label: { kind: 'TEMPLATE', key: 'bot.ticket.view_button' }, data: `tkv:${TICKET}` },
    ]);
    expect(notificationButtons('TICKET_REPLY', {})).toEqual([]);
    expect(notificationButtons('PAYMENT_REJECTED', { ticketId: TICKET })).toEqual([]);
  });
});
