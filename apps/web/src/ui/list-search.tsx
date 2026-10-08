import { useEffect, useState, type FormEvent } from 'react';
import { LIST_SEARCH_MAX_LENGTH, classifyListSearch, type ListSearchKind } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, type Route } from '../router';
import { Button, Field, IconButton, Input } from './kit';

/**
 * The ONE free-text search box a list page draws (spec §10).
 *
 * It replaced a row of single-purpose boxes on each list — a Telegram-id box and a
 * username box on `/users`, internal-uuid boxes on `/orders`, `/payments` and
 * `/services` — and with them the commonest dead end those pages had: an operator pasting
 * the Telegram id they had in front of them into a box that wanted an internal uuid. The
 * operator types what they have; the SERVER decides what it is (`classifyListSearch`),
 * and the line under the box says how it was read, from the same function, so nobody has
 * to guess why a search found nothing.
 *
 * Non-text filters (status, method, gateway…) stay as their own controls on each page.
 *
 * The search lives in the URL as `q`, so a found row can be reloaded and linked; the
 * draft lives in state, so a keystroke on its own issues no request. The draft FOLLOWS the
 * applied value — derived, not initialised — because the sidebar link re-renders a page with
 * an empty query instead of remounting it (`users.tsx` records that defect).
 *
 * With `autoApply` (UX batch 02, issue 13; `/users` today) the draft is applied by itself
 * once it has been still for `LIST_SEARCH_DEBOUNCE_MS`: typing or pasting searches, and a
 * burst of keystrokes is ONE navigation and so one request. Enter and the button still apply
 * at once. What keeps an older answer from replacing a newer one is not here: the applied
 * text is part of the page's query key, so a slow response for a superseded term lands in
 * that term's cache entry and is never drawn under the current one.
 */
export const LIST_SEARCH_PARAM = 'q';

/**
 * How long the box waits after the last keystroke before applying it. The app had no
 * convention; 400 ms sits in the middle of the 300–500 ms the owner asked for — long enough
 * that a Telegram id typed at speed is one request, short enough to read as immediate.
 */
export const LIST_SEARCH_DEBOUNCE_MS = 400;

const KIND_LABELS: Readonly<Record<ListSearchKind, WebKey>> = {
  TELEGRAM_ID: 'web.list_search_reads_telegram',
  UUID: 'web.list_search_reads_id',
  USERNAME: 'web.list_search_reads_username',
  TEXT: 'web.list_search_reads_text',
};

/** The applied search, from the URL: the one value a page puts in its query key and request. */
export function appliedListSearch(route: Route): string {
  return route.query.get(LIST_SEARCH_PARAM) ?? '';
}

/*
 * «پاک کردن همهٔ فیلترها» also empties the box (review of #242, N5). Clearing navigates,
 * which cancels a pending automatic apply by design — but the half-typed text stayed in the
 * box while no search was applied, suggesting a filter that was not in force. The button
 * and the box share no parent state, so the button tells every mounted box to drop its
 * draft; there is one per page.
 */
const draftResets = new Set<() => void>();

function resetSearchDrafts(): void {
  for (const reset of draftResets) reset();
}

export function ListSearchBox({
  route,
  id,
  hint,
  hidden = false,
  resetKeys = [],
  autoApply = false,
}: {
  route: Route;
  /** The input's DOM id; one box per page, so a page-specific id. */
  id: string;
  /** What this LIST matches the text against — each list says it in its own words. */
  hint: string;
  hidden?: boolean;
  /**
   * URL keys a new search must clear, such as a cursor held in the URL: a cursor minted
   * under one search strands every row before it under another.
   */
  resetKeys?: readonly string[];
  /** Apply the draft by itself after `LIST_SEARCH_DEBOUNCE_MS` of stillness (see above). */
  autoApply?: boolean;
}) {
  const applied = appliedListSearch(route);
  /** The whole URL the box sits under, so the draft knows which one it was typed against. */
  const routeKey = `${route.path}?${route.query.toString()}`;
  /*
   * `at` is the route the draft was last edited under. The automatic apply runs only while
   * the route is still that one: a navigation the box did not make — the sidebar «کاربران»
   * link, a status chip — cancels a pending apply instead of carrying the half-typed text
   * into the new list a moment later (which would defeat the link meant to reset it). The
   * text stays in the box, unapplied, exactly as before auto-search existed; the next
   * keystroke or Enter applies it under the new route.
   */
  const [draft, setDraft] = useState<{ applied: string; text: string; at: string }>({
    applied,
    text: applied,
    at: routeKey,
  });
  /*
   * An input method (Persian, among others) fires `change` with a half-composed word; a
   * pause mid-composition must not search for it. Nothing is scheduled while composing, and
   * the end of the composition schedules the finished word.
   */
  const [composing, setComposing] = useState(false);
  const text = draft.applied === applied ? draft.text : applied;
  const term = classifyListSearch(text);
  /** What applying the draft would put in the URL: trimmed, and `''` for "no search". */
  const wanted = term === null ? '' : text.trim();

  const navigate = (value: string | null) =>
    setQueries(route, [
      [LIST_SEARCH_PARAM, value],
      ...resetKeys.map((key) => [key, null] as const),
    ]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    navigate(wanted === '' ? null : wanted);
  };

  /*
   * The automatic apply records the value it applies AS the draft's own `applied`, so the URL
   * catching up does not reset the box to the trimmed value: an operator who paused after
   * `ali ` and typed on would otherwise watch the space vanish under the caret and get
   * `alir`. (An explicit Enter or button press keeps showing the trimmed search it applied,
   * as it always has: the operator has finished typing.)
   */
  const commit = (value: string) => {
    setDraft((current) => ({ ...current, applied: value }));
    navigate(value === '' ? null : value);
  };

  /*
   * The debounce: every change of the draft restarts the wait; nothing is scheduled while
   * the draft already reads as the applied search, while composing, or once the route has
   * moved away from the one the draft was typed under (see `at`). Any of those changing
   * clears the pending timer — which is also why Enter, by changing `applied`, cancels it.
   * Emptying the box applies "no search", which sends no `q` at all.
   */
  const typedHere = draft.at === routeKey;
  useEffect(() => {
    if (!autoApply || hidden || composing || !typedHere || wanted === applied) return undefined;
    const timer = setTimeout(() => commit(wanted), LIST_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `commit` closes over this render's `route`, which `routeKey` stands for in the list.
  }, [autoApply, hidden, composing, typedHere, wanted, applied, routeKey]);

  const clear = () => {
    setDraft({ applied, text: '', at: routeKey });
    navigate(null);
  };

  useEffect(() => {
    const reset = () => setDraft((current) => ({ ...current, applied: '', text: '' }));
    draftResets.add(reset);
    return () => {
      draftResets.delete(reset);
    };
  }, []);

  return (
    <form className="toolbar ca-search" onSubmit={apply} hidden={hidden} role="search">
      <Field compact label={t('web.list_search_label')} hint={hint} htmlFor={id}>
        <Input
          id={id}
          size="sm"
          // Persian names and Latin ids both arrive here; the browser picks the direction.
          dir="auto"
          type="search"
          maxLength={LIST_SEARCH_MAX_LENGTH}
          value={text}
          onChange={(event) => setDraft({ applied, text: event.target.value, at: routeKey })}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
        />
      </Field>
      {term !== null && (
        <span className="muted small" data-testid="list-search-kind">
          {t(KIND_LABELS[term.kind])}
        </span>
      )}
      <div className="ca-search-actions">
        <Button type="submit" variant="primary" size="sm" icon="search">
          {t('web.users_search_apply')}
        </Button>
        <Button variant="ghost" size="sm" onClick={clear} disabled={applied === '' && text === ''}>
          {t('web.users_search_clear')}
        </Button>
      </div>
    </form>
  );
}

/**
 * «پاک کردن همهٔ فیلترها»: one press back to the unfiltered list (roadmap B4).
 *
 * Drawn only while one of `keys` is in the URL — a reset with nothing to reset is noise. A
 * list's filters live in the URL beside its search, so clearing is one navigation: every
 * key (and any `cursor` the page keeps there) goes in the same `setQueries`, never one
 * `setQuery` per key (`router.ts` says why). The page passes the keys it filters on,
 * the search's `q` included.
 */
export function ClearFiltersButton({
  route,
  keys,
  hidden = false,
}: {
  route: Route;
  keys: readonly string[];
  hidden?: boolean;
}) {
  const active = keys.some((key) => (route.query.get(key) ?? '') !== '');
  if (!active || hidden) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon="x"
      onClick={() => {
        resetSearchDrafts();
        setQueries(
          route,
          [...keys, 'cursor'].map((key) => [key, null] as const),
        );
      }}
    >
      {t('web.list_filters_clear')}
    </Button>
  );
}

/** Time with seconds: a refresh within the same minute must still visibly change. */
const READ_AT = new Intl.DateTimeFormat('fa-IR', {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

/**
 * How fresh a list is, and a way to ask again (roadmap B1, data freshness).
 *
 * The queue lists do not poll and do not refetch on window focus, so an operator who left
 * /tickets open read a list of unknown age with nothing saying so. This states when the
 * rows were read — the query's own `dataUpdatedAt`, never the time of the render — and
 * offers a refresh that re-reads the same page under the same filters.
 *
 * Accessibility (review of #242, N6):
 * - the `aria-live` region stays mounted from the start and only its TEXT changes, so the
 *   new read time is announced (a region inserted with its text usually is not);
 * - the button is never `disabled` — that would drop a keyboard user's focus to the page —
 *   it says `aria-busy` while reading and ignores a press until the read settles;
 * - the time has seconds, so a refresh within the same minute visibly changes it.
 */
export function ListFreshness({
  query,
  hidden = false,
}: {
  query: { dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown };
  hidden?: boolean;
}) {
  const shown = !hidden && query.dataUpdatedAt !== 0;
  return (
    <span className="list-freshness">
      <span className="muted small" aria-live="polite" data-testid="list-read-at">
        {shown
          ? t('web.list_read_at').replace('{time}', READ_AT.format(new Date(query.dataUpdatedAt)))
          : ''}
      </span>
      {shown && (
        <IconButton
          icon="refresh"
          size="sm"
          label={query.isFetching ? t('web.list_refreshing') : t('web.list_refresh')}
          aria-busy={query.isFetching}
          onClick={() => {
            if (!query.isFetching) void query.refetch();
          }}
        />
      )}
    </span>
  );
}
