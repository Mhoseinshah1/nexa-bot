import { readdirSync, readFileSync, statSync } from 'node:fs';
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

/** Rendered only by the one-time import page and its flow. */
const IMPORT_PAGE_KEYS: ReadonlySet<string> = new Set([
  'web.recovery_file_hint',
  'web.recovery_file_mirza',
  'web.recovery_file_unknown',
  'web.recovery_no_permission_nexa',
  'web.lmg_disabled',
  'web.lmg_approval_owner_only',
  'web.lmg_history_title',
  'web.mrz_steps_label',
  'web.mrz_no_permission',
  'web.mrz_confirm_button',
  'web.mrz_exact_col_table',
  'web.mrz_exact_col_mirza_rows',
  'web.mrz_exact_col_mirza_sum',
  'web.mrz_result_ok',
  'web.mrz_result_failed',
]);

const IMPORT_PAGE_FILE = /^pages\/recovery(-mirza[\w-]*)?\.tsx$/u;

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
      expect(
        files.filter((f) => !IMPORT_PAGE_FILE.test(f)),
        key,
      ).toEqual([]);
    }
  });

  it('the source badge and the «منبع» filter are neutral', () => {
    expect(WEB_FA['web.source_badge_mirza']).toBe('منتقل‌شده');
    expect(WEB_FA['web.source_mirza']).toBe('ربات قبلی');
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

  it('no web source outside the catalogue and the import page spells «میرزا» in code', () => {
    const offending: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, file).split('\\').join('/');
      if (rel.startsWith('i18n/') || IMPORT_PAGE_FILE.test(rel)) continue;
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
