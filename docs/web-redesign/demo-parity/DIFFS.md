# DIFFS — live app (v0.7.2 code) vs approved demo, every page

How this list was made: the current code was built and every Web Admin route was screenshotted at 1440 dark with the repo's own fixtures (`pnpm web:shots`). The same 56 routes were screenshotted in `approved-demo.html`. Each pair was compared side by side; the images are in `reference/pairs/` (LEFT = app, RIGHT = demo).

This is the **minimum** checklist. It covers 1440 dark only. You must repeat the comparison yourself for 1440 light and 390 dark/light, add anything else you find, and close every item. Total so far: 95 MAJOR, 116 MINOR, 56 pages.

## X — Cross-cutting fixes (do these once, in shared components; they affect almost every page)
- X1 **Breadcrumb in the page header** on every page («گروه منو / صفحه», and «… / جزئیات …» on detail pages), above the H1. It is missing on every page today.
- X2 **Pager labels** «تازه‌تر / قدیمی‌تر» for cursor pagers. Show only the available direction as active. Where the demo shows a counted pager, use «۱–۱۰ از N · صفحه ۱ از M» with قبلی/بعدی. This applies to features, content, reseller-plans, support-knowledge, payments, appearance and others. Pages that list everything in one long list must paginate at 10 rows, as in the demo.
- X3 **Header actions** (primary buttons such as «محصول جدید», «رخداد تازه», «افزودن», «ثبت تأیید مالک», «عملیات گروهی جدید») sit below the subtitle, aligned with the bottom of the header block. They are not level with the H1.
- X4 **«خوانده‌شده در …» + refresh**: a round refresh icon button with the timestamp under the subtitle. Tickets uses a «خواندن دوباره» button.
- X5 **Info callouts**: an outlined, slightly brighter bordered card with **no ⓘ icon**.
- X6 **Stat strips**: separate bordered cards with large numbers, all **neutral**. No amber or orange highlight borders unless the demo has them. This covers terms, payment-gateways, reseller-plans, panel-health and recovery.
- X7 **Linkable identifiers** (names, codes, order/payment IDs, tracking codes, campaign/broadcast titles) are underlined links. IDs use monospace. Drop the copy icons where the demo has none.
- X8 **Toolbar order on list pages**: the «فیلترها» / «فیلترهای ذخیره‌شده» row comes first, then the search row. Saved-filter chips show their count.
- X9 **No horizontal table overflow** at 1440. Panels («ظرفیت»), referrals («زمان»), discounts and services refunds are clipped today. Re-balance the columns as the demo does.
- X10 **Filled vs outlined pills**: rule-type and status pills follow the demo, outlined where the demo is outlined.
- X11 Shell: top bar, sidebar, page title placement, incident banner style and the 390 layout, as in PROMPT.md §A.

## Per page
### alerts
- [MAJOR] Columns differ. Demo: شدت | رویداد (readable event title) | پیام | تعداد رخداد | نخستین بار | آخرین بار | وضعیت. App shows a «کد» column with machine codes (`admin.roles_changed`), adds a «جزئیات فنی» expander column, and lacks «رویداد».
- [MAJOR] Filter toolbar: demo has «فیلترها» with a count badge plus a removable chip «وضعیت: همه ×»; app shows «فیلترها» + «بدون فیلتر — همه نمایش داده می‌شوند» text and no chip.
- [MAJOR] Breadcrumb missing («مدیریت سیستم / هشدارهای مدیریتی»).
- [MINOR] Pagination labels «تازه‌تر / قدیمی‌تر» (app: «قبلی / بعدی»).
- [MINOR] Message cells wrap to 2 lines in demo; app truncates to one line.

### bulk-operations
- [MAJOR] «عملیات گروهی جدید» button: demo puts it on its own row under the subtitle, just above the table; app puts it on the title row (top-left).
- [MAJOR] Breadcrumb missing («مالی و پرداخت / عملیات گروهی»).
- [MINOR] Operation-type cells are underlined links in demo; app shows plain bold text.
- [MINOR] Pagination labels «تازه‌تر / قدیمی‌تر».

### dashboard
- [MAJOR] KPI area: demo has a large hero card «فروش امروز» (big number + tall area chart) spanning 2 rows; beside it a tall «فروش این ماه» card with sparkline and USDT sub-line; then a 2×2 grid of small tiles (سرویس فعال، مشتری جدید، تمدیدها، پرداخت ناموفق). App shows 6 equal tiles in one row.
- [MAJOR] صف رسیدگی: demo has title + description as a narrow side panel on the right; the 4 critical items are large tiles with big counts in one row; the rest are compact rows (3 per row). App puts the title on top with 2 rows of 4 equal tiles. Empty state must keep the side panel.
- [MAJOR] Period segmented control (امروز/۷ روز/۳۰ روز/این ماه/دلخواه), «مقایسه با دورهٔ قبل» switch and refresh button are absent on the live v0.7.2 page (see reference/live-v0.7.2-dashboard.png); they must render.
- [MAJOR] وضعیت سامانه: demo shows a grid of 6 service cards (redis, postgres, provisioner, outbox, backup-storage, monitor), each with a status pill and latency; app shows 4 items as big green «در دسترس» text.
- [MAJOR] توزیع پنل‌ها: demo uses one segmented stacked bar per group with rows marked by coloured dots; app uses a separate progress bar per row.
- [MAJOR] خلاصهٔ خطاها: demo uses 5 bordered mini-cards (2×2 + 1); app uses a plain divided grid.
- [MAJOR] Demo has a «وضعیت عملیاتی» section label above the last row; app has none.
- [MAJOR] Delta badges are pills (+9% ▲) in demo; sparklines are filled gradient areas (never a hairline spike at the card edge).
- [MINOR] درآمد روزانه: demo has a range pager under the chart («۱–۱۰ از ۳۰، صفحهٔ ۱ از ۳»).
- [MINOR] نیازمند توجه: demo shows ERROR/CRITICAL/WARN pills, timestamps and a «شرایط باز دیگر» footer.
- [MINOR] «مقایسه با دورهٔ قبل» is a toggle switch in demo; app uses a checkbox.
- [MINOR] Row 3 columns are equal width in demo; app makes سهم روش‌های پرداخت wider.

### legacy-products
- [MAJOR] Filter order: demo puts the «فیلترها» toolbar first, then a narrow left-aligned search; app puts a full-width search first, then the toolbar.
- [MAJOR] Breadcrumb missing («فروش و محصولات / بازبینی محصولات قدیمی»).
- [MINOR] Demo shows extra warning pills beside the status pill («منبع تغییر کرده», «کد تکراری», «در خواندن آخر نبود») — render them when the data has those flags.
- [MINOR] Info callout has no icon in demo.
- [MINOR] Pagination labels «تازه‌تر / قدیمی‌تر».

### panels
- [MAJOR] Table overflows horizontally in app: «ظرفیت» column is cut off at the left edge.
- [MAJOR] App lacks the «وضعیت» column (demo: «فعال/غیرفعال» pill + «قابل فروش نیست» warning line).
- [MAJOR] «نوع خطا» is a short pill in demo («پاسخ دیر رسید»); app shows long sentence banners.
- [MAJOR] Breadcrumb missing («زیرساخت و پنل‌ها / پنل‌ها»).
- [MINOR] Capacity reads «۱٬۴۲۰ / ۲٬۰۰۰ (۲)» with a bar under it in demo.
- [MINOR] Panel names are underlined links in demo.
- [MINOR] Pagination labels «تازه‌تر / قدیمی‌تر».

### referrals
- [MAJOR] «دفتر پورسانت» table overflows horizontally in app: «زمان» and part of «برگشت‌داده‌شده» are cut off.
- [MAJOR] Breadcrumb missing («فروش و محصولات / معرفی و پورسانت»).
- [MINOR] Period selector in تحلیل معرف is a full-width segmented bar in demo; app compact and right-aligned.
- [MINOR] Referrer codes, names and order IDs are underlined links in demo.
- [MINOR] Demo has (i) info icons on «خریدار شده» and «درآمد از معرفی‌شده‌ها» tiles.
- [MINOR] Pagination labels «تازه‌تر / قدیمی‌تر».

### services-detail
- [MAJOR] In-page breadcrumb missing («مشتریان و پشتیبانی / سرویس‌ها / جزئیات سرویس»).
- [MINOR] «حجم مصرف‌شده» tile has a percentage label («۷۱٪») beside its bar in demo.

### support
- [MAJOR] Breadcrumb missing («مشتریان و پشتیبانی / پشتیبانی»).
- [MINOR] «راه ارتباط با پشتیبانی» card: «رفتن به تنظیمات» button aligns with the card title in demo; app centres it vertically.
### appearance
- [MAJOR] Breadcrumb above title missing ("ربات و ارتباط با مشتری / ظاهر ربات").
- [MAJOR] Test-message side panel: demo lists every bot as a bulleted list, each with its own status pill ("پذیرفته شد", "متوقف") and explanation line; app shows only one bot.
- [MAJOR] Table rows lack the expand chevron at far left that every demo row has.
- [MINOR] First tab "جایگاه‌های آیکون" lacks its count pill (demo shows 29).
- [MINOR] Preview column lacks the extra "خاموش" pill beside the emoji badge.
- [MINOR] Pagination text should be "10–1 از 29 · صفحه 1 از 3" (app shows only "صفحه ۱ از ۳").
- [MINOR] App has an extra footer note ("شناسه عددی: خالی یعنی…") not present in demo.

### business-chats
- [MAJOR] Breadcrumb missing ("هوش مصنوعی پشتیبانی / گفتگوهای تلگرام بیزینس").
- [MAJOR] Chats table footer missing: demo shows "نمایش 6" + "نمایش بیشتر" load-more button.
- [MINOR] Status cell lacks the secondary "تیکت دارد" pill under the status badge.
- [MINOR] Waiting-time value bold in demo ("26 دقیقه"), plain in app.

### discounts
- [MAJOR] Breadcrumb missing.
- [MAJOR] Price-preview form: demo uses a 2×2 grid (order type + product / customer ID + discount code); app puts four fields in one row.
- [MAJOR] Discount-rules table actions: demo stacks a pencil icon above a "غیرفعال" button; app uses inline "ویرایش" link + button and the column is clipped at the left edge.
- [MINOR] Pagination labels should be "قدیمی‌تر / تازه‌تر" in both tables (app: "قبلی / بعدی").
- [MINOR] Demo rows are taller; the scope cell has 2–3 lines (category, first purchase only, minimum amount).

### legacy-services
- [MAJOR] Results card should be a two-column grid listing every result category with its count (~25 rows); app shows a single column with only 2 rows.
- [MAJOR] Filters should be an inline row of five fields (result select, review-status select, panel code, legacy product code, invoice ID); app has one text input + "فیلترها" button.
- [MAJOR] Breadcrumb missing.
- [MINOR] Warning box: app has an info icon; demo box is plain.
- [MINOR] Pagination labels should be "قدیمی‌تر / تازه‌تر".

### payment-gateways
- [MAJOR] Breadcrumb missing.
- [MAJOR] Rate stats: demo uses four separate cards with large numbers; app uses one bordered strip with dividers.
- [MAJOR] Gateway rows: demo rows are multi-line (underlined name link, "نام پیش‌فرض" pill + last-change date below it, amount limits on several lines, several stacked status pills in the API-key column — تنظیم شده / کلید IPN / اتصال موفق — with dates); app rows are single-line.
- [MINOR] "جزئیات فنی": demo has a full-width bordered collapsible bar; app has a small text toggle.

### reminders
- [MAJOR] Each card has an extra labelled toggle row in the app (e.g. "یادآور کاهش حجم" + switch); in the demo the switch and status pill sit in the card header, opposite the title, with no separate row.
- [MAJOR] Breadcrumb missing.
- [MINOR] "متن پیام‌ها" buttons lack counts (demo: "(3)", "(5)" …).
- [MINOR] A disabled reminder's value (wallet card) should be muted as in the demo.

### services
- [MAJOR] Breadcrumb missing ("مشتریان و پشتیبانی / سرویس‌ها").
- [MAJOR] Location column shows "—"; demo shows flag + "country — city".
- [MINOR] Saved-filters chip lacks its count (demo "1").
- [MINOR] Pagination labels should be "قدیمی‌تر / تازه‌تر".
- [MINOR] Refund table's leftmost columns (result) are clipped in the app.

### system
- [MAJOR] Breadcrumb missing ("مدیریت سیستم / سامانه و عملیات").
- [MAJOR] Column split: demo splits version info and system status ~50/50; app has a narrow (~1/3) version card and a wide status card.
- [MAJOR] Logs card "گروه گزارش‌ها" button: demo puts it bottom-left, on the description's row, with a send icon and label "گروه گزارش‌های مدیریتی"; app puts it in the header beside the title.
- [MINOR] Dependency names (postgres, redis, migrations, outbox) are bare monospace in the demo, without Persian labels.
### audit-log
- [MAJOR] Filter panel: demo shows an expanded panel with 6 labelled fields in a grid (انجام‌دهنده، عملیات، شناسه موجودیت، شناسه مشتری، از تاریخ، تا تاریخ with date pickers and helper text) plus «اعمال فیلتر» and «پاک کردن فیلترها» buttons; app collapses it to a single «نام کاربری یا شناسه مدیر» input with جستجو/پاک کردن.
- [MAJOR] Table (compare with fixture data): demo columns زمان / انجام‌دهنده (role sub-line) / عملیات (دلیل sub-line) / موجودیت (tag chips) / نتیجه (badge) / جزئیات; expandable rows («۲ فیلد ⌃»); failed rows red-tinted; pager تازه‌تر/قدیمی‌تر with «نمایش N». The screenshot fixture currently returns an empty list — add rows so this is visible.
- [MINOR] Breadcrumb missing (مدیریت سیستم / گزارش ممیزی); CSV button lacks its download icon.

### campaigns
- [MINOR] «کمپین چه کاری می‌کند…» box: bright outlined border, no info icon (app: muted card with ⓘ).
- [MINOR] Campaign names are underlined links.
- [MINOR] Pagination labels تازه‌تر / قدیمی‌تر.
- [MINOR] Breadcrumb missing (فروش و محصولات / کمپین‌ها).

### extra-devices
- [MINOR] Breadcrumb missing.
- [MINOR] Pagination labels تازه‌تر / قدیمی‌تر.
- [MINOR] «آخرین تغییر» uses numeric date-time (1405/07/03 12:10), not «۱۳ شهریور».

### notification-center
- [MAJOR] Not audited yet: the demo screenshot for this route rendered the overview page. Use the demo's `#/inbox` («مرکز اعلان‌ها») as the reference and audit it yourself.

### payments
- [MAJOR] «وضعیت عملیاتی» column shows «—» in app; demo shows outlined pill badges («رسید در انتظار بررسی», «در انتظار پرداخت مشتری»).
- [MAJOR] Pagination: demo has a numeric pager («10–1 از 12 · صفحه 1 از 2», قبلی/بعدی) above the تازه‌تر / قدیمی‌تر pager; app has only قبلی / بعدی.
- [MINOR] کد پیگیری is an underlined link with no copy icons in demo; app has an extra «مشتری» column not visible in demo (keep data, match the demo's column set/order).
- [MINOR] Breadcrumb missing (مالی و پرداخت / پرداخت‌ها و کیف پول).
- (Excluded: the «۱۰ کارت‌به‌کارت منتظر بررسی — شروع بررسی سریع» banner — on hold.)

### reports
- [MAJOR] KPI grid: demo has 6 cards in the first row (فروش، درآمد، سفارش موفق، کاربر جدید، سرویس جدید، تمدید), then شارژ کیف پول and سرویس فعال; app shows 5 + 3; cards lack their ⓘ icons.
- [MAJOR] Trend chart lacks y-axis (0–20M), x-axis dates, gridlines and the filled area under the current-period line; app adds a second legend at the bottom not in demo.
- [MINOR] Breadcrumb missing.

### settings
- [MAJOR] Tab strip lacks the «سایر تنظیمات 1» tab (wraps to a second row in demo).
- [MINOR] «اطلاعات فنی» is a full-width bordered collapsible bar with a ◄ caret in demo, not a plain inline link.
- [MINOR] «آخرین تغییر» missing on some rows.
- [MINOR] Breadcrumb missing.

### terms
- [MAJOR] Stats strip: 4 separate bordered cards with large numbers in demo; app shows plain unboxed text.
- [MAJOR] «تاریخچهٔ نسخه‌ها» is a table (نسخه / عنوان / انتشار / پذیرش‌ها) with expand chevrons and a «نسخهٔ فعلی» badge in demo; app shows only empty text.
- [MAJOR] Version cards: «نسخهٔ فعلی» needs its meta line (نسخه · time · author) and a «مشاهده» link; «پیش‌نویس» needs its meta line and «ویرایش پیش‌نویس» / «پیش‌نمایش و انتشار» buttons.
- [MINOR] Toggle lacks its «روشن» status pill.
- [MINOR] Breadcrumb missing.
### bot-buttons
- [MAJOR] «دکمه‌های آزاد» placement: demo has a full-width card ABOVE the «منو» section, each free button (e.g. «پشتیبانی / تیکت‌ها») a full-width draggable row; app has a narrow side column to the right of the menu preview.
- [MAJOR] Missing yellow per-row warning banner under the phone preview («ردیف ۴ ممکن است روی گوشی‌های باریک فشرده…») and the ⚠ icon beside the affected row.
- [MAJOR] «منو» section must be its own full-width card with the segmented control (ویرایش / دید مشتری / منوی زنده فعلی) top-left and a wider phone preview below it.
- [MINOR] Status pill: demo green «منتشرشده و یکسان با پیش‌نویس» pill with dot; app neutral text pill.
- [MINOR] Breadcrumb missing.

### client-apps
- [MINOR] Breadcrumb missing. Otherwise matches.

### features
- [MAJOR] No pagination: demo shows 10 features per page with a footer pager («قبلی / ۱–۱۰ از ۲۱ · صفحه ۱ از ۳ / بعدی»); app renders all in one long list.
- [MAJOR] Inline validation missing in «تنظیمات مرتبط»: demo shows a red error beside an invalid value («مقدار ذخیره‌شده این تنظیم دیگر معتبر نیست…»).
- [MINOR] In related-settings boxes, values sit at the far left edge with labels on the right; app puts values in a middle column.
- [MINOR] Breadcrumb missing.

### notifications
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر».
- [MINOR] Status pills lack the amber «در انتظار» variant.
- [MINOR] Breadcrumb missing.

### product-categories
- [MAJOR] «آیکون دسته‌بندی‌ها» cards: demo has a small coloured preview chip top-left (the button as it will look in the bot) and stacked full-width inputs with labels above and a «حذف» link beside filled values; app has a full-width grey preview bar and small inline inputs.
- [MINOR] Count line «N دسته‌بندی آیکون یا ایموجی دارد» missing above the cards.
- [MINOR] More vertical padding per card in demo. Breadcrumb missing.

### reseller-plans
- [MAJOR] Remove the extra segmented control «این ماه / ماه قبل» in «پیشرفت حداقل فروش ماهانه» (not in demo).
- [MAJOR] Stat strip: demo has 4 equal full-width cards with large numbers, none highlighted; app has 4 small cards on the right and an orange-outlined «هنوز نرسیده» card.
- [MAJOR] Pager under the progress table missing («قبلی / ۱–۱۰ از ۱۱ · صفحه ۱ از ۲ / بعدی»).
- [MINOR] Tier column can show a «معلق» pill beside the tier name. Breadcrumb missing.

### support-ai
- [MAJOR] «کلیدهای ارائه‌دهنده‌ها»: each provider in demo is a vertical label/value list (زمان ثبت کلید، آخرین آزمون اتصال، خطای پیاپی، رد کلید در، منطقه کلید where relevant), action buttons stacked below, and a separate «مدل آزمون:» + «آزمون اتصال» row; app squeezes it into one inline row.
- [MAJOR] Missing red «کلید رد شده است» alert box inside a provider block, and status pills «موقتاً کنار گذاشته شده», «محدودیت تعداد درخواست», «در انتظار یک آزمون دوباره».
- [MAJOR] Header: demo shows a mode pill («پاسخ خودکار امن») under the subtitle on the left; app shows a «فقط دستیار» chip next to the title.
- [MAJOR] Provider chain: demo shows numbered backup rows («پشتیبان ۱») each with provider select, model input and trash button; app shows only the primary.
- [MINOR] «حالت» radios one per line in demo (app puts two per line); demo uses soft inset cards, app uses fieldset legend borders. Breadcrumb missing.

### tickets
- [MAJOR] Extra search row (input + «جستجو» + «پاک کردن») at top of the table card; demo has only the «فیلترها» + «فیلترهای ذخیره‌شده» toolbar.
- [MAJOR] Header refresh: demo has a «خواندن دوباره» button with the «خوانده‌شده در …» timestamp; app shows only an icon and text far top-left.
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر»; 10 rows per page.
- [MINOR] «افزودن دسته» lacks its «+» icon; category rows have a pencil icon on «تغییر نام». Breadcrumb missing.
### bots
- [MAJOR] «افزودن ربات» is a bordered card in demo (header row with + icon and title, explanation below); app shows one plain line under the bot card.
- [MAJOR] Stat pill row lacks «نیازمند توجه» (demo: ربات / فعال / نیازمند توجه) — show it even at 0.
- [MINOR] Unhealthy bot: demo shows an amber warning box with bullets inside that bot's card — make sure it renders. Breadcrumb missing.

### compensations
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر».
- [MINOR] Payment and order IDs are underlined monospace links (order as ORD-xxxx); app plain bold. Breadcrumb missing.

### incidents
- [MINOR] «رخداد تازه» button aligns with the bottom of the header block (demo), not the title row.
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر». Breadcrumb missing.

### ops-group
- [MAJOR] Middle row: demo two equal columns (وضعیت اتصال right; تاپیک‌ها with صف گزارش‌ها stacked left); app ~2:1 with the connection card wider.
- [MAJOR] صف گزارش‌ها card lacks its «ارسال مجدد گزارش‌های ارسال‌نشده» button (app text even refers to it).
- [MAJOR] اتصال گروه تلگرام section lacks the «فیلترها» button and «بدون فیلتر — همه نمایش داده می‌شوند» line above the connect button.
- [MINOR] Each topic one compact row (icon, name, status pill right; last successful send left); app uses two lines per topic.
- [MINOR] Support the deleted-topic state red pill («حذف شده — دوباره ساخته می‌شود»). Breadcrumb missing.

### products
- [MAJOR] Toolbar order: demo puts «فیلترها» + «بدون فیلتر…» row first, search row under it; app search first.
- [MINOR] Header buttons (محصول جدید، دسته‌بندی‌ها) align with the bottom of the header block.
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر». Breadcrumb missing.

### reseller-tiers
- [MAJOR] «مجوزها» cell: one vertical list (محصول، دسته، پنل، ربات، نوع خرید), one per line each with its pill; app uses a 2-column grid of pills.
- [MINOR] «سطح تازه» form footer: hint on the right, «ساخت سطح» on the left, same row; app stacks them.
- [MINOR] Header buttons align with the bottom of the header block. Breadcrumb missing.

### support-analytics
- [MAJOR] 4 KPI cards must fill the full width in four equal columns; app leaves an empty column-wide gap on the left (grid behaves as 5 columns).
- [MINOR] Period control lacks the «بازه» label to the right of the pills; remove the extra empty divider under the pills.
- [MINOR] Horizontal bar rows: label right, bar middle, number left on one line (all bar cards); app puts label and number above a full-width bar.
- [MINOR] پاسخ خودکار breakdown bars use a different colour per outcome; app uses one colour. Breadcrumb missing.

### trials
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر».
- [MINOR] Actor cell in سابقه بازنشانی‌ها has a copy icon not in demo. Breadcrumb missing.
### broadcasts
- [MINOR] First-column titles are underlined links that open the broadcast (app: plain bold).
- [MINOR] Progress bar colours: blue for in-progress/paused, green at 100%/finished (app: white/grey).
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر», only the available direction active. Breadcrumb missing.

### content
- [MAJOR] Message list (right) has no pagination and runs the full page; demo has a limited-height list pane with footer «۱–۱۰ از ۷۳۲ · صفحه ۱ از ۷۴» + قبلی/بعدی.
- [MINOR] Small dot markers on edited/customised entries. Breadcrumb missing.

### knowledge-build
- [MAJOR] Each proposal: demo shows a pair of bordered cards side by side — «متن فعلی» (right) and «متن پیشنهادی» (left); add-only items show one card on the right. App shows bare inline text.
- [MAJOR] Demo stacks unnumbered rows separated by dividers, each with badge + category on top and «اعمال این مورد» below the cards; app numbers items «۱.» «۲.» and has no dividers.
- [MINOR] Conflict row shows the inline chooser («جایگزینی با متن ساخته‌شده» / «نگه‌داشتن ویرایش فعلی»); retire rows show an explanation on the left plus «بازنشسته‌کردن این مطلب» — add fixture rows and verify. Breadcrumb missing.

### orders
- [MINOR] «خوانده‌شده در …» refresh line sits under the subtitle with a round refresh icon button (app: on the title row).
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر».
- [MINOR] Customer column shows `@username` + Telegram ID in monospace (app: name only). Breadcrumb missing.

### providers
- [MAJOR] «کارهای پشتیبانی‌شده» column is empty in app; demo fills it with wrapping green-dot capability pills (ساخت سرویس، تمدید، افزایش حجم، …) from the adapter's capabilities.
- [MINOR] Info callout: brighter outlined border, no icon.
- [MINOR] Provider names as monospace code-style pills.
- [MINOR] App lists 2 providers, demo 3 (RickPanel missing) — verify the screenshot fixture/registry includes rickpanel. Breadcrumb missing.

### resellers
- [MAJOR] Remove the extra column «سقف خرید در میرزا (اعمال نمی‌شود)» (not in demo; owner: no Mirza-specific UI).
- [MAJOR] Toolbar order reversed and search narrow: demo filters row first, then a full-width search input with its button.
- [MINOR] «قاعده‌هایی که این صفحه رعایت می‌کند» card is ~half width, aligned right, in demo (app full width).
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر». Breadcrumb missing.

### support-knowledge
- [MINOR] Filters row wrapped in its own bordered card.
- [MINOR] Pagination footer «۱–۱۰ از ۳۷ · صفحه ۱ از ۴» + قبلی/بعدی (render even with one page).
- [MINOR] Info callout is a slimmer bordered strip. Breadcrumb missing.

### users-detail (Customer 360)
- [MAJOR] Stat strip: demo puts it AFTER the operations card as 6 separate stat cards; app puts it inside the identity header card above operations. Demo identity header is not inside a card.
- [MAJOR] «میان‌برهای اپراتور» links are a vertical list in demo; app wraps them side by side.
- [MINOR] Tab labels: «محدودیت و کنترل‌ها» (app «کنترل‌ها»), «معرف و نماینده» (app «نماینده و معرف»), «یادداشت‌ها و برچسب‌ها» (app «یادداشت و برچسب»), «تاریخچهٔ مدیریتی» (app «تاریخچه»).
- [MINOR] «→ کاربران» back link above the header.
- [MINOR] Blocked user shows the red «این مشتری مسدود است» alert below the stats; empty «نیازمند رسیدگی» state «برای این مشتری چیزی در انتظار رسیدگی نیست.» — add fixtures and verify.
### bulk-operations-new
- [MINOR] Breadcrumb missing («مالی و پرداخت / عملیات گروهی»).
- [MINOR] «مخاطبان» count card: larger headline number («مخاطبان این عملیات» + big figure + «مشتری»).

### custom-service
- [MINOR] Capability callout: outlined card, no icon.
- [MINOR] Rule-type pills (حجم/زمان) outlined, not filled. Breadcrumb missing.

### legacy-cutover
- [MAJOR] «تأییدها» section card (columns نوع / اثر انگشت منبع / وضعیت / کارها, status pills, «لغو تأیید» action, pagination) missing; app shows a bare empty state outside any card. Render the card with the empty state inside.
- [MINOR] Readings table shows the «آزمایشی» pill in the source-fingerprint cell.
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر».
- [MINOR] «ثبت تأیید مالک» sits below the subtitle (app: level with H1). Breadcrumb missing.

### panel-health
- [MAJOR] Panel cards in a 2-column grid (app: 3).
- [MAJOR] Cards lack the «سابقه — در انتظار بسته‌شدن» history block.
- [MAJOR] Current alerts are a bulleted list with severity pills (خطا/هشدار) and timestamps (app: plain text).
- [MAJOR] Missing amber «فروش جدید متوقف» drain callout at the top of a drained panel's card and its «ازسرگیری فروش» button.
- [MAJOR] Error text overflows outside the cards into the gutter — layout bug.
- [MINOR] Stat-strip cards «ناقص» and «آفلاین» are neutral in demo (app amber borders). Breadcrumb missing.

### recovery
- [MAJOR] «بازیابی‌های پیشین از میرزا» table (file name / status / stop reason / backup ID / time) under restore operations missing.
- [MAJOR] Latest-backup card lacks the amber «پاکسازی ناقص» warning callout (when applicable).
- [MINOR] Kit and restore-operations section headers: title and subtitle inline on one row.
- [MINOR] «ارسال‌های نامعلوم» stat card neutral (app amber border).
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر». Breadcrumb missing.

### service-locations
- [MINOR] «افزودن» button below the subtitle (app: level with H1). Breadcrumb missing.

### support-learning
- [MAJOR] Not audited: the demo has no page at this route (renders the overview). Keep the app's content; apply the shared shell/header/pagination/callout rules and the demo's card and table patterns.

### users
- [MINOR] Refresh is a circular icon button next to «مدیریت برچسب‌ها» (app: inline icon).
- [MINOR] Pager labels «تازه‌تر / قدیمی‌تر». Breadcrumb missing.
