import { describe, expect, it } from 'vitest';
import { OPS_ERROR_EVENTS } from '@nexa/contracts';
import {
  OPERATIONAL_EVENT_FAMILY_LABELS_FA,
  OPERATIONAL_EVENT_LABELS_FA,
  operationalEventLabelFa,
} from '@nexa/i18n';

const PERSIAN = /[؀-ۿ]/u;

/**
 * Round 4 B5: the alerts page, the dashboard and the operations-group renderer name an
 * operational event from its CODE through one shared map. A code with no Persian name would
 * fall back to raw English on an operator's screen, so every classified code must have one.
 */
describe('operational-event labels (packages/i18n)', () => {
  it('names every classified operational-event code in Persian', () => {
    expect(OPS_ERROR_EVENTS.length).toBeGreaterThan(40);
    const missing = OPS_ERROR_EVENTS.filter(
      (event) => operationalEventLabelFa(event.code) === null,
    );
    // A family entry (`prefix: true`) is named by its family label, and an exact code by its own.
    for (const event of OPS_ERROR_EVENTS.filter((entry) => entry.prefix === true)) {
      expect(OPERATIONAL_EVENT_FAMILY_LABELS_FA[event.code], event.code).toMatch(PERSIAN);
    }
    for (const event of OPS_ERROR_EVENTS.filter((entry) => entry.prefix !== true)) {
      expect(OPERATIONAL_EVENT_LABELS_FA[event.code], event.code).toMatch(PERSIAN);
    }
    expect(missing.map((event) => event.code)).toEqual([]);
  });

  it('every name contains Persian letters and is not the code itself', () => {
    for (const [code, text] of Object.entries(OPERATIONAL_EVENT_LABELS_FA)) {
      expect(text, code).toMatch(PERSIAN);
      expect(text, code).not.toBe(code);
    }
  });

  it('does not claim a name for a code it has never heard of', () => {
    expect(operationalEventLabelFa('brand.new_code')).toBeNull();
    expect(operationalEventLabelFa('constructor')).toBeNull();
  });
});
