import type { ReactNode } from 'react';
import type { KpiDelta } from '../dashboard-view';
import { t } from '../i18n/web.fa';
import { Icon, type IconName } from '../ui/icons';
import { Num, PERIOD_PRESETS, type DistributionSlice, type PeriodPreset } from '../ui/kit';
import type { WebKey } from '../i18n/web.fa';

/**
 * The dashboard's own pieces (the approved demo's `#/` composition): the header controls,
 * the KPI card in its three sizes, and the movement pill. Presentation only — every figure
 * is the caller's, from the server; these draw what they are given and decide nothing.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------- the pill --- */

/**
 * A movement against the previous period, as a pill: an arrow and the percentage, green for
 * a good movement, red for a bad one, neutral for none. «جدید» (nothing before) has no
 * percentage, so it is a neutral pill with no arrow.
 */
export function DeltaPill({ delta }: { delta: KpiDelta }) {
  const direction = delta.fresh === true ? 'neutral' : delta.direction;
  const arrow = delta.fresh === true ? undefined : delta.trend;
  return (
    <span className={cx('dash-delta', 'delta', direction)}>
      {arrow === 'up' && <Icon name="arrowUp" size={11} />}
      {arrow === 'down' && <Icon name="arrowDown" size={11} />}
      {/* Isolated LTR, so «+12.5%» keeps its sign in front inside a Persian line. */}
      <span className="num signed">{delta.text}</span>
    </span>
  );
}

/* -------------------------------------------------------------- KPI card --- */

export type KpiSize = 'hero' | 'card' | 'tile';

/**
 * One KPI: its label, the figure with its unit, and what goes under it.
 *
 *   - `hero` (today's sales): the large figure, the meta line with the pill and its
 *     caption, and an area chart filling the rest of the card;
 *   - `card` (this month, and the second row): the figure, the meta lines, a small chart;
 *   - `tile` (the 2×2 grid): the figure with its pill beside it, the caption, a sparkline.
 *
 * `tone` outlines a figure that needs attention (`alert` red, `warn` amber), never as
 * decoration.
 */
export function KpiCard({
  label,
  icon,
  value,
  unit,
  delta,
  caption,
  meta,
  lines,
  tone,
  size,
  className,
  chart,
}: {
  label: ReactNode;
  icon: IconName;
  value: ReactNode;
  unit?: ReactNode;
  /** Drawn only while comparison is on; the caption goes with it. */
  delta?: KpiDelta | undefined;
  /** What the movement is against; shown with the pill. `false`: the pill stands alone. */
  caption?: ReactNode | false;
  /** The line under the figure (a count, a state, a hint), before the pill. */
  meta?: ReactNode;
  /** Further lines (another currency, a breakdown). */
  lines?: ReactNode;
  tone?: 'alert' | 'warn' | undefined;
  size: KpiSize;
  className?: string;
  chart?: ReactNode;
}) {
  const pillBeside = size === 'tile';
  const shownCaption =
    delta === undefined || caption === false ? undefined : (caption ?? t('web.vs_previous'));
  return (
    <section
      className={cx(
        'card',
        'dash-kpi',
        `kpi-${size}`,
        tone === 'alert' && 'alert',
        tone === 'warn' && 'warnish',
        className,
      )}
    >
      <h2 className="dash-kpi-lbl">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </h2>
      <div className="dash-kpi-val">
        <span className="num">{value}</span>
        {unit !== undefined && <small>{unit}</small>}
        {pillBeside && delta !== undefined && <DeltaPill delta={delta} />}
      </div>
      {(meta !== undefined ||
        (!pillBeside && delta !== undefined) ||
        shownCaption !== undefined) && (
        <div className="dash-kpi-sub">
          {meta !== undefined && <span className="dash-kpi-meta">{meta}</span>}
          {!pillBeside && delta !== undefined && <DeltaPill delta={delta} />}
          {shownCaption !== undefined && <span className="dash-kpi-cap">{shownCaption}</span>}
        </div>
      )}
      {lines}
      {chart !== undefined && chart !== null && <div className="dash-kpi-chart">{chart}</div>}
    </section>
  );
}

/* ------------------------------------------------------- header controls --- */

const PERIOD_LABEL: Readonly<Record<PeriodPreset, WebKey>> = {
  today: 'web.period_today',
  '7d': 'web.period_7d',
  '30d': 'web.period_30d',
  month: 'web.period_month',
  custom: 'web.period_custom',
};

/**
 * The page header's controls, in the demo's order from the sidebar side: the period's
 * segmented capsule, the comparison SWITCH, and the refresh button. Drawn whatever the
 * figures are — loading, empty or refused — because choosing a period is how an empty
 * period is left; `refresh` is the caller's (withheld after a final refusal).
 */
export function DashboardControls({
  value,
  onChange,
  compare,
  onCompareChange,
  custom,
  refresh,
}: {
  value: PeriodPreset;
  onChange: (next: PeriodPreset) => void;
  compare: boolean;
  onCompareChange: (next: boolean) => void;
  /** The custom range's inputs, drawn while the custom preset is selected. */
  custom?: ReactNode;
  refresh?: ReactNode;
}) {
  return (
    <div className="dash-ctrls">
      <div className="pills dash-seg" role="group" aria-label={t('web.period_label')}>
        {PERIOD_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={value === preset ? 'on' : undefined}
            aria-pressed={value === preset}
            onClick={() => onChange(preset)}
          >
            {t(PERIOD_LABEL[preset])}
          </button>
        ))}
      </div>
      {value === 'custom' && custom}
      <button
        type="button"
        role="switch"
        aria-checked={compare}
        className={cx('dash-toggle', compare && 'on')}
        onClick={() => onCompareChange(!compare)}
      >
        <span className="dash-toggle-track" aria-hidden="true">
          <span />
        </span>
        <span>{t('web.period_compare')}</span>
      </button>
      {refresh}
    </div>
  );
}

/* ------------------------------------------------------------ section label --- */

/** A quiet label over a group of cards, with a hairline to the far edge. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="dash-sec">{children}</h2>;
}

/* ---------------------------------------------------------- share of a whole --- */

/**
 * A share-of-total breakdown as the demo draws the fleet: ONE segmented bar for the whole
 * group, then a row per slice — its coloured dot, its label and its exact server count.
 * The widths are SVG attributes (the production CSP drops a `style` attribute); a slice of
 * nothing is no segment and no row.
 */
export function ShareBar({ slices }: { slices: readonly DistributionSlice[] }) {
  const shown = slices.filter((slice) => slice.count > 0);
  const total = shown.reduce((sum, slice) => sum + slice.count, 0);
  if (total === 0) return null;
  const gap = shown.length > 1 ? 0.8 : 0;
  const room = 100 - gap * (shown.length - 1);
  let offset = 0;
  return (
    <div className="dash-share">
      <svg
        className="dash-stack"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {shown.map((slice) => {
          const width = (slice.count / total) * room;
          const node = (
            <rect
              key={slice.key}
              className={`tone-${slice.tone ?? 'info'}`}
              x={offset}
              y={0}
              width={width}
              height={10}
            />
          );
          offset += width + gap;
          return node;
        })}
      </svg>
      <ul className="dash-share-rows">
        {shown.map((slice) => (
          <li key={slice.key}>
            <i className={`dash-dot tone-${slice.tone ?? 'info'}`} aria-hidden="true" />
            <span className="grow">{slice.label}</span>
            <b className="num">
              <Num value={slice.count} />
            </b>
          </li>
        ))}
      </ul>
    </div>
  );
}
