/**
 * Phase 6B PR-3 (ADR-0039, "The open data export"): the data export's inventory — every table
 * that goes into the ZIP, and for EVERY column of it a decision: exported (with its Persian
 * description, which is the README) or excluded (with the reason).
 *
 * The export is DRIVEN by this file and is an allow-list: it selects exactly the exported
 * columns and nothing else, so a column added to a table tomorrow is never in a file until
 * somebody decides it is. `tests/unit/data-export-inventory.test.ts` fails the build when a
 * column of an exported table is in neither list, and when an exported column looks like a
 * secret (a hash, a token, a key, a credential, a bearer link) without an explicit,
 * reasoned allowance below. The tables are the TENANT class of
 * `tenant-archive-inventory.ts`; the file's own table, `tenant_data_exports`, is NEVER there.
 *
 * Money is printed as it is stored: an integer in minor units, beside its currency column.
 * Never a float, never a bare number — the README says so for every such column.
 *
 * Pure data: no database, no I/O.
 */

import {
  CUSTOMER_STATUSES,
  LEDGER_DIRECTIONS,
  LEDGER_REASONS,
  ORDER_STATES,
  PAYMENT_STATES,
  PRODUCT_AUDIENCES,
  PRODUCT_STATUSES,
  RESELLER_STATUSES,
  SERVICE_STATES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
} from '@nexa/contracts';

/**
 * How a column is read and written:
 * - `text`, `uuid`: a string (a text cell is guarded against spreadsheet formulas);
 * - `integer`: a whole number;
 * - `money_minor`: an integer in minor units (e.g. rials), exact, beside its currency column;
 * - `bytes`: a whole number of bytes;
 * - `timestamp`: an instant, ISO 8601 in UTC (`2026-01-31T09:30:00.000Z`);
 * - `boolean`: `true` or `false`;
 * - `json`: JSON text.
 */
export type ExportColumnKind =
  'text' | 'uuid' | 'integer' | 'money_minor' | 'bytes' | 'timestamp' | 'boolean' | 'json';

export interface ExportColumn {
  readonly name: string;
  readonly kind: ExportColumnKind;
  /** Persian, for the README. */
  readonly description: string;
  /** The values the column takes, when it is an enumeration. */
  readonly values?: readonly string[];
}

export interface ExportDataset {
  /** The CSV's file name inside the ZIP. */
  readonly file: string;
  /** The table it is read from (TENANT class of the tenant archive inventory). */
  readonly table: string;
  /** Persian: the file's title and what a row is. */
  readonly title: string;
  readonly description: string;
  /** In file order. */
  readonly columns: readonly ExportColumn[];
  /** Every other column of the table, with the reason it is not exported. */
  readonly excluded: Readonly<Record<string, string>>;
  /** The ORDER BY, so two exports of the same data are the same bytes. */
  readonly orderBy: readonly string[];
}

const col = (
  name: string,
  kind: ExportColumnKind,
  description: string,
  values?: readonly string[],
): ExportColumn => ({ name, kind, description, ...(values === undefined ? {} : { values }) });

const SOURCE = col(
  'source',
  'text',
  'منبع ورود رکورد (مثلاً ورود از سامانهٔ قبلی)؛ خالی یعنی در همین سامانه ساخته شده.',
);
const SOURCE_REF = col('source_ref', 'text', 'شناسهٔ رکورد در منبع بالا.');
const CREATED_AT = col('created_at', 'timestamp', 'زمان ساخت رکورد (UTC).');
const UPDATED_AT = col('updated_at', 'timestamp', 'زمان آخرین تغییر رکورد (UTC).');

/** A column whose name looks like a secret but is not one: allowed by name, with the reason. */
export const SECRET_LOOKING_ALLOWED: Readonly<Record<string, string>> = {
  'services.location_key': 'a location slug the customer sees (e.g. "de-1"), not a key',
};

/**
 * Names that read as secrets. An EXPORTED column matching one fails the inventory test unless
 * `SECRET_LOOKING_ALLOWED` names it (`table.column`) — a new `api_token` column cannot be
 * "included" by adding it to a list.
 */
export const SECRET_LOOKING = new RegExp(
  [
    'secret',
    'token',
    'passw',
    'hash',
    'cipher',
    'credential',
    'api_?key',
    'private',
    'otp',
    'totp',
    'salt',
    'signature',
    'nonce',
    'cookie',
    'session',
    'webhook',
    'subscription_(url|ref)',
    'client_id',
    '(^|_)key($|_)',
    'resume',
    'backup_code',
    'recovery',
  ].join('|'),
  'i',
);

export const DATA_EXPORT_DATASETS: readonly ExportDataset[] = [
  {
    file: 'customers.csv',
    table: 'customers',
    title: 'مشتریان',
    description: 'هر ردیف یک مشتری ربات است.',
    orderBy: ['id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ یکتای مشتری؛ در فایل‌های دیگر با نام customer_id می‌آید.'),
      col('telegram_user_id', 'text', 'شناسهٔ عددی کاربر در تلگرام.'),
      col('username', 'text', 'نام کاربری تلگرام (بدون @)؛ ممکن است خالی باشد.'),
      col('first_name', 'text', 'نام در تلگرام.'),
      col('last_name', 'text', 'نام خانوادگی در تلگرام.'),
      col('language_code', 'text', 'کد زبان تلگرام مشتری.'),
      col('status', 'text', 'وضعیت مشتری.', CUSTOMER_STATUSES),
      col('first_bot_instance_id', 'uuid', 'شناسهٔ رباتی که مشتری اول بار با آن آمد.'),
      col('first_seen_at', 'timestamp', 'اولین دیدن مشتری (UTC).'),
      col('last_seen_at', 'timestamp', 'آخرین فعالیت مشتری (UTC).'),
      col('blocked_at', 'timestamp', 'زمان مسدود شدن؛ خالی یعنی مسدود نیست.'),
      col('blocked_reason', 'text', 'دلیل مسدودسازی که مدیر نوشته است.'),
      col('marketing_opt_out_at', 'timestamp', 'زمانی که مشتری پیام‌های تبلیغاتی را رد کرد.'),
      col('reminders_opt_out_at', 'timestamp', 'زمانی که مشتری یادآوری‌ها را رد کرد.'),
      col('channel_membership_exempt_at', 'timestamp', 'زمان معافیت از عضویت اجباری در کانال.'),
      col('phone_number', 'text', 'شمارهٔ تلفن مشتری، اگر داده باشد.'),
      col('phone_verified_at', 'timestamp', 'زمان تأیید شمارهٔ تلفن.'),
      col('phone_verification_exempt_at', 'timestamp', 'زمان معافیت از تأیید شمارهٔ تلفن.'),
      col('personal_discount_percent', 'integer', 'درصد تخفیف شخصی مشتری (۰ تا ۱۰۰).'),
      col('personal_discount_set_at', 'timestamp', 'زمان تعیین تخفیف شخصی.'),
      col('legacy_terms_accepted_at', 'timestamp', 'زمان پذیرش قوانین در سامانهٔ قبلی.'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      blocked_reason_shown: 'an internal presentation flag of the bot',
      phone_resume: 'the resume state of an unfinished phone-verification step',
      phone_resume_at: 'the resume state of an unfinished phone-verification step',
      phone_not_accepted_at: 'an internal wizard mark',
    },
  },
  {
    file: 'wallet_ledger.csv',
    table: 'wallet_entries',
    title: 'دفتر کیف پول',
    description:
      'دفتر کیف پول مشتریان؛ فقط افزودنی است و هیچ ردیفی ویرایش نمی‌شود. موجودی هر مشتری از جمع همین ردیف‌ها به‌دست می‌آید (فایل wallet_balances.csv).',
    orderBy: ['created_at', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ ردیف دفتر.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('direction', 'text', 'جهت: CREDIT افزایش موجودی، DEBIT کاهش موجودی.', LEDGER_DIRECTIONS),
      col('reason', 'text', 'دلیل ثبت ردیف.', LEDGER_REASONS),
      col(
        'amount',
        'money_minor',
        'مبلغ ردیف، همیشه مثبت، به کوچک‌ترین واحد پول (مثلاً ریال)، دقیق و بدون اعشار.',
      ),
      col('currency', 'text', 'کد واحد پول مبلغ (مثلاً IRR).'),
      col('reference', 'text', 'مرجع ردیف (برای جلوگیری از ثبت تکراری).'),
      col('reverses_entry_id', 'uuid', 'اگر این ردیف ردیف دیگری را خنثی می‌کند، شناسهٔ آن.'),
      col('order_id', 'uuid', 'سفارش مرتبط، اگر باشد.'),
      col('payment_id', 'uuid', 'پرداخت مرتبط، اگر باشد.'),
      col('actor_admin_id', 'uuid', 'شناسهٔ مدیری که ردیف را ثبت کرده، اگر دستی بوده.'),
      col('note', 'text', 'یادداشت مدیر.'),
      col('note_shown_to_customer', 'boolean', 'آیا یادداشت به مشتری نشان داده شد.'),
      CREATED_AT,
    ],
    excluded: { tenant_id: "the tenant itself: every row of the file is this tenant's" },
  },
  {
    file: 'orders.csv',
    table: 'orders',
    title: 'سفارش‌ها',
    description: 'هر ردیف یک سفارش است، با یک قلم کالا.',
    orderBy: ['created_at', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ سفارش.'),
      col('code', 'text', 'کد سفارش که به مشتری نشان داده می‌شود.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('state', 'text', 'وضعیت سفارش.', ORDER_STATES),
      col('purpose', 'text', 'هدف سفارش (مثلاً خرید یا تمدید).'),
      col('product_id', 'uuid', 'شناسهٔ محصول (products.csv).'),
      col('line_title', 'text', 'عنوان محصول در لحظهٔ سفارش.'),
      col('line_category_id', 'uuid', 'شناسهٔ دستهٔ محصول در لحظهٔ سفارش.'),
      col('line_category_name', 'text', 'نام دستهٔ محصول در لحظهٔ سفارش.'),
      col('line_category_emoji', 'text', 'ایموجی دستهٔ محصول در لحظهٔ سفارش.'),
      col('line_duration_days', 'integer', 'مدت به روز.'),
      col('line_duration_hours', 'integer', 'مدت به ساعت، اگر به ساعت تعریف شده باشد.'),
      col('line_traffic_bytes', 'bytes', 'حجم به بایت.'),
      col('line_device_limit', 'integer', 'حد تعداد دستگاه.'),
      col('line_unit_price_amount', 'money_minor', 'قیمت واحد، به کوچک‌ترین واحد پول، دقیق.'),
      col('line_quantity', 'integer', 'تعداد.'),
      col('subtotal_amount', 'money_minor', 'جمع پیش از تخفیف، به کوچک‌ترین واحد پول، دقیق.'),
      col('discount_amount', 'money_minor', 'مبلغ تخفیف، به کوچک‌ترین واحد پول، دقیق.'),
      col('total_amount', 'money_minor', 'مبلغ نهایی، به کوچک‌ترین واحد پول، دقیق.'),
      col('currency', 'text', 'کد واحد پول همهٔ مبلغ‌های این سفارش.'),
      col('discount_code', 'text', 'کد تخفیفی که مشتری وارد کرد.'),
      col('panel_id', 'uuid', 'شناسهٔ پنل ارائه‌دهنده.'),
      col('origin', 'text', 'منشأ سفارش.'),
      col('source_surface', 'text', 'بخشی که سفارش از آن ثبت شد (ربات، وب‌ادمین، …).'),
      col('expires_at', 'timestamp', 'مهلت پرداخت (UTC).'),
      col('confirmed_at', 'timestamp', 'زمان تأیید (UTC).'),
      col('settled_at', 'timestamp', 'زمان تسویه (UTC).'),
      col('cancelled_at', 'timestamp', 'زمان لغو (UTC).'),
      col('refunded_at', 'timestamp', 'زمان بازپرداخت (UTC).'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      quote: 'the internal pricing snapshot (JSON); the priced lines are exported as columns',
    },
  },
  {
    file: 'services.csv',
    table: 'services',
    title: 'سرویس‌ها',
    description:
      'هر ردیف یک سرویس خریداری‌شده است. پیوند اشتراک و شناسه‌های اتصال هرگز در خروجی نیست.',
    orderBy: ['created_at', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ سرویس.'),
      col('code', 'text', 'کد سرویس که به مشتری نشان داده می‌شود.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('order_id', 'uuid', 'شناسهٔ سفارش (orders.csv).'),
      col('product_id', 'uuid', 'شناسهٔ محصول (products.csv).'),
      col('panel_id', 'uuid', 'شناسهٔ پنل ارائه‌دهنده.'),
      col('state', 'text', 'وضعیت سرویس.', SERVICE_STATES),
      col('state_since', 'timestamp', 'زمان ورود به وضعیت فعلی.'),
      col('expiry_cause', 'text', 'علت پایان، اگر سرویس منقضی شده باشد.'),
      col('provider_username', 'text', 'نام کاربری سرویس در پنل.'),
      col('provider_user_id', 'text', 'شناسهٔ کاربر در پنل، اگر پنل داده باشد.'),
      col('expires_at', 'timestamp', 'زمان پایان سرویس (UTC).'),
      col('traffic_limit_bytes', 'bytes', 'حجم مجاز به بایت.'),
      col('traffic_used_bytes', 'bytes', 'حجم مصرف‌شده به بایت، در آخرین همگام‌سازی.'),
      col('usage_synced_at', 'timestamp', 'زمان آخرین همگام‌سازی مصرف.'),
      col('device_limit', 'integer', 'حد تعداد دستگاه.'),
      col('location_key', 'text', 'شناسهٔ لوکیشن سرویس.'),
      col('location_label', 'text', 'نام لوکیشن سرویس.'),
      col('customer_note', 'text', 'یادداشتی که مشتری برای سرویس نوشته است.'),
      col('is_trial', 'boolean', 'آیا سرویس آزمایشی است.'),
      col('is_test', 'boolean', 'آیا سرویس آزمایشی داخلی مدیر است.'),
      col('provisioned_at', 'timestamp', 'زمان ساخت در پنل (UTC).'),
      col('delivery_state', 'text', 'وضعیت تحویل سرویس به مشتری.'),
      col('delivered_at', 'timestamp', 'زمان تحویل به مشتری (UTC).'),
      col('original_started_at', 'timestamp', 'زمان شروع اصلی (پیش از ورود از سامانهٔ قبلی).'),
      col('missing_on_panel_at', 'timestamp', 'زمانی که سرویس در پنل پیدا نشد.'),
      col('last_seen_at', 'timestamp', 'آخرین زمانی که سرویس در پنل دیده شد.'),
      col('terminated_at', 'timestamp', 'زمان پایان قطعی (UTC).'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      subscription_url: 'a bearer link: whoever holds it uses the service',
      subscription_ref: 'the panel-side subscription reference, a credential of the service',
      provider_client_id: "the panel client id the customer's configuration authenticates with",
      delivery_attempts: 'internal delivery bookkeeping',
      delivery_next_attempt_at: 'internal delivery bookkeeping',
      delivery_send_started_at: 'internal delivery bookkeeping',
      usage_refresh_started_at: 'internal usage-sync bookkeeping',
      last_seen_state: 'internal panel-monitor state',
    },
  },
  {
    file: 'payments.csv',
    table: 'payments',
    title: 'پرداخت‌ها',
    description:
      'هر ردیف یک پرداخت (خرید، شارژ کیف پول یا فیش) است. مبلغ‌ها به کوچک‌ترین واحد پول و دقیق‌اند.',
    orderBy: ['created_at', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ پرداخت.'),
      col('code', 'text', 'کد پرداخت که به مشتری نشان داده می‌شود.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('order_id', 'uuid', 'سفارش مرتبط (orders.csv)، اگر باشد.'),
      col('state', 'text', 'وضعیت پرداخت.', PAYMENT_STATES),
      col('method', 'text', 'روش پرداخت.'),
      col('gateway_provider', 'text', 'درگاه پرداخت، اگر از درگاه بوده باشد.'),
      col('amount', 'money_minor', 'مبلغ پرداخت، به کوچک‌ترین واحد پول، دقیق.'),
      col('currency', 'text', 'کد واحد پول مبلغ‌ها.'),
      col('customer_fee_amount', 'money_minor', 'کارمزدی که مشتری پرداخت کرد، دقیق.'),
      col('customer_fee_basis_points', 'integer', 'نرخ کارمزد به صدم درصد (۱۰۰ = یک درصد).'),
      col('payable_amount', 'money_minor', 'مبلغ قابل پرداخت (مبلغ به‌علاوهٔ کارمزد)، دقیق.'),
      col('topup_cashback_percent', 'integer', 'درصد هدیهٔ شارژ.'),
      col('reference', 'text', 'مرجع داخلی پرداخت.'),
      col('external_reference', 'text', 'مرجع پرداخت نزد درگاه یا بانک.'),
      col('evidence_kind', 'text', 'نوع مدرک پرداخت.'),
      col('evidence_note', 'text', 'توضیح مدرک.'),
      col('customer_signalled_at', 'timestamp', 'زمانی که مشتری گفت پرداخت کرده‌ام.'),
      col('confirmed_at', 'timestamp', 'زمان تأیید پرداخت (UTC).'),
      col('confirmed_by_admin_id', 'uuid', 'مدیری که تأیید کرد، اگر دستی بوده.'),
      col('resolved_at', 'timestamp', 'زمان تعیین تکلیف دستی (UTC).'),
      col('resolved_by_admin_id', 'uuid', 'مدیری که تکلیف را تعیین کرد.'),
      col('resolution_note', 'text', 'توضیح مدیر هنگام تعیین تکلیف.'),
      col('expires_at', 'timestamp', 'مهلت پرداخت (UTC).'),
      col('source_surface', 'text', 'بخشی که پرداخت از آن ثبت شد.'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      checkout_held_until: 'internal checkout-hold bookkeeping',
      provider_review_started_at: 'internal gateway-review bookkeeping',
      provider_review_until: 'internal gateway-review bookkeeping',
    },
  },
  {
    file: 'products.csv',
    table: 'products',
    title: 'محصول‌ها',
    description: 'هر ردیف یک محصول فروشگاه است.',
    orderBy: ['sort_order', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ محصول.'),
      col('code_number', 'integer', 'شمارهٔ کد محصول.'),
      col('title', 'text', 'عنوان محصول.'),
      col('description', 'text', 'توضیح محصول.'),
      col('status', 'text', 'وضعیت محصول.', PRODUCT_STATUSES),
      col('audience', 'text', 'چه کسانی محصول را می‌بینند.', PRODUCT_AUDIENCES),
      col('category_id', 'uuid', 'شناسهٔ دسته (product_categories.csv).'),
      col('sort_order', 'integer', 'ترتیب نمایش.'),
      col('panel_id', 'uuid', 'شناسهٔ پنل ارائه‌دهنده.'),
      col('duration_days', 'integer', 'مدت به روز.'),
      col('traffic_bytes', 'bytes', 'حجم به بایت.'),
      col('device_limit', 'integer', 'حد تعداد دستگاه.'),
      col('price_amount', 'money_minor', 'قیمت، به کوچک‌ترین واحد پول، دقیق.'),
      col('price_currency', 'text', 'کد واحد پول قیمت.'),
      col('display_locations', 'json', 'لوکیشن‌هایی که به مشتری نمایش داده می‌شود (فهرست JSON).'),
      col('display_features', 'json', 'ویژگی‌هایی که به مشتری نمایش داده می‌شود (فهرست JSON).'),
      col('service_location_label', 'text', 'نام لوکیشن سرویس.'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: { tenant_id: "the tenant itself: every row of the file is this tenant's" },
  },
  {
    file: 'product_categories.csv',
    table: 'product_categories',
    title: 'دسته‌های محصول',
    description: 'هر ردیف یک دستهٔ محصول است.',
    orderBy: ['sort_order', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ دسته.'),
      col('name', 'text', 'نام دسته.'),
      col('description', 'text', 'توضیح دسته.'),
      col('emoji', 'text', 'ایموجی دسته.'),
      col('status', 'text', 'وضعیت دسته.'),
      col('visibility', 'text', 'چه کسانی دسته را می‌بینند.'),
      col('sort_order', 'integer', 'ترتیب نمایش.'),
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: { tenant_id: "the tenant itself: every row of the file is this tenant's" },
  },
  {
    file: 'resellers.csv',
    table: 'resellers',
    title: 'نمایندگان',
    description: 'هر ردیف یک مشتری است که نمایندهٔ فروش شده است.',
    orderBy: ['created_at', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ نماینده.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('status', 'text', 'وضعیت نماینده.', RESELLER_STATUSES),
      col('pricing_mode', 'text', 'شیوهٔ قیمت‌گذاری برای نماینده.'),
      col('discount_percentage', 'integer', 'درصد تخفیف نماینده.'),
      col('tier_id', 'uuid', 'شناسهٔ سطح نماینده.'),
      col(
        'credit_limit_amount',
        'money_minor',
        'سقف اعتبار تعریف‌شده، به کوچک‌ترین واحد پول، دقیق.',
      ),
      col('credit_limit_currency', 'text', 'کد واحد پول سقف اعتبار.'),
      col(
        'monthly_minimum_amount',
        'money_minor',
        'حداقل خرید ماهانه، به کوچک‌ترین واحد پول، دقیق.',
      ),
      col('monthly_minimum_currency', 'text', 'کد واحد پول حداقل خرید ماهانه.'),
      col('imported_purchase_cap_minor', 'money_minor', 'سقف خرید واردشده از سامانهٔ قبلی، دقیق.'),
      col('imported_purchase_cap_currency', 'text', 'کد واحد پول سقف بالا.'),
      col('expires_at', 'timestamp', 'پایان نمایندگی (UTC).'),
      col('expiry_suspended_at', 'timestamp', 'زمان تعلیق به‌علت پایان نمایندگی (UTC).'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      source_detail: 'internal import provenance (JSON)',
    },
  },
  {
    file: 'tickets.csv',
    table: 'tickets',
    title: 'تیکت‌ها',
    description: 'هر ردیف یک تیکت پشتیبانی است؛ پیام‌ها در ticket_messages.csv هستند.',
    orderBy: ['number', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ تیکت.'),
      col('number', 'integer', 'شمارهٔ تیکت که به مشتری نشان داده می‌شود.'),
      col('code', 'text', 'کد تیکت.'),
      col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
      col('category_id', 'uuid', 'شناسهٔ دسته (ticket_categories.csv).'),
      col('category_title', 'text', 'عنوان دسته در لحظهٔ ساخت.'),
      col('subject', 'text', 'موضوع تیکت.'),
      col('status', 'text', 'وضعیت تیکت.', TICKET_STATUSES),
      col('priority', 'text', 'اولویت.', TICKET_PRIORITIES),
      col('assigned_admin_id', 'uuid', 'مدیری که تیکت به او سپرده شده.'),
      col('service_id', 'uuid', 'سرویس مرتبط (services.csv).'),
      col('order_id', 'uuid', 'سفارش مرتبط (orders.csv).'),
      col('payment_id', 'uuid', 'پرداخت مرتبط (payments.csv).'),
      col('origin', 'text', 'منشأ تیکت.'),
      col('source_surface', 'text', 'بخشی که تیکت از آن ساخته شد.'),
      col('last_message_at', 'timestamp', 'زمان آخرین پیام (UTC).'),
      col('closed_at', 'timestamp', 'زمان بسته شدن (UTC).'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      bot_instance_id: 'the bot the ticket arrived on: an internal id of this server',
      opening_key: 'an idempotency key of the ticket-opening command',
    },
  },
  {
    file: 'ticket_messages.csv',
    table: 'ticket_messages',
    title: 'پیام‌های تیکت',
    description:
      'هر ردیف یک پیام از یک تیکت است. خود فایل‌های پیوست در خروجی نیست؛ فقط نام، نوع و اندازهٔ آن‌ها.',
    orderBy: ['ticket_id', 'seq'],
    columns: [
      col('id', 'uuid', 'شناسهٔ پیام.'),
      col('ticket_id', 'uuid', 'شناسهٔ تیکت (tickets.csv).'),
      col('seq', 'integer', 'شمارهٔ ترتیب پیام در تیکت.'),
      col('sender_type', 'text', 'فرستنده: مشتری، پشتیبان یا سیستم.'),
      col('author_admin_id', 'uuid', 'مدیری که پیام را نوشته، اگر از پشتیبانی بوده.'),
      col('body', 'text', 'متن پیام.'),
      col('system_event', 'text', 'اگر پیام رویدادی سیستمی است، نوع آن.'),
      col('attachment_kind', 'text', 'نوع پیوست، اگر داشته باشد.'),
      col('attachment_mime_type', 'text', 'نوع MIME پیوست.'),
      col('attachment_file_name', 'text', 'نام فایل پیوست.'),
      col('attachment_file_size', 'bytes', 'اندازهٔ پیوست به بایت.'),
      SOURCE,
      SOURCE_REF,
      CREATED_AT,
    ],
    excluded: {
      tenant_id: "the tenant itself: every row of the file is this tenant's",
      attachment_bot_instance_id:
        'the bot that can fetch the attachment: an internal id of this server',
      attachment_file_id: 'a Telegram file id: a fetch handle bound to this bot, not data',
      attachment_file_unique_id: 'a Telegram file id: a fetch handle bound to this bot, not data',
      idempotency_key: 'an idempotency key of the message command',
      request_hash: 'an internal request fingerprint',
    },
  },
  {
    file: 'ticket_categories.csv',
    table: 'ticket_categories',
    title: 'دسته‌های تیکت',
    description: 'هر ردیف یک دستهٔ تیکت است.',
    orderBy: ['sort_order', 'id'],
    columns: [
      col('id', 'uuid', 'شناسهٔ دسته.'),
      col('title', 'text', 'عنوان دسته.'),
      col('sort_order', 'integer', 'ترتیب نمایش.'),
      col('is_active', 'boolean', 'آیا دسته فعال است.'),
      CREATED_AT,
      UPDATED_AT,
    ],
    excluded: { tenant_id: "the tenant itself: every row of the file is this tenant's" },
  },
];

/**
 * `wallet_balances.csv`: not a table but a total — each customer's balance per currency,
 * summed from the ledger (`wallet_entries`), because the balance is never stored. Read by one
 * fixed statement over the ledger table, so it is no new source of data.
 */
export const WALLET_BALANCES_DATASET = {
  file: 'wallet_balances.csv',
  title: 'موجودی کیف پول',
  description:
    'موجودی هر مشتری به تفکیک واحد پول؛ از جمع دفتر کیف پول (wallet_ledger.csv) به‌دست آمده: جمع ردیف‌های CREDIT منهای جمع ردیف‌های DEBIT. موجودی جداگانه‌ای ذخیره نشده است.',
  columns: [
    col('customer_id', 'uuid', 'شناسهٔ مشتری (customers.csv).'),
    col('currency', 'text', 'کد واحد پول.'),
    col('balance_minor', 'money_minor', 'موجودی، به کوچک‌ترین واحد پول، دقیق؛ می‌تواند منفی باشد.'),
    col('entries', 'integer', 'تعداد ردیف‌های دفتر که در این جمع آمده است.'),
    col('last_entry_at', 'timestamp', 'زمان آخرین ردیف دفتر این مشتری و واحد پول (UTC).'),
  ],
} as const;

/** Every file of the ZIP, in order: the datasets, then the derived balances. */
export const DATA_EXPORT_FILES: readonly string[] = [
  ...DATA_EXPORT_DATASETS.map((dataset) => dataset.file),
  WALLET_BALANCES_DATASET.file,
];

/** The tables the export reads: the datasets' tables (the balances read the ledger's). */
export const DATA_EXPORT_TABLES: readonly string[] = DATA_EXPORT_DATASETS.map(
  (dataset) => dataset.table,
);
