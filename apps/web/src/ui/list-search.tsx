import { useEffect, useState, type FormEvent } from 'react';
import { LIST_SEARCH_MAX_LENGTH, classifyListSearch, type ListSearchKind } from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, type Route } from '../router';
import { Button, Field, Input } from './kit';

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
  const [draft, setDraft] = useState<{ applied: string; text: string }>({ applied, text: applied });
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
    setDraft((current) => ({ applied: value, text: current.text }));
    navigate(value === '' ? null : value);
  };

  /*
   * The debounce: every change of the draft (or of the route it would be applied to — a
   * status chip pressed mid-pause) restarts the wait, and nothing is scheduled while the
   * draft already reads as the applied search. Emptying the box applies "no search", which
   * sends no `q` at all.
   */
  useEffect(() => {
    if (!autoApply || hidden || wanted === applied) return undefined;
    const timer = setTimeout(() => commit(wanted), LIST_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `commit` is rebuilt every render from `route`, which is why `route` is in the list.
  }, [autoApply, hidden, wanted, applied, route]);

  const clear = () => {
    setDraft({ applied, text: '' });
    navigate(null);
  };

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
          onChange={(event) => setDraft({ applied, text: event.target.value })}
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
