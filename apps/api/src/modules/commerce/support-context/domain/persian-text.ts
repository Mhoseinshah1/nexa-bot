/**
 * Phase 4 PR-2 — the ONE Persian text normaliser, and the retrieval vocabulary built on it.
 *
 * Knowledge retrieval (`knowledge-relevance.ts`) and the learning dedupe
 * (`support-knowledge/domain/dedupe.ts`) used to fold Persian each its own way: retrieval knew
 * nothing of «ۀ» and «ؤ», the dedupe turned a ZWNJ into a space where retrieval removed it, so
 * the same words met in one and missed in the other. Both now read `normalizePersian`.
 *
 * Pure: no I/O, no clock.
 */

/**
 * Text as it is compared: NFKC (full-width and presentation forms), lower case (Latin), the
 * Arabic letters customers' keyboards produce folded to their Persian forms (ي/ى → ی, ك → ک,
 * ة/ۀ → ه, أ/إ/آ/ٱ → ا, ؤ → و, ئ → ی), diacritics and tatweel removed, ZWNJ and every other
 * zero-width character removed (so «نمی‌شه» and «نمیشه» are one word), and Persian and
 * Arabic-Indic digits as ASCII.
 */
export function normalizePersian(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064A\u0649\u0626]/gu, '\u06CC')
    .replace(/\u0643/gu, '\u06A9')
    .replace(/[\u0629\u06C0]/gu, '\u0647')
    .replace(/[\u0622\u0623\u0625\u0671]/gu, '\u0627')
    .replace(/\u0624/gu, '\u0648')
    .replace(/[\u064B-\u065F\u0670\u0640]/gu, '')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/gu, '')
    .replace(/[\u06F0-\u06F9]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * Words whose ending LOOKS like an inflection but is part of the word: never stemmed. Without
 * this «کارت» (card) lost its «ت» and became «کار» (work), so «کار نمی‌کنه» («it doesn't work»)
 * matched the card-payment article.
 */
export const PROTECTED_WORDS: ReadonlySet<string> = new Set(
  [
    'کارت',
    'مدت',
    'دست',
    'پست',
    'ساعت',
    'سرعت',
    'قیمت',
    'پرداخت',
    'اینترنت',
    'اکانت',
    'لیست',
    'دوست',
    'کیفیت',
    'وضعیت',
    'ظرفیت',
    'محدودیت',
    'امنیت',
    'فعالیت',
    'اولویت',
    'هویت',
    'پیام',
    'تمام',
    'انجام',
    'سیستم',
    'گزارش',
    'نمایش',
    'آرامش',
    'گوشی',
    'ایرانسل',
    'همراه',
    'تست',
    'ثبت',
    'نصب',
  ].map(normalizePersian),
);

/**
 * Finglish (Persian typed in Latin letters) → Persian, for the words support questions are made
 * of. A query's Latin words are looked up here and the Persian word is ADDED to the query (the
 * Latin word stays: an article may be written either way). A dictionary, not a letter-by-letter
 * transliteration: Finglish spelling is free, and a guessed word matches the wrong article.
 */
export const FINGLISH: Readonly<Record<string, string>> = {
  vasl: 'وصل',
  vasle: 'وصل',
  nemishe: 'نمیشه',
  nemishavad: 'نمیشود',
  mishe: 'میشه',
  ghat: 'قطع',
  qat: 'قطع',
  ghate: 'قطعه',
  qate: 'قطعه',
  ghatee: 'قطعه',
  kar: 'کار',
  nemikone: 'نمیکنه',
  kharab: 'خراب',
  internet: 'اینترنت',
  sorat: 'سرعت',
  soraat: 'سرعت',
  kond: 'کند',
  kande: 'کنده',
  ping: 'پینگ',
  link: 'لینک',
  linkam: 'لینکم',
  linkamo: 'لینکم',
  sub: 'ساب',
  config: 'کانفیگ',
  confing: 'کانفیگ',
  tamdid: 'تمدید',
  kharid: 'خرید',
  bekharam: 'بخرم',
  gheymat: 'قیمت',
  gheimat: 'قیمت',
  qeymat: 'قیمت',
  ghimat: 'قیمت',
  chande: 'چنده',
  pardakht: 'پرداخت',
  kart: 'کارت',
  hajm: 'حجم',
  traffic: 'ترافیک',
  gig: 'گیگ',
  test: 'تست',
  rayegan: 'رایگان',
  location: 'لوکیشن',
  lokeyshen: 'لوکیشن',
  keshvar: 'کشور',
  server: 'سرور',
  app: 'برنامه',
  barname: 'برنامه',
  barnameh: 'برنامه',
  nasb: 'نصب',
  android: 'اندروید',
  iphone: 'آیفون',
  ayfon: 'آیفون',
  ios: 'آیفون',
  windows: 'ویندوز',
  vindoz: 'ویندوز',
  mac: 'مک',
  emza: 'امضا',
  hesab: 'حساب',
  etebar: 'اعتبار',
  tamom: 'تموم',
  tamoom: 'تموم',
  shod: 'شد',
  khata: 'خطا',
  error: 'خطا',
  update: 'آپدیت',
  apdeit: 'آپدیت',
  sakht: 'ساخت',
  karbar: 'کاربر',
  dastgah: 'دستگاه',
  roz: 'روز',
  rooz: 'روز',
  mah: 'ماه',
  mahe: 'ماهه',
  ettesal: 'اتصال',
  etesal: 'اتصال',
};

/**
 * The VPN support vocabulary: each group is words a customer and an article use for the same
 * thing. A query word in a group brings the group's other words into the query. A PHRASE entry
 * (it has a space) is matched against the whole normalised query text — «وصل نمیشه», «کار
 * نمیکنه» — and brings the group's single words.
 */
export const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['آیفون', 'ایفون', 'ios', 'iphone', 'اپل', 'آی او اس'],
  ['اندروید', 'android'],
  ['ویندوز', 'windows'],
  ['مک', 'macos', 'مکینتاش'],
  ['لینوکس', 'linux'],
  ['کانفیگ', 'لینک', 'ساب', 'اشتراک', 'سابسکریپشن', 'config', 'subscription'],
  [
    'اتصال',
    'وصل',
    'قطع',
    'قطعه',
    'وصل نمیشه',
    'وصل نمیشود',
    'کار نمیکنه',
    'کار نمیکند',
    'وصل نیست',
    'قطع شده',
  ],
  ['سرعت', 'کند', 'کنده', 'پینگ', 'لگ', 'افت سرعت'],
  ['تمدید', 'تمدیدش', 'renew'],
  ['خرید', 'بخرم', 'خریدن', 'سفارش'],
  ['قیمت', 'چنده', 'هزینه', 'تعرفه', 'چقدره'],
  ['پرداخت', 'کارت به کارت', 'واریز'],
  ['حجم', 'ترافیک', 'گیگ'],
  ['لوکیشن', 'موقعیت', 'کشور'],
  ['برنامه', 'اپ', 'اپلیکیشن', 'نرم افزار', 'app'],
  ['تست', 'آزمایشی', 'رایگان'],
].map((group) => group.map(normalizePersian));

/**
 * A query's text with its Finglish words' Persian forms and its synonyms ADDED (the original
 * words stay first). Used for the QUERY only: an article is matched as written, plus its tags.
 */
export function expandQueryText(text: string): string {
  const normal = normalizePersian(text);
  const words = normal.split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
  const added: string[] = [];
  for (const word of words) {
    const persian = FINGLISH[word];
    if (persian !== undefined) added.push(persian);
  }
  const vocabulary = new Set([...words, ...added.map(normalizePersian)]);
  const haystack = ` ${[normal, ...added].join(' ')} `;
  for (const group of SYNONYM_GROUPS) {
    const hit = group.some((entry) =>
      entry.includes(' ') ? haystack.includes(` ${entry} `) : vocabulary.has(entry),
    );
    if (hit) added.push(...group.filter((entry) => !entry.includes(' ')));
  }
  return added.length === 0 ? text : `${text} ${added.join(' ')}`;
}

/**
 * Phase 4 PR-2 — the Persian tags a BUILT article gets by its source (and, for an app or a
 * guide, its platform): words customers use that the article's own text may not, so retrieval
 * finds it. At most eight, each within the tag bound.
 */
export function builtArticleTags(sourceType: string, platform: string | null = null): string[] {
  const bySource: Readonly<Record<string, readonly string[]>> = {
    PRODUCT: ['خرید', 'قیمت', 'پلن', 'سرویس'],
    LOCATIONS: ['لوکیشن', 'موقعیت', 'کشور', 'سرور'],
    CLIENT_APP: ['برنامه', 'نصب', 'اتصال'],
    TUTORIAL: ['اتصال', 'وصل', 'آموزش', 'راهنما'],
    FAQ: ['پرسش متداول'],
    TERMS: ['قوانین', 'شرایط'],
    SUPPORT_ACCOUNTS: ['پشتیبانی', 'پشتیبان', 'تماس'],
    PAYMENT_METHOD: ['پرداخت', 'کارت به کارت', 'واریز'],
  };
  const byPlatform: Readonly<Record<string, readonly string[]>> = {
    ANDROID: ['اندروید', 'android'],
    IOS: ['آیفون', 'ios', 'iphone'],
    WINDOWS: ['ویندوز', 'windows'],
    MACOS: ['مک', 'macos'],
    LINUX: ['لینوکس', 'linux'],
  };
  const tags = [
    ...(platform === null ? [] : (byPlatform[platform] ?? [])),
    ...(bySource[sourceType] ?? []),
  ];
  return [...new Set(tags)].slice(0, 8);
}
