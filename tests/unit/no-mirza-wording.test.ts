import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_HEADERS_FA,
  CATALOGUE_FA,
  REPORT_EXPORT_HEADERS_FA,
  REPORT_EXPORT_SHEETS_FA,
} from '@nexa/i18n';
import { PAYMENT_METHOD_NAMES_FA } from '../../packages/i18n/src/payment-methods.fa';
import {
  PLACEHOLDER_LABEL_OVERRIDES_FA,
  PLACEHOLDER_LABELS_FA,
  PLACEHOLDER_TYPE_LABELS_FA,
  TEMPLATE_COPY_FA,
  TEMPLATE_GROUPS_FA,
  TEMPLATE_OTHER_GROUP_FA,
} from '../../apps/web/src/i18n/templates.fa';
import { WEB_FA } from '../../apps/web/src/i18n/web.fa';
import {
  MIRZA_IMPORT_ADMIN_DISPLAY_NAME,
  MIRZA_TICKET_CATEGORY_TITLE,
} from '../../apps/api/src/modules/platform/legacy-materialize/application/ticket-history.step';

/**
 * Owner product rule (2026-10-18, superseding the 2026-10-17 «از میرزا» badge): the name of
 * the previous bot appears nowhere in customer-facing or operator text, EXCEPT on the
 * one-time import page — the Mirza restore flow inside «بکاپ و بازیابی ← عملیات بازیابی»
 * (`apps/web/src/pages/recovery.tsx` and `recovery-mirza*.tsx`). Everywhere else it is
 * «ربات قبلی» / «منتقل‌شده».
 *
 * The allowlist is closed and every entry must be drawn ONLY by the import page, so a
 * key cannot be allowlisted to smuggle the name onto another screen.
 */

const PREVIOUS_BOT_NAME = /میرزا|ميرزا|mirza/iu;

/**
 * Round 4 B4 (owner, 2026-10-19): the allowlist is EMPTY. The one-click import page speaks of
 * «ربات قبلی» like every other screen, so the catalogue never spells the old bot's name.
 */
const IMPORT_PAGE_KEYS: ReadonlySet<string> = new Set([]);

const ROOT = join(__dirname, '..', '..');
const WEB_SRC = join(ROOT, 'apps', 'web', 'src');

/** Every string reachable from a value, with a path naming where it sits. */
function strings(value: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, `${path}.${k}`, out);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/u.test(name) ? [full] : [];
  });
}

describe('no previous-bot name outside the one-time import page', () => {
  it('the web catalogue names it only under allowlisted import-page keys', () => {
    const offending = Object.entries(WEB_FA)
      .filter(([key, text]) => PREVIOUS_BOT_NAME.test(text) && !IMPORT_PAGE_KEYS.has(key))
      .map(([key]) => key);
    expect(offending).toEqual([]);
  });

  it('every allowlisted key is drawn by the import page and nowhere else', () => {
    const users = new Map<string, string[]>();
    for (const file of sourceFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, file).split('\\').join('/');
      if (rel.startsWith('i18n/')) continue;
      const text = readFileSync(file, 'utf8');
      for (const key of IMPORT_PAGE_KEYS) {
        if (text.includes(`'${key}'`)) users.set(key, [...(users.get(key) ?? []), rel]);
      }
    }
    for (const key of IMPORT_PAGE_KEYS) {
      expect(key in WEB_FA, `${key} is no longer in the catalogue; drop it here`).toBe(true);
      const files = users.get(key) ?? [];
      expect(files.length, `${key} is drawn by no page`).toBeGreaterThan(0);
    }
  });

  it('the source badge reads «منتقل‌شده از ربات قبلی» and the «منبع» filter is gone (R4 B2)', () => {
    expect(WEB_FA['web.source_badge_mirza']).toBe('منتقل‌شده از ربات قبلی');
    for (const key of [
      'web.source_mirza',
      'web.source_nexa',
      'web.source_filter',
      'web.source_filter_all',
    ]) {
      expect(key in WEB_FA, key).toBe(false);
    }
    expect(existsSync(join(WEB_SRC, 'pages', 'record-source.tsx'))).toBe(false);
  });

  it('the imported-from mark is drawn only on tickets and payments (R4 B2)', () => {
    const users = sourceFiles(WEB_SRC)
      .map((file) => relative(WEB_SRC, file).split('\\').join('/'))
      .filter((rel) => !rel.startsWith('i18n/'))
      .filter((rel) =>
        /SourceBadge|source_badge_mirza/u.test(readFileSync(join(WEB_SRC, rel), 'utf8')),
      )
      .sort();
    expect(users).toEqual(['pages/payments.tsx', 'pages/tickets.tsx', 'ui/source-badge.tsx']);
  });

  it('the opening-balance ledger reason reads «موجودی اولیه» (R4 B2)', () => {
    expect(WEB_FA['web.ledger_reason_migration_opening_balance']).toBe('موجودی اولیه');
  });

  it('the customer bot catalogue and the shared export labels never name it', () => {
    const offending = [
      ...strings(CATALOGUE_FA, 'CATALOGUE_FA'),
      ...strings(AUDIT_EXPORT_HEADERS_FA, 'AUDIT_EXPORT_HEADERS_FA'),
      ...strings(REPORT_EXPORT_HEADERS_FA, 'REPORT_EXPORT_HEADERS_FA'),
      ...strings(REPORT_EXPORT_SHEETS_FA, 'REPORT_EXPORT_SHEETS_FA'),
      ...strings(PAYMENT_METHOD_NAMES_FA, 'PAYMENT_METHOD_NAMES_FA'),
    ]
      .filter(([, text]) => PREVIOUS_BOT_NAME.test(text))
      .map(([path]) => path);
    expect(offending).toEqual([]);
  });

  it('the operator template copy never names it', () => {
    const offending = [
      ...strings(TEMPLATE_COPY_FA, 'TEMPLATE_COPY_FA'),
      ...strings(TEMPLATE_GROUPS_FA, 'TEMPLATE_GROUPS_FA'),
      ...strings(TEMPLATE_OTHER_GROUP_FA, 'TEMPLATE_OTHER_GROUP_FA'),
      ...strings(PLACEHOLDER_LABELS_FA, 'PLACEHOLDER_LABELS_FA'),
      ...strings(PLACEHOLDER_LABEL_OVERRIDES_FA, 'PLACEHOLDER_LABEL_OVERRIDES_FA'),
      ...strings(PLACEHOLDER_TYPE_LABELS_FA, 'PLACEHOLDER_TYPE_LABELS_FA'),
    ]
      .filter(([, text]) => PREVIOUS_BOT_NAME.test(text))
      .map(([path]) => path);
    expect(offending).toEqual([]);
  });

  it('the labels the import writes into rows the operator sees are neutral', () => {
    expect(MIRZA_TICKET_CATEGORY_TITLE).not.toMatch(PREVIOUS_BOT_NAME);
    expect(MIRZA_IMPORT_ADMIN_DISPLAY_NAME).not.toMatch(PREVIOUS_BOT_NAME);
  });

  it('no web source spells «میرزا» in code', () => {
    const offending: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, file).split('\\').join('/');
      if (rel.startsWith('i18n/')) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
          if (/میرزا|ميرزا/u.test(line)) offending.push(`${rel}:${i + 1}`);
        });
    }
    expect(offending).toEqual([]);
  });
});
