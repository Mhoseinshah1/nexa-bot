import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  DEFAULT_SERVICE_CARD_ROWS,
  INLINE_BUTTONS,
  SERVICE_CARD_BUTTONS,
  SERVICE_CARD_ROW_MAX,
  serviceCardLayoutSchema,
} from '@nexa/contracts';
import { ServiceCardLayoutSection } from '../../apps/web/src/pages/bot-buttons/service-card-layout';
import { INLINE_BUTTON_NAME } from '../../apps/web/src/pages/bot-buttons/inline-buttons';
import {
  defaultServiceCardRows,
  effectiveServiceCardRows,
  moveServiceCardAcrossRows,
  moveServiceCardRow,
  moveServiceCardWithinRow,
  setServiceCardEnabled,
  splitServiceCardButton,
  storedServiceCardRows,
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

  it('moves within a row, across rows and into a row of its own — never past three', () => {
    const rows = defaultServiceCardRows();
    expect(order(moveServiceCardWithinRow(rows, 'service.refresh', 1))[0]).toEqual([
      'service.files',
      'service.refresh',
    ]);
    // The third row is full: nothing may join it.
    const full = moveServiceCardAcrossRows(rows, 'service.link', 1);
    expect(order(full)).toEqual(order(rows));
    // A button may join a row with room, and its old row closes when it empties.
    const joined = moveServiceCardAcrossRows(rows, 'service.add_devices', -1);
    expect(order(joined)[3]).toEqual(['service.renew', 'service.suspend', 'service.add_devices']);
    expect(joined.length).toBe(rows.length - 1);
    // Split makes a row of one; a row of one cannot be split or moved off the end.
    expect(order(splitServiceCardButton(rows, 'service.files'))[1]).toEqual(['service.files']);
    expect(splitServiceCardButton(rows, 'service.add_devices')).toBe(rows);
    for (const edited of [joined, full, splitServiceCardButton(rows, 'service.files')]) {
      for (const row of edited) {
        expect(row.length).toBeGreaterThanOrEqual(1);
        expect(row.length).toBeLessThanOrEqual(SERVICE_CARD_ROW_MAX);
      }
      expect(serviceCardLayoutSchema.safeParse({ rows: edited }).success).toBe(true);
    }
  });

  it('moves a whole row', () => {
    const rows = defaultServiceCardRows();
    expect(order(moveServiceCardRow(rows, 0, 1))[1]).toEqual(['service.refresh', 'service.files']);
    expect(moveServiceCardRow(rows, 0, -1)).toBe(rows);
  });
});

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

  it('saves an edited order, rows and switch as ONE write with the version read', async () => {
    const a = api({ rows: [] }, 4);
    renderPage(section());
    await loaded();
    fireEvent.click(
      screen.getByRole('button', { name: `${t('web.scl_later')}: ${nameOf('service.refresh')}` }),
    );
    fireEvent.click(
      screen.getByRole('switch', { name: `${t('web.scl_show')} ${nameOf('service.link')}` }),
    );
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
      expect(order(body.value.rows)[0]).toEqual(['service.files', 'service.refresh']);
      const link = body.value.rows.flat().find((entry) => entry.button === 'service.link');
      expect(link?.enabled).toBe(false);
    });
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
    expect(
      screen.getByRole('switch', { name: `${t('web.scl_show')} ${nameOf('service.link')}` }),
    ).toBeDisabled();
  });
});
