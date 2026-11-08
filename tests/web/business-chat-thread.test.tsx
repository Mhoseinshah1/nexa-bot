import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BusinessChatDetailPage } from '../../apps/web/src/pages/business-chats';
import {
  THREAD_PAGE_SIZE,
  entryMatchesFilter,
  layoutThread,
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

const items = () => {
  const thread = screen.getByRole('list', { name: t('web.bchat_transcript') });
  return within(thread).getAllByRole('listitem');
};

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

  it('shows the newest 50 and counts the older ones; a search looks at all of them', () => {
    const entries = threadEntries(conversation(120), []);
    const eventText = () => '';
    const first = visibleEntries(entries, {
      filter: 'all',
      query: '',
      shown: THREAD_PAGE_SIZE,
      eventText,
    });
    expect(first.entries).toHaveLength(50);
    expect(first.older).toBe(70);
    expect(first.entries[0]!.id).toBe(messageId(71));
    const more = visibleEntries(entries, { filter: 'all', query: '', shown: 100, eventText });
    expect([more.entries.length, more.older]).toEqual([100, 20]);
    const found = visibleEntries(entries, {
      filter: 'all',
      query: 'شمارهٔ 3',
      shown: 50,
      eventText,
    });
    expect(found.hits).toBe(11);
    expect(found.older).toBe(0);
  });
});

describe('the thread on the page', () => {
  it('opens with the 50 latest messages and reveals fifty older ones at a time', async () => {
    open(conversation(120));
    expect(await screen.findByText('پیام شمارهٔ 120')).toBeTruthy();
    expect(items().filter((item) => item.getAttribute('data-origin') !== null)).toHaveLength(50);
    expect(screen.queryByText('پیام شمارهٔ 70')).toBeNull();
    expect(screen.getByText('پیام شمارهٔ 71')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: t('web.bchat_thread_older').replace('{n}', '50') }),
    );
    expect(items().filter((item) => item.getAttribute('data-origin') !== null)).toHaveLength(100);
    expect(screen.getByText('پیام شمارهٔ 21')).toBeTruthy();

    // 20 are left: the button names the real number, and then it is gone.
    fireEvent.click(
      screen.getByRole('button', { name: t('web.bchat_thread_older').replace('{n}', '20') }),
    );
    expect(items().filter((item) => item.getAttribute('data-origin') !== null)).toHaveLength(120);
    expect(screen.queryByRole('button', { name: /پیام قدیمی‌تر/u })).toBeNull();
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
    const chips = screen.getByRole('group', { name: t('web.bchat_thread_filters') });

    fireEvent.click(within(chips).getByRole('button', { name: t('web.bchat_tf_customer') }));
    expect(items().map((item) => item.getAttribute('data-origin'))).toEqual(['INBOUND', 'INBOUND']);

    fireEvent.click(within(chips).getByRole('button', { name: t('web.bchat_tf_ai') }));
    expect(new Set(items().map((item) => item.getAttribute('data-origin')))).toEqual(
      new Set(['OWN_ECHO']),
    );

    fireEvent.click(within(chips).getByRole('button', { name: t('web.bchat_tf_operator') }));
    expect(items().map((item) => item.getAttribute('data-origin'))).toEqual(['HUMAN', 'HUMAN']);

    fireEvent.click(within(chips).getByRole('button', { name: t('web.bchat_tf_events') }));
    expect(items().map((item) => item.getAttribute('data-event'))).toEqual(['handoff']);
  });

  it('searches the whole conversation, not just the 50 on screen, and says how many', async () => {
    open(conversation(120));
    await screen.findByText('پیام شمارهٔ 120');
    expect(screen.queryByText('پیام شمارهٔ 5')).toBeNull();
    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: 'شمارهٔ 5' },
    });
    // 5 and 50..59: eleven hits, though only 71..120 were on screen.
    expect(screen.getByText('پیام شمارهٔ 5')).toBeTruthy();
    expect(screen.getByText(t('web.bchat_thread_hits').replace('{n}', '11'))).toBeTruthy();
    expect(items()).toHaveLength(11);

    fireEvent.change(screen.getByLabelText(t('web.bchat_thread_search')), {
      target: { value: 'چیزی که نیست' },
    });
    expect(screen.getByText(t('web.bchat_thread_none'))).toBeTruthy();
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
