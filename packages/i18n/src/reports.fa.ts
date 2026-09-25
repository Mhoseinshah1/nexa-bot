/**
 * The Persian column headers and sheet names of WP12's report exports.
 *
 * In the shared catalogue rather than in the API, for the rule every other string follows:
 * a surface — and an export file is one — does not carry Persian literals, and one
 * catalogue is what keeps a column called one thing in the file and another on screen.
 * Keyed by the column key the export builder uses, so a column without a header is a
 * compile error there rather than a blank cell here.
 */
export const REPORT_EXPORT_HEADERS_FA = {
  rank: 'رتبه',
  orderId: 'شناسه سفارش',
  settledAtLocal: 'تاریخ پرداخت',
  settledAtUtc: 'زمان پرداخت (UTC)',
  purpose: 'نوع عملیات',
  title: 'محصول (عنوان زمان خرید)',
  category: 'دسته‌بندی (زمان خرید)',
  productId: 'شناسه محصول',
  productStatus: 'وضعیت فعلی محصول',
  subtotal: 'مبلغ پیش از تخفیف',
  discount: 'تخفیف',
  total: 'مبلغ نهایی',
  revenue: 'درآمد',
  currency: 'واحد پول',
  paymentMethod: 'روش پرداخت',
  paymentRoute: 'مسیر پرداخت',
  customerId: 'شناسه مشتری',
  orders: 'تعداد سفارش',
  quantity: 'تعداد اقلام',
  method: 'روش پرداخت',
  route: 'مسیر پرداخت',
  kind: 'نوع پرداخت',
  attempts: 'تلاش‌ها',
  confirmed: 'موفق',
  failed: 'ناموفق',
  cancelled: 'لغوشده',
  expired: 'منقضی‌شده',
  pending: 'در انتظار',
  unknown: 'نامعلوم',
  successRatePercent: 'نرخ موفقیت (درصد)',
  confirmedAmount: 'مبلغ موفق',
  reason: 'علت تراکنش',
  group: 'گروه',
  direction: 'جهت',
  entries: 'تعداد',
  amount: 'مبلغ',
  panelName: 'پنل',
  providerType: 'نوع ارائه‌دهنده',
  servicesCreated: 'سرویس‌های ایجادشده',
  activeServices: 'سرویس‌های فعال',
  trafficSoldBytes: 'ترافیک فروخته‌شده (بایت)',
  unlimitedTrafficLines: 'اقلام نامحدود',
  provisioningFailures: 'خطای ساخت سرویس',
  referrerId: 'شناسه معرف',
  signups: 'ثبت‌نام معرفی‌شده',
  convertedBuyers: 'خریدار شده',
  commission: 'پورسانت',
  resellerCustomerId: 'شناسه نماینده',
  tierName: 'سطح',
  status: 'وضعیت',
  sales: 'مبلغ فروش',
  services: 'سرویس‌ها',
  creditLimit: 'سقف اعتبار',
  creditInUse: 'اعتبار در حال استفاده',
} as const;
export type ReportExportHeaderKey = keyof typeof REPORT_EXPORT_HEADERS_FA;

export const REPORT_EXPORT_SHEETS_FA = {
  SALES: 'فروش',
  PRODUCTS: 'محصولات',
  PAYMENTS: 'پرداخت‌ها',
  WALLET: 'کیف پول',
  INFRASTRUCTURE: 'زیرساخت',
  REFERRALS: 'معرفی',
  RESELLERS: 'نمایندگان',
} as const;
