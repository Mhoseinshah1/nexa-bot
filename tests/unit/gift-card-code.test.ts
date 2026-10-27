import { describe, expect, it } from 'vitest';
import {
  GIFT_CARD_CODE_ALPHABET,
  GIFT_CARD_CODE_INPUT_MAX_LENGTH,
  GIFT_CARD_CODE_LENGTH,
  GIFT_CARD_EXPORT_COLUMNS,
  money,
} from '@nexa/contracts';
import {
  formatGiftCardCode,
  generateGiftCardCode,
  giftCardLast4,
  hashGiftCardCode,
  normaliseGiftCardCode,
} from '../../apps/api/src/modules/commerce/gift-cards/domain/gift-card-code';
import {
  buildGiftCardCsv,
  giftCardCsvFileName,
} from '../../apps/api/src/modules/commerce/gift-cards/infrastructure/gift-card-csv';
import { redactForLog, redactSecretText } from '../../apps/api/src/infrastructure/redaction';
import type { GiftCardBatchRecord } from '../../apps/api/src/modules/commerce/gift-cards/application/ports';

/**
 * R10 D4 — the gift card code: generated uniformly from the CSPRNG, normalised forgivingly but
 * never guessed at, stored only as a tenant-bound hash, and redacted wherever text is logged.
 * Synthetic codes only.
 */

const TENANT_A = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b';
const TENANT_B = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7c';

/** A random source that hands out exactly these bytes, then zeros. */
function scripted(bytes: readonly number[]): (size: number) => Uint8Array {
  let at = 0;
  return (size) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) out[i] = at < bytes.length ? (bytes[at++] as number) : 0;
    return out;
  };
}

describe('generateGiftCardCode', () => {
  it('draws 20 symbols of the public-code alphabet, about 98 bits', () => {
    expect(GIFT_CARD_CODE_ALPHABET).toHaveLength(30);
    expect(GIFT_CARD_CODE_LENGTH).toBe(20);
    expect(GIFT_CARD_CODE_LENGTH * Math.log2(GIFT_CARD_CODE_ALPHABET.length)).toBeGreaterThan(98);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = generateGiftCardCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{20}$/u);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  it('discards every byte at or above 240, so no symbol is favoured (rejection sampling)', () => {
    // Bytes 240..255 would map onto the first 16 symbols a second time under `% 30`.
    const high = Array.from({ length: 16 }, (_, i) => 240 + i);
    const code = generateGiftCardCode(
      scripted([...high, ...Array.from({ length: 20 }, (_, i) => i)]),
    );
    expect(code).toBe(GIFT_CARD_CODE_ALPHABET.slice(0, 20));
  });

  it('gives every symbol the same share: the first 16 symbols are not favoured by `% 30`', () => {
    // 20 000 codes, 400 000 symbols, ~13 333 each. Without the rejection the first 16 symbols
    // would each expect 9/256 of the draws and the last 14 only 8/256 — about 1 560 apart on
    // average. With it the two group means differ by sampling noise only (σ ≈ 40).
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      for (const symbol of generateGiftCardCode())
        counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    const share = (symbols: string): number =>
      [...symbols].reduce((sum, symbol) => sum + (counts.get(symbol) ?? 0), 0) / symbols.length;
    const first = share(GIFT_CARD_CODE_ALPHABET.slice(0, 16));
    const rest = share(GIFT_CARD_CODE_ALPHABET.slice(16));
    expect(Math.abs(first - rest)).toBeLessThan(400);
  });

  it('never maps a discarded byte, however many come in a row', () => {
    const fromHigh = generateGiftCardCode(
      scripted([
        ...Array.from({ length: 31 }, () => 255),
        29,
        ...Array.from({ length: 19 }, () => 0),
      ]),
    );
    expect(fromHigh).toBe(`${GIFT_CARD_CODE_ALPHABET[29] as string}${'2'.repeat(19)}`);
  });
});

describe('normaliseGiftCardCode', () => {
  const code = 'ABCDEFGHJKMNPQRSTVWX';

  it('forgives case, dashes, spaces, line breaks and Persian or Arabic digits', () => {
    expect(normaliseGiftCardCode(formatGiftCardCode(code))).toBe(code);
    expect(normaliseGiftCardCode(' abcd efgh-jkmn\npqrs tvwx ')).toBe(code);
    expect(normaliseGiftCardCode('۲۳۴۵-٦٧٨٩-ABCD-EFGH-JKMN')).toBe('23456789ABCDEFGHJKMN');
    expect(normaliseGiftCardCode('ABCD‌EFGH​JKMN—PQRS‐TVWX')).toBe(code);
  });

  it('refuses rather than guesses a symbol outside the alphabet', () => {
    for (const bad of ['0', '1', 'O', 'I', 'L', 'U']) {
      expect(normaliseGiftCardCode(`${bad}${code.slice(1)}`)).toBeNull();
    }
    expect(normaliseGiftCardCode(code.slice(1))).toBeNull();
    expect(normaliseGiftCardCode(`${code}2`)).toBeNull();
    expect(normaliseGiftCardCode('')).toBeNull();
  });

  it('refuses unread anything longer than the input bound', () => {
    const padded = `${' '.repeat(GIFT_CARD_CODE_INPUT_MAX_LENGTH - code.length + 1)}${code}`;
    expect(padded.length).toBe(GIFT_CARD_CODE_INPUT_MAX_LENGTH + 1);
    expect(normaliseGiftCardCode(padded)).toBeNull();
    expect(normaliseGiftCardCode(padded.slice(1))).toBe(code);
  });

  it('prints the code in five groups of four and keeps its last four for support', () => {
    expect(formatGiftCardCode(code)).toBe('ABCD-EFGH-JKMN-PQRS-TVWX');
    expect(giftCardLast4(code)).toBe('TVWX');
  });
});

describe('hashGiftCardCode', () => {
  it('is hex SHA-256 bound to the tenant: one code never matches in another tenant', () => {
    const code = generateGiftCardCode();
    const a = hashGiftCardCode(TENANT_A, code);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashGiftCardCode(TENANT_A, code)).toBe(a);
    expect(hashGiftCardCode(TENANT_B, code)).not.toBe(a);
    expect(a).not.toContain(code.toLowerCase());
  });
});

describe('the export CSV', () => {
  const batch: GiftCardBatchRecord = {
    id: '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b',
    label: '=HYPERLINK("http://evil")',
    amount: money(500_000n, 'IRT'),
    codeCount: 2,
    perCustomerLimit: null,
    expiresAt: new Date('2026-12-31T20:30:00.000Z'),
    state: 'ACTIVE',
    reason: 'test',
    createdByAdminId: null,
    createdAt: new Date('2026-10-26T00:00:00.000Z'),
    disabledAt: null,
    disabledByAdminId: null,
    exportExpiresAt: new Date('2026-10-27T00:00:00.000Z'),
    sealedExport: null,
  };

  it('writes a BOM, the header, one quoted row per code and neutralises a formula label', () => {
    const csv = buildGiftCardCsv(batch, ['ABCDEFGHJKMNPQRSTVWX', '23456789ABCDEFGHJKMN'], {
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
    });
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(GIFT_CARD_EXPORT_COLUMNS.map((c) => `"${c}"`).join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(
      '"ABCD-EFGH-JKMN-PQRS-TVWX","500000","IRT","2026-12-31T20:30:00.000Z"',
    );
    // A label that would be a spreadsheet formula is prefixed and its quotes doubled.
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(giftCardCsvFileName(batch.id)).toBe('gift-cards-0190a5b2.csv');
  });
});

describe('redaction of a gift card code in free text', () => {
  it('takes a code typed bare, grouped, or lower-case, wherever it sits in a sentence', () => {
    for (const shape of [
      'ABCDEFGHJKMNPQRSTVWX',
      'ABCD-EFGH-JKMN-PQRS-TVWX',
      'abcd efgh jkmn pqrs tvwx',
    ]) {
      const out = redactSecretText(`customer typed ${shape} into the bot`);
      expect(out).not.toContain(shape);
      expect(out).toContain('customer typed');
    }
    const logged = JSON.stringify(redactForLog({ text: 'code ABCD-EFGH-JKMN-PQRS-TVWX here' }));
    expect(logged).not.toContain('ABCD-EFGH-JKMN-PQRS-TVWX');
  });

  it('leaves a uuid, a hex digest and an ordinary Persian sentence alone', () => {
    const uuid = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b';
    const hex = 'a'.repeat(64);
    const sentence = 'کد هدیه پذیرفته شد';
    expect(redactSecretText(`order ${uuid}`)).toBe(`order ${uuid}`);
    expect(redactSecretText(`hash ${hex}`)).toBe(`hash ${hex}`);
    expect(redactSecretText(sentence)).toBe(sentence);
  });
});
