import { createContext } from 'react';
import { t } from '../i18n/web.fa';
import type { SavedViewsRegistration } from './saved-views';

/**
 * «★ فیلترهای ذخیره‌شده ▾» (W1.4) — the saved-filters menu at the end of a `ListFilterBar`.
 *
 * Exactly as wide as the search box's own buttons (from «جست‌وجو» to «پاک کردن»; at least
 * 170px; full width on a phone). When a saved view matches the filters in force, the button
 * reads that view's name. Dropdown: «ذخیره‌شده‌ها» (★ on the default), «پیشنهادی» presets,
 * «+ ذخیرهٔ فیلتر فعلی» (disabled until something is filtered), «به‌روزرسانی «X»» after
 * changing an applied view, «مدیریت» (rename, default, reorder, delete with undo).
 *
 * The storage scope comes from `SavedViewsScope`, which the shell provides from the session.
 *
 * PHASE-0 INTERFACE STUB — agent A implements it.
 */
export interface SavedViewsScopeValue {
  /** The installation's scope (the session carries no tenant id; see the PR's decisions). */
  readonly scope: string;
  readonly adminId: string;
}

export const SavedViewsScope = createContext<SavedViewsScopeValue | null>(null);

export function SavedViewsMenu({ registration }: { registration: SavedViewsRegistration }) {
  return (
    <button type="button" className="btn sm" data-page={registration.page} disabled>
      {t('web.saved_views')}
    </button>
  );
}
