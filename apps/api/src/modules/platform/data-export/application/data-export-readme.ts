import {
  DATA_EXPORT_DATASETS,
  WALLET_BALANCES_DATASET,
  type ExportColumn,
  type ExportColumnKind,
} from './data-export-inventory.js';

/**
 * `README.fa.md`: the description of every file and column of one export, written from the
 * SAME inventory the export reads, so the README can never name a column the files lack nor
 * miss one they hold. Persian, plain Markdown. Pure: the counts and the date come in.
 */

const KIND_LABEL: Readonly<Record<ExportColumnKind, string>> = {
  text: 'متن',
  uuid: 'شناسه (UUID)',
  integer: 'عدد صحیح',
  money_minor: 'مبلغ (عدد صحیح، کوچک‌ترین واحد پول)',
  bytes: 'عدد صحیح (بایت)',
  timestamp: 'زمان (ISO 8601، UTC)',
  boolean: 'true یا false',
  json: 'JSON',
};

/** A cell of a Markdown table: no pipe, no line break. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll(/\r?\n/gu, ' ');
}

function columnTable(columns: readonly ExportColumn[]): string[] {
  const lines = ['| ستون | نوع | توضیح |', '| --- | --- | --- |'];
  for (const column of columns) {
    const values =
      column.values === undefined
        ? ''
        : ` مقدارها: ${column.values.map((value) => `\`${value}\``).join('، ')}.`;
    lines.push(
      `| \`${column.name}\` | ${KIND_LABEL[column.kind]} | ${cell(column.description + values)} |`,
    );
  }
  return lines;
}

export interface DataExportReadmeInput {
  readonly tenantDisplayName: string;
  readonly tenantSlug: string;
  /** ISO 8601, UTC. */
  readonly generatedAt: string;
  /** Rows written per file name. */
  readonly rows: Readonly<Record<string, number>>;
}

export function buildDataExportReadme(input: DataExportReadmeInput): string {
  const lines: string[] = [
    '# خروجی داده',
    '',
    `ربات: ${input.tenantDisplayName} (\`${input.tenantSlug}\`)`,
    '',
    `زمان تهیهٔ این خروجی: \`${input.generatedAt}\` (UTC)`,
    '',
    'این فایل ZIP نسخهٔ ساده و بازِ داده‌های ربات شماست؛ هر فایل یک جدول CSV است که هر نرم‌افزار صفحه‌گسترده یا پایگاه داده می‌تواند بخواند.',
    '',
    '## قواعد کلی',
    '',
    '- کدگذاری همهٔ فایل‌ها UTF-8 همراه با BOM است تا اکسل فارسی را درست نشان دهد.',
    '- جداکنندهٔ ستون‌ها ویرگول (`,`) و پایان هر ردیف `CRLF` است؛ مقدار دارای ویرگول، نقل‌قول یا خط جدید داخل `"` می‌آید.',
    '- سطر اول هر فایل نام ستون‌هاست. نام ستون‌ها انگلیسی و ثابت است و در همین فایل توضیح داده شده.',
    '- خانهٔ خالی یعنی مقداری ثبت نشده است.',
    '- زمان‌ها به‌صورت ISO 8601 و به وقت UTC هستند (مثلاً `2026-01-31T09:30:00.000Z`).',
    '- مبلغ‌ها همیشه عدد صحیح به کوچک‌ترین واحد پول‌اند (مثلاً ریال) و دقیقاً همان‌اند که ذخیره شده؛ هرگز اعشاری نیستند. واحد پول در ستون `currency` (یا ستون‌های `…_currency`) کنار مبلغ می‌آید.',
    '- شناسه‌ها (UUID) در همهٔ فایل‌ها یکی‌اند؛ مثلاً `customer_id` در سفارش‌ها همان `id` در `customers.csv` است.',
    "- اگر متنی (مثلاً نام یک مشتری در تلگرام) با `=` یا `+` یا `-` یا `@` شروع شود، برای اینکه صفحه‌گسترده آن را فرمول اجرا نکند، یک `'` در ابتدای آن گذاشته شده است.",
    '',
    '## چه چیزی در این خروجی نیست',
    '',
    'رمزها، کلیدها، توکن‌ها، اعتبارنامه‌های پنل و درگاه، هش رمز مدیران، عامل‌های دوم ورود، نشست‌های ورود، پیوند اشتراک و شناسه‌های اتصال سرویس‌ها، و کلیدها و مهرهای فنی داخلی هرگز در این خروجی نیستند. فایل‌های پیوست تیکت‌ها هم در خروجی نیست؛ فقط نام و نوع و اندازهٔ آن‌ها آمده است.',
    '',
    '## فایل‌ها',
    '',
  ];
  const wallet = WALLET_BALANCES_DATASET;
  const count = (file: string): string => String(input.rows[file] ?? 0);
  for (const dataset of DATA_EXPORT_DATASETS) {
    lines.push(
      `### ${dataset.file} — ${dataset.title}`,
      '',
      `${dataset.description} تعداد ردیف‌ها: ${count(dataset.file)}.`,
      '',
      ...columnTable(dataset.columns),
      '',
    );
  }
  lines.push(
    `### ${wallet.file} — ${wallet.title}`,
    '',
    `${wallet.description} تعداد ردیف‌ها: ${count(wallet.file)}.`,
    '',
    ...columnTable(wallet.columns),
    '',
  );
  return `${lines.join('\n')}\n`;
}
