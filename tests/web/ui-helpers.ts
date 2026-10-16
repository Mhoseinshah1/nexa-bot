import { fireEvent, screen, within } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';
import { parseIsoDay, toJalali } from '../../apps/web/src/ui/jalali';

/**
 * Test drivers for the W1 shared components. Pages' tests use ONLY these to operate a
 * `DateField` or open a `ListFilterBar` panel, so the components can change their markup
 * without every page test changing with them. Agent A owns this file and keeps every driver
 * working against the real component.
 */

function popoverOf(trigger: HTMLElement): HTMLElement {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const id = trigger.getAttribute('aria-controls');
  const pop = id === null ? null : document.getElementById(id);
  if (pop === null) throw new Error('setDateField: the calendar did not open');
  return pop;
}

function pickDay(pop: HTMLElement, iso: string): void {
  const g = parseIsoDay(iso);
  if (g === null) throw new Error(`setDateField: ${iso} is not a day`);
  const j = toJalali(g);
  // The month grid, then the year arrows, then the month, then the day.
  const title = within(pop).getByRole('button', { name: t('web.date_choose_month') });
  if (title.getAttribute('aria-expanded') !== 'true') fireEvent.click(title);
  for (let guard = 0; guard < 400; guard += 1) {
    const year = Number(pop.getAttribute('data-view-year'));
    if (year === j.jy) break;
    const arrow = pop.querySelector<HTMLElement>(`[data-nav="${year < j.jy ? 'next' : 'prev'}"]`);
    if (arrow === null) throw new Error('setDateField: no year arrow');
    fireEvent.click(arrow);
  }
  const month = pop.querySelector<HTMLElement>(`[data-month="${j.jm}"]`);
  if (month === null) throw new Error('setDateField: no month button');
  fireEvent.click(month);
  const day = pop.querySelector<HTMLElement>(`[data-day="${j.jd}"]`);
  if (day === null) throw new Error('setDateField: no day button');
  if (day.getAttribute('aria-disabled') === 'true') {
    throw new Error(`setDateField: ${iso} is outside the field's min/max`);
  }
  fireEvent.click(day);
}

function setTime(pop: HTMLElement, hhmm: string): void {
  const [h = '', m = ''] = hhmm.split(':');
  fireEvent.change(within(pop).getByLabelText(t('web.date_hour')), { target: { value: h } });
  fireEvent.change(within(pop).getByLabelText(t('web.date_minute')), { target: { value: m } });
  const ok = within(pop).getByRole('button', { name: t('web.date_confirm') });
  if ((ok as HTMLButtonElement).disabled) {
    throw new Error(`setDateField: ${hhmm} cannot be confirmed (outside min/max?)`);
  }
  fireEvent.click(ok);
}

/**
 * Sets a `DateField` (found by its trigger — `getByLabelText` returns it) to a wire value:
 * `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`, `HH:MM`, or `''` to clear it. It operates the real
 * calendar (month grid, year arrows, day, time, «تأیید»), so it reaches any date and fails
 * loudly on one the field's `min`/`max` refuses. A plain input (a page not yet moved to the
 * field) is still set by a change event.
 */
export function setDateField(field: HTMLElement, value: string): void {
  const trigger = field.hasAttribute('data-date-field')
    ? field
    : field.querySelector<HTMLElement>('[data-date-field]');
  if (trigger === null) {
    fireEvent.change(field, { target: { value } });
    return;
  }
  const mode = trigger.getAttribute('data-date-field');
  if (value === '') {
    const clear = trigger.parentElement?.querySelector<HTMLElement>('.date-field-clear');
    // No × means the field is already empty or disabled: clearing it would prove nothing.
    if (clear === null || clear === undefined) {
      throw new Error('setDateField: there is nothing to clear (empty or disabled field)');
    }
    fireEvent.click(clear);
    return;
  }
  const pop = popoverOf(trigger);
  if (mode === 'time') {
    setTime(pop, value);
    return;
  }
  if (mode === 'datetime') {
    const [day = '', time = ''] = value.split('T');
    pickDay(pop, day);
    setTime(pop, time.slice(0, 5));
    return;
  }
  pickDay(pop, value);
}

/** «فیلترها», with or without its count — never «فیلترهای ذخیره‌شده». */
export const FILTERS_TOGGLE = new RegExp(`^\\s*${t('web.filters')}(?!\\p{L})`, 'u');

/** Opens the «فیلترها» panel of the (only, or given) filter bar and returns the panel. */
export function openFilterPanel(container: HTMLElement = document.body): HTMLElement {
  const scope = within(container);
  const toggle = scope.getAllByRole('button', { name: FILTERS_TOGGLE })[0];
  if (toggle === undefined) throw new Error('no filter bar');
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return screen.getByRole('dialog', { name: t('web.filters') });
}

/**
 * Adds a condition to the audience builder by its label (from the catalogue) through
 * «+ افزودن شرط», and returns the condition's open editor.
 */
export function addAudienceCondition(label: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: t('web.aq_add') }));
  const menu = screen.getByRole('group', { name: t('web.aq_add') });
  fireEvent.click(within(menu).getByRole('button', { name: label }));
  return audienceConditionEditor(label);
}

/** Opens (if closed) and returns the editor of a condition already in the list. */
export function audienceConditionEditor(label: string): HTMLElement {
  const close = screen.queryByRole('button', { name: `${t('web.aq_close')} ${label}` });
  if (close === null) {
    fireEvent.click(screen.getByRole('button', { name: `${t('web.aq_change')} ${label}` }));
  }
  const row = screen
    .getByRole('button', { name: `${t('web.aq_close')} ${label}` })
    .closest('.aq-row');
  const editor = row?.querySelector<HTMLElement>('.aq-ed');
  if (editor === null || editor === undefined) throw new Error(`no editor for ${label}`);
  return editor;
}
