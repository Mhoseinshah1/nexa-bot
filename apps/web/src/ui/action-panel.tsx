import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
   * N is the number of disabled BUTTONS the panel draws, counted from what is drawn — one
   * reason can cover several buttons (no edit permission) and a reason can name an action
   * whose button is not drawn at all (PR #285 review, A4).
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
  /*
   * The buttons are the page's own components (a `Button` inside an `ActionButton`), so
   * their `disabled` is not a prop the panel can read: it counts the disabled buttons it
   * DREW, after every render and before paint. A drawer a button opens renders in a portal
   * and is not inside the panel, so it is never counted.
   */
  const section = useRef<HTMLElement>(null);
  const [disabledCount, setDisabledCount] = useState(0);
  useLayoutEffect(() => {
    const next =
      section.current?.querySelectorAll('.action-group-buttons button:disabled').length ?? 0;
    if (next !== disabledCount) setDisabledCount(next);
  });
  if (drawn.length === 0 && danger.length === 0) return null;
  const heading = title ?? t('web.action_panel_title');
  return (
    <section ref={section} className="action-panel" aria-labelledby={titleId}>
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
            {disabledCount > 0
              ? t('web.action_panel_why').replace('{n}', formatNumber(disabledCount))
              : t('web.action_panel_why_unavailable')}
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
