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
});

/*
 * Substitute review of PR #203, finding 1: shapes that passed unredacted. Each names the rule
 * that catches it; `scripts/mutate-tb8.py` TB8-32..TB8-40 revert those rules one at a time.
 */
describe('scrubber: the shapes the substitute review found passing (PR #203, finding 1)', () => {
  const cases: readonly (readonly [string, string, SupportLearningSensitiveKind])[] = [
    // Separator RUNS between digit groups.
    ['a card with double spaces', 'کارت 6037  9975  1234  5678 است', 'CARD'],
    ['a card with spaced en dashes', 'کارت 6037 – 9975 – 1234 – 5678', 'CARD'],
    ['a card with em dashes in Persian digits', 'کارت ۶۰۳۷—۹۹۷۵—۱۲۳۴—۵۶۷۸', 'CARD'],
    ['a card with dots and spaces', '6037 . 9975 . 1234 . 5678', 'CARD'],
    ['a mobile with double spaces', 'شماره 0912  123  4567', 'PHONE'],
    ['a mobile with spaced en dashes', 'شماره ۰۹۱۲ – ۱۲۳ – ۴۵۶۷', 'PHONE'],
    ['a Telegram id with double spaces', 'آیدی ۷۰۰  ۰۰۰  ۱۲۳۴', 'LONG_NUMBER'],
    // Any URL: a short or unlisted token, or just a server's name.
    ['a URL with a short unlisted parameter', 'https://x/getSub?id=abc123', 'URL_TOKEN'],
    ['a URL with a one-letter parameter', 'https://panel.x.io/s?t=abcdef', 'URL_TOKEN'],
    ['a URL with a short token segment', 'https://bot.x/link/AbC12', 'URL_TOKEN'],
    ['a URL with a digit in a segment', 'https://bot.example.org/c/k9', 'URL_TOKEN'],
    [
      'a store link with a query (fail closed)',
      'https://play.google.com/store/apps/details?id=com.v2ray.ang',
      'URL_TOKEN',
    ],
    ['a websocket URL with a query', 'wss://cdn.example.net/ws?ed=2048', 'URL_TOKEN'],
    ['a plain URL still names a server', 'سایت https://example.com/ را باز کنید', 'HOST'],
    ['a ws:// URL', 'ws://de1.example.com:8080/path', 'HOST'],
    // A server by name, and a subscription path, without a scheme.
    ['a scheme-less subscription path', 'panel.example.com/sub/abcdef', 'SUBSCRIPTION_LINK'],
    [
      'a scheme-less subscription path on an IP',
      '185.12.34.56:2096/sub/abcdef',
      'SUBSCRIPTION_LINK',
    ],
    ['a server by name', 'server: de1.example.com port 443', 'HOST'],
    ['a server with a port', 'به de1.example.com:443 وصل شوید', 'HOST'],
    ['a scheme-less path', 'cdn.example.ir/config/user', 'HOST'],
    // Secrets in prose.
    ['a password in prose', 'your password is hunter2', 'SECRET'],
    ['a new password in prose', 'new password: hunter2', 'SECRET'],
    ['a Persian password in prose', 'رمزتون abc123 هست', 'SECRET'],
    ['a Persian password with a colon-free phrase', 'رمز عبور جدید Qw12345 است', 'SECRET'],
    ['a Persian «کلمه عبور»', 'کلمه عبور شما xyz789 است', 'SECRET'],
    ['a code', 'کد 4821 را وارد کنید', 'SECRET'],
    ['a token in prose', 'the token is abcd-1234', 'SECRET'],
    // A Telegram profile link names a person.
    ['a t.me profile link', 'به t.me/ali_reza پیام بدهید', 'USERNAME'],
    ['a t.me profile link with a scheme', 'https://t.me/ali_reza', 'USERNAME'],
    // Amounts: a decimal separator, a k, and words.
    ['an amount with the Arabic decimal separator', 'مبلغ ۲۵۰٫۰۰۰ تومان', 'AMOUNT'],
    ['an amount with the Arabic thousands separator', 'مبلغ ۲۵۰٬۰۰۰ تومان', 'AMOUNT'],
    ['an amount in k', 'ماهی 150k', 'AMOUNT'],
    ['an amount in k in Persian digits', 'قیمت ۱۵۰K', 'AMOUNT'],
    ['an amount in millions', 'حدود ۲ میلیون', 'AMOUNT'],
    ['an amount in Persian words', 'صد و پنجاه هزار تومان', 'AMOUNT'],
    ['an amount in Persian words, colloquial', 'دویست تومن', 'AMOUNT'],
    ['an amount in English words', 'fifty dollars', 'AMOUNT'],
  ];
  for (const [label, text, kind] of cases) {
    it(`${label} → ${kind}`, () => {
      const result = scrubSensitive(text);
      expect(result.kinds).toContain(kind);
      expect(result.text).toContain(`[REDACTED:${kind}]`);
    });
  }

  it('no digit of a separated card or phone survives', () => {
    const text = scrubSensitive('کارت 6037 – 9975 – 1234 – 5678 و 0912  123  4567').text;
    expect(text).not.toMatch(/6037|9975|5678|0912|4567/u);
  });

  it('no host, token or secret survives in the scrubbed text', () => {
    const text = scrubSensitive(
      'server: de1.example.com port 443, https://x/getSub?id=abc123, رمزتون abc123 هست, t.me/ali_reza',
    ).text;
    expect(text).not.toMatch(/example|getSub|abc123|ali_reza/u);
  });

  it('negative controls: plain Persian help text stays clean', () => {
    const general = [
      'اگر رمز عبور را فراموش کردید، از منوی تنظیمات آن را تغییر دهید.',
      'کد تخفیف را در مرحله پرداخت وارد کنید.',
      'کدام سرور سریع‌تر است؟',
      'برای دریافت لینک اشتراک روی «سرویس‌های من» بزنید.',
      'پلن یک‌ماهه برای دو کاربر است.',
      'قیمت‌ها به تومان است.',
      'برنامه را ببندید و دوباره باز کنید؛ اگر باز هم وصل نشد، یک بار گوشی را ری‌استارت کنید.',
      'در iOS از برنامه Streisand و در اندروید از v2rayNG استفاده کنید.',
      'پرداخت شده است و سرویس فعال می‌شود.',
      'Open the app, tap + and choose "Import from clipboard".',
    ];
    for (const text of general) expect(detectSensitive(text), text).toEqual([]);
  });
});

describe('scrubber: what it replaces and what it leaves', () => {
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
