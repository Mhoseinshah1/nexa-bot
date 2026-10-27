import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  USAGE_CHART_RANGES_DAYS,
  miniAppUsageHistorySchema,
  type MiniAppUsageHistory,
  type UsageChartRangeDays,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { dateTime, traffic } from '../format.js';
import { Button, Card, errorText, useLoad } from '../ui.js';

/**
 * R11 B2: the used volume of one service over the last 7 or 30 days, drawn from the
 * snapshots the server stored beside the usage reads it already makes. Only the used volume:
 * there is no connected-device count anywhere in the data. The line is drawn left to right in
 * time (the figures themselves are numbers, not prose, so the axis stays one way in the RTL
 * page), the vertical scale is the largest stored figure, and an empty range says so instead
 * of drawing a line through nothing.
 */

const WIDTH = 320;
const HEIGHT = 140;
const PAD_X = 8;
const PAD_Y = 10;

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * The points' coordinates inside the plot. Times map linearly onto `[from, to]`; a figure maps
 * onto `[0, max]` with the share computed in bigint thousandths, never a float of a byte count.
 */
export function plot(history: MiniAppUsageHistory): { points: ChartPoint[]; max: bigint } {
  const from = new Date(history.from).getTime();
  const span = Math.max(1, new Date(history.to).getTime() - from);
  const figures = history.points.map((point) => BigInt(point.usedBytes));
  const max = figures.reduce((most, value) => (value > most ? value : most), 0n);
  const inner = { width: WIDTH - 2 * PAD_X, height: HEIGHT - 2 * PAD_Y };
  const points = history.points.map((point, index) => {
    const at = (new Date(point.at).getTime() - from) / span;
    const share = max === 0n ? 0 : Number(((figures[index] as bigint) * 1000n) / max) / 1000;
    return {
      x: PAD_X + Math.min(1, Math.max(0, at)) * inner.width,
      y: PAD_Y + (1 - share) * inner.height,
    };
  });
  return { points, max };
}

export function UsageChart({ serviceId }: { serviceId: string }) {
  const { api } = useApp();
  const [days, setDays] = useState<UsageChartRangeDays>(7);
  const { loaded, reload } = useLoad(
    () =>
      api.get(
        MINIAPP_ROUTES.serviceUsage,
        { serviceId },
        miniAppUsageHistorySchema,
        `days=${String(days)}`,
      ),
    [api, serviceId, days],
  );
  return (
    <Card>
      <h2>{t('miniapp.usage_title')}</h2>
      <div className="chips" role="group" aria-label={t('miniapp.usage_title')}>
        {USAGE_CHART_RANGES_DAYS.map((range) => (
          <button
            key={range}
            type="button"
            className={range === days ? 'chip chip-on' : 'chip'}
            aria-pressed={range === days}
            onClick={() => setDays(range)}
          >
            {t(range === 7 ? 'miniapp.usage_range_7' : 'miniapp.usage_range_30')}
          </button>
        ))}
      </div>
      {loaded.state === 'loading' && <p className="muted">{t('miniapp.loading')}</p>}
      {loaded.state === 'failed' && (
        <>
          <p className="error">{errorText(loaded.error)}</p>
          <Button onClick={reload}>{t('miniapp.retry')}</Button>
        </>
      )}
      {loaded.state === 'ready' && <Chart history={loaded.data} />}
    </Card>
  );
}

function Chart({ history }: { history: MiniAppUsageHistory }) {
  if (history.points.length === 0) return <p className="muted">{t('miniapp.usage_empty')}</p>;
  const { points, max } = plot(history);
  const last = history.points[history.points.length - 1] as MiniAppUsageHistory['points'][number];
  const line = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
  const floor = HEIGHT - PAD_Y;
  const first = points[0] as ChartPoint;
  const end = points[points.length - 1] as ChartPoint;
  const area = `${first.x.toFixed(1)},${String(floor)} ${line} ${end.x.toFixed(1)},${String(floor)}`;
  const label = t('miniapp.usage_chart_label', {
    days: history.days,
    last: traffic(last.usedBytes),
    at: dateTime(last.at),
  });
  return (
    <div className="usage-chart">
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={label}
        data-testid="usage-chart"
        style={{ direction: 'ltr' }}
      >
        <line className="usage-chart-axis" x1={PAD_X} x2={WIDTH - PAD_X} y1={floor} y2={floor} />
        {points.length > 1 && <polygon className="usage-chart-area" points={area} />}
        {points.length > 1 && <polyline className="usage-chart-line" points={line} />}
        {points.map((point, index) => (
          <circle
            key={history.points[index]?.at}
            className="usage-chart-dot"
            cx={point.x}
            cy={point.y}
            r={points.length > 40 ? 0 : 2.5}
          />
        ))}
      </svg>
      <p className="muted">{t('miniapp.usage_max', { max: traffic(max) })}</p>
      <p className="muted">
        {t('miniapp.usage_last', { last: traffic(last.usedBytes), at: dateTime(last.at) })}
      </p>
    </div>
  );
}
