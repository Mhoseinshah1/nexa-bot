import { useId, useMemo, useState, type ReactNode } from 'react';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';

/**
 * Small, dependency-free charts, drawn as SVG.
 *
 * Why hand-rolled: the admin has three runtime dependencies, and a chart
 * library to draw a line, a bar and a ring would be the largest of them.
 *
 * Four rules hold for every chart here:
 *
 * - **No style attributes.** The production policy is `style-src 'self'`.
 *   Geometry is SVG attributes and colour is a class (`s1`…`s6`) bound to the
 *   `--chart-*` tokens, so both themes are one stylesheet.
 * - **No invented points.** A `null` is a gap — the line breaks, the bar is
 *   absent — never a zero and never an interpolation. Fewer than two points
 *   draws no line at all.
 * - **The numbers are always reachable as text.** Each chart carries a
 *   visually hidden table of every value, a caption as its accessible name,
 *   and a hover/focus readout under the plot.
 * - **The time axis runs left to right**, as the reference draws it: the svg
 *   is LTR, while every label and legend around it stays in the document's
 *   direction.
 */

export type SeriesTone = 1 | 2 | 3 | 4 | 5 | 6;

const DEFAULT_WIDTH = 720;

/** A "nice" ceiling for an axis: 1, 2 or 5 times a power of ten. */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
}

/**
 * A tight axis ceiling (the demo's): the largest value plus 4% of headroom, rounded up to a whole
 * number, so the peak sits just under the top line (a stacked bar of 69 gets 72: 18, 36, 54, 72)
 * instead of a "nice" 100 that leaves a third of the plot empty. Always a coordinate, never a
 * figure the page states.
 */
export function tightCeiling(max: number): number {
  if (!(max > 0)) return 1;
  return Math.max(1, Math.ceil(max * 1.04));
}

/**
 * A value-axis tick as short text (`21M`, `5.3M`, `850K`, `72`): Latin digits, one decimal at
 * most, no grouping. A coordinate on an axis, never a figure — readouts and tables keep the
 * exact value.
 */
export function compactAxis(value: number): string {
  const abs = Math.abs(value);
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e4) return `${trim(value / 1e3)}K`;
  return formatNumber(Math.round(value));
}

/**
 * Which x-axis slots carry a label: every `step`-th from the first, where
 * `step` keeps at most `most` labels, and always the last. When the last does
 * not land on the stepping, the stepped label before it is dropped rather
 * than drawn on top of it — two labels are never closer than one `step`.
 */
export function axisLabelSlots(slots: number, most: number): ReadonlySet<number> {
  const shown = new Set<number>();
  if (slots <= 0) return shown;
  const step = Math.max(1, Math.ceil(slots / Math.max(1, most)));
  for (let i = 0; i < slots; i += step) shown.add(i);
  const last = slots - 1;
  const lastStepped = last - (last % step);
  if (lastStepped !== last && lastStepped !== 0) shown.delete(lastStepped);
  shown.add(last);
  return shown;
}

function defaultFormat(value: number): string {
  return formatNumber(Math.round(value));
}

/* ---------------------------------------------------------------- legend --- */

export function Legend({
  items,
}: {
  items: readonly {
    readonly label: string;
    readonly tone?: SeriesTone;
    readonly dashed?: boolean;
  }[];
}) {
  return (
    <ul className="legend">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <i
            className={`key s${item.tone ?? (index % 6) + 1}${item.dashed === true ? ' dashed' : ''}`}
            aria-hidden="true"
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- chart card --- */

/** A card that frames one chart: a title, an optional legend at its end, the plot. */
export function ChartCard({
  title,
  hint,
  legend,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  legend?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card chart-card${className === undefined ? '' : ` ${className}`}`}>
      <header className="card-head">
        <div className="titles">
          <h2>{title}</h2>
          {hint !== undefined && <p className="hint">{hint}</p>}
        </div>
        {legend}
        {actions !== undefined && <div className="actions">{actions}</div>}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------- sparkline --- */

/** A tiny trend line for a KPI card. Nothing is drawn from fewer than two points. */
export function Sparkline({
  values,
  label,
  tone = 1,
}: {
  values: readonly (number | null)[];
  /** The accessible name: what trend this is. */
  label: string;
  tone?: SeriesTone;
}) {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return null;
  const w = 120;
  const h = 28;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = max - min || 1;
  const x = (i: number) => (values.length <= 1 ? 0 : (i / (values.length - 1)) * w);
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const runs = segments(values);
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {runs.map((run) => {
        const d = run
          .map(
            (i, n) =>
              `${n === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`,
          )
          .join(' ');
        const first = run[0] as number;
        const last = run[run.length - 1] as number;
        return (
          <g key={first} className={`s${tone}`}>
            <path
              className="area"
              d={`${d} L${x(last).toFixed(1)},${h} L${x(first).toFixed(1)},${h} Z`}
            />
            <path className="line" d={d} />
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------ area spark --- */

/** A `useId` value as a token an SVG `url(#…)` reference can name. */
function svgId(id: string): string {
  return `g${id.replace(/[^A-Za-z0-9_-]/gu, '')}`;
}

/** How tall an area spark's geometry is, by where it is drawn. */
const AREA_SPARK_HEIGHT = { hero: 120, card: 56, tile: 40 } as const;

/**
 * A KPI trend as a filled area: a gradient under the line, fading to the baseline, and the
 * last known point marked. The geometry is inset from every edge, so a final rise is drawn
 * inside the card, never as a hairline spike against its border.
 *
 * Two shapes are not trends and are drawn as a flat, centred baseline instead: fewer than
 * two known points, and a series whose every point is the same (all zero, typically). A
 * `null` is a gap, as on every chart here — never a zero.
 */
export function AreaSpark({
  values,
  label,
  tone = 1,
  size = 'tile',
}: {
  values: readonly (number | null)[];
  /** The accessible name: what trend this is. */
  label: string;
  tone?: SeriesTone;
  /** `hero` fills the space its card gives it; `card` and `tile` are fixed strips. */
  size?: keyof typeof AREA_SPARK_HEIGHT;
}) {
  const gradientId = svgId(useId());
  const w = 300;
  const h = AREA_SPARK_HEIGHT[size];
  const padX = 4;
  const padTop = Math.round(h * 0.14);
  const padBottom = 2;
  const known = values.filter((value): value is number => value !== null);
  const max = known.length === 0 ? 0 : Math.max(...known);
  const min = known.length === 0 ? 0 : Math.min(0, ...known);
  const flat = known.length < 2 || max === Math.min(...known);
  const className = `area-spark as-${size} s${tone}${flat ? ' flat' : ''}`;
  if (flat) {
    return (
      <svg
        className={className}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <path className="baseline" d={`M${padX},${h / 2} L${w - padX},${h / 2}`} />
      </svg>
    );
  }
  const span = max - min || 1;
  const x = (i: number) =>
    values.length <= 1 ? w / 2 : padX + (i / (values.length - 1)) * (w - 2 * padX);
  const y = (v: number) => padTop + (1 - (v - min) / span) * (h - padTop - padBottom);
  const runs = segments(values);
  const lastIndex = values.reduce<number>((last, value, i) => (value === null ? last : i), -1);
  const lastValue = values[lastIndex] as number;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={gradientId} className="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopOpacity={0.38} />
          <stop offset="1" stopOpacity={0} />
        </linearGradient>
      </defs>
      {runs.map((run) => {
        const d = run
          .map(
            (i, n) =>
              `${n === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(values[i] as number).toFixed(1)}`,
          )
          .join(' ');
        const first = run[0] as number;
        const last = run[run.length - 1] as number;
        return (
          <g key={first}>
            <path
              className="area"
              fill={`url(#${gradientId})`}
              d={`${d} L${x(last).toFixed(1)},${h} L${x(first).toFixed(1)},${h} Z`}
            />
            <path className="line" d={d} />
          </g>
        );
      })}
      {/* A zero-length round-capped stroke: a dot that stays round however the box stretches. */}
      <path className="last" d={`M${x(lastIndex).toFixed(1)},${y(lastValue).toFixed(1)} h0`} />
    </svg>
  );
}

/* ------------------------------------------------------------ line chart --- */

/**
 * What a reader is shown for each value, where a coordinate cannot carry it exactly.
 *
 * `values` is geometry, and a `number` rounds past 2^53; a money figure arrives as an exact
 * minor-unit string. When `texts[i]` is given, the readout, the focus label and the hidden
 * table show it instead of `format(values[i])`, so the chart never states a rounded figure.
 */
type ValueTexts = readonly (string | null)[];

export interface LineSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
  readonly texts?: ValueTexts;
  readonly tone?: SeriesTone;
  /** A comparison series: dashed, no area, drawn beneath the others. */
  readonly dashed?: boolean;
  readonly area?: boolean;
}

/**
 * A time series, with an optional previous-period series drawn dashed beneath
 * it. Each x slot is a hover and focus target whose readout names every
 * series' value at that point.
 */
export function LineChart({
  labels,
  series,
  caption,
  format = defaultFormat,
  height = 220,
  width = DEFAULT_WIDTH,
  gradient = false,
  axisFormat,
  tight = false,
}: {
  labels: readonly string[];
  series: readonly LineSeries[];
  caption: string;
  format?: (value: number) => string;
  height?: number;
  /** The viewBox width: the card's own width keeps the axis text at its true size. */
  width?: number;
  /** Fill the area under each solid line with a gradient that fades to the axis. */
  gradient?: boolean;
  /** A value-axis tick as short text; the readout and the table keep `format`. */
  axisFormat?: (value: number) => string;
  /** A ceiling just above the peak (`tightCeiling`) instead of a "nice" round one. */
  tight?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const gradientId = svgId(useId());
  const WIDTH = width;
  const known = series.flatMap((one) => one.values.filter((v): v is number => v !== null));
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const max = (tight ? tightCeiling : niceCeiling)(Math.max(0, ...known));
  const slots = labels.length;
  const x = (i: number) => padL + (slots <= 1 ? 0 : (i / (slots - 1)) * (WIDTH - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const slotW = slots <= 1 ? WIDTH - padL - padR : (WIDTH - padL - padR) / (slots - 1);
  const labelled = axisLabelSlots(slots, Math.max(3, Math.round(WIDTH / 90)));

  if (known.length === 0) return <ChartEmpty />;

  return (
    <figure className="chart-figure">
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={caption}>
        {gradient && (
          <defs>
            {series.map((one, index) => (
              <linearGradient
                key={one.name}
                id={`${gradientId}-${index}`}
                className={`grad s${one.tone ?? (index % 6) + 1}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0" stopOpacity={0.32} />
                <stop offset="1" stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
        )}
        <Grid max={max} y={y} padL={padL} padR={padR} format={axisFormat ?? format} width={WIDTH} />
        {labels.map((label, i) =>
          labelled.has(i) ? (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle">
              {label}
            </text>
          ) : null,
        )}
        {series.map((one, index) => {
          const tone = one.tone ?? (index % 6) + 1;
          const runs = segments(one.values);
          return (
            <g key={one.name} className={one.dashed === true ? 'muted-series' : `s${tone}`}>
              {runs.map((run) => {
                const d = run
                  .map(
                    (i, n) =>
                      `${n === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(one.values[i] as number).toFixed(1)}`,
                  )
                  .join(' ');
                const first = run[0] as number;
                const last = run[run.length - 1] as number;
                return (
                  <g key={first}>
                    {one.dashed !== true && one.area !== false && (
                      <path
                        className={gradient ? 'area graded' : 'area'}
                        d={`${d} L${x(last).toFixed(1)},${y(0)} L${x(first).toFixed(1)},${y(0)} Z`}
                        {...(gradient ? { fill: `url(#${gradientId}-${index})` } : {})}
                      />
                    )}
                    <path className={one.dashed === true ? 'line dashed' : 'line'} d={d} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {active !== null && (
          <line className="cursor" x1={x(active)} x2={x(active)} y1={padT} y2={height - padB} />
        )}
        {labels.map((label, i) => (
          <rect
            key={i}
            className="hit"
            x={Math.max(padL - slotW / 2, x(i) - slotW / 2)}
            y={padT}
            width={slotW}
            height={height - padT - padB}
            tabIndex={0}
            aria-label={readout(label, series, i, format)}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      <Readout active={active} labels={labels} series={series} format={format} />
      <DataTableFor caption={caption} labels={labels} series={series} format={format} />
    </figure>
  );
}

/* ------------------------------------------------------------- bar chart --- */

export interface BarSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
  readonly texts?: ValueTexts;
  readonly tone?: SeriesTone;
}

/** Columns per category, grouped side by side or stacked. */
export function BarChart({
  labels,
  series,
  caption,
  stacked = false,
  format = defaultFormat,
  height = 200,
  width = DEFAULT_WIDTH,
  ticks = [0, 0.5, 1],
  axisFormat,
  tight = false,
}: {
  labels: readonly string[];
  series: readonly BarSeries[];
  caption: string;
  stacked?: boolean;
  format?: (value: number) => string;
  height?: number;
  /** The viewBox width: the card's own width keeps the axis text at its true size. */
  width?: number;
  /** The gridlines, as shares of the axis ceiling. */
  ticks?: readonly number[];
  /** A value-axis tick as short text; the readout and the table keep `format`. */
  axisFormat?: (value: number) => string;
  /** A ceiling just above the tallest bar (`tightCeiling`) instead of a "nice" round one. */
  tight?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const WIDTH = width;
  const padL = 46;
  const padR = 8;
  const padT = 10;
  const padB = 26;
  const slots = labels.length;
  const totals = labels.map((_, i) =>
    stacked
      ? series.reduce((sum, one) => sum + (one.values[i] ?? 0), 0)
      : Math.max(0, ...series.map((one) => one.values[i] ?? 0)),
  );
  const anything = series.some((one) => one.values.some((v) => v !== null));
  const max = (tight ? tightCeiling : niceCeiling)(Math.max(0, ...totals));
  const slot = slots === 0 ? 0 : (WIDTH - padL - padR) / slots;
  const bw = stacked ? slot * 0.55 : (slot * 0.7) / Math.max(1, series.length);
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const labelled = axisLabelSlots(slots, Math.max(3, Math.round(WIDTH / 72)));

  if (!anything) return <ChartEmpty />;

  return (
    <figure className="chart-figure">
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={caption}>
        <Grid
          max={max}
          y={y}
          padL={padL}
          padR={padR}
          format={axisFormat ?? format}
          ticks={ticks}
          width={WIDTH}
        />
        {labels.map((label, i) => {
          const cx = padL + slot * i + slot / 2;
          let acc = 0;
          return (
            <g key={i}>
              {series.map((one, index) => {
                const value = one.values[i];
                if (value === null || value === undefined) return null;
                const top = stacked ? y(acc + value) : y(value);
                const bottom = stacked ? y(acc) : y(0);
                const left = stacked ? cx - bw / 2 : cx - (bw * series.length) / 2 + index * bw;
                acc += value;
                return (
                  <rect
                    key={one.name}
                    className={`bar s${one.tone ?? (index % 6) + 1}`}
                    x={left}
                    y={top}
                    width={Math.max(0, bw - (stacked ? 0 : 2))}
                    height={Math.max(0, bottom - top)}
                    rx={2}
                  />
                );
              })}
              {labelled.has(i) && (
                <text x={cx} y={height - 8} textAnchor="middle">
                  {label}
                </text>
              )}
              <rect
                className="hit"
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={height - padT - padB}
                tabIndex={0}
                aria-label={readout(label, series, i, format)}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      <Readout active={active} labels={labels} series={series} format={format} />
      <DataTableFor caption={caption} labels={labels} series={series} format={format} />
    </figure>
  );
}

/* ----------------------------------------------------------------- donut --- */

export interface DonutSlice {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly tone?: SeriesTone;
}

/** Shares of a whole, as a ring with its legend. The total is in the middle. */
export function Donut({
  slices,
  caption,
  format = defaultFormat,
  center,
  shares = true,
}: {
  slices: readonly DonutSlice[];
  caption: string;
  format?: (value: number) => string;
  /** What the middle says; defaults to the formatted total. */
  center?: string;
  /** Print each slice's percentage beside its value (the demo's dashboard legend does not). */
  shares?: boolean;
}) {
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
  if (total === 0) return <ChartEmpty />;
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="chart-figure donut">
      <div className="row">
        <svg
          className="chart donut-svg"
          viewBox="0 0 100 100"
          width="150"
          height="150"
          role="img"
          aria-label={caption}
        >
          <circle className="donut-track" cx={50} cy={50} r={r} strokeWidth={14} />
          {slices.map((slice, index) => {
            const share = Math.max(0, slice.value) / total;
            const node = (
              <circle
                key={slice.key}
                className={`donut-seg s${slice.tone ?? (index % 6) + 1}`}
                cx={50}
                cy={50}
                r={r}
                strokeWidth={14}
                strokeDasharray={`${share * c} ${c}`}
                strokeDashoffset={-offset * c}
                transform="rotate(-90 50 50)"
              >
                <title>{`${slice.label}: ${format(slice.value)}`}</title>
              </circle>
            );
            offset += share;
            return node;
          })}
          <text className="donut-total" x={50} y={54} textAnchor="middle">
            {center ?? format(total)}
          </text>
        </svg>
        <ul className="legend donut-legend">
          {slices.map((slice, index) => (
            <li key={slice.key}>
              <i className={`key s${slice.tone ?? (index % 6) + 1}`} aria-hidden="true" />
              <span>{slice.label}</span>
              <b className="num">{format(slice.value)}</b>
              {shares && (
                <span className="faint num">{`${formatNumber(Math.round((Math.max(0, slice.value) / total) * 100))}${t('web.percent_sign')}`}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/* --------------------------------------------------------------- helpers --- */

interface TextedSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
  readonly texts?: ValueTexts;
}

/** One value as a reader sees it: the exact text when supplied, else the formatted coordinate. */
function valueText(one: TextedSeries, i: number, format: (value: number) => string): string {
  const value = one.values[i];
  if (value === null || value === undefined) return '—';
  return one.texts?.[i] ?? format(value);
}

function ChartEmpty() {
  return <div className="chart-empty">{t('web.chart_empty')}</div>;
}

function Grid({
  max,
  y,
  padL,
  padR,
  format,
  ticks = [0, 0.25, 0.5, 0.75, 1],
  width = DEFAULT_WIDTH,
}: {
  max: number;
  y: (v: number) => number;
  padL: number;
  padR: number;
  format: (value: number) => string;
  ticks?: readonly number[];
  width?: number;
}) {
  const WIDTH = width;
  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            className="grid-line"
            x1={padL}
            x2={WIDTH - padR}
            y1={y(max * tick)}
            y2={y(max * tick)}
          />
          <text x={padL - 8} y={y(max * tick) + 3.5} textAnchor="end">
            {format(max * tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

function readout(
  label: string,
  series: readonly TextedSeries[],
  i: number,
  format: (value: number) => string,
): string {
  const parts = series.map((one) => `${one.name}: ${valueText(one, i, format)}`);
  return `${label} — ${parts.join(t('web.list_separator'))}`;
}

function Readout({
  active,
  labels,
  series,
  format,
}: {
  active: number | null;
  labels: readonly string[];
  series: readonly TextedSeries[];
  format: (value: number) => string;
}) {
  return (
    <div className="chart-readout" aria-live="polite">
      {active === null ? (
        <span className="faint">{t('web.report_chart_hover_hint')}</span>
      ) : (
        <>
          <strong>{labels[active]}</strong>
          {series.map((one) => (
            <span key={one.name}>
              {one.name}: <b className="num">{valueText(one, active, format)}</b>
            </span>
          ))}
        </>
      )}
    </div>
  );
}

/** Every value as a table, for a screen reader and for anyone who needs the exact figure. */
function DataTableFor({
  caption,
  labels,
  series,
  format,
}: {
  caption: string;
  labels: readonly string[];
  series: readonly TextedSeries[];
  format: (value: number) => string;
}) {
  const id = useId();
  const rows = useMemo(() => labels.map((label, i) => ({ label, i })), [labels]);
  return (
    <table className="visually-hidden" aria-labelledby={id}>
      <caption id={id}>{`${caption} — ${t('web.chart_table')}`}</caption>
      <thead>
        <tr>
          <th scope="col">{t('web.chart_category')}</th>
          {series.map((one) => (
            <th key={one.name} scope="col">
              {one.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ label, i }) => (
          <tr key={i}>
            <th scope="row">{label}</th>
            {series.map((one) => (
              <td key={one.name}>{valueText(one, i, format)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Runs of consecutive known values, so a missing bucket breaks the line instead of zeroing it. */
function segments(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((value, i) => {
    if (value === null) {
      if (run.length > 0) out.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length > 0) out.push(run);
  return out.filter((segment) => segment.length > 1);
}
