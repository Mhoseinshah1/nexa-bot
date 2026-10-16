import { useId, type ReactNode } from 'react';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';

/**
 * The action panel (W1.5): a page's action buttons in ONE framed panel under the page title,
 * never loose on the page. Buttons are sorted into small titled groups, two groups per row,
 * pill buttons 40px high; a red «عملیات حساس» strip sits at the bottom; the reasons a button
 * is disabled fold into «چرا N دکمه غیرفعال است؟» at the foot.
 *
 * The buttons are the page's own `Button`s — same handlers, same permission props, same
 * confirmations. The panel decides where they are drawn, nothing else. A group whose actions
 * are all absent (`null`/`false`, e.g. no permission) is not drawn; a panel with nothing to
 * draw is not drawn.
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
  return (nodes ?? []).filter(
    (node) => node !== null && node !== undefined && node !== false && node !== '',
  );
}

export function ActionPanel({ title, groups, sensitive, disabledReasons }: ActionPanelProps) {
  const titleId = useId();
  const drawn = groups
    .map((group) => ({ ...group, actions: present(group.actions) }))
    .filter((group) => group.actions.length > 0);
  const danger = present(sensitive);
  const reasons = present(disabledReasons);
  if (drawn.length === 0 && danger.length === 0) return null;
  const heading = title ?? t('web.action_panel_title');
  return (
    <section className="action-panel" aria-labelledby={titleId}>
      <h2 className="action-panel-title" id={titleId}>
        {heading}
      </h2>
      {drawn.length > 0 && (
        <div className="action-grid">
          {drawn.map((group) => (
            <ActionGroupBox key={group.key} title={group.title}>
              {group.actions}
            </ActionGroupBox>
          ))}
        </div>
      )}
      {danger.length > 0 && (
        <ActionGroupBox title={t('web.action_panel_sensitive')} danger>
          {danger}
        </ActionGroupBox>
      )}
      {reasons.length > 0 && (
        <details className="action-panel-why">
          <summary>
            {t('web.action_panel_why').replace('{n}', formatNumber(reasons.length))}
          </summary>
          <ul>
            {reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ActionGroupBox({
  title,
  danger = false,
  children,
}: {
  title: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`action-group${danger ? ' danger' : ''}`} role="group" aria-labelledby={id}>
      <h3 className="action-group-title" id={id}>
        {title}
      </h3>
      <div className="action-group-buttons">{children}</div>
    </div>
  );
}
