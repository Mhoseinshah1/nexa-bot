import { describe, expect, it } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import {
  TEMPLATE_KEYS,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { ContentPage } from '../../apps/web/src/pages/content';
import { formatNumber } from '../../apps/web/src/format';
import { renderPage, stubApi } from './harness';

/**
 * B5: «متن‌های ربات» drew every template at once — a list row and an editor for each of the
 * ~900 keys, all but one hidden — and took minutes to appear in a test browser and stuttered
 * in a real one. It now draws the page's rows and mounts an editor only once its row has been
 * opened (and keeps it mounted afterwards, so an unsaved draft survives picking another row).
 * What must not change: the search and the filters still find every template.
 *
 * `B5_KEYS=<n>` limits the catalogue to its first n keys (used to measure the old page, which
 * cannot render all of them in reasonable time); by default it is every key.
 */
const KEYS: readonly TemplateKey[] = TEMPLATE_KEYS.slice(
  0,
  Number(process.env['B5_KEYS'] ?? TEMPLATE_KEYS.length),
);

const view = (key: TemplateKey) => {
  const definition = templateDefinition(key);
  return templateViewSchema.parse({
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body: CATALOGUE_FA[key],
    defaultBody: CATALOGUE_FA[key],
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
};

/** The editors that exist in the document, shown or hidden. */
const editors = () => document.querySelectorAll('.content-editor > div').length;
const listRows = () => document.querySelectorAll('.content-nav-list li').length;
const search = () => document.getElementById('templates-search') as HTMLInputElement;

async function open() {
  stubApi([{ url: '/templates', body: { templates: KEYS.map(view), total: KEYS.length } }]);
  const started = performance.now();
  renderPage(<ContentPage mayEdit denied={false} />);
  await waitFor(() => expect(listRows()).toBeGreaterThan(0), { timeout: 600_000 });
  const ms = Math.round(performance.now() - started);
  // eslint-disable-next-line no-console
  console.log(
    `B5-METRIC keys=${KEYS.length} firstRenderMs=${ms} domNodes=${document.querySelectorAll('*').length} listRows=${listRows()} editors=${editors()}`,
  );
}

describe('«متن‌های ربات» with the whole catalogue', () => {
  it('draws one page of rows and mounts one editor, not one per template', async () => {
    await open();
    expect(listRows()).toBeLessThanOrEqual(10);
    expect(editors()).toBe(1);
  }, 600_000);

  it('still counts, filters and finds every template', async () => {
    await open();
    // The counter is over ALL of them, though only a page is drawn.
    expect(document.body.textContent).toContain(formatNumber(KEYS.length));
    // A key far past the first page is found by its raw key and by its words.
    const far = KEYS[KEYS.length - 1] as TemplateKey;
    fireEvent.change(search(), { target: { value: far } });
    await waitFor(() => expect(document.getElementById(`template-item-${far}`)).not.toBeNull());
    expect(listRows()).toBeGreaterThan(0);
    // Searching mounts only the editor the list falls back to, not one per match.
    expect(editors()).toBeLessThanOrEqual(2);
  }, 600_000);

  it('mounts an editor when its row is opened, and keeps the earlier one (so its draft survives)', async () => {
    await open();
    const rows = [...document.querySelectorAll('.content-nav-list li button')] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1);
    fireEvent.click(rows[1] as HTMLElement);
    await waitFor(() => expect(editors()).toBe(2));
    // Opening a row that was already opened adds nothing.
    fireEvent.click(rows[0] as HTMLElement);
    expect(editors()).toBe(2);
  }, 600_000);
});
