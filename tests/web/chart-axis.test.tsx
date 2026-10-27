import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BarChart, LineChart } from '../../apps/web/src/ui/kit';
import { compactAxis, tightCeiling } from '../../apps/web/src/ui/charts';

/**
 * R11 A1 (report items 8, 9): the demo's value axes are compact (`21M`) and sit just above the
 * peak (a stacked bar of 69 draws 18 / 36 / 54 / 72), where the app drew `20,000,000` and a
 * round 100 that left a third of the plot empty. The axis is a coordinate: the readout and the
 * hidden table keep the exact value.
 */
describe('chart axes', () => {
  it('writes ticks compactly, in Latin digits', () => {
    expect(compactAxis(0)).toBe('0');
    expect(compactAxis(72)).toBe('72');
    expect(compactAxis(5_300_000)).toBe('5.3M');
    expect(compactAxis(21_000_000)).toBe('21M');
    expect(compactAxis(16_000_000)).toBe('16M');
    expect(compactAxis(85_000)).toBe('85K');
    expect(compactAxis(2_500_000_000)).toBe('2.5B');
    expect(compactAxis(1_250)).toBe('1,250');
  });

  it('puts the ceiling just above the peak, never below it', () => {
    expect(tightCeiling(69)).toBe(72);
    expect(tightCeiling(0)).toBe(1);
    for (const peak of [1, 7, 69, 100, 12_345, 20_400_000]) {
      expect(tightCeiling(peak)).toBeGreaterThanOrEqual(peak);
      expect(tightCeiling(peak)).toBeLessThanOrEqual(Math.ceil(peak * 1.04));
    }
  });

  it('draws a tight stacked bar axis: 69 at the peak reads 18, 36, 54, 72', () => {
    const { container } = render(
      <BarChart
        stacked
        tight
        ticks={[0, 0.25, 0.5, 0.75, 1]}
        labels={['a', 'b']}
        caption="c"
        series={[
          { name: 'x', values: [40, 10] },
          { name: 'y', values: [29, 5] },
        ]}
      />,
    );
    const axis = [...container.querySelectorAll('svg.chart > g > g > text')].map(
      (node) => node.textContent,
    );
    expect(axis).toEqual(['0', '18', '36', '54', '72']);
  });

  it('keeps the round ceiling when tight is not asked for', () => {
    const { container } = render(
      <BarChart
        stacked
        ticks={[0, 0.5, 1]}
        labels={['a']}
        caption="c"
        series={[{ name: 'x', values: [69] }]}
      />,
    );
    const axis = [...container.querySelectorAll('svg.chart > g > g > text')].map(
      (node) => node.textContent,
    );
    expect(axis).toEqual(['0', '50', '100']);
  });

  it('abbreviates only the axis of a line chart; the hidden table keeps the exact figure', () => {
    const { container } = render(
      <LineChart
        tight
        axisFormat={compactAxis}
        labels={['1', '2']}
        caption="c"
        series={[{ name: 's', values: [10_000_000, 20_400_000] }]}
      />,
    );
    const axis = [...container.querySelectorAll('svg.chart > g > g > text')].map(
      (node) => node.textContent,
    );
    expect(axis).toEqual(['0', '5.3M', '10.6M', '15.9M', '21.2M']);
    expect(container.textContent).toContain('20,400,000');
  });
});
