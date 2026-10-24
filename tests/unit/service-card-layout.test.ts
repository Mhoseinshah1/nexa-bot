import { describe, expect, it } from 'vitest';
import { applyServiceCardLayout } from '../../apps/api/src/surfaces/telegram/service-card-layout';

/** R8-C3: the pure arrangement of the buttons the screen has already decided to draw. */
const b = (inline: string, row: number) => ({ inline, row });
const BUTTONS = [
  b('service.refresh', 0),
  b('service.link', 1),
  b('service.note', 2),
  b('service.renew', 3),
  b('service.resume', 3),
  b('service.back_to_list', 5),
];
const layout = (rows: [string, boolean?][][]) => ({
  rows: rows.map((row) => row.map(([button, enabled]) => ({ button, enabled: enabled ?? true }))),
});
const grouped = (buttons: readonly { inline: string; row: number }[]) => {
  const rows = new Map<number, string[]>();
  for (const one of buttons) rows.set(one.row, [...(rows.get(one.row) ?? []), one.inline]);
  return [...rows.values()];
};

describe('applyServiceCardLayout (R8-C3)', () => {
  it('returns the very same buttons when nothing is saved or the value is unreadable', () => {
    expect(applyServiceCardLayout(BUTTONS, null)).toBe(BUTTONS);
    expect(applyServiceCardLayout(BUTTONS, { rows: [] })).toBe(BUTTONS);
    expect(applyServiceCardLayout(BUTTONS, { rows: 'x' })).toBe(BUTTONS);
  });

  it('orders and groups by the layout, keeps unnamed buttons after it, and ends with back', () => {
    const out = applyServiceCardLayout(
      BUTTONS,
      layout([[['service.note'], ['service.refresh']], [['service.suspend']]]),
    );
    expect(grouped(out)).toEqual([
      ['service.note', 'service.refresh'],
      ['service.resume'],
      ['service.link'],
      ['service.renew'],
      ['service.back_to_list'],
    ]);
  });

  it('hides a disabled slot, and the suspend slot governs resume too', () => {
    const out = applyServiceCardLayout(
      BUTTONS,
      layout([[['service.note', false], ['service.suspend', false], ['service.refresh']]]),
    );
    const names = out.map((one) => one.inline);
    expect(names).not.toContain('service.note');
    expect(names).not.toContain('service.resume');
    expect(names).toContain('service.refresh');
  });

  it('draws nothing for a slot with no built button, and always ends with back', () => {
    const out = applyServiceCardLayout(
      [b('service.back_to_list', 0), b('service.note', 1)],
      layout([[['service.transfer'], ['service.note']]]),
    );
    expect(out.map((one) => one.inline)).toEqual(['service.note', 'service.back_to_list']);
  });
});
