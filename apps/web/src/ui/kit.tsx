import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { MoneyWire } from '@nexa/contracts';
import { Icon, type IconName } from './icons';
import { errorCopy, queryState, retryOf, staleAfterError, type QueryView } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { formatMoney, formatMoneyText, formatNumber, splitDuration } from '../format';
import { navigate, useLinkHandler, type Route } from '../router';

/**
 * The production component kit.
 *
 * Two rules run through all of it. Every visible string comes from the
 * catalogue, so `check:i18n` can prove none was typed into a component. And
 * every technical value — an id, a URL, a hash, a handle — is rendered inside a
 * BIDI ISOLATE, because a Latin run dropped bare into a Persian sentence
 * reorders the sentence around it.
 *
 * A third, from the deployment: the document policy is `style-src 'self'`,
 * which blocks every `style` ATTRIBUTE. Nothing here writes one. A width that
 * varies continuously (a progress bar, a chart) is SVG geometry — a
 * presentation attribute, which that policy does not govern — and everything
 * else is a class. `tests/web/csp.test.tsx` walks every route to hold that.
 *
 * The API page agents build on is listed in `docs/web-redesign/foundation.md`.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'teal' | 'neutral';

function cx(...parts: readonly (string | false | null | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}

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
export function Ident({ name, id }: { name: string; id?: string | null }) {
  return (
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
}

/**
 * The identity cell of a list row: a display name on the first line, the
 * technical handles — an `@username`, an id — isolated beneath it.
 *
 * `href` makes the name the row's link; the handles never are, so a copied
 * username is never a navigation.
 */
export function IdentityCell({
  name,
  username,
  id,
  href,
}: {
  name: ReactNode;
  username?: string | null;
  id?: string | null;
  href?: string;
}) {
  const onLink = useLinkHandler();
  return (
    <span className="ident-cell">
      {href === undefined ? (
        <span className="name">{name}</span>
      ) : (
        <a className="name" href={href} onClick={onLink}>
          {name}
        </a>
      )}
      {((username !== undefined && username !== null && username !== '') ||
        (id !== undefined && id !== null && id !== '')) && (
        <span className="handles">
          {username !== undefined && username !== null && username !== '' && (
            <Ltr mono={false}>{`@${username}`}</Ltr>
          )}
          {id !== undefined && id !== null && id !== '' && <Ltr>{id}</Ltr>}
        </span>
      )}
    </span>
  );
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

/**
 * A quantity — a count, days, gigabytes, a percentage, a rate. Grouped,
 * tabular, never shortened to `1.2k`, and drawn in the body's digit shapes:
 * a quantity is not a technical identifier, so it is never `Ltr` (which
 * keeps Latin digits for ids, hosts, hashes and usernames).
 *
 * `value` is a number to group, or a figure a formatter already wrote (a
 * traffic amount, a rate, `12.5%`). `signed` isolates it left to right, so a
 * leading `+`/`−` stays in front of its digits inside a Persian sentence (and
 * a figure written as an equation, `2,150 تومان = ⭐ 1`, keeps its order).
 */
export function Num({ value, signed = false }: { value: number | string; signed?: boolean }) {
  return (
    <span className={signed ? 'num signed' : 'num'}>
      {typeof value === 'number' ? formatNumber(value) : value}
    </span>
  );
}

/**
 * A compound quantity — `215 / 400`, `42 ms`, `3 / 5` — kept in its written
 * order (isolated left to right) and drawn in the body's digits, like `Num`.
 * Not `Ltr`, which would turn every digit in it Latin.
 */
export function Quantity({ children }: { children: ReactNode }) {
  return <span className="num signed">{children}</span>;
}

/**
 * A duration, in the largest whole unit it divides into.
 *
 * In the kit rather than in a page, because a SECOND copy was about to be
 * written: the recovery page needs the same rendering of a backup interval that
 * the system page needs for a monitor cadence, and two copies of a unit mapping
 * is how one page comes to say "ساعت" where the other says "دقیقه" for the same
 * number of milliseconds.
 */
const DURATION_UNIT_KEYS: Readonly<Record<'second' | 'minute' | 'hour', WebKey>> = {
  second: 'web.unit_seconds',
  minute: 'web.unit_minutes',
  hour: 'web.unit_hours',
};

export function Duration({ ms }: { ms: number }) {
  const { value, unit } = splitDuration(ms);
  return (
    <span className="nowrap">
      <Num value={value} /> {t(DURATION_UNIT_KEYS[unit])}
    </span>
  );
}

/* ------------------------------------------------------------------ copy --- */

/**
 * The copy action on its own: copies `value`, reports the outcome as a toast.
 *
 * `navigator.clipboard` is absent on an insecure origin and can be refused by
 * permission, so the failure is REPORTED rather than swallowed — a silent
 * "copied" that copied nothing is the legacy pattern this codebase exists to
 * avoid.
 */
export function CopyButton({ value, label }: { value: string; label?: string }) {
  const toast = useToast();
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
    <button
      type="button"
      className="btn ghost icon sm"
      aria-label={label ?? t('web.copy')}
      title={label ?? t('web.copy')}
      data-copy-value={value}
      onClick={(event) => {
        event.stopPropagation();
        copy();
      }}
    >
      <Icon name="copy" size={13} />
    </button>
  );
}

/**
 * A technical reference that copies its FULL value.
 *
 * Revision 9, and the preview got exactly half of it: it truncated the display,
 * showed a "copied" toast, and never touched the clipboard. The visible text
 * may be short; `value` is what is copied, always, and the test asserts the
 * copied payload rather than the rendered one.
 */
export function Copyable({ value, display }: { value: string; display?: string }) {
  const shown = display ?? value;
  return (
    <span className="copyable">
      <span className="val ltr mono truncate" title={value}>
        {shown}
      </span>
      <CopyButton value={value} />
    </span>
  );
}

/**
 * A technical value on its own line — a URL, a hash, a command — with an
 * optional copy button. Always LTR and isolated; never a secret (a credential
 * is `Secret`, which renders presence only).
 */
export function CodeValue({
  value,
  copy = true,
  wrap = false,
}: {
  value: string;
  copy?: boolean;
  wrap?: boolean;
}) {
  return (
    <span className="code-field">
      <code className={cx('code', wrap && 'wrap')}>{value}</code>
      {copy && <CopyButton value={value} />}
    </span>
  );
}

/* --------------------------------------------------------------- badges --- */

export function Badge({
  tone = 'neutral',
  children,
  title,
  dot = false,
  outline = false,
  pulse = false,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  /** A leading status dot in the badge's colour. */
  dot?: boolean;
  /** Transparent with a border — for a protocol or a type rather than a state. */
  outline?: boolean;
  /** Animates the dot: a state that is in progress. Honours reduced motion. */
  pulse?: boolean;
}) {
  return (
    <span
      className={cx('badge', tone, outline && 'outline', pulse && 'pulse')}
      {...(title === undefined ? {} : { title })}
    >
      {dot && <i className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A coloured dot and its label. The label is REQUIRED: colour alone never
 * carries a meaning here (brief §11), so a dot with nothing beside it would be
 * a state only a sighted operator with full colour vision could read.
 */
export function StatusDot({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="status-dot">
      <i className={cx('dot', tone)} aria-hidden="true" />
      <span>{children}</span>
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

/* --------------------------------------------------------------- buttons --- */

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'danger-solid' | 'ghost';

function buttonClass(variant: ButtonVariant, size: 'md' | 'sm', extra?: string): string {
  return cx(
    'btn',
    variant === 'primary' && 'primary',
    (variant === 'danger' || variant === 'danger-solid') && 'danger',
    variant === 'danger-solid' && 'solid',
    variant === 'ghost' && 'ghost',
    size === 'sm' && 'sm',
    extra,
  );
}

/**
 * A button. `type` defaults to `button` — a bare `<button>` inside a form is a
 * submit, which is how a "cancel" ends up saving.
 */
export function Button({
  variant = 'default',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: IconName;
  className?: string;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon !== undefined && <Icon name={icon} />}
      {children}
    </button>
  );
}

/** An icon-only button. `label` is required: it is the button's only name. */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: {
  icon: IconName;
  label: string;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children' | 'aria-label'>) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, cx('icon', className))}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
}

/**
 * Related actions, spaced. `segmented` joins them into one control, for a
 * choice among a few options (each child then carries `aria-pressed`).
 */
export function ButtonGroup({
  children,
  segmented = false,
  label,
}: {
  children: ReactNode;
  segmented?: boolean;
  label?: string;
}) {
  return (
    <div
      className={cx('btn-group', segmented && 'segmented')}
      role="group"
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- layout --- */

export function PageHead({
  title,
  subtitle,
  maturity,
  badge,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /**
   * Only for a page that does not do its job yet (planned, server-ready,
   * unsupported). A working page carries no badge: «فعال» beside a list's
   * title read as the state of some record, and the reference draws none.
   */
  maturity?: Exclude<Maturity, 'now'>;
  /** A status badge beside the title — the entity's state on a detail page. */
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="titles">
        <h1>
          {title}
          {badge}
          {maturity !== undefined && <MaturityBadge value={maturity} />}
        </h1>
        {subtitle !== undefined && <p className="sub">{subtitle}</p>}
      </div>
      {actions !== undefined && <div className="actions">{actions}</div>}
    </div>
  );
}

/**
 * A section of a page.
 *
 * Always a `<section class="card">` with a real `<h2>` when titled — tests and
 * assistive technology both find a card by its heading. `tone="danger"` is the
 * isolated destructive zone; `tone="muted"` a quieter card for notes and
 * explanations; `tight` removes the body padding for a flush table.
 */
export function Card({
  title,
  hint,
  actions,
  children,
  foot,
  className,
  tone,
  tight = false,
  id,
}: {
  /** A node rather than a string, so a title can isolate a Latin run inside Persian. */
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  className?: string;
  tone?: 'danger' | 'muted';
  tight?: boolean;
  id?: string;
}) {
  return (
    <section
      className={cx(
        'card',
        tone === 'danger' && 'danger-zone',
        tone === 'muted' && 'muted-card',
        className,
      )}
      {...(id === undefined ? {} : { id })}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="card-head">
          <div className="titles">
            {title !== undefined && <h2>{title}</h2>}
            {hint !== undefined && <p className="hint">{hint}</p>}
          </div>
          {actions !== undefined && <div className="actions">{actions}</div>}
        </header>
      )}
      <div className={cx('card-body', tight && 'tight')}>{children}</div>
      {foot !== undefined && <div className="card-foot">{foot}</div>}
    </section>
  );
}

/**
 * The head of a detail page, as a card: identity (with an optional avatar
 * initial and a status badge), a meta line, the primary actions, and a strip
 * of summary figures beneath.
 */
export function DetailHead({
  title,
  badge,
  meta,
  actions,
  initial,
  stats,
}: {
  title: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** One or two characters for the avatar tile; omitted, no tile is drawn. */
  initial?: string;
  stats?: readonly { readonly label: ReactNode; readonly value: ReactNode }[];
}) {
  return (
    <section className="card detail-head">
      <div className="head-card">
        {initial !== undefined && (
          <span className="avatar lg" aria-hidden="true">
            {initial}
          </span>
        )}
        <div className="ident-block">
          <h2>
            {title}
            {badge}
          </h2>
          {meta !== undefined && <div className="meta">{meta}</div>}
        </div>
        {actions !== undefined && <div className="quick">{actions}</div>}
      </div>
      {stats !== undefined && stats.length > 0 && (
        <dl className="head-stats">
          {stats.map((stat, index) => (
            // Position is the identity: a fixed, statically written strip.
            <div key={index}>
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** The two-column detail layout: the main column and a narrower side column. */
export function TwoColumn({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="two-col">
      <div className="stack">{main}</div>
      <div className="stack">{side}</div>
    </div>
  );
}

/**
 * One figure in a strip (`head-stats`). Not a card — `StatCard` is.
 */
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
      <span className="lbl">{label}</span>
      <strong className={cx('val', tone)}>
        {value}
        {unit !== undefined && <span className="unit"> {unit}</span>}
      </strong>
      {hint !== undefined && <span className="foot">{hint}</span>}
    </div>
  );
}

/**
 * The change a KPI shows against the previous period.
 *
 * `direction` is MEANING, not arithmetic: a rise in failed payments is `bad`.
 * A metric with no good or bad direction passes `neutral` and is drawn without
 * a colour, because colour there would be a claim the data does not make.
 */
export interface StatDelta {
  readonly text: ReactNode;
  readonly direction: 'good' | 'bad' | 'neutral';
  readonly trend?: 'up' | 'down';
  readonly caption?: ReactNode;
}

/**
 * A KPI card: icon and label, the value with its unit, an optional delta and
 * an optional sparkline or footnote. `tone` outlines the card for a figure
 * that needs attention (`alert` red, `warn` amber) — never as decoration.
 */
export function StatCard({
  label,
  value,
  unit,
  icon,
  delta,
  hint,
  tone,
  children,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  icon?: IconName;
  delta?: StatDelta;
  hint?: ReactNode;
  tone?: 'alert' | 'warn';
  /** A `Sparkline`, or anything else that belongs under the figure. */
  children?: ReactNode;
}) {
  return (
    <div className={cx('card', 'stat', tone === 'alert' && 'alert', tone === 'warn' && 'warnish')}>
      <div className="lbl">
        {icon !== undefined && <Icon name={icon} size={13} />}
        <span>{label}</span>
      </div>
      <div className="val">
        {value}
        {unit !== undefined && <small>{unit}</small>}
      </div>
      {delta !== undefined && (
        <div className={cx('delta', delta.direction)}>
          <b>
            {delta.trend === 'up' && <Icon name="arrowUp" size={11} />}
            {delta.trend === 'down' && <Icon name="arrowDown" size={11} />}
            {/* Isolated LTR, so «+12.5%» keeps its sign in front inside a Persian line. */}
            <span className="num signed">{delta.text}</span>
          </b>
          <span>{delta.caption ?? t('web.vs_previous')}</span>
        </div>
      )}
      {hint !== undefined && <div className="foot">{hint}</div>}
      {children}
    </div>
  );
}

/** A `StatCard` that needs attention. The same card, outlined red by default. */
export function AlertStatCard(props: Parameters<typeof StatCard>[0]) {
  return <StatCard {...props} tone={props.tone ?? 'alert'} />;
}

/** A labelled figure, inline — a caption above a value. */
export function Metric({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <span className="metric">
      <span className="l">{label}</span>
      <span className="v">{value}</span>
    </span>
  );
}

/**
 * A definition list of label → value rows. `DefinitionList` is the same
 * component under the name the kit inventory uses.
 */
export function KV({
  items,
  inline = false,
}: {
  items: [ReactNode, ReactNode][];
  inline?: boolean;
}) {
  return (
    <dl className={cx('kv', inline && 'inline')}>
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
export const DefinitionList = KV;

/**
 * A share of a whole, drawn as an SVG bar so its width survives the CSP.
 *
 * `value` and `max` may be bigints (traffic bytes are), and the ratio is taken
 * without converting either to a float first — 2^53 bytes is only 8 PiB.
 */
export function Progress({
  value,
  max,
  label,
  tone,
  size = 'md',
}: {
  value: number | bigint;
  max: number | bigint;
  /** The accessible name — what is being measured. */
  label: string;
  /** Omitted: ok below 80%, warn below 95%, danger at or above. */
  tone?: Tone;
  size?: 'md' | 'lg';
}) {
  const ratio = progressRatio(value, max);
  const percent = Math.round(ratio * 100);
  const resolved: Tone = tone ?? (percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok');
  return (
    <svg
      className={cx('progress', resolved, size === 'lg' && 'lg')}
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      focusable="false"
    >
      <rect x="0" y="0" height="10" width={ratio * 100} />
    </svg>
  );
}

/** A ratio in [0, 1], exact for bigints. Zero for a zero or negative maximum. */
export function progressRatio(value: number | bigint, max: number | bigint): number {
  if (typeof value === 'bigint' || typeof max === 'bigint') {
    const v = BigInt(value);
    const m = BigInt(max);
    if (m <= 0n) return 0;
    if (v <= 0n) return 0;
    if (v >= m) return 1;
    return Number((v * 10000n) / m) / 10000;
  }
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(1, value / max);
}

/** A labelled meter: `used of total` above a `Progress`. */
export function Meter({
  label,
  used,
  total,
  value,
  max,
  tone,
}: {
  label: string;
  used: ReactNode;
  total: ReactNode;
  value: number | bigint;
  max: number | bigint;
  tone?: Tone;
}) {
  return (
    <div className="meter">
      <div className="lbl">
        <span>{label}</span>
        <span className="num">
          {used} {t('web.progress_of')} {total}
        </span>
      </div>
      <Progress value={value} max={max} label={label} {...(tone === undefined ? {} : { tone })} />
    </div>
  );
}

/**
 * A section closed until asked for: technical identifiers, an «advanced»
 * field, a default text beside its override. One look everywhere — a chevron
 * that turns when open, the summary in the secondary colour, the content
 * spaced beneath it.
 *
 * - `size="sm"` for a technical footnote under a form or a card.
 * - `variant="boxed"` frames it on the sunken background, for a disclosure
 *   that is one block among several inside a card.
 * - `onToggle` receives the new open state; a query enabled by opening is the
 *   caller's to keep (see the template revisions pane).
 *
 * The native `<details>` is kept: keyboard, find-in-page and the open state
 * all come from the browser, and a closed body is not in the tab order.
 */
export function Disclosure({
  summary,
  children,
  size = 'md',
  variant = 'plain',
  className,
  onToggle,
}: {
  summary: ReactNode;
  children?: ReactNode;
  size?: 'md' | 'sm';
  variant?: 'plain' | 'boxed';
  className?: string;
  onToggle?: (open: boolean) => void;
}) {
  const classes = ['disclosure'];
  if (size === 'sm') classes.push('sm');
  if (variant === 'boxed') classes.push('boxed');
  if (className !== undefined) classes.push(className);
  return (
    <details
      className={classes.join(' ')}
      {...(onToggle === undefined
        ? {}
        : { onToggle: (event) => onToggle(event.currentTarget.open) })}
    >
      <summary>
        <Icon name="chevronLeft" size={14} className="disclosure-chevron" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  icon,
  role,
  action,
}: {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
  icon?: IconName;
  /** Overrides the tone's default. See `StaleNotice` for why one needs to. */
  role?: 'status' | 'alert' | undefined;
  /** A control that resolves what the banner says — at the end of the line. */
  action?: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`} role={role ?? (tone === 'danger' ? 'alert' : undefined)}>
      <Icon name={icon ?? (tone === 'danger' || tone === 'warn' ? 'alert' : 'info')} size={16} />
      <div>
        {title !== undefined && <strong>{title}</strong>}
        {children}
      </div>
      {action}
    </div>
  );
}

/** A `Banner` by the name the kit inventory uses. */
export const Callout = Banner;

/** A vertical history: when, what, and an optional detail, each with a tone. */
export function Timeline({
  items,
}: {
  items: readonly {
    readonly key: string;
    readonly at: ReactNode;
    readonly title: ReactNode;
    readonly detail?: ReactNode;
    readonly tone?: Tone;
  }[];
}) {
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={item.key} className={item.tone}>
          <div className="t">{item.at}</div>
          <div>{item.title}</div>
          {item.detail !== undefined && <div className="d">{item.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ tabs --- */

/**
 * A tablist, and the three things that make it one rather than three buttons
 * wearing `role="tab"`.
 *
 * `aria-controls` and a matching `role="tabpanel"`, so a screen reader that
 * announces "tab 2 of 3, selected" has something to associate it with; a
 * ROVING `tabIndex`, so Tab moves past the whole strip instead of through it;
 * and arrow keys to move between tabs, which the ARIA practices require and
 * which is the only way a keyboard user reaches tab three without Tabbing
 * through tab two's contents.
 *
 * `panelId` is what ties the two halves together, so `TabPanel` below takes
 * the same id. A tablist whose panels are not identified is the accessible
 * equivalent of a label pointing at nothing.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  items,
  panelId,
  vertical = false,
}: {
  value: T;
  onChange: (next: T) => void;
  items: readonly { id: T; label: string; count?: number }[];
  panelId: string;
  vertical?: boolean;
}) {
  /**
   * The tab buttons, so activation can MOVE FOCUS.
   *
   * Selecting with an arrow key and leaving `document.activeElement` on the
   * old button puts focus on a tab that is now `aria-selected=false` with
   * `tabIndex={-1}` while a different panel is shown — the roving tabindex
   * advertised by the markup then does not work for exactly the users it
   * exists for.
   */
  const buttons = useRef(new Map<T, HTMLButtonElement | null>());

  const select = (next: T) => {
    onChange(next);
    // After the state change, so the newly selected button is the one focused.
    queueMicrotask(() => buttons.current.get(next)?.focus());
  };

  const move = (delta: number) => {
    const at = items.findIndex((item) => item.id === value);
    if (at < 0) return;
    // Wrapping, per the ARIA practices: from the last tab, End-of-strip is the
    // first one rather than nothing happening.
    const next = items[(at + delta + items.length) % items.length];
    if (next) select(next.id);
  };

  return (
    <div
      className={vertical ? 'tabs vertical' : 'tabs'}
      role="tablist"
      {...(vertical ? { 'aria-orientation': 'vertical' as const } : {})}
      onKeyDown={(event) => {
        // RTL: the strip runs right-to-left, so ArrowLeft advances.
        if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowDown')) {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowUp')) {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Home') {
          event.preventDefault();
          if (items[0]) select(items[0].id);
        } else if (event.key === 'End') {
          event.preventDefault();
          const last = items[items.length - 1];
          if (last) select(last.id);
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            buttons.current.set(item.id, node);
          }}
          type="button"
          role="tab"
          id={`${panelId}-tab-${item.id}`}
          aria-selected={item.id === value}
          aria-controls={panelId}
          // The roving part: only the selected tab is in the tab order.
          tabIndex={item.id === value ? 0 : -1}
          className={item.id === value ? 'on' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.count !== undefined && <span className="cnt">{formatNumber(item.count)}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The panel a `Tabs` strip controls. Its `id` must be the strip's `panelId`,
 * and `labelledBy` the id of the selected tab.
 */
export function TabPanel({
  id,
  labelledBy,
  children,
}: {
  id: string;
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <div id={id} role="tabpanel" aria-labelledby={labelledBy} tabIndex={0}>
      {children}
    </div>
  );
}

/**
 * The selected tab of a detail page, kept in the URL (`?tab=`) so a tab is
 * linkable and Back/Forward move between tabs (lead decision D1).
 *
 * An unknown or missing value falls back to the first id, so a stale link
 * lands on a real tab. Switching PUSHES a history entry and is leave-guarded:
 * a tab's panel is mounted only while it is open, so switching away from a
 * dirty form would discard it.
 */
export function useQueryTab<T extends string>(
  route: Route,
  ids: readonly T[],
  param = 'tab',
): [T, (next: T) => void] {
  const raw = route.query.get(param);
  const fallback = ids[0] as T;
  const value = raw !== null && (ids as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => {
      const query = new URLSearchParams(route.query);
      if (next === fallback) query.delete(param);
      else query.set(param, next);
      const suffix = query.toString();
      navigate(suffix ? `${route.path}?${suffix}` : route.path, { guard: true });
    },
    [route, fallback, param],
  );
  return [value, set];
}

/**
 * A strip of tabs whose selection lives in the URL, with ONLY the open tab's
 * panel mounted. Queries inside a closed tab's panel do not run.
 */
export function RoutedTabs<T extends string>({
  route,
  items,
  panelId,
  param = 'tab',
  children,
}: {
  route: Route;
  items: readonly { id: T; label: string; count?: number }[];
  panelId: string;
  param?: string;
  /** Renders the open tab's panel. Called for the selected tab only. */
  children: (selected: T) => ReactNode;
}) {
  const [value, setValue] = useQueryTab(
    route,
    items.map((item) => item.id),
    param,
  );
  return (
    <>
      <Tabs value={value} onChange={setValue} items={items} panelId={panelId} />
      <TabPanel id={panelId} labelledBy={`${panelId}-tab-${value}`}>
        {children(value)}
      </TabPanel>
    </>
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
          className={item.id === value ? 'on' : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- period --- */

export const PERIOD_PRESETS = ['today', '7d', '30d', 'month', 'custom'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

const PERIOD_LABEL: Readonly<Record<PeriodPreset, WebKey>> = {
  today: 'web.period_today',
  '7d': 'web.period_7d',
  '30d': 'web.period_30d',
  month: 'web.period_month',
  custom: 'web.period_custom',
};

/**
 * The period control: امروز · ۷ روز · ۳۰ روز · این ماه · دلخواه, and the
 * comparison switch. The component only; what a preset MEANS (the tenant's
 * calendar and timezone, the reporting definitions) is the caller's, and the
 * custom range's inputs are passed in through `custom`, shown while the
 * `custom` preset is selected.
 */
export function PeriodControl({
  value,
  onChange,
  presets = PERIOD_PRESETS,
  compare,
  onCompareChange,
  custom,
}: {
  value: PeriodPreset;
  onChange: (next: PeriodPreset) => void;
  presets?: readonly PeriodPreset[];
  compare?: boolean;
  onCompareChange?: (next: boolean) => void;
  custom?: ReactNode;
}) {
  return (
    <div className="period">
      <ButtonGroup segmented label={t('web.period_label')}>
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            className={cx('btn', 'sm', value === preset && 'on')}
            aria-pressed={value === preset}
            onClick={() => onChange(preset)}
          >
            {t(PERIOD_LABEL[preset])}
          </button>
        ))}
      </ButtonGroup>
      {value === 'custom' && custom !== undefined && <span className="custom">{custom}</span>}
      {onCompareChange !== undefined && (
        <Checkbox
          label={t('web.period_compare')}
          checked={compare === true}
          onChange={onCompareChange}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- forms --- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  compact = false,
  required = false,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  /** Tighter, for a labelled exact-match input inside a table toolbar. */
  compact?: boolean;
  required?: boolean;
}) {
  return (
    <div className={cx('field', compact && 'compact', error !== undefined && 'invalid')}>
      <label {...(htmlFor === undefined ? {} : { htmlFor })}>
        {label}
        {required && (
          <span className="danger" aria-hidden="true">
            *
          </span>
        )}
      </label>
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

/** A text input with the kit's look. Every prop is passed through. */
export function Input({
  className,
  size = 'md',
  ...rest
}: { className?: string; size?: 'md' | 'sm' } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'size'
>) {
  return <input className={cx('input', size === 'sm' && 'sm', className)} {...rest} />;
}

export function Textarea({
  className,
  ...rest
}: { className?: string } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return <textarea className={cx('input', className)} {...rest} />;
}

export function Select({
  className,
  size = 'md',
  children,
  ...rest
}: { className?: string; size?: 'md' | 'sm'; children: ReactNode } & Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'size' | 'children'
>) {
  return (
    <select className={cx('input', size === 'sm' && 'sm', className)} {...rest}>
      {children}
    </select>
  );
}

/** A labelled checkbox. The label is the control's name. */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled = false,
  name,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  name?: string;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        {...(name === undefined ? {} : { name })}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** One labelled radio of a group sharing `name`. */
export function Radio<T extends string>({
  label,
  name,
  value,
  selected,
  onChange,
  disabled = false,
}: {
  label: ReactNode;
  name: string;
  value: T;
  selected: string;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="radio">
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected === value}
        disabled={disabled}
        onChange={() => onChange(value)}
      />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  danger = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Red when on: a switch whose ON state is the risky one. */
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', checked && 'on', danger && 'danger')}
      disabled={disabled === true}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** A setting line: a title and a helper sentence, with its switch at the end. */
export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
  danger,
}: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="txt">
        <b>{title}</b>
        {description !== undefined && <span>{description}</span>}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label={title}
        {...(disabled === undefined ? {} : { disabled })}
        {...(danger === undefined ? {} : { danger })}
      />
    </div>
  );
}

/**
 * A search box: a visually hidden label (the accessible name), the glyph, and
 * the input. It does not debounce or submit — the caller owns when a search
 * becomes a request.
 */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder,
  id,
  dir,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
  id?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
}) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="search">
      <label className="visually-hidden" htmlFor={inputId}>
        {label}
      </label>
      <Icon name="search" size={14} />
      <input
        id={inputId}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        {...(dir === undefined ? {} : { dir })}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** The bar above a list: search, filters and actions, wrapping on a narrow screen. */
export function FilterBar({ children, hidden }: { children: ReactNode; hidden?: boolean }) {
  return (
    <div className="toolbar" {...(hidden === undefined ? {} : { hidden })}>
      {children}
    </div>
  );
}

/** A row of filter chips. `ChipDivider` separates two groups of them. */
export function FilterChips({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      className="filter-row"
      role="group"
      {...(label === undefined ? {} : { 'aria-label': label })}
    >
      {children}
    </div>
  );
}

/**
 * One filter chip — a toggle. `count`, when given, must be a REAL server
 * total (lead decision D2); a count computed from the page of rows on screen
 * is not a count of anything.
 */
export function FilterChip({
  pressed,
  onClick,
  children,
  count,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      className={cx('chip', pressed && 'on')}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {children}
      {count !== undefined && <span className="cnt num">{formatNumber(count)}</span>}
    </button>
  );
}

export function ChipDivider() {
  return <span className="divider" aria-hidden="true" />;
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
  label,
  configured,
  meta,
  onReplace,
  onRemove,
}: {
  /**
   * Which credential this row IS — required, not optional.
   *
   * Three rows rendered only presence, a timestamp and an identically named
   * "Remove". With a username and an API token configured, an operator saw two
   * indistinguishable destructive controls and could delete the wrong live
   * credential; a screen reader announced both as simply "remove". The name is
   * both visible and part of each button's accessible name.
   */
  label: string;
  configured: boolean;
  meta?: string;
  onReplace?: () => void;
  onRemove?: () => void;
}) {
  return (
    <div className="secret">
      <Icon name="lock" size={14} className="faint" />
      <span className="strong">{label}</span>
      <Badge tone={configured ? 'ok' : 'neutral'} dot>
        {configured ? t('web.credential_set') : t('web.credential_absent')}
      </Badge>
      {meta !== undefined && <span className="faint small">{meta}</span>}
      <span className="spacer" />
      {onReplace !== undefined && (
        <button
          type="button"
          className="btn sm"
          aria-label={`${t('web.replace')} — ${label}`}
          onClick={onReplace}
        >
          {t('web.replace')}
        </button>
      )}
      {onRemove !== undefined && configured && (
        <button
          type="button"
          className="btn sm ghost danger"
          aria-label={`${t('web.remove')} — ${label}`}
          onClick={onRemove}
        >
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
  variant,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  icon?: IconName;
  variant?: 'error' | 'denied' | 'compact';
}) {
  return (
    <div className={cx('empty', variant)}>
      <Icon name={icon ?? 'inbox'} size={28} />
      <strong>{title}</strong>
      {hint !== undefined && <p className="muted small">{hint}</p>}
      {action}
    </div>
  );
}
/** `Empty` by the name the kit inventory uses. */
export const EmptyState = Empty;

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

/**
 * A loading placeholder that is announced. `Skeleton` is decorative
 * (`aria-hidden`); this adds the words for a screen reader.
 */
export function LoadingState({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-busy="true">
      <span className="visually-hidden">{t('web.loading')}</span>
      <Skeleton rows={rows} cols={cols} />
    </div>
  );
}

/** The error state of a query, in the same words `StateSwitch` uses. */
export function ErrorState({ query }: { query: QueryView }) {
  const copy = errorCopy(query);
  const onRetry = retryOf(query);
  return (
    <Empty
      variant="error"
      title={t(copy.title)}
      hint={t(copy.hint)}
      icon={copy.icon}
      action={
        onRetry === undefined ? undefined : (
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="refresh" />
            {t('web.retry')}
          </button>
        )
      }
    />
  );
}

/** The actor may not see this. Says so, and names nothing it may not see. */
export function PermissionDeniedState() {
  return (
    <Empty
      variant="denied"
      title={t('web.no_permission')}
      hint={t('web.no_permission_hint')}
      icon="lock"
    />
  );
}

export type { ViewState } from '../view-state';

/**
 * The five states every data view has, in one place.
 *
 * Written as one component because the alternative — each page spelling out its
 * own `isPending` / `isError` / `length === 0` ladder — is how a screen ends up
 * with a loading state and no empty state, or an empty state that is really an
 * error nobody surfaced.
 */
function StaleNotice({ onRetry }: { onRetry?: (() => void) | undefined }) {
  return (
    /*
     * ANNOUNCED, because nothing on screen prompted it.
     *
     * `Banner` gives a role only to `danger`, and this one arrives on a timer
     * with no user action behind it. Without a live region the page still stops
     * refreshing in silence for a screen-reader operator — the exact defect the
     * banner exists to remove, left in place for the one audience that cannot
     * see it. `status` rather than `alert`: it is worth knowing, not worth
     * interrupting what they are reading.
     */
    <Banner tone="warn" icon="alert" role="status">
      {t('web.refresh_failed')}{' '}
      {onRetry !== undefined && (
        <button type="button" className="link" onClick={onRetry}>
          {t('web.retry')}
        </button>
      )}
    </Banner>
  );
}

export function StateSwitch({
  query,
  denied = false,
  isEmpty = false,
  empty,
  children,
}: {
  /**
   * ONE object, from which the state, the staleness and the retry are all
   * derived here — see `QueryView` in `view-state.ts` for why they are not
   * three props any more.
   */
  query: QueryView;
  /** The actor may not see this at all, which outranks every query state. */
  denied?: boolean;
  isEmpty?: boolean;
  empty?: ReactNode;
  children: ReactNode;
}) {
  const state = denied ? 'denied' : queryState(query, isEmpty);
  const stale = staleAfterError(query);
  const onRetry = retryOf(query);
  if (state === 'loading') return <Skeleton />;
  if (state === 'denied') return <PermissionDeniedState />;
  // A refusal is not a connection failure, and neither is any other final
  // answer. `errorCopy` decides all three together so this site and the
  // alerts detail cannot drift apart again.
  if (state === 'error') return <ErrorState query={query} />;
  if (state === 'empty')
    return (
      <>
        {stale && <StaleNotice onRetry={onRetry} />}
        {empty ?? <Empty title={t('web.empty')} />}
      </>
    );
  return (
    <>
      {stale && <StaleNotice onRetry={onRetry} />}
      {children}
    </>
  );
}

/* ---------------------------------------------------------------- tables --- */

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  /** Right-aligned numeric column in a logical-property world: `end`. */
  readonly align?: 'start' | 'end';
  /** Lets the cell wrap instead of holding one line — for free text. */
  readonly wrap?: boolean;
}

/**
 * A table over a page of rows the SERVER decided.
 *
 * It deliberately cannot sort. Sorting the rows it holds would sort ONE PAGE,
 * which is the defect revision 13 names: a "newest first" that only orders the
 * fifty rows already fetched is worse than no ordering, because it looks
 * right. Ordering is a query parameter or it does not exist, and this component
 * has no idea what the query was.
 *
 * The `<caption>` is the table's accessible name, always. `toolbar` and
 * `filters` are drawn above it, flush with the card that holds it; `sticky`
 * keeps the header row in view inside a bounded scroll area; `dense` is the
 * compact row height the reference uses for long lists.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  dense = false,
  sticky = false,
  toolbar,
  filters,
  rowClassName,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  caption: string;
  dense?: boolean;
  sticky?: boolean;
  toolbar?: ReactNode;
  filters?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
}) {
  return (
    <>
      {toolbar !== undefined && <div className="toolbar">{toolbar}</div>}
      {filters !== undefined && <div className="filter-row">{filters}</div>}
      <div className={cx('tbl-wrap', sticky && 'sticky')}>
        <table className={cx('tbl', dense && 'dense')}>
          <caption className="visually-hidden">{caption}</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                // Classes, not a `style` attribute. The production document
                // policy is `style-src 'self'`, which blocks element `style`
                // attributes outright — so an inline alignment silently does
                // nothing in the DEPLOYMENT while jsdom and the build stay
                // green.
                <th
                  key={column.key}
                  scope="col"
                  className={cx(
                    `al-${column.align === 'end' ? 'end' : 'start'}`,
                    column.wrap && 'wrap',
                  )}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)} className={rowClassName?.(row)}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      `al-${column.align === 'end' ? 'end' : 'start'}`,
                      column.wrap && 'wrap',
                    )}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
/** `DataTable` by the name the kit inventory uses. */
export const Table = DataTable;

/** A two-line cell: the primary value, and a quieter line beneath it. */
export function CellMain({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <span className="cell-main">
      <span>{primary}</span>
      {secondary !== undefined && <span>{secondary}</span>}
    </span>
  );
}

/** The actions at the end of a row. Put them in a column with `align: 'end'`. */
export function RowActions({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  // `wrap`: more actions than fit one line beside the data break onto a second
  // line, so a row with three buttons never pushes its table wider than the card.
  return <span className={wrap ? 'row-actions wrap' : 'row-actions'}>{children}</span>;
}

/**
 * Keyset paging: forward through opaque cursors, and back through the ones
 * already seen.
 *
 * There is no page number, because the API does not offer one: `nextCursor` is
 * opaque and the response says nothing about how many pages exist. Rendering
 * "page 3 of 12" would require counting the collection on every request, which
 * is the thing keyset paging exists to avoid.
 *
 * The labels FOLLOW the traversal, and the caller is the one that knows it.
 * The ops-log and notification lists walk `before` cursors down a `DESC`
 * keyset, so their next page is older and the way back is newer — the
 * defaults. The panel lists walk an `ASC` keyset, so their next page is NEWER
 * and they pass the labels the other way round.
 *
 * The cursor is opaque to this component and it stays that way.
 */
export function CursorPager({
  onPrevious,
  onNext,
  hasPrevious,
  hasNext,
  shown,
  nextLabel = 'web.older',
  previousLabel = 'web.newer',
  summary,
}: {
  onPrevious: () => void;
  onNext: () => void;
  hasPrevious: boolean;
  hasNext: boolean;
  /** Rows on this page, drawn as `web.showing` N unless `summary` says something else. */
  shown?: number;
  nextLabel?: WebKey;
  previousLabel?: WebKey;
  /**
   * What the pager says about the rows, in place of «نمایش N»: a report that
   * pages by offset knows its total («تعداد کل: N»), and one that pages by an
   * opaque cursor may say nothing at all (`null`).
   */
  summary?: ReactNode;
}) {
  const said =
    summary !== undefined ? (
      summary
    ) : shown === undefined ? null : (
      <>
        {t('web.showing')} <Num value={shown} />
      </>
    );
  return (
    <div className="pager">
      {said !== null && <span className="muted small">{said}</span>}
      <span className="spacer" />
      <button type="button" className="btn sm" disabled={!hasPrevious} onClick={onPrevious}>
        <Icon name="chevronRight" />
        {t(previousLabel)}
      </button>
      <button type="button" className="btn sm" disabled={!hasNext} onClick={onNext}>
        {t(nextLabel)}
        <Icon name="chevronLeft" />
      </button>
    </div>
  );
}
/** `CursorPager` by the name the kit inventory uses. The semantics are keyset. */
export const Pagination = CursorPager;

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
  /*
   * The dismissal timers still pending. They are cleared when the provider unmounts:
   * a timer that outlived it fired into a torn-down tree — after a sign-out, and in the
   * web suite after the test environment was gone, where it threw `window is not
   * defined` and failed a run whose every test had passed.
   */
  const timers = useRef(new Set<number>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const notify = useCallback<Notify>((toast) => {
    next.current += 1;
    const id = next.current;
    setToasts((current) => [...current, { ...toast, id }]);
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, 4000);
    timers.current.add(timer);
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
          {/*
            SVG, because the width is a CONTINUOUS value and the production
            policy is `style-src 'self'`. SVG geometry is a presentation
            ATTRIBUTE rather than a style, so it is not subject to `style-src`
            at all, and the bar renders under the deployed CSP.
          */}
          <svg
            className="bar"
            viewBox="0 0 100 8"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            <rect
              className={slice.tone ?? 'info'}
              x="0"
              y="0"
              height="8"
              width={(slice.count / total) * 100}
            />
          </svg>
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
            aria-label={`${t('web.move_up')} — ${index + 1}`}
            disabled={disabled === true || index === 0}
            onClick={() => move(index, -1)}
          >
            {/*
              A class, not `style={{ transform }}`: under `style-src 'self'`
              the inline transform is dropped and BOTH reorder arrows point
              the same way — a control that lies about its direction, in the
              deployment only.
            */}
            <span className="flip">
              <Icon name="chevron" size={13} />
            </span>
          </button>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={`${t('web.move_down')} — ${index + 1}`}
            disabled={disabled === true || index === items.length - 1}
            onClick={() => move(index, 1)}
          >
            <Icon name="chevron" size={13} />
          </button>
          <button
            type="button"
            className="btn ghost icon sm danger"
            aria-label={`${t('web.remove')} — ${index + 1}`}
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

/* ----------------------------------------------------------- breadcrumbs --- */

export interface Crumb {
  readonly label: string;
  readonly href?: string;
}

/**
 * The trail to the current page. The last crumb is the page itself
 * (`aria-current`), the rest are links that navigate without a reload.
 */
export function Breadcrumbs({ items }: { items: readonly Crumb[] }) {
  const onLink = useLinkHandler();
  return (
    <nav className="crumbs" aria-label={t('web.breadcrumbs')}>
      {items.map((crumb, index) => (
        <span key={`${crumb.label}-${index}`}>
          {index > 0 && (
            <span className="sep" aria-hidden="true">
              /
            </span>
          )}
          {crumb.href === undefined ? (
            <span className="cur" aria-current="page">
              {crumb.label}
            </span>
          ) : (
            <a href={crumb.href} onClick={onLink}>
              {crumb.label}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}

/* Re-exported so a page imports its whole kit from one module. */
export { Modal, Drawer, Menu, useFocusTrap } from './overlays';
export { ChartCard, Sparkline, BarChart, LineChart, Donut, Legend, axisLabelSlots } from './charts';
export { useUnsavedChanges, LeaveGuardHost } from './unsaved';
export { ConfirmDialog, confirmDialogOpen } from './confirm-dialog';
