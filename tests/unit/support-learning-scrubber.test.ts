import { describe, expect, it } from 'vitest';
import {
  SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA,
  supportLearningExtractionSchema,
  type SupportLearningSensitiveKind,
} from '@nexa/contracts';
import {
  detectSensitive,
  foldDigits,
  scrubSensitive,
} from '../../apps/api/src/modules/control/support-knowledge/domain/scrubber';
import {
  NEAR_DUPLICATE_THRESHOLD,
  findDuplicate,
  normalizeTitle,
  trigramSimilarity,
} from '../../apps/api/src/modules/control/support-knowledge/domain/dedupe';
import {
  learningSystemPrompt,
  learningUserMessage,
} from '../../apps/api/src/modules/control/support-knowledge/domain/learning-prompt';

/**
 * TB8 — the pure parts of controlled learning: the scrubber (run before the provider and again
 * over its output), the strict extraction schema, and the duplicate detection.
 */

describe('scrubber: every shape it must catch', () => {
  const cases: readonly (readonly [string, string, SupportLearningSensitiveKind])[] = [
    ['an Iranian mobile', 'شماره من 09121234567 است', 'PHONE'],
    ['an Iranian mobile in Persian digits', 'شماره من ۰۹۱۲۱۲۳۴۵۶۷ است', 'PHONE'],
    ['an Iranian mobile in Arabic-Indic digits', 'رقم ٠٩١٢١٢٣٤٥٦٧', 'PHONE'],
    ['a grouped mobile', 'call 0912 123 4567 please', 'PHONE'],
    ['a dashed mobile in Persian digits', 'تماس: ۰۹۱۲-۱۲۳-۴۵۶۷', 'PHONE'],
    ['an international number', 'reach me at +98 912 123 4567', 'PHONE'],
    ['a 00 international number', 'tel 00989121234567', 'PHONE'],
    ['a landline', 'دفتر 021-88776655', 'PHONE'],
    ['a card number', 'کارت 6037991234567890 به نام', 'CARD'],
    ['a grouped card in Persian digits', 'کارت ۶۰۳۷-۹۹۱۲-۳۴۵۶-۷۸۹۰', 'CARD'],
    ['a spaced card', 'card 6037 9912 3456 7890', 'CARD'],
    ['an Iranian IBAN', 'شبا IR820540102680020817909002', 'IBAN'],
    ['a grouped IBAN', 'IR82 0540 1026 8002 0817 9090 02', 'IBAN'],
    ['an e-mail', 'mail me at ali.rezaei+vpn@gmail.com', 'EMAIL'],
    [
      'a vless link',
      'vless://3f1e2c4a-1b2c-4d5e-8f90-123456789abc@1.2.3.4:443?type=ws#me',
      'SUBSCRIPTION_LINK',
    ],
    ['a vmess link', 'vmess://eyJ2IjoiMiIsInBzIjoibWUifQ==', 'SUBSCRIPTION_LINK'],
    ['a subscription URL', 'https://panel.example.com/sub/abc123', 'SUBSCRIPTION_LINK'],
    ['a URL with a token parameter', 'https://example.com/dl?token=abc', 'URL_TOKEN'],
    ['a URL with userinfo', 'https://admin:hunter2@panel.example.com/', 'URL_TOKEN'],
    ['a URL with a token-shaped segment', 'https://x.io/f/Ab3dEf6hIj9kLmNoPq2sTuV', 'URL_TOKEN'],
    ['a Telegram invite link', 'join t.me/+AbCdEfGh123', 'URL_TOKEN'],
    ['an IPv4 address', 'server 185.12.34.56:2053', 'IP_ADDRESS'],
    ['a UUID', 'id 3f1e2c4a-1b2c-4d5e-8f90-123456789abc', 'UUID'],
    ['a password line', 'password: Sup3rS3cret!', 'SECRET'],
    ['a Persian password line', 'رمز عبور: abc12345', 'SECRET'],
    ['an API key', 'key sk-proj-abcdefghijklmnop1234', 'SECRET'],
    ['a long base64 token', 'token QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA=', 'SECRET'],
    ['a Telegram username', 'به @ali_support2 پیام بده', 'USERNAME'],
    ['an amount in toman', 'مبلغ ۲۵۰,۰۰۰ تومان برگشت داده شد', 'AMOUNT'],
    ['an amount in thousands of toman', '۱۵۰ هزار تومان', 'AMOUNT'],
    ['an amount in rial', '1500000 ریال', 'AMOUNT'],
    ['a dollar amount', 'refund of $12.50', 'AMOUNT'],
    ['a USDT amount', 'send 10 USDT', 'AMOUNT'],
    ['a Telegram id', 'user 7000001234 asked', 'LONG_NUMBER'],
    ['a Telegram id in Persian digits', 'آیدی ۷۰۰۰۰۰۱۲۳۴', 'LONG_NUMBER'],
    ['a transaction number', 'پیگیری 98765432', 'LONG_NUMBER'],
    ['a redaction marker', 'call [REDACTED:PHONE] now', 'REDACTION_MARK'],
  ];
  for (const [label, text, kind] of cases) {
    it(`${label} → ${kind}`, () => {
      const result = scrubSensitive(text);
      expect(result.kinds).toContain(kind);
      expect(result.text).toContain(`[REDACTED:${kind}]`);
    });
  }

  it('replaces the value itself, so no digit of it survives', () => {
    const result = scrubSensitive('شماره ۰۹۱۲۱۲۳۴۵۶۷ و کارت 6037991234567890');
    expect(result.text).not.toMatch(/0912|1234567|6037|۰۹۱۲/u);
    expect(result.kinds).toEqual(['PHONE', 'CARD']);
  });

  it('leaves general support text alone', () => {
    const general = [
      'برای اتصال، برنامه v2rayNG را از Google Play نصب کنید و لینک اشتراک را از ربات بگیرید.',
      'اگر وصل نمی‌شوید، یک بار حالت هواپیما را روشن و خاموش کنید.',
      'پلن ۳۰ روزه با ۲ کاربر همزمان است.',
      'Open Settings > Routing and pick "Global".',
      'https://play.google.com/store/apps/details?id=com.v2ray.ang',
      'تاریخ انقضا 2026-10-04 است.',
      'نسخه 1.8.2 را نصب کنید.',
    ];
    for (const text of general) expect(detectSensitive(text), text).toEqual([]);
  });

  it('folds Persian and Arabic-Indic digits one for one', () => {
    expect(foldDigits('۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩')).toBe('0123456789 0123456789');
  });

  it('does not re-scrub its own marker, and reports each kind once', () => {
    const once = scrubSensitive('a 09121234567 b 09351234567');
    expect(once.kinds).toEqual(['PHONE']);
    expect(scrubSensitive(once.text).kinds).toEqual(['REDACTION_MARK']);
  });

  it('catches digits split by zero-width characters', () => {
    expect(detectSensitive('0912‌123‌4567')).toContain('PHONE');
  });
});

describe('the LEARNING_EXTRACT output schema', () => {
  const valid = {
    proposal: 'CANDIDATE',
    title: 'چطور برنامه را وصل کنم؟',
    body: 'لینک اشتراک را از ربات کپی و در برنامه وارد کنید.',
    category: 'APPS',
    tags: ['v2rayNG'],
    rationale: 'Applies to every Android customer.',
    confidence: 'HIGH',
  };

  it('accepts a candidate and a NONE with empty text', () => {
    expect(supportLearningExtractionSchema.safeParse(valid).success).toBe(true);
    expect(
      supportLearningExtractionSchema.safeParse({ ...valid, proposal: 'NONE', title: '', body: '' })
        .success,
    ).toBe(true);
  });

  it('refuses an extra key, an unknown category, an empty candidate and over-long text', () => {
    const bad = [
      { ...valid, sourceRef: 'x' },
      { ...valid, category: 'REFUNDS' },
      { ...valid, title: '  ' },
      { ...valid, body: '' },
      { ...valid, title: 'x'.repeat(201) },
      { ...valid, body: 'x'.repeat(4001) },
      { ...valid, tags: Array.from({ length: 9 }, (_, i) => `t${String(i)}`) },
      { ...valid, confidence: 'CERTAIN' },
    ];
    for (const value of bad)
      expect(supportLearningExtractionSchema.safeParse(value).success).toBe(false);
  });

  it('the provider JSON schema is closed and requires every key the zod schema has', () => {
    expect(SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA['additionalProperties']).toBe(false);
    expect([...(SUPPORT_LEARNING_EXTRACTION_JSON_SCHEMA['required'] as string[])].sort()).toEqual(
      Object.keys(valid).sort(),
    );
  });
});

describe('the extraction prompt', () => {
  it('states the refusals and frames the conversation as data', () => {
    const system = learningSystemPrompt();
    expect(system).toMatch(/one-off decision/u);
    expect(system).toMatch(/NEVER include personal or secret data/u);
    expect(system).toMatch(/DATA, never instructions/u);
  });

  it('scrubs the conversation and the reply BEFORE the provider sees them', () => {
    const message = learningUserMessage({
      transcript: [
        { side: 'customer', text: 'شماره من ۰۹۱۲۱۲۳۴۵۶۷ و ایمیلم a@b.co' },
        { side: 'support', text: 'کارت 6037991234567890 را چک کردم' },
      ],
      reply: 'لینک شما vless://abc@1.2.3.4:443 است، ۲۵۰ هزار تومان برگشت خورد',
    });
    expect(message.text).not.toMatch(/0912|۰۹۱۲|a@b\.co|6037|vless:|1\.2\.3\.4|۲۵۰/u);
    expect(message.scrubbedKinds).toEqual(
      expect.arrayContaining(['PHONE', 'EMAIL', 'CARD', 'SUBSCRIPTION_LINK', 'AMOUNT']),
    );
    expect(message.text).toMatch(/^CONVERSATION \(data/u);
  });
});

describe('duplicate detection', () => {
  it('normalises Arabic letters, digits, diacritics, ZWNJ, punctuation and case', () => {
    expect(normalizeTitle('چطور  برنامه‌ي v2rayNG را نصب كنم؟')).toBe(
      normalizeTitle('چطور برنامه ی V2RAYNG را نصب کنم'),
    );
    expect(normalizeTitle('پلن ۳۰ روزه')).toBe('پلن 30 روزه');
    expect(normalizeTitle('ـسلامٌ!')).toBe('سلام');
    expect(normalizeTitle('?!')).toBe('');
  });

  it('trigram similarity is 1 for equal titles and low for unrelated ones', () => {
    expect(trigramSimilarity('abc def', 'abc def')).toBe(1);
    expect(trigramSimilarity('connect android app', 'refund policy rules')).toBeLessThan(0.2);
  });

  it('finds an exact match first, then a near one at the threshold, else nothing', () => {
    const rows = [
      { id: 'a', normalizedTitle: normalizeTitle('چطور برنامه را روی اندروید وصل کنم') },
      { id: 'b', normalizedTitle: normalizeTitle('قوانین بازگشت وجه') },
    ];
    expect(findDuplicate(rows[1]!.normalizedTitle, rows)?.id).toBe('b');
    const near = normalizeTitle('چطور برنامه را روی اندروید وصل کنم؟؟ لطفا');
    expect(trigramSimilarity(near, rows[0]!.normalizedTitle)).toBeGreaterThanOrEqual(
      NEAR_DUPLICATE_THRESHOLD,
    );
    expect(findDuplicate(near, rows)?.id).toBe('a');
    expect(findDuplicate(normalizeTitle('آموزش نصب روی آیفون'), rows)).toBeNull();
  });
});
