import { useState, type FormEvent } from 'react';
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
 * draft lives in state, so typing issues no request. The draft FOLLOWS the applied value —
 * derived, not initialised — because the sidebar link re-renders a page with an empty
 * query instead of remounting it (`users.tsx` records that defect).
 */
export const LIST_SEARCH_PARAM = 'q';

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
}) {
  const applied = appliedListSearch(route);
  const [draft, setDraft] = useState<{ applied: string; text: string }>({ applied, text: applied });
  const text = draft.applied === applied ? draft.text : applied;
  const term = classifyListSearch(text);

  const navigate = (value: string | null) =>
    setQueries(route, [
      [LIST_SEARCH_PARAM, value],
      ...resetKeys.map((key) => [key, null] as const),
    ]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    navigate(term === null ? null : text.trim());
  };

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
