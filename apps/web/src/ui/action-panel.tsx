import type { ReactNode } from 'react';
import { t } from '../i18n/web.fa';

/**
 * The action panel (W1.5): a page's action buttons in ONE framed panel under the page title,
 * never loose on the page. Buttons are sorted into small titled groups, two per row, pill
 * buttons 40px high; a red «عملیات حساس» strip sits at the bottom; the reasons a button is
 * disabled fold into «چرا N دکمه غیرفعال است؟» at the foot.
 *
 * The buttons are the page's own `Button`s — same handlers, same permission props, same
 * confirmations. The panel decides where they are drawn, nothing else. A group whose actions
 * are all absent (`null`/`false`, e.g. no permission) is not drawn; a panel with nothing to
 * draw is not drawn.
 *
 * PHASE-0 INTERFACE STUB — agent A implements the look.
 */
export interface ActionGroup {
  /** Stable id. */
  key: string;
  /** The group's Persian title. */
  title: string;
  /** The buttons, in order. `null`/`false` entries are skipped. */
  actions: readonly ReactNode[];
}

export interface ActionPanelProps {
  /**
   * «عملیات روی این سرویس» / «عملیات روی این مشتری»; default «عملیات».
   */
  title?: string;
  groups: readonly ActionGroup[];
  /**
   * The red «عملیات حساس» strip: delete/terminate, transfer, disable all configs…
   */
  sensitive?: readonly ReactNode[];
  /**
   * Why buttons are disabled: one reason per entry, folded under «چرا N دکمه غیرفعال است؟».
   */
  disabledReasons?: readonly ReactNode[];
}

function present(nodes: readonly ReactNode[] | undefined): ReactNode[] {
  return (nodes ?? []).filter((node) => node !== null && node !== undefined && node !== false);
}

export function ActionPanel({ title, groups, sensitive, disabledReasons }: ActionPanelProps) {
  const drawn = groups
    .map((group) => ({ ...group, actions: present(group.actions) }))
    .filter((group) => group.actions.length > 0);
  const danger = present(sensitive);
  if (drawn.length === 0 && danger.length === 0) return null;
  return (
    <section className="action-panel" aria-label={title ?? t('web.action_panel_title')}>
      <h2 className="action-panel-title">{title ?? t('web.action_panel_title')}</h2>
      {drawn.map((group) => (
        <div key={group.key} className="action-group" role="group" aria-label={group.title}>
          <h3>{group.title}</h3>
          <div className="action-group-buttons">{group.actions}</div>
        </div>
      ))}
      {danger.length > 0 && (
        <div
          className="action-group danger"
          role="group"
          aria-label={t('web.action_panel_sensitive')}
        >
          <h3>{t('web.action_panel_sensitive')}</h3>
          <div className="action-group-buttons">{danger}</div>
        </div>
      )}
      {present(disabledReasons).length > 0 && (
        <ul className="action-panel-why">
          {present(disabledReasons).map((reason, index) => (
            <li key={index}>{reason}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
