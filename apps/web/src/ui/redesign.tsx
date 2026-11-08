import { useId, useState, type ReactNode } from 'react';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';
import { Button, Banner, FilterChip, FilterChips, Switch, type Tone } from './kit';
import { Icon } from './icons';

/**
 * The redesign kit (web redesign, PR-0): the patterns every redesigned page is built from.
 *
 * Presentation only. Nothing here fetches, decides a permission or owns a mutation: a page
 * passes its own buttons, handlers and permission props, exactly as it did before, and the kit
 * decides where they are drawn. Counts shown by these components must be server totals
 * (`nexa-web-design`: no client-side counts) — the kit just draws what it is given.
 *
 * `PageHead` (kit.tsx) carries the page head: title + count chip, and freshness + refresh +
 * page actions in one row. `Drawer` (overlays.tsx) is the side drawer; `TwoColumn` is the old
 * independent-columns layout — new pages use `CardRows`.
 */

function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}

/* ------------------------------------------------------------ quick filters --- */

export interface QuickFilterItem<T extends string> {
  readonly key: T;
  readonly label: ReactNode;
  /** A REAL server total; omitted, no count is drawn. */
  readonly count?: number;
}

/** Quick-filter chips with counts — the redesign's replacement for tabs where the demo has chips. */
export function QuickFilters<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly QuickFilterItem<T>[];
  value: T;
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <FilterChips label={label}>
      {items.map((item) => (
        <FilterChip
          key={item.key}
          pressed={item.key === value}
          onClick={() => onChange(item.key)}
          {...(item.count === undefined ? {} : { count: item.count })}
        >
          {item.label}
        </FilterChip>
      ))}
    </FilterChips>
  );
}

/* ----------------------------------------------------------- selection bar --- */

/** The bar that exists only while rows are ticked. With nothing selected it draws nothing. */
export function SelectionBar({
  count,
  onClear,
  children,
}: {
  count: number;
  onClear: () => void;
  children?: ReactNode;
}) {
  if (count <= 0) return null;
  return (
    <div className="selection-bar" role="region" aria-label={t('web.kit_selection_bar')}>
      <b className="num" aria-live="polite">
        {t('web.kit_selected_count').replace('{n}', formatNumber(count))}
      </b>
      <div className="selection-actions">{children}</div>
      <Button variant="ghost" size="sm" onClick={onClear}>
        {t('web.kit_selection_clear')}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------- quick action bar --- */

/**
 * A button that may be unavailable. Disabled, it shows WHY on hover and focus: a disabled
 * `<button>` gets no pointer events in some browsers, so the reason sits on a wrapper that
 * does, and the button points at it with `aria-describedby`. A dangerous action is red, ends
 * in «…» (it opens a confirm) and keeps whatever confirm and reason it had before.
 */
export function QuickAction({
  label,
  onClick,
  danger = false,
  disabled = false,
  disabledReason,
  icon,
}: {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown on hover/focus while `disabled`. */
  disabledReason?: string;
  icon?: Parameters<typeof Icon>[0]['name'];
}) {
  const reasonId = useId();
  const shown = danger && !label.endsWith('…') ? `${label}…` : label;
  const why = disabled && disabledReason !== undefined && disabledReason !== '';
  return (
    <span
      className={cx('qa-wrap', why && 'has-reason')}
      {...(why ? { title: disabledReason } : {})}
    >
      <button
        type="button"
        className={cx('qa', danger && 'danger')}
        disabled={disabled}
        {...(why ? { 'aria-describedby': reasonId } : {})}
        {...(onClick === undefined ? {} : { onClick })}
      >
        {icon !== undefined && <Icon name={icon} size={14} />}
        {shown}
      </button>
      {why && (
        <span id={reasonId} className="visually-hidden">
          {disabledReason}
        </span>
      )}
    </span>
  );
}

export interface QuickActionGroup {
  readonly key: string;
  /** The group's small label (wallet, order, account…). */
  readonly label: string;
  /** `QuickAction`s (or any page button); `null`/`false` are skipped. */
  readonly actions: readonly ReactNode[];
}

/**
 * The grouped quick-action bar of a detail page: groups with a small label, dangerous actions
 * red. A group with nothing to draw (every action absent for want of a permission) is not
 * drawn, and a bar with no group is not drawn.
 */
export function QuickActionBar({
  groups,
  label,
}: {
  groups: readonly QuickActionGroup[];
  label?: string;
}) {
  const drawn = groups
    .map((group) => ({
      ...group,
      actions: group.actions.filter(
        (a) => a !== null && a !== undefined && a !== false && a !== '',
      ),
    }))
    .filter((group) => group.actions.length > 0);
  if (drawn.length === 0) return null;
  return (
    <div className="qbar" role="toolbar" aria-label={label ?? t('web.kit_quick_actions')}>
      {drawn.map((group) => (
        <span key={group.key} className="qgrp" role="group" aria-label={group.label}>
          <span className="ql" aria-hidden="true">
            {group.label}
          </span>
          {group.actions.map((action, index) => (
            <span key={index} className="qitem">
              {action}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- attention strip --- */

export interface AttentionItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly count?: number;
  readonly href?: string;
  readonly onClick?: () => void;
}

/**
 * The yellow strip for items that need action. Draws nothing when there is nothing to do —
 * a strip that is always there is noise. `tone="danger"` is the red variant (a blocked customer).
 */
export function AttentionStrip({
  items,
  title,
  tone = 'warn',
  children,
}: {
  items?: readonly AttentionItem[];
  title?: ReactNode;
  tone?: Extract<Tone, 'warn' | 'danger'>;
  /** Free content after the items (a note, a button). */
  children?: ReactNode;
}) {
  const list = items ?? [];
  if (list.length === 0 && children === undefined) return null;
  return (
    <div className={cx('attention-strip', tone)} role="status">
      <b>{title ?? t('web.kit_attention_title')}</b>
      {list.map((item) => {
        const body = (
          <>
            {item.label}
            {item.count !== undefined && <span className="num"> · {formatNumber(item.count)}</span>}
          </>
        );
        if (item.href !== undefined)
          return (
            <a key={item.key} className="attn-item" href={item.href}>
              {body}
            </a>
          );
        if (item.onClick !== undefined)
          return (
            <button key={item.key} type="button" className="attn-item" onClick={item.onClick}>
              {body}
            </button>
          );
        return (
          <span key={item.key} className="attn-item">
            {body}
          </span>
        );
      })}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ KPI row --- */

export interface KpiItem {
  readonly key: string;
  readonly label: ReactNode;
  /** Already formatted (`Money`, `Num`, a date). A missing figure is an em dash, never 0. */
  readonly value: ReactNode;
  readonly unit?: ReactNode;
}

/** A row of key figures: five across at a desk, two on a phone. */
export function KpiRow({ items }: { items: readonly KpiItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="kpi-row">
      {items.map((item) => (
        <div key={item.key} className="kpi-cell">
          <div className="kpi-cell-label">{item.label}</div>
          <div className="kpi-cell-value">
            {item.value}
            {item.unit !== undefined && <span className="kpi-cell-unit"> {item.unit}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- card rows --- */

export interface CardRowSpec {
  readonly key: string;
  readonly main: ReactNode;
  /** Absent, the main card spans the whole row. */
  readonly side?: ReactNode;
}

/**
 * Cards side by side are the same height, row by row: a grid of ROWS (main 2fr + side 1fr,
 * `align-items: stretch`), never two independent columns. Below 820px the rows stack.
 */
export function CardRows({ rows }: { rows: readonly CardRowSpec[] }) {
  return (
    <div className="card-rows">
      {rows.map((row) => (
        <div key={row.key} className={cx('card-row', row.side === undefined && 'solo')}>
          <div className="card-row-main">{row.main}</div>
          {row.side !== undefined && <div className="card-row-side">{row.side}</div>}
        </div>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- settings --- */

/** A collapsible section of setting rows. */
export function SettingsSection({
  title,
  description,
  defaultOpen = true,
  changed = 0,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  /** How many settings in this section hold an unsaved change; a dot marks the title. */
  changed?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className={cx('settings-section card', open && 'open')}>
      <h2 className="settings-section-head">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name={open ? 'chevron' : 'chevronLeft'} size={16} />
          <span className="settings-section-title">{title}</span>
          {changed > 0 && (
            <span className="settings-changed num" aria-hidden="true">
              {formatNumber(changed)}
            </span>
          )}
        </button>
      </h2>
      {description !== undefined && <p className="settings-section-desc">{description}</p>}
      <div id={bodyId} className="settings-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/** One setting: title and a muted description, with its control (a switch, an input) at the end. */
export function SettingRow({
  title,
  description,
  control,
  changed = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  /** The value differs from the saved one. */
  changed?: boolean;
}) {
  return (
    <div className={cx('setting-row', changed && 'changed')}>
      <div className="txt">
        <b>{title}</b>
        {description !== undefined && <span>{description}</span>}
      </div>
      <div className="ctl">{control}</div>
    </div>
  );
}

/** A setting whose control is a switch. */
export function SwitchSettingRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  danger,
  changed,
}: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
  changed?: boolean;
}) {
  return (
    <SettingRow
      title={title}
      {...(description === undefined ? {} : { description })}
      {...(changed === undefined ? {} : { changed })}
      control={
        <Switch
          checked={checked}
          onChange={onChange}
          label={title}
          {...(disabled === undefined ? {} : { disabled })}
          {...(danger === undefined ? {} : { danger })}
        />
      }
    />
  );
}

/**
 * The one sticky «N تغییر ذخیره‌نشده — ذخیره / لغو» bar of a settings page. Hidden while there
 * is nothing to save. Saving and cancelling stay the page's own handlers, so the page's
 * mutation, validation and unsaved-changes guard are untouched.
 */
export function StickySaveBar({
  changes,
  onSave,
  onCancel,
  saving = false,
  error,
}: {
  changes: number;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  error?: ReactNode;
}) {
  if (changes <= 0) return null;
  return (
    <div className="sticky-save-bar" role="region" aria-label={t('web.kit_settings_save')}>
      <b className="num" aria-live="polite">
        {t('web.kit_settings_unsaved').replace('{n}', formatNumber(changes))}
      </b>
      {error !== undefined && <Banner tone="danger">{error}</Banner>}
      <span className="spacer" />
      <Button variant="ghost" onClick={onCancel} disabled={saving}>
        {t('web.kit_settings_cancel')}
      </Button>
      <Button variant="primary" onClick={onSave} disabled={saving}>
        {saving ? t('web.kit_settings_saving') : t('web.kit_settings_save')}
      </Button>
    </div>
  );
}
