import type { BusinessChatDetailResponse } from '@nexa/contracts';

/**
 * The shape of a business conversation's thread (web redesign PR-3): what is drawn, in what
 * order, grouped how. Pure — no React, no fetching. The page hands it the messages and the
 * handoffs the detail response ALREADY carries; nothing here asks the server for more.
 */

export type ThreadMessage = BusinessChatDetailResponse['messages'][number];
export type ThreadEscalation = BusinessChatDetailResponse['escalations'][number];

/** The chips over the thread. «events» are the handoffs; the rest filter by who spoke. */
export const THREAD_FILTERS = ['all', 'customer', 'ai', 'operator', 'events'] as const;
export type ThreadFilter = (typeof THREAD_FILTERS)[number];

/** How many entries are drawn first, and how many each «older» press reveals. */
export const THREAD_PAGE_SIZE = 50;

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
 * Who a message belongs to, for the filter. The customer is `INBOUND`. Everything this bot or
 * Telegram sent by itself (`OWN_ECHO`, `OFFLINE`) is the automatic side; a person speaking
 * for the account (`HUMAN`, `OTHER_BOT`) is the operator side.
 */
export function entryMatchesFilter(entry: ThreadEntry, filter: ThreadFilter): boolean {
  if (filter === 'all') return true;
  if (entry.kind === 'event') return filter === 'events';
  switch (filter) {
    case 'customer':
      return entry.message.origin === 'INBOUND';
    case 'ai':
      return entry.message.origin === 'OWN_ECHO' || entry.message.origin === 'OFFLINE';
    case 'operator':
      return entry.message.origin === 'HUMAN' || entry.message.origin === 'OTHER_BOT';
    default:
      return false;
  }
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
 * The entries to draw: the filter first, then — when nothing is searched — only the newest
 * `shown`. A search looks through the WHOLE conversation and shows every hit.
 */
export function visibleEntries(
  entries: readonly ThreadEntry[],
  options: {
    readonly filter: ThreadFilter;
    readonly query: string;
    readonly shown: number;
    readonly eventText: (escalation: ThreadEscalation) => string;
  },
): { readonly entries: ThreadEntry[]; readonly older: number; readonly hits: number | null } {
  const searching = options.query.trim() !== '';
  const matching = entries.filter(
    (entry) =>
      entryMatchesFilter(entry, options.filter) &&
      entryMatchesQuery(entry, options.query, options.eventText),
  );
  if (searching) return { entries: matching, older: 0, hits: matching.length };
  const start = Math.max(0, matching.length - options.shown);
  return { entries: matching.slice(start), older: start, hits: null };
}
