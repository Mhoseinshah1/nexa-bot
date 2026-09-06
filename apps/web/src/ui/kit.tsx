import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { MoneyWire } from '@nexa/contracts';
import { Icon, type IconName } from './icons';
import { t, type WebKey } from '../i18n/web.fa';
import { formatMoney, formatMoneyText, formatNumber } from '../format';

/**
 * The production component kit.
 *
 * Two rules run through all of it. Every visible string comes from the
 * catalogue, so `check:i18n` can prove none was typed into a component. And
 * every technical value — an id, a URL, a hash, a handle — is rendered inside a
 * BIDI ISOLATE, because a Latin run dropped bare into a Persian sentence
 * reorders the sentence around it.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'teal' | 'neutral';

/* ------------------------------------------------------------------ bidi --- */

/**
 * A technical value, isolated from the Persian text around it.
 *
 * `direction: ltr` alone is not enough and that difference is the whole bug the
 * owner's revision 7 describes: without `unicode-bidi: isolate` the bidi
 * algorithm still resolves the run against its NEIGHBOURS, so `30 روز • 15 GB`
 * comes out reordered. Isolation makes the span one neutral object.
 */
export function Ltr({ children, mono = true }: { children: ReactNode; mono?: boolean }) {
  return <span className={mono ? 'ltr mono' : 'ltr'}>{children}</span>;
}

/**
 * A name and its numeric identifier, never concatenated.
 *
 * Revision 8: `کیان شریفی776737141` is what happens when a display name and an
 * id are printed adjacent with no separator — the reader cannot tell where one
 * ends. The separator is a real character, and the id carries its own isolate
 * so it does not drag the name around it.
 */
export function Ident({ name, id, href }: { name: string; id?: string | null; href?: string }) {
  const body = (
    <span className="ident">
      <span className="strong">{name}</span>
      {id !== undefined && id !== null && id !== '' && (
        <>
          <span className="sep" aria-hidden="true">
            {t('web.ident_separator')}
          </span>
          <Ltr>
            <span className="id">{id}</span>
          </Ltr>
        </>
      )}
    </span>
  );
  return href === undefined ? body : <a href={href}>{body}</a>;
}

/* ----------------------------------------------------------------- money --- */

/**
 * The only way money is drawn.
 *
 * Never abbreviated, never rounded, and the unit comes from the value rather
 * than the call site — the three things revision 1 asks for, enforced by the
 * component rather than by everyone remembering.
 */
export function Money({ value }: { value: MoneyWire }) {
  const { amount, unit } = formatMoney(value);
  return (
    <span className="money" title={formatMoneyText(value)}>
      {amount}
      <span className="unit">{unit}</span>
    </span>
  );
}

/** A count. Grouped, tabular, never shortened to `1.2k`. */
export function Num({ value }: { value: number }) {
  return <span className="num">{formatNumber(value)}</span>;
}

/* ------------------------------------------------------------------ copy --- */

/**
 * A technical reference that copies its FULL value.
 *
 * Revision 9, and the preview got exactly half of it: it truncated the display,
 * showed a "copied" toast, and never touched the clipboard. The visible text
 * may be short; `value` is what is copied, always, and the test asserts the
 * copied payload rather than the rendered one.
 *
 * `navigator.clipboard` is absent on an insecure origin and can be refused by
 * permission, so the failure is REPORTED rather than swallowed — a silent
 * "copied" that copied nothing is the legacy pattern this codebase exists to
 * avoid.
 */
export function Copyable({ value, display }: { value: string; display?: string }) {
  const toast = useToast();
  const shown = display ?? value;

  const copy = useCallback(() => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      toast({ tone: 'danger', message: t('web.copy_failed') });
      return;
    }
    clipboard.writeText(value).then(
      () => toast({ tone: 'ok', message: t('web.copied') }),
      () => toast({ tone: 'danger', message: t('web.copy_failed') }),
    );
  }, [toast, value]);

  return (
    <span className="copyable">
      <span className="val ltr mono truncate" title={value}>
        {shown}
      </span>
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={t('web.copy')}
        data-copy-value={value}
        onClick={(event) => {
          event.stopPropagation();
          copy();
        }}
      >
        <Icon name="copy" size={13} />
      </button>
    </span>
  );
}

/* --------------------------------------------------------------- badges --- */

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge ${tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}

/**
 * How much of a capability actually exists.
 *
 * The vocabulary is the load-bearing part of this whole release: it is what
 * lets a route show a concept the backend does not implement without implying
 * that pressing something would do it.
 */
export const MATURITIES = ['now', 'ready', 'planned', 'unsupported'] as const;
export type Maturity = (typeof MATURITIES)[number];

const MATURITY_LABEL: Readonly<Record<Maturity, WebKey>> = {
  now: 'web.maturity_now',
  ready: 'web.maturity_ready',
  planned: 'web.maturity_planned',
  unsupported: 'web.maturity_unsupported',
};

const MATURITY_HELP: Readonly<Record<Maturity, WebKey>> = {
  now: 'web.maturity_now_help',
  ready: 'web.maturity_ready_help',
  planned: 'web.maturity_planned_help',
  unsupported: 'web.maturity_unsupported_help',
};

export function MaturityBadge({ value }: { value: Maturity }) {
  return (
    <span className={`maturity ${value}`} title={t(MATURITY_HELP[value])}>
      {t(MATURITY_LABEL[value])}
    </span>
  );
}

/* --------------------------------------------------------------- layout --- */

export function PageHead({
  title,
  subtitle,
  maturity,
  actions,
}: {
  title: string;
  subtitle?: string;
  maturity?: Maturity;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>
          {title}
          {maturity !== undefined && (
            <>
              {' '}
              <MaturityBadge value={maturity} />
            </>
          )}
        </h1>
        {subtitle !== undefined && <p className="muted small">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="btn-group">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  hint,
  actions,
  children,
  foot,
  className,
}: {
  title?: string;
  hint?: string;
  actions?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="card-head">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {hint !== undefined && <p className="muted small">{hint}</p>}
          </div>
          {actions !== undefined && <div className="btn-group">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
      {foot !== undefined && <div className="card-foot">{foot}</div>}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="stat">
      <span className="muted small">{label}</span>
      <strong className={tone === undefined ? undefined : tone}>
        {value}
        {unit !== undefined && <span className="unit muted small"> {unit}</span>}
      </strong>
      {hint !== undefined && <span className="faint small">{hint}</span>}
    </div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([term, value], index) => (
        // The index is the key because a KV row is identified by its POSITION
        // in a fixed, statically written list; the term can be an element.
        <div key={index}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  icon,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className={`banner ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'danger' ? 'alert' : 'info')} size={16} />
      <div>
        {title !== undefined && <strong>{title}</strong>}
        {children}
      </div>
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: Tone }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className={tone ?? 'info'} style={{ width: `${clamped}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ tabs --- */

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (next: T) => void;
  items: readonly { id: T; label: string }[];
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          className={item.id === value ? 'active' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Pills<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (next: T) => void;
  items: readonly { id: T; label: string }[];
}) {
  return (
    <div className="pills" role="group">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.id === value}
          className={item.id === value ? 'active' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Chip({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <span className="chip">
      {children}
      {onRemove !== undefined && (
        <button type="button" aria-label={t('web.remove')} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

/* ----------------------------------------------------------------- forms --- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label {...(htmlFor === undefined ? {} : { htmlFor })}>{label}</label>
      {children}
      {hint !== undefined && <span className="muted small">{hint}</span>}
      {error !== undefined && (
        <span className="danger small" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'on' : ''}`}
      disabled={disabled === true}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/**
 * A configured credential, rendered as PRESENCE and never as a value.
 *
 * There is no masked form on purpose. `********` in an edit field submits
 * `********` back, and the panel password becomes eight asterisks — which is
 * why the response schema carries `configured` and `lastReplacedAt` and nothing
 * else. A replace field starts EMPTY for the same reason.
 */
export function Secret({
  configured,
  meta,
  onReplace,
  onRemove,
}: {
  configured: boolean;
  meta?: string;
  onReplace?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="secret">
      <Badge tone={configured ? 'ok' : 'neutral'}>
        {configured ? t('web.credential_set') : t('web.credential_absent')}
      </Badge>
      {meta !== undefined && <span className="faint small">{meta}</span>}
      <span className="spacer" />
      {onReplace !== undefined && (
        <button type="button" className="btn sm" onClick={onReplace}>
          {t('web.replace')}
        </button>
      )}
      {onRemove !== undefined && configured && (
        <button type="button" className="btn sm ghost danger" onClick={onRemove}>
          {t('web.remove')}
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- states --- */

export function Empty({
  title,
  hint,
  action,
  icon,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty">
      <Icon name={icon ?? 'inbox'} size={28} />
      <strong>{title}</strong>
      {hint !== undefined && <p className="muted small">{hint}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row}>
          {Array.from({ length: cols }, (_, col) => (
            <span key={col} />
          ))}
        </div>
      ))}
    </div>
  );
}

export type ViewState = 'ready' | 'loading' | 'empty' | 'error' | 'denied';

/**
 * The five states every data view has, in one place.
 *
 * Written as one component because the alternative — each page spelling out its
 * own `isPending` / `isError` / `length === 0` ladder — is how a screen ends up
 * with a loading state and no empty state, or an empty state that is really an
 * error nobody surfaced.
 */
export function StateSwitch({
  state,
  onRetry,
  empty,
  children,
}: {
  state: ViewState;
  onRetry?: () => void;
  empty?: ReactNode;
  children: ReactNode;
}) {
  if (state === 'loading') return <Skeleton />;
  if (state === 'denied')
    return <Empty title={t('web.no_permission')} hint={t('web.no_permission_hint')} icon="lock" />;
  if (state === 'error')
    return (
      <Empty
        title={t('web.error')}
        hint={t('web.error_hint')}
        icon="alert"
        action={
          onRetry === undefined ? undefined : (
            <button type="button" className="btn" onClick={onRetry}>
              {t('web.retry')}
            </button>
          )
        }
      />
    );
  if (state === 'empty') return <>{empty ?? <Empty title={t('web.empty')} />}</>;
  return <>{children}</>;
}

/* ---------------------------------------------------------------- tables --- */

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  /** Right-aligned numeric column in a logical-property world: `end`. */
  readonly align?: 'start' | 'end';
  readonly width?: string;
}

/**
 * A table over a page of rows the SERVER decided.
 *
 * It deliberately cannot sort. Sorting the rows it holds would sort ONE PAGE,
 * which is the defect revision 13 names: a "newest first" that only orders the
 * fifty rows already fetched is worse than no ordering, because it looks
 * right. Ordering is a query parameter or it does not exist, and this component
 * has no idea what the query was.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  caption,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  caption: string;
}) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  textAlign: column.align === 'end' ? 'end' : 'start',
                  ...(column.width === undefined ? {} : { width: column.width }),
                }}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              {...(onRowClick === undefined
                ? {}
                : {
                    onClick: () => onRowClick(row),
                    style: { cursor: 'pointer' },
                  })}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  style={{ textAlign: column.align === 'end' ? 'end' : 'start' }}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Keyset paging: forward through opaque cursors, and back through the ones
 * already seen.
 *
 * There is no page number, because the API does not offer one — `nextCursor`
 * encodes `(name, id)` and the response says nothing about how many pages
 * exist. Rendering "page 3 of 12" would require counting the collection on
 * every request, which is the thing keyset paging exists to avoid.
 */
export function CursorPager({
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
  shown,
}: {
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  shown: number;
}) {
  return (
    <div className="pager">
      <span className="muted small">
        {t('web.showing')} <Num value={shown} />
      </span>
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={!hasPrevious} onClick={onPrevious}>
        {t('web.newer')}
      </button>
      <button type="button" className="btn sm" disabled={!hasNext} onClick={onNext}>
        {t('web.older')}
      </button>
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="input-group">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <Icon name="search" size={14} />
      <input
        id={id}
        className="input"
        type="search"
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/* -------------------------------------------------------------- overlays --- */

/**
 * Escape closes, focus goes in, and focus comes back.
 *
 * The third is the one usually missed: a dialog that returns focus to the
 * document body leaves a keyboard user at the top of the page, having lost the
 * control they opened it from.
 */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    restoreTo.current = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreTo.current?.focus();
    };
  }, [open, onClose]);

  return ref;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  foot,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn ghost icon"
            aria-label={t('web.close')}
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {foot !== undefined && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  foot,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn ghost icon"
            aria-label={t('web.close')}
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {foot !== undefined && <div className="drawer-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  tone,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      foot={
        <>
          <button type="button" className="btn" onClick={onCancel}>
            {t('web.cancel')}
          </button>
          <button
            type="button"
            className={`btn primary ${tone ?? ''}`}
            disabled={busy === true}
            onClick={onConfirm}
          >
            {busy === true ? t('web.working') : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/* ---------------------------------------------------------------- toasts --- */

interface Toast {
  readonly id: number;
  readonly tone: Tone;
  readonly message: string;
}

type Notify = (toast: { tone: Tone; message: string }) => void;

const ToastContext = createContext<Notify>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const next = useRef(0);

  const notify = useCallback<Notify>((toast) => {
    next.current += 1;
    const id = next.current;
    setToasts((current) => [...current, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      {children}
      {/*
        `status`, not `alert`. A confirmation that something was copied should
        not interrupt what a screen reader is already saying; a polite live
        region announces it when the user is between utterances.
      */}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}

/* -------------------------------------------------- distribution & lists --- */

export interface DistributionSlice {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone?: Tone;
}

/**
 * A share-of-total breakdown.
 *
 * Revision 2 is about WHAT is aggregated, not how it is drawn: a panel may
 * serve several locations, so a location breakdown double-counts and a panel
 * breakdown does not. This component takes slices and knows nothing about
 * either — the caller decides, and the dashboard's caller passes panels.
 */
export function Distribution({ slices }: { slices: readonly DistributionSlice[] }) {
  const total = useMemo(() => slices.reduce((sum, slice) => sum + slice.count, 0), [slices]);

  if (total === 0) return <Empty title={t('web.empty')} />;

  return (
    <div className="dist">
      {slices.map((slice) => (
        <div className="dist-row" key={slice.key}>
          <span>{slice.label}</span>
          <span className="num muted">
            <Num value={slice.count} />
          </span>
          <span className="bar">
            <span
              className={slice.tone ?? 'info'}
              style={{ width: `${(slice.count / total) * 100}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * An ordered list an operator edits by hand.
 *
 * Revisions 22 and 23 both need the same four affordances — add, remove,
 * reorder, validate — so they are one component rather than two that drift.
 * Order is meaningful and therefore preserved: it is the order the list is
 * stored in, not a rendering choice.
 *
 * Reordering is move-up/move-down buttons rather than drag. Drag alone is
 * unusable from a keyboard, and a list of three support handles does not earn a
 * drag implementation plus its keyboard fallback.
 */
export function ListEditor<T>({
  items,
  onChange,
  renderRow,
  onAdd,
  addLabel,
  disabled,
  emptyHint,
}: {
  items: readonly T[];
  onChange: (next: readonly T[]) => void;
  renderRow: (item: T, index: number, update: (next: T) => void) => ReactNode;
  onAdd: () => T;
  addLabel: string;
  disabled?: boolean;
  emptyHint: string;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <div className="list-editor">
      {items.length === 0 && <p className="muted small">{emptyHint}</p>}
      {items.map((item, index) => (
        // Position IS the identity here: the rows are an ordered list of
        // values an operator is editing, and two identical handles are a state
        // the editor must survive rather than crash on.
        <div className="list-editor-row" key={index}>
          <span className="ord num">{formatNumber(index + 1)}</span>
          <div className="grow">
            {renderRow(item, index, (nextItem) => {
              const next = [...items];
              next[index] = nextItem;
              onChange(next);
            })}
          </div>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.move_up')}
            disabled={disabled === true || index === 0}
            onClick={() => move(index, -1)}
          >
            <Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} />
          </button>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.move_down')}
            disabled={disabled === true || index === items.length - 1}
            onClick={() => move(index, 1)}
          >
            <Icon name="chevron" size={13} />
          </button>
          <button
            type="button"
            className="btn ghost icon sm danger"
            aria-label={t('web.remove')}
            disabled={disabled === true}
            onClick={() => onChange(items.filter((_, at) => at !== index))}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn sm"
          disabled={disabled === true}
          onClick={() => onChange([...items, onAdd()])}
        >
          <Icon name="plus" size={13} /> {addLabel}
        </button>
      </div>
    </div>
  );
}
