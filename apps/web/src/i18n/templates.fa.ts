import type { PlaceholderType, TemplateKey } from '@nexa/contracts';

/**
 * The Persian names and descriptions of the bot's message templates — Web Admin chrome.
 *
 * The contract catalogue (`packages/contracts/src/templates.ts`) describes each key in
 * English, for the people who write code against it. An operator editing a message needs
 * something else: what the message is called, where the bot sends it, and what each
 * `{token}` in it stands for. That is presentation, so it lives here, beside the rest of
 * the web catalogue, and the frozen contract is not touched to hold it.
 *
 * Nothing here is customer-facing and nothing here is rendered into a message: the
 * DEFAULT BODIES are in `@nexa/i18n` and a tenant's own wording is in its override. This
 * file only explains those bodies to the person editing them. It never renames a token —
 * a placeholder is still `{amount}` in every body; `مبلغ` is only the helper beside it.
 *
 * Every entry is OPTIONAL at the type level, deliberately. A package that adds a template
 * key without a Persian name here still builds and the screen still works: the key falls
 * back to its catalogue description (`template-copy.ts`). What stops that fallback from
 * becoming permanent is `tests/unit/template-copy.test.ts`, which names every catalogue
 * key and every token with no Persian entry, so the package that added one is the one
 * that fails.
 *
 * Checked by `scripts/check-i18n-keys.mjs` as a catalogue file: it is one of the two web
 * files allowed to contain Persian.
 */

/** `[name, description]`: what the operator calls the message, and where the bot uses it. */
export type TemplateCopyEntry = readonly [name: string, description: string];

/** A section of the template screen, and the key prefixes that belong to it. */
export interface TemplateGroupDefinition {
  readonly id: string;
  readonly label: string;
  /**
   * Key prefixes, matched by the LONGEST prefix across every group, so the order of the
   * list decides only the order on screen, never which group a key lands in.
   */
  readonly prefixes: readonly string[];
}

/** The sections, in the order the screen shows them. */
export const TEMPLATE_GROUPS_FA: readonly TemplateGroupDefinition[] = [
  {
    id: 'start',
    label: 'شروع، منوی اصلی و دستورها',
    prefixes: ['bot.start.', 'bot.menu.', 'bot.command.', 'bot.help'],
  },
  {
    id: 'general',
    label: 'پیام‌های عمومی، خطا و مسدودی',
    prefixes: [
      'bot.ping.',
      'error.',
      'bot.unknown_command',
      'bot.request_unavailable',
      'bot.blocked',
    ],
  },
  { id: 'channels', label: 'عضویت اجباری در کانال', prefixes: ['bot.channels.'] },
  { id: 'catalog', label: 'فروشگاه، سفارش و پیش‌فاکتور', prefixes: ['bot.catalog.', 'bot.order.'] },
  { id: 'username', label: 'انتخاب یوزرنیم سرویس', prefixes: ['bot.username.'] },
  { id: 'discount', label: 'کد تخفیف', prefixes: ['bot.discount.'] },
  { id: 'trial', label: 'سرویس آزمایشی', prefixes: ['bot.trial.'] },
  { id: 'custom_service', label: 'سرویس دلخواه', prefixes: ['bot.custom_service.'] },
  { id: 'wallet', label: 'کیف پول و شارژ', prefixes: ['bot.wallet.'] },
  {
    id: 'payment',
    label: 'پرداخت کارت‌به‌کارت و رسید',
    prefixes: ['bot.payment.', 'bot.refund.'],
  },
  {
    id: 'gateway',
    label: 'درگاه آنلاین و تلگرام استارز',
    prefixes: [
      'bot.payment.gateway_',
      'bot.payment.stars_',
      'bot.payment.route_name_',
      'bot.payment.checkout_in_progress',
    ],
  },
  { id: 'services', label: 'سرویس‌های من', prefixes: ['bot.service.'] },
  {
    id: 'delivery',
    label: 'تحویل سرویس و آموزش اتصال',
    prefixes: [
      'bot.service.delivered',
      'bot.service.tutorial_button',
      'bot.service.connected_',
      'bot.service.problem_button',
      'bot.tutorial.',
    ],
  },
  { id: 'apps', label: 'دانلود برنامه و آموزش اتصال', prefixes: ['bot.apps.'] },
  {
    id: 'reminders',
    label: 'یادآورهای خودکار: انقضا، حجم، موجودی و پرداخت',
    prefixes: [
      'bot.service.expiry_',
      'bot.service.expired',
      'bot.service.usage_',
      // WP-A9: the other automated reminders, beside the ones they are configured with.
      'bot.wallet.low_balance',
      'bot.payment.pending_reminder',
      'bot.order.pending_reminder',
      // Round N, package D: the reseller monthly minimum.
      'bot.reseller.minimum_',
    ],
  },
  { id: 'transfer', label: 'انتقال سرویس', prefixes: ['bot.service.transfer_'] },
  {
    id: 'extra_devices',
    label: 'افزایش تعداد کاربر / دستگاه',
    prefixes: ['bot.service.add_devices_button', 'bot.service.devices_'],
  },
  {
    id: 'location_change',
    label: 'تغییر لوکیشن سرویس',
    prefixes: ['bot.service.change_location_button', 'bot.service.location_'],
  },
  {
    id: 'refund_request',
    label: 'درخواست بازگشت وجه (مشتری)',
    prefixes: ['bot.service.refund_request_'],
  },
  { id: 'referral', label: 'معرفی دوستان و هدیهٔ عضویت', prefixes: ['bot.referral.'] },
  { id: 'support', label: 'پشتیبانی و پرسش‌های متداول', prefixes: ['bot.faq.', 'bot.support.'] },
  { id: 'tickets', label: 'تیکت‌های پشتیبانی (مشتری)', prefixes: ['bot.ticket.'] },
  // Round N: the wrapper every broadcast is sent in.
  { id: 'broadcast', label: 'ارسال همگانی', prefixes: ['bot.broadcast.'] },
  {
    id: 'admin',
    label: 'مدیریت در تلگرام — عمومی',
    prefixes: ['bot.menu.admin', 'bot.admin.'],
  },
  {
    id: 'admin_receipts',
    label: 'مدیریت در تلگرام — بررسی رسیدها',
    prefixes: [
      'bot.admin.receipt',
      'bot.admin.operation_',
      'bot.admin.approve',
      'bot.admin.reject',
      'bot.admin.credit',
      'bot.admin.block',
    ],
  },
  {
    id: 'admin_services',
    label: 'مدیریت در تلگرام — سرویس‌ها',
    prefixes: ['bot.admin.service'],
  },
  {
    id: 'admin_reminders',
    label: 'مدیریت در تلگرام — تنظیم یادآورها',
    prefixes: ['bot.admin.reminder'],
  },
  {
    id: 'admin_panels',
    label: 'مدیریت در تلگرام — پنل‌ها و یوزرنیم',
    prefixes: ['bot.admin.panel_', 'bot.admin.panels_', 'bot.admin.username_'],
  },
  {
    id: 'admin_customers',
    label: 'مدیریت در تلگرام — مشتری‌ها',
    prefixes: ['bot.admin.customer'],
  },
  {
    id: 'admin_catalog',
    label: 'مدیریت در تلگرام — دسته‌بندی‌ها',
    prefixes: ['bot.admin.categor', 'bot.admin.product_'],
  },
  {
    id: 'admin_admins',
    label: 'مدیریت در تلگرام — ادمین‌ها',
    prefixes: [
      'bot.admin.section',
      'bot.admin.admin',
      'bot.admin.revoke',
      'bot.admin.linked',
      'bot.admin.roles_set',
      'bot.admin.usage',
      'bot.admin.refused',
    ],
  },
  {
    id: 'admin_refund_requests',
    label: 'مدیریت در تلگرام — درخواست‌های بازگشت وجه',
    prefixes: ['bot.admin.refund_request_'],
  },
  {
    id: 'ops',
    label: 'اعلان‌های گروه عملیات',
    prefixes: ['ops.notification.'],
  },
  {
    id: 'ops_financial',
    label: 'گزارش‌های مالی گروه لاگ',
    prefixes: ['ops.financial.'],
  },
  // WP-A4: what Nexa itself says in the operations log group it manages.
  {
    id: 'ops_group',
    label: 'گروه گزارش‌های مدیریتی — اتصال و تاپیک‌ها',
    prefixes: ['ops.group.'],
  },
  {
    id: 'ops_support',
    label: 'اعلان تیکت‌ها به پشتیبانی',
    prefixes: ['ops.support.'],
  },
];

/** Where a key no group claims is shown. Nothing registered today lands here. */
export const TEMPLATE_OTHER_GROUP_FA: TemplateGroupDefinition = {
  id: 'other',
  label: 'سایر متن‌ها',
  prefixes: [],
};

/** What each placeholder TYPE means to somebody typing a sample value. */
export const PLACEHOLDER_TYPE_LABELS_FA: Readonly<Record<PlaceholderType, string>> = {
  STRING: 'متن',
  NUMBER: 'عدد',
  MONEY: 'مبلغ با واحد پول',
  DATETIME: 'تاریخ و زمان',
  DURATION_DAYS: 'مدت به روز (صفر یعنی نامحدود)',
  BYTES: 'حجم',
  TRAFFIC_LIMIT: 'سقف حجم (صفر یعنی نامحدود)',
};

/**
 * One Persian label per distinct placeholder TOKEN.
 *
 * Keyed by the token exactly as the catalogue declares it, and the token is never
 * translated: the label is the helper shown beside `{token}`, not a replacement for it.
 * Where one token means different things in different messages, the general meaning is
 * here and the specific one is in `PLACEHOLDER_LABEL_OVERRIDES_FA` below.
 */
export const PLACEHOLDER_LABELS_FA: Readonly<Record<string, string>> = {
  achievedSales: 'فروش نماینده در این ماه',
  addedTrafficBytes: 'حجم افزوده‌شده',
  adminId: 'شناسهٔ مدیر تصمیم‌گیرنده',
  amount: 'مبلغ',
  answer: 'پاسخ',
  app: 'نام برنامه (با نماد، اگر تعیین شده باشد)',
  at: 'زمان',
  automatic: 'نشانهٔ روشن بودن انتخاب خودکار',
  availableAt: 'زمان مجاز بعدی',
  balance: 'موجودی کیف پول',
  botInstanceId: 'شناسهٔ ربات',
  bytes: 'مقدار حجم',
  cap: 'سقف ظرفیت پنل',
  caption: 'توضیح فایل',
  cashback: 'مبلغ کش‌بک',
  cashbackLine: 'خط کش‌بک',
  category: 'نام دسته',
  cause: 'علت',
  channel: 'مقصد بازگشت وجه',
  checkedAt: 'زمان آخرین بررسی',
  code: 'کد',
  commissionPercent: 'درصد پورسانت',
  commissionScope: 'اینکه پورسانت فقط برای اولین خرید است یا همهٔ خریدها',
  commissionReceivedTotal: 'مجموع پورسانت دریافتی',
  content: 'محتوای این بخش',
  conversation: 'آخرین پیام‌های گفتگو',
  cooldownHours: 'فاصلهٔ مجاز (ساعت)',
  correlationId: 'شناسهٔ پیگیری',
  count: 'تعداد',
  creditedAmount: 'مبلغ واریزشده به کیف پول',
  current: 'مقدار فعلی',
  currentLimit: 'تعداد کاربر / دستگاه مجاز فعلی',
  currentLocation: 'لوکیشن فعلی سرویس',
  custom: 'نشانهٔ روشن بودن انتخاب دلخواه',
  customBlock: 'بخش سرویس دلخواه',
  customTemplate: 'نشانهٔ انتخاب الگوی سفارشی',
  customer: 'مشتری (شناسهٔ تلگرام)',
  customerGroup: 'گروه کاربری',
  days: 'روزهای باقی‌مانده',
  delivery: 'وضعیت تحویل لینک',
  description: 'توضیح کوتاه برنامه',
  destination: 'اطلاعات حساب مقصد',
  details: 'جزئیات رخداد',
  devicesBlock: 'بخش افزایش کاربر / دستگاه',
  discount: 'مبلغ تخفیف',
  discountLine: 'خط تخفیف',
  displayName: 'نام نمایشی',
  durationDays: 'مدت (روز)',
  emoji: 'ایموجی',
  evidence: 'مبنای تأیید',
  expired: 'وضعیت اعلان پایان اعتبار',
  expiresAt: 'زمان انقضا',
  expiry: 'وضعیت یادآور انقضا',
  failed: 'تعداد فرمت‌های ناموفق',
  failure: 'نوع خطا',
  featuresBlock: 'بخش ویژگی‌ها',
  fee: 'کارمزد',
  finalPercent: 'آستانهٔ پایانی مصرف (درصد)',
  firstDays: 'یادآور اول انقضا (روز)',
  firstPercent: 'آستانهٔ اول مصرف (درصد)',
  firstSeen: 'زمان نخستین تماس',
  firstSeenAt: 'زمان نخستین رخداد',
  fromLocation: 'لوکیشن مبدأ',
  gift: 'مبلغ هدیه',
  giftBlock: 'بخش هدیهٔ عضویت',
  guide: 'متن آموزش اتصال برنامه',
  hours: 'مدت به ساعت',
  health: 'وضعیت سلامت',
  history: 'تعداد عملیات ثبت‌شده',
  id: 'شناسه',
  label: 'نام نمایشی',
  lastSeen: 'آخرین فعالیت',
  lastSeenAt: 'زمان این رخداد',
  limit: 'سقف تعداد',
  lines: 'فهرست خط‌به‌خط',
  location: 'لوکیشن',
  locationChangeBlock: 'بخش تغییر لوکیشن',
  locationsBlock: 'بخش لوکیشن‌ها',
  max: 'حداکثر تعداد نویسه',
  maxBytes: 'حداکثر حجم فایل',
  maximum: 'حداکثر مبلغ',
  message: 'متن رخداد',
  method: 'روش پرداخت',
  min: 'حداقل تعداد نویسه',
  minimum: 'حداقل مبلغ',
  minimumOrder: 'حداقل مبلغ خریدی که پورسانت دارد',
  minutes: 'مهلت (دقیقه)',
  name: 'نام',
  noExpiry: 'خط بدون تاریخ انقضا',
  note: 'یادداشت',
  notice: 'اطلاعیهٔ کارت سرویس',
  number: 'شماره',
  occurrences: 'تعداد تکرار',
  olderLine: 'خط پیام‌های قدیمی‌تر',
  operation: 'نوع عملیات',
  order: 'سفارش',
  orderId: 'شناسهٔ سفارش',
  outcome: 'نتیجه',
  page: 'شمارهٔ صفحه',
  pages: 'تعداد صفحه‌ها',
  paidInvoiceCount: 'تعداد پرداخت‌های موفق',
  panel: 'نام پنل',
  payable: 'مبلغ قابل پرداخت',
  paymentId: 'شناسهٔ پرداخت',
  percent: 'درصد',
  phoneState: 'وضعیت شمارهٔ تلفن',
  prefix: 'پیشوند',
  prefixRandom: 'نشانهٔ انتخاب پیشوند + تصادفی',
  preview: 'نمونهٔ یوزرنیم',
  price: 'قیمت',
  pricePerDay: 'قیمت هر روز',
  pricePerGb: 'قیمت هر گیگابایت',
  principal: 'مبلغ اصلی',
  product: 'محصول',
  productName: 'نام محصول',
  productTitle: 'عنوان محصول',
  products: 'تعداد محصولات',
  quantity: 'تعداد',
  provider: 'نوع پنل',
  providerFinalAmount: 'مبلغ نهایی گزارش‌شده توسط درگاه',
  providerInvoiceId: 'شناسهٔ فاکتور درگاه',
  query: 'عبارت جست‌وجو',
  question: 'پرسش',
  random: 'نشانهٔ انتخاب تصادفی',
  reason: 'دلیل',
  recipientId: 'شناسهٔ تلگرام گیرنده',
  recipientName: 'نام گیرنده',
  reference: 'کد پیگیری پرداخت',
  referralCode: 'کد معرف',
  referralCount: 'تعداد زیرمجموعه‌ها',
  referralLink: 'لینک دعوت',
  referredCount: 'تعداد دعوت‌شدگان',
  referredPercent: 'سهم دعوت‌شونده (درصد)',
  referredPurchaseCount: 'تعداد خریدهای زیرمجموعه‌ها',
  referredPurchaseTotal: 'مجموع خرید زیرمجموعه‌ها',
  referrerPercent: 'سهم معرف (درصد)',
  refundAmount: 'مبلغ بازگشتی',
  refundId: 'شناسهٔ بازگشت وجه',
  registeredAt: 'زمان عضویت',
  remaining: 'مبلغ قابل بازگشت باقی‌مانده',
  remainingPercent: 'درصد حجم باقی‌مانده',
  remainingSales: 'مبلغ باقی‌مانده تا حداقل فروش',
  remainingDays: 'روزهای باقی‌مانده',
  remainingTraffic: 'حجم باقی‌مانده',
  requestId: 'شناسهٔ درخواست',
  requestedAt: 'زمان ثبت درخواست',
  requestedBy: 'درخواست‌کننده',
  reservations: 'تعداد رزروها',
  roles: 'نقش‌ها',
  rotateHint: 'راهنمای تغییر لینک',
  route: 'درگاه',
  secondDays: 'یادآور دوم انقضا (روز)',
  secondPercent: 'آستانهٔ دوم مصرف (درصد)',
  seconds: 'زمان انتظار (ثانیه)',
  service: 'نام سرویس',
  serviceCount: 'تعداد سرویس‌ها',
  serviceId: 'شناسهٔ سرویس',
  serviceLocation: 'موقعیت سرویس',
  serviceUsername: 'نام کاربری سرویس',
  services: 'تعداد سرویس‌ها',
  setting: 'کلید تنظیم',
  severity: 'شدت',
  shortfall: 'مبلغ کمبود',
  shown: 'تعداد نمایش‌داده‌شده',
  stars: 'تعداد استارز',
  state: 'وضعیت سرویس',
  status: 'وضعیت',
  subscriptionUrl: 'لینک اشتراک',
  subtotal: 'قیمت پیش از تخفیف',
  syncedAt: 'زمان آخرین همگام‌سازی',
  targetLimit: 'تعداد مجاز پس از افزایش',
  telegram: 'اتصال تلگرام',
  telegramId: 'شناسهٔ عددی تلگرام',
  telegramIdRandom: 'نشانهٔ انتخاب شناسهٔ تلگرام + تصادفی',
  template: 'الگو',
  tenantId: 'شناسهٔ مستأجر',
  text: 'متن پیام',
  threshold: 'مبلغ آستانه',
  timePrice: 'قیمت زمان',
  toLocation: 'لوکیشن مقصد',
  title: 'عنوان',
  topic: 'نام تاپیک',
  total: 'مبلغ کل',
  traffic: 'حجم',
  totalTraffic: 'کل حجم',
  totalTrafficBytes: 'کل حجم',
  trafficBytes: 'حجم',
  trafficLimit: 'سقف حجم',
  unitPrice: 'قیمت هر واحد',
  usage: 'وضعیت یادآور مصرف',
  usagePercent: 'درصد مصرف',
  usedTraffic: 'حجم مصرف‌شده',
  usedTrafficBytes: 'حجم مصرف‌شده',
  username: 'نام کاربری تلگرام',
  usernameAutomatic: 'نشانهٔ روشن بودن یوزرنیم خودکار',
  usernameCustom: 'نشانهٔ روشن بودن یوزرنیم دلخواه',
  usernamePrefix: 'پیشوند یوزرنیم',
  usernameTemplate: 'الگوی یوزرنیم',
  value: 'مقدار',
  visibility: 'نمایش به مشتری',
  volumeBytes: 'حجم',
  volumePrice: 'قیمت حجم',
  walletAfter: 'موجودی کیف پول پس از واریز',
  walletBalance: 'موجودی کیف پول',
  walletBefore: 'موجودی کیف پول پیش از واریز',
};

/**
 * The same token, meaning something narrower in one message.
 *
 * `{username}` is a customer's Telegram handle in the financial log, a service's account
 * name in an order summary and an administrator's sign-in name in the admin roster; one
 * label for all three would be wrong in two of them.
 */
export const PLACEHOLDER_LABEL_OVERRIDES_FA: Partial<
  Record<TemplateKey, Readonly<Record<string, string>>>
> = {
  'ops.notification.operational_event': { code: 'کد رخداد' },
  'bot.channels.join_private_button': { number: 'شمارهٔ کانال در فهرست' },
  'bot.order.summary': { username: 'نام کاربری سرویس' },
  'bot.order.summary_discounted': { username: 'نام کاربری سرویس' },
  'bot.order.summary_cashback': { username: 'نام کاربری سرویس' },
  'bot.order.summary_discounted_cashback': { username: 'نام کاربری سرویس' },
  'bot.admin.receipt': { name: 'نام مشتری', order: 'محصول سفارش' },
  'bot.admin.review_final': {
    name: 'نام مشتری',
    order: 'محصول سفارش',
    total: 'مبلغ پرداخت',
    outcome: 'نتیجهٔ بررسی (یکی از چهار متن نتیجه)',
  },
  'bot.admin.service': { username: 'نام کاربری سرویس روی پنل' },
  'bot.admin.reminder_saved': { value: 'مقدار تازه' },
  'bot.admin.panel_detail': { name: 'نام پنل', status: 'وضعیت پنل' },
  'bot.admin.customer_detail': {
    name: 'نام مشتری',
    status: 'وضعیت مشتری',
    reason: 'دلیل مسدودی',
    lastSeen: 'زمان آخرین تماس',
  },
  'bot.admin.customer_status_changed': { status: 'وضعیت مشتری' },
  'bot.admin.category_detail': { name: 'نام دسته', status: 'وضعیت دسته' },
  'bot.admin.category_delete_ask': { name: 'نام دسته' },
  'bot.admin.category_deleted': { name: 'نام دسته' },
  'bot.admin.section': { total: 'تعداد کل ادمین‌ها' },
  'bot.admin.admin_detail': { username: 'نام کاربری ادمین', status: 'وضعیت ادمین' },
  'bot.admin.admin_status_changed': { username: 'نام کاربری ادمین', status: 'وضعیت ادمین' },
  'bot.admin.linked': { username: 'نام کاربری ادمین' },
  'bot.admin.revoked': { username: 'نام کاربری ادمین' },
  'bot.admin.roles_set': { username: 'نام کاربری ادمین' },
  'bot.admin.refund_request_card': { reason: 'دلیل مشتری' },
  'bot.discount.applied': { code: 'کد تخفیف' },
  'bot.faq.item': { number: 'شمارهٔ پرسش' },
  'bot.order.preinvoice_locations': { lines: 'فهرست لوکیشن‌ها' },
  'bot.order.preinvoice_features': { lines: 'فهرست ویژگی‌ها' },
  'bot.service.addon_option': { title: 'نام بسته' },
  'bot.service.devices_choice': {
    remaining: 'تعداد کاربر قابل افزودن',
    unitPrice: 'قیمت هر کاربر اضافه',
  },
  'bot.service.devices_option': { quantity: 'تعداد کاربر', price: 'قیمت این تعداد' },
  'bot.order.preinvoice_devices': { unitPrice: 'قیمت هر کاربر اضافه' },
  'bot.service.renew_option_button': { title: 'نام محصول' },
  // R2: the renewal result names the renewed account, not the customer's Telegram username.
  'bot.service.renewed': { username: 'نام کاربری سرویس' },
  // Round N, package D: the minimum is a monthly SALES minimum, and the days run to month end.
  'bot.reseller.minimum_reminder': {
    minimum: 'حداقل فروش ماهانه',
    days: 'روزهای باقی‌مانده تا پایان ماه',
  },
  'bot.reseller.minimum_achieved': { minimum: 'حداقل فروش ماهانه' },
  'bot.service.list': { total: 'تعداد کل سرویس‌ها' },
  'bot.service.list_item_button': { username: 'نام کاربری سرویس' },
  'bot.service.card': { lastSeen: 'آخرین اتصال', status: 'وضعیت سرویس' },
  'bot.service.remaining_value': { percent: 'درصد باقی‌مانده' },
  'bot.wallet.topup_method_button': { name: 'نام روش پرداخت' },
  'bot.wallet.topup_method_gift_button': { name: 'نام روش پرداخت', percent: 'درصد هدیهٔ شارژ' },
  'bot.referral.gift_block': { total: 'مجموع هدیه' },
  'bot.service.location_option': { location: 'لوکیشن مقصد', price: 'قیمت انتقال' },
  'bot.service.location_option_free': { location: 'لوکیشن مقصد' },
  'bot.ticket.list_item_button': {
    status: 'وضعیت تیکت',
    number: 'شمارهٔ تیکت',
    category: 'موضوع تیکت',
  },
  'bot.ticket.view': { status: 'وضعیت تیکت', number: 'شمارهٔ تیکت', category: 'موضوع تیکت' },
  'bot.ticket.view_older': { count: 'تعداد پیام‌های قدیمی‌تر' },
  'bot.ticket.open_limit': { max: 'حداکثر تیکت باز' },
  'bot.ticket.category_button': { title: 'نام دسته' },
  'bot.ticket.message_prompt': { category: 'موضوع تیکت' },
  'bot.ticket.support_replied': { text: 'متن پاسخ پشتیبانی', category: 'موضوع تیکت' },
  'bot.ticket.support_attachment': { number: 'شمارهٔ تیکت', category: 'موضوع تیکت' },
  'ops.support.ticket_opened': { number: 'شمارهٔ تیکت', category: 'موضوع تیکت' },
  'ops.support.customer_replied': { number: 'شمارهٔ تیکت', category: 'موضوع تیکت' },
  // Round N: the broadcast wrapper and the two mass-action notices.
  'bot.broadcast.message': { message: 'متن پیام همگانی' },
  'bot.wallet.mass_credited': { amount: 'مبلغ شارژ همگانی' },
  'bot.service.gift_applied': {
    service: 'نام کاربری سرویس',
    traffic: 'حجم هدیه',
    days: 'زمان هدیه',
  },
};

/**
 * Every registered template, by key: its Persian name and where it is used.
 *
 * Grouped to match `TEMPLATE_GROUPS_FA`. The name is what the screen titles the card
 * with and what a search matches; the description is one sentence an operator can act
 * on. Neither is ever sent to anybody.
 */
export const TEMPLATE_COPY_FA: Partial<Record<TemplateKey, TemplateCopyEntry>> = {
  // --- Start, main menu and commands ------------------------------------------------
  'bot.start.welcome': [
    'خوش‌آمد به مشتری تازه',
    'نخستین پیامی که مشتری پس از اولین شروع ربات می‌بیند.',
  ],
  'bot.start.welcome_back': [
    'خوش‌آمد به مشتری قدیمی',
    'پیام شروع برای مشتری‌ای که پیش‌تر از ربات استفاده کرده است.',
  ],
  'bot.command.start': [
    'توضیح دستور /start در فهرست دستورها',
    'متن کوتاهی که تلگرام کنار دستور /start در فهرست دستورهای ربات نشان می‌دهد.',
  ],
  'bot.command.catalog': [
    'توضیح دستور /catalog در فهرست دستورها',
    'متن کوتاه کنار دستور /catalog (خرید سرویس) در فهرست دستورهای تلگرام.',
  ],
  'bot.command.services': [
    'توضیح دستور /services در فهرست دستورها',
    'متن کوتاه کنار دستور /services (سرویس‌های من) در فهرست دستورهای تلگرام.',
  ],
  'bot.command.wallet': [
    'توضیح دستور /wallet در فهرست دستورها',
    'متن کوتاه کنار دستور /wallet (کیف پول) در فهرست دستورهای تلگرام.',
  ],
  'bot.command.help': [
    'توضیح دستور /help در فهرست دستورها',
    'متن کوتاه کنار دستور /help (پشتیبانی و راهنما) در فهرست دستورهای تلگرام.',
  ],
  'bot.command.paysupport': [
    'توضیح دستور /paysupport در فهرست دستورها',
    'متن کوتاه کنار دستور /paysupport برای پشتیبانی پرداخت؛ تلگرام آن را از ربات‌هایی که با استارز می‌فروشند می‌خواهد.',
  ],
  'bot.command.tickets': [
    'توضیح دستور /tickets در فهرست دستورها',
    'متن کوتاه کنار دستور /tickets (تیکت‌های پشتیبانی) در فهرست دستورهای تلگرام.',
  ],
  'bot.menu.tickets': [
    'دکمهٔ تیکت‌ها در منوی اصلی',
    'دکمهٔ منوی اصلی که فهرست تیکت‌های پشتیبانی مشتری را باز می‌کند؛ همان کار دستور /tickets.',
  ],
  'bot.menu.catalog': [
    'دکمهٔ خرید در منوی اصلی',
    'دکمهٔ منوی اصلی که فهرست سرویس‌های قابل خرید را باز می‌کند؛ همان کار دستور /catalog.',
  ],
  'bot.menu.services': [
    'دکمهٔ سرویس‌های من در منوی اصلی',
    'دکمهٔ منوی اصلی که سرویس‌های مشتری را نشان می‌دهد؛ همان کار دستور /services.',
  ],
  'bot.menu.wallet': [
    'دکمهٔ کیف پول در منوی اصلی',
    'دکمهٔ منوی اصلی که کیف پول و موجودی مشتری را نشان می‌دهد؛ همان کار دستور /wallet.',
  ],
  'bot.menu.help': [
    'دکمهٔ پشتیبانی در منوی اصلی',
    'دکمهٔ منوی اصلی که بخش پشتیبانی و راهنما را باز می‌کند؛ همان کار دستور /help.',
  ],
  'bot.menu.trial': [
    'دکمهٔ سرویس تست در منوی اصلی',
    'دکمهٔ منوی اصلی برای دریافت سرویس تست رایگان؛ فقط وقتی دست‌کم یک پنل سرویس تست ارائه می‌کند نمایش داده می‌شود.',
  ],
  'bot.menu.referral': [
    'دکمهٔ زیرمجموعه‌گیری در منوی اصلی',
    'دکمهٔ منوی اصلی که پیام دعوت و آمار زیرمجموعه‌گیری مشتری را نشان می‌دهد؛ فقط وقتی قابلیت معرفی دوستان روشن است نمایش داده می‌شود.',
  ],
  'bot.command.apps': [
    'توضیح دستور /apps در فهرست دستورها',
    'متن کوتاه کنار دستور /apps (دانلود برنامه و آموزش اتصال) در فهرست دستورهای تلگرام.',
  ],
  'bot.menu.apps': [
    'دکمهٔ دانلود برنامه در منوی اصلی',
    'دکمهٔ منوی اصلی که انتخاب سیستم‌عامل و برنامه‌های پیشنهادی را باز می‌کند؛ همان کار دستور /apps.',
  ],
  'bot.menu.main_button': [
    'دکمهٔ بازگشت به منوی اصلی',
    'دکمه‌ای که از هر صفحهٔ مشتری به منوی اصلی برمی‌گرداند.',
  ],
  'bot.help': [
    'راهنمای دستورها (/help)',
    'فهرست کارهایی که ربات انجام می‌دهد، در پاسخ به دستور /help.',
  ],

  // --- General, errors and blocking -------------------------------------------------
  'bot.ping.reply': [
    'پاسخ دستور /ping',
    'پاسخ ربات به دستور /ping برای بررسی فعال بودن آن؛ شناسهٔ پیگیری درخواست را نشان می‌دهد.',
  ],
  'bot.unknown_command': [
    'پاسخ به دستور ناشناخته',
    'وقتی مشتری دستوری می‌فرستد که ربات آن را نمی‌شناسد.',
  ],
  'error.internal': [
    'پیام خطای عمومی',
    'پیام کلی خطا که هنگام بروز مشکل داخلی به مشتری نشان داده می‌شود.',
  ],
  'error.permission_denied': [
    'پیام نداشتن دسترسی',
    'وقتی کاربر اجازهٔ انجام کاری را که خواسته ندارد.',
  ],
  'bot.request_unavailable': [
    'درخواست در حال حاضر ممکن نیست',
    'پاسخ کلی وقتی درخواست انجام نمی‌شود و دلیلش برای مشتری قابل اقدام نیست؛ می‌گوید مبلغی کسر نشده است.',
  ],
  'bot.blocked': [
    'پیام حساب مسدود',
    'به مشتری مسدودشده نشان داده می‌شود؛ فقط می‌گوید حساب قابل استفاده نیست و دلیلی نمی‌آورد.',
  ],
  'bot.blocked_spam': [
    'پیام مسدودی به دلیل اسپم',
    'به مشتری‌ای که سامانهٔ ضداسپم به دلیل پیام‌های سریع و پیاپی مسدودش کرده نشان داده می‌شود.',
  ],
  'bot.blocked_with_reason': [
    'پیام حساب مسدود همراه با دلیل',
    'به مشتری مسدودی که مدیر برای مسدودی‌اش دلیل نوشته نشان داده می‌شود؛ دلیل و راه تماس با پشتیبانی را می‌گوید.',
  ],

  // --- Required channel membership --------------------------------------------------
  'bot.channels.join_required': [
    'درخواست عضویت در کانال‌های اجباری',
    'به جای پاسخ درخواست مشتری نشان داده می‌شود وقتی در کانالی که عضویتش اجباری است عضو نیست؛ دکمه‌های عضویت و بررسی زیر آن می‌آیند.',
  ],
  'bot.channels.still_missing': [
    'عضویت هنوز تأیید نشده',
    'پاسخ دکمهٔ بررسی عضویت وقتی مشتری هنوز در همهٔ کانال‌های اجباری عضو نشده است.',
  ],
  'bot.channels.check_button': [
    'دکمهٔ بررسی عضویت',
    'دکمه‌ای که مشتری پس از عضویت در کانال‌ها می‌زند تا عضویتش بررسی شود.',
  ],
  'bot.channels.join_private_button': [
    'دکمهٔ عضویت در کانال خصوصی',
    'دکمهٔ عضویت برای کانال اجباری بدون آیدی عمومی که با لینک دعوت باز می‌شود؛ با شمارهٔ کانال در فهرست.',
  ],

  // --- Catalogue, order and pre-invoice ---------------------------------------------
  'bot.catalog.empty': ['فروشگاه خالی', 'وقتی هیچ محصول قابل فروشی تنظیم نشده است.'],
  'bot.catalog.heading': [
    'عنوان فهرست محصولات یک دسته',
    'بالای فهرست محصولات داخل یک دسته نمایش داده می‌شود.',
  ],
  'bot.catalog.categories_heading': [
    'عنوان فهرست دسته‌ها',
    'بالای فهرست دسته‌بندی‌ها، در نخستین مرحلهٔ خرید.',
  ],
  'bot.catalog.category_empty': [
    'دستهٔ بدون محصول',
    'وقتی دسته‌ای که مشتری انتخاب کرده دیگر محصولی برای فروش ندارد.',
  ],
  'bot.catalog.next_page_button': [
    'دکمهٔ صفحهٔ بعد فروشگاه',
    'دکمهٔ رفتن به صفحهٔ بعد در فهرست محصولات یا دسته‌ها.',
  ],
  'bot.catalog.previous_page_button': [
    'دکمهٔ صفحهٔ قبل فروشگاه',
    'دکمهٔ بازگشت به صفحهٔ قبل در فهرست محصولات یا دسته‌ها.',
  ],
  'bot.catalog.back_to_categories_button': [
    'دکمهٔ بازگشت به دسته‌ها',
    'از فهرست محصولات یک دسته به فهرست دسته‌ها برمی‌گرداند.',
  ],
  'bot.order.summary': [
    'خلاصهٔ سفارش',
    'خلاصه‌ای که مشتری پیش از ثبت سفارش تأیید می‌کند؛ همهٔ ارقام را سرور محاسبه می‌کند.',
  ],
  'bot.order.summary_discounted': [
    'خلاصهٔ سفارش با تخفیف',
    'خلاصهٔ سفارش وقتی تخفیف اعمال شده است؛ قیمت پیش از تخفیف و مبلغ تخفیف را هم نشان می‌دهد.',
  ],
  'bot.order.summary_cashback': [
    'خلاصهٔ سفارش با کش‌بک',
    'خلاصهٔ سفارش وقتی کش‌بک وعده داده شده و تخفیفی نیست؛ کش‌بک پس از تحویل سرویس واریز می‌شود.',
  ],
  'bot.order.summary_discounted_cashback': [
    'خلاصهٔ سفارش با تخفیف و کش‌بک',
    'خلاصهٔ سفارش وقتی هم تخفیف اعمال شده و هم کش‌بک وعده داده شده است.',
  ],
  'bot.order.awaiting_payment': [
    'سفارش در انتظار پرداخت',
    'تأیید می‌کند سفارش ثبت شده و منتظر پرداخت است؛ مبلغ و مهلت پرداخت را می‌گوید.',
  ],
  'bot.order.confirm_button': [
    'دکمهٔ تأیید و ثبت سفارش',
    'دکمه‌ای که مشتری برای تأیید خلاصهٔ سفارش می‌زند.',
  ],
  'bot.order.unavailable': [
    'محصول قابل خرید نیست',
    'وقتی محصولی قابل سفارش نیست؛ برداشته شده، قیمت ندارد یا به پنلی وصل نیست.',
  ],
  'bot.order.terms_changed': [
    'قیمت نمایندگی تغییر کرده',
    'هنگام تأیید سفارش، وقتی قیمت نماینده بین نمایش خلاصه و تأیید تغییر کرده است؛ مبلغی کسر نشده.',
  ],
  'bot.order.expired': [
    'مهلت سفارش تمام شده',
    'وقتی مشتری پس از پایان مهلت سفارش آن را تأیید یا پرداخت می‌کند.',
  ],
  'bot.order.not_awaiting_payment': [
    'سفارش دیگر منتظر پرداخت نیست',
    'وقتی مشتری دکمهٔ پرداخت سفارشی را می‌زند که دیگر در انتظار پرداخت نیست؛ معمولاً همان سفارشی که پرداخت کرده است.',
  ],
  'bot.order.settled': [
    'تأیید پرداخت سفارش',
    'اعلام می‌کند پرداخت پذیرفته شد و سفارش پرداخت‌شده است؛ دربارهٔ ساخت سرویس چیزی نمی‌گوید.',
  ],
  'bot.order.cancelled': ['سفارش لغو شد', 'تأیید لغو سفارش پرداخت‌نشده توسط خود مشتری.'],
  'bot.order.refunded_to_wallet': [
    'بازگشت مبلغ سفارش به کیف پول',
    'وقتی پول سفارش رسیده ولی سرویس ساخته نشد؛ مبلغ به کیف پول برگشته و مشتری می‌تواند دوباره خرید کند.',
  ],
  'bot.order.cancel_button': [
    'دکمهٔ لغو سفارش',
    'دکمه‌ای که مشتری برای لغو سفارش پرداخت‌نشده می‌زند.',
  ],
  'bot.order.cancel_confirm': [
    'پرسش تأیید لغو سفارش',
    'پرسشی که پیش از لغو سفارش نشان داده می‌شود.',
  ],
  'bot.order.cancel_confirm_button': [
    'دکمهٔ تأیید لغو سفارش',
    'تنها دکمه‌ای که سفارش را واقعاً لغو می‌کند.',
  ],
  'bot.order.transfer_under_review': [
    'لغو سفارش با واریز در حال بررسی',
    'وقتی مشتری می‌خواهد سفارشی را لغو کند که گفته مبلغش را واریز کرده؛ تا پایان بررسی لغو ممکن نیست.',
  ],
  'bot.order.preinvoice': [
    'پیش‌فاکتور خرید',
    'پیش‌فاکتوری که مشتری از روی آن پرداخت می‌کند: نام کاربری، محصول، مدت، حجم، مبلغ و موجودی کیف پول.',
  ],
  'bot.order.preinvoice_devices': [
    'بخش افزایش کاربر / دستگاه در پیش‌فاکتور',
    'تعداد خریده‌شده، قیمت هر کاربر و تعداد مجاز پیش و پس از افزایش؛ فقط برای خرید کاربر اضافه.',
  ],
  'bot.order.preinvoice_custom': [
    'بخش سرویس دلخواه در پیش‌فاکتور',
    'لوکیشن، حجم و مدتی که مشتری وارد کرده، با قیمت واحد و قیمت هر کدام؛ فقط برای سرویس دلخواه.',
  ],
  'bot.order.preinvoice_locations': [
    'بخش لوکیشن‌ها در پیش‌فاکتور',
    'عنوان و فهرست لوکیشن‌های محصول، هر کدام در یک خط؛ فقط وقتی محصول لوکیشن دارد.',
  ],
  'bot.order.preinvoice_features': [
    'بخش ویژگی‌ها در پیش‌فاکتور',
    'فهرست ویژگی‌های محصول، هر کدام در یک خط؛ فقط وقتی محصول ویژگی دارد.',
  ],
  'bot.order.preinvoice_discount_line': [
    'خط تخفیف در پیش‌فاکتور',
    'مبلغ تخفیف و قیمت پیش از تخفیف؛ فقط وقتی تخفیفی اعمال شده است.',
  ],
  'bot.order.preinvoice_cashback_line': [
    'خط کش‌بک در پیش‌فاکتور',
    'کش‌بکی که پس از تحویل سرویس واریز می‌شود؛ فقط وقتی کش‌بک وعده داده شده است.',
  ],
  'bot.order.preinvoice_location_change': [
    'بخش تغییر لوکیشن در پیش‌فاکتور',
    'لوکیشن مبدأ و مقصد و اینکه مشخصات اتصال ممکن است عوض شود؛ از روی درخواست ثبت‌شده خوانده می‌شود، نه تنظیمات امروز.',
  ],

  // --- Service username -------------------------------------------------------------
  'bot.username.choose': [
    'پرسش روش انتخاب یوزرنیم',
    'وقتی پنل هر دو روش را مجاز می‌داند، از مشتری می‌پرسد یوزرنیم را خودش بنویسد یا خودکار ساخته شود.',
  ],
  'bot.username.custom_button': [
    'دکمهٔ یوزرنیم دلخواه',
    'دکمه‌ای که مرحلهٔ نوشتن یوزرنیم دلخواه را شروع می‌کند.',
  ],
  'bot.username.automatic_button': [
    'دکمهٔ یوزرنیم خودکار',
    'دکمه‌ای که یوزرنیم سرویس را خودکار می‌سازد.',
  ],
  'bot.username.instructions': [
    'قوانین یوزرنیم دلخواه',
    'پیش از نوشتن یوزرنیم، همهٔ شرایط آن (طول، نویسه‌های مجاز و …) را به مشتری می‌گوید.',
  ],
  'bot.username.invalid': [
    'یوزرنیم نامعتبر',
    'وقتی یوزرنیم فرستاده‌شده با شرایط اعلام‌شده جور نیست.',
  ],
  'bot.username.taken': [
    'یوزرنیم تکراری',
    'وقتی یوزرنیم قبلاً روی همان سرور گرفته شده است؛ می‌گوید مبلغی کسر نشده.',
  ],
  'bot.username.exhausted': [
    'ناتوانی موقت در ساخت یوزرنیم خودکار',
    'وقتی همهٔ یوزرنیم‌های خودکار ساخته‌شده تکراری بودند؛ از مشتری می‌خواهد کمی بعد دوباره تلاش کند.',
  ],
  'bot.username.unavailable': [
    'یوزرنیم خودکار برای این خرید ممکن نیست',
    'وقتی تنظیمات خودکار پنل برای این خرید نمی‌تواند یوزرنیم بسازد؛ مشتری را به یوزرنیم دلخواه راهنمایی می‌کند.',
  ],
  'bot.username.mode_unavailable': [
    'یوزرنیم دلخواه دیگر مجاز نیست',
    'وقتی مشتری دکمهٔ یوزرنیم دلخواه را می‌زند ولی پنل دیگر آن را مجاز نمی‌داند.',
  ],
  'bot.username.stale': [
    'یوزرنیم رزروشده دیگر معتبر نیست',
    'یوزرنیم نگه‌داشته‌شده برای سفارش پرداخت‌نشده با قوانین فعلی جور نیست و آزاد شد؛ مشتری باید دوباره انتخاب کند.',
  ],

  // --- Discount ---------------------------------------------------------------------
  'bot.discount.applied': [
    'کد تخفیف اعمال شد',
    'تأیید کد تخفیف واردشده و مبلغی که از قیمت کم کرده است.',
  ],
  'bot.discount.rejected': [
    'کد تخفیف پذیرفته نشد',
    'یک پیام برای همهٔ دلایل رد کد، تا وجود یا اتمام کدها قابل حدس زدن نباشد.',
  ],
  'bot.discount.enter_button': [
    'دکمهٔ اعمال کد تخفیف',
    'دکمهٔ زیر خلاصهٔ خرید که مرحلهٔ وارد کردن کد تخفیف را باز می‌کند.',
  ],
  'bot.discount.remove_button': [
    'دکمهٔ حذف کد تخفیف',
    'کد واردشده را از سفارش برمی‌دارد و قیمت را دوباره محاسبه می‌کند.',
  ],
  'bot.discount.ask': ['درخواست کد تخفیف', 'از مشتری می‌خواهد کد تخفیف را در پیام بعدی بفرستد.'],
  'bot.discount.no_longer_valid': [
    'تخفیف دیگر معتبر نیست',
    'هنگام تأیید سفارش، وقتی تخفیفی که در خلاصه بود دیگر برقرار نیست؛ مبلغی کسر نشده و مشتری باید دوباره سفارش دهد.',
  ],

  // --- Trial ------------------------------------------------------------------------
  'bot.trial.unavailable': [
    'سرویس آزمایشی در دسترس نیست',
    'وقتی سرویس آزمایشی تنظیم نشده، سهمیهٔ مشتری تمام شده یا محصول آن در دسترس نیست.',
  ],
  'bot.trial.issued': [
    'سرویس آزمایشی در حال ساخت',
    'تأیید می‌کند سرویس آزمایشی در حال ساخته شدن است؛ لینک جداگانه فرستاده می‌شود.',
  ],
  'bot.trial.button': [
    'دکمهٔ سرویس آزمایشی در فروشگاه (بازنشسته)',
    'دیگر نمایش داده نمی‌شود؛ سرویس تست فقط از دکمهٔ خودش در منوی اصلی گرفته می‌شود و در مراحل خرید نیست.',
  ],
  'bot.trial.choose_panel': [
    'انتخاب سرور سرویس تست',
    'وقتی چند پنل سرویس تست دارند، از مشتری می‌خواهد یکی را انتخاب کند؛ پنل‌ها روی دکمه‌های زیر آن هستند.',
  ],
  'bot.trial.panel_button': [
    'دکمهٔ یک سرور سرویس تست',
    'یک پنل در انتخاب سرویس تست: نام نمایشی، حجم و مدت آن به ساعت.',
  ],
  'bot.trial.not_delivered': [
    'سرویس آزمایشی ساخته نشد',
    'وقتی سرویس آزمایشی روی پنل ساخته نشد؛ می‌گوید از سهمیهٔ مشتری کم نشده است.',
  ],

  // --- Custom service ---------------------------------------------------------------
  'bot.custom_service.button': [
    'دکمهٔ سرویس دلخواه',
    'دکمهٔ فروشگاه که خرید سرویس با حجم و مدت دلخواه را شروع می‌کند.',
  ],
  'bot.custom_service.locations': [
    'انتخاب لوکیشن سرویس دلخواه',
    'از مشتری می‌خواهد لوکیشن سرویس دلخواه را از میان دکمه‌ها انتخاب کند.',
  ],
  'bot.custom_service.ask_volume': [
    'درخواست حجم سرویس دلخواه',
    'حجم مورد نظر را به گیگابایت می‌پرسد؛ پیام بعدی مشتری تا ده دقیقه به عنوان حجم خوانده می‌شود.',
  ],
  'bot.custom_service.invalid_volume': [
    'حجم نامعتبر سرویس دلخواه',
    'حجم واردشده عدد مثبت با حداکثر دو رقم اعشار نیست؛ مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.custom_service.ask_days': [
    'درخواست مدت سرویس دلخواه',
    'پس از حجم، مدت را به روز می‌پرسد؛ پیام بعدی مشتری تا ده دقیقه به عنوان مدت خوانده می‌شود.',
  ],
  'bot.custom_service.invalid_days': [
    'مدت نامعتبر سرویس دلخواه',
    'تعداد روز واردشده عدد صحیح مثبت در محدودهٔ مجاز نیست؛ مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.custom_service.unavailable': [
    'سرویس دلخواه با این مشخصات ممکن نیست',
    'یک پیام برای همهٔ دلایل: قابلیت خاموش است، لوکیشن ارائه نمی‌شود، پنل ظرفیت ندارد یا قیمتی برای این حجم و مدت نیست.',
  ],
  'bot.custom_service.not_extendable': [
    'سرویس دلخواه قابل تمدید نیست',
    'تمدید یا افزایش حجم و زمان برای سرویس دلخواه ممکن نیست؛ خرید سرویس دلخواه تازه را پیشنهاد می‌کند.',
  ],
  'bot.custom_service.terms_changed': [
    'قیمت سرویس دلخواه تغییر کرده',
    'هنگام تأیید، وقتی قاعدهٔ قیمت یا لوکیشن از زمان پیش‌فاکتور تغییر کرده است؛ مبلغی کسر نشده.',
  ],

  // --- Wallet and top-up ------------------------------------------------------------
  'bot.wallet.balance': [
    'موجودی کیف پول',
    'موجودی کیف پول مشتری که از روی دفتر حساب محاسبه می‌شود.',
  ],
  'bot.wallet.summary': [
    'اطلاعات حساب کاربری (کیف پول)',
    'صفحهٔ کیف پول: شناسه و نام، موجودی، تعداد سرویس‌ها و پرداخت‌ها، زیرمجموعه‌ها و گروه کاربری.',
  ],
  'bot.wallet.phone_missing': [
    'خط شمارهٔ تلفن ثبت‌نشده',
    'متنی که در اطلاعات حساب به جای شمارهٔ تلفنِ ثبت‌نشده نمایش داده می‌شود.',
  ],
  'bot.wallet.group_customer': [
    'برچسب گروه کاربری: کاربر عادی',
    'نام گروه برای مشتری عادی در اطلاعات حساب.',
  ],
  'bot.wallet.group_reseller': [
    'برچسب گروه کاربری: نماینده',
    'نام گروه برای نمایندهٔ فعال در اطلاعات حساب.',
  ],
  'bot.wallet.insufficient': [
    'موجودی ناکافی',
    'وقتی پرداخت از کیف پول به دلیل کمبود موجودی رد می‌شود؛ مقدار کمبود را می‌گوید.',
  ],
  'bot.wallet.topup_button': [
    'دکمهٔ افزایش موجودی',
    'دکمهٔ زیر موجودی که شارژ کیف پول را شروع می‌کند.',
  ],
  'bot.wallet.topup_choose': [
    'انتخاب مبلغ شارژ',
    'بالای دکمه‌های مبلغ‌های از پیش تعیین‌شدهٔ شارژ نمایش داده می‌شود.',
  ],
  'bot.wallet.topup_unavailable': [
    'شارژ کیف پول غیرفعال',
    'وقتی شارژ درخواست شده ولی مبلغ یا حساب پرداختی فعالی تنظیم نشده است.',
  ],
  'bot.wallet.topup_refused': [
    'مبلغ شارژ پذیرفته نشد',
    'وقتی مبلغ انتخاب‌شده دیگر ارائه نمی‌شود یا کمتر از حداقل است.',
  ],
  'bot.wallet.topup_credited': [
    'واریز شارژ کیف پول',
    'پس از تأیید شارژ، مبلغ واریزشده به کیف پول را به مشتری اعلام می‌کند.',
  ],
  'bot.wallet.topup_gift_credited': [
    'واریز هدیهٔ شارژ',
    'وقتی شارژ تأییدشده هدیه دارد، واریز جداگانهٔ هدیه را اعلام می‌کند.',
  ],
  'bot.wallet.topup_amount_prompt': [
    'درخواست مبلغ شارژ',
    'مبلغ شارژ را می‌پرسد و در صورت تنظیم، حداقل و حداکثر را هم می‌گوید؛ پیام بعدی مشتری تا ده دقیقه خوانده می‌شود.',
  ],
  'bot.wallet.topup_amount_invalid': ['مبلغ شارژ نامعتبر', 'متن واردشده عدد صحیح و مثبت نیست.'],
  'bot.wallet.topup_below_minimum': [
    'مبلغ شارژ کمتر از حداقل',
    'مبلغ واردشده کمتر از حداقل مجاز شارژ است.',
  ],
  'bot.wallet.topup_above_maximum': [
    'مبلغ شارژ بیشتر از حداکثر',
    'مبلغ واردشده بیشتر از حداکثر مجاز شارژ است.',
  ],
  'bot.wallet.topup_method_prompt': [
    'انتخاب روش پرداخت',
    'پرسش انتخاب روش پرداخت، هم برای شارژ کیف پول و هم برای پرداخت سفارش.',
  ],
  'bot.wallet.topup_method_button': [
    'دکمهٔ روش پرداخت',
    'دکمهٔ هر روش پرداخت در فهرست روش‌ها، وقتی هدیهٔ شارژ ندارد.',
  ],
  'bot.wallet.topup_method_gift_button': [
    'دکمهٔ روش پرداخت با هدیهٔ شارژ',
    'دکمهٔ روش پرداختی که برای شارژ کیف پول درصد هدیه دارد.',
  ],
  'bot.wallet.topup_close_button': [
    'دکمهٔ بستن فهرست روش‌های پرداخت',
    'فهرست روش‌های پرداخت را می‌بندد و به صفحهٔ قبل برمی‌گرداند؛ پرداختی ساخته نمی‌شود.',
  ],
  'bot.wallet.topup_closed': [
    'فهرست روش‌های پرداخت بسته شد',
    'پس از بستن فهرست، می‌گوید درخواستی ثبت نشده است.',
  ],
  'bot.wallet.topup_none_available': [
    'روش پرداختی برای این مبلغ نیست',
    'وقتی هیچ روش پرداختی همین حالا برای این مشتری و این مبلغ قابل استفاده نیست.',
  ],
  'bot.wallet.topup_expired': [
    'مهلت درخواست شارژ تمام شد',
    'دکمه‌ای که زده شده مربوط به درخواستی است که منقضی یا جایگزین شده است.',
  ],

  // --- Card-to-card payment and receipts --------------------------------------------
  'bot.payment.manual_instructions': [
    'راهنمای پرداخت دستی',
    'راهنمای پرداخت خارج از ربات و ارسال مدرک آن، همراه با مبلغ و کد پیگیری.',
  ],
  'bot.payment.transfer_instructions': [
    'فاکتور کارت‌به‌کارت',
    'فاکتور پرداخت: شناسهٔ فاکتور، مبلغ قابل پرداخت، اطلاعات حساب مقصد و راهنمای پرداخت.',
  ],
  'bot.payment.destination.bank': [
    'خط نام بانک در فاکتور',
    'یک خط از اطلاعات حساب مقصد: بانکی که حساب در آن است.',
  ],
  'bot.payment.destination.holder': [
    'خط نام صاحب حساب در فاکتور',
    'یک خط از اطلاعات حساب مقصد: نامی که حساب به آن ثبت شده است.',
  ],
  'bot.payment.destination.card': [
    'خط شمارهٔ کارت در فاکتور',
    'یک خط از اطلاعات حساب مقصد: شمارهٔ کارت شانزده‌رقمی بدون فاصله.',
  ],
  'bot.payment.destination.sheba': [
    'خط شمارهٔ شبا در فاکتور',
    'یک خط از اطلاعات حساب مقصد: شمارهٔ شبا؛ فقط وقتی برای حساب ثبت شده است.',
  ],
  'bot.payment.copy_card_button': [
    'دکمهٔ کپی شمارهٔ کارت',
    'دکمه‌ای که شمارهٔ کارت را در حافظهٔ گوشی مشتری کپی می‌کند.',
  ],
  'bot.payment.copy_amount_button': [
    'دکمهٔ کپی مبلغ',
    'دکمه‌ای که مبلغ را بدون جداکننده و واحد، برای برنامهٔ بانکی کپی می‌کند.',
  ],
  'bot.payment.wallet_button': [
    'دکمهٔ پرداخت از کیف پول',
    'دکمه‌ای که مشتری برای پرداخت سفارش از موجودی کیف پول می‌زند.',
  ],
  'bot.payment.manual_button': [
    'دکمهٔ ثبت پرداخت (انتخاب روش پرداخت)',
    'روش‌های پرداخت قابل استفاده برای سفارش را فهرست می‌کند؛ خودش چیزی پرداخت نمی‌کند.',
  ],
  'bot.payment.unconfigured': [
    'روش پرداخت فعال نیست',
    'وقتی مشتری روشی را انتخاب می‌کند که در این مجموعه تنظیم نشده است.',
  ],
  'bot.payment.received_for_review': [
    'اعلام واریز ثبت شد',
    'پاسخ به اعلام «پرداخت را انجام دادم»؛ می‌گوید هنوز مبلغی دریافت یا تأیید نشده و نتیجه پس از بررسی اعلام می‌شود.',
  ],
  'bot.payment.sent_button': [
    'دکمهٔ اعلام واریز و ارسال رسید',
    'مشتری با آن اعلام می‌کند انتقال را انجام داده و ارسال رسید را شروع می‌کند.',
  ],
  'bot.payment.receipt_prompt': [
    'درخواست ارسال رسید',
    'پس از اعلام واریز، از مشتری می‌خواهد تصویر یا فایل رسید را در مهلت مشخص بفرستد.',
  ],
  'bot.payment.receipt_received': [
    'رسید دریافت شد',
    'تأیید می‌کند فایل رسید رسید و بررسی می‌شود؛ نمی‌گوید پرداخت تأیید شده است.',
  ],
  'bot.payment.receipt_not_expected': [
    'رسید بی‌موقع',
    'وقتی مشتری تصویر یا فایلی می‌فرستد ولی ربات منتظر رسیدی نیست؛ راه درست ارسال را می‌گوید.',
  ],
  'bot.payment.receipt_expired': [
    'مهلت ارسال رسید تمام شد',
    'رسید پس از پایان مهلت رسیده است؛ مشتری باید دوباره دکمهٔ ارسال رسید را بزند.',
  ],
  'bot.payment.receipt_limit': [
    'سقف تعداد رسید',
    'بیش از حد مجاز رسید برای یک پرداخت فرستاده شده است؛ رسیدهای قبلی بررسی می‌شوند.',
  ],
  'bot.payment.window_too_short': [
    'مهلت سفارش برای کارت‌به‌کارت کافی نیست',
    'وقتی از مهلت سفارش برای پرداخت کارت‌به‌کارت زمان کافی نمانده است؛ ثبت سفارش تازه را پیشنهاد می‌کند.',
  ],
  'bot.payment.cancel_button': [
    'دکمهٔ انصراف از پرداخت',
    'دکمه‌ای که مشتری برای انصراف از پرداخت کارت‌به‌کارتِ شروع‌شده می‌زند.',
  ],
  'bot.payment.cancel_confirm': [
    'پرسش تأیید انصراف از پرداخت',
    'پیش از انصراف می‌گوید کد پیگیری باطل می‌شود و این کار برگشت‌پذیر نیست.',
  ],
  'bot.payment.cancel_confirm_button': [
    'دکمهٔ تأیید انصراف از پرداخت',
    'تنها دکمه‌ای که پرداخت در انتظار را واقعاً لغو می‌کند.',
  ],
  'bot.payment.cancelled': [
    'پرداخت لغو شد',
    'تأیید انصراف از پرداخت؛ کد پیگیری قبلی باطل است ولی سفارش تا پایان مهلتش باز می‌ماند.',
  ],
  'bot.payment.rejected': [
    'پرداخت تأیید نشد (پیام به مشتری)',
    'به مشتری اعلام می‌کند مدیر انتقال او را بررسی و رد کرده است؛ همراه با دلیل.',
  ],
  'bot.payment.expired': [
    'مهلت پرداخت تمام شد',
    'به مشتری اعلام می‌کند مهلت پرداخت بدون تأیید تمام و پرداخت بسته شد.',
  ],
  'bot.payment.withdraw_under_review': [
    'انصراف از پرداختِ دارای رسید ممکن نیست',
    'وقتی مشتری می‌خواهد از پرداختی انصراف دهد که رسیدش را فرستاده؛ تا تصمیم مدیر ممکن نیست.',
  ],
  'bot.payment.transfer_under_review': [
    'پرداخت از کیف پول با واریز در حال بررسی',
    'وقتی مشتری پس از اعلام واریز می‌خواهد همان سفارش را از کیف پول بپردازد؛ چیزی کسر نشده است.',
  ],
  'bot.payment.not_pending': [
    'پرداخت دیگر در انتظار نیست',
    'وقتی مشتری روی پرداختی اقدام می‌کند که تأیید، لغو، رد یا منقضی شده است.',
  ],
  'bot.payment.receipt_credited_to_wallet': [
    'واریز مبلغ رسید به کیف پول',
    'وقتی مدیر به جای تأیید پرداخت، مبلغ رسید کارت‌به‌کارت را به کیف پول مشتری واریز کرده است.',
  ],
  'bot.refund.completed': [
    'بازپرداخت انجام شد',
    'به مشتری اعلام می‌کند بازپرداخت مدیر انجام شده است؛ به کیف پول یا خارج از ربات.',
  ],

  // --- Online gateway and Telegram Stars --------------------------------------------
  'bot.payment.gateway_button': [
    'دکمهٔ پرداخت با درگاه',
    'دکمهٔ پرداخت از طریق درگاه آنلاین؛ فقط وقتی دست‌کم یک درگاه فعال و قابل استفاده است.',
  ],
  'bot.payment.gateway_choose': [
    'انتخاب درگاه پرداخت',
    'عنوان فهرست درگاه‌ها، وقتی بیش از یک درگاه آنلاین ارائه می‌شود.',
  ],
  'bot.payment.route_name_manual_transfer': [
    'نام پیش‌فرض روش کارت‌به‌کارت',
    'نامی که برای روش کارت‌به‌کارت نمایش داده می‌شود اگر مدیر نام دیگری برایش نگذاشته باشد.',
  ],
  'bot.payment.route_name_tonpays': [
    'نام پیش‌فرض روش TonPays',
    'نامی که برای درگاه TonPays نمایش داده می‌شود اگر مدیر نام دیگری برایش نگذاشته باشد.',
  ],
  'bot.payment.route_name_telegram_stars': [
    'نام پیش‌فرض روش تلگرام استارز',
    'نامی که برای پرداخت با تلگرام استارز نمایش داده می‌شود اگر مدیر نام دیگری برایش نگذاشته باشد.',
  ],
  'bot.payment.stars_invoice_order': [
    'خلاصهٔ فاکتور استارز برای سفارش',
    'خلاصهٔ پرداخت سفارش با تلگرام استارز بدون کارمزد: مبلغ، تعداد استارز و مهلت.',
  ],
  'bot.payment.stars_invoice_order_fee': [
    'خلاصهٔ فاکتور استارز برای سفارش با کارمزد',
    'خلاصهٔ پرداخت سفارش با تلگرام استارز وقتی کارمزد دارد: مبلغ سفارش، کارمزد، مبلغ قابل پرداخت، استارز و مهلت.',
  ],
  'bot.payment.stars_invoice_topup': [
    'خلاصهٔ فاکتور استارز برای شارژ کیف پول',
    'خلاصهٔ شارژ کیف پول با تلگرام استارز بدون کارمزد: مبلغ شارژ، تعداد استارز و مهلت.',
  ],
  'bot.payment.stars_invoice_topup_fee': [
    'خلاصهٔ فاکتور استارز برای شارژ با کارمزد',
    'خلاصهٔ شارژ کیف پول با تلگرام استارز وقتی کارمزد دارد؛ می‌گوید کارمزد به کیف پول واریز نمی‌شود.',
  ],
  'bot.payment.stars_invoice_title': [
    'عنوان فاکتور استارز',
    'عنوان پیام فاکتور تلگرام استارز؛ تلگرام فقط ۱ تا ۳۲ نویسه می‌پذیرد.',
  ],
  'bot.payment.stars_invoice_description': [
    'توضیح فاکتور استارز',
    'توضیح پیام فاکتور تلگرام استارز؛ تلگرام فقط ۱ تا ۲۵۵ نویسه می‌پذیرد.',
  ],
  'bot.payment.stars_price_label': [
    'برچسب مبلغ در فاکتور استارز',
    'برچسب تنها خط قیمت در فاکتور تلگرام استارز.',
  ],
  'bot.payment.checkout_in_progress': [
    'پرداخت استارز در حال انجام',
    'وقتی مشتری در میانهٔ پرداخت استارزِ تأییدشده می‌خواهد لغو یا روش دیگری انتخاب کند؛ از او می‌خواهد کمی صبر کند.',
  ],
  'bot.payment.stars_precheckout_refused': [
    'فاکتور استارز دیگر قابل پرداخت نیست',
    'متنی که تلگرام هنگام رد پرداخت استارز نشان می‌دهد؛ برای همهٔ دلایل یکسان است.',
  ],
  'bot.payment.fx_unavailable': [
    'نرخ ارز در دسترس نیست',
    'وقتی مشتری روشی با نرخ مرکزی ارز (مثل استارز در حالت نرخ مرکزی) را انتخاب می‌کند و نرخ قابل استفاده‌ای وجود ندارد؛ می‌گوید بعداً تلاش کند یا روش دیگری برگزیند.',
  ],
  'bot.payment.gateway_preparing': [
    'فاکتور درگاه در حال ساخت',
    'وقتی فاکتور درگاه هنوز ساخته نشده؛ همین پیام به‌محض آماده شدن فاکتور خودکار به فاکتور و دکمهٔ پرداخت تبدیل می‌شود.',
  ],
  'bot.payment.gateway_invoice': [
    'فاکتور پرداخت آنلاین',
    'فاکتور درگاه با دکمهٔ پرداخت: مبلغ و مهلت؛ می‌گوید پرداخت فقط پس از تأیید درگاه ثبت می‌شود.',
  ],
  'bot.payment.gateway_invoice_order_fee': [
    'فاکتور آنلاین سفارش با کارمزد',
    'فاکتور درگاه برای سفارشی که کارمزد درگاه دارد: مبلغ سفارش، کارمزد و مبلغ قابل پرداخت.',
  ],
  'bot.payment.gateway_invoice_topup_fee': [
    'فاکتور آنلاین شارژ کیف پول با کارمزد',
    'فاکتور درگاه برای شارژ کیف پولی که کارمزد درگاه دارد: مبلغ شارژ، کارمزد و مبلغ قابل پرداخت.',
  ],
  'bot.payment.gateway_pay_button': [
    'دکمهٔ پرداخت آنلاین',
    'دکمه‌ای که صفحهٔ پرداخت درگاه را باز می‌کند.',
  ],
  'bot.payment.gateway_check_button': [
    'دکمهٔ بررسی وضعیت پرداخت',
    'وضعیت پرداخت درگاه را دوباره بررسی می‌کند.',
  ],
  'bot.payment.gateway_confirmed': [
    'پرداخت درگاه تأیید شد',
    'درگاه پرداخت را تأیید کرد و ثبت شد؛ برای سفارش، تحویل جداگانه انجام می‌شود.',
  ],
  'bot.payment.gateway_failed': [
    'پرداخت درگاه تأیید نشد',
    'درگاه این پرداخت را قطعاً تأیید نکرد؛ مبلغی ثبت نشده و مشتری می‌تواند دوباره پرداخت کند.',
  ],
  'bot.payment.gateway_unavailable': [
    'درگاه در دسترس نیست',
    'درگاه به دلیل تنظیمات همین مجموعه یا حساب درگاه قابل استفاده نیست؛ مشکل از پرداخت مشتری نیست.',
  ],
  'bot.payment.gateway_unknown': [
    'پاسخ درگاه دریافت نشد',
    'پاسخ درگاه برای ساخت فاکتور گم شد و لینکی نمایش داده نمی‌شود؛ چیزی پرداخت‌شده ثبت نشده است.',
  ],
  'bot.payment.gateway_no_link': [
    'درگاه لینک پرداخت نفرستاد',
    'درگاه ساخت فاکتور را اعلام کرد اما لینکی که مشتری بتواند باز کند برنگرداند؛ مبلغی ثبت نشده و مشتری می‌تواند پرداخت تازه‌ای شروع کند.',
  ],
  'bot.payment.gateway_closed': [
    'فاکتور درگاه بسته شده',
    'مهلت این فاکتور تمام شده یا بسته شده است؛ سفارش لغو نمی‌شود و مشتری می‌تواند پرداخت تازه‌ای شروع کند.',
  ],

  // --- My services ------------------------------------------------------------------
  'bot.service.list_empty': ['مشتری سرویسی ندارد', 'وقتی مشتری هنوز هیچ سرویسی ندارد.'],
  'bot.service.list_heading': [
    'عنوان کوتاه فهرست سرویس‌ها',
    'عنوانی که بالای فهرست سرویس‌های خریداری‌شدهٔ مشتری می‌آید.',
  ],
  'bot.service.list': [
    'صفحهٔ سرویس‌های من',
    'صفحهٔ فهرست سرویس‌ها بالای دکمه‌های هر سرویس، با شمارهٔ صفحه و تعداد کل.',
  ],
  'bot.service.list_more': [
    'دکمهٔ سرویس‌های بیشتر',
    'دکمه‌ای که صفحهٔ بعد سرویس‌های مشتری را نشان می‌دهد.',
  ],
  'bot.service.list_item_button': [
    'دکمهٔ هر سرویس در فهرست',
    'دکمهٔ هر سرویس در فهرست سرویس‌ها با نام کاربری آن روی پنل.',
  ],
  'bot.service.search_label_button': [
    'دکمهٔ برچسب جست‌وجو',
    'دکمهٔ برچسب ردیف جست‌وجو که مانند دکمهٔ کنارش جست‌وجو را باز می‌کند.',
  ],
  'bot.service.search_button': [
    'دکمهٔ جست‌وجوی سرویس',
    'جست‌وجو بر اساس نام کاربری سرویس را باز می‌کند.',
  ],
  'bot.service.page_button': [
    'نشانگر شمارهٔ صفحهٔ سرویس‌ها',
    'دکمهٔ میان پیکان‌ها که شمارهٔ صفحه را نشان می‌دهد.',
  ],
  'bot.service.prev_page_button': ['دکمهٔ صفحهٔ قبل سرویس‌ها', 'صفحهٔ قبل فهرست سرویس‌ها.'],
  'bot.service.next_page_button': ['دکمهٔ صفحهٔ بعد سرویس‌ها', 'صفحهٔ بعد فهرست سرویس‌ها.'],
  'bot.service.back_to_menu_button': [
    'دکمهٔ بازگشت به منو از فهرست سرویس‌ها',
    'از فهرست سرویس‌ها به منوی اصلی برمی‌گرداند.',
  ],
  'bot.service.search_prompt': [
    'درخواست عبارت جست‌وجو',
    'نام کاربری سرویس یا ابتدای آن را از مشتری می‌پرسد.',
  ],
  'bot.service.search_results': ['عنوان نتایج جست‌وجو', 'عنوان بالای نتایج جست‌وجوی سرویس.'],
  'bot.service.search_none': [
    'نتیجه‌ای در جست‌وجو پیدا نشد',
    'هیچ‌کدام از سرویس‌های مشتری با عبارت جست‌وجو جور نیست.',
  ],
  'bot.service.search_invalid': [
    'عبارت جست‌وجو نامعتبر',
    'عبارت جست‌وجو خالی یا بیش از حد طولانی است.',
  ],
  'bot.service.not_found': [
    'سرویس در دسترس نیست',
    'وقتی مشتری روی سرویسی اقدام می‌کند که متعلق به او نیست یا وجود ندارد.',
  ],
  'bot.service.detail': [
    'جزئیات سرویس برای مشتری',
    'اطلاعات یک سرویس برای صاحب آن: وضعیت، مصرف و انقضا بر اساس آخرین همگام‌سازی.',
  ],
  'bot.service.card': [
    'کارت مدیریت سرویس',
    'کارت اصلی مدیریت سرویس برای مشتری: وضعیت، نام، موقعیت، حجم، مصرف، انقضا، آخرین اتصال و یادداشت.',
  ],
  'bot.service.state_pending_provision': [
    'وضعیت سرویس: در حال ساخت',
    'متن وضعیت در کارت سرویس، وقتی سرویس هنوز ساخته نشده است.',
  ],
  'bot.service.state_active': ['وضعیت سرویس: فعال', 'متن وضعیت در کارت سرویس فعال.'],
  'bot.service.state_suspended': [
    'وضعیت سرویس: خاموش',
    'متن وضعیت در کارت سرویسی که موقتاً غیرفعال شده است.',
  ],
  'bot.service.state_expired': [
    'وضعیت سرویس: منقضی',
    'متن وضعیت در کارت سرویسی که اعتبارش تمام شده است.',
  ],
  'bot.service.state_terminated': [
    'وضعیت سرویس: حذف‌شده',
    'متن وضعیت در کارت سرویسی که به پایان رسیده و حذف شده است.',
  ],
  'bot.service.state_working': [
    'وضعیت سرویس: در حال اعمال درخواست',
    'متن وضعیت در کارت سرویس تا وقتی خاموش/روشن کردن، تغییر لینک یا تغییر لوکیشن هنوز روی سرور نهایی نشده است؛ دکمه‌های عملیات تا پاسخ نهایی نمایش داده نمی‌شوند.',
  ],
  'bot.service.status_with_notice': [
    'وضعیت سرویس همراه با یک اطلاعیه',
    'وقتی کارت سرویس دربارهٔ آخرین درخواست یک خط توضیح دارد: وضعیت و سپس همان خط.',
  ],
  'bot.service.notice_action_failed': [
    'اطلاعیهٔ انجام نشدن درخواست',
    'روی همان کارت سرویس، وقتی خاموش/روشن کردن یا تغییر لینک قطعاً روی سرور انجام نشد.',
  ],
  'bot.service.state_unreconciled': [
    'وضعیت سرویس: در حال بررسی',
    'متن وضعیت وقتی پاسخ پنل گم شده و وضعیت سرویس باید دوباره از پنل خوانده شود.',
  ],
  'bot.service.traffic_value': [
    'نمایش مقدار حجم',
    'نحوهٔ نمایش یک مقدار حجم با واحد آن در کارت سرویس.',
  ],
  'bot.service.traffic_unknown': [
    'حجم هنوز خوانده نشده',
    'وقتی مصرف سرویس هنوز از پنل خوانده نشده است؛ به جای صفر نمایش داده می‌شود.',
  ],
  'bot.service.remaining_value': [
    'نمایش حجم باقی‌مانده',
    'حجم باقی‌مانده و درصد آن از کل حجم در کارت سرویس.',
  ],
  'bot.service.remaining_unlimited': [
    'حجم باقی‌ماندهٔ نامحدود',
    'حجم باقی‌مانده برای سرویس با حجم نامحدود.',
  ],
  'bot.service.no_expiry': [
    'خط بدون تاریخ انقضا',
    'خط تاریخ انقضا برای سرویسی که محدودیت زمانی ندارد.',
  ],
  'bot.service.last_seen_at': [
    'زمان آخرین اتصال',
    'آخرین زمان اتصال، وقتی پنل آن را گزارش کرده است.',
  ],
  'bot.service.last_seen_never': [
    'هرگز متصل نشده',
    'وقتی پنل گزارش می‌دهد این حساب هرگز متصل نشده است.',
  ],
  'bot.service.last_seen_unavailable': [
    'آخرین اتصال در دسترس نیست',
    'وقتی پنل زمان آخرین اتصال را گزارش نمی‌کند.',
  ],
  'bot.service.rotate_hint': [
    'راهنمای تغییر لینک زیر کارت سرویس',
    'توضیح زیر کارت سرویس، فقط وقتی دکمهٔ تغییر لینک نمایش داده می‌شود.',
  ],
  'bot.service.refresh_button': [
    'دکمهٔ به‌روزرسانی اطلاعات سرویس',
    'خواندن مصرف سرویس از پنل را در صف می‌گذارد.',
  ],
  'bot.service.refresh_requested': [
    'درخواست به‌روزرسانی ثبت شد',
    'خواندن از پنل در صف است و نتیجه در پیام جداگانه می‌آید.',
  ],
  'bot.service.refresh_too_soon': [
    'به‌روزرسانی زودتر از حد مجاز',
    'اطلاعات به‌تازگی خوانده شده است و درخواست تازه‌ای ثبت نمی‌شود.',
  ],
  'bot.service.link_button': [
    'دکمهٔ لینک اشتراک',
    'لینک اشتراک فعلی را دوباره می‌فرستد؛ لینک تازه نمی‌سازد.',
  ],
  'bot.service.note_button': [
    'دکمهٔ تغییر یادداشت',
    'مرحلهٔ نوشتن یادداشت برای سرویس را باز می‌کند.',
  ],
  'bot.service.note_prompt': [
    'درخواست یادداشت سرویس',
    'یادداشت سرویس را از مشتری می‌خواهد و حداکثر طول آن را می‌گوید.',
  ],
  'bot.service.note_saved': ['یادداشت ذخیره شد', 'یادداشت روی سرویس مشتری ذخیره شد.'],
  'bot.service.note_cleared': ['یادداشت حذف شد', 'یادداشت سرویس مشتری حذف شد.'],
  'bot.service.note_invalid': ['یادداشت نامعتبر', 'متن یادداشت خالی یا بیش از حد طولانی است.'],
  'bot.service.back_to_list_button': [
    'دکمهٔ بازگشت به فهرست سرویس‌ها',
    'از کارت یک سرویس به فهرست سرویس‌ها برمی‌گرداند.',
  ],
  'bot.service.subscription': ['لینک اشتراک', 'لینک اشتراک مشتری به شکلی که با لمس کپی شود.'],
  'bot.service.resend_button': [
    'دکمهٔ ارسال دوبارهٔ لینک اشتراک',
    'دکمه‌ای که ارسال دوبارهٔ لینک اشتراک را درخواست می‌کند.',
  ],
  'bot.service.rotate_button': [
    'دکمهٔ تغییر لینک اشتراک',
    'دکمهٔ درخواست لینک اشتراک جدید؛ فقط وقتی تغییر لینک فعال است و پنل آن را پشتیبانی می‌کند.',
  ],
  'bot.service.rotate_ask': [
    'پرسش تأیید تغییر لینک',
    'پیش از تغییر لینک می‌گوید لینک تازه باید در برنامه‌ها وارد شود و تا چه مدت نمی‌توان دوباره درخواست داد.',
  ],
  'bot.service.rotate_confirm_button': [
    'دکمهٔ تأیید ساخت لینک جدید',
    'دکمه‌ای که در صفحهٔ تأیید، لینک جدید را درخواست می‌کند.',
  ],
  'bot.service.rotate_cooldown': [
    'محدودیت زمانی تغییر لینک',
    'مشتری به‌تازگی لینک جدید گرفته است؛ زمانی را که دوباره ممکن است می‌گوید.',
  ],
  'bot.service.files_button': [
    'دکمهٔ دریافت فایل‌های اتصال',
    'فایل‌های آمادهٔ اتصال را از پنل می‌گیرد؛ فقط وقتی پنل این امکان را دارد.',
  ],
  'bot.service.file_caption': [
    'توضیح پنل زیر فایل اتصال',
    'توضیح آماده‌ای که خود پنل برای هر فایل اتصال می‌فرستد، همان‌طور که پنل نوشته است؛ قالب‌بندی آن (مثلاً متن کد) حفظ می‌شود.',
  ],
  'bot.service.connection_file_caption': [
    'توضیح فایل اتصال بدون توضیح پنل',
    'فقط وقتی پنل برای یک فایل توضیحی نفرستاده باشد: نام کاربری سرویس.',
  ],
  'bot.service.link_rotated': [
    'لینک اشتراک تغییر کرد',
    'پس از تغییر لینک همان سرویس؛ لینک جدید را می‌دهد و می‌گوید لینک قبلی دیگر کار نمی‌کند. پس از آن فایل‌های اتصال جدید ارسال می‌شود.',
  ],
  'bot.service.back_to_card_button': [
    'دکمهٔ بازگشت به مشخصات سرویس',
    'زیر پرسش تغییر لینک؛ کارت سرویس را در همان پیام برمی‌گرداند.',
  ],
  'bot.service.refresh_failed': [
    'خطای بروزرسانی اطلاعات',
    'پیام کوتاه روی دکمهٔ بروزرسانی وقتی اطلاعات از سرور خوانده نشد؛ کارت سرویس دست نمی‌خورد.',
  ],
  'bot.service.files_partial': [
    'برخی فایل‌های اتصال آماده نشد',
    'پس از ارسال فایل‌های آماده، می‌گوید چند فرمت آماده نشد.',
  ],
  'bot.service.files_unavailable': [
    'فایل‌های اتصال در دسترس نیست',
    'وقتی هیچ فایل اتصالی همین حالا قابل ارسال نیست.',
  ],
  'bot.service.files_rate_limited': [
    'محدودیت دریافت فایل‌های اتصال',
    'پنل تعداد درخواست فایل‌ها را محدود کرده است؛ زمان انتظار را می‌گوید.',
  ],
  'bot.service.provisioning': [
    'سرویس در حال ساخت',
    'وقتی سرویس روی پنل در حال ساخته شدن است؛ نتیجه بعداً اعلام می‌شود.',
  ],
  'bot.service.provision_delayed': [
    'تأخیر در ساخت سرویس',
    'ساخت سرویس کامل نشد و پشتیبانی باخبر شد؛ از مشتری نمی‌خواهد دوباره تلاش کند.',
  ],
  'bot.service.suspend_button': [
    'دکمهٔ خاموش کردن اکانت',
    'درخواست غیرفعال کردن موقت سرویس؛ فقط برای سرویس فعال روی پنلی که این کار را پشتیبانی می‌کند.',
  ],
  'bot.service.resume_button': ['دکمهٔ روشن کردن اکانت', 'درخواست فعال کردن دوبارهٔ سرویس خاموش.'],
  'bot.service.terminate_button': [
    'دکمهٔ حذف سرویس',
    'حذف سرویس را شروع می‌کند و پرسش تأیید را نشان می‌دهد؛ خودش چیزی حذف نمی‌کند.',
  ],
  'bot.service.terminate_confirm': [
    'پرسش تأیید حذف سرویس',
    'نام سرویس را می‌آورد و می‌گوید حذف برگشت‌پذیر نیست.',
  ],
  'bot.service.terminate_confirm_button': [
    'دکمهٔ تأیید حذف سرویس',
    'تنها دکمه‌ای که حذف سرویس را واقعاً درخواست می‌کند.',
  ],
  'bot.service.renew_button': [
    'دکمهٔ تمدید سرویس',
    'قیمت تمدید را نشان می‌دهد و می‌پرسد؛ خودش چیزی نمی‌خرد.',
  ],
  'bot.service.renew_choose': [
    'انتخاب گزینهٔ تمدید',
    'صفحهٔ تمدید: تمدید خود محصول و بسته‌های افزایش زمان.',
  ],
  'bot.service.renew_option_button': ['دکمهٔ گزینهٔ تمدید', 'دکمهٔ تمدید همان محصول با قیمت فعلی.'],
  'bot.service.renew_unavailable': [
    'گزینهٔ تمدید در دسترس نیست',
    'محصول برداشته شده یا قیمت ندارد و بستهٔ افزایش زمانی هم نیست.',
  ],
  'bot.service.add_traffic_button': [
    'دکمهٔ خرید حجم اضافه',
    'بسته‌های حجم اضافهٔ قابل خرید را نشان می‌دهد.',
  ],
  'bot.service.add_time_button': [
    'دکمهٔ خرید زمان اضافه',
    'بسته‌های زمان اضافهٔ قابل خرید را نشان می‌دهد.',
  ],
  'bot.service.add_devices_button': [
    'دکمهٔ افزایش کاربر / دستگاه',
    'پیشنهاد خرید کاربر یا دستگاه اضافه را باز می‌کند؛ فقط وقتی پنل سرویس این قابلیت را دارد و تعرفه‌ای فعال است نمایش داده می‌شود.',
  ],
  'bot.service.devices_choice': [
    'انتخاب تعداد کاربر / دستگاه اضافه',
    'تعداد مجاز فعلی، قیمت هر کاربر و تعدادی که هنوز قابل خرید است؛ تعدادها روی دکمه‌های زیر آن هستند.',
  ],
  'bot.service.devices_option': [
    'دکمهٔ هر تعداد کاربر اضافه',
    'یک تعداد و قیمت آن، پیش از هر تخفیف؛ مبلغ نهایی در پیش‌فاکتور می‌آید.',
  ],
  'bot.service.addon_choice': [
    'عنوان انتخاب بستهٔ افزودنی',
    'عنوان بالای بسته‌های حجم یا زمان اضافه؛ مقدار و قیمت روی دکمه‌ها است.',
  ],
  'bot.service.addon_option': ['دکمهٔ هر بستهٔ افزودنی', 'نام و قیمت هر بستهٔ حجم یا زمان اضافه.'],
  'bot.service.action_quote': [
    'پیش‌فاکتور تمدید یا افزودنی',
    'آنچه این خرید به سرویس اضافه می‌کند و قیمت آن؛ همان قیمتی که سفارش با آن ثبت می‌شود.',
  ],
  'bot.service.action_confirm_button': [
    'دکمهٔ تأیید و پرداخت تمدید یا افزودنی',
    'مشتری را به پیش‌فاکتور متعهد و سفارش را منتظر پرداخت می‌کند.',
  ],
  'bot.service.action_unavailable': [
    'این امکان برای سرویس در دسترس نیست',
    'بسته‌ای تنظیم نشده، محصول تمدید برداشته شده یا پنل این کار را انجام نمی‌دهد.',
  ],
  'bot.service.action_not_allowed': [
    'وضعیت سرویس اجازهٔ این کار را نمی‌دهد',
    'سرویس در وضعیتی نیست که این کار برایش معنا داشته باشد؛ مثلاً سرویس حذف‌شده قابل تمدید نیست.',
  ],
  'bot.service.action_in_progress': [
    'درخواست قبلی هنوز اعمال نشده',
    'تمدید یا افزودنی قبلی هنوز روی پنل اعمال نشده؛ مشتری باید کمی بعد دوباره تلاش کند.',
  ],
  'bot.service.action_requested': [
    'درخواست تغییر سرویس ثبت شد',
    'خاموش، روشن یا حذف کردن سرویس ثبت شد و در حال اعمال روی پنل است؛ نمی‌گوید انجام شده.',
  ],
  'bot.service.action_succeeded': [
    'درخواست سرویس انجام شد',
    'درخواست مشتری (خاموش، روشن، حذف، تمدید یا افزودنی) روی پنل اعمال شد.',
  ],
  'bot.service.action_failed': [
    'درخواست سرویس انجام نشد',
    'درخواست مشتری انجام نمی‌شود؛ می‌تواند دوباره تلاش کند یا با پشتیبانی تماس بگیرد.',
  ],
  'bot.service.renewed': [
    'نتیجهٔ تمدید سرویس',
    'پیام جداگانه‌ای که پس از تمدید موفق روی پنل برای مشتری فرستاده می‌شود، با نام کاربری، مدت تمدید، تاریخ انقضای جدید و کد پیگیری.',
  ],
  'bot.service.renewed_details_button': [
    'دکمهٔ «مشخصات سرویس» در نتیجهٔ تمدید',
    'زیر پیام نتیجهٔ تمدید می‌آید و کارت همان سرویس تمدیدشده را باز می‌کند.',
  ],
  'bot.service.renew_paid': [
    'بستن پیام پرداخت تمدید',
    'پیام پرداخت تمدید پس از پرداخت از کیف پول به این متن تبدیل می‌شود و دکمه‌هایش حذف می‌شود؛ نتیجهٔ تمدید جداگانه می‌آید.',
  ],
  'bot.service.capability_unsupported': [
    'قابلیت برای این سرویس پشتیبانی نمی‌شود',
    'وقتی مشتری کاری می‌خواهد که پنل سرویس او انجام نمی‌دهد.',
  ],

  // --- Delivery and connection guides -----------------------------------------------
  'bot.service.delivered': [
    'کارت تحویل سرویس',
    'پس از خرید موفق همراه تصویر QR فرستاده می‌شود: نام کاربری، مشخصات سرویس و لینک اشتراک.',
  ],
  'bot.service.delivered_qr_caption': [
    'توضیح کوتاه تصویر QR',
    'وقتی کارت تحویل در توضیح تصویر جا نمی‌شود، زیر تصویر QR می‌آید و کارت در پیام بعدی.',
  ],
  'bot.service.tutorial_button': [
    'دکمهٔ مشاهدهٔ آموزش',
    'انتخاب سیستم‌عامل برای آموزش اتصال را باز می‌کند.',
  ],
  'bot.service.connected_button': [
    'دکمهٔ «وصل شدم»',
    'مشتری اعلام می‌کند متصل شده است؛ چیزی ثبت نمی‌شود.',
  ],
  'bot.service.problem_button': [
    'دکمهٔ «مشکل دارم»',
    'صفحهٔ پرسش‌های متداول و پشتیبانی را باز می‌کند.',
  ],
  'bot.service.connected_ack': [
    'پاسخ به «وصل شدم»',
    'پاسخ تشکر به مشتری‌ای که اعلام کرده متصل شده است.',
  ],
  'bot.tutorial.choose': [
    'انتخاب سیستم‌عامل برای آموزش',
    'نخستین صفحهٔ راهنمای اتصال: انتخاب سیستم‌عامل.',
  ],
  'bot.tutorial.android_button': ['دکمهٔ آموزش اندروید', 'دکمهٔ انتخاب راهنمای اندروید.'],
  'bot.tutorial.ios_button': ['دکمهٔ آموزش آیفون', 'دکمهٔ انتخاب راهنمای آیفون (iOS).'],
  'bot.tutorial.windows_button': ['دکمهٔ آموزش ویندوز', 'دکمهٔ انتخاب راهنمای ویندوز.'],
  'bot.tutorial.macos_button': ['دکمهٔ آموزش مک', 'دکمهٔ انتخاب راهنمای مک.'],
  'bot.tutorial.linux_button': ['دکمهٔ آموزش لینوکس', 'دکمهٔ انتخاب راهنمای لینوکس.'],
  'bot.tutorial.other_button': [
    'دکمهٔ «سایر»',
    'دکمهٔ انتخاب برنامه‌های بخش «سایر»؛ فقط وقتی نشان داده می‌شود که برنامهٔ فعالی در این بخش ثبت شده باشد.',
  ],
  'bot.tutorial.android': [
    'آموزش اتصال در اندروید',
    'راهنمای کلی اتصال در اندروید؛ وقتی نشان داده می‌شود که برای این سیستم‌عامل هیچ برنامهٔ فعالی در بخش «برنامه‌ها و آموزش اتصال» ثبت نشده است.',
  ],
  'bot.tutorial.ios': [
    'آموزش اتصال در آیفون',
    'راهنمای کلی اتصال در آیفون (iOS)؛ وقتی نشان داده می‌شود که برای این سیستم‌عامل هیچ برنامهٔ فعالی در بخش «برنامه‌ها و آموزش اتصال» ثبت نشده است.',
  ],
  'bot.tutorial.windows': [
    'آموزش اتصال در ویندوز',
    'راهنمای کلی اتصال در ویندوز؛ وقتی نشان داده می‌شود که برای این سیستم‌عامل هیچ برنامهٔ فعالی در بخش «برنامه‌ها و آموزش اتصال» ثبت نشده است.',
  ],
  'bot.tutorial.macos': [
    'آموزش اتصال در مک',
    'راهنمای کلی اتصال در مک؛ وقتی نشان داده می‌شود که برای این سیستم‌عامل هیچ برنامهٔ فعالی در بخش «برنامه‌ها و آموزش اتصال» ثبت نشده است.',
  ],
  'bot.tutorial.linux': [
    'آموزش اتصال در لینوکس',
    'راهنمای کلی اتصال در لینوکس؛ وقتی نشان داده می‌شود که برای این سیستم‌عامل هیچ برنامهٔ فعالی در بخش «برنامه‌ها و آموزش اتصال» ثبت نشده است.',
  ],

  // --- App downloads and connection guides ------------------------------------------
  'bot.apps.platform': [
    'فهرست برنامه‌های یک سیستم‌عامل',
    'بالای دکمه‌های برنامه‌های پیشنهادی یک سیستم‌عامل می‌آید؛ برنامه‌ها خودشان دکمه‌های زیر آن‌اند.',
  ],
  'bot.apps.platform_empty': [
    'بخش بدون برنامه',
    'وقتی مشتری «سایر» را باز می‌کند و هیچ برنامهٔ فعالی برای او در آن نمانده است.',
  ],
  'bot.apps.detail': [
    'صفحهٔ یک برنامه',
    'نام، توضیح و آموزش اتصال یک برنامه؛ دکمه‌های دانلود زیر آن می‌آیند.',
  ],
  'bot.apps.detail_files': [
    'صفحهٔ برنامه با فایل‌های اتصال',
    'همان صفحهٔ برنامه، برای برنامه‌ای که فایل اتصال هم می‌پذیرد و مشتری‌ای که سرویسش فایل دارد؛ جای دریافت فایل‌ها را هم می‌گوید.',
  ],
  'bot.apps.download_button': [
    'دکمهٔ دانلود رسمی',
    'دکمه‌ای که لینک دانلود رسمی برنامه را باز می‌کند.',
  ],
  'bot.apps.alternative_button': [
    'دکمهٔ فروشگاه یا لینک جایگزین',
    'دکمه‌ای که لینک فروشگاه یا لینک جایگزین برنامه را باز می‌کند؛ فقط وقتی چنین لینکی ثبت شده باشد.',
  ],
  'bot.apps.help_button': [
    'دکمهٔ ویدیو و راهنما',
    'دکمه‌ای که لینک ویدیو یا راهنمای بیشتر برنامه را باز می‌کند؛ فقط وقتی چنین لینکی ثبت شده باشد.',
  ],
  'bot.apps.back_button': [
    'دکمهٔ بازگشت به فهرست برنامه‌ها',
    'از صفحهٔ یک برنامه به فهرست برنامه‌های همان سیستم‌عامل برمی‌گرداند.',
  ],
  'bot.apps.platforms_button': [
    'دکمهٔ انتخاب سیستم‌عامل دیگر',
    'به صفحهٔ انتخاب سیستم‌عامل برمی‌گرداند.',
  ],
  'bot.apps.not_found': ['برنامهٔ ناموجود', 'پاسخ به دکمهٔ برنامه‌ای که حذف یا غیرفعال شده است.'],

  // --- Expiry and usage reminders ---------------------------------------------------
  'bot.service.expiry_first': [
    'یادآور اول انقضای سرویس',
    'وقتی به نخستین آستانهٔ انقضا (پیش‌فرض سه روز مانده) می‌رسد، به مشتری فرستاده می‌شود.',
  ],
  'bot.service.expiry_second': [
    'یادآور دوم انقضای سرویس',
    'یادآور فوری‌تر انقضا (پیش‌فرض یک روز مانده).',
  ],
  'bot.service.expired': [
    'اعلان پایان اعتبار سرویس',
    'اعتبار سرویس تمام شده است؛ به تمدید دعوت می‌کند و نمی‌گوید چیزی حذف شده.',
  ],
  'bot.service.usage_first': [
    'یادآور اول مصرف حجم',
    'وقتی از حجم سرویس به نخستین آستانه (پیش‌فرض ۲۰ درصد) باقی مانده باشد.',
  ],
  'bot.service.usage_second': [
    'یادآور دوم مصرف حجم',
    'وقتی از حجم سرویس به آستانهٔ دوم (پیش‌فرض ۱۰ درصد) باقی مانده باشد.',
  ],
  'bot.service.usage_final': [
    'یادآور پایانی مصرف حجم',
    'وقتی از حجم سرویس به آستانهٔ پایانی (پیش‌فرض ۵ درصد) باقی مانده باشد؛ خرید حجم اضافه را پیشنهاد می‌کند.',
  ],
  // WP-A9: the week-out and day-of expiry reminders, and the non-service reminders.
  'bot.service.expiry_early': [
    'یادآور هفتگی انقضای سرویس',
    'زودترین یادآور انقضا (پیش‌فرض هفت روز مانده)؛ پیش از یادآور اول فرستاده می‌شود.',
  ],
  'bot.service.expiry_day': [
    'یادآور روز انقضای سرویس',
    'در روز پایان اعتبار و پیش از پایان آن فرستاده می‌شود و زمان دقیق انقضا را می‌گوید.',
  ],
  'bot.wallet.low_balance': [
    'هشدار کمبود موجودی کیف پول',
    'وقتی موجودی کیف پول از آستانهٔ تعیین‌شده کمتر شود، یک بار فرستاده می‌شود.',
  ],
  'bot.payment.pending_reminder': [
    'یادآور مهلت پرداخت کارت‌به‌کارت',
    'کمی پیش از پایان مهلت پرداخت، اگر مشتری هنوز واریز نکرده و رسیدی نفرستاده باشد.',
  ],
  'bot.order.pending_reminder': [
    'یادآور سفارش پرداخت‌نشده',
    'کمی پیش از پایان مهلت سفارشی که هنوز پرداختی برایش شروع نشده است.',
  ],
  // Round N, package D: informational only — nothing happens to a reseller below the minimum.
  'bot.reseller.minimum_reminder': [
    'یادآوری حداقل فروش ماهانهٔ نمایندگی',
    'چند روز پیش از پایان ماه، یک بار به نماینده‌ای که فروشش هنوز به حداقل ماهانه نرسیده فرستاده می‌شود.',
  ],
  'bot.reseller.minimum_achieved': [
    'رسیدن به حداقل فروش ماهانه',
    'یک بار در ماه، وقتی فروش نماینده به حداقل ماهانهٔ او برسد (اگر این پیام روشن باشد).',
  ],

  // --- Service transfer -------------------------------------------------------------
  'bot.service.transfer_button': [
    'دکمهٔ انتقال سرویس',
    'انتقال سرویس به کاربر دیگر را شروع می‌کند؛ فقط وقتی سرویس قابل انتقال است.',
  ],
  'bot.service.transfer_prompt': [
    'درخواست شناسهٔ کاربر مقصد',
    'شناسهٔ عددی تلگرام کاربر مقصد را می‌پرسد؛ هنوز چیزی منتقل نمی‌شود.',
  ],
  'bot.service.transfer_confirm': [
    'تأیید انتقال سرویس',
    'مشخصات سرویس و کاربر مقصد را پیش از انتقال نشان می‌دهد.',
  ],
  'bot.service.transfer_confirm_button': [
    'دکمهٔ تأیید انتقال سرویس',
    'تنها دکمه‌ای که سرویس را منتقل می‌کند.',
  ],
  'bot.service.transfer_done': [
    'انتقال سرویس انجام شد',
    'سرویس به کاربر مقصد منتقل شد؛ پاسخ تأیید تکراری هم همین است.',
  ],
  'bot.service.transfer_received': [
    'اعلان دریافت سرویس انتقالی',
    'به گیرنده اعلام می‌کند سرویسی به او منتقل شده است.',
  ],
  'bot.service.transfer_details_button': [
    'دکمهٔ مشخصات سرویس انتقالی',
    'دکمهٔ زیر اعلان گیرنده که سرویس منتقل‌شده را باز می‌کند.',
  ],
  'bot.service.transfer_recipient_invalid': [
    'شناسهٔ مقصد نامعتبر',
    'متن واردشده شناسهٔ عددی تلگرام نیست؛ دوباره پرسیده می‌شود.',
  ],
  'bot.service.transfer_recipient_unavailable': [
    'کاربر مقصد پیدا نشد',
    'کاربری با این شناسه در ربات نیست یا نمی‌تواند سرویس دریافت کند.',
  ],
  'bot.service.transfer_recipient_self': [
    'انتقال سرویس به خود ممکن نیست',
    'شناسهٔ واردشده متعلق به خود فرستنده است.',
  ],
  'bot.service.transfer_unavailable': [
    'انتقال این سرویس ممکن نیست',
    'یک پیام برای همهٔ دلایل: وضعیت سرویس، لینک تحویل‌نشده، پرداخت یا درخواست در جریان، یا سرویس آزمایشی.',
  ],

  // --- Service location change --------------------------------------------------------
  'bot.service.change_location_button': [
    'دکمهٔ تغییر لوکیشن',
    'تغییر لوکیشن سرویس را باز می‌کند؛ فقط وقتی سرویس فعال است، پنل آن را پشتیبانی می‌کند و دست‌کم یک لوکیشن مقصد فعال و قیمت‌دار تعریف شده است.',
  ],
  'bot.service.location_choice': [
    'صفحهٔ انتخاب لوکیشن مقصد',
    'لوکیشن فعلی سرویس را می‌گوید؛ لوکیشن‌های مقصد با قیمت یا «رایگان» روی دکمه‌های زیر آن است.',
  ],
  'bot.service.location_option': [
    'دکمهٔ لوکیشن مقصد پولی',
    'نام لوکیشن مقصد و قیمت فهرست انتقال؛ مبلغ نهایی پس از تخفیف در پیش‌فاکتور گفته می‌شود.',
  ],
  'bot.service.location_option_free': [
    'دکمهٔ لوکیشن مقصد رایگان',
    'لوکیشنی که مدیر انتقال به آن را رایگان کرده (قیمت صفر، نه قیمت تعریف‌نشده).',
  ],
  'bot.service.location_confirm_free': [
    'تأیید تغییر لوکیشن رایگان',
    'مبدأ، مقصد، رایگان بودن و اینکه مشخصات اتصال ممکن است عوض شود؛ تا تأیید مشتری چیزی تغییر نمی‌کند.',
  ],
  'bot.service.location_confirm_button': [
    'دکمهٔ تأیید تغییر لوکیشن',
    'تنها دکمه‌ای که تغییر لوکیشن رایگان را ثبت می‌کند.',
  ],
  'bot.service.location_requested': [
    'درخواست تغییر لوکیشن ثبت شد',
    'تغییر رایگان ثبت شد و روی پنل انجام می‌شود؛ نتیجه و مشخصات اتصال تازه از راه اعلان‌ها می‌رسد.',
  ],
  'bot.service.location_same': [
    'لوکیشن مقصد همان لوکیشن فعلی است',
    'سرویس همین حالا در لوکیشن انتخاب‌شده است؛ چیزی تغییر نکرد و مبلغی کسر نشد.',
  ],
  'bot.service.location_cooldown': [
    'تغییر لوکیشن زودتر از فاصلهٔ مجاز',
    'از آخرین تغییر لوکیشن کمتر از فاصلهٔ تعیین‌شدهٔ مدیر گذشته است؛ چیزی تغییر نکرد و مبلغی کسر نشد.',
  ],
  'bot.service.location_limit': [
    'سقف دفعات تغییر لوکیشن',
    'سرویس در این بازه به سقف دفعات مجاز تغییر لوکیشن رسیده است؛ چیزی تغییر نکرد و مبلغی کسر نشد.',
  ],

  // --- Customer refund requests -----------------------------------------------------
  'bot.service.refund_request_button': [
    'دکمهٔ درخواست بازگشت وجه',
    'درخواست بازگشت وجه برای سرویس را شروع می‌کند؛ فقط وقتی این قابلیت روشن و سرویس واجد شرایط است.',
  ],
  'bot.service.refund_request_ask': [
    'توضیح درخواست بازگشت وجه',
    'می‌گوید مبلغ را مدیر تعیین می‌کند، در صورت تأیید سرویس حذف و مبلغ به کیف پول واریز می‌شود.',
  ],
  'bot.service.refund_request_confirm_button': [
    'دکمهٔ تأیید درخواست بازگشت وجه',
    'درخواست را تأیید می‌کند و دلیل آن را می‌پرسد.',
  ],
  'bot.service.refund_request_reason_prompt': [
    'درخواست دلیل بازگشت وجه',
    'دلیل درخواست بازگشت وجه را از مشتری می‌پرسد.',
  ],
  'bot.service.refund_request_reason_invalid': [
    'دلیل بازگشت وجه نامعتبر',
    'طول دلیل خارج از محدودهٔ مجاز است؛ مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.service.refund_request_registered': [
    'درخواست بازگشت وجه ثبت شد',
    'درخواست ثبت شد؛ هنوز مبلغی جابه‌جا و سرویسی حذف نشده است.',
  ],
  'bot.service.refund_request_approved': [
    'درخواست بازگشت وجه تأیید شد',
    'سرویس حذف و مبلغ تأییدشده به کیف پول واریز شد؛ پس از انجام هر دو فرستاده می‌شود.',
  ],
  'bot.service.refund_request_rejected': [
    'درخواست بازگشت وجه رد شد (پیام به مشتری)',
    'مدیر درخواست را رد کرده است؛ همراه با دلیل. سرویس و مبلغی تغییر نکرده است.',
  ],
  'bot.service.refund_request_unavailable': [
    'ثبت درخواست بازگشت وجه ممکن نیست',
    'یک پیام برای همهٔ دلایلی که درخواست برای این سرویس ثبت نمی‌شود.',
  ],
  'bot.service.refund_request_pending': [
    'درخواست بازگشت وجه در حال بررسی',
    'برای این سرویس یک درخواست بازگشت وجه باز وجود دارد.',
  ],

  // --- Referral ---------------------------------------------------------------------
  'bot.referral.invite': [
    'لینک و کد دعوت',
    'لینک و کد دعوت مشتری برای اشتراک‌گذاری و تعداد کسانی که با آن عضو شده‌اند.',
  ],
  'bot.referral.unconfigured': ['برنامهٔ معرفی غیرفعال است', 'وقتی پاداش معرفی تنظیم نشده است.'],
  'bot.referral.button': [
    'دکمهٔ دعوت دوستان در کیف پول (بازنشسته)',
    'دیگر نمایش داده نمی‌شود؛ کیف پول فقط عملیات کیف پول را دارد و زیرمجموعه‌گیری از دکمهٔ خودش در منوی اصلی باز می‌شود.',
  ],
  'bot.referral.screen': [
    'صفحهٔ زیرمجموعه‌گیری (بازنشسته)',
    'دیگر فرستاده نمی‌شود؛ جای آن را «پیام دعوت زیرمجموعه‌گیری» و «آمار زیرمجموعه‌گیری» گرفته‌اند.',
  ],
  'bot.referral.invite_card': [
    'پیام دعوت زیرمجموعه‌گیری',
    'پیام اول زیرمجموعه‌گیری که مشتری برای دوستانش هدایت می‌کند: معرفی، درصد پورسانت و لینک دعوت، همراه با بنر اگر تنظیم شده باشد. هیچ آماری از خود مشتری در آن نیست.',
  ],
  'bot.referral.dashboard': [
    'آمار زیرمجموعه‌گیری',
    'پیام دوم زیرمجموعه‌گیری، فقط برای خود مشتری: شرایط هدیهٔ عضویت، پورسانت و آمار زیرمجموعه‌ها، با دکمه‌های اشتراک لینک، دریافت هدیه و بازگشت.',
  ],
  'bot.referral.scope_first_order': [
    'پورسانت فقط برای اولین خرید',
    'سطری از آمار زیرمجموعه‌گیری وقتی فقط اولین خرید هر زیرمجموعه پورسانت دارد.',
  ],
  'bot.referral.scope_every_order': [
    'پورسانت برای همهٔ خریدها',
    'سطری از آمار زیرمجموعه‌گیری وقتی همهٔ خریدهای زیرمجموعه پورسانت دارند.',
  ],
  'bot.referral.gift_block': [
    'بخش هدیهٔ عضویت',
    'شرایط هدیهٔ عضویت: مبلغ کل و سهم معرف و دعوت‌شونده.',
  ],
  'bot.referral.share_button': [
    'دکمهٔ اشتراک‌گذاری لینک دعوت',
    'صفحهٔ اشتراک‌گذاری تلگرام را با لینک دعوت باز می‌کند.',
  ],
  'bot.referral.gift_button': [
    'دکمهٔ دریافت هدیهٔ عضویت',
    'همهٔ سهم‌های دریافت‌نشدهٔ هدیهٔ عضویت را دریافت می‌کند؛ فقط وقتی هدیه فعال است.',
  ],
  'bot.referral.gift_claimed': [
    'هدیهٔ عضویت واریز شد',
    'مبلغی که با این درخواست به کیف پول واریز شد.',
  ],
  'bot.referral.gift_nothing': [
    'هدیهٔ عضویتی برای دریافت نیست',
    'مشتری معرفی‌شده نیست یا همهٔ سهم‌ها را قبلاً دریافت کرده است.',
  ],
  'bot.referral.gift_disabled': [
    'هدیهٔ عضویت غیرفعال است',
    'هدیهٔ عضویت خاموش است یا شرایط آن کامل تنظیم نشده است.',
  ],

  // --- Support and FAQ --------------------------------------------------------------
  'bot.faq.heading': ['عنوان پرسش‌های متداول', 'عنوان بالای پرسش‌های متداول فعال.'],
  'bot.faq.item': ['قالب هر پرسش متداول', 'نحوهٔ نمایش هر پرسش و پاسخ در صفحهٔ پرسش‌های متداول.'],
  'bot.faq.footer': [
    'پانویس پرسش‌های متداول',
    'خط پس از آخرین پرسش که مشتری را به پشتیبانی راهنمایی می‌کند.',
  ],
  'bot.faq.page': [
    'قالب هر پیام پرسش‌های متداول',
    'پوشش هر پیام از صفحهٔ پرسش‌های متداول که از عنوان، پرسش‌ها و پانویس ساخته می‌شود.',
  ],
  'bot.faq.default_1_question': [
    'پرسش متداول پیش‌فرض ۱ — پرسش',
    'پرسش نمونه که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود و پس از آن در بخش پشتیبانی ویرایش می‌شود.',
  ],
  'bot.faq.default_1_answer': ['پرسش متداول پیش‌فرض ۱ — پاسخ', 'پاسخ پرسش نمونهٔ ۱.'],
  'bot.faq.default_2_question': [
    'پرسش متداول پیش‌فرض ۲ — پرسش',
    'پرسش نمونهٔ ۲ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_2_answer': ['پرسش متداول پیش‌فرض ۲ — پاسخ', 'پاسخ پرسش نمونهٔ ۲.'],
  'bot.faq.default_3_question': [
    'پرسش متداول پیش‌فرض ۳ — پرسش',
    'پرسش نمونهٔ ۳ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_3_answer': ['پرسش متداول پیش‌فرض ۳ — پاسخ', 'پاسخ پرسش نمونهٔ ۳.'],
  'bot.faq.default_4_question': [
    'پرسش متداول پیش‌فرض ۴ — پرسش',
    'پرسش نمونهٔ ۴ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_4_answer': ['پرسش متداول پیش‌فرض ۴ — پاسخ', 'پاسخ پرسش نمونهٔ ۴.'],
  'bot.faq.default_5_question': [
    'پرسش متداول پیش‌فرض ۵ — پرسش',
    'پرسش نمونهٔ ۵ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_5_answer': ['پرسش متداول پیش‌فرض ۵ — پاسخ', 'پاسخ پرسش نمونهٔ ۵.'],
  'bot.faq.default_6_question': [
    'پرسش متداول پیش‌فرض ۶ — پرسش',
    'پرسش نمونهٔ ۶ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_6_answer': ['پرسش متداول پیش‌فرض ۶ — پاسخ', 'پاسخ پرسش نمونهٔ ۶.'],
  'bot.faq.default_7_question': [
    'پرسش متداول پیش‌فرض ۷ — پرسش',
    'پرسش نمونهٔ ۷ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_7_answer': ['پرسش متداول پیش‌فرض ۷ — پاسخ', 'پاسخ پرسش نمونهٔ ۷.'],
  'bot.faq.default_8_question': [
    'پرسش متداول پیش‌فرض ۸ — پرسش',
    'پرسش نمونهٔ ۸ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_8_answer': ['پرسش متداول پیش‌فرض ۸ — پاسخ', 'پاسخ پرسش نمونهٔ ۸.'],
  'bot.faq.default_9_question': [
    'پرسش متداول پیش‌فرض ۹ — پرسش',
    'پرسش نمونهٔ ۹ که یک بار در پرسش‌های متداول هر مجموعه کپی می‌شود.',
  ],
  'bot.faq.default_9_answer': ['پرسش متداول پیش‌فرض ۹ — پاسخ', 'پاسخ پرسش نمونهٔ ۹.'],
  'bot.support.contact_button': [
    'دکمهٔ پیام به پشتیبانی',
    'حساب تلگرام پشتیبانی را باز می‌کند؛ فقط وقتی حساب پشتیبانی تنظیم شده است.',
  ],
  'bot.support.contact': [
    'صفحهٔ تماس با پشتیبانی',
    'وقتی پرسش متداول فعالی نیست، فقط راه تماس با پشتیبانی نمایش داده می‌شود.',
  ],
  'bot.support.unconfigured': [
    'پشتیبانی تنظیم نشده',
    'هیچ حساب پشتیبانی تنظیم نشده است و این را صریح می‌گوید.',
  ],
  'bot.support.tickets_button': [
    'دکمهٔ تیکت‌ها در صفحهٔ پشتیبانی',
    'در صفحهٔ پشتیبانی و پاسخ /paysupport، فهرست تیکت‌های مشتری را باز می‌کند.',
  ],

  // --- Support tickets --------------------------------------------------------------
  'bot.ticket.list': [
    'فهرست تیکت‌های مشتری',
    'سرتیتر فهرست تیکت‌های مشتری؛ برای هر تیکت یک دکمه و سپس دکمهٔ تیکت جدید می‌آید.',
  ],
  'bot.ticket.list_empty': [
    'فهرست خالی تیکت‌ها',
    'وقتی مشتری هنوز تیکتی ثبت نکرده است؛ فقط دکمهٔ تیکت جدید دارد.',
  ],
  'bot.ticket.list_item_button': [
    'دکمهٔ یک تیکت در فهرست',
    'هر تیکت در فهرست: وضعیت، شماره و موضوع آن.',
  ],
  'bot.ticket.new_button': ['دکمهٔ تیکت جدید', 'ثبت تیکت تازه را با انتخاب موضوع شروع می‌کند.'],
  'bot.ticket.back_button': ['دکمهٔ بازگشت به تیکت‌ها', 'مشتری را به فهرست تیکت‌هایش برمی‌گرداند.'],
  'bot.ticket.choose_category': [
    'انتخاب موضوع تیکت',
    'از مشتری می‌خواهد موضوع تیکت تازه را انتخاب کند؛ برای هر دستهٔ فعال یک دکمه می‌آید.',
  ],
  'bot.ticket.category_button': [
    'دکمهٔ یک موضوع تیکت',
    'یک دستهٔ تیکت، با همان نامی که مدیر در پنل گذاشته است.',
  ],
  'bot.ticket.no_categories': [
    'ثبت تیکت فعلاً ممکن نیست',
    'هیچ دستهٔ فعالی وجود ندارد، پس تیکت تازه‌ای ثبت نمی‌شود.',
  ],
  'bot.ticket.message_prompt': [
    'درخواست نخستین پیام تیکت',
    'پس از انتخاب موضوع، نخستین پیام تیکت را می‌خواهد؛ متن یا عکس و فایل همراه با توضیح.',
  ],
  'bot.ticket.reply_prompt': [
    'درخواست پاسخ مشتری به تیکت',
    'پاسخ مشتری به یک تیکت را می‌خواهد؛ متن یا عکس و فایل.',
  ],
  'bot.ticket.message_invalid': [
    'پیام تیکت نامعتبر',
    'پیام خالی یا بلندتر از حد مجاز بود؛ مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.ticket.attachment_too_large': [
    'فایل تیکت بیش از حد بزرگ',
    'حجم فایل پیوست بیش از حد مجاز است؛ چیزی ذخیره نشد و مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.ticket.attachment_type_refused': [
    'نوع فایل تیکت پذیرفته نیست',
    'نوع فایل پیوست پذیرفته نمی‌شود؛ چیزی ذخیره نشد و مشتری می‌تواند دوباره بفرستد.',
  ],
  'bot.ticket.created': [
    'تیکت ثبت شد',
    'تیکت تازه ثبت شده است و پاسخ پشتیبانی در همین ربات می‌رسد.',
  ],
  'bot.ticket.reply_sent': ['پیام مشتری به تیکت افزوده شد', 'پاسخ مشتری به تیکت ثبت شد.'],
  'bot.ticket.open_limit': [
    'سقف تیکت‌های باز',
    'مشتری بیشترین تعداد تیکت باز مجاز را دارد و تیکت تازه ثبت نمی‌شود.',
  ],
  'bot.ticket.message_limit': [
    'سقف پیام‌های تیکت',
    'این تیکت به بیشترین تعداد پیام مجاز رسیده است؛ مشتری باید تیکت تازه ثبت کند.',
  ],
  'bot.ticket.view': [
    'گفتگوی یک تیکت',
    'سرتیتر تیکت (شماره، موضوع، وضعیت) و آخرین پیام‌های گفتگو در ربات.',
  ],
  'bot.ticket.view_older': [
    'خط پیام‌های قدیمی‌تر تیکت',
    'می‌گوید چند پیام قدیمی‌تر در نمای ربات نیامده و در پنل پشتیبانی نگه داشته شده است.',
  ],
  'bot.ticket.line_customer': [
    'پیام مشتری در گفتگوی تیکت',
    'یک پیام خود مشتری در نمای گفتگوی تیکت.',
  ],
  'bot.ticket.line_support': [
    'پیام پشتیبانی در گفتگوی تیکت',
    'یک پیام پشتیبانی در نمای گفتگوی تیکت.',
  ],
  'bot.ticket.line_closed_by_customer': [
    'خط بستن تیکت توسط مشتری',
    'در گفتگو ثبت می‌کند که مشتری تیکت را بسته است.',
  ],
  'bot.ticket.line_closed_by_support': [
    'خط بستن تیکت توسط پشتیبانی',
    'در گفتگو ثبت می‌کند که پشتیبانی تیکت را بسته است.',
  ],
  'bot.ticket.line_reopened': [
    'خط بازگشایی تیکت',
    'در گفتگو ثبت می‌کند که پشتیبانی تیکت را دوباره باز کرده است.',
  ],
  'bot.ticket.attachment_marker': [
    'نشانهٔ پیوست در گفتگو',
    'کنار پیامی می‌آید که فایل یا عکس پیوست دارد.',
  ],
  'bot.ticket.reply_button': [
    'دکمهٔ ارسال پاسخ به تیکت',
    'پنجرهٔ پاسخ مشتری به تیکت را باز می‌کند.',
  ],
  'bot.ticket.close_button': [
    'دکمهٔ بستن تیکت',
    'می‌پرسد آیا مشتری تیکت را می‌بندد؛ هنوز چیزی ثبت نمی‌شود.',
  ],
  'bot.ticket.close_ask': ['پرسش پیش از بستن تیکت', 'پیش از بستن تیکت توسط مشتری، تأیید می‌خواهد.'],
  'bot.ticket.close_confirm_button': ['دکمهٔ تأیید بستن تیکت', 'تیکت را می‌بندد.'],
  'bot.ticket.closed': ['تیکت بسته شد', 'مشتری تیکت خود را بسته است.'],
  'bot.ticket.already_closed': [
    'تیکت از قبل بسته است',
    'پیام یا درخواست بستن برای تیکتی که بسته شده است؛ مشتری باید تیکت تازه ثبت کند.',
  ],
  'bot.ticket.not_found': [
    'تیکت پیدا نشد',
    'تیکت وجود ندارد یا متعلق به این مشتری یا این ربات نیست.',
  ],
  'bot.ticket.status_open': ['برچسب وضعیت: باز', 'برچسب تیکتی که هنوز پاسخی نگرفته است.'],
  'bot.ticket.status_waiting_for_customer': [
    'برچسب وضعیت: منتظر پاسخ مشتری',
    'برچسب تیکتی که پشتیبانی به آن پاسخ داده و منتظر مشتری است.',
  ],
  'bot.ticket.status_waiting_for_support': [
    'برچسب وضعیت: در انتظار پشتیبانی',
    'برچسب تیکتی که مشتری در آن نوشته و منتظر پشتیبانی است.',
  ],
  'bot.ticket.status_closed': ['برچسب وضعیت: بسته‌شده', 'برچسب تیکت بسته‌شده.'],
  'bot.ticket.support_replied': [
    'پاسخ پشتیبانی به تیکت (اعلان به مشتری)',
    'وقتی پشتیبانی در پنل پاسخ می‌دهد برای مشتری فرستاده می‌شود؛ متن پاسخ هنگام ارسال از خود تیکت خوانده می‌شود.',
  ],
  'bot.ticket.support_attachment': [
    'پیوست پاسخ پشتیبانی (اعلان به مشتری)',
    'زیرنویس عکس یا فایلی که پشتیبانی همراه پاسخ فرستاده است؛ جدا از متن پاسخ برای مشتری ارسال می‌شود.',
  ],
  'bot.ticket.view_button': ['دکمهٔ مشاهدهٔ تیکت', 'در اعلان پاسخ پشتیبانی، تیکت را باز می‌کند.'],
  'bot.ticket.category_default_1': [
    'دستهٔ پیش‌فرض تیکت ۱',
    'دستهٔ نمونهٔ ۱ که نخستین بار در دسته‌های تیکت هر مجموعه کپی می‌شود.',
  ],
  'bot.ticket.category_default_2': [
    'دستهٔ پیش‌فرض تیکت ۲',
    'دستهٔ نمونهٔ ۲ که نخستین بار در دسته‌های تیکت هر مجموعه کپی می‌شود.',
  ],
  'bot.ticket.category_default_3': [
    'دستهٔ پیش‌فرض تیکت ۳',
    'دستهٔ نمونهٔ ۳ که نخستین بار در دسته‌های تیکت هر مجموعه کپی می‌شود.',
  ],
  'bot.ticket.category_default_4': [
    'دستهٔ پیش‌فرض تیکت ۴',
    'دستهٔ نمونهٔ ۴ که نخستین بار در دسته‌های تیکت هر مجموعه کپی می‌شود.',
  ],
  'bot.ticket.category_default_5': [
    'دستهٔ پیش‌فرض تیکت ۵',
    'دستهٔ نمونهٔ ۵ که نخستین بار در دسته‌های تیکت هر مجموعه کپی می‌شود.',
  ],

  // --- Telegram admin: general ------------------------------------------------------
  'bot.menu.admin': [
    'دکمهٔ پنل مدیریت در منو',
    'دکمهٔ منوی اصلی که فقط برای مدیران دارای دسترسی نمایش داده می‌شود و پنل مدیریت را باز می‌کند.',
  ],
  'bot.admin.panel': [
    'صفحهٔ اصلی پنل مدیریت تلگرام',
    'صفحهٔ آغازین پنل مدیریت در ربات؛ بخش‌ها بر اساس دسترسی هر مدیر نمایش داده می‌شوند.',
  ],

  // --- Telegram admin: receipts -----------------------------------------------------
  'bot.admin.receipts_button': [
    'دکمهٔ رسیدهای تأییدنشده',
    'صف پرداخت‌های کارت‌به‌کارتِ منتظر تصمیم را باز می‌کند.',
  ],
  'bot.admin.receipts_list': ['عنوان صف رسیدها', 'عنوان بالای فهرست پرداخت‌های منتظر بررسی.'],
  'bot.admin.receipts_none': ['صف رسیدها خالی است', 'وقتی هیچ پرداختی منتظر بررسی نیست.'],
  'bot.admin.receipt': [
    'کارت بررسی رسید',
    'توضیح زیر تصویر رسید برای مدیر: نوع عملیات، مبلغ، مشتری و یادداشت او، همراه با دکمه‌های تصمیم.',
  ],
  'bot.admin.receipt_balance': [
    'موجودی مشتری در کارت رسید',
    'نحوهٔ نمایش موجودی کیف پول مشتری داخل کارت بررسی رسید.',
  ],
  'bot.admin.receipt_duration': [
    'مدت سرویس در کارت رسید',
    'نحوهٔ نمایش مدت سرویس سفارش داخل کارت بررسی رسید.',
  ],
  'bot.admin.receipt_traffic': [
    'حجم سرویس در کارت رسید',
    'نحوهٔ نمایش حجم سرویس سفارش داخل کارت بررسی رسید.',
  ],
  'bot.admin.receipt_awaiting': [
    'اعلان رسید تازه به مدیران',
    'هنگام ثبت رسید تازه به هر مدیری که اجازهٔ بررسی دارد فرستاده می‌شود؛ کد پیگیری و مبلغ را می‌گوید.',
  ],
  'bot.admin.operation_new_service': [
    'برچسب عملیات: خرید سرویس جدید',
    'نوع عملیات در کارت رسید برای خرید سرویس تازه.',
  ],
  'bot.admin.operation_custom_service': [
    'برچسب عملیات: خرید سرویس دلخواه',
    'نوع عملیات در کارت رسید برای خرید سرویس دلخواه.',
  ],
  'bot.admin.operation_renew': ['برچسب عملیات: تمدید', 'نوع عملیات در کارت رسید برای تمدید سرویس.'],
  'bot.admin.operation_add_traffic': [
    'برچسب عملیات: افزایش حجم',
    'نوع عملیات در کارت رسید برای خرید حجم اضافه.',
  ],
  'bot.admin.operation_add_time': [
    'برچسب عملیات: افزایش زمان',
    'نوع عملیات در کارت رسید برای خرید زمان اضافه.',
  ],
  'bot.admin.operation_add_devices': [
    'برچسب عملیات: افزایش کاربر / دستگاه',
    'نوع عملیات در کارت رسید برای خرید کاربر یا دستگاه اضافه.',
  ],
  'bot.admin.operation_change_location': [
    'برچسب عملیات: تغییر لوکیشن',
    'نوع عملیات در کارت رسید برای تغییر لوکیشن پولی سرویس موجود.',
  ],
  'bot.admin.operation_topup': [
    'برچسب عملیات: شارژ کیف پول',
    'نوع عملیات در کارت رسید برای شارژ کیف پول.',
  ],
  'bot.admin.receipt_already_approved': [
    'رسید قبلاً تأیید شده',
    'مدیر روی دکمهٔ رسیدی زده که قبلاً تأیید شده است؛ چیزی تغییر نمی‌کند.',
  ],
  'bot.admin.receipt_already_rejected': [
    'رسید قبلاً رد شده',
    'مدیر روی دکمهٔ رسیدی زده که قبلاً رد شده است؛ چیزی تغییر نمی‌کند.',
  ],
  'bot.admin.receipt_already_credited': [
    'رسید قبلاً به کیف پول واریز شده',
    'رسید قبلاً با واریز به کیف پول بسته شده است؛ مبلغ واریزشده را می‌گوید.',
  ],
  'bot.admin.receipt_gone': [
    'رسید دیگر منتظر بررسی نیست',
    'پرداخت پس از نمایش پیام، تأیید، رد، لغو یا منقضی شده است.',
  ],
  'bot.admin.approve_button': [
    'دکمهٔ تأیید پرداخت',
    'انتقال را تأیید می‌کند؛ از همان مسیری که پنل وب استفاده می‌کند.',
  ],
  'bot.admin.reject_button': [
    'دکمهٔ رد پرداخت',
    'رد انتقال را شروع می‌کند؛ پیش از رد، دلیل پرسیده می‌شود.',
  ],
  'bot.admin.approved': [
    'پرداخت تأیید شد (پیام به مدیر)',
    'به مدیر اعلام می‌کند تصمیم تأیید ثبت شد.',
  ],
  'bot.admin.rejected': [
    'پرداخت رد شد (پیام به مدیر)',
    'به مدیر اعلام می‌کند تصمیم رد ثبت شد و مشتری از طریق اعلان‌ها باخبر می‌شود.',
  ],
  'bot.admin.review_approved': [
    'نتیجهٔ بررسی رسید: تأیید',
    'پیام اصلی بررسی رسید پس از تأیید پرداخت به این متن تبدیل می‌شود و دکمه‌هایش حذف می‌شود.',
  ],
  'bot.admin.review_rejected': [
    'نتیجهٔ بررسی رسید: رد',
    'پیام اصلی بررسی رسید پس از رد پرداخت به این متن تبدیل می‌شود و دکمه‌هایش حذف می‌شود.',
  ],
  'bot.admin.review_blocked': [
    'نتیجهٔ بررسی رسید: بلاک کاربر',
    'پیام اصلی بررسی رسید پس از بلاک کردن مشتری به این متن تبدیل می‌شود؛ خود رسید همچنان در صف بررسی می‌ماند.',
  ],
  'bot.admin.review_credited': [
    'نتیجهٔ بررسی رسید: واریز به کیف پول',
    'پیام اصلی بررسی رسید پس از واریز مبلغ به کیف پول مشتری به این متن تبدیل می‌شود و دکمه‌هایش حذف می‌شود.',
  ],
  'bot.admin.review_final': [
    'سابقهٔ نهایی بررسی رسید',
    'پیام اصلی بررسی رسید پس از تصمیم به این سابقهٔ کامل تبدیل می‌شود: خط نتیجه، نوع عملیات، محصول، نام کاربری سرویس، شناسه و یوزرنیم تلگرام مشتری، مبلغ و کد پیگیری، و برای واریز به کیف پول موجودی پیش و پس از آن. سطری که مقداری ندارد حذف می‌شود.',
  ],
  'bot.admin.review_final_short': [
    'سابقهٔ نهایی بررسی رسید (نسخهٔ کوتاه)',
    'وقتی سابقهٔ کامل در توضیح عکس رسید جا نشود (بیش از ۱۰۲۴ نویسه)، توضیح عکس به این متن کوتاه تبدیل می‌شود و سابقهٔ کامل به‌صورت پاسخ به همان پیام فرستاده می‌شود.',
  ],
  'bot.admin.review_repeat_approved': [
    'پاسخ دکمهٔ تکراری: قبلاً تأیید شده',
    'وقتی روی پیامی که قبلاً نهایی شده دوباره دکمه‌ای زده شود و پرداخت تأیید شده باشد، همین متن کوتاه نشان داده می‌شود و کاری تکرار نمی‌شود.',
  ],
  'bot.admin.review_repeat_rejected': [
    'پاسخ دکمهٔ تکراری: قبلاً رد شده',
    'وقتی روی پیامی که قبلاً نهایی شده دوباره دکمه‌ای زده شود و پرداخت رد شده باشد، همین متن کوتاه نشان داده می‌شود.',
  ],
  'bot.admin.review_repeat_credited': [
    'پاسخ دکمهٔ تکراری: قبلاً به کیف پول واریز شده',
    'وقتی روی پیامی که قبلاً نهایی شده دوباره دکمه‌ای زده شود و رسید با واریز به کیف پول بسته شده باشد؛ چیزی دوباره واریز نمی‌شود.',
  ],
  'bot.admin.review_repeat_blocked': [
    'پاسخ دکمهٔ تکراری: کاربر قبلاً بلاک شده',
    'وقتی روی پیامی که با بلاک کردن مشتری نهایی شده دوباره دکمه‌ای زده شود و پرداخت هنوز تصمیمی نگرفته باشد.',
  ],
  'bot.admin.review_repeat_gone': [
    'پاسخ دکمهٔ تکراری: دیگر در انتظار بررسی نیست',
    'وقتی روی پیامی که قبلاً نهایی شده دوباره دکمه‌ای زده شود و پرداخت به هر دلیل دیگری دیگر در انتظار بررسی نباشد.',
  ],
  'bot.admin.reject_reason_prompt': [
    'درخواست دلیل رد پرداخت',
    'دلیل اجباری رد را از مدیر می‌خواهد؛ هنوز چیزی رد نشده است.',
  ],
  'bot.admin.reject_reason_invalid': [
    'دلیل رد پرداخت نامعتبر',
    'دلیل خالی یا بیش از حد طولانی است؛ منتظر پیام بعدی می‌ماند.',
  ],
  'bot.admin.reject_confirm': [
    'تأیید نهایی رد پرداخت',
    'پرداخت و دلیل را پیش از ثبت رد نشان می‌دهد و می‌گوید دلیل برای مشتری فرستاده می‌شود.',
  ],
  'bot.admin.reject_confirm_button': [
    'دکمهٔ ثبت رد پرداخت',
    'پرداخت را با دلیل نوشته‌شده رد می‌کند.',
  ],
  'bot.admin.reject_cancel_button': [
    'دکمهٔ انصراف از رد پرداخت',
    'رد را رها می‌کند؛ رسید در صف می‌ماند.',
  ],
  'bot.admin.reject_cancelled': [
    'رد پرداخت لغو شد',
    'مدیر رد را رها کرد؛ چیزی جابه‌جا نشده و رسید همچنان در صف است.',
  ],
  'bot.admin.reject_expired': [
    'مهلت نوشتن دلیل رد تمام شد',
    'مهلت پاسخ گذشت و پرداخت رد نشد؛ باید از رسید دوباره شروع کرد.',
  ],
  'bot.admin.credit_button': [
    'دکمهٔ واریز رسید به کیف پول',
    'تصمیم سوم برای رسید: واریز مبلغی که مدیر وارد می‌کند به کیف پول مشتری.',
  ],
  'bot.admin.credit_amount_prompt': [
    'درخواست مبلغ واریز به کیف پول',
    'مبلغ دقیق واریز را از مدیر می‌پرسد؛ فقط پیام بعدی همین مدیر برای مدت محدود خوانده می‌شود.',
  ],
  'bot.admin.credit_amount_invalid': [
    'مبلغ واریز نامعتبر',
    'پیام مدیر مبلغ قابل قبولی نیست؛ منتظر پیام بعدی می‌ماند.',
  ],
  'bot.admin.credit_confirm': [
    'تأیید نهایی واریز به کیف پول',
    'پیش از واریز، مبلغ، مشتری و پرداخت را دقیق نشان می‌دهد.',
  ],
  'bot.admin.credit_confirm_button': [
    'دکمهٔ تأیید واریز به کیف پول',
    'واریز اعلام‌شده را انجام می‌دهد.',
  ],
  'bot.admin.credit_cancel_button': [
    'دکمهٔ انصراف از واریز',
    'واریز را رها می‌کند؛ رسید در صف می‌ماند.',
  ],
  'bot.admin.credited': [
    'واریز به کیف پول انجام شد',
    'مبلغ به کیف پول مشتری واریز و پرداخت بسته شد؛ سفارش با آن تسویه نشده است.',
  ],
  'bot.admin.credit_cancelled': [
    'واریز لغو شد',
    'مدیر واریز را رها کرد؛ مبلغی جابه‌جا نشده و رسید همچنان در صف است.',
  ],
  'bot.admin.credit_expired': [
    'مهلت وارد کردن مبلغ تمام شد',
    'مهلت پاسخ مدیر برای مبلغ واریز گذشت؛ باید از رسید دوباره شروع کند.',
  ],
  'bot.admin.credit_no_receipt': [
    'واریز بدون رسید ممکن نیست',
    'برای پرداختی که رسید ندارد، واریز به کیف پول ممکن نیست.',
  ],
  'bot.admin.credit_currency': [
    'واحد پول رسید پشتیبانی نمی‌شود',
    'واحد پول این پرداخت دیگر واحد فروش نیست و واریز آن ممکن نیست؛ تأیید یا رد همچنان ممکن است.',
  ],
  'bot.admin.block_button': [
    'دکمهٔ بلاک کاربر از روی رسید',
    'دکمهٔ چهارم رسید برای مسدود کردن مشتری فرستنده.',
  ],
  'bot.admin.block_ask': [
    'پرسش بلاک کاربر از روی رسید',
    'پیش از بلاک، مشتری را نام می‌برد و می‌گوید رسید تأیید، رد یا واریز نمی‌شود.',
  ],
  'bot.admin.block_yes_button': [
    'دکمهٔ ادامهٔ بلاک و نوشتن دلیل',
    'قصد بلاک را تأیید و دلیل را درخواست می‌کند؛ هنوز چیزی ثبت نمی‌شود.',
  ],
  'bot.admin.block_cancel_button': [
    'دکمهٔ انصراف از بلاک (رسید)',
    'بلاک را رها می‌کند؛ وضعیت مشتری تغییری نمی‌کند.',
  ],
  'bot.admin.block_reason_prompt': [
    'درخواست دلیل بلاک (رسید)',
    'دلیل اجباری بلاک را از مدیر می‌خواهد؛ فقط پیام بعدی همین مدیر برای چند دقیقه خوانده می‌شود.',
  ],
  'bot.admin.block_reason_invalid': [
    'دلیل بلاک نامعتبر (رسید)',
    'دلیل خالی یا بیش از حد طولانی است؛ منتظر پیام بعدی می‌ماند.',
  ],
  'bot.admin.block_confirm': [
    'تأیید نهایی بلاک (رسید)',
    'مشتری و دلیل را پیش از ثبت بلاک دوباره نشان می‌دهد.',
  ],
  'bot.admin.block_confirm_button': ['دکمهٔ ثبت بلاک (رسید)', 'بلاک را ثبت می‌کند.'],
  'bot.admin.blocked_from_receipt': [
    'کاربر از روی رسید بلاک شد',
    'مشتری بلاک شد، اما رسید هنوز بررسی نشده و در صف است.',
  ],
  'bot.admin.block_already': [
    'کاربر از قبل بلاک بوده (رسید)',
    'مشتری از قبل مسدود بوده و دلیل قبلی تغییری نکرد؛ رسید همچنان منتظر تصمیم است.',
  ],
  'bot.admin.block_cancelled': ['بلاک لغو شد (رسید)', 'بلاک رها شد و وضعیت مشتری تغییری نکرد.'],
  'bot.admin.block_expired': [
    'مهلت نوشتن دلیل بلاک تمام شد (رسید)',
    'مهلت پاسخ گذشت و چیزی ثبت نشد؛ باید از رسید دوباره شروع کرد.',
  ],

  // --- Telegram admin: services -----------------------------------------------------
  'bot.admin.services_button': [
    'دکمهٔ بخش سرویس‌ها (مدیریت)',
    'بخش سرویس‌های نیازمند رسیدگی را در پنل مدیریت باز می‌کند.',
  ],
  'bot.admin.services_section': [
    'صفحهٔ سرویس‌های نیازمند رسیدگی',
    'دو صف را معرفی می‌کند: سرویس‌هایی با وضعیت نامعلوم روی پنل و سرویس‌هایی که لینکشان تحویل نشد.',
  ],
  'bot.admin.services_none': ['هیچ سرویسی رسیدگی نمی‌خواهد', 'وقتی هر دو صف سرویس‌ها خالی است.'],
  'bot.admin.services_browse_button': [
    'دکمهٔ همهٔ سرویس‌ها (مدیریت)',
    'فهرست کامل سرویس‌ها را کنار صف رسیدگی باز می‌کند.',
  ],
  'bot.admin.services_browse': [
    'فهرست همهٔ سرویس‌ها (مدیریت)',
    'فهرست سرویس‌ها از تازه‌ترین، یک دکمه برای هر سرویس.',
  ],
  'bot.admin.services_browse_none': [
    'سرویسی برای نمایش نیست (مدیریت)',
    'سرویسی در این مجموعه یا در ادامهٔ این صفحه نیست.',
  ],
  'bot.admin.services_more_button': [
    'دکمهٔ صفحهٔ بعد سرویس‌ها (مدیریت)',
    'صفحهٔ بعد فهرست سرویس‌ها در پنل مدیریت.',
  ],
  'bot.admin.services_back_button': [
    'دکمهٔ بازگشت به بخش سرویس‌ها',
    'از یک سرویس به بخش سرویس‌های پنل مدیریت برمی‌گرداند.',
  ],
  'bot.admin.service': [
    'جزئیات سرویس برای مدیر',
    'اطلاعات یک سرویس در پنل مدیریت تلگرام: مشتری، پنل، وضعیت، مصرف، انقضا و آخرین عملیات؛ بدون لینک اشتراک.',
  ],
  'bot.admin.service_gone': [
    'سرویس پیدا نشد (مدیریت)',
    'سرویس متعلق به این مجموعه نیست یا دیگر وجود ندارد.',
  ],
  'bot.admin.service_sync_button': [
    'دکمهٔ خواندن مصرف از پنل',
    'مصرف سرویس را دوباره از پنل می‌خواند.',
  ],
  'bot.admin.service_resend_button': [
    'دکمهٔ ارسال مجدد لینک به مشتری',
    'لینک و تنظیمات سرویس را دوباره برای مشتری می‌فرستد.',
  ],
  'bot.admin.service_retry_button': [
    'دکمهٔ تلاش مجدد برای ساخت سرویس',
    'ساخت دوبارهٔ حساب روی پنل را درخواست می‌کند؛ سرویس با وضعیت نامعلوم ابتدا تطبیق داده می‌شود.',
  ],
  'bot.admin.service_reconcile_button': [
    'دکمهٔ تطبیق سرویس با پنل',
    'وضعیت نامعلوم سرویس را با پنل تطبیق می‌دهد تا بدون ساخت حساب تکراری روشن شود.',
  ],
  'bot.admin.service_suspend_button': [
    'دکمهٔ غیرفعال کردن سرویس (مدیریت)',
    'حساب را روی پنل موقتاً غیرفعال می‌کند.',
  ],
  'bot.admin.service_resume_button': [
    'دکمهٔ فعال کردن سرویس (مدیریت)',
    'حساب غیرفعال‌شده را دوباره فعال می‌کند.',
  ],
  'bot.admin.service_rotate_link_button': [
    'دکمهٔ لینک اشتراک جدید (مدیریت)',
    'درخواست ساخت لینک اشتراک جدید برای مشتری را شروع می‌کند؛ نیاز به تأیید دوم دارد.',
  ],
  'bot.admin.service_rotate_link_ask': [
    'پرسش تأیید لینک اشتراک جدید (مدیریت)',
    'می‌گوید پنل لینک تازه می‌سازد و برای مشتری فرستاده می‌شود.',
  ],
  'bot.admin.service_rotate_link_confirm_button': [
    'دکمهٔ تأیید ساخت لینک جدید (مدیریت)',
    'تنها دکمه‌ای که از پنل لینک تازه می‌خواهد.',
  ],
  'bot.admin.service_terminate_button': [
    'دکمهٔ پایان دادن به سرویس (مدیریت)',
    'درخواست پایان سرویس را شروع می‌کند؛ نیاز به تأیید دوم دارد.',
  ],
  'bot.admin.service_terminate_ask': [
    'پرسش تأیید پایان سرویس (مدیریت)',
    'می‌گوید حساب مشتری روی پنل حذف می‌شود و برگشت‌پذیر نیست.',
  ],
  'bot.admin.service_terminate_confirm_button': [
    'دکمهٔ تأیید پایان سرویس (مدیریت)',
    'تنها دکمه‌ای که حساب را روی پنل حذف می‌کند.',
  ],
  'bot.admin.service_planned': [
    'درخواست مدیر روی سرویس ثبت شد',
    'درخواست ثبت شده ولی هنوز روی پنل اعمال نشده است؛ نتیجه بعداً مشخص می‌شود.',
  ],
  'bot.admin.service_resent': [
    'لینک برای مشتری فرستاده شد',
    'تنظیمات سرویس دوباره برای مشتری فرستاده شد.',
  ],
  'bot.admin.service_unavailable': [
    'این کار روی سرویس ممکن نیست (مدیریت)',
    'یک پیام برای همهٔ دلایل؛ دلیل دقیق در پنل وب دیده می‌شود.',
  ],
  'bot.admin.service_customer_button': [
    'دکمهٔ مشتری این سرویس',
    'صفحهٔ مشتری صاحب سرویس را باز می‌کند؛ فقط برای مدیر دارای دسترسی مشتری‌ها.',
  ],
  'bot.admin.service_ambiguous': [
    'یوزرنیم مشترک بین چند سرویس',
    'نام کاربری جست‌وجوشده روی بیش از یک سرویس است؛ همهٔ موارد را نشان می‌دهد.',
  ],
  'bot.admin.service_usage': [
    'راهنمای دستور /service',
    'دستور /service بدون مقدار درست فرستاده شده؛ شکل درست آن را تکرار می‌کند.',
  ],

  // --- Telegram admin: reminders ----------------------------------------------------
  'bot.admin.reminders_button': [
    'دکمهٔ تنظیمات یادآور',
    'بخش تنظیمات یادآور سرویس را از پنل مدیریت باز می‌کند.',
  ],
  'bot.admin.reminders_section': [
    'صفحهٔ تنظیمات یادآور',
    'همهٔ تنظیمات و کلیدهای یادآور سرویس را با مقدار فعلی نشان می‌دهد.',
  ],
  'bot.admin.reminder_expiry_first_button': [
    'دکمهٔ یادآور اول انقضا',
    'انتخاب تعداد روزِ یادآور اول انقضا را باز می‌کند.',
  ],
  'bot.admin.reminder_expiry_second_button': [
    'دکمهٔ یادآور دوم انقضا',
    'انتخاب تعداد روزِ یادآور دوم انقضا را باز می‌کند.',
  ],
  'bot.admin.reminder_usage_first_button': [
    'دکمهٔ آستانهٔ اول مصرف',
    'انتخاب درصد آستانهٔ اول مصرف را باز می‌کند.',
  ],
  'bot.admin.reminder_usage_second_button': [
    'دکمهٔ آستانهٔ دوم مصرف',
    'انتخاب درصد آستانهٔ دوم مصرف را باز می‌کند.',
  ],
  'bot.admin.reminder_usage_final_button': [
    'دکمهٔ آستانهٔ پایانی مصرف',
    'انتخاب درصد آستانهٔ پایانی مصرف را باز می‌کند.',
  ],
  'bot.admin.reminder_choose': [
    'انتخاب مقدار تازهٔ یادآور',
    'یک تنظیم، مقدار فعلی آن و مقدارهای قابل انتخاب را نشان می‌دهد.',
  ],
  'bot.admin.reminder_saved': [
    'تنظیم یادآور ذخیره شد',
    'مقداری را که اکنون ذخیره شده است نام می‌برد.',
  ],
  'bot.admin.reminder_refused': [
    'تنظیم یادآور پذیرفته نشد',
    'این ترکیب مقدارها مجاز نیست؛ دلیل دقیق را می‌گوید.',
  ],

  // --- Telegram admin: panels and username policy -----------------------------------
  'bot.admin.panels_button': [
    'دکمهٔ بخش پنل‌ها',
    'بخش پنل‌ها را در پنل مدیریت باز می‌کند؛ فقط برای مدیر دارای دسترسی پنل‌ها.',
  ],
  'bot.admin.panels_section': [
    'فهرست پنل‌ها',
    'پنل‌های در سرویس را از تازه‌ترین، یک دکمه برای هر پنل، نشان می‌دهد.',
  ],
  'bot.admin.panels_none': [
    'هیچ پنلی در سرویس نیست',
    'می‌گوید پنل‌ها در پنل وب ساخته می‌شوند، چون اطلاعات ورود در گفت‌وگو وارد نمی‌شود.',
  ],
  'bot.admin.panels_more_button': ['دکمهٔ صفحهٔ بعد پنل‌ها', 'صفحهٔ بعد فهرست پنل‌ها.'],
  'bot.admin.panel_detail': [
    'جزئیات پنل',
    'نام، نوع، وضعیت، سلامت، ظرفیت و تنظیمات یوزرنیم یک پنل.',
  ],
  'bot.admin.panel_gone': ['پنل پیدا نشد', 'پنل متعلق به این مجموعه نیست یا دیگر وجود ندارد.'],
  'bot.admin.panel_test_button': [
    'دکمهٔ تست اتصال پنل',
    'اتصال به پنل را آزمایش می‌کند؛ فقط برای مدیر دارای اجازهٔ ویرایش پنل.',
  ],
  'bot.admin.panel_tested': ['تست اتصال انجام شد', 'تست واقعی انجام شد و سلامت پنل به‌روز شد.'],
  'bot.admin.panel_test_replayed': [
    'تست تازه انجام نشد',
    'همین درخواست قبلاً انجام شده یا پنل به‌تازگی بررسی شده است؛ سلامت ذخیره‌شده نمایش داده می‌شود.',
  ],
  'bot.admin.panel_enable_button': [
    'دکمهٔ بازگرداندن پنل به سرویس',
    'پنل غیرفعال را دوباره به سرویس برمی‌گرداند؛ نیاز به تست اتصال موفق دارد.',
  ],
  'bot.admin.panel_disable_button': [
    'دکمهٔ خارج کردن پنل از سرویس',
    'فروش تازه روی پنل و پایش آن را متوقف می‌کند؛ به سرویس‌های موجود دست نمی‌زند.',
  ],
  'bot.admin.panel_enabled': [
    'پنل به سرویس برگشت',
    'پنل دوباره قابل فروش است و پایش آن از سر گرفته شد.',
  ],
  'bot.admin.panel_disabled': [
    'پنل از سرویس خارج شد',
    'فروش تازه متوقف شد ولی سرویس‌های موجود روی پنل کار می‌کنند.',
  ],
  'bot.admin.panel_not_validated': [
    'نیاز به تست اتصال موفق',
    'بازگرداندن پنل رد شد چون تست اتصال موفقی برای تنظیمات فعلی آن نیست.',
  ],
  'bot.admin.panel_archive_button': [
    'دکمهٔ بایگانی پنل',
    'پرسش تأیید بایگانی را باز می‌کند؛ خودش چیزی را تغییر نمی‌دهد.',
  ],
  'bot.admin.panel_archive_ask': [
    'پرسش تأیید بایگانی پنل',
    'می‌گوید بایگانی چه می‌کند و چه نمی‌کند؛ سرویس‌های موجود پایان نمی‌یابند.',
  ],
  'bot.admin.panel_archive_confirm_button': [
    'دکمهٔ تأیید بایگانی پنل',
    'تنها دکمه‌ای که پنل را بایگانی می‌کند.',
  ],
  'bot.admin.panel_archived': [
    'پنل بایگانی شد',
    'پنل بایگانی شد و نامش آزاد است؛ بازگردانی از بایگانی در پنل وب انجام می‌شود.',
  ],
  'bot.admin.panel_unavailable': [
    'این کار روی پنل ممکن نیست',
    'یک پیام برای همهٔ دلایل؛ دلیل دقیق در پنل وب دیده می‌شود.',
  ],
  'bot.admin.username_button': [
    'دکمهٔ تنظیم یوزرنیم سرویس‌های پنل',
    'بخش سیاست یوزرنیم پنل را از صفحهٔ جزئیات آن باز می‌کند.',
  ],
  'bot.admin.username_section': [
    'تنظیمات یوزرنیم پنل',
    'سیاست کامل یوزرنیم پنل را پیش از ویرایش نشان می‌دهد، همراه با یک نمونه.',
  ],
  'bot.admin.username_custom_button': [
    'کلید یوزرنیم دلخواه پنل',
    'امکان انتخاب یوزرنیم توسط مشتری را برای این پنل روشن یا خاموش می‌کند.',
  ],
  'bot.admin.username_automatic_button': [
    'کلید یوزرنیم خودکار پنل',
    'امکان ساخت خودکار یوزرنیم را برای این پنل روشن یا خاموش می‌کند.',
  ],
  'bot.admin.username_strategy_random': [
    'روش خودکار: تصادفی ۱۲ نویسه‌ای',
    'روش ساخت یوزرنیم با دوازده نویسهٔ تصادفی را انتخاب می‌کند.',
  ],
  'bot.admin.username_strategy_prefix_random': [
    'روش خودکار: پیشوند + تصادفی',
    'روش ساخت یوزرنیم با پیشوند ذخیره‌شده و نویسه‌های تصادفی را انتخاب می‌کند.',
  ],
  'bot.admin.username_strategy_telegram_id_random': [
    'روش خودکار: شناسهٔ تلگرام + تصادفی',
    'روش ساخت یوزرنیم با شناسهٔ تلگرام مشتری را انتخاب می‌کند.',
  ],
  'bot.admin.username_refused': [
    'تنظیم یوزرنیم ذخیره نشد',
    'سیاست یوزرنیم پذیرفته نشد و چیزی ذخیره نشد؛ دلیل را می‌گوید.',
  ],

  // --- Telegram admin: customers ----------------------------------------------------
  'bot.admin.customers_button': [
    'دکمهٔ بخش مشتری‌ها',
    'بخش مشتری‌ها را در پنل مدیریت باز می‌کند؛ فقط برای مدیر دارای دسترسی مشتری‌ها.',
  ],
  'bot.admin.customers_section': [
    'فهرست مشتری‌ها',
    'مشتری‌ها را از قدیمی‌ترین، همراه با شکل دقیق دستور جست‌وجو نشان می‌دهد.',
  ],
  'bot.admin.customers_none': [
    'هنوز مشتری‌ای نیست',
    'هنوز هیچ مشتری‌ای با این ربات تماس نگرفته است.',
  ],
  'bot.admin.customers_more_button': ['دکمهٔ صفحهٔ بعد مشتری‌ها', 'صفحهٔ بعد فهرست مشتری‌ها.'],
  'bot.admin.customers_back_button': [
    'دکمهٔ بازگشت به فهرست مشتری‌ها',
    'از یک مشتری به صفحهٔ اول فهرست مشتری‌ها برمی‌گرداند.',
  ],
  'bot.admin.customer_detail': [
    'جزئیات مشتری',
    'شناسه و نام کاربری تلگرام، نام، وضعیت، دلیل مسدودی و زمان‌های نخستین و آخرین تماس.',
  ],
  'bot.admin.customer_gone': [
    'مشتری پیدا نشد',
    'یک پاسخ برای شناسهٔ ناشناخته، نامعتبر یا متعلق به مجموعهٔ دیگر.',
  ],
  'bot.admin.customer_block_button': [
    'دکمهٔ مسدود کردن مشتری',
    'مسدود کردن مشتری را شروع می‌کند؛ فقط برای مدیر دارای اجازهٔ مسدودسازی.',
  ],
  'bot.admin.customer_unblock_button': [
    'دکمهٔ رفع مسدودی مشتری',
    'رفع مسدودی مشتری را شروع می‌کند.',
  ],
  'bot.admin.customer_status_changed': [
    'وضعیت مشتری تغییر کرد',
    'وضعیتی را که مشتری اکنون دارد نام می‌برد.',
  ],
  'bot.admin.customer_block_ask': [
    'پرسش مسدود کردن مشتری',
    'پیش از ثبت، مشتری را نام می‌برد و می‌گوید دلیل پرسیده و به او نشان داده می‌شود.',
  ],
  'bot.admin.customer_block_reason_prompt': [
    'درخواست دلیل مسدودی مشتری',
    'دلیل اجباری مسدودی را از مدیر می‌خواهد؛ فقط پیام بعدی همین مدیر برای چند دقیقه خوانده می‌شود.',
  ],
  'bot.admin.customer_block_confirm': [
    'تأیید نهایی مسدودی مشتری',
    'دلیل نوشته‌شده را دوباره نشان می‌دهد و تنها دکمهٔ مسدودسازی را ارائه می‌کند.',
  ],
  'bot.admin.customer_block_already': [
    'مشتری از قبل مسدود بوده',
    'مشتری از قبل مسدود بوده و دلیل قبلی تغییری نکرد.',
  ],
  'bot.admin.customer_block_cancelled': [
    'مسدود کردن مشتری لغو شد',
    'مسدودسازی رها شد و وضعیت مشتری تغییری نکرد.',
  ],
  'bot.admin.customer_block_expired': [
    'مهلت نوشتن دلیل مسدودی تمام شد',
    'مهلت پاسخ گذشت و مشتری مسدود نشد.',
  ],
  'bot.admin.customer_unblock_ask': [
    'پرسش رفع مسدودی مشتری',
    'پیش از رفع مسدودی تأیید می‌گیرد؛ دلیل قبلی پاک می‌شود.',
  ],
  'bot.admin.customer_unblock_confirm_button': [
    'دکمهٔ تأیید رفع مسدودی',
    'تنها دکمه‌ای که مسدودی مشتری را برمی‌دارد.',
  ],
  'bot.admin.customer_usage': [
    'راهنمای دستور /customer',
    'دستور /customer بدون شناسهٔ تلگرام درست فرستاده شده؛ شکل درست آن را تکرار می‌کند.',
  ],

  // --- Telegram admin: categories ---------------------------------------------------
  'bot.admin.categories_button': [
    'دکمهٔ بخش دسته‌بندی‌ها',
    'بخش دسته‌بندی‌ها را در پنل مدیریت باز می‌کند.',
  ],
  'bot.admin.categories_section': [
    'فهرست دسته‌بندی‌ها (مدیریت)',
    'دسته‌ها به ترتیبی که مشتری می‌بیند، با وضعیت و نمایش هر کدام و دستور ساخت دستهٔ تازه.',
  ],
  'bot.admin.categories_none': [
    'هنوز دسته‌ای ساخته نشده',
    'هیچ دسته‌ای نیست؛ دستور ساخت دسته را نام می‌برد.',
  ],
  'bot.admin.categories_next_button': [
    'دکمهٔ صفحهٔ بعد دسته‌ها (مدیریت)',
    'صفحهٔ بعد فهرست دسته‌ها در پنل مدیریت.',
  ],
  'bot.admin.categories_previous_button': [
    'دکمهٔ صفحهٔ قبل دسته‌ها (مدیریت)',
    'صفحهٔ قبل فهرست دسته‌ها در پنل مدیریت.',
  ],
  'bot.admin.categories_back_button': [
    'دکمهٔ بازگشت به دسته‌بندی‌ها (مدیریت)',
    'به فهرست دسته‌بندی‌ها در پنل مدیریت برمی‌گرداند.',
  ],
  'bot.admin.category_detail': [
    'جزئیات دسته',
    'نام، ایموجی، وضعیت، نمایش و تعداد محصولات دسته، با دستورهای ویرایش آن.',
  ],
  'bot.admin.category_gone': [
    'دسته پیدا نشد',
    'یک پاسخ برای شناسهٔ ناشناخته، نامعتبر یا متعلق به مجموعهٔ دیگر.',
  ],
  'bot.admin.category_activate_button': ['دکمهٔ فعال کردن دسته', 'دسته را فعال می‌کند.'],
  'bot.admin.category_deactivate_button': [
    'دکمهٔ غیرفعال کردن دسته',
    'دسته را غیرفعال می‌کند؛ هیچ محصولی از آن، حتی با لینک مستقیم، قابل خرید نیست.',
  ],
  'bot.admin.category_show_button': [
    'دکمهٔ نمایش دسته به مشتری',
    'دسته را دوباره در فهرست مشتری نشان می‌دهد.',
  ],
  'bot.admin.category_hide_button': [
    'دکمهٔ پنهان کردن دسته',
    'دسته را از فهرست پنهان می‌کند؛ محصولاتش با لینک مستقیم قابل سفارش می‌مانند.',
  ],
  'bot.admin.category_up_button': [
    'دکمهٔ جابه‌جایی دسته به بالا',
    'دسته را یک جایگاه بالاتر می‌برد.',
  ],
  'bot.admin.category_down_button': [
    'دکمهٔ جابه‌جایی دسته به پایین',
    'دسته را یک جایگاه پایین‌تر می‌برد.',
  ],
  'bot.admin.category_delete_button': [
    'دکمهٔ حذف دسته',
    'پرسش تأیید حذف را باز می‌کند؛ خودش چیزی حذف نمی‌کند.',
  ],
  'bot.admin.category_delete_ask': ['پرسش تأیید حذف دسته', 'پیش از حذف دستهٔ خالی تأیید می‌گیرد.'],
  'bot.admin.category_delete_confirm_button': [
    'دکمهٔ تأیید حذف دسته',
    'تنها دکمه‌ای که دسته را حذف می‌کند.',
  ],
  'bot.admin.category_deleted': [
    'دسته حذف شد',
    'دسته حذف شد؛ سفارش‌های گذشته نام آن را نگه می‌دارند.',
  ],
  'bot.admin.category_not_empty': [
    'دسته هنوز محصول دارد',
    'حذف رد شد چون دسته هنوز محصول دارد؛ تعداد محصولات را می‌گوید.',
  ],
  'bot.admin.category_usage': [
    'راهنمای دستورهای دسته‌بندی',
    'دستور دسته‌بندی ناقص یا نامعتبر است؛ شکل درست هر سه دستور را تکرار می‌کند.',
  ],
  'bot.admin.category_products_button': [
    'دکمهٔ انتقال محصول به دستهٔ دیگر',
    'فهرست محصولات را برای جابه‌جایی بین دسته‌ها باز می‌کند.',
  ],
  'bot.admin.category_products': [
    'فهرست محصولات برای انتقال',
    'هر دکمه نام محصول و دستهٔ فعلی آن را نشان می‌دهد.',
  ],
  'bot.admin.category_products_none': [
    'محصولی در این صفحه نیست',
    'هیچ محصولی نیست یا فهرست تمام شده است.',
  ],
  'bot.admin.category_products_more_button': [
    'دکمهٔ محصولات بیشتر',
    'صفحهٔ بعد فهرست محصولات برای انتقال.',
  ],
  'bot.admin.category_pick': ['انتخاب دستهٔ مقصد', 'می‌پرسد محصول به کدام دسته منتقل شود.'],
  'bot.admin.category_pick_none': [
    'دستهٔ دیگری برای انتقال نیست',
    'دستهٔ دیگری برای انتقال این محصول نیست؛ دستور ساخت دسته را نام می‌برد.',
  ],
  'bot.admin.category_moved': [
    'محصول به دستهٔ دیگر منتقل شد',
    'محصول به دستهٔ تازه رفت؛ سفارش‌های گذشته دستهٔ خرید خود را نگه می‌دارند.',
  ],
  'bot.admin.product_gone': [
    'محصول پیدا نشد',
    'یک پاسخ برای شناسهٔ ناشناخته، نامعتبر یا متعلق به مجموعهٔ دیگر.',
  ],

  // --- Telegram admin: administrators -----------------------------------------------
  'bot.admin.section_button': [
    'دکمهٔ بخش ادمین‌ها',
    'بخش مدیریت دسترسی تلگرام ادمین‌ها را باز می‌کند.',
  ],
  'bot.admin.section': [
    'فهرست ادمین‌ها',
    'ادمین‌های دارای دسترسی تلگرام و شکل دقیق دستورهای این بخش.',
  ],
  'bot.admin.admins_none': [
    'هیچ ادمینی دسترسی تلگرام ندارد',
    'می‌گوید ادمین‌ها در پنل وب ساخته می‌شوند.',
  ],
  'bot.admin.admin_detail': [
    'جزئیات ادمین',
    'نام کاربری، نام نمایشی، وضعیت، نقش‌ها و اتصال تلگرام یک ادمین؛ بدون گذرواژه.',
  ],
  'bot.admin.admin_enable_button': [
    'دکمهٔ فعال کردن ادمین',
    'ادمین غیرفعال را با همان نقش‌ها و اتصال قبلی دوباره فعال می‌کند.',
  ],
  'bot.admin.admin_disable_button': [
    'دکمهٔ غیرفعال کردن ادمین',
    'همهٔ دسترسی‌ها و نشست‌های ادمین را متوقف می‌کند؛ برای خود مدیر و آخرین مالک مجاز نیست.',
  ],
  'bot.admin.admin_status_changed': [
    'وضعیت ادمین تغییر کرد',
    'وضعیتی را که ادمین اکنون دارد نام می‌برد.',
  ],
  'bot.admin.admin_gone': [
    'ادمین پیدا نشد',
    'یک پاسخ برای شناسهٔ ناشناخته، نامعتبر یا متعلق به مجموعهٔ دیگر.',
  ],
  'bot.admin.revoke_button': [
    'دکمهٔ قطع دسترسی تلگرام ادمین',
    'دسترسی تلگرام ادمین را برمی‌دارد؛ حساب، نقش‌ها و ورود به پنل وب او دست‌نخورده می‌ماند.',
  ],
  'bot.admin.admins_back_button': [
    'دکمهٔ بازگشت به فهرست ادمین‌ها',
    'از یک ادمین به فهرست ادمین‌ها برمی‌گرداند.',
  ],
  'bot.admin.linked': ['دسترسی تلگرام ادمین ثبت شد', 'یک حساب تلگرام به ادمین متصل شد.'],
  'bot.admin.revoked': ['دسترسی تلگرام ادمین حذف شد', 'ادمین دیگر دسترسی تلگرام ندارد.'],
  'bot.admin.roles_set': ['نقش‌های ادمین تغییر کرد', 'نقش‌های تازهٔ ادمین را نام می‌برد.'],
  'bot.admin.usage': [
    'راهنمای دستورهای بخش ادمین‌ها',
    'دستور به شکل پذیرفته‌شده نیست؛ شکل درست را تکرار می‌کند.',
  ],
  'bot.admin.refused': [
    'درخواست مدیریتی انجام نشد',
    'یک پیام برای همهٔ دلایل رد در این بخش، مانند نداشتن دسترسی یا اطلاعات نادرست.',
  ],

  // --- Telegram admin: refund requests ----------------------------------------------
  'bot.admin.refund_request_card': [
    'کارت بررسی درخواست بازگشت وجه',
    'کارتی که مدیر برای هر درخواست بازگشت وجه مشتری دریافت می‌کند؛ دلیل مشتری عیناً نقل می‌شود.',
  ],
  'bot.admin.refund_request_approve_button': [
    'دکمهٔ تأیید درخواست بازگشت وجه (مدیر)',
    'پرسش مبلغ را باز می‌کند؛ خودش چیزی را تصمیم نمی‌گیرد.',
  ],
  'bot.admin.refund_request_reject_button': [
    'دکمهٔ رد درخواست بازگشت وجه',
    'پرسش دلیل رد را باز می‌کند؛ خودش چیزی را تصمیم نمی‌گیرد.',
  ],
  'bot.admin.refund_request_user_button': [
    'دکمهٔ مشاهدهٔ کاربر (درخواست بازگشت وجه)',
    'مشتری صاحب درخواست را فقط برای مشاهده باز می‌کند.',
  ],
  'bot.admin.refund_request_service_button': [
    'دکمهٔ مشاهدهٔ سرویس (درخواست بازگشت وجه)',
    'سرویس مربوط به درخواست را فقط برای مشاهده باز می‌کند.',
  ],
  'bot.admin.refund_request_amount_prompt': [
    'درخواست مبلغ بازگشت وجه',
    'مبلغ بازگشتی را از مدیر می‌پرسد و حداکثر قابل بازگشت را می‌گوید.',
  ],
  'bot.admin.refund_request_amount_invalid': [
    'مبلغ بازگشت وجه نامعتبر',
    'مبلغ عدد صحیح مثبت نیست یا از حداکثر قابل بازگشت بیشتر است.',
  ],
  'bot.admin.refund_request_confirm': [
    'تأیید نهایی بازگشت وجه',
    'پیش از اجرا، مبلغ، مشتری و سرویس را نام می‌برد و می‌گوید سرویس حذف و مبلغ به کیف پول واریز می‌شود.',
  ],
  'bot.admin.refund_request_confirm_button': [
    'دکمهٔ تأیید نهایی و حذف سرویس',
    'درخواست بازگشت وجه تأییدشده را اجرا می‌کند.',
  ],
  'bot.admin.refund_request_cancel_button': [
    'دکمهٔ انصراف از تصمیم بازگشت وجه',
    'تأیید یا رد در جریان را رها می‌کند؛ چیزی تصمیم گرفته نمی‌شود.',
  ],
  'bot.admin.refund_request_cancelled': [
    'تصمیم بازگشت وجه لغو شد',
    'مدیر تصمیم را رها کرد؛ درخواست همچنان باز است.',
  ],
  'bot.admin.refund_request_executing': [
    'بازگشت وجه در حال اجرا',
    'تأیید ثبت شد و حذف سرویس آغاز شد؛ واریز پس از حذف موفق انجام می‌شود.',
  ],
  'bot.admin.refund_request_reject_prompt': [
    'درخواست دلیل رد بازگشت وجه',
    'دلیل اجباری رد را می‌خواهد؛ این دلیل برای مشتری فرستاده می‌شود.',
  ],
  'bot.admin.refund_request_reject_invalid': [
    'دلیل رد بازگشت وجه نامعتبر',
    'دلیل خالی یا بیش از حد طولانی است.',
  ],
  'bot.admin.refund_request_rejected': [
    'درخواست بازگشت وجه رد شد (پیام به مدیر)',
    'رد ثبت شد و دلیل آن برای مشتری فرستاده می‌شود.',
  ],
  'bot.admin.refund_request_closed': [
    'درخواست بازگشت وجه بسته شده',
    'درخواست دیگر باز نیست؛ مدیر دیگری تصمیم گرفته یا قبلاً تمام شده است.',
  ],
  'bot.admin.refund_request_not_executable': [
    'درخواست بازگشت وجه قابل اجرا نیست',
    'سرویس دیگر قابل حذف نیست یا پرداخت مبدأ قابل بازگشت نیست؛ چیزی جابه‌جا نشد.',
  ],
  'bot.admin.refund_request_expired': [
    'مهلت پاسخ به درخواست بازگشت وجه تمام شد',
    'مهلت پاسخ مدیر گذشت و چیزی تصمیم گرفته نشد.',
  ],

  // --- Operations group -------------------------------------------------------------
  'ops.notification.operational_event': [
    'گزارش رخداد عملیاتی',
    'برای هر رخداد عملیاتی (مثل خطای پنل) به گروه اعلان‌های عملیاتی فرستاده می‌شود؛ رخداد تکراری یک بار و با تعداد تکرار.',
  ],
  'ops.notification.test': [
    'پیام آزمایشی گروه عملیات',
    'هنگام آزمایش مقصد اعلان‌های عملیاتی فرستاده می‌شود تا درستی تنظیمات مشخص شود.',
  ],

  // --- The operations log group Nexa manages (WP-A4) ---------------------------------
  'ops.group.topic_name.system': [
    'نام تاپیک سیستم و خطاها',
    'نامی که Nexa هنگام ساختن (یا ساختن دوبارهٔ) تاپیک گزارش‌های سیستم و خطاها در گروه به آن می‌دهد.',
  ],
  'ops.group.topic_name.payments': [
    'نام تاپیک پرداخت‌ها',
    'نامی که Nexa هنگام ساختن (یا ساختن دوبارهٔ) تاپیک گزارش‌های پرداخت در گروه به آن می‌دهد.',
  ],
  'ops.group.connected': [
    'پیام اتصال موفق گروه',
    'پس از پذیرفته شدن کد اتصال، در همان گروه فرستاده می‌شود.',
  ],
  'ops.group.connect_refused': [
    'پیام رد کد اتصال',
    'وقتی کد اتصالِ فرستاده‌شده در گروه پذیرفته نشود؛ برای هر علتی یک متن.',
  ],
  'ops.group.connect_not_forum': [
    'پیام گروه بدون تاپیک',
    'وقتی کد اتصال در گروهی فرستاده شود که تاپیک‌های آن روشن نیست؛ کد مصرف نمی‌شود.',
  ],
  'ops.group.test': [
    'پیام آزمایشی گروه گزارش‌ها',
    'با «ارسال پیام آزمایشی» در پنل، در هر تاپیک گروه فرستاده می‌شود.',
  ],

  // --- Financial log group ----------------------------------------------------------
  'ops.financial.order_paid': [
    'گزارش مالی: تأیید پرداخت سفارش',
    'در تاپیک پرداخت‌های گروه لاگ، پس از تأیید پرداخت یک سفارش با هر روشی فرستاده می‌شود.',
  ],
  'ops.financial.topup_credited': [
    'گزارش مالی: شارژ کیف پول',
    'پس از تأیید و واریز شارژ کیف پول؛ مبلغ اصلی، کارمزد، مبلغ پرداخت‌شده و هدیه جداگانه می‌آیند.',
  ],
  'ops.financial.payment_failed': [
    'گزارش مالی: پرداخت ناموفق یا ردشده',
    'وقتی پرداختی بدون دریافت پول بسته می‌شود؛ با رد مدیر یا اعلام ناموفق بودن از سوی درگاه.',
  ],
  'ops.financial.late_completion': [
    'گزارش مالی: تأیید دیرهنگام درگاه',
    'درگاه پرداختی را پس از بسته شدن آن تأیید کرده است؛ چیزی تسویه نشده و مدیر باید آن را بررسی کند.',
  ],
  'ops.financial.refund_completed': [
    'گزارش مالی: بازگشت وجه انجام‌شده',
    'وقتی بازگشت وجهی کامل می‌شود؛ چه توسط مدیر و چه بازپرداخت خودکار سفارشی که تحویل نشد.',
  ],
  'ops.financial.refund_failed': [
    'گزارش مالی: بازگشت وجه ناموفق',
    'وقتی بازگشت وجهی ناموفق اعلام یا با بازپرداخت خودکار همان پرداخت جایگزین می‌شود.',
  ],
  'ops.financial.service_refund_request': [
    'گزارش مالی: نتیجهٔ درخواست بازگشت وجه سرویس',
    'وقتی درخواست بازگشت وجه یک سرویس به نتیجهٔ نهایی می‌رسد: انجام‌شده، ردشده یا ناموفق.',
  ],

  // --- Support tickets, to support ---------------------------------------------------
  'ops.support.ticket_opened': [
    'اعلان تیکت تازه به پشتیبانی',
    'وقتی مشتری تیکت تازه ثبت می‌کند به مدیران پشتیبانی فرستاده می‌شود؛ شماره، موضوع و مشتری را می‌گوید و متن مشتری را هرگز.',
  ],
  'ops.support.customer_replied': [
    'اعلان پیام تازهٔ مشتری در تیکت',
    'وقتی مشتری در تیکتی موجود می‌نویسد به مدیران پشتیبانی فرستاده می‌شود؛ متن مشتری را هرگز.',
  ],

  // --- Round N: broadcast and mass actions ------------------------------------------
  'bot.broadcast.message': [
    'قالب پیام همگانی',
    'هر پیام همگانی درون این قالب فرستاده می‌شود؛ می‌توانید سرتیتر یا پانویس ثابتی به همهٔ پیام‌های همگانی اضافه کنید.',
  ],
  'bot.wallet.mass_credited': [
    'اطلاع شارژ همگانی کیف پول',
    'وقتی شارژ همگانی به کیف پول مشتری رسید و مدیر اطلاع‌رسانی را انتخاب کرده بود فرستاده می‌شود.',
  ],
  'bot.service.gift_applied': [
    'اطلاع هدیهٔ حجم یا زمان',
    'فقط پس از اعمال قطعی هدیهٔ گروهی حجم یا زمان روی پنل، و اگر مدیر اطلاع‌رسانی را انتخاب کرده بود، فرستاده می‌شود.',
  ],
};
