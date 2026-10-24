import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVICE_CARD_ROWS,
  INLINE_BUTTONS,
  SERVICE_CARD_BUTTONS,
  SERVICE_CARD_ROW_MAX,
  serviceCardLayoutSchema,
  serviceCardSlotOf,
  settingDefinition,
} from '@nexa/contracts';

/** R8-C3: the service screen's layout value. */
const entry = (button: (typeof SERVICE_CARD_BUTTONS)[number], enabled = true) => ({
  button,
  enabled,
});

describe('the service screen layout (R8-C3)', () => {
  it('is a registered setting whose default is the empty, as-always layout', () => {
    const definition = settingDefinition('bot.service_card_layout');
    expect(definition.defaultValue).toEqual({ rows: [] });
    expect(serviceCardLayoutSchema.safeParse(definition.defaultValue).success).toBe(true);
  });

  it('names only real inline buttons that have a label template', () => {
    for (const slot of SERVICE_CARD_BUTTONS) {
      const found = INLINE_BUTTONS.find((one) => one.key === slot);
      expect(found?.label, slot).not.toBeNull();
      expect(found, slot).toBeDefined();
    }
    // «بازگشت» is never a slot: it is always present and always last.
    expect(SERVICE_CARD_BUTTONS as readonly string[]).not.toContain('service.back_to_list');
  });

  it('the default rows name every slot exactly once, at most three to a row', () => {
    const flat = DEFAULT_SERVICE_CARD_ROWS.flat();
    expect([...flat].sort()).toEqual([...SERVICE_CARD_BUTTONS].sort());
    for (const row of DEFAULT_SERVICE_CARD_ROWS) {
      expect(row.length).toBeGreaterThanOrEqual(1);
      expect(row.length).toBeLessThanOrEqual(SERVICE_CARD_ROW_MAX);
    }
  });

  it('accepts rows of one to three and refuses four, an empty row and a repeated button', () => {
    const ok = (rows: unknown) => serviceCardLayoutSchema.safeParse({ rows }).success;
    expect(ok([[entry('service.note'), entry('service.renew', false)]])).toBe(true);
    expect(
      ok([
        [
          entry('service.note'),
          entry('service.renew'),
          entry('service.link'),
          entry('service.files'),
        ],
      ]),
    ).toBe(false);
    expect(ok([[]])).toBe(false);
    expect(ok([[entry('service.note')], [entry('service.note')]])).toBe(false);
    expect(ok([[{ button: 'service.back_to_list', enabled: true }]])).toBe(false);
    expect(ok([[{ button: 'service.note', enabled: 'true' }]])).toBe(false);
  });

  it('resume shares the suspend slot', () => {
    expect(serviceCardSlotOf('service.resume')).toBe('service.suspend');
    expect(serviceCardSlotOf('service.back_to_list')).toBeNull();
  });
});
