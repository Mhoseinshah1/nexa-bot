import type { TemplateKey } from '@nexa/contracts';

/**
 * The Persian catalogue.
 *
 * Text is stored RAW, with `{token}` placeholders left un-substituted. It is
 * never stored in rendered form: the legacy template editor echoes the
 * RENDERED string — `{first_name}` demonstrably resolves in the viewing
 * admin's own context — so the raw template is not recoverable from that
 * screen, and saving it back would bake the editor's own name into the
 * template for every customer.
 *
 * The rendering is observed (TBR-TXT-004, VERIFIED_BY_UI and VERIFIED_BY_OWNER).
 * The consequence is a HAZARD, not a recorded event: the investigation never
 * sent a single character to that bot, and says so
 * (`docs/research/mirzabotbottextmanagementinvestigationcomplete/`
 * `bot-text-management-knowledge/incidents.md`). The text corruption that DID
 * happen is INCIDENT-FIN-001, where a typed menu label was swallowed by a
 * value-capture prompt and overwrote a production tutorial text.
 *
 * Keys are the identifier. The Persian text is data and may change freely
 * without breaking a single call site — unlike the legacy system, where the
 * Persian caption WAS the key.
 *
 * The product is Persian-only for now. `Locale` exists so that adding a second
 * language is a new catalogue file rather than a refactor.
 */
export const CATALOGUE_FA: Readonly<Record<TemplateKey, string>> = {
  'bot.ping.reply': 'سلام. ربات فعال است. شناسه پیگیری: {correlationId}',
  'bot.unknown_command': 'این دستور شناخته نشد. برای دیدن فهرست دستورها /help را بفرستید.',
  'error.internal': 'خطایی رخ داد. لطفاً بعداً دوباره تلاش کنید.',
  'error.permission_denied': 'شما به این بخش دسترسی ندارید.',

  // Operations. Persian like everything else: the people running this
  // installation read Persian too, and a mixed-language operations channel is
  // how a message stops being read at all.
  'ops.notification.operational_event':
    '{severity} — <code>{code}</code>\n{message}\nتعداد رخداد: {occurrences}\nنخستین بار: {firstSeenAt}',
  'ops.notification.test':
    'این یک پیام آزمایشی است. مقصد اعلان‌های عملیاتی به درستی پیکربندی شده است.\nدرخواست‌کننده: {requestedBy}\nزمان: {at}',

  // Customer-facing commerce — Phase 4.
  //
  // No greeting names the customer. `templates.ts` records why: a name placeholder is
  // a placeholder whose value comes from a third party, and the product has nothing
  // to gain from rendering it.
  //
  // Wording is deliberately plain and short. These are read on a phone, in a chat,
  // by someone who wants to buy something — not an operations channel.
  //
  // NEITHER greeting mentions a menu, and that is a correctness rule rather than a
  // style choice. Both of these said "use the menu to see the services you can buy" —
  // to every customer, as the first and only thing this head of the product says to
  // them — while `bot-runtime.ts` handles exactly two things: `/start`, and "I did not
  // understand that". There is no menu, no catalogue, no order and no service flow, so
  // the copy instructed a customer to do something that could only answer
  // `bot.unknown_command`.
  //
  // The keys below them — `bot.catalog.*`, `bot.order.*`, `bot.wallet.*` — were the
  // frozen catalogue for phases that had not shipped, and nothing rendered them. These
  // two ARE rendered, on every customer's first contact, so they say what is true now.
  // That sentence said "when the catalogue ships, the sentence changes with it", and
  // this is that change: `/catalog` answers, so it is named. Payment is NOT mentioned,
  // because a customer cannot pay yet and an instruction they cannot follow is the
  // defect this comment was written about.
  'bot.start.welcome':
    'خوش آمدید. حساب شما در این ربات ساخته شد. برای دیدن سرویس‌ها دستور /catalog را بفرستید.',
  'bot.start.welcome_back': 'خوش آمدید. برای دیدن سرویس‌های قابل خرید دستور /catalog را بفرستید.',
  'bot.blocked': 'دسترسی این حساب به ربات بسته شده است.',

  // What this bot can do, and the descriptions Telegram shows in its own command menu.
  // One list in `BOT_COMMANDS` feeds both, so a command cannot be registered and
  // undocumented, or documented and unregistered.
  'bot.help':
    'دستورهای این ربات:\n/catalog — دیدن و خرید سرویس‌ها\n/services — سرویس‌های من و مدیریت آن‌ها\n/wallet — موجودی کیف پول\n/help — همین راهنما',
  'bot.command.start': 'شروع',
  'bot.command.catalog': 'خرید سرویس',
  'bot.command.services': 'سرویس‌های من',
  'bot.command.wallet': 'کیف پول',
  'bot.command.help': 'راهنما',

  // The persistent main menu, as the owner specified it after v0.2.0 staging
  // acceptance. These four are ROUTES as well as labels: `intentOf` matches the
  // text a tap sends against exactly these strings, so an edit here changes what
  // the bot answers and not merely what it shows.
  'bot.menu.catalog': '🛒 خرید اشتراک',
  'bot.menu.services': '📱 سرویس‌های من',
  'bot.menu.wallet': '💰 کیف پول',
  'bot.menu.help': '📚 راهنما',

  'bot.catalog.empty': 'در حال حاضر سرویسی برای فروش تنظیم نشده است.',
  'bot.catalog.heading': 'سرویس‌های قابل خرید:',
  'bot.catalog.categories_heading': 'یک دسته را انتخاب کنید:',
  'bot.catalog.category_empty':
    'در حال حاضر چیزی در این دسته برای فروش نیست. دسته‌های دیگر را ببینید.',
  'bot.catalog.next_page_button': 'بعدی ›',
  'bot.catalog.previous_page_button': '‹ قبلی',
  'bot.catalog.back_to_categories_button': 'بازگشت به دسته‌ها',

  // The username a customer's service is known by on the panel. The panel's policy
  // decides which of the two modes they are offered; with one enabled the choice is
  // skipped and that flow runs directly.
  'bot.username.choose': 'یوزرنیم سرویس‌تان را چطور انتخاب می‌کنید؟',
  'bot.username.custom_button': '✍️ نام کاربری دلخواه',
  'bot.username.automatic_button': '🎲 انتخاب خودکار',
  // The rule, stated once and in full, because a customer who is refused twice for two
  // different reasons they were never told stops buying. Every clause here is one the
  // shared validator actually enforces.
  'bot.username.instructions':
    'یوزرنیم دلخواه‌تان را بفرستید.\n' +
    '• بین ۴ تا ۲۰ نویسه\n' +
    '• فقط حروف انگلیسی (a تا z)، رقم انگلیسی (0 تا 9)، خط تیره (-) و زیرخط (_)\n' +
    '• حداقل یک حرف انگلیسی و حداقل یک رقم داشته باشد\n' +
    '• حروف بزرگ و کوچک فرقی ندارند و در نهایت با حروف کوچک ذخیره می‌شود\n' +
    '• حرف و رقم فارسی، فاصله، نقطه، @ و ایموجی پذیرفته نمی‌شود',
  'bot.username.invalid':
    'این یوزرنیم پذیرفته نشد. لطفاً با توجه به شرایط بالا یک یوزرنیم دیگر بفرستید.',
  'bot.username.taken':
    'این یوزرنیم قبلاً گرفته شده است. لطفاً یوزرنیم دیگری بفرستید. هیچ مبلغی کسر نشده است.',
  // Three refusals the customer did not cause. Each says that no money moved, because
  // that is the only part of the answer they can act on; none of them names a panel,
  // a preset or a template, because none of those is theirs to fix.
  'bot.username.exhausted':
    'ساخت خودکار یوزرنیم در این لحظه ممکن نشد. لطفاً چند دقیقه دیگر دوباره تلاش کنید. هیچ مبلغی کسر نشده است.',
  'bot.username.unavailable':
    'ساخت خودکار یوزرنیم برای این خرید ممکن نیست. لطفاً یوزرنیم دلخواه خود را بفرستید یا با پشتیبانی تماس بگیرید. هیچ مبلغی کسر نشده است.',
  'bot.username.mode_unavailable':
    'انتخاب یوزرنیم دلخواه برای این خرید در دسترس نیست. لطفاً گزینه‌ی انتخاب خودکار را بزنید. هیچ مبلغی کسر نشده است.',
  'bot.username.stale':
    'یوزرنیم انتخاب‌شده برای این سفارش دیگر معتبر نیست و آزاد شد. لطفاً دوباره یوزرنیم انتخاب کنید. هیچ مبلغی کسر نشده است.',
  'bot.order.summary':
    'سفارش شما\nسرویس: {productTitle}\nمدت: {durationDays}\nحجم: {trafficBytes}\nیوزرنیم: {username}\nمبلغ قابل پرداخت: {total}',
  'bot.order.confirm_button': 'تأیید و ثبت سفارش',
  'bot.order.unavailable': 'این سرویس در حال حاضر قابل خرید نیست.',
  'bot.order.expired': 'مهلت این سفارش به پایان رسیده است. لطفاً دوباره سفارش دهید.',
  'bot.order.not_awaiting_payment': 'این سفارش دیگر در انتظار پرداخت نیست.',
  'bot.order.awaiting_payment':
    'سفارش ثبت شد و در انتظار پرداخت است.\nمبلغ: {total}\nاعتبار تا: {expiresAt}',
  /*
   * Payment, and NOTHING about a service.
   *
   * The shipped copy said «سرویس شما در حال آماده‌سازی است» — "your service is being
   * prepared" — and Phase 4C is the phase that first SENDS this key. Nothing in this
   * release provisions anything: no panel call, no service row, no credential. A
   * message claiming an effect that did not happen is the defect this codebase is
   * organised around, and 4B could ship the sentence only because 4B never sent it.
   *
   * The KEY and its frozen description are untouched — `docs/phase4c-audit.md` records
   * that the description is a contract and the default copy is not. A tenant running a
   * later phase words it however they like; the default must not lie in the release
   * that ships it.
   */
  'bot.order.settled': 'پرداخت با موفقیت تأیید شد و سفارش شما پرداخت‌شده است.',
  'bot.order.cancelled': 'سفارش لغو شد.',
  /*
   * Three lines, and the two figures are the point of the change.
   *
   * The old sentence said the money came back and sent the customer to /wallet to
   * find out how much — which is the legacy answer the research records: true,
   * useless, and impossible to reconcile against what they paid. Both figures come
   * from the committed ledger, rendered by `formatMoney`, so no currency unit is
   * typed here.
   *
   * It says an error occurred and the order did not complete. It does NOT say
   * `ACTIVATION_INCOMPLETE` or any other internal code: which of the operator's
   * machines was misconfigured is not a fact a customer is owed, and it is not
   * something they can act on.
   */
  'bot.order.refunded_to_wallet':
    'در ساخت سرویس شما خطایی رخ داد و سفارش انجام نشد.\n' +
    'مبلغ {refundAmount} به کیف پول شما بازگردانده شد.\n' +
    'موجودی جدید کیف پول: {walletBalance}',
  'bot.order.cancel_button': 'لغو سفارش',
  /*
   * The two things the customer cannot take back, said before the destructive tap.
   *
   * `ORDER_MACHINE` has no edge out of CANCELLED, so the quoted price is gone with the
   * order: a new order is priced at whatever the plan costs today. Saying so is what
   * makes this a decision rather than a mis-touch on a message they scrolled past.
   */
  'bot.order.cancel_confirm':
    'آیا از لغو این سفارش مطمئن هستید؟ این کار برگشت‌پذیر نیست و قیمت فعلی شما از بین می‌رود؛ سفارش بعدی با قیمت روز ثبت می‌شود.',
  'bot.order.cancel_confirm_button': 'بله، سفارش را لغو کن',
  /*
   * NOT a refusal to argue with. The customer said they had paid, and money already
   * sent cannot be unsent by cancelling the order it was for.
   */
  'bot.order.transfer_under_review':
    'شما اعلام کرده‌اید که مبلغ این سفارش را واریز کرده‌اید، بنابراین تا پایان بررسی نمی‌توان آن را لغو کرد. نتیجهٔ بررسی به شما اطلاع داده می‌شود.',

  /*
   * Phase 5T — the management panel.
   *
   * Admin-facing Persian, and it says only what this build actually does. The two
   * section labels are the strings the Mirza research recorded on its own panel
   * (`👨‍💼 پنل مدیریت`, `💵 رسید های تایید نشده`, `👨‍🔧 بخش ادمین`), because an operator
   * moving across is looking for those words — and everything BELOW those labels is
   * Nexa's own behaviour rather than a reproduction of a runtime nobody observed.
   */
  'bot.menu.admin': '👨‍💼 پنل مدیریت',
  'bot.admin.panel': 'پنل مدیریت. بخش مورد نظر را انتخاب کنید:',
  'bot.admin.receipts_button': '💵 رسید های تایید نشده',
  'bot.admin.section_button': '👨‍🔧 بخش ادمین',
  'bot.admin.receipts_list': 'پرداخت‌های در انتظار بررسی:',
  'bot.admin.receipts_none': 'در حال حاضر هیچ پرداختی در انتظار بررسی نیست.',
  'bot.admin.receipt':
    'کد پیگیری: {reference}\nمبلغ: {total}\nمشتری: {customer}\n\nرسید ارسال‌شده در پیام‌های بعدی است. پس از بررسی، یکی از دو گزینه را انتخاب کنید.',
  'bot.admin.receipt_gone': 'این پرداخت دیگر در انتظار بررسی نیست و نتیجهٔ آن قبلاً ثبت شده است.',
  'bot.admin.approve_button': '✅ تأیید پرداخت',
  'bot.admin.reject_button': '❌ رد پرداخت',
  'bot.admin.approved': 'پرداخت تأیید شد و نتیجه برای مشتری ثبت گردید.',
  'bot.admin.rejected': 'پرداخت رد شد و نتیجه برای مشتری ثبت گردید.',
  /*
   * The services section, Phase 6A. Every action goes through the canonical path the
   * Web Admin uses; these strings are what an administrator reads while it does.
   */
  'bot.admin.services_button': '🧰 سرویس‌ها',
  'bot.admin.services_section':
    'سرویس‌هایی که رسیدگی می‌خواهند:\n\n• سرویس‌هایی که وضعیتشان روی پنل نامعلوم است\n• سرویس‌هایی که لینکشان به مشتری نرسیده است\n\nبرای دیدن یک سرویس مشخص:\n/service <شناسهٔ سرویس>',
  'bot.admin.services_none':
    'در حال حاضر هیچ سرویسی رسیدگی نمی‌خواهد. برای دیدن یک سرویس مشخص: /service <شناسهٔ سرویس>',
  'bot.admin.service':
    'مشتری: {customer}\nنام کاربری روی پنل: {username}\nپنل: {panel}\nپلن: {product}\nوضعیت: {state}\nتحویل به مشتری: {delivery}\nمصرف: {usedTrafficBytes} از {totalTrafficBytes}\nآخرین خواندن مصرف: {syncedAt}\nانقضا: {expiresAt}\nآخرین عملیات: {operation}\nشمار عملیات ثبت‌شده: {history}',
  'bot.admin.service_gone': 'این سرویس پیدا نشد.',
  'bot.admin.service_sync_button': '🔄 خواندن مصرف از پنل',
  'bot.admin.service_resend_button': '📨 ارسال مجدد لینک',
  'bot.admin.service_retry_button': '♻️ تلاش مجدد برای ساخت',
  'bot.admin.service_reconcile_button': '🧭 تطبیق با پنل',
  'bot.admin.service_suspend_button': '⏸ غیرفعال کردن',
  'bot.admin.service_resume_button': '▶️ فعال کردن',
  'bot.admin.service_rotate_link_button': '🔄 لینک اشتراک جدید',
  'bot.admin.service_rotate_link_ask':
    'پنل برای این سرویس یک لینک اشتراک تازه می‌سازد و لینک تازه برای مشتری فرستاده می‌شود.\n\nاگر مطمئن هستید، دکمهٔ زیر را بزنید.',
  'bot.admin.service_rotate_link_confirm_button': '🔄 بله، لینک جدید بساز',
  'bot.admin.service_terminate_button': '🗑 پایان دادن به سرویس',
  'bot.admin.service_terminate_ask':
    'با این کار حساب مشتری روی پنل حذف می‌شود و برگشت‌پذیر نیست. سفارشی که مشتری پرداخت کرده سر جایش می‌ماند.\n\nاگر مطمئن هستید، دکمهٔ زیر را بزنید.',
  'bot.admin.service_terminate_confirm_button': '🗑 بله، پایان بده',
  'bot.admin.service_planned':
    'درخواست ثبت شد. تا وقتی پنل آن را اعمال نکند، انجام‌شده نیست؛ نتیجه در تاریخچهٔ سرویس می‌آید.',
  'bot.admin.service_resent': 'لینک برای مشتری فرستاده شد.',
  'bot.admin.service_unavailable':
    'این کار روی این سرویس در حال حاضر ممکن نیست. دلیلش در پنل وب، روی صفحهٔ همین سرویس، نوشته شده است.',
  /*
   * Phase 6B — the panels section. No address, no credential, no provider body:
   * a chat message is forwardable and stays in that chat for ever.
   */
  /*
   * The reminder settings section.
   *
   * Every value is PRINTED before anything is editable — the cure for BC-SB-003, where
   * seven of twelve legacy screens ask for a new value without showing the old one.
   */
  'bot.admin.reminders_button': 'یادآورهای سرویس',
  'bot.admin.reminders_section':
    'تنظیمات یادآور سرویس‌ها\n\n' +
    'یادآور پیش از انقضا: {expiry}\n' +
    '  • یادآور اول: {firstDays} روز پیش از پایان\n' +
    '  • یادآور دوم: {secondDays} روز پیش از پایان\n' +
    'اعلام پایان اعتبار: {expired}\n\n' +
    'یادآور مصرف حجم: {usage}\n' +
    '  • آستانه اول: {firstPercent}٪\n' +
    '  • آستانه دوم: {secondPercent}٪\n' +
    '  • آستانه پایانی: {finalPercent}٪\n\n' +
    'برای تغییر هر مقدار، دکمهٔ آن را بزنید. روشن و خاموش کردن خودِ یادآورها از پنل وب ' +
    'انجام می‌شود، چون دامنهٔ اثر آن کل مشتریان است و به تأیید نوشتاری و ثبت دلیل نیاز دارد.',
  'bot.admin.reminder_expiry_first_button': 'یادآور اول انقضا',
  'bot.admin.reminder_expiry_second_button': 'یادآور دوم انقضا',
  'bot.admin.reminder_usage_first_button': 'آستانه اول مصرف',
  'bot.admin.reminder_usage_second_button': 'آستانه دوم مصرف',
  'bot.admin.reminder_usage_final_button': 'آستانه پایانی مصرف',
  'bot.admin.reminder_choose':
    'تنظیم: <code>{setting}</code>\nمقدار فعلی: {current}\n\nمقدار تازه را انتخاب کنید.',
  'bot.admin.reminder_saved': 'ذخیره شد.\n<code>{setting}</code> از این پس {value} است.',
  'bot.admin.reminder_refused': 'این مقدار پذیرفته نشد.\n\n{reason}',
  'bot.admin.panels_button': '🛰 پنل‌ها',
  'bot.admin.panels_section':
    'پنل‌های در سرویس، از تازه‌ترین. برای دیدن وضعیت و ظرفیت هر پنل، روی نامش بزنید.',
  'bot.admin.panels_none':
    'هیچ پنلی در سرویس نیست. پنل‌ها در پنل وب ساخته می‌شوند، چون ساختن پنل به اعتبارنامه نیاز دارد و اعتبارنامه در چت وارد نمی‌شود.',
  'bot.admin.panels_more_button': '▶️ صفحهٔ بعد',
  'bot.admin.panel_detail':
    'پنل: {name}\nارائه‌دهنده: {provider}\nوضعیت: {status}\nسلامت: {health}\nآخرین بررسی: {checkedAt}\nخطای آخرین بررسی: {failure}\n\nسرویس‌های فعال: {services}\nرزرو جاری: {reservations}\nسقف سرویس: {cap}\n\nیوزرنیم دلخواه: {usernameCustom}\nیوزرنیم خودکار: {usernameAutomatic}\nپیشوند: {usernamePrefix}\nالگوی یوزرنیم: {usernameTemplate}',
  'bot.admin.panel_gone': 'این پنل پیدا نشد.',
  'bot.admin.panel_test_button': '🔌 تست اتصال',
  'bot.admin.panel_tested': 'تست اتصال انجام شد و سلامت پنل به‌روز شد.',
  'bot.admin.panel_test_replayed':
    'تست تازه‌ای انجام نشد؛ همین درخواست پیش‌تر ثبت شده یا این پنل به‌تازگی بررسی شده است. آنچه می‌بینید سلامت ذخیره‌شده است.',
  'bot.admin.panel_enable_button': '▶️ بازگرداندن به سرویس',
  'bot.admin.panel_disable_button': '⏸ خارج کردن از سرویس',
  'bot.admin.panel_enabled':
    'پنل به سرویس برگشت: فروش تازه روی آن ممکن است و پایش دوباره شروع می‌شود.',
  'bot.admin.panel_disabled':
    'پنل از سرویس خارج شد: فروش تازه روی آن انجام نمی‌شود و پایش متوقف می‌شود. سرویس‌هایی که همین حالا روی آن هستند دست‌نخورده کار می‌کنند.',
  'bot.admin.panel_not_validated':
    'برای بازگرداندن این پنل به سرویس، اول باید یک تست اتصال موفق روی پیکربندی فعلی‌اش انجام شود. دکمهٔ «تست اتصال» روی همین صفحه است.',
  'bot.admin.panel_archive_button': '🗄 بایگانی کردن پنل',
  'bot.admin.panel_archive_ask':
    'با بایگانی کردن، این پنل از کاتالوگ، از زمان‌بندی پایش و از فهرست‌ها خارج می‌شود و نامش آزاد می‌شود. {services} سرویس روی این پنل هست و هیچ‌کدام با این کار پایان نمی‌یابد.\n\nاگر مطمئن هستید، دکمهٔ زیر را بزنید.',
  'bot.admin.panel_archive_confirm_button': '🗄 بله، بایگانی کن',
  'bot.admin.panel_archived':
    'پنل بایگانی شد و نامش آزاد است. بازگردانی از بایگانی در پنل وب انجام می‌شود، چون ممکن است به نام تازه نیاز داشته باشد.',
  'bot.admin.panel_unavailable':
    'این کار روی این پنل در حال حاضر ممکن نیست. دلیلش در پنل وب، روی صفحهٔ همین پنل، نوشته شده است.',
  /*
   * The syntax is IN the message, because these are commands rather than a prompt.
   * A prompt that captures the next message is what overwrote a production gateway
   * setting in INCIDENT-FIN-001; a command carries its argument with it.
   */
  // The panel's username policy, read back in full before anything is edited. The two
  // toggles and the four presets are taps; the prefix and the template are commands
  // that carry their argument, because a prompt that captures the next message is
  // INCIDENT-FIN-001.
  'bot.admin.username_button': '👤 یوزرنیم سرویس‌ها',
  'bot.admin.username_section':
    'یوزرنیم سرویس‌های پنل <b>{panel}</b>\n\n' +
    'انتخاب دلخواه توسط مشتری: {custom}\n' +
    'انتخاب خودکار: {automatic}\n' +
    'روش خودکار:\n' +
    '{random} تصادفی ۱۲ نویسه‌ای\n' +
    '{prefixRandom} پیشوند + تصادفی\n' +
    '{telegramIdRandom} شناسهٔ تلگرام + تصادفی\n' +
    '{customTemplate} الگوی دلخواه\n' +
    'پیشوند: <code>{prefix}</code>\n' +
    'الگو: <code>{template}</code>\n' +
    'نمونهٔ خروجی: <code>{preview}</code>\n\n' +
    'هر یوزرنیم جدید بین ۴ تا ۲۰ نویسه و فقط از حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته می‌شود.\n' +
    'برای تغییر پیشوند: <code>/panel_prefix &lt;شمارهٔ پنل&gt; &lt;پیشوند&gt;</code>\n' +
    'برای تغییر الگو: <code>/panel_template &lt;شمارهٔ پنل&gt; &lt;الگو&gt;</code>',
  'bot.admin.username_custom_button': 'انتخاب دلخواه',
  'bot.admin.username_automatic_button': 'انتخاب خودکار',
  'bot.admin.username_strategy_random': 'تصادفی ۱۲ نویسه‌ای',
  'bot.admin.username_strategy_prefix_random': 'پیشوند + تصادفی',
  'bot.admin.username_strategy_telegram_id_random': 'شناسهٔ تلگرام + تصادفی',
  'bot.admin.username_refused': 'ذخیره نشد: {reason}',
  'bot.admin.services_browse_button': '📋 همهٔ سرویس‌ها',
  'bot.admin.services_browse':
    'سرویس‌های این نصب، از تازه‌ترین. برای دیدن جزئیات و کارهای ممکن، روی نام هرکدام بزنید.\n\nبرای یافتن یک سرویس با نام کاربری‌اش روی پنل:\n/service <نام کاربری یا شناسهٔ سرویس>',
  'bot.admin.services_browse_none': 'سرویسی برای نمایش نیست.',
  'bot.admin.services_more_button': '▶️ صفحهٔ بعد',
  'bot.admin.services_back_button': 'بازگشت به بخش سرویس‌ها',
  'bot.admin.service_customer_button': '👤 مشتری این سرویس',
  'bot.admin.service_ambiguous':
    'این نام کاربری روی بیش از یک سرویس در این نصب وجود دارد؛ یکتا بودن نام فقط در محدودهٔ هر پنل تضمین شده است.\n\nبرای اینکه کاری روی سرویس اشتباه انجام نشود، انتخاب با شماست:',
  'bot.admin.service_usage':
    'دستور ناقص یا نامعتبر است.\n\n/service <نام کاربری روی پنل یا شناسهٔ سرویس>',
  'bot.admin.customers_button': '👤 مشتری‌ها',
  'bot.admin.customers_section':
    'مشتری‌های این نصب، از قدیمی‌ترین. برای دیدن جزئیات و مسدود کردن یا رفع مسدودی، روی نام هرکدام بزنید.\n\nبرای یافتن یک مشتری با شناسهٔ عددی تلگرام:\n/customer <شناسهٔ عددی تلگرام>',
  'bot.admin.customers_none': 'هنوز هیچ مشتری‌ای با این ربات تماس نگرفته است.',
  'bot.admin.customers_more_button': '▶️ صفحهٔ بعد',
  'bot.admin.customers_back_button': 'بازگشت به فهرست مشتری‌ها',
  'bot.admin.customer_detail':
    'شناسهٔ تلگرام: {telegramId}\nنام کاربری: {username}\nنام: {name}\nوضعیت: {status}\nدلیل مسدودی: {reason}\n\nاولین تماس: {firstSeen}\nآخرین تماس: {lastSeen}',
  'bot.admin.customer_gone': 'چنین مشتری‌ای یافت نشد.',
  'bot.admin.customer_block_button': '⛔️ مسدود کردن',
  'bot.admin.customer_unblock_button': '✅ رفع مسدودی',
  'bot.admin.customer_status_changed': 'وضعیت {telegramId} اکنون {status} است.',
  'bot.admin.customer_usage': 'دستور ناقص یا نامعتبر است.\n\n/customer <شناسهٔ عددی تلگرام>',
  'bot.admin.categories_button': '🗂 دسته‌بندی‌ها',
  'bot.admin.categories_section':
    'دسته‌بندی‌ها به همان ترتیبی که مشتری می‌بیند. کنار هر دسته وضعیت و نمایش آن آمده است؛ برای مدیریت روی هرکدام بزنید.\n\nبرای ساختن دستهٔ تازه:\n/category_new <نام>',
  'bot.admin.categories_none':
    'هنوز هیچ دسته‌ای ساخته نشده است. تا محصولی در دسته‌ای نباشد، فروخته نمی‌شود.\n\nبرای ساختن دستهٔ تازه:\n/category_new <نام>',
  'bot.admin.categories_next_button': '▶️ صفحهٔ بعد',
  'bot.admin.categories_previous_button': '◀️ صفحهٔ قبل',
  'bot.admin.categories_back_button': 'بازگشت به دسته‌بندی‌ها',
  'bot.admin.category_detail':
    'دسته: {emoji} {name}\nوضعیت: {status}\nنمایش: {visibility}\nتعداد محصولات: {products}\nشناسه: {id}\n\nبرای تغییر نام یا ایموجی:\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
  'bot.admin.category_gone': 'چنین دسته‌ای یافت نشد.',
  'bot.admin.category_activate_button': '✅ فعال کردن',
  'bot.admin.category_deactivate_button': '⏸ غیرفعال کردن',
  'bot.admin.category_show_button': '👁 نمایش به مشتری',
  'bot.admin.category_hide_button': '🙈 پنهان کردن',
  'bot.admin.category_up_button': '⬆️ بالاتر',
  'bot.admin.category_down_button': '⬇️ پایین‌تر',
  'bot.admin.category_delete_button': '🗑 حذف دسته',
  'bot.admin.category_delete_ask':
    'دستهٔ «{name}» حذف شود؟ این کار برگشت‌پذیر نیست. سفارش‌های گذشته نام دسته را نگه می‌دارند.',
  'bot.admin.category_delete_confirm_button': 'بله، حذف شود',
  'bot.admin.category_deleted': 'دستهٔ «{name}» حذف شد.',
  'bot.admin.category_not_empty':
    'این دسته هنوز {products} محصول دارد و حذف نشد. ابتدا محصولاتش را به دستهٔ دیگری منتقل کنید.',
  'bot.admin.category_usage':
    'دستور ناقص یا نامعتبر است.\n\n/category_new <نام>\n/category_rename <شناسهٔ دسته> <نام تازه>\n/category_emoji <شناسهٔ دسته> <ایموجی یا ->',
  'bot.admin.category_products_button': '🔀 انتقال محصول به دستهٔ دیگر',
  'bot.admin.category_products':
    'محصولی را که می‌خواهید جابه‌جا کنید انتخاب کنید. کنار هر محصول دستهٔ فعلی‌اش آمده است؛ «—» یعنی بدون دسته، و چنین محصولی تا در دسته‌ای قرار نگیرد فروخته نمی‌شود.',
  'bot.admin.category_products_none': 'محصولی در این صفحه نیست.',
  'bot.admin.category_products_more_button': '▶️ محصولات بیشتر',
  'bot.admin.category_pick':
    'محصول «{product}» اکنون در دستهٔ «{category}» است. دستهٔ مقصد را انتخاب کنید.',
  'bot.admin.category_pick_none':
    'دستهٔ دیگری برای انتقال این محصول وجود ندارد.\n\nبرای ساختن دستهٔ تازه:\n/category_new <نام>',
  'bot.admin.category_moved': 'محصول «{product}» به دستهٔ «{category}» منتقل شد.',
  'bot.admin.product_gone': 'چنین محصولی یافت نشد.',
  'bot.admin.section':
    'فهرست ادمین‌های این نصب ({shown} از {total}). برای دیدن جزئیات و تغییر وضعیت، روی نام هرکدام بزنید.\n\nبرای دادن دسترسی تلگرام به یک ادمین موجود:\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n\nبرای تعیین نقش یک ادمین:\n/role <نام کاربری ادمین> <کلید نقش>',
  'bot.admin.admins_none':
    'هیچ ادمینی دسترسی تلگرام ندارد. ادمین‌ها در پنل وب ساخته می‌شوند و سپس با /link به تلگرام متصل می‌شوند.',
  'bot.admin.admin_detail':
    'نام کاربری: {username}\nنام نمایشی: {displayName}\nوضعیت: {status}\nنقش‌ها: {roles}\nتلگرام: {telegram}',
  'bot.admin.admin_enable_button': 'فعال کردن',
  'bot.admin.admin_disable_button': 'غیرفعال کردن',
  'bot.admin.admin_status_changed': 'وضعیت {username} اکنون {status} است.',
  'bot.admin.admin_gone': 'چنین ادمینی یافت نشد.',
  'bot.admin.revoke_button': 'قطع دسترسی تلگرام',
  'bot.admin.admins_back_button': 'بازگشت به فهرست ادمین‌ها',
  'bot.admin.linked': 'دسترسی تلگرام برای {username} ثبت شد.',
  'bot.admin.revoked': 'دسترسی تلگرام {username} حذف شد.',
  'bot.admin.roles_set': 'نقش‌های {username} به {roles} تغییر یافت.',
  'bot.admin.usage':
    'دستور ناقص یا نامعتبر است.\n\n/link <شناسهٔ عددی تلگرام> <نام کاربری ادمین>\n/role <نام کاربری ادمین> <کلید نقش>',
  /*
   * ONE refusal for every case, on purpose. Which refusal it was belongs to the audit
   * row and the error code; spelling it out here would tell whoever holds the chat
   * whether the administrator exists, whether the Telegram account is already bound,
   * and which permission is missing.
   */
  'bot.admin.refused':
    'این درخواست انجام نشد. دسترسی یا اطلاعات وارد‌شده اجازهٔ این کار را نمی‌دهد.',
  'bot.admin.receipt_awaiting':
    'رسید تازه‌ای برای بررسی ثبت شد.\nکد پیگیری: {reference}\nمبلغ: {total}\nاز بخش «رسید های تایید نشده» در پنل مدیریت آن را بررسی کنید.',

  'bot.wallet.balance': 'موجودی کیف پول شما: {balance}',
  'bot.wallet.insufficient': 'موجودی کیف پول کافی نیست. کمبود: {shortfall}',
  'bot.wallet.topup_button': '➕ شارژ کیف پول',
  'bot.wallet.topup_choose': 'مبلغ شارژ را انتخاب کنید:',
  'bot.wallet.topup_refused': 'این مبلغ قابل شارژ نیست. لطفاً مبلغ دیگری را از فهرست انتخاب کنید.',
  'bot.wallet.topup_unavailable':
    'شارژ کیف پول در حال حاضر فعال نیست. لطفاً با پشتیبانی تماس بگیرید.',
  /*
   * No amount, because the notification lane carries no payload. The sentence says the
   * balance changed and where to read it; `/wallet` derives the figure from the ledger.
   */
  'bot.wallet.topup_credited': 'شارژ کیف پول شما تأیید شد. موجودی جدید را با /wallet ببینید.',

  /*
   * It used to end «سپس رسید را ارسال نمایید» — "then send the receipt" — and no
   * surface in this product accepts one. Owner revision 17 says no receipt is stored,
   * archived or displayed, so the instruction described a step the customer could
   * attempt for ever without anything happening. 4H gives them the step that exists.
   */
  'bot.payment.manual_instructions':
    'برای پرداخت مبلغ {total} طبق راهنمای فروشنده اقدام کنید و سپس دکمهٔ «پرداخت را انجام دادم» را بزنید.\nکد پیگیری این پرداخت: {reference}',
  /*
   * The invoice layout the owner specified: heading, invoice id, payable amount, then
   * the destination lines, then the instructions.
   *
   * The trailing paragraph is the tenant-editable part of that layout — editable
   * because the whole body is a tenant-overridable template, which is also why there
   * is no second key for it.
   *
   * {destination} is composed from the payment's FROZEN snapshot, so editing the
   * account afterwards does not change what this customer was told.
   */
  'bot.payment.transfer_instructions':
    '🧾 جزئیات فاکتور پرداخت شما\n\nشناسه فاکتور: {reference}\nمبلغ قابل پرداخت: {total}\n{destination}\n\nپس از واریز، دکمهٔ پایین را بزنید و تصویر یا فایل رسید را ارسال کنید. پرداخت شما پس از بررسی پشتیبانی تأیید می‌شود.',
  'bot.payment.destination.bank': 'بانک: {value}',
  'bot.payment.destination.holder': 'به نام: {value}',
  'bot.payment.destination.card': 'شماره کارت: {value}',
  'bot.payment.destination.sheba': 'شبا: {value}',
  'bot.payment.copy_card_button': '📋 کپی شماره کارت',
  'bot.payment.copy_amount_button': '💵 کپی مبلغ',
  'bot.payment.wallet_button': 'پرداخت از کیف پول',
  'bot.payment.manual_button': 'پرداخت کارت به کارت',
  /*
   * The generic refusal, and it says two things on purpose: that the request cannot be
   * completed NOW (so trying later is sensible), and that nothing was charged — because
   * every cause that reaches this key rolled its transaction back, and a customer whose
   * tap vanished will otherwise assume the money moved.
   */
  'bot.request_unavailable':
    'انجام این درخواست در حال حاضر امکان‌پذیر نیست و مبلغی از شما کسر نشد. لطفاً کمی بعد دوباره تلاش کنید.',
  'bot.payment.unconfigured': 'این روش پرداخت در حال حاضر فعال نیست.',
  /*
   * ONE button naming both halves, and the Payment UX addendum fixes the wording.
   *
   * «ارسال رسید» is deliberately NOT a second button. The tap records the
   * customer’s claim and opens the upload window in one transaction, so two buttons
   * would be two ways to reach one action — and a customer who pressed only the first
   * would have a window open and no idea it was there.
   */
  'bot.payment.sent_button': '✅ پرداخت را انجام دادم | ارسال رسید',
  /*
   * Whose claim this repeats is the whole of the wording.
   *
   * It used to read «رسید شما دریافت شد» — "your receipt has been received" — which was
   * two untruths at once: no receipt was accepted anywhere in this product, and nothing
   * had been received. 5R makes the FIRST half true and not the second: a receipt is now
   * stored and bound to this payment, and no money has still been received or verified.
   * So `bot.payment.receipt_received` may say the file arrived and this key may not say
   * anything more than it did — what is true here is that the CUSTOMER's claim is
   * recorded and a person will check it against a bank statement. A sentence that
   * blurred the two would be `PRBR-004` in a message.
   *
   * It is still reachable: it is the notification-lane wording for
   * `PAYMENT_TRANSFER_RECORDED`, which is what a customer is told when the interactive
   * reply could not be delivered.
   */
  'bot.payment.received_for_review':
    'اعلام شما ثبت شد. هنوز مبلغی دریافت یا تأیید نشده است؛ پس از بررسی، نتیجه به شما اطلاع داده می‌شود.',
  'bot.payment.receipt_prompt':
    'اعلام شما ثبت شد. هنوز مبلغی دریافت یا تأیید نشده است.\n\nاکنون تصویر یا فایل رسید را در همین گفتگو ارسال کنید. تا {minutes} دقیقه فرصت دارید.',
  'bot.payment.receipt_received':
    'رسید شما دریافت و به این پرداخت پیوست شد. هنوز مبلغی تأیید نشده است؛ پس از بررسی، نتیجه به شما اطلاع داده می‌شود.',
  'bot.payment.receipt_not_expected':
    'در حال حاضر منتظر رسیدی از شما نیستیم. برای ارسال رسید، ابتدا پیام پرداخت خود را باز کنید و دکمهٔ ارسال رسید را بزنید.',
  'bot.payment.receipt_expired':
    'مهلت ارسال رسید به پایان رسید. لطفاً دوباره از پیام پرداخت، دکمهٔ ارسال رسید را بزنید.',
  'bot.payment.receipt_limit':
    'برای این پرداخت {limit} رسید ثبت شده است و بیش از این پذیرفته نمی‌شود. همین رسیدها بررسی می‌شوند.',
  'bot.payment.window_too_short':
    'مهلت این سفارش برای پرداخت کارت به کارت کافی نیست. لطفاً دوباره سفارش دهید.',
  'bot.payment.cancel_button': 'انصراف از پرداخت',
  'bot.payment.cancel_confirm':
    'آیا از انصراف این پرداخت مطمئن هستید؟ کد پیگیری فعلی باطل می‌شود و اگر پس از آن مبلغی واریز کنید، قابل پیگیری نخواهد بود. این کار برگشت‌پذیر نیست.',
  'bot.payment.cancel_confirm_button': 'بله، انصراف بده',
  'bot.payment.cancelled':
    'پرداخت شما لغو شد و کد پیگیری قبلی دیگر معتبر نیست. سفارش تا پایان مهلت آن باز است و می‌توانید با روش دیگری پرداخت کنید.',
  // Sent by the customer notification lane, not as a reply. Both say the payment is
  // closed and neither says the ORDER is: a rejection and an expiry leave the order open
  // until its own deadline, which is the behaviour OQ-4G-05 records.
  /*
   * The second sentence is CONDITIONAL since 5B, and that is a correctness fix rather
   * than a wording preference. It used to assert «سفارش شما همچنان باز است» — your order
   * is still open — and a rejected wallet TOP-UP has no order at all, so the one sentence
   * this lane sends for a rejection was false for half of what it can now be sent about.
   * One kind, one frozen template (ADR 0030), so the sentence has to be true of both.
   */
  'bot.payment.rejected':
    'پرداخت شما بررسی شد و تأیید نشد. اگر سفارشی در انتظار پرداخت دارید، تا پایان مهلت آن می‌توانید دوباره پرداخت کنید.',
  'bot.payment.expired': 'مهلت پرداخت شما به پایان رسید و این پرداخت بسته شد.',
  'bot.payment.not_pending': 'این پرداخت دیگر در انتظار نیست.',

  'bot.service.list_empty': 'هنوز سرویسی ندارید.',
  'bot.service.list_heading': 'سرویس‌های شما:',
  'bot.service.list_more': 'سرویس‌های بیشتر',
  // ONE message for a service that is not theirs and one that does not exist. Telling
  // them apart would make the bot an oracle for guessing service ids; `templates.ts`
  // records the reasoning.
  'bot.service.not_found': 'این سرویس در دسترس شما نیست.',
  'bot.service.detail':
    'سرویس: {productTitle}\nوضعیت: {state}\nمصرف: {usedTrafficBytes} از {totalTrafficBytes}\nانقضا: {expiresAt}\nآخرین به‌روزرسانی مصرف: {syncedAt}',
  'bot.service.subscription': 'لینک اشتراک شما:\n<code>{subscriptionUrl}</code>',
  'bot.service.resend_button': 'ارسال دوباره لینک اشتراک',
  'bot.service.provisioning': 'سرویس شما در حال ساخته شدن است. نتیجه به شما اطلاع داده می‌شود.',
  // Deliberately does NOT invite a retry: `templates.ts` records that a retry after an
  // unknown outcome is how a duplicate account is created.
  /*
   * The six reminders.
   *
   * Each names the SERVICE, states the fact with the figures the reminder was raised
   * against, and gives the next step. The numbers are placeholders rather than words
   * because the thresholds are a tenant's settings now (CBR-003, CBR-011): a body that
   * said «سه روز» would be wrong the moment an operator configured five.
   *
   * The figures are a SNAPSHOT taken when the reminder was raised, not a value re-read
   * at send time, so the sentence cannot disagree with the threshold it names.
   */
  'bot.service.expiry_first':
    'سرویس «{service}» تا {days} روز دیگر به پایان اعتبار می‌رسد (تاریخ: {expiresAt}).\n' +
    'برای جلوگیری از قطع شدن، از بخش «سرویس‌های من» تمدید کنید.',
  'bot.service.expiry_second':
    'تنها {days} روز تا پایان اعتبار سرویس «{service}» مانده است (تاریخ: {expiresAt}).\n' +
    'برای جلوگیری از قطع شدن، همین حالا از بخش «سرویس‌های من» تمدید کنید.',
  'bot.service.expired':
    'اعتبار سرویس «{service}» در {expiresAt} به پایان رسید.\n' +
    'از بخش «سرویس‌های من» می‌توانید آن را تمدید کنید.',
  'bot.service.usage_first':
    '{usagePercent} درصد از حجم سرویس «{service}» مصرف شده است ({usedTraffic} از {totalTraffic}).\n' +
    'در صورت نیاز می‌توانید از بخش «سرویس‌های من» حجم اضافه کنید.',
  'bot.service.usage_second':
    '{usagePercent} درصد از حجم سرویس «{service}» مصرف شده است ({usedTraffic} از {totalTraffic}).\n' +
    'برای جلوگیری از قطع شدن، از بخش «سرویس‌های من» حجم اضافه کنید.',
  'bot.service.usage_final':
    'حجم سرویس «{service}» به پایان رسید ({usedTraffic} از {totalTraffic}).\n' +
    'از بخش «سرویس‌های من» می‌توانید حجم اضافه کنید.',
  'bot.service.provision_delayed':
    'ساخت سرویس کامل نشد و موضوع به پشتیبانی اطلاع داده شد. لطفاً منتظر پیگیری بمانید.',
  'bot.service.renew_button': 'تمدید سرویس',
  'bot.service.add_traffic_button': 'حجم اضافه',
  'bot.service.add_time_button': 'زمان اضافه',
  // ONE message for "no package is configured", "the plan behind this renewal was
  // withdrawn" and "this panel cannot do it". The customer's next step is the same for
  // all three, and naming which would tell them about an operator's configuration;
  // `templates.ts` records that the operational log carries the distinction.
  'bot.service.action_unavailable': 'این امکان در حال حاضر برای این سرویس در دسترس نیست.',
  'bot.service.action_not_allowed': 'وضعیت این سرویس اجازه‌ی این کار را نمی‌دهد.',
  'bot.service.action_in_progress':
    'یک درخواست قبلی برای این سرویس هنوز اعمال نشده است. چند لحظه بعد دوباره تلاش کنید.',
  'bot.service.addon_choice': 'یکی از بسته‌های زیر را انتخاب کنید:',
  'bot.service.addon_option': '{title} — {price}',
  'bot.service.action_quote':
    '{productTitle}\nحجم افزوده: {trafficBytes}\nمدت افزوده: {durationDays}\nمبلغ: {total}',
  'bot.service.action_confirm_button': 'تأیید و پرداخت',
  'bot.service.suspend_button': 'توقف موقت سرویس',
  'bot.service.resume_button': 'فعال‌سازی دوباره سرویس',
  'bot.service.terminate_button': 'حذف سرویس',
  'bot.service.terminate_confirm':
    'آیا از حذف «{productTitle}» مطمئن هستید؟ با تأیید، حساب شما روی سرور پاک می‌شود و این کار برگشت‌پذیر نیست.',
  'bot.service.terminate_confirm_button': 'بله، سرویس حذف شود',
  'bot.service.action_requested': 'درخواست شما ثبت شد و در حال اعمال روی سرور است.',
  // The counterparts to `action_requested`, sent by the notification lane once the
  // provisioner has an answer. `action_failed` deliberately carries no reason: a
  // provider failure is operational detail and belongs in the operations log.
  'bot.service.action_succeeded': 'درخواست شما با موفقیت روی سرور اعمال شد.',
  'bot.service.action_failed':
    'درخواست شما اعمال نشد. لطفاً دوباره تلاش کنید یا با پشتیبانی تماس بگیرید.',
  'bot.service.capability_unsupported': 'این قابلیت برای سرویس شما در دسترس نیست.',

  'bot.discount.applied': 'کد تخفیف {code} اعمال شد. مبلغ تخفیف: {amount}',
  // One message for every rejection reason, so the bot is not an oracle for guessing
  // codes. `templates.ts` records the reasoning.
  'bot.discount.rejected': 'این کد تخفیف قابل استفاده نیست.',

  'bot.referral.invite': 'کد معرف شما: {referralCode}',
  'bot.referral.unconfigured': 'برنامه معرفی دوستان در حال حاضر فعال نیست.',

  'bot.trial.unavailable': 'سرویس آزمایشی در حال حاضر در دسترس نیست.',
  'bot.trial.issued':
    'سرویس آزمایشی شما در حال ساخته شدن است. لینک اشتراک به‌محض آماده شدن برایتان ارسال می‌شود.',
  'bot.trial.button': '🎁 دریافت سرویس آزمایشی',
  'bot.trial.not_delivered':
    'متأسفیم، سرویس آزمایشی شما ساخته نشد. این مورد جزو سهمیه سرویس آزمایشی شما حساب نمی‌شود.',
};
