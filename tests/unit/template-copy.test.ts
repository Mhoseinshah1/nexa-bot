import { describe, expect, it } from 'vitest';
import { TEMPLATE_KEYS, TEMPLATES } from '@nexa/contracts';
import {
  PLACEHOLDER_LABEL_OVERRIDES_FA,
  PLACEHOLDER_LABELS_FA,
  TEMPLATE_COPY_FA,
} from '../../apps/web/src/i18n/templates.fa';
import {
  matchesTemplateSearch,
  normalizeSearchText,
  placeholderLabel,
  templateCopy,
  templateGroupOf,
} from '../../apps/web/src/template-copy';

/**
 * The Persian names of the bot's message templates (WP-A3).
 *
 * The registry is OPTIONAL per key at the type level, so a package that adds a template
 * key without a Persian name still builds and the screen falls back to the catalogue
 * description. These cases are what make that fallback temporary: each one NAMES the
 * keys or tokens that are missing, so the package that added them is the one that fails,
 * and the failure message says what to add to `apps/web/src/i18n/templates.fa.ts`.
 */

const PERSIAN = /[؀-ۿ]/;
const declaredTokens = (key: string): Set<string> =>
  new Set(TEMPLATES.find((t) => t.key === key)?.placeholders.map((p) => p.token) ?? []);

describe('the Persian template registry', () => {
  it('names and describes every template key in the catalogue', () => {
    const missing = TEMPLATE_KEYS.filter((key) => TEMPLATE_COPY_FA[key] === undefined);
    expect(missing, 'add these keys to TEMPLATE_COPY_FA in templates.fa.ts').toEqual([]);
  });

  it('has no entry for a key the catalogue no longer registers', () => {
    const registered = new Set<string>(TEMPLATE_KEYS);
    const stale = Object.keys(TEMPLATE_COPY_FA).filter((key) => !registered.has(key));
    expect(stale).toEqual([]);
  });

  it('writes every name and description in Persian, and no two templates share a name', () => {
    const notPersian: string[] = [];
    const byName = new Map<string, string[]>();
    for (const [key, entry] of Object.entries(TEMPLATE_COPY_FA)) {
      if (entry === undefined) continue;
      const [name, description] = entry;
      if (!PERSIAN.test(name) || !PERSIAN.test(description)) notPersian.push(key);
      byName.set(name, [...(byName.get(name) ?? []), key]);
    }
    expect(notPersian).toEqual([]);
    // Two cards with one title are two messages an operator cannot tell apart.
    const shared = [...byName.entries()].filter(([, keys]) => keys.length > 1);
    expect(shared).toEqual([]);
  });

  it('labels every placeholder token any template declares', () => {
    const tokens = new Set(TEMPLATES.flatMap((t) => t.placeholders.map((p) => p.token)));
    const missing = [...tokens].filter(
      (token) => !Object.prototype.hasOwnProperty.call(PLACEHOLDER_LABELS_FA, token),
    );
    expect(missing, 'add these tokens to PLACEHOLDER_LABELS_FA in templates.fa.ts').toEqual([]);
  });

  it('overrides a label only for a token that template actually declares', () => {
    const stale: string[] = [];
    for (const [key, labels] of Object.entries(PLACEHOLDER_LABEL_OVERRIDES_FA)) {
      const declared = declaredTokens(key);
      for (const token of Object.keys(labels ?? {})) {
        if (!declared.has(token)) stale.push(`${key}: {${token}}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('puts every catalogue key in a named section rather than the catch-all', () => {
    const unsectioned = TEMPLATE_KEYS.filter((key) => templateGroupOf(key).id === 'other');
    expect(unsectioned, 'give these keys a prefix in TEMPLATE_GROUPS_FA').toEqual([]);
  });
});

describe('a key or token with no Persian entry', () => {
  it('falls back to the raw key and the catalogue description instead of failing', () => {
    expect(templateCopy('bot.not_yet_named', 'Catalogue description.')).toEqual({
      name: 'bot.not_yet_named',
      description: 'Catalogue description.',
      localized: false,
    });
    expect(placeholderLabel('bot.not_yet_named', 'notYetLabelled', 'The value.')).toBe(
      'The value.',
    );
    // Not fooled by a token that is a property of every object.
    expect(placeholderLabel('bot.ping.reply', 'constructor', 'fallback')).toBe('fallback');
  });

  it('shows the per-template meaning of a token before the general one', () => {
    const general = placeholderLabel('ops.financial.order_paid', 'username', '');
    const admin = placeholderLabel('bot.admin.linked', 'username', '');
    expect(general).not.toBe('');
    expect(admin).not.toBe('');
    expect(admin).not.toBe(general);
  });
});

describe('sections', () => {
  it('uses the longest matching prefix, so a narrower section wins', () => {
    expect(templateGroupOf('bot.service.transfer_prompt').id).toBe('transfer');
    expect(templateGroupOf('bot.service.card').id).toBe('services');
    expect(templateGroupOf('bot.admin.panel').id).toBe('admin');
    expect(templateGroupOf('bot.admin.panel_detail').id).toBe('admin_panels');
    expect(templateGroupOf('bot.payment.gateway_invoice').id).toBe('gateway');
    expect(templateGroupOf('bot.payment.receipt_prompt').id).toBe('payment');
  });

  it('gives the location change and the extra users / devices screens their own sections', () => {
    expect(templateGroupOf('bot.service.change_location_button').id).toBe('location_change');
    expect(templateGroupOf('bot.service.location_confirm_free').id).toBe('location_change');
    expect(templateGroupOf('bot.service.add_devices_button').id).toBe('extra_devices');
    expect(templateGroupOf('bot.service.devices_choice').id).toBe('extra_devices');
    // The pre-invoice blocks stay with the pre-invoice they are part of.
    expect(templateGroupOf('bot.order.preinvoice_location_change').id).toBe('catalog');
  });

  it('sends a key no section claims to the catch-all', () => {
    expect(templateGroupOf('something.new').id).toBe('other');
  });
});

describe('template search', () => {
  it('finds a template by its raw key and by its Persian name', () => {
    const [name, description] = TEMPLATE_COPY_FA['bot.wallet.balance'] ?? ['', ''];
    const haystack = [name, description, 'bot.wallet.balance', 'body'];
    expect(matchesTemplateSearch('BOT.WALLET.balance', haystack)).toBe(true);
    expect(matchesTemplateSearch(name, haystack)).toBe(true);
    expect(matchesTemplateSearch('bot.order', haystack)).toBe(false);
  });

  it('requires every word, in any order', () => {
    const haystack = ['alpha beta', 'gamma'];
    expect(matchesTemplateSearch('gamma alpha', haystack)).toBe(true);
    expect(matchesTemplateSearch('gamma delta', haystack)).toBe(false);
    expect(matchesTemplateSearch('   ', haystack)).toBe(true);
  });

  it('treats Arabic and Persian letters, the ZWNJ and either digit script as the same', () => {
    // Arabic yeh and kaf, typed on an Arabic layout, against the Persian letters.
    expect(normalizeSearchText('يك')).toBe(normalizeSearchText('یک'));
    // With and without the zero-width non-joiner.
    expect(normalizeSearchText('می‌شود')).toBe(normalizeSearchText('میشود'));
    // Persian digits against Latin ones.
    expect(normalizeSearchText('۱۲')).toBe('12');
  });
});
