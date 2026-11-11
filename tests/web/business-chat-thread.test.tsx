import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  BUSINESS_CHAT_DETAIL_MESSAGES,
  BUSINESS_CHAT_HISTORY_PAGE,
  businessMessageSenderOf,
} from '@nexa/contracts';
import {
  BUSINESS_CHAT_REFRESH_MS,
  BusinessChatDetailPage,
} from '../../apps/web/src/pages/business-chats';
import {
  THREAD_PAGE_SIZE,
  entryMatchesFilter,
  historyHasMore,
  layoutThread,
  mergeMessages,
  oldestMessageId,
  searchEntries,
  threadEntries,
  visibleEntries,
  type ThreadMessage,
} from '../../apps/web/src/pages/business-chat-thread-model';
import { formatDate } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The business chat thread (web redesign PR-3): its own scrolling box built for 100+ messages —
 * the 50 latest first with «older» reveals, day separators, runs of one sender, handoffs
 * inline, filters, search across the whole conversation, a jump-to-latest button and a
 * composer that opens only after «در اختیار گرفتن».
 *
 * PR-10: beyond the detail's 100 messages «older» reads the history from the server, and a
 * search is the server's, over the whole conversation. `serve` below answers both as the API
 * does (newest first, 50 a page, a message-id cursor, text and speaker search).
 */

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019410ab-cdef-7012-8345-6789abcdef01';
const hex = (n: number) => n.toString(16).padStart(12, '0');
const messageId = (n: number) => `019420ab-cdef-7012-8345-${hex(n)}`;

type Origin = ThreadMessage['origin'];

/** `count` messages, one a minute from 2026-10-01 10:00Z, origins cycling customer, AI, AI, human. */
function conversation(count: number): ThreadMessage[] {
  const cycle: Origin[] = ['INBOUND', 'OWN_ECHO', 'OWN_ECHO', 'HUMAN'];
  return Array.from({ length: count }, (_, index) => ({
    id: messageId(index + 1),
    origin: cycle[index % cycle.length]!,
    kind: 'TEXT' as const,
    text: `پیام شمارهٔ ${index + 1}`,
    sentAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 0) + index * 60_000).toISOString(),
    edited: false,
    deleted: false,
  }));
}

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: CHAT_ID,
  state: 'HUMAN_ACTIVE',
  takeoverReason: null,
  handoffReason: null,
  peerTelegramUserId: '951001',
  customer: { id: CUSTOMER_ID, username: 'mary', firstName: 'مریم' },
  connectionStatus: 'ACTIVE',
  lastMessageAt: '2026-10-01T12:00:00.000Z',
  lastInboundAt: '2026-10-01T12:00:00.000Z',
  preview: null,
  unansweredSince: null,
  ticketId: null,
  ...overrides,
});

const detail = (
  messages: readonly ThreadMessage[],
  conv: Record<string, unknown> = {},
  escalations: readonly Record<string, unknown>[] = [],
) => ({
  conversation: { ...summary(conv), controlEpoch: 3, lastHumanAt: null },
  escalations,
  messages,
  outbound: [],
});

const handoff = (at: string, id = '019450ab-cdef-7012-8345-6789abcdef01') => ({
  id,
  reason: 'HANDOFF_TOPIC',
  summary: null,
  ticketId: null,
  ticketOutcome: 'NO_CUSTOMER',
  createdAt: at,
  aiFailure: null,
});

function open(
  messages: readonly ThreadMessage[],
  conv = {},
  escalations: Record<string, unknown>[] = [],
) {
  stubApi([{ url: `/business-chats/${CHAT_ID}`, body: detail(messages, conv, escalations) }]);
  renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply />);
}

type Call = { readonly path: string; readonly query: URLSearchParams };

/**
 * The API for one conversation of `all` messages: the detail with its newest 100 (oldest
 * first) and the history as the server answers it. Returns every request made.
 */
function serve(
  all: readonly ThreadMessage[],
  conv: Record<string, unknown> = {},
  escalations: Record<string, unknown>[] = [],
  /** A history request this answers with a server error. */
  fails: (query: URLSearchParams) => boolean = () => false,
): Call[] {
  const calls: Call[] = [];
  const newestFirst = [...all].sort((a, b) =>
    a.sentAt === b.sentAt ? b.id.localeCompare(a.id) : b.sentAt.localeCompare(a.sentAt),
  );
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = new URL(String(input), 'http://admin.test');
      calls.push({ path: url.pathname, query: url.searchParams });
      if (url.pathname.endsWith(`/business-chats/${CHAT_ID}/history`)) {
        if (fails(url.searchParams)) {
          return json({ error: { kind: 'internal', code: 'test.down', message: 'down' } }, 500);
        }
        const before = url.searchParams.get('before');
        const q = url.searchParams.get('q')?.toLowerCase() ?? null;
        const sender = url.searchParams.get('sender');
        let rows = newestFirst;
        if (before !== null) {
          const at = rows.findIndex((one) => one.id === before);
          if (at === -1) return json({ error: { kind: 'validation', code: 'x' } }, 400);
          rows = rows.slice(at + 1);
        }
        if (q !== null) rows = rows.filter((one) => (one.text ?? '').toLowerCase().includes(q));
        if (sender !== null) {
          rows = rows.filter((one) => businessMessageSenderOf(one.origin) === sender);
        }
        const page = rows.slice(0, BUSINESS_CHAT_HISTORY_PAGE);
        return json({
          messages: page,
          nextCursor: rows.length > page.length ? page[page.length - 1]!.id : null,
        });
      }
      if (url.pathname.endsWith(`/business-chats/${CHAT_ID}`)) {
        return json(
          detail(newestFirst.slice(0, BUSINESS_CHAT_DETAIL_MESSAGES).reverse(), conv, escalations),
        );
      }
      return json(
        { error: { kind: 'not_found', code: 'test.unrouted', message: url.pathname } },
        404,
      );
    }),
  );
  return calls;
}

const historyCalls = (calls: readonly Call[]) =>
  calls.filter((call) => call.path.endsWith('/history'));

function openServed(
  all: readonly ThreadMessage[],
  conv: Record<string, unknown> = {},
  escalations: Record<string, unknown>[] = [],
) {
  const calls = serve(all, conv, escalations);
  renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply />);
  return calls;
}

const olderButton = (n: number) =>
  screen.getByRole('button', { name: t('web.bchat_thread_older').replace('{n}', String(n)) });

const messageItems = () => items().filter((item) => item.getAttribute('data-origin') !== null);

const items = () => {
  const thread = screen.getByRole('list', { name: t('web.bchat_transcript') });
  return within(thread).getAllByRole('listitem');
};

/** Demo parity: the sender filter is one select (the demo has no chip row in a conversation). */
const chooseSender = (value: 'all' | 'customer' | 'ai' | 'operator' | 'events') =>
  fireEvent.change(screen.getByRole('combobox', { name: t('web.bchat_thread_filters') }), {
    target: { value },
  });

describe('the thread model', () => {
  const dayOf = (iso: string) => iso.slice(0, 10);
  const at = (hour: number, minute = 0, day = 1) =>
    new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
  const message = (n: number, origin: Origin, sentAt: string): ThreadMessage => ({
    id: messageId(n),
    origin,
    kind: 'TEXT',
    text: `m${n}`,
    sentAt,
    edited: false,
    deleted: false,
  });

  it('groups a run of one sender: the name on the first, the time on the last', () => {
    const rows = layoutThread(
      threadEntries(
        [
          message(1, 'INBOUND', at(10)),
          message(2, 'INBOUND', at(10, 1)),
          message(3, 'INBOUND', at(10, 2)),
          message(4, 'OWN_ECHO', at(10, 3)),
        ],
        [],
      ),
      dayOf,
    );
    const messages = rows.filter((row) => row.type === 'message');
    expect(messages.map((row) => [row.showWho, row.showTime])).toEqual([
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ]);
  });

  it('puts a day separator before the first entry of each day and breaks a run at midnight', () => {
    const rows = layoutThread(
      threadEntries([message(1, 'INBOUND', at(23, 58)), message(2, 'INBOUND', at(0, 2, 2))], []),
      dayOf,
    );
    expect(rows.map((row) => row.type)).toEqual(['day', 'message', 'day', 'message']);
    const last = rows.filter((row) => row.type === 'message');
    expect(last.map((row) => [row.showWho, row.showTime])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it('draws a handoff in its place by time and breaks the run around it', () => {
    const entries = threadEntries(
      [message(1, 'INBOUND', at(10)), message(2, 'INBOUND', at(10, 5))],
      [handoff(at(10, 2)) as never],
    );
    const rows = layoutThread(entries, dayOf);
    expect(rows.map((row) => row.type)).toEqual(['day', 'message', 'event', 'message']);
    const messages = rows.filter((row) => row.type === 'message');
    expect(messages.map((row) => [row.showWho, row.showTime])).toEqual([
      [true, true],
      [true, true],
    ]);
  });

  it('filters by who spoke: the AI side is NEXA and Telegram, the operator side a person', () => {
    const entries = threadEntries(
      (['INBOUND', 'OWN_ECHO', 'OFFLINE', 'HUMAN', 'OTHER_BOT'] as const).map((origin, index) =>
        message(index + 1, origin, at(10, index)),
      ),
      [handoff(at(10, 9)) as never],
    );
    const pick = (filter: Parameters<typeof entryMatchesFilter>[1]) =>
      entries.filter((entry) => entryMatchesFilter(entry, filter)).length;
    expect([pick('all'), pick('customer'), pick('ai'), pick('operator'), pick('events')]).toEqual([
      6, 1, 2, 2, 1,
    ]);
  });

  it('shows the newest 50 and counts the older ones held; the server may hold more', () => {
    const entries = threadEntries(conversation(120), []);
    const first = visibleEntries(entries, { filter: 'all', shown: THREAD_PAGE_SIZE, more: false });
    expect(first.entries).toHaveLength(50);
    expect([first.older, first.canLoadOlder, first.nextCount]).toEqual([70, true, 50]);
    expect(first.entries[0]!.id).toBe(messageId(71));
    const more = visibleEntries(entries, { filter: 'all', shown: 100, more: false });
    expect([more.entries.length, more.older, more.nextCount]).toEqual([100, 20, 20]);
    // Everything held is on screen: the button stays only while the server holds older ones.
    const all = visibleEntries(entries, { filter: 'all', shown: 150, more: false });
    expect([all.entries.length, all.canLoadOlder]).toEqual([120, false]);
    const server = visibleEntries(entries, { filter: 'all', shown: 150, more: true });
    expect([server.canLoadOlder, server.nextCount]).toEqual([true, 50]);
  });

  it('knows when the history may hold more: a full detail window, then the last cursor', () => {
    expect(historyHasMore(BUSINESS_CHAT_DETAIL_MESSAGES - 1, null)).toBe(false);
    expect(historyHasMore(BUSINESS_CHAT_DETAIL_MESSAGES, null)).toBe(true);
    expect(historyHasMore(0, [])).toBe(true);
    expect(historyHasMore(0, [{ messages: [], nextCursor: messageId(3) }])).toBe(true);
    expect(
      historyHasMore(0, [
        { messages: [], nextCursor: messageId(3) },
        { messages: [], nextCursor: null },
      ]),
    ).toBe(false);
  });

  it('merges the detail window and the older pages, one per id, the fresher copy winning', () => {
    const held = conversation(5);
    const edited = { ...held[4]!, text: 'ویرایش شد', edited: true };
    const merged = mergeMessages([edited, held[3]!], held);
    expect(merged.map((one) => one.id).sort()).toEqual(held.map((one) => one.id).sort());
    expect(merged.find((one) => one.id === edited.id)?.text).toBe('ویرایش شد');
    expect(oldestMessageId([held[3]!, held[1]!, held[2]!])).toBe(messageId(2));
    expect(oldestMessageId([])).toBeNull();
  });

  it('builds a search from the server’s hits and the handoffs whose label matches', () => {
    const hits = conversation(3);
    const escalation = handoff(new Date(Date.UTC(2026, 9, 1, 10, 1, 30)).toISOString()) as never;
    const eventText = () => 'سپرده شدن';
    const pick = (filter: Parameters<typeof searchEntries>[2]['filter'], query = 'سپرده') =>
      searchEntries(hits, [escalation], { filter, query, eventText }).map((one) => one.kind);
    expect(pick('all')).toEqual(['message', 'message', 'event', 'message']);
    expect(pick('events')).toEqual(['event']);
    expect(pick('customer')).toEqual(['message', 'message', 'message']);
    expect(pick('all', 'نیست')).toEqual(['message', 'message', 'message']);
  });
});

describe('the thread on the page', () => {
  it('opens with the 50 latest, reveals what it holds, then reads 50 older at a time from the server', async () => {
    // 180 messages; the detail holds the newest 100 (81–180), as the API sends it.
    const calls = openServed(conversation(180));
    expect(await screen.findByText('پیام شمارهٔ 180')).toBeTruthy();
    expect(messageItems()).toHaveLength(50);
    expect(screen.queryByText('پیام شمارهٔ 130')).toBeNull();
    expect(screen.getByText('پیام شمارهٔ 131')).toBeTruthy();

    // What is held covers the first press: no request.
    fireEvent.click(olderButton(50));
    expect(messageItems()).toHaveLength(100);
    expect(screen.getByText('پیام شمارهٔ 81')).toBeTruthy();
    expect(historyCalls(calls)).toEqual([]);

    // The next press asks the server for the 50 before the oldest held message.
    fireEvent.click(olderButton(50));
    expect(await screen.findByText('پیام شمارهٔ 31')).toBeTruthy();
    expect(screen.queryByText('پیام شمارهٔ 30')).toBeNull();
    expect(messageItems()).toHaveLength(150);
    expect(historyCalls(calls).map((call) => call.query.get('before'))).toEqual([messageId(81)]);

    // Then by the cursor the page returned, to the first message, and the button is gone.
    fireEvent.click(olderButton(50));
    expect(await screen.findByText('پیام شمارهٔ 1')).toBeTruthy();
    expect(historyCalls(calls).map((call) => call.query.get('before'))).toEqual([
      messageId(81),
      messageId(31),
    ]);
    const shown = messageItems();
    expect(shown).toHaveLength(180);
    // No gap and no duplicate: every message once, oldest first.
    expect(shown.map((item) => within(item).getByText(/^پیام شمارهٔ \d+$/u).textContent)).toEqual(
      Array.from({ length: 180 }, (_, index) => `پیام شمارهٔ ${index + 1}`),
    );
    expect(screen.queryByRole('button', { name: /پیام قدیمی‌تر/u })).toBeNull();
    for (const call of historyCalls(calls)) {
      expect(call.query.get('q')).toBeNull();
      expect(call.query.get('sender')).toBeNull();
    }
  });

  it('reveals the last held ones by their real number when the detail is the whole conversation', async () => {
    const calls = openServed(conversation(70));
    await screen.findByText('پیام شمارهٔ 70');
    fireEvent.click(olderButton(20));
    expect(messageItems()).toHaveLength(70);
    expect(screen.queryByRole('button', { name: /پیام قدیمی‌تر/u })).toBeNull();
    expect(historyCalls(calls)).toEqual([]);
  });

  it('draws no «older» button for a short conversation, and names a sender once per run', async () => {
    open(conversation(4));
    await screen.findByText('پیام شمارهٔ 4');
    expect(screen.queryByRole('button', { name: /پیام قدیمی‌تر/u })).toBeNull();
    const thread = screen.getByRole('list', { name: t('web.bchat_transcript') });
    // Messages 2 and 3 are one run of the AI side: one name, between them no time.
    expect(within(thread).getAllByText(t('web.bchat_origin_own_echo'))).toHaveLength(1);
    expect(within(thread).getAllByText(t('web.bchat_origin_inbound'))).toHaveLength(1);
  });

  it('draws one Jalali day separator per day', async () => {
    const messages = conversation(130); // 130 minutes: all on one day
    messages.push({
      ...messages[0]!,
      id: messageId(999),
      text: 'پیام روز بعد',
      sentAt: '2026-10-03T09:00:00.000Z',
    });
    open(messages);
    await screen.findByText('پیام روز بعد');
    const separators = within(
      screen.getByRole('list', { name: t('web.bchat_transcript') }),
    ).getAllByRole('separator');
    expect(separators.map((one) => one.textContent)).toEqual([
      formatDate('2026-10-01T11:30:00.000Z'),
      formatDate('2026-10-03T09:00:00.000Z'),
    ]);
  });

  it('draws a handoff inline and filters to customer, AI, operator and events', async () => {
    open(conversation(8), {}, [handoff('2026-10-01T10:02:30.000Z')]);
    await screen.findByText('پیام شمارهٔ 8');
    expect(document.querySelector('[data-event="handoff"]')).toBeTruthy();

    chooseSender('customer');
    expect(items().map((item) => item.getAttribute('data-origin'))).toEqual(['INBOUND', 'INBOUND']);

    chooseSender('ai');
    expect(new Set(items().map((item) => item.getAttribute('data-origin')))).toEqual(
      new Set(['OWN_ECHO']),
    );

    chooseSender('operator');
    expect(items().map((item) => item.getAttribute('data-origin'))).toEqual(['HUMAN', 'HUMAN']);

    chooseSender('events');
    expect(items().map((item) => item.getAttribute('data-event'))).toEqual(['handoff']);
  });

  it('searches the whole conversation on the server — older than anything held — and says how many', async () => {
    const calls = openServed(conversation(180));
    await screen.findByText('پیام شمارهٔ 180');
    expect(screen.queryByText('پیام شمارهٔ 5')).toBeNull();
    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: '  شمارهٔ 5 ' },
    });
    // 5 and 50..59: eleven hits, all older than the 100 the detail holds.
    expect(await screen.findByText('پیام شمارهٔ 5')).toBeTruthy();
    expect(screen.getByText(t('web.bchat_thread_hits').replace('{n}', '11'))).toBeTruthy();
    expect(items()).toHaveLength(11);
    const searched = historyCalls(calls);
    expect(searched.map((call) => [call.query.get('q'), call.query.get('sender')])).toEqual([
      ['شمارهٔ 5', null],
    ]);
    expect(searched[0]!.query.get('before')).toBeNull();

    // The filter's speaker goes with the words: the customer's hits only (5, 53, 57).
    chooseSender('customer');
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(new Set(items().map((item) => item.getAttribute('data-origin')))).toEqual(
      new Set(['INBOUND']),
    );
    expect(historyCalls(calls).at(-1)!.query.get('sender')).toBe('customer');

    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: 'چیزی که نیست' },
    });
    expect(await screen.findByText(t('web.bchat_thread_none'))).toBeTruthy();
  });

  it('pages a long search 50 hits at a time and says there are more until the last page', async () => {
    const calls = openServed(conversation(180));
    await screen.findByText('پیام شمارهٔ 180');
    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: 'شمارهٔ' },
    });
    expect(
      await screen.findByText(t('web.bchat_thread_hits_more').replace('{n}', '50')),
    ).toBeTruthy();
    expect(screen.getByText('پیام شمارهٔ 131')).toBeTruthy();
    fireEvent.click(olderButton(50));
    expect(await screen.findByText('پیام شمارهٔ 81')).toBeTruthy();
    fireEvent.click(olderButton(50));
    expect(await screen.findByText('پیام شمارهٔ 31')).toBeTruthy();
    fireEvent.click(olderButton(50));
    expect(await screen.findByText(t('web.bchat_thread_hits').replace('{n}', '180'))).toBeTruthy();
    expect(items()).toHaveLength(180);
    expect(screen.queryByRole('button', { name: /پیام قدیمی‌تر/u })).toBeNull();
    expect(historyCalls(calls).map((call) => call.query.get('before'))).toEqual([
      null,
      messageId(131),
      messageId(81),
      messageId(31),
    ]);
  });

  it('searches the handoffs by their label without asking the server under «events»', async () => {
    const calls = openServed(conversation(8), {}, [handoff('2026-10-01T10:02:30.000Z')]);
    await screen.findByText('پیام شمارهٔ 8');
    chooseSender('events');
    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: t('web.bchat_event_handoff') },
    });
    expect(await screen.findByText(t('web.bchat_thread_hits').replace('{n}', '1'))).toBeTruthy();
    expect(items().map((item) => item.getAttribute('data-event'))).toEqual(['handoff']);
    expect(historyCalls(calls)).toEqual([]);
  });

  it('says when an older page could not be read, and the button asks again', async () => {
    let down = true;
    const calls = serve(conversation(180), {}, [], () => down);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply />);
    await screen.findByText('پیام شمارهٔ 180');
    fireEvent.click(olderButton(50));
    fireEvent.click(olderButton(50));
    expect(await screen.findByText(t('web.bchat_thread_older_failed'))).toBeTruthy();
    expect(messageItems()).toHaveLength(100);
    down = false;
    fireEvent.click(olderButton(50));
    expect(await screen.findByText('پیام شمارهٔ 31')).toBeTruthy();
    expect(screen.queryByText(t('web.bchat_thread_older_failed'))).toBeNull();
    expect(historyCalls(calls).map((call) => call.query.get('before'))).toEqual([
      messageId(81),
      messageId(81),
    ]);
  });

  it('draws the error card with «retry» when a search could not be made', async () => {
    let down = true;
    serve(conversation(30), {}, [], () => down);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply />);
    await screen.findByText('پیام شمارهٔ 30');
    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: 'شمارهٔ 2' },
    });
    const retry = await screen.findByRole('button', { name: t('web.retry') });
    expect(screen.queryByText(t('web.bchat_thread_none'))).toBeNull();
    down = false;
    fireEvent.click(retry);
    expect(await screen.findByText(t('web.bchat_thread_hits').replace('{n}', '11'))).toBeTruthy();
  });

  it('asks nothing — not the detail, not the history — without business_chats.view', async () => {
    const calls = serve(conversation(180));
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied mayReply={false} />);
    await screen.findAllByText(t('web.no_permission'));
    expect(calls).toEqual([]);
  });

  it('shows «رفتن به آخرین پیام» once the reader scrolls up, and it scrolls back down', async () => {
    open(conversation(120));
    await screen.findByText('پیام شمارهٔ 120');
    const box = screen.getByRole('region', { name: t('web.bchat_transcript') });
    expect(screen.queryByRole('button', { name: t('web.bchat_thread_jump') })).toBeNull();
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 600 });
    box.scrollTop = 100;
    fireEvent.scroll(box);
    const jump = await screen.findByRole('button', { name: t('web.bchat_thread_jump') });
    fireEvent.click(jump);
    expect(box.scrollTop).toBe(5000);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('web.bchat_thread_jump') })).toBeNull(),
    );
  });

  it('keeps the entry being read on screen when a poll adds a message while scrolled up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open(conversation(80));
    await screen.findByText('پیام شمارهٔ 80');
    expect(screen.getByText('پیام شمارهٔ 31')).toBeTruthy();
    expect(screen.queryByText('پیام شمارهٔ 30')).toBeNull();
    const box = screen.getByRole('region', { name: t('web.bchat_transcript') });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 5000 });
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: 600 });
    box.scrollTop = 100;
    fireEvent.scroll(box);
    stubApi([{ url: `/business-chats/${CHAT_ID}`, body: detail(conversation(81)) }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUSINESS_CHAT_REFRESH_MS + 100);
    });
    await screen.findByText('پیام شمارهٔ 81');
    expect(screen.getByText('پیام شمارهٔ 31')).toBeTruthy();
    vi.useRealTimers();
  });

  it('opens its own scrolling box at the latest message', async () => {
    open(conversation(120));
    await screen.findByText('پیام شمارهٔ 120');
    const box = screen.getByRole('region', { name: t('web.bchat_transcript') });
    expect(box.className).toContain('bchat-scroll');
    // jsdom has no layout: the box was told to go to its end (scrollHeight is 0 here).
    expect(box.scrollTop).toBe(box.scrollHeight);
  });
});

describe('the composer opens only after «در اختیار گرفتن»', () => {
  it('is disabled, with the reason, while the AI holds the conversation', async () => {
    open(conversation(3), { state: 'AI_ACTIVE' });
    const box = (await screen.findByLabelText(t('web.bchat_reply_text'))) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(t('web.bchat_composer_locked'))).toBeTruthy();
    const send = screen.getByRole('button', { name: t('web.bchat_send') }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('title')).toBe(t('web.bchat_composer_locked'));
  });

  it('is disabled while a handoff waits for a person, and enabled when a person holds it', async () => {
    open(conversation(3), { state: 'HANDOFF_REQUIRED', handoffReason: 'HANDOFF_TOPIC' });
    expect(
      ((await screen.findByLabelText(t('web.bchat_reply_text'))) as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });

  it('is writable once a person holds the conversation', async () => {
    open(conversation(3), { state: 'HUMAN_ACTIVE' });
    const box = (await screen.findByLabelText(t('web.bchat_reply_text'))) as HTMLTextAreaElement;
    expect(box.disabled).toBe(false);
    expect(screen.queryByText(t('web.bchat_composer_locked'))).toBeNull();
    fireEvent.change(box, { target: { value: 'سلام' } });
    expect(
      (screen.getByRole('button', { name: t('web.bchat_send') }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
