import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ReportBucket } from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import { formatNumber } from '../format';
import { seriesValues } from '../report-view';
import { axisLabel } from '../dashboard-view';
import { axisLabelSlots, niceCeiling, tightCeiling } from './charts';

/**
 * The one business trend chart: the current period and the previous equivalent period
 * on the same axes (spec §7, §23).
 *
 * Drawn as inline SVG rather than with a chart library — the admin has three runtime
 * dependencies and one line chart does not justify a fourth. Colours and strokes come
 * from classes: the production policy is `style-src 'self'`, which blocks a `style`
 * attribute, so nothing here writes one. For the same reason the hover readout is a
 * fixed line under the chart rather than a tooltip positioned at the cursor. As the demo
 * draws it: a value axis with grid lines, the dates underneath, and the current period's
 * area filled down to the axis.
 *
 * Bucket `i` of one series is compared with bucket `i` of the other (the audit's §3
 * alignment rule), and each series keeps its OWN labels, so the readout names both
 * periods. A bucket that has not begun is a gap in the line, never a drop to zero.
 */
const FALLBACK_WIDTH = 640;
const HEIGHT = 240;
/** Room for the value axis on the left and the date axis underneath (demo parity). */
const PAD_L = 72;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 28;
/** The value axis: five lines, zero to a "nice" ceiling, as the demo's trend draws them. */
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

export interface TrendChartProps {
  readonly current: readonly ReportBucket[];
  readonly previous: readonly ReportBucket[];
  /** Renders one exact value, money or count, for the readout. */
  readonly format: (value: string) => ReactNode;
  readonly caption: string;
  /**
   * A value-axis tick as text — a coordinate, not a figure (readouts keep the exact value).
   * Grouped digits by default; the business report passes the compact form (`21M`).
   */
  readonly axisFormat?: (value: number) => string;
  /** A ceiling just above the peak (`tightCeiling`), as the demo draws it. */
  readonly tight?: boolean;
}

/**
 * The rendered width of the chart's box, so the geometry is drawn at the size it is shown and
 * the axis text keeps its true size on a phone and on a wide card alike.
 */
function useBoxWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const next = Math.round(box.getBoundingClientRect().width);
      if (next > 0) setWidth((now) => (Math.abs(now - next) > 2 ? next : now));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

export function TrendChart({
  current,
  previous,
  format,
  caption,
  axisFormat = (value) => formatNumber(Math.round(value)),
  tight = false,
}: TrendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const box = useBoxWidth(FALLBACK_WIDTH);
  const WIDTH = box.width;
  const slots = Math.max(current.length, previous.length);
  const a = seriesValues(current);
  const b = seriesValues(previous);
  const max = (tight ? tightCeiling : niceCeiling)(
    Math.max(0, ...a.filter(isNumber), ...b.filter(isNumber)),
  );
  const plot = WIDTH - PAD_L - PAD_R;
  const x = (i: number) => PAD_L + (slots <= 1 ? 0 : (i * plot) / (slots - 1));
  const y = (v: number) => HEIGHT - PAD_B - (v / max) * (HEIGHT - PAD_T - PAD_B);
  const slotWidth = slots <= 1 ? plot : plot / (slots - 1);
  // The date axis: the current period's own labels, the year dropped, at most one per ~90px.
  const labelled = axisLabelSlots(slots, Math.max(3, Math.round(WIDTH / 90)));

  const shown = active === null ? null : { now: current[active], before: previous[active] };

  return (
    <figure className="trend">
      <div ref={box.ref} className="trend-box">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="chart trend-svg"
          role="img"
          aria-label={caption}
        >
          {TICKS.map((tick) => (
            <g key={tick}>
              <line
                className={tick === 0 ? 'trend-axis' : 'grid-line'}
                x1={PAD_L}
                x2={WIDTH - PAD_R}
                y1={y(max * tick)}
                y2={y(max * tick)}
              />
              <text x={PAD_L - 8} y={y(max * tick) + 3.5} textAnchor="end">
                {axisFormat(max * tick)}
              </text>
            </g>
          ))}
          {Array.from({ length: slots }, (_, i) =>
            labelled.has(i) ? (
              <text key={`x-${i}`} x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                {axisLabel(current[i]?.label ?? previous[i]?.label ?? '')}
              </text>
            ) : null,
          )}
          {segments(b).map((segment) => (
            <polyline
              key={`p-${segment[0]}`}
              className="trend-line previous"
              points={segment.map((i) => `${x(i)},${y(b[i] as number)}`).join(' ')}
            />
          ))}
          {segments(a).map((segment) => {
            const first = segment[0] as number;
            const last = segment[segment.length - 1] as number;
            const points = segment.map((i) => `${x(i)},${y(a[i] as number)}`).join(' ');
            return (
              <g key={`c-${first}`}>
                {/* The filled area under the current period, down to the axis (demo). */}
                <polygon
                  className="trend-area"
                  points={`${points} ${x(last)},${y(0)} ${x(first)},${y(0)}`}
                />
                <polyline className="trend-line current" points={points} />
              </g>
            );
          })}
          {active !== null && (
            <line
              className="trend-cursor"
              x1={x(active)}
              x2={x(active)}
              y1={PAD_T}
              y2={HEIGHT - PAD_B}
            />
          )}
          {Array.from({ length: slots }, (_, i) => (
            <rect
              key={i}
              data-testid={`trend-slot-${i}`}
              className="trend-hit"
              x={Math.max(PAD_L - slotWidth / 2, x(i) - slotWidth / 2)}
              y={PAD_T}
              width={slotWidth}
              height={HEIGHT - PAD_T - PAD_B}
              tabIndex={0}
              aria-label={current[i]?.label ?? previous[i]?.label ?? String(i + 1)}
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
      </div>
      {/* The two periods are named by the card's own legend, above the chart, as the demo
          draws it; the line under the chart is the readout alone. */}
      <div className="trend-readout" role="status" aria-live="polite">
        {shown === null ? (
          <span className="faint small">{t('web.report_chart_hover_hint')}</span>
        ) : (
          <>
            <span>
              <strong>{t('web.report_chart_current')}</strong> {shown.now?.label ?? '—'}:{' '}
              {shown.now?.value == null ? '—' : format(shown.now.value)}
            </span>
            <span>
              <strong>{t('web.report_chart_previous')}</strong> {shown.before?.label ?? '—'}:{' '}
              {shown.before?.value == null ? '—' : format(shown.before.value)}
            </span>
          </>
        )}
      </div>
    </figure>
  );
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

/** Runs of consecutive known values, so a future bucket breaks the line instead of zeroing it. */
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
  // A single point draws nothing as a polyline; doubling it draws a dot-length stroke.
  return out.map((segment) =>
    segment.length === 1 ? [segment[0] as number, segment[0] as number] : segment,
  );
}
