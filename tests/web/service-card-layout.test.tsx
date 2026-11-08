import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { moveItem } from '../../apps/web/src/ui/layout-dnd';
import {
  DEFAULT_SERVICE_CARD_ROWS,
  INLINE_BUTTONS,
  SERVICE_CARD_BUTTONS,
  SERVICE_CARD_ROW_MAX,
  serviceCardLayoutSchema,
  templateDefinition,
  templateViewSchema,
  type TemplateKey,
} from '@nexa/contracts';
import { ServiceCardLayoutSection } from '../../apps/web/src/pages/bot-buttons/service-card-layout';
import { INLINE_BUTTON_NAME } from '../../apps/web/src/pages/bot-buttons/inline-buttons';
import {
  defaultServiceCardRows,
  effectiveServiceCardRows,
  fromDndLayout,
  setServiceCardEnabled,
  storedServiceCardRows,
  toDndLayout,
} from '../../apps/web/src/pages/bot-buttons/service-card-model';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, setting, stubApi } from './harness';

/**
 * R8-C3: «چیدمان صفحهٔ سرویس». The model keeps the editor from producing a value the
 * schema refuses; the section saves it as one versioned settings write.
 */

const KEY = 'bot.service_card_layout';
const order = (rows: readonly (readonly { button: string }[])[]) =>
  rows.map((row) => row.map((entry) => entry.button));

describe('the service layout model', () => {
  it('shows the default arrangement when nothing is saved, and it is a valid layout', () => {
    expect(order(effectiveServiceCardRows([]))).toEqual(
      DEFAULT_SERVICE_CARD_ROWS.map((row) => [...row]),
    );
    expect(serviceCardLayoutSchema.safeParse({ rows: defaultServiceCardRows() }).success).toBe(
      true,
    );
    // The default arrangement is stored as «as always», never as a copy that could go stale.
    expect(storedServiceCardRows(defaultServiceCardRows())).toEqual([]);
  });

  it('appends the buttons a saved layout does not name, in their usual grouping', () => {
    const rows = effectiveServiceCardRows([[{ button: 'service.note', enabled: true }]]);
    expect(rows.flat().length).toBe(SERVICE_CARD_BUTTONS.length);
    expect(order(rows)[0]).toEqual(['service.note']);
  });

  it('hides and shows a button', () => {
    const hidden = setServiceCardEnabled(defaultServiceCardRows(), 'service.link', false);
    expect(hidden.flat().find((entry) => entry.button === 'service.link')?.enabled).toBe(false);
  });

  it('holds hidden buttons in the free box and stores them in trailing rows, never past three', () => {
    const hidden = setServiceCardEnabled(
      setServiceCardEnabled(defaultServiceCardRows(), 'service.link', false),
      'service.note',
      false,
    );
    const dnd = toDndLayout(hidden);
    expect(dnd.free).toEqual(['service.link', 'service.note']);
    expect(dnd.rows.flat()).not.toContain('service.link');
    // Round trip: every button named once, hidden ones disabled, rows valid.
    const stored = fromDndLayout(dnd);
    expect(stored.flat().length).toBe(SERVICE_CARD_BUTTONS.length);
    expect(
      stored
        .flat()
        .filter((entry) => !entry.enabled)
        .map((entry) => entry.button),
    ).toEqual(['service.link', 'service.note']);
    for (const row of stored) {
      expect(row.length).toBeGreaterThanOrEqual(1);
      expect(row.length).toBeLessThanOrEqual(SERVICE_CARD_ROW_MAX);
    }
    expect(serviceCardLayoutSchema.safeParse({ rows: stored }).success).toBe(true);
  });

  it('refuses a drop on a full row, and a new row keeps every row valid', () => {
    const dnd = toDndLayout(defaultServiceCardRows());
    const rules = { maxPerRow: SERVICE_CARD_ROW_MAX };
    const full = dnd.rows.findIndex((row) => row.length === SERVICE_CARD_ROW_MAX);
    expect(full).toBeGreaterThanOrEqual(0);
    expect(moveItem(dnd, 'service.files', { kind: 'row-end', row: full }, rules)).toBeNull();
    const alone = moveItem(dnd, 'service.files', { kind: 'new-row' }, rules);
    expect(alone).not.toBeNull();
    expect(alone?.rows.at(-1)).toEqual(['service.files']);
    expect(serviceCardLayoutSchema.safeParse({ rows: fromDndLayout(alone as never) }).success).toBe(
      true,
    );
  });
});

/** A pointer drag of an item onto `target`, past the drag threshold. */
function drag(button: string, target: () => Element | null): void {
  const from = document.querySelector(`[data-dnd-item="${button}"]`) as HTMLElement;
  fireEvent.pointerDown(from, { pointerId: 1, clientX: 1, clientY: 1 });
  const element = target();
  expect(element).not.toBeNull();
  document.elementFromPoint = vi.fn(() => element);
  fireEvent.pointerMove(from, { pointerId: 1, clientX: 30, clientY: 30 });
  fireEvent.pointerUp(from, { pointerId: 1, clientX: 30, clientY: 30 });
}
const freeBox = () => document.querySelector('[data-dnd-free]');
const newRow = () => document.querySelector('[data-dnd-new-row]');
const drawnRows = () =>
  [...document.querySelectorAll('.dnd-row')].map((row) =>
    [...row.querySelectorAll('[data-button]')].map((one) => one.getAttribute('data-button')),
  );

afterEach(() => Reflect.deleteProperty(document, 'elementFromPoint'));

const nameOf = (slot: (typeof SERVICE_CARD_BUTTONS)[number]) =>
  t(INLINE_BUTTON_NAME[slot as keyof typeof INLINE_BUTTON_NAME]);

function api(value: unknown, version: number | null) {
  return stubApi([
    {
      url: '/settings',
      body: { settings: [setting({ key: KEY, value, version, configures: null })] },
    },
    {
      url: `/settings/${KEY}`,
      body: {
        setting: setting({ key: KEY, value, version: (version ?? 0) + 1, configures: null }),
        changed: true,
      },
    },
  ]);
}

const section = (mayEdit = true) => (
  <ServiceCardLayoutSection
    mayEdit={mayEdit}
    denied={false}
    mayViewTemplates={false}
    mayEditTemplates={false}
    templates={undefined}
    onLabelChanged={() => undefined}
  />
);
const loaded = () =>
  waitFor(() =>
    expect(document.querySelector('[data-testid="service-card-layout"]')).not.toBeNull(),
  );

describe('«چیدمان صفحهٔ سرویس»', () => {
  it('lists every configurable button once, in the default rows, with «بازگشت» fixed last', async () => {
    api({ rows: [] }, null);
    renderPage(section());
    await loaded();
    const drawn = [...document.querySelectorAll('[data-button]')].map((node) =>
      node.getAttribute('data-button'),
    );
    expect(drawn).toEqual(DEFAULT_SERVICE_CARD_ROWS.flat());
    for (const slot of SERVICE_CARD_BUTTONS) {
      expect(INLINE_BUTTONS.some((entry) => entry.key === slot)).toBe(true);
    }
    expect(screen.getByTestId('scl-back-fixed')).toHaveTextContent(t('web.scl_back_fixed'));
    // Nothing to save until something changes.
    expect(screen.getByRole('button', { name: t('web.scl_save') })).toBeDisabled();
  });

  it('saves an edited order, rows and a removed button as ONE write with the version read', async () => {
    const a = api({ rows: [] }, 4);
    renderPage(section());
    await loaded();
    // refresh onto the start half of files (right half in Persian): before it.
    const files = document.querySelector('[data-dnd-item="service.files"]') as HTMLElement;
    files.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 30 }) as DOMRect;
    const from = document.querySelector('[data-dnd-item="service.refresh"]') as HTMLElement;
    fireEvent.pointerDown(from, { pointerId: 1, clientX: 1, clientY: 1 });
    document.elementFromPoint = vi.fn(() => files);
    fireEvent.pointerMove(from, { pointerId: 1, clientX: 90, clientY: 20 });
    fireEvent.pointerUp(from, { pointerId: 1, clientX: 90, clientY: 20 });
    expect(drawnRows()[0]).toEqual(['service.refresh', 'service.files']);
    drag('service.link', freeBox);
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_save') }));
    await waitFor(() => {
      const write = a.calls.find((call) => call.method === 'POST');
      expect(write).toBeDefined();
      const body = write?.body as {
        value: { rows: { button: string; enabled: boolean }[][] };
        expectedVersion: number;
      };
      expect(body.expectedVersion).toBe(4);
      expect(serviceCardLayoutSchema.safeParse(body.value).success).toBe(true);
      expect(order(body.value.rows)[0]).toEqual(['service.refresh', 'service.files']);
      const link = body.value.rows.flat().find((entry) => entry.button === 'service.link');
      expect(link?.enabled).toBe(false);
    });
  });

  it('has no move, split or show/hide control: dragging and the free box are the only way', async () => {
    api({ rows: [] }, null);
    renderPage(section());
    await loaded();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    for (const button of document.querySelectorAll('[data-dnd-item] button')) {
      expect(button.textContent).not.toMatch(/[↑↓→←⇡⇣⊟]/u);
    }
    expect(screen.getByText(t('web.kit_dnd_free'))).toBeTruthy();
    expect(screen.getByText(t('web.kit_dnd_new_row'))).toBeTruthy();
    // A full row refuses a fourth button: the drop changes nothing.
    const before = drawnRows();
    const full = before.findIndex((row) => row.length === SERVICE_CARD_ROW_MAX);
    drag('service.files', () => document.querySelector(`[data-dnd-row="${String(full)}"]`));
    expect(drawnRows()).toEqual(before);
  });

  it('«بازگشت به چیدمان پیش‌فرض» saves the empty layout', async () => {
    const a = api({ rows: [[{ button: 'service.note', enabled: true }]] }, 2);
    renderPage(section());
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_reset') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_save') }));
    await waitFor(() => {
      const write = a.calls.find((call) => call.method === 'POST');
      expect((write?.body as { value: unknown }).value).toEqual({ rows: [] });
    });
  });

  it('is read-only without settings.edit', async () => {
    api({ rows: [] }, null);
    renderPage(section(false));
    await loaded();
    expect(screen.getByRole('button', { name: t('web.scl_save') })).toBeDisabled();
    for (const item of document.querySelectorAll('[data-dnd-item]')) {
      if (item.getAttribute('tabindex') === '0')
        expect(item.getAttribute('aria-disabled')).toBe('true');
    }
    drag('service.link', freeBox);
    expect(drawnRows().flat()).toContain('service.link');
  });
});

const noteLabel = INLINE_BUTTONS.find((entry) => entry.key === 'service.note')
  ?.label as TemplateKey;
const noteView = (() => {
  const definition = templateDefinition(noteLabel);
  return templateViewSchema.parse({
    key: noteLabel,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body: 'یادداشت',
    defaultBody: 'یادداشت',
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  });
})();

describe('«چیدمان صفحهٔ سرویس» — review fixes', () => {
  it('after a failed save whose version moved on, offers to adopt the fresh value and saves with it', async () => {
    api({ rows: [] }, 4);
    renderPage(section());
    await loaded();
    drag('service.refresh', newRow);
    // Somebody else saved: the next read is version 5, and this save is refused.
    stubApi([
      {
        url: `/settings/${KEY}`,
        method: 'POST',
        status: 409,
        body: {
          error: { kind: 'conflict', code: 'VERSION_CONFLICT', message: 'x', correlationId: 'c' },
        },
      },
      {
        url: '/settings',
        method: 'GET',
        body: {
          settings: [setting({ key: KEY, value: { rows: [] }, version: 5, configures: null })],
        },
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_save') }));
    const reload = await screen.findByRole('button', { name: t('web.ib_reload') });
    expect(screen.getByRole('button', { name: t('web.scl_save') })).toBeDisabled();
    const a = api({ rows: [] }, 5);
    fireEvent.click(reload);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: t('web.ib_reload') })).toBeNull(),
    );
    drag('service.refresh', newRow);
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_save') }));
    await waitFor(() => {
      const write = a.calls.find((call) => call.method === 'POST');
      expect((write?.body as { expectedVersion: number }).expectedVersion).toBe(5);
    });
  });

  it('locks every control while a save is in flight', async () => {
    api({ rows: [] }, 1);
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>(() => undefined)
        : real(input as string, init),
    );
    renderPage(section());
    await loaded();
    drag('service.refresh', newRow);
    fireEvent.click(screen.getByRole('button', { name: t('web.scl_save') }));
    await waitFor(() =>
      expect(document.querySelector('[data-dnd-item]')?.getAttribute('aria-disabled')).toBe('true'),
    );
    // In flight: a drop changes nothing.
    const during = drawnRows();
    drag('service.files', freeBox);
    expect(drawnRows()).toEqual(during);
    expect(screen.getByRole('button', { name: t('web.scl_reset') })).toBeDisabled();
  });

  it('keeps an unsaved label text when its sheet is closed', async () => {
    api({ rows: [] }, 1);
    renderPage(
      <ServiceCardLayoutSection
        mayEdit
        denied={false}
        mayViewTemplates
        mayEditTemplates
        templates={[noteView]}
        onLabelChanged={() => undefined}
      />,
    );
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: `${t('web.scl_edit_label')}: ${nameOf('service.note')}` }),
    );
    const area = await waitFor(() => {
      const found = document.querySelector('textarea');
      if (found === null) throw new Error('no body');
      return found;
    });
    fireEvent.change(area, { target: { value: 'متن نیمه‌کاره' } });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe('متن نیمه‌کاره');
  });
});
