import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { ReportBucket } from '@nexa/contracts';
import { BarChart, Donut, LineChart, Sparkline } from '../../apps/web/src/ui/kit';
import { AreaSpark } from '../../apps/web/src/ui/charts';
import { TrendChart } from '../../apps/web/src/ui/trend-chart';
import { ShareBar } from '../../apps/web/src/pages/dashboard-parts';

/**
 * v0.9.7 added draw-in CSS, but nothing animated: the CSS named `.chart path.line` and
 * `.spark path.area`, while the KPI sparks are `.area-spark`, the business trend draws
 * `polyline.trend-line`, and the dashboard's stacked bar had no rule. Each chart the owner
 * sees must carry a class the draw-in block targets, and the block must keep every selector
 * inside `prefers-reduced-motion: no-preference`.
 */
const css = readFileSync('apps/web/src/styles/kit.css', 'utf8');
const start = css.indexOf('@media (prefers-reduced-motion: no-preference) {\n  .chart path.line');
const block = css.slice(start, css.indexOf('\n}\n', start));

const bucket = (i: number, value: string | null): ReportBucket => ({
  index: i,
  start: `2026-10-0${i + 1}T00:00:00.000Z`,
  end: `2026-10-0${i + 2}T00:00:00.000Z`,
  label: `d${i}`,
  value,
});
const current = [bucket(0, '10'), bucket(1, '30'), bucket(2, '20')];
const previous = [bucket(0, '5'), bucket(1, '15'), bucket(2, '25')];

describe('chart draw-in', () => {
  it('keeps the draw-in rules inside the no-preference media query', () => {
    expect(start).toBeGreaterThan(0);
    for (const selector of [
      '.chart path.line:not(.dashed)',
      '.area-spark path.line',
      '.trend-line.current',
      '.trend-area',
      '.chart rect.bar',
      '.chart .donut-seg',
      '.dash-stack rect',
    ]) {
      expect(block).toContain(selector);
    }
    // Outside the block the animations are never declared.
    expect(css.slice(0, start)).not.toMatch(/animation:\s*chart-/u);
    expect(css).not.toMatch(/prefers-color-scheme/u);
  });

  it('draws the dashboard KPI area spark with the classes the CSS targets', () => {
    const { container } = render(<AreaSpark values={[1, 4, 2, 6]} label="x" />);
    expect(container.querySelector('svg.area-spark path.area')).not.toBeNull();
    expect(container.querySelector('svg.area-spark path.line')).not.toBeNull();
    expect(container.querySelector('svg.area-spark path.last')).not.toBeNull();
  });

  it('draws the small spark, line and area chart with path.line / path.area under .spark / .chart', () => {
    const spark = render(<Sparkline values={[1, 4, 2, 6]} label="x" />).container;
    expect(spark.querySelector('svg.spark path.area')).not.toBeNull();
    expect(spark.querySelector('svg.spark path.line')).not.toBeNull();
    const line = render(
      <LineChart
        labels={['a', 'b', 'c']}
        series={[
          { name: 's', values: [1, 4, 2] },
          { name: 'p', values: [2, 2, 3], dashed: true },
        ]}
        caption="c"
      />,
    ).container;
    expect(line.querySelector('svg.chart path.area')).not.toBeNull();
    expect(line.querySelector('svg.chart path.line:not(.dashed)')).not.toBeNull();
    expect(line.querySelector('svg.chart path.line.dashed')).not.toBeNull();
  });

  it('draws the business trend lines and area with the trend classes', () => {
    const { container } = render(
      <TrendChart current={current} previous={previous} format={(v) => v} caption="c" />,
    );
    expect(container.querySelector('svg.chart .trend-line.current')).not.toBeNull();
    expect(container.querySelector('svg.chart .trend-line.previous')).not.toBeNull();
    expect(container.querySelector('svg.chart .trend-area')).not.toBeNull();
  });

  it('draws bars, donut segments and the dashboard stack with targeted classes', () => {
    const bars = render(
      <BarChart labels={['a', 'b']} series={[{ name: 's', values: [3, 5] }]} caption="c" />,
    ).container;
    expect(bars.querySelector('svg.chart rect.bar')).not.toBeNull();
    const donut = render(
      <Donut
        slices={[
          { key: 'a', label: 'a', value: 2 },
          { key: 'b', label: 'b', value: 3 },
        ]}
        caption="c"
      />,
    ).container;
    expect(donut.querySelectorAll('svg.chart .donut-seg')).toHaveLength(2);
    const stack = render(
      <ShareBar
        slices={[
          { key: 'a', label: 'a', count: 2, tone: 'ok' },
          { key: 'b', label: 'b', count: 1, tone: 'warn' },
        ]}
      />,
    ).container;
    expect(stack.querySelectorAll('svg.dash-stack rect')).toHaveLength(2);
  });
});
