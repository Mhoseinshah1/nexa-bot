import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_EMOJI_ID_PATTERN,
  categoryButtonIconOf,
  categoryButtonStyleOf,
  categoryButtonText,
  categoryColorsSchema,
  categoryIconOf,
  categoryIconsSchema,
  inlineButtonIconsSchema,
  inlineButtonStylesSchema,
  isValidCategoryAfterEmoji,
  type CategoryColors,
  type CategoryIcon,
  type CategoryIcons,
  type InlineButtonIcons,
  type InlineButtonStyles,
  type ProductCategoryListingResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../api/client';
import { t } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Badge, Banner, Button, Card, StateSwitch, useToast, useUnsavedChanges } from '../ui/kit';
import { ErrorReport } from './settings';
import { fill } from './bot-buttons/canvas';
import { INLINE_BUTTONS_SETTING, INLINE_BUTTON_ICONS_SETTING } from './bot-buttons/inline-buttons';
import { CATEGORY_COLORS_SETTING, orderedCategories } from './category-colors';

/**
 * Phase 2 UX wave, Item 2: «آیکون دسته‌بندی‌ها» — each category's optional decorations, on
 * the categories page beside the list they decorate.
 *
 * - «آیکون پریمیوم قبل»: a Telegram custom emoji id, drawn as the button's ONE premium icon,
 *   before the text, only from a bot whose appearance test succeeded.
 * - «ایموجی بعد»: an ORDINARY Unicode emoji after the name. Telegram cannot draw a premium
 *   emoji after (or inside) a button's text, so this is never presented as one.
 *
 * The preview shows the label exactly as the bot builds it (`categoryButtonText`), its
 * colour (`categoryButtonStyleOf`), and a dashed MARKER where the premium icon goes — never a
 * fake of the custom emoji, which only Telegram can draw. Saved through the settings endpoint
 * (`bot.category_icons`: versioned, audited, `settings.edit`) with the version the draft was
 * edited from; the save is refused on screen until every typed value is valid, and the
 * server validates it again.
 */

export const CATEGORY_ICONS_SETTING = 'bot.category_icons';

/** What the operator has typed for one category, untrimmed. */
type Typed = { readonly before: string; readonly after: string };
type Draft = Readonly<Record<string, Typed>>;

function typedOf(icons: CategoryIcons): Draft {
  const out: Record<string, Typed> = {};
  for (const [id, icon] of Object.entries(icons)) {
    out[id] = { before: icon.before ?? '', after: icon.after ?? '' };
  }
  return out;
}

/** The value a save writes: trimmed, empty fields and empty entries dropped, ids sorted. */
export function canonicalCategoryIcons(draft: Draft): CategoryIcons {
  const out: Record<string, CategoryIcon> = {};
  for (const id of Object.keys(draft).sort()) {
    const before = draft[id]?.before.trim() ?? '';
    const after = draft[id]?.after.trim() ?? '';
    if (before === '' && after === '') continue;
    out[id] = { ...(before === '' ? {} : { before }), ...(after === '' ? {} : { after }) };
  }
  return out;
}

/** Each typed field that the contract would refuse: the save waits until none is left. */
export function invalidCategoryIcons(
  draft: Draft,
): readonly { readonly id: string; readonly field: 'before' | 'after' }[] {
  const bad: { id: string; field: 'before' | 'after' }[] = [];
  for (const [id, icon] of Object.entries(canonicalCategoryIcons(draft))) {
    if (icon.before !== undefined && !CUSTOM_EMOJI_ID_PATTERN.test(icon.before)) {
      bad.push({ id, field: 'before' });
    }
    if (icon.after !== undefined && !isValidCategoryAfterEmoji(icon.after)) {
      bad.push({ id, field: 'after' });
    }
  }
  return bad;
}

/** A stored value as this release reads it; an unreadable one is shown as empty. */
function parsed<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown } },
  value: unknown,
): T {
  const result = schema.safeParse(value ?? {});
  return (result.success ? result.data : {}) as T;
}

const same = (a: Draft, b: Draft) =>
  JSON.stringify(canonicalCategoryIcons(a)) === JSON.stringify(canonicalCategoryIcons(b));

export function CategoryIconsSection({
  denied,
  mayEdit,
  categories,
}: {
  /** No `settings.view`: the section is not drawn at all. */
  denied: boolean;
  /** `settings.edit`. */
  mayEdit: boolean;
  /** The page's own read of the catalogue (`/product-categories`). */
  categories: readonly ProductCategoryListingResponse[];
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const find = (key: string) => settings.data?.settings.find((one) => one.key === key);
  const setting = find(CATEGORY_ICONS_SETTING);
  const stored = useMemo<CategoryIcons>(
    () => parsed<CategoryIcons>(categoryIconsSchema, setting?.value),
    [setting?.value],
  );
  const colorsValue = find(CATEGORY_COLORS_SETTING)?.value;
  const stylesValue = find(INLINE_BUTTONS_SETTING)?.value;
  const inlineIconsValue = find(INLINE_BUTTON_ICONS_SETTING)?.value;
  const colors = useMemo<CategoryColors>(
    () => parsed<CategoryColors>(categoryColorsSchema, colorsValue),
    [colorsValue],
  );
  const styles = useMemo<InlineButtonStyles>(
    () => parsed<InlineButtonStyles>(inlineButtonStylesSchema, stylesValue),
    [stylesValue],
  );
  const inlineIcons = useMemo<InlineButtonIcons>(
    () => parsed<InlineButtonIcons>(inlineButtonIconsSchema, inlineIconsValue),
    [inlineIconsValue],
  );

  // The draft keeps the VERSION it was edited from: a save never claims a later read's.
  const [draft, setDraft] = useState<{
    readonly icons: Draft;
    readonly basisVersion: number | null;
  } | null>(null);
  const current = draft?.icons ?? typedOf(stored);
  const bad = invalidCategoryIcons(current);
  const isBad = (id: string, field: 'before' | 'after') =>
    bad.some((one) => one.id === id && one.field === field);
  const invalid = setting?.storedValueInvalid === true;
  const unsaved = draft !== null && (invalid || !same(draft.icons, typedOf(stored)));
  const basisVersion = setting?.version ?? null;
  const changedElsewhere =
    draft !== null && setting !== undefined && setting.version !== draft.basisVersion;
  useUnsavedChanges(mayEdit && unsaved);

  const edit = (id: string, field: 'before' | 'after', value: string) =>
    setDraft((before) => {
      const icons = before?.icons ?? typedOf(stored);
      const entry = icons[id] ?? { before: '', after: '' };
      return {
        icons: { ...icons, [id]: { ...entry, [field]: value } },
        basisVersion: before === null ? basisVersion : before.basisVersion,
      };
    });

  const rows = useMemo(() => orderedCategories(categories), [categories]);
  const decorated = rows.filter(
    (row) => canonicalCategoryIcons(current)[row.id] !== undefined,
  ).length;

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: CategoryIcons;
      expectedVersion: number | null;
    }) => saveSetting({ key: CATEGORY_ICONS_SETTING, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.ci_saved' : 'web.ci_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: t('web.ci_failed') });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const field = (
    category: ProductCategoryListingResponse,
    which: 'before' | 'after',
    name: string,
  ) => {
    const typed = current[category.id]?.[which] ?? '';
    const wrong = isBad(category.id, which);
    const label = t(which === 'before' ? 'web.ci_before' : 'web.ci_after');
    const id = `ci-${which}-${category.id}`;
    return (
      <div className="ib-icon" data-testid={`ci-${which}`}>
        <label className="muted small" htmlFor={id}>
          {label} <span className="muted small">{t('web.bb_optional')}</span>
        </label>
        <input
          id={id}
          type="text"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          inputMode={which === 'before' ? 'numeric' : undefined}
          maxLength={which === 'before' ? 64 : 32}
          className={`input sm${which === 'before' ? ' mono' : ''}`}
          value={typed}
          placeholder={t(
            which === 'before' ? 'web.ci_before_placeholder' : 'web.ci_after_placeholder',
          )}
          disabled={!mayEdit || save.isPending}
          aria-invalid={wrong}
          aria-label={`${label} — ${name}`}
          onChange={(event) => edit(category.id, which, event.target.value)}
        />
        {typed !== '' && mayEdit && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            aria-label={`${t('web.ci_remove')} ${label} — ${name}`}
            onClick={() => edit(category.id, which, '')}
          >
            {t('web.ci_remove')}
          </Button>
        )}
        {wrong && (
          <span className="small ib-icon-error" role="alert">
            {t(which === 'before' ? 'web.ci_before_invalid' : 'web.ci_after_invalid')}
          </span>
        )}
      </div>
    );
  };

  return (
    <Card title={t('web.ci_title')} hint={t('web.ci_hint')} id="category-icons">
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        <p className="muted small" data-testid="ci-limits">
          {t('web.ci_limits')}
        </p>
        {invalid && <Banner tone="warn">{t('web.ci_stored_invalid')}</Banner>}
        {!mayEdit && <Banner tone="info">{t('web.ci_denied_edit')}</Banner>}
        {rows.length === 0 ? (
          <p className="muted">{t('web.ci_empty')}</p>
        ) : (
          <>
            <p className="muted small" data-testid="ci-count">
              {fill(t('web.ci_count'), { n: decorated })}
            </p>
            <ul className="ib-list" data-testid="ci-list">
              {rows.map((category) => {
                const name =
                  category.emoji === null ? category.name : `${category.emoji} ${category.name}`;
                // The preview draws only what the bot would: an invalid typed value is not drawn.
                const own = canonicalCategoryIcons(current)[category.id];
                const shown: CategoryIcon = {
                  ...(own?.before === undefined || isBad(category.id, 'before')
                    ? {}
                    : { before: own.before }),
                  ...(own?.after === undefined || isBad(category.id, 'after')
                    ? {}
                    : { after: own.after }),
                };
                const shownIcons: CategoryIcons = { [category.id]: shown };
                const icon = categoryButtonIconOf(category.id, shownIcons, inlineIcons);
                const text = categoryButtonText(
                  name,
                  categoryIconOf(category.id, shownIcons).after,
                );
                const style = categoryButtonStyleOf(category.id, colors, styles);
                return (
                  <li key={category.id} className="ib-row" data-category={category.id}>
                    <div className="ib-head">
                      <span className="ib-name">{name}</span>
                      {category.status !== 'ACTIVE' && (
                        <Badge tone="neutral">{t('web.cc_inactive')}</Badge>
                      )}
                      {category.status === 'ACTIVE' && category.visibility === 'HIDDEN' && (
                        <Badge tone="neutral">{t('web.cc_hidden')}</Badge>
                      )}
                      <span
                        className={`menu-preview-key ib-preview bb-style-${style}`}
                        data-testid="ci-preview"
                        aria-label={`${t('web.ci_preview')} — ${name}`}
                      >
                        {icon !== null && (
                          <span
                            className="bb-icon-mark"
                            title={t('web.ci_mark_title')}
                            aria-hidden="true"
                            data-testid="ci-icon-mark"
                          >
                            ✦
                          </span>
                        )}
                        <span data-testid="ci-preview-text">{text}</span>
                      </span>
                    </div>
                    {field(category, 'before', name)}
                    {field(category, 'after', name)}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {save.isError && <ErrorReport error={save.error} />}
        {mayEdit && changedElsewhere && (
          <Banner tone="warn">
            {t('web.ib_changed_elsewhere')}{' '}
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('web.ib_reload')}
            </Button>
          </Banner>
        )}
        {mayEdit && (
          <div className="ib-actions">
            {unsaved && <span className="muted small">{t('web.ci_unsaved')}</span>}
            <Button
              variant="primary"
              size="sm"
              disabled={
                !(unsaved || invalid) || bad.length > 0 || save.isPending || setting === undefined
              }
              onClick={() => {
                // Snapshotted at the click; the version is the one the draft was edited from.
                const command = {
                  value: canonicalCategoryIcons(current),
                  expectedVersion: draft === null ? basisVersion : draft.basisVersion,
                };
                save.mutate({ ...command, idempotencyKey: submission.current(command) });
              }}
            >
              {t('web.ci_save')}
            </Button>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}
