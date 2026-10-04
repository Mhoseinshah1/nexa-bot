import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INLINE_BUTTON_STYLES,
  categoryButtonStyleOf,
  categoryColorsSchema,
  inlineButtonStyleOf,
  inlineButtonStylesSchema,
  type CategoryColors,
  type InlineButtonStyle,
  type InlineButtonStyles,
  type ProductCategoryListingResponse,
} from '@nexa/contracts';
import { fetchProductCategories, fetchSettings, saveSetting } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Badge, Banner, Button, Card, StateSwitch, useToast, useUnsavedChanges } from '../ui/kit';
import { ErrorReport } from './settings';
import { fill } from './bot-buttons/canvas';
import { INLINE_BUTTONS_SETTING } from './bot-buttons/inline-buttons';

/**
 * UX Batch 01, item 2: «رنگ دسته‌بندی‌ها» — one colour per product category.
 *
 * The list is the tenant's REAL catalogue (`/product-categories`), in its own order, so a
 * category the operator creates appears here with no code change and a rename keeps its
 * colour: the value (`bot.category_colors`) is keyed by category id. An inactive or hidden
 * category is listed and marked — the bot does not draw it, and its colour is kept for when
 * it returns. A colour stored for a category since deleted is not shown and stays harmless.
 *
 * The palette is Telegram's four inline-button styles, nothing else, plus «پیش‌فرض دسته‌ها»:
 * no colour of its own, so the category takes the generic category button's style
 * (`categoryButtonStyleOf`, the same rule the bot draws with). Saved through the settings
 * endpoint — versioned, audited, `settings.edit` — with the version the draft was edited from.
 */

export const CATEGORY_COLORS_SETTING = 'bot.category_colors';

/** The «no colour of its own» choice in the select. Not a style: nothing is stored. */
const INHERIT = '';

const STYLE_NAME: Readonly<Record<InlineButtonStyle, WebKey>> = {
  default: 'web.bb_style_default',
  primary: 'web.bb_style_primary',
  success: 'web.bb_style_success',
  danger: 'web.bb_style_danger',
};

/** Only the ids with a colour, sorted, so two equal maps compare equal. */
function canonical(colors: CategoryColors): CategoryColors {
  const out: Record<string, InlineButtonStyle> = {};
  for (const id of Object.keys(colors).sort()) {
    const style = colors[id];
    if (style !== undefined) out[id] = style;
  }
  return out;
}

function same(a: CategoryColors, b: CategoryColors): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** The catalogue's own order: its sort position, then creation, then id. */
export function orderedCategories(
  categories: readonly ProductCategoryListingResponse[],
): ProductCategoryListingResponse[] {
  return [...categories].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

export function CategoryColorsSection({
  denied,
  mayEdit,
  mayViewCategories,
}: {
  /** No `settings.view`: the section is not drawn at all. */
  denied: boolean;
  /** `settings.edit`. */
  mayEdit: boolean;
  /** `catalog.view`: the category list. */
  mayViewCategories: boolean;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const categories = useQuery({
    queryKey: ['product-categories'],
    queryFn: fetchProductCategories,
    enabled: !denied && mayViewCategories,
  });
  const setting = settings.data?.settings.find((one) => one.key === CATEGORY_COLORS_SETTING);
  const stylesSetting = settings.data?.settings.find((one) => one.key === INLINE_BUTTONS_SETTING);
  const stored = useMemo<CategoryColors>(() => {
    const parsed = categoryColorsSchema.safeParse(setting?.value ?? {});
    return parsed.success ? parsed.data : {};
  }, [setting?.value]);
  const styles = useMemo<InlineButtonStyles>(() => {
    const parsed = inlineButtonStylesSchema.safeParse(stylesSetting?.value ?? {});
    return parsed.success ? parsed.data : {};
  }, [stylesSetting?.value]);
  const generic = inlineButtonStyleOf('catalog.category', styles);

  // The draft keeps the VERSION it was edited from: a save never claims a later read's.
  const [draft, setDraft] = useState<{
    readonly colors: CategoryColors;
    readonly basisVersion: number | null;
  } | null>(null);
  const current = draft?.colors ?? stored;
  const invalid = setting?.storedValueInvalid === true;
  const unsaved = draft !== null && (invalid || !same(draft.colors, stored));
  const basisVersion = setting?.version ?? null;
  const changedElsewhere =
    draft !== null && setting !== undefined && setting.version !== draft.basisVersion;
  const edit = (colors: CategoryColors) =>
    setDraft((before) => ({ colors, basisVersion: before?.basisVersion ?? basisVersion }));
  useUnsavedChanges(mayEdit && unsaved);

  const rows = useMemo(
    () => orderedCategories(categories.data?.categories ?? []),
    [categories.data],
  );
  const coloured = rows.filter((row) => Object.prototype.hasOwnProperty.call(current, row.id));

  const save = useMutation({
    mutationFn: (command: {
      idempotencyKey: string;
      value: CategoryColors;
      expectedVersion: number | null;
    }) => saveSetting({ key: CATEGORY_COLORS_SETTING, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.cc_saved' : 'web.cc_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: t('web.cc_failed') });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const choose = (id: string, value: string) => {
    const next: Record<string, InlineButtonStyle> = { ...current };
    if (value === INHERIT) delete next[id];
    else next[id] = value as InlineButtonStyle;
    edit(next);
  };

  return (
    <Card title={t('web.cc_title')} hint={t('web.cc_hint')} id="category-colors">
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {invalid && <Banner tone="warn">{t('web.cc_stored_invalid')}</Banner>}
        {!mayEdit && <Banner tone="info">{t('web.cc_denied_edit')}</Banner>}
        {!mayViewCategories ? (
          <Banner tone="info">{t('web.cc_categories_denied')}</Banner>
        ) : (
          <StateSwitch
            query={categories}
            isEmpty={rows.length === 0}
            empty={<p className="muted">{t('web.cc_empty')}</p>}
          >
            <p className="muted small" data-testid="cc-coloured">
              {fill(t('web.cc_changed_count'), { n: coloured.length })}
            </p>
            <ul className="ib-list" data-testid="cc-list">
              {rows.map((category) => {
                const own = Object.prototype.hasOwnProperty.call(current, category.id)
                  ? current[category.id]
                  : undefined;
                const style = categoryButtonStyleOf(category.id, current, styles);
                const name =
                  category.emoji === null ? category.name : `${category.emoji} ${category.name}`;
                const shown = category.status === 'ACTIVE' && category.visibility === 'VISIBLE';
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
                        data-testid="cc-preview"
                        data-style={style}
                        aria-label={`${t('web.cc_preview')} — ${name}`}
                      >
                        {name}
                      </span>
                    </div>
                    <label className="ib-style">
                      <span className="muted small">{t('web.cc_color')}</span>
                      <select
                        className="input sm"
                        value={own ?? INHERIT}
                        disabled={!mayEdit || save.isPending}
                        aria-label={`${t('web.cc_color')} — ${name}`}
                        onChange={(event) => choose(category.id, event.target.value)}
                      >
                        <option value={INHERIT}>
                          {fill(t('web.cc_inherit'), { style: t(STYLE_NAME[generic]) })}
                        </option>
                        {INLINE_BUTTON_STYLES.map((option) => (
                          <option key={option} value={option}>
                            {t(STYLE_NAME[option])}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!shown && <p className="muted small ib-note">{t('web.cc_kept_note')}</p>}
                  </li>
                );
              })}
            </ul>
          </StateSwitch>
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
        {mayEdit && mayViewCategories && (
          <div className="ib-actions">
            {unsaved && <span className="muted small">{t('web.cc_unsaved')}</span>}
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending || (Object.keys(current).length === 0 && !invalid)}
              onClick={() => edit({})}
            >
              {t('web.cc_reset')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!(unsaved || invalid) || save.isPending || setting === undefined}
              onClick={() => {
                // Snapshotted at the click; the version is the one the draft was edited from.
                const command = {
                  value: canonical(current),
                  expectedVersion: draft === null ? basisVersion : draft.basisVersion,
                };
                save.mutate({ ...command, idempotencyKey: submission.current(command) });
              }}
            >
              {t('web.cc_save')}
            </Button>
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}
