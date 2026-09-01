import { describe, expect, it } from 'vitest';
import { money, TEMPLATE_KEYS } from '@nexa/contracts';
import { auditCatalogue, CATALOGUE_FA, createTranslator, formatMoney } from '@nexa/i18n';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';

describe('shared catalogue', () => {
  it('has a Persian string for every registered template key', () => {
    const audit = auditCatalogue('fa');
    expect(audit.missing).toEqual([]);
  });

  it('uses only declared placeholder tokens', () => {
    const audit = auditCatalogue('fa');
    expect(audit.undeclaredTokens).toEqual([]);
  });

  it('stores templates raw, with placeholders un-substituted', () => {
    // The legacy editor echoed the RENDERED string, so saving from that view
    // baked an admin's own name into {first_name} for ~13,700 customers.
    expect(CATALOGUE_FA['bot.ping.reply']).toContain('{correlationId}');
  });

  it('substitutes declared tokens', () => {
    const translator = createTranslator();
    const rendered = translator.translate('bot.ping.reply', { correlationId: 'abc-123' });
    expect(rendered).toContain('abc-123');
    expect(rendered).not.toContain('{correlationId}');
  });

  it('leaves an unsupplied token intact rather than printing "undefined"', () => {
    const translator = createTranslator();
    expect(translator.translate('bot.ping.reply')).toContain('{correlationId}');
  });

  it('reports which keys it has', () => {
    const translator = createTranslator();
    for (const key of TEMPLATE_KEYS) {
      expect(translator.has(key)).toBe(true);
    }
  });
});

describe('money formatting', () => {
  it('renders the currency unit from the type, never from copy', () => {
    // One legacy card-to-card template says تومان where its twin says ریال for
    // the same {price} token, because the unit was typed into the text.
    expect(formatMoney(money(145000n, 'IRT'))).toBe('145,000 تومان');
    expect(formatMoney(money(145000n, 'IRR'))).toBe('145,000 ریال');
  });

  it('applies the currency exponent', () => {
    expect(formatMoney(money(12345n, 'USD'))).toBe('123.45 دلار');
  });

  it('renders negatives with the sign outside the grouping', () => {
    expect(formatMoney(money(-1500n, 'IRT'))).toBe('-1,500 تومان');
  });

  it('formats amounts beyond the safe integer range exactly', () => {
    expect(formatMoney(money(9007199254740993n, 'IRT'))).toBe('9,007,199,254,740,993 تومان');
  });
});

describe('surface-scoped catalogue', () => {
  it('keeps web chrome under the web namespace', () => {
    for (const key of Object.keys(WEB_FA)) {
      expect(key.startsWith('web.')).toBe(true);
    }
  });

  it('does not duplicate a shared key in the web catalogue', () => {
    const shared = new Set<string>(TEMPLATE_KEYS);
    for (const key of Object.keys(WEB_FA)) {
      expect(shared.has(key)).toBe(false);
    }
  });
});
