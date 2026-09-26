import { useState, type ReactNode } from 'react';
import type { ReportBucket } from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import { seriesValues } from '../report-view';

/**
 * The one business trend chart: the current period and the previous equivalent period
 * on the same axes (spec §7, §23).
 *
 * Drawn as inline SVG rather than with a chart library — the admin has three runtime
 * dependencies and one line chart does not justify a fourth. Colours and strokes come
 * from classes: the production policy is `style-src 'self'`, which blocks a `style`
 * attribute, so nothing here writes one. For the same reason the hover readout is a
 * fixed line under the chart rather than a tooltip positioned at the cursor.
 *
 * Bucket `i` of one series is compared with bucket `i` of the other (the audit's §3
 * alignment rule), and each series keeps its OWN labels, so the readout names both
 * periods. A bucket that has not begun is a gap in the line, never a drop to zero.
 */
const WIDTH = 640;
const HEIGHT = 220;
const PAD_X = 12;
const PAD_Y = 16;

export interface TrendChartProps {
  readonly current: readonly ReportBucket[];
  readonly previous: readonly ReportBucket[];
  /** Renders one exact value, money or count, for the readout. */
  readonly format: (value: string) => ReactNode;
  readonly caption: string;
}

export function TrendChart({ current, previous, format, caption }: TrendChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const slots = Math.max(current.length, previous.length);
  const a = seriesValues(current);
  const b = seriesValues(previous);
  const max = Math.max(1, ...a.filter(isNumber), ...b.filter(isNumber));
  const x = (i: number) => PAD_X + (slots <= 1 ? 0 : (i * (WIDTH - 2 * PAD_X)) / (slots - 1));
  const y = (v: number) => HEIGHT - PAD_Y - (v / max) * (HEIGHT - 2 * PAD_Y);
  const slotWidth = slots <= 1 ? WIDTH : (WIDTH - 2 * PAD_X) / (slots - 1);

  const shown = active === null ? null : { now: current[active], before: previous[active] };

  return (
    <figure className="trend">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="trend-svg"
        role="img"
        aria-label={caption}
        preserveAspectRatio="none"
      >
        <line
          className="trend-axis"
          x1={PAD_X}
          x2={WIDTH - PAD_X}
          y1={HEIGHT - PAD_Y}
          y2={HEIGHT - PAD_Y}
        />
        {segments(b).map((segment) => (
          <polyline
            key={`p-${segment[0]}`}
            className="trend-line previous"
            points={segment.map((i) => `${x(i)},${y(b[i] as number)}`).join(' ')}
          />
        ))}
        {segments(a).map((segment) => (
          <polyline
            key={`c-${segment[0]}`}
            className="trend-line current"
            points={segment.map((i) => `${x(i)},${y(a[i] as number)}`).join(' ')}
          />
        ))}
        {active !== null && (
          <line
            className="trend-cursor"
            x1={x(active)}
            x2={x(active)}
            y1={PAD_Y}
            y2={HEIGHT - PAD_Y}
          />
        )}
        {Array.from({ length: slots }, (_, i) => (
          <rect
            key={i}
            data-testid={`trend-slot-${i}`}
            className="trend-hit"
            x={Math.max(0, x(i) - slotWidth / 2)}
            y={0}
            width={slotWidth}
            height={HEIGHT}
            tabIndex={0}
            aria-label={current[i]?.label ?? previous[i]?.label ?? String(i + 1)}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onMouseLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
      <figcaption className="trend-legend">
        <span className="trend-key current">{t('web.report_chart_current')}</span>
        <span className="trend-key previous">{t('web.report_chart_previous')}</span>
      </figcaption>
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
