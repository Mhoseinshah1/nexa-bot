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

const WIDTH = 720;

/** A "nice" ceiling for an axis: 1, 2 or 5 times a power of ten. */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= max) return step * power;
  }
  return 10 * power;
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

/* ------------------------------------------------------------ line chart --- */

export interface LineSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
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
}: {
  labels: readonly string[];
  series: readonly LineSeries[];
  caption: string;
  format?: (value: number) => string;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const known = series.flatMap((one) => one.values.filter((v): v is number => v !== null));
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 28;
  const max = niceCeiling(Math.max(0, ...known));
  const slots = labels.length;
  const x = (i: number) => padL + (slots <= 1 ? 0 : (i / (slots - 1)) * (WIDTH - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const slotW = slots <= 1 ? WIDTH - padL - padR : (WIDTH - padL - padR) / (slots - 1);
  const step = Math.max(1, Math.ceil(slots / 8));

  if (known.length === 0) return <ChartEmpty />;

  return (
    <figure className="chart-figure">
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={caption}>
        <Grid max={max} y={y} padL={padL} padR={padR} format={format} />
        {labels.map((label, i) =>
          i % step === 0 || i === slots - 1 ? (
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
                        className="area"
                        d={`${d} L${x(last).toFixed(1)},${y(0)} L${x(first).toFixed(1)},${y(0)} Z`}
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
}: {
  labels: readonly string[];
  series: readonly BarSeries[];
  caption: string;
  stacked?: boolean;
  format?: (value: number) => string;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
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
  const max = niceCeiling(Math.max(0, ...totals));
  const slot = slots === 0 ? 0 : (WIDTH - padL - padR) / slots;
  const bw = stacked ? slot * 0.55 : (slot * 0.7) / Math.max(1, series.length);
  const y = (v: number) => padT + (1 - v / max) * (height - padT - padB);
  const step = Math.max(1, Math.ceil(slots / 10));

  if (!anything) return <ChartEmpty />;

  return (
    <figure className="chart-figure">
      <svg className="chart" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={caption}>
        <Grid max={max} y={y} padL={padL} padR={padR} format={format} ticks={[0, 0.5, 1]} />
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
              {(i % step === 0 || i === slots - 1) && (
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
}: {
  slices: readonly DonutSlice[];
  caption: string;
  format?: (value: number) => string;
  /** What the middle says; defaults to the formatted total. */
  center?: string;
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
              <span className="faint num">{`${formatNumber(Math.round((Math.max(0, slice.value) / total) * 100))}${t('web.percent_sign')}`}</span>
            </li>
          ))}
        </ul>
      </div>
    </figure>
  );
}

/* --------------------------------------------------------------- helpers --- */

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
}: {
  max: number;
  y: (v: number) => number;
  padL: number;
  padR: number;
  format: (value: number) => string;
  ticks?: readonly number[];
}) {
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
  series: readonly { name: string; values: readonly (number | null)[] }[],
  i: number,
  format: (value: number) => string,
): string {
  const parts = series.map((one) => {
    const value = one.values[i];
    return `${one.name}: ${value === null || value === undefined ? '—' : format(value)}`;
  });
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
  series: readonly { name: string; values: readonly (number | null)[] }[];
  format: (value: number) => string;
}) {
  return (
    <div className="chart-readout" aria-live="polite">
      {active === null ? (
        <span className="faint">{t('web.report_chart_hover_hint')}</span>
      ) : (
        <>
          <strong>{labels[active]}</strong>
          {series.map((one) => {
            const value = one.values[active];
            return (
              <span key={one.name}>
                {one.name}:{' '}
                <b className="num">{value === null || value === undefined ? '—' : format(value)}</b>
              </span>
            );
          })}
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
  series: readonly { name: string; values: readonly (number | null)[] }[];
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
            {series.map((one) => {
              const value = one.values[i];
              return (
                <td key={one.name}>
                  {value === null || value === undefined ? '—' : format(value)}
                </td>
              );
            })}
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
