import { memo, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONTROL_ERROR_CODES,
  TEMPLATE_CATEGORIES,
  coerceTemplateValue,
  templateCategoryOf,
  type TemplateCategory,
  type PlaceholderDefinition,
  type TemplateViewResponse,
} from '@nexa/contracts';
import {
  ApiError,
  fetchTemplateRevisions,
  fetchTemplates,
  previewTemplate,
  revertTemplate,
  saveTemplate,
} from '../api/client';
import { formatNumber, formatTimestamp } from '../format';
import { finalAnswer } from '../polling';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import {
  TEMPLATE_GROUPS,
  matchesTemplateSearch,
  placeholderLabel,
  placeholderTypeLabel,
  templateCopy,
  templateGroupOf,
  type TemplateGroup,
} from '../template-copy';
import { ErrorReport } from './settings';
import { DirtyScope, UnsavedCount, useDirtySet, useReportDirty } from './ops-b-layout';
import {
  Disclosure,
  Badge,
  Banner,
  Card,
  Ltr,
  Num,
  PageHead,
  Pills,
  StateSwitch,
  useUnsavedChanges,
} from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * What a sample value has to look like in a text field, per declared type.
 *
 * The server coerces text into the declared type (`coerceTemplateValues`), so
 * the form has to say what it expects. Before that coercion existed, a NUMBER
 * placeholder was rejected on every attempt and a DATETIME or MONEY one could
 * not be supplied at all — the field could only send a string.
 */
const SAMPLE_HINTS: Partial<Record<TemplateViewResponse['placeholders'][number]['type'], WebKey>> =
  {
    NUMBER: 'web.sample_number',
    DURATION_DAYS: 'web.sample_days',
    BYTES: 'web.sample_bytes',
    TRAFFIC_LIMIT: 'web.sample_traffic_limit',
    DATETIME: 'web.sample_datetime',
    MONEY: 'web.sample_money',
  };

type SourceFilter = 'all' | 'custom' | 'default';

/**
 * UX Batch 01, item 5: the domain categories the screen offers, from the contract
 * (`TEMPLATE_CATEGORIES`, `templateCategoryOf`) — never a list of its own. `other` holds only
 * a key a newer server sends that this build's contract does not categorise; every key this
 * build knows has a category (`tests/unit/template-categories.test.ts`).
 */
type CategoryFilter = 'all' | TemplateCategory | 'other';

export const TEMPLATE_CATEGORY_LABEL: Readonly<Record<TemplateCategory | 'other', WebKey>> = {
  general: 'web.tcat_general',
  purchase: 'web.tcat_purchase',
  payment: 'web.tcat_payment',
  wallet: 'web.tcat_wallet',
  services: 'web.tcat_services',
  service_changes: 'web.tcat_service_changes',
  errors: 'web.tcat_errors',
  support: 'web.tcat_support',
  notifications: 'web.tcat_notifications',
  referral: 'web.tcat_referral',
  terms: 'web.tcat_terms',
  tutorials: 'web.tcat_tutorials',
  channels: 'web.tcat_channels',
  trial: 'web.tcat_trial',
  admin: 'web.tcat_admin',
  operations: 'web.tcat_operations',
  other: 'web.tcat_other',
};

/** The category a key is shown under; a key this build cannot place goes to `other`. */
export function templateCategoryFilterOf(key: string): TemplateCategory | 'other' {
  return templateCategoryOf(key) ?? 'other';
}

/**
 * Whether this tenant has its own text for a template: a STORED override, applied or not.
 *
 * Not `source === 'TENANT'`. With the `template_overrides` feature off the server answers
 * `source: 'DEFAULT'` and the default as `body` while keeping the tenant's text in
 * `overrideBody` — and the editor shows that text, with the suppressed warning. Deciding
 * by `source` filed such a template under «پیش‌فرض» while its card showed customised text.
 * The filters, the badge and the default-body disclosure all use this one rule.
 */
function isCustomised(template: TemplateViewResponse): boolean {
  return template.overrideBody !== null;
}

/** One section of the screen and the templates in it, in catalogue order. */
interface TemplateSection {
  readonly group: TemplateGroup;
  readonly templates: readonly TemplateViewResponse[];
}

/**
 * The template screen.
 *
 * The editor is populated from `overrideBody` when there is one and from
 * `defaultBody` otherwise — both RAW, both with their placeholders intact.
 * Nothing rendered is ever put in the edit field, which is the entire defence
 * against the legacy screen: there the edit prompt shows the RENDERED text, so
 * `{first_name}` appears as the viewing administrator's own name and saving that
 * view would store it.
 *
 * The preview is a separate, explicitly-labelled call with values the
 * administrator types, and it stores nothing.
 *
 * Every card is titled with its Persian name (`template-copy.ts`) and grouped into
 * sections; the raw key stays on the card as a small technical detail. The search
 * and the filters HIDE cards rather than unmounting them: a card holds its operator's
 * unsaved draft in its own state, and a filter that unmounted it would silently throw
 * that draft away the moment somebody searched for something else.
 */
export function ContentPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: fetchTemplates,
    enabled: !denied,
  });
  const rows = useMemo(() => templates.data?.templates ?? [], [templates.data]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [groupId, setGroupId] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');

  const sections = useMemo<TemplateSection[]>(() => {
    const byGroup = new Map<string, TemplateViewResponse[]>();
    for (const template of rows) {
      const id = templateGroupOf(template.key).id;
      byGroup.set(id, [...(byGroup.get(id) ?? []), template]);
    }
    return TEMPLATE_GROUPS.filter((group) => byGroup.has(group.id)).map((group) => ({
      group,
      templates: byGroup.get(group.id) ?? [],
    }));
  }, [rows]);

  /*
   * What the search and the source filter match, in EVERY category: the category chips
   * count from it, so an operator searching inside one category sees where else the words
   * are, and can widen the search to all of them with one tap.
   */
  const matching = useMemo(() => {
    const shown = new Set<string>();
    for (const template of rows) {
      if (source === 'custom' && !isCustomised(template)) continue;
      if (source === 'default' && isCustomised(template)) continue;
      const copy = templateCopy(template.key, template.description);
      // The text the EDITOR shows, not `body`: with overrides switched off `body` is
      // the default, while the textarea holds the stored override.
      const editable = template.overrideBody ?? template.defaultBody;
      const haystack = [copy.name, copy.description, template.key, editable];
      if (matchesTemplateSearch(search, haystack)) shown.add(template.key);
    }
    return shown;
  }, [rows, search, source]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<TemplateCategory | 'other', number>();
    for (const key of matching) {
      const id = templateCategoryFilterOf(key);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [matching]);
  // Every category in contract order; `other` only when a key actually lands there.
  const categories = useMemo<(TemplateCategory | 'other')[]>(
    () => [
      ...TEMPLATE_CATEGORIES,
      ...(rows.some((template) => templateCategoryOf(template.key) === null)
        ? (['other'] as const)
        : []),
    ],
    [rows],
  );
  const inCategory = (key: string) =>
    category === 'all' || templateCategoryFilterOf(key) === category;

  // The sections that have a template in the chosen category: the section filter's choices.
  const categorySections = useMemo(
    () =>
      sections.filter((section) =>
        section.templates.some(
          (template) => category === 'all' || templateCategoryFilterOf(template.key) === category,
        ),
      ),
    [sections, category],
  );
  // A section chosen in another category does not silently empty this one.
  const activeGroupId = categorySections.some((section) => section.group.id === groupId)
    ? groupId
    : '';

  const visible = useMemo(() => {
    const shown = new Set<string>();
    for (const section of sections) {
      if (activeGroupId !== '' && section.group.id !== activeGroupId) continue;
      for (const template of section.templates) {
        if (!matching.has(template.key)) continue;
        if (category !== 'all' && templateCategoryFilterOf(template.key) !== category) continue;
        shown.add(template.key);
      }
    }
    return shown;
  }, [sections, activeGroupId, matching, category]);
  // Matches the search finds outside the chosen category.
  const elsewhere = [...matching].filter((key) => !inCategory(key)).length;

  const chooseCategory = (next: CategoryFilter) => {
    setCategory(next);
    setGroupId('');
  };

  const clearFilters = () => {
    setSearch('');
    setCategory('all');
    setGroupId('');
    setSource('all');
  };

  /*
   * The template open in the editor column. Every card stays MOUNTED and only the chosen
   * one is shown, for the reason the filters hide rather than unmount: a card holds its
   * operator's unsaved draft in its own state. A choice the filters have since hidden
   * falls back to the first template still listed, so the editor never shows a template
   * the list does not.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const ordered = useMemo(() => sections.flatMap((section) => section.templates), [sections]);
  const firstVisible = ordered.find((template) => visible.has(template.key))?.key ?? null;
  const selected = chosen !== null && visible.has(chosen) ? chosen : firstVisible;

  const { dirty, report } = useDirtySet();
  useUnsavedChanges(dirty.size > 0);

  return (
    <>
      <PageHead
        title={t('web.templates_title')}
        subtitle={t('web.templates_intro')}
        badge={<UnsavedCount count={dirty.size} />}
      />
      <StateSwitch query={templates} denied={denied} isEmpty={rows.length === 0}>
        <DirtyScope report={report}>
          <nav className="card tcat-bar" aria-label={t('web.templates_categories')}>
            <div className="tcat-chips" role="group" aria-label={t('web.templates_categories')}>
              <CategoryChip
                id="all"
                label={t('web.templates_category_all')}
                count={matching.size}
                current={category === 'all'}
                onSelect={chooseCategory}
              />
              {categories.map((id) => (
                <CategoryChip
                  key={id}
                  id={id}
                  label={t(TEMPLATE_CATEGORY_LABEL[id])}
                  count={categoryCounts.get(id) ?? 0}
                  current={category === id}
                  onSelect={chooseCategory}
                />
              ))}
            </div>
          </nav>
          <div className="content-split">
            <aside className="card content-nav" aria-label={t('web.templates_list')}>
              <div className="content-nav-tools">
                <label className="visually-hidden" htmlFor="templates-search">
                  {t('web.templates_search')}
                </label>
                <div className="search">
                  <Icon name="search" size={14} />
                  <input
                    id="templates-search"
                    type="search"
                    className="input"
                    value={search}
                    placeholder={t('web.templates_search_placeholder')}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <div className="content-nav-filters">
                  <label className="visually-hidden" htmlFor="templates-group">
                    {t('web.templates_group')}
                  </label>
                  <select
                    id="templates-group"
                    className="input sm"
                    value={activeGroupId}
                    onChange={(event) => setGroupId(event.target.value)}
                  >
                    <option value="">{t('web.templates_group_all')}</option>
                    {categorySections.map((section) => (
                      <option key={section.group.id} value={section.group.id}>
                        {section.group.label}
                      </option>
                    ))}
                  </select>
                  <Pills
                    value={source}
                    onChange={setSource}
                    items={[
                      { id: 'all', label: t('web.all') },
                      { id: 'custom', label: t('web.templates_filter_custom') },
                      { id: 'default', label: t('web.templates_filter_default') },
                    ]}
                  />
                </div>
                <span className="muted small">
                  {t('web.templates_count')}: <Num value={visible.size} />{' '}
                  {t('web.templates_count_of')} <Num value={rows.length} />
                </span>
              </div>

              {category !== 'all' && search.trim() !== '' && elsewhere > 0 && (
                <div className="content-nav-elsewhere" data-testid="templates-elsewhere">
                  <span className="muted small">
                    {t('web.templates_elsewhere').replace('{n}', formatNumber(elsewhere))}
                  </span>
                  <button type="button" className="btn sm" onClick={() => chooseCategory('all')}>
                    {t('web.templates_search_all')}
                  </button>
                </div>
              )}

              {visible.size === 0 && (
                <div className="content-nav-empty">
                  <p>{t('web.templates_no_match')}</p>
                  <button type="button" className="btn sm" onClick={clearFilters}>
                    {t('web.templates_clear_filters')}
                  </button>
                </div>
              )}

              <div className="content-nav-list">
                {sections.map((section) => (
                  <section
                    key={section.group.id}
                    aria-labelledby={`templates-group-${section.group.id}`}
                    hidden={!section.templates.some((template) => visible.has(template.key))}
                  >
                    <h2 id={`templates-group-${section.group.id}`} className="content-nav-group">
                      {section.group.label}
                    </h2>
                    <ul>
                      {section.templates.map((template) => (
                        <li key={template.key} hidden={!visible.has(template.key)}>
                          <TemplateListItem
                            template={template}
                            current={template.key === selected}
                            unsaved={dirty.has(template.key)}
                            onSelect={() => setChosen(template.key)}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </aside>

            <div className="content-editor">
              {ordered.map((template) => (
                <div key={template.key} hidden={template.key !== selected}>
                  <TemplateCard template={template} mayEdit={mayEdit} />
                </div>
              ))}
            </div>
          </div>
        </DirtyScope>
      </StateSwitch>
    </>
  );
}

/** One category chip: its name and how many texts in it match the search. */
function CategoryChip({
  id,
  label,
  count,
  current,
  onSelect,
}: {
  id: CategoryFilter;
  label: string;
  count: number;
  current: boolean;
  onSelect: (id: CategoryFilter) => void;
}) {
  return (
    <button
      type="button"
      className="tcat-chip"
      data-category={id}
      aria-pressed={current}
      onClick={() => onSelect(id)}
    >
      <span>{label}</span>
      <span className="tcat-count">
        <Num value={count} />
      </span>
    </button>
  );
}

/** One template in the list: its Persian name, its key, and whether it is customised. */
function TemplateListItem({
  template,
  current,
  unsaved,
  onSelect,
}: {
  template: TemplateViewResponse;
  current: boolean;
  unsaved: boolean;
  onSelect: () => void;
}) {
  const copy = templateCopy(template.key, template.description);
  return (
    <button
      type="button"
      id={`template-item-${template.key}`}
      className="content-item"
      aria-current={current ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="content-item-name">
        {copy.localized ? <BidiText text={copy.name} /> : <Ltr>{copy.name}</Ltr>}
      </span>
      {copy.localized && (
        <span className="content-item-key">
          <Ltr>{template.key}</Ltr>
        </span>
      )}
      <span className="content-item-marks">
        {isCustomised(template) && (
          <span className="content-item-mark" title={t('web.template_customised')}>
            <i className="dot info" aria-hidden="true" />
            <span className="visually-hidden">{t('web.template_customised')}</span>
          </span>
        )}
        {unsaved && (
          <span className="content-item-mark" title={t('web.ob_unsaved_row')}>
            <i className="dot warn" aria-hidden="true" />
            <span className="visually-hidden">{t('web.ob_unsaved_row')}</span>
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Memoised, because typing in the search box re-renders the page and the page holds
 * every card: without it each keystroke re-rendered all of them. The row objects come
 * from the query cache, which shares structure across refetches, so an unchanged row
 * is the same object and its card is skipped.
 *
 * Exported for the reminders screen (WP-A9), which edits its own templates in place.
 */
export const TemplateCard = memo(function TemplateCard({
  template,
  mayEdit,
  onChanged,
}: {
  template: TemplateViewResponse;
  mayEdit: boolean;
  /**
   * Run after a save or a revert committed, once the card's own queries are invalidated.
   * A page that draws this card beside a read model of the same text (the bot's menu, its
   * command list and digest) refreshes that model here (Codex #7).
   */
  onChanged?: () => Promise<unknown> | void;
}) {
  const client = useQueryClient();
  const copy = templateCopy(template.key, template.description);
  const labelOf = (placeholder: TemplateViewResponse['placeholders'][number]) =>
    placeholderLabel(template.key, placeholder.token, placeholder.description);

  /**
   * The template the draft is based on, held apart from the one the query has.
   *
   * The same rule as the settings screen, for the same reason: once somebody
   * else saves this key the query refetches, and submitting the text on screen
   * against THEIR version would discard their change with nothing to notice it
   * by. The write states the version the draft was actually based on, so a
   * concurrent change comes back as a conflict and the typing survives.
   */
  const [basis, setBasis] = useState<TemplateViewResponse>(template);
  // The RAW body. The override when there is one, otherwise the default — never
  // anything that has been through the renderer.
  const [draft, setDraft] = useState(template.overrideBody ?? template.defaultBody);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  /**
   * The INPUT the last preview was rendered from — the body and the sample
   * values together.
   *
   * Without it the rendered output stays on screen while what it came from is
   * edited away underneath, which is a small version of exactly the legacy
   * confusion this screen exists to end: a preview that is not of the thing you
   * are looking at. Comparing only the body was half a fix: changing
   * `occurrences` from 3 to 10 left a preview of 3 on screen with nothing said.
   */
  const [previewedInput, setPreviewedInput] = useState<string | null>(null);

  const storedBody = template.overrideBody ?? template.defaultBody;
  // Revision AND version. A revert restarts the version at 1, so comparing
  // versions alone reports "unchanged" across a revert-then-save — which is
  // exactly the sequence that silently overwrote the other administrator.
  const changedElsewhereStored =
    basis.version !== template.version || basis.revision !== template.revision;
  const unsaved = draft !== (basis.overrideBody ?? basis.defaultBody);
  // The page that draws this card (texts, reminders) holds one leave guard for all of them.
  useReportDirty(template.key, unsaved);

  const adopt = (fresh: TemplateViewResponse) => {
    setBasis(fresh);
    setDraft(fresh.overrideBody ?? fresh.defaultBody);
  };

  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ['templates'] });
    await client.invalidateQueries({ queryKey: ['revisions', template.key] });
    await onChanged?.();
  };

  // Two independent submissions on this card, so two keys. Saving and
  // reverting are different commands and must not share one.
  const saving = useSubmissionKey();
  const reverting = useSubmissionKey();

  const save = useMutation({
    // Held across a failure, so a person pressing the button again after a
    // dropped response is asking "did that work?" rather than issuing a second
    // command.
    // The WHOLE command travels as the variable; see the note in
    // `settings.tsx`. Reading the draft out of the closure would let a retry
    // carry the original key with a later body.
    mutationFn: (command: {
      idempotencyKey: string;
      body: string;
      expectedVersion: number | null;
      expectedRevision: number | null;
    }) => saveTemplate({ key: template.key, ...command }),
    onSuccess: async (result) => {
      saving.settle();
      adopt(result.template);
      await invalidate();
    },
    // A conflict means the cached row is stale, and only a success invalidated
    // it — so `changedElsewhere` stayed false, the reload button was never
    // offered, and every resubmission repeated the same conflict until an
    // unrelated refetch happened. The draft survives; what is refreshed is the
    // row it will be compared against.
    onError: (error: unknown) => {
      saving.settleOn(error);
      void invalidate();
    },
  });

  /**
   * The row a revert would remove, or null when the draft is based on none.
   *
   * The button's guard and its payload have to name the SAME row. They did not:
   * the guard tested the freshly-fetched `template` while the request carried
   * `basis`, so opening the card with no override and letting somebody else
   * create one drew a button that submitted a null version — refused as a 400
   * validation error rather than the conflict the operator should see. Two
   * `as number` casts were what hid it from the type checker, under a comment
   * claiming the guard had already been fixed.
   */
  const revertable =
    basis.version !== null && basis.revision !== null
      ? { version: basis.version, revision: basis.revision }
      : null;

  const undo = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      expectedVersion: number;
      expectedRevision: number;
    }) => {
      if (revertable === null) {
        // Unreachable: the button is not rendered without it. Refusing here
        // rather than casting is what makes that a fact the type checker
        // holds, instead of an assertion a comment makes.
        throw new Error('There is no override to revert.');
      }
      return revertTemplate({ key: template.key, ...command });
    },
    onSuccess: async (result) => {
      reverting.settle();
      adopt(result.template);
      await invalidate();
    },
    onError: (error: unknown) => {
      reverting.settleOn(error);
      void invalidate();
    },
  });

  // The whole input, in a stable order, so a re-render cannot make it look
  // changed when it is not.
  /**
   * Not while OUR OWN write is settling.
   *
   * `save` and `undo` both adopt the row they were handed before the awaited
   * invalidation resolves, so for the width of that round trip `basis` carries
   * the new version/revision while the query still carries the old — and the
   * banner told the operator their own write had been made "elsewhere",
   * promising a conflict that could not happen because `basis` was at that
   * moment the newest revision in existence. Same fix as the panel form and
   * the settings editor.
   */
  const changedElsewhere = !save.isPending && !undo.isPending && changedElsewhereStored;

  const previewInput = JSON.stringify([draft, Object.entries(sample).sort()]);

  const preview = useMutation({
    // The input travels as the mutation's VARIABLE, so the marker is set from
    // what the request actually used. Reading `previewInput` in `onSuccess`
    // closed over the latest render instead: editing the body while a preview
    // was in flight recorded the NEW input, and the stale preview then reported
    // itself as current — the failure this whole mechanism exists to prevent,
    // in its last remaining form.
    mutationFn: (input: { body: string; values: Record<string, string> }) =>
      previewTemplate(template.key, input.body, input.values),
    onSuccess: (_result, variables) =>
      setPreviewedInput(JSON.stringify([variables.body, Object.entries(variables.values).sort()])),
  });

  const previewStale = preview.isSuccess && previewedInput !== previewInput;

  const revisions = useQuery({
    queryKey: ['revisions', template.key],
    queryFn: () => fetchTemplateRevisions(template.key),
    /*
     * Sticky-open, but a FINAL answer still ends it.
     *
     * `showHistory` is sticky so that closing the pane no longer flips
     * `enabled` false→true on the next open, which used to re-trigger an
     * errored query once per reopen. The comment on the revisions disclosure below said
     * staying enabled "costs nothing: this query has no interval". The cost is
     * not an interval — it is `invalidate()`, which runs on every save
     * success, every save failure and every undo failure and invalidates this
     * exact key. Sticky-enabled, that refetches even with the pane CLOSED, and
     * even when the query is sitting in the 403 for which `retryOf`
     * deliberately withholds the Retry button: measured at one extra refused
     * `GET /templates/:key/revisions` — and one more
     * `access.permission_denied` — per save, unbounded, for the life of the
     * card. That is a worse channel than the reopen it replaced, because it
     * fires on the operator's primary action rather than on a deliberate
     * gesture.
     *
     * So the rule `retryOf` states is stated here too: after a final answer
     * there is nothing to fetch. A retryable failure stays enabled, because a
     * retryable failure is worth waiting through.
     */
    enabled: (query) =>
      showHistory && !(query.state.status === 'error' && finalAnswer(query.state.error)),
  });

  /*
   * The SAME pending guard the button has.
   *
   * `<button onClick={runPreview} disabled={preview.isPending}>` refuses a
   * second preview while one is in flight; the Enter handler added beside it
   * called straight through, so two preview mutations could run at once.
   * react-query drops the older one's RESULT but still runs its `onSuccess`,
   * and `onSuccess` is what records `previewedInput` — so a late first
   * response marks the displayed second render as current for an input it was
   * not rendered from. That is "a preview that is not of the thing you are
   * looking at", which is the one confusion this whole mechanism exists to
   * end, reintroduced by the fix for a different defect in the same file.
   */
  const runPreview = () => {
    if (preview.isPending) return;
    preview.mutate({ body: draft, values: sample });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    /*
     * A SUBMIT CONTROL pressed it, or nothing happens.
     *
     * This form holds more than the save: the preview pane's sample-value
     * fields are ordinary enabled inputs inside it. HTML's implicit submission
     * rule says a form with no submit button and exactly ONE field that blocks
     * implicit submission submits when Enter is pressed in that field — and for
     * an actor with `templates.view` but not `templates.edit` the Save button
     * is not rendered at all, so a single-placeholder template like
     * `bot.ping.reply` is exactly that shape. Enter in its sample box issued
     * `POST /templates/bot.ping.reply`, which the server refuses on
     * `templates.edit` — writing a DENIED audit row and an
     * `access.permission_denied` operational event, and putting a red error
     * about a save they never asked for on a screen with no Save button.
     *
     * So the rule is stated as a POSITIVE: a submit control produced this, or
     * nothing happens. `submitter` is null for implicit submission with no
     * default button and undefined on an event that is not a `SubmitEvent` at
     * all — `=== null` alone let the second through, which is how the test
     * below first caught this guard rather than the defect it guards.
     *
     * It is the backstop that keeps holding when a later field is added to
     * this form; `onKeyDown` on the sample inputs below is what stops Enter
     * reaching here at all when the Save button IS rendered, because then
     * implicit submission clicks it and `submitter` is perfectly legitimate.
     */
    if (!((event.nativeEvent as SubmitEvent).submitter instanceof HTMLElement)) return;
    // Snapshotted at the click, so a retry cannot see a later edit.
    const command = {
      body: draft,
      expectedVersion: basis.version,
      expectedRevision: basis.revision,
    };
    save.mutate({ ...command, idempotencyKey: saving.current(command) });
  };

  return (
    <Card
      className="template-card"
      title={copy.localized ? <BidiText text={copy.name} /> : <Ltr>{copy.name}</Ltr>}
      hint={
        // A key with no Persian entry falls back to its English catalogue description,
        // which is one left-to-right run rather than Latin islands in a Persian line.
        copy.localized ? (
          <BidiText text={copy.description} />
        ) : (
          <Ltr mono={false}>{copy.description}</Ltr>
        )
      }
      actions={
        <>
          {unsaved && (
            <Badge tone="warn" dot>
              {t('web.ob_unsaved_row')}
            </Badge>
          )}
          <Badge tone={isCustomised(template) ? 'info' : 'neutral'}>
            {isCustomised(template) ? t('web.template_customised') : t('web.source_default')}
          </Badge>
        </>
      }
    >
      <form onSubmit={onSubmit}>
        {/* The raw key is a technical detail: small, and never the title. */}
        <p className="muted small template-meta">
          {t('web.template_technical_key')}:{' '}
          <Ltr>
            <code>{template.key}</code>
          </Ltr>{' '}
          <span className="tag">
            {template.format === 'TELEGRAM_HTML'
              ? t('web.template_format_html')
              : t('web.template_format_plain')}
          </span>
        </p>

        {template.overrideSuppressed && <p className="error">{t('web.override_suppressed')}</p>}

        <label htmlFor={`body-${template.key}`}>{t('web.template_body')}</label>
        <textarea
          id={`body-${template.key}`}
          className="input"
          value={draft}
          rows={4}
          maxLength={template.maxLength}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!mayEdit}
          dir="auto"
        />
        <p className="muted small">
          {/* In words, not `n / max`: a slash between two numbers reads backwards in
            a right-to-left line. */}
          {t('web.template_length')}: <Num value={draft.length} /> {t('web.templates_count_of')}{' '}
          <Num value={template.maxLength} /> {t('web.template_length_unit')}
          {' — '}
          {template.format === 'TELEGRAM_HTML'
            ? t('web.template_format_html_hint')
            : t('web.template_format_plain_hint')}
        </p>
        {template.placeholders.length > 0 && (
          <p className="small template-tokens">
            {template.placeholders.map((placeholder) => (
              <span key={placeholder.token} className="tag">
                <Ltr>{`{${placeholder.token}}`}</Ltr>&nbsp;{labelOf(placeholder)}
              </span>
            ))}
          </p>
        )}

        {changedElsewhere && (
          <p className="notice">
            {t('web.changed_elsewhere')}{' '}
            <button type="button" className="link" onClick={() => adopt(template)}>
              {t('web.reload_value')}
            </button>
          </p>
        )}
        {!changedElsewhere && unsaved && (
          <p className="notice">
            {t('web.unsaved_changes')}{' '}
            <button type="button" className="link" onClick={() => setDraft(storedBody)}>
              {t('web.discard')}
            </button>
          </p>
        )}

        {isCustomised(template) && (
          /* Showing the default beside the override is the one thing the
             legacy web surface got right here (WEB-BR-019). */
          <Disclosure variant="boxed" size="sm" summary={t('web.template_default')}>
            <pre dir="auto" className="template-default">
              {template.defaultBody}
            </pre>
          </Disclosure>
        )}

        {template.placeholders.length === 0 ? (
          <p className="muted small">{t('web.template_no_placeholders')}</p>
        ) : (
          <Disclosure
            variant="boxed"
            size="sm"
            summary={
              <span>
                {t('web.placeholders')} (<Num value={template.placeholders.length} />)
              </span>
            }
          >
            {/* The token is the contract and is shown exactly as it must be typed;
              the Persian beside it only explains it. */}
            <p className="muted small">{t('web.template_placeholders_hint')}</p>
            <div className="tbl-wrap template-table">
              <table className="tbl dense">
                <thead>
                  <tr>
                    <th>{t('web.template_placeholder_token')}</th>
                    <th>{t('web.description')}</th>
                    <th>{t('web.template_placeholder_type')}</th>
                    <th>{t('web.required')}</th>
                  </tr>
                </thead>
                <tbody>
                  {template.placeholders.map((placeholder) => (
                    <tr key={placeholder.token}>
                      <td>
                        <Ltr>
                          <code>{`{${placeholder.token}}`}</code>
                        </Ltr>
                      </td>
                      <td>{labelOf(placeholder)}</td>
                      <td>{placeholderTypeLabel(placeholder.type)}</td>
                      <td>
                        {placeholder.required
                          ? t('web.template_required_yes')
                          : t('web.template_required_no')}
                        {placeholder.repeatable && (
                          <>
                            {t('web.list_separator')}
                            {t('web.template_repeatable')}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Disclosure>
        )}

        <Disclosure variant="boxed" size="sm" summary={t('web.preview')}>
          <p className="notice">{t('web.preview_note')}</p>
          {template.placeholders.length > 0 && <h4>{t('web.preview_values')}</h4>}
          {template.placeholders.map((placeholder) => (
            <div key={placeholder.token}>
              <label htmlFor={`sample-${template.key}-${placeholder.token}`}>
                <Ltr>{`{${placeholder.token}}`}</Ltr> {labelOf(placeholder)}
              </label>
              <input
                id={`sample-${template.key}-${placeholder.token}`}
                className="input"
                value={sample[placeholder.token] ?? ''}
                placeholder={hintFor(placeholder.type)}
                onChange={(event) =>
                  setSample((current) => ({ ...current, [placeholder.token]: event.target.value }))
                }
                /*
                  Enter here PREVIEWS. It must not reach the form.

                  These fields sit inside the save form, so implicit submission
                  made Enter store the draft body — the one action on this card
                  that is not undoable by pressing it again, reached from the
                  control furthest from it in intent. Preview is what the
                  operator typing a sample value is asking for, so that is what
                  it does; `preventDefault` is what stops the save, and doing
                  the useful thing instead of nothing is why nobody will be
                  tempted to remove it.
                */
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  runPreview();
                }}
              />
            </div>
          ))}
          <button type="button" className="btn" onClick={runPreview} disabled={preview.isPending}>
            {t('web.preview')}
          </button>
          {preview.isError && (
            <TemplateErrorReport
              error={preview.error}
              template={template}
              samples={preview.variables?.values}
            />
          )}
          {preview.data && (
            <>
              {/* The rendered output is of the body it was rendered from, and
                that body may have been edited since. Saying so is cheaper than
                a preview that quietly describes something else. */}
              {previewStale && <p className="notice">{t('web.preview_stale')}</p>}
              <pre dir="auto" className="template-bubble">
                {preview.data.rendered}
              </pre>
              {preview.data.unresolved.length > 0 && (
                <p className="notice">
                  {t('web.preview_unresolved')}:{' '}
                  {preview.data.unresolved.map((token, index) => (
                    <span key={token}>
                      {index > 0 && t('web.list_separator')}
                      <TokenWithLabel template={template} token={token} />
                    </span>
                  ))}
                </p>
              )}
            </>
          )}
        </Disclosure>

        {/*
          STICKY. The first open enables the query; closing does not disable it.
          
          `setShowHistory(open)` made the `<summary>` element a retry button the
          rule does not know about: every close-and-reopen flipped `enabled`
          false→true, which re-triggers an errored query — so the pane refetched
          on each reopen, unbounded, while the card inside deliberately withheld
          Retry because the answer was final. Measured at one request per
          reopen.

          Sticky is only half of it, and the first version of this comment had
          the other half backwards: it said staying enabled "costs nothing:
          this query has no interval". The cost was never an interval. It is
          `invalidate()`, which fires on every save and every undo failure and
          invalidates this key — so sticky-enabled turned one request per
          deliberate reopen into one per save, with the pane shut. The
          `enabled` callback on the query is where that is stopped: see it for
          the measurement.
        */}
        <Disclosure
          variant="boxed"
          size="sm"
          summary={t('web.revisions')}
          onToggle={(open) => {
            setShowHistory((current) => current || open);
          }}
        >
          {/*
            The SAME rule as every other query-driven view.
            
            This pane rendered `{revisions.data && …}` and nothing else — no
            loading state, no error state, no retry. A refused or failing
            `GET /templates/:key/revisions` therefore drew an EMPTY pane, which
            an operator reads as "this template has no revision history": a
            false statement about the record, from the module whose own comment
            says silence is the one outcome this subsystem may not produce.
            
            It never mentioned `isError`, so the scan aimed at hand-rolled
            ladders could not see it either — the scan matched a spelling, and
            this site's defect was the absence of that spelling.
          */}
          {showHistory && (
            <StateSwitch
              query={revisions}
              isEmpty={(revisions.data?.revisions.length ?? 0) === 0}
              empty={<p>{t('web.empty')}</p>}
            >
              {revisions.data && revisions.data.revisions.length > 0 && (
                <div className="tbl-wrap template-table">
                  <table className="tbl dense">
                    <thead>
                      <tr>
                        <th>{t('web.revision')}</th>
                        <th>{t('web.action')}</th>
                        <th>{t('web.template_body')}</th>
                        <th>{t('web.updated_at')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {revisions.data.revisions.map((revision) => (
                        <tr key={revision.revision}>
                          <td>{revision.revision}</td>
                          <td>
                            {revision.action === 'SET'
                              ? t('web.action_set')
                              : t('web.action_revert')}
                          </td>
                          {/* A REVERT stores no body: reverting goes back to the
                      default rather than copying it. */}
                          <td dir="auto">{revision.body ?? '—'}</td>
                          <td>{formatTimestamp(revision.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </StateSwitch>
          )}
        </Disclosure>

        {mayEdit && (
          <div className="template-actions">
            <button type="submit" className="btn primary" disabled={save.isPending}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
            {/*
              `revertable`, not `template.version`. The payload is built from
              the DRAFT BASIS, so if another administrator creates an override
              between opening this card and its refetch, the button appeared
              while `revertable` was null and pressing it returned silently —
              no request, no error, no outcome.
            */}
            {revertable !== null && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (revertable === null) return;
                  const command = {
                    expectedVersion: revertable.version,
                    expectedRevision: revertable.revision,
                  };
                  undo.mutate({ ...command, idempotencyKey: reverting.current(command) });
                }}
                disabled={undo.isPending}
              >
                {t('web.revert')}
              </button>
            )}
          </div>
        )}
        {mayEdit && revertable !== null && <p className="notice">{t('web.revert_note')}</p>}

        {/* Which placeholder was wrong, not just that something was. */}
        {save.isError && <TemplateErrorReport error={save.error} template={template} />}
        {undo.isError && <TemplateErrorReport error={undo.error} template={template} />}
        {/* A no-op says so, exactly as a setting write does. Answering "saved"
          for a save that stored nothing is the legacy pattern verbatim. */}
        {save.isSuccess && (
          <p className="notice">{save.data.changed ? t('web.saved') : t('web.unchanged')}</p>
        )}
      </form>
    </Card>
  );
});

/** The text form a sample value has to take, or nothing for a plain string. */
function hintFor(type: TemplateViewResponse['placeholders'][number]['type']): string | undefined {
  const key = SAMPLE_HINTS[type];
  return key ? t(key) : undefined;
}

/** `{token}` in its own isolate, then its Persian helper — how every issue names a token. */
function TokenWithLabel({ template, token }: { template: TemplateViewResponse; token: string }) {
  const declared = template.placeholders.find((placeholder) => placeholder.token === token);
  const label =
    declared === undefined
      ? undefined
      : placeholderLabel(template.key, token, declared.description);
  return (
    <>
      <Ltr>{`{${token}}`}</Ltr>
      {label !== undefined && ` (${label})`}
    </>
  );
}

/** One refusal, in Persian: what is wrong and, where it is about one, which token. */
interface TemplateIssueCopy {
  readonly text: string;
  readonly token?: string;
  readonly hint?: string;
}

/**
 * A refusal of THIS screen's commands, said in Persian.
 *
 * The server's messages and issue details are English sentences for a log. What an
 * operator needs is which rule the body broke and which `{token}` it is about, and the
 * structured half of the refusal already carries both: `validateTemplateBody` returns
 * `{ kind, token }`, so the sentence is chosen here by KIND and the token is shown as
 * typed. A refusal this screen has no Persian for — a conflict, a permission, a dropped
 * connection — goes to the shared `ErrorReport`, which already speaks Persian for those.
 */
function templateRefusal(
  error: unknown,
  template: TemplateViewResponse,
  samples: Readonly<Record<string, string>> | undefined,
): { readonly message: string; readonly issues: readonly TemplateIssueCopy[] } | null {
  if (!(error instanceof ApiError)) return null;
  const raw = error.details?.issues;
  const details: readonly unknown[] = Array.isArray(raw) ? raw : [];

  switch (error.code) {
    case CONTROL_ERROR_CODES.TEMPLATE_INVALID:
      return { message: t('web.template_invalid'), issues: details.map(bodyIssue) };

    case CONTROL_ERROR_CODES.INVALID_VALUE: {
      /*
       * The sample values, re-checked by the SAME function the server ran.
       *
       * The server's problems are sentences with the token inside them; parsing a token
       * back out of English prose is the fragile half. `coerceTemplateValue` is the one
       * implementation both sides import, so running it over what this preview sent
       * names exactly the fields the server refused.
       */
      const issues: TemplateIssueCopy[] = [];
      for (const placeholder of template.placeholders) {
        const typed = samples?.[placeholder.token];
        if (typed === undefined || typed.trim() === '') continue;
        const coerced = coerceTemplateValue(placeholder as PlaceholderDefinition, typed);
        if (coerced.ok) continue;
        const hint = hintFor(placeholder.type);
        issues.push({
          text: t('web.template_sample_invalid'),
          token: placeholder.token,
          ...(hint === undefined ? {} : { hint }),
        });
      }
      return { message: t('web.template_samples_invalid'), issues };
    }

    case CONTROL_ERROR_CODES.TEMPLATE_NOT_OVERRIDDEN:
      return { message: t('web.template_not_overridden'), issues: [] };

    case CONTROL_ERROR_CODES.UNKNOWN_KEY:
      return { message: t('web.template_unknown_key'), issues: [] };

    // The request schema refuses an empty body before the service ever sees it.
    case 'request.invalid':
      return details.some((issue) => (issue as { path?: unknown }).path === 'body')
        ? { message: t('web.template_invalid'), issues: [{ text: t('web.template_issue_empty') }] }
        : null;

    default:
      return null;
  }
}

/** One `validateTemplateBody` issue, by its kind. An unknown kind keeps its own words. */
function bodyIssue(issue: unknown): TemplateIssueCopy {
  const shaped = (typeof issue === 'object' && issue !== null ? issue : {}) as {
    kind?: unknown;
    token?: unknown;
    detail?: unknown;
  };
  const token = typeof shaped.token === 'string' ? shaped.token : undefined;
  const withToken = (key: WebKey): TemplateIssueCopy =>
    token === undefined ? { text: t(key) } : { text: t(key), token };
  switch (shaped.kind) {
    case 'EMPTY':
      return { text: t('web.template_issue_empty') };
    case 'TOO_LONG':
      return { text: t('web.template_issue_too_long') };
    case 'UNKNOWN_PLACEHOLDER':
      return withToken('web.template_issue_unknown');
    case 'MISSING_REQUIRED_PLACEHOLDER':
      return withToken('web.template_issue_missing');
    case 'REPEATED_PLACEHOLDER':
      return withToken('web.template_issue_repeated');
    case 'UNKNOWN_ICON':
      return withToken('web.template_issue_unknown_icon');
    default:
      if (typeof issue === 'string') return { text: issue };
      return { text: typeof shaped.detail === 'string' ? shaped.detail : JSON.stringify(issue) };
  }
}

function TemplateErrorReport({
  error,
  template,
  samples,
}: {
  error: unknown;
  template: TemplateViewResponse;
  samples?: Readonly<Record<string, string>> | undefined;
}) {
  const refusal = templateRefusal(error, template, samples);
  if (refusal === null) return <ErrorReport error={error} />;
  const lines: ReactNode[] = refusal.issues.map((issue, index) => (
    // The index is part of the key, for the reason `ErrorReport` gives.
    <li key={`${index}:${issue.text}:${issue.token ?? ''}`}>
      {issue.text}
      {issue.token !== undefined && (
        <>
          {': '}
          <TokenWithLabel template={template} token={issue.token} />
        </>
      )}
      {issue.hint !== undefined && ` — ${issue.hint}`}
    </li>
  ));
  return (
    <>
      <Banner tone="danger">{refusal.message}</Banner>
      {lines.length > 0 && <ul className="danger">{lines}</ul>}
    </>
  );
}

/**
 * A Latin run — a `/command`, a product name, `iOS` — isolated inside Persian text.
 *
 * Without the isolate the bidi algorithm resolves the run's neutral edges against the
 * Persian around it, so a title naming `/start` is drawn with the slash on the wrong side
 * of `start`. A trailing full stop is left outside the run, where the sentence needs it.
 */
const LATIN_RUN = /([/@{]?[A-Za-z0-9](?:[A-Za-z0-9_./@{}:+-]*[A-Za-z0-9_}])?)/;

function BidiText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(LATIN_RUN)
        .map((part, index) => (index % 2 === 1 ? <bdi key={index}>{part}</bdi> : part))}
    </>
  );
}
