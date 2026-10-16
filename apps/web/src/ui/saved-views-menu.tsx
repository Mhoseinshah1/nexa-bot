import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { t } from '../i18n/web.fa';
import { Icon } from './icons';
import { Drawer, Modal, useFocusTrap } from './overlays';
import { Button, Checkbox, Field, Input, useToast } from './kit';
import {
  SAVED_VIEW_NAME_MAX,
  addView,
  isEmptyViewState,
  moveView,
  normalizeViewState,
  removeView,
  renameView,
  restoreView,
  sameViewState,
  savedViewsStorageKey,
  setDefaultView,
  updateViewState,
  useSavedViews,
  type SavedView,
  type SavedViewsRegistration,
  type ViewNameError,
  type ViewState,
} from './saved-views';

/**
 * «★ فیلترهای ذخیره‌شده ▾» (W1.4) — the saved-filters menu at the end of a `ListFilterBar`.
 *
 * Exactly as wide as the search box's own buttons (from «جست‌وجو» to «پاک کردن»; at least
 * 170px; full width on a phone) — the filter bar's grid does that. When a saved view or a
 * preset matches the filters in force, the button reads its name. Dropdown: «ذخیره‌شده‌ها»
 * (★ on the default), «پیشنهادی» presets, «+ ذخیرهٔ فیلتر فعلی» (disabled until something is
 * filtered), «به‌روزرسانی «X»» after changing an applied view, «مدیریت» (rename, default,
 * reorder, delete with undo).
 *
 * A default view is applied when the page opens (the menu mounts) and nothing is filtered.
 *
 * The storage scope comes from `SavedViewsScope`, which the shell provides from the session;
 * without it the views are kept in memory only.
 */
export interface SavedViewsScopeValue {
  /** The installation's scope (the session carries no tenant id; see the PR's decisions). */
  readonly scope: string;
  readonly adminId: string;
}

export const SavedViewsScope = createContext<SavedViewsScopeValue | null>(null);

/** The key used when no scope is provided: never written to storage under a real key. */
const MEMORY_ONLY_KEY = `${savedViewsStorageKey('memory', 'none')}`;

const ERROR_KEYS = {
  too_short: 'web.saved_views_err_short',
  taken: 'web.saved_views_err_taken',
  full: 'web.saved_views_err_full',
} as const satisfies Record<ViewNameError, string>;

export function SavedViewsMenu({ registration }: { registration: SavedViewsRegistration }) {
  const scope = useContext(SavedViewsScope);
  const storageKey =
    scope === null ? MEMORY_ONLY_KEY : savedViewsStorageKey(scope.scope, scope.adminId);
  const { views, replace } = useSavedViews(storageKey, registration.page);
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const { empty } = registration;
  const current = registration.get();
  const presets = registration.presets.filter(
    (preset) =>
      !views.some((view) => sameViewState(empty, view.state, { ...empty, ...preset.state })),
  );
  const matchedView = views.find((view) => sameViewState(empty, current, view.state));
  const matchedPreset = presets.find((preset) =>
    sameViewState(empty, current, { ...empty, ...preset.state }),
  );
  const matchName =
    matchedView?.name ?? (matchedPreset === undefined ? null : t(matchedPreset.name));
  const last = views.find((view) => view.id === lastApplied);
  const changed = last !== undefined && !sameViewState(empty, current, last.state);
  const canSave = !isEmptyViewState(empty, current) && matchName === null;

  // The default view, once, when the page opens with nothing filtered.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current) return;
    appliedDefault.current = true;
    const fallback = views.find((view) => view.isDefault);
    if (fallback !== undefined && isEmptyViewState(empty, registration.get())) {
      setLastApplied(fallback.id);
      registration.set({ ...empty, ...fallback.state });
    }
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const apply = (state: ViewState, viewId: string | null) => {
    setLastApplied(viewId);
    setOpen(false);
    registration.set({ ...empty, ...state });
  };

  return (
    <div ref={wrap} className={`saved-views${open ? ' open' : ''}`} data-page={registration.page}>
      <button
        ref={trigger}
        type="button"
        className={`btn sm saved-views-btn${matchName === null ? '' : ' primary'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
        onClick={() => {
          if (!open) trigger.current?.focus();
          setOpen(!open);
        }}
      >
        <span aria-hidden="true">★</span>
        <span className="saved-views-name">{matchName ?? t('web.saved_views')}</span>
        {matchName === null && views.length > 0 && (
          <span className="lfb-n num">{views.length}</span>
        )}
        <Icon name="chevron" size={12} />
      </button>
      {open && (
        <SavedViewsDropdown
          id={panelId}
          views={views}
          presets={presets.map((preset) => ({
            id: preset.id,
            name: t(preset.name),
            state: preset.state,
          }))}
          isActive={(state) => sameViewState(empty, current, { ...empty, ...state })}
          canSave={canSave}
          updatable={changed ? last : undefined}
          onApply={apply}
          onClear={() => apply(empty, null)}
          onSave={() => {
            setOpen(false);
            setSaving(true);
          }}
          onUpdate={(view) => {
            replace(updateViewState(views, view.id, normalizeViewState(empty, current)));
            setOpen(false);
            notify({
              tone: 'ok',
              message: t('web.saved_views_updated').replace('{name}', view.name),
            });
          }}
          onManage={() => {
            setOpen(false);
            setManaging(true);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      {saving && (
        <SaveViewDialog
          onClose={() => setSaving(false)}
          onSave={(name, isDefault) => {
            const result = addView(views, {
              name,
              state: normalizeViewState(empty, current),
              isDefault,
            });
            if ('error' in result) return result.error;
            replace(result.views);
            setLastApplied(result.view.id);
            setSaving(false);
            notify({
              tone: 'ok',
              message: t('web.saved_views_saved').replace('{name}', result.view.name),
            });
            return null;
          }}
        />
      )}
      <ManageViewsDrawer
        open={managing}
        views={views}
        replace={replace}
        onClose={() => setManaging(false)}
      />
    </div>
  );
}

function SavedViewsDropdown({
  id,
  views,
  presets,
  isActive,
  canSave,
  updatable,
  onApply,
  onClear,
  onSave,
  onUpdate,
  onManage,
  onClose,
}: {
  id: string;
  views: readonly SavedView[];
  presets: readonly { id: string; name: string; state: ViewState }[];
  isActive: (state: ViewState) => boolean;
  canSave: boolean;
  updatable: SavedView | undefined;
  onApply: (state: ViewState, viewId: string | null) => void;
  onClear: () => void;
  onSave: () => void;
  onUpdate: (view: SavedView) => void;
  onManage: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  const item = (
    key: string,
    name: string,
    state: ViewState,
    viewId: string | null,
    star = false,
  ) => {
    const active = isActive(state);
    return (
      <button
        key={key}
        type="button"
        className={`saved-views-item${viewId === null ? ' preset' : ''}`}
        aria-pressed={active}
        title={active ? t('web.saved_views_clear_title') : t('web.saved_views_apply_title')}
        onClick={() => (active ? onClear() : onApply(state, viewId))}
      >
        {star && (
          <span className="saved-views-star" aria-label={t('web.saved_views_default')}>
            ★
          </span>
        )}
        <span className="saved-views-item-name">{name}</span>
      </button>
    );
  };
  return (
    <div
      ref={ref}
      id={id}
      className="saved-views-pop"
      role="dialog"
      aria-label={t('web.saved_views')}
    >
      {views.length > 0 ? (
        <>
          <h3>{t('web.saved_views_mine')}</h3>
          {views.map((view) => item(view.id, view.name, view.state, view.id, view.isDefault))}
        </>
      ) : (
        <p className="saved-views-none">{t('web.saved_views_none')}</p>
      )}
      {presets.length > 0 && (
        <>
          <h3>{t('web.saved_views_presets')}</h3>
          {presets.map((preset) => item(`p-${preset.id}`, preset.name, preset.state, null))}
        </>
      )}
      <div className="saved-views-foot">
        {updatable !== undefined && (
          <Button size="sm" onClick={() => onUpdate(updatable)}>
            {t('web.saved_views_update').replace('{name}', updatable.name)}
          </Button>
        )}
        <Button
          size="sm"
          variant={canSave ? 'primary' : 'default'}
          disabled={!canSave}
          onClick={onSave}
          {...(canSave ? {} : { title: t('web.saved_views_save_disabled') })}
        >
          {t('web.saved_views_save')}
        </Button>
        {views.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onManage}>
            {t('web.saved_views_manage')}
          </Button>
        )}
      </div>
    </div>
  );
}

function SaveViewDialog({
  onSave,
  onClose,
}: {
  onSave: (name: string, isDefault: boolean) => ViewNameError | null;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<ViewNameError | null>(null);
  const formId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(onSave(name, isDefault));
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('web.saved_views_save_title')}
      foot={
        <>
          <Button onClick={onClose}>{t('web.saved_views_cancel')}</Button>
          <Button type="submit" form={formId} variant="primary">
            {t('web.saved_views_submit')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="saved-views-form">
        <p className="muted small">{t('web.saved_views_save_hint')}</p>
        <Field
          label={t('web.saved_views_name')}
          htmlFor={`${formId}-name`}
          {...(error === null ? {} : { error: t(ERROR_KEYS[error]) })}
        >
          <Input
            id={`${formId}-name`}
            value={name}
            maxLength={SAVED_VIEW_NAME_MAX}
            placeholder={t('web.saved_views_name_placeholder')}
            aria-invalid={error !== null}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </Field>
        <Checkbox
          label={t('web.saved_views_make_default')}
          checked={isDefault}
          onChange={setIsDefault}
        />
      </form>
    </Modal>
  );
}

function ManageViewsDrawer({
  open,
  views,
  replace,
  onClose,
}: {
  open: boolean;
  views: readonly SavedView[];
  replace: (next: readonly SavedView[]) => void;
  onClose: () => void;
}) {
  const [undo, setUndo] = useState<{ view: SavedView; index: number } | null>(null);
  const notify = useToast();
  const close = () => {
    setUndo(null);
    onClose();
  };
  return (
    <Drawer
      open={open}
      onClose={close}
      title={t('web.saved_views_manage_title')}
      foot={<Button onClick={close}>{t('web.close')}</Button>}
    >
      {undo !== null && (
        <div className="saved-views-undo" role="status">
          <span>{t('web.saved_views_deleted').replace('{name}', undo.view.name)}</span>
          <Button
            size="sm"
            onClick={() => {
              replace(restoreView(views, undo));
              setUndo(null);
            }}
          >
            {t('web.saved_views_undo')}
          </Button>
        </div>
      )}
      {views.length === 0 ? (
        <p className="muted">{t('web.saved_views_manage_empty')}</p>
      ) : (
        <ul className="saved-views-list">
          {views.map((view, index) => (
            <ManageRow
              key={view.id}
              view={view}
              first={index === 0}
              last={index === views.length - 1}
              onRename={(name) => {
                const result = renameView(views, view.id, name);
                if ('error' in result) return result.error;
                replace(result.views);
                notify({ tone: 'ok', message: t('web.saved_views_renamed') });
                return null;
              }}
              onDefault={() => replace(setDefaultView(views, view.id))}
              onMove={(delta) => replace(moveView(views, view.id, delta))}
              onDelete={() => {
                const result = removeView(views, view.id);
                replace(result.views);
                setUndo(result.removed);
              }}
            />
          ))}
        </ul>
      )}
      {views.some((view) => view.isDefault) && (
        <Button size="sm" variant="ghost" onClick={() => replace(setDefaultView(views, null))}>
          {t('web.saved_views_no_default')}
        </Button>
      )}
    </Drawer>
  );
}

function ManageRow({
  view,
  first,
  last,
  onRename,
  onDefault,
  onMove,
  onDelete,
}: {
  view: SavedView;
  first: boolean;
  last: boolean;
  onRename: (name: string) => ViewNameError | null;
  onDefault: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(view.name);
  const [error, setError] = useState<ViewNameError | null>(null);
  const id = useId();
  const commit = () => {
    if (draft.trim() === view.name) {
      setDraft(view.name);
      return;
    }
    const result = onRename(draft);
    setError(result);
  };
  return (
    <li className="saved-views-row">
      <Field
        label={t('web.saved_views_name')}
        htmlFor={id}
        {...(error === null ? {} : { error: t(ERROR_KEYS[error]) })}
      >
        <Input
          id={id}
          size="sm"
          value={draft}
          maxLength={SAVED_VIEW_NAME_MAX}
          aria-invalid={error !== null}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
        />
      </Field>
      <div className="saved-views-row-actions">
        <label className="check">
          <input
            type="radio"
            name={`saved-views-default-${id}`}
            checked={view.isDefault}
            onChange={onDefault}
          />
          <span>{t('web.saved_views_default')}</span>
        </label>
        <span className="saved-views-sp" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('web.saved_views_up')}
          title={t('web.saved_views_up')}
          disabled={first}
          onClick={() => onMove(-1)}
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('web.saved_views_down')}
          title={t('web.saved_views_down')}
          disabled={last}
          onClick={() => onMove(1)}
        >
          <Icon name="arrowDown" />
        </button>
        <Button size="sm" variant="danger" onClick={onDelete}>
          {t('web.saved_views_delete')}
        </Button>
      </div>
    </li>
  );
}
