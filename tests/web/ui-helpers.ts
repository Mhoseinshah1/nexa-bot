import { fireEvent, screen, within } from '@testing-library/react';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * Test drivers for the W1 shared components. Pages' tests use ONLY these to operate a
 * `DateField` or open a `ListFilterBar` panel, so the components can change their markup
 * without every page test changing with them. Agent A owns this file and keeps every driver
 * working against the real component.
 */

/** Sets a `DateField` (found by its trigger element) to a wire value (`YYYY-MM-DD`, …, or ''). */
export function setDateField(field: HTMLElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

/** Opens the «فیلترها» panel of the (only, or given) filter bar and returns the panel. */
export function openFilterPanel(container: HTMLElement = document.body): HTMLElement {
  const scope = within(container);
  const toggle = scope.getAllByRole('button', { name: new RegExp(t('web.filters')) })[0];
  if (toggle === undefined) throw new Error('no filter bar');
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return screen.getByRole('dialog', { name: t('web.filters') });
}
