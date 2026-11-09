import {
  BUSINESS_CHAT_DETAIL_MESSAGES,
  businessMessageSenderOf,
  type BusinessChatDetailResponse,
  type BusinessChatHistoryResponse,
  type BusinessMessageSender,
} from '@nexa/contracts';

/**
 * The shape of a business conversation's thread (web redesign PR-3): what is drawn, in what
 * order, grouped how. Pure — no React, no fetching. The page hands it the messages it holds —
 * the detail's window and the older pages of the history it read (PR-10) — and the handoffs
 * the detail carries; a search's hits come from the server, which searches the whole
 * conversation.
 */

export type ThreadMessage = BusinessChatDetailResponse['messages'][number];
export type ThreadEscalation = BusinessChatDetailResponse['escalations'][number];

/** The chips over the thread. «events» are the handoffs; the rest filter by who spoke. */
export const THREAD_FILTERS = ['all', 'customer', 'ai', 'operator', 'events'] as const;
export type ThreadFilter = (typeof THREAD_FILTERS)[number];

/** How many entries are drawn first, and how many each «older» press reveals. */
export const THREAD_PAGE_SIZE = 50;

/** The speaker a filter asks the history's search for; null asks for every speaker. */
export const THREAD_FILTER_SENDER: Readonly<Record<ThreadFilter, BusinessMessageSender | null>> = {
  all: null,
  customer: 'customer',
  ai: 'ai',
  operator: 'operator',
  events: null,
};

export type ThreadEntry =
  | {
      readonly kind: 'message';
      readonly id: string;
      readonly at: string;
      readonly message: ThreadMessage;
    }
  | {
      readonly kind: 'event';
      readonly id: string;
      readonly at: string;
      readonly escalation: ThreadEscalation;
    };

/** Oldest first, as a chat reads; ties by id so two polls draw the same order. */
export function threadEntries(
  messages: readonly ThreadMessage[],
  escalations: readonly ThreadEscalation[],
): ThreadEntry[] {
  const entries: ThreadEntry[] = [
    ...messages.map(
      (message) => ({ kind: 'message', id: message.id, at: message.sentAt, message }) as const,
    ),
    ...escalations.map(
      (escalation) =>
        ({ kind: 'event', id: escalation.id, at: escalation.createdAt, escalation }) as const,
    ),
  ];
  return entries.sort((a, b) =>
    a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at),
  );
}

/**
 * Who a message belongs to, for the filter: the contract's speaker groups
 * (`businessMessageSenderOf`), the same the server's search uses. The customer is `INBOUND`;
 * what this bot or Telegram sent by itself (`OWN_ECHO`, `OFFLINE`) is the automatic side; a
 * person speaking for the account (`HUMAN`, `OTHER_BOT`) is the operator side.
 */
export function entryMatchesFilter(entry: ThreadEntry, filter: ThreadFilter): boolean {
  if (filter === 'all') return true;
  if (entry.kind === 'event') return filter === 'events';
  return THREAD_FILTER_SENDER[filter] === businessMessageSenderOf(entry.message.origin);
}

/** Case-insensitive substring over the entry's own words; an event is searched by `eventText`. */
export function entryMatchesQuery(
  entry: ThreadEntry,
  query: string,
  eventText: (escalation: ThreadEscalation) => string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack =
    entry.kind === 'event' ? eventText(entry.escalation) : (entry.message.text ?? '');
  return haystack.toLowerCase().includes(needle);
}

export type ThreadRow =
  | { readonly type: 'day'; readonly key: string; readonly at: string }
  | {
      readonly type: 'event';
      readonly key: string;
      readonly entry: Extract<ThreadEntry, { kind: 'event' }>;
    }
  | {
      readonly type: 'message';
      readonly key: string;
      readonly entry: Extract<ThreadEntry, { kind: 'message' }>;
      /** The sender's name is drawn on the first message of a run only. */
      readonly showWho: boolean;
      /** The time is drawn on the last message of a run only. */
      readonly showTime: boolean;
    };

/**
 * Day separators, handoffs inline, and runs: consecutive messages from one origin on one day,
 * with nothing between them, are a run (name once, time on the last).
 */
export function layoutThread(
  entries: readonly ThreadEntry[],
  dayOf: (iso: string) => string,
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  let lastDay = '';
  entries.forEach((entry, index) => {
    const day = dayOf(entry.at);
    if (day !== lastDay) {
      rows.push({ type: 'day', key: `day-${day}-${entry.id}`, at: entry.at });
      lastDay = day;
    }
    if (entry.kind === 'event') {
      rows.push({ type: 'event', key: entry.id, entry });
      return;
    }
    const previous = entries[index - 1];
    const next = entries[index + 1];
    const sameRun = (other: ThreadEntry | undefined): boolean =>
      other !== undefined &&
      other.kind === 'message' &&
      other.message.origin === entry.message.origin &&
      dayOf(other.at) === day;
    rows.push({
      type: 'message',
      key: entry.id,
      entry,
      showWho: !sameRun(previous),
      showTime: !sameRun(next),
    });
  });
  return rows;
}

/**
 * The messages the thread holds: the detail's window (the fresher copy of a message, so an
 * edit or a deletion shows) and the older pages the history returned, one entry per id.
 */
export function mergeMessages(
  fresh: readonly ThreadMessage[],
  older: readonly ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  for (const message of older) byId.set(message.id, message);
  for (const message of fresh) byId.set(message.id, message);
  return [...byId.values()];
}

/**
 * Whether the server may hold messages older than the thread has: before any history page
 * was read, only when the detail's window was full (a shorter one is the whole conversation);
 * after, when the last page named a next cursor.
 */
export function historyHasMore(
  detailMessages: number,
  pages: readonly BusinessChatHistoryResponse[] | null,
): boolean {
  if (pages === null) return detailMessages >= BUSINESS_CHAT_DETAIL_MESSAGES;
  const last = pages[pages.length - 1];
  return last === undefined || last.nextCursor !== null;
}

/** The oldest message the thread holds — the history's first cursor. */
export function oldestMessageId(messages: readonly ThreadMessage[]): string | null {
  let oldest: ThreadMessage | null = null;
  for (const message of messages) {
    if (
      oldest === null ||
      message.sentAt < oldest.sentAt ||
      (message.sentAt === oldest.sentAt && message.id < oldest.id)
    ) {
      oldest = message;
    }
  }
  return oldest?.id ?? null;
}

/**
 * The entries to draw when nothing is searched: the filter, then only the newest `shown`.
 * `older` counts the held entries left above; `more` says the server holds older ones still,
 * so the «older» button stays, and `nextCount` is what it would reveal.
 */
export function visibleEntries(
  entries: readonly ThreadEntry[],
  options: { readonly filter: ThreadFilter; readonly shown: number; readonly more: boolean },
): {
  readonly entries: ThreadEntry[];
  readonly older: number;
  readonly canLoadOlder: boolean;
  readonly nextCount: number;
} {
  const matching = entries.filter((entry) => entryMatchesFilter(entry, options.filter));
  const start = Math.max(0, matching.length - options.shown);
  return {
    entries: matching.slice(start),
    older: start,
    canLoadOlder: start > 0 || options.more,
    nextCount: options.more ? THREAD_PAGE_SIZE : Math.min(THREAD_PAGE_SIZE, start),
  };
}

/**
 * A search's entries, oldest first: the server's hits (it searched the whole conversation by
 * text and by the filter's speaker; none are asked for under «events») and the handoffs whose
 * label holds the words, under «all» and «events».
 */
export function searchEntries(
  hits: readonly ThreadMessage[],
  escalations: readonly ThreadEscalation[],
  options: {
    readonly filter: ThreadFilter;
    readonly query: string;
    readonly eventText: (escalation: ThreadEscalation) => string;
  },
): ThreadEntry[] {
  const messages = options.filter === 'events' ? [] : hits;
  const events =
    options.filter === 'all' || options.filter === 'events'
      ? escalations.filter((escalation) =>
          entryMatchesQuery(
            { kind: 'event', id: escalation.id, at: escalation.createdAt, escalation },
            options.query,
            options.eventText,
          ),
        )
      : [];
  return threadEntries(messages, events);
}
