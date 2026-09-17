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

  'bot.order.summary':
    'سفارش شما\nسرویس: {productTitle}\nمدت: {durationDays}\nحجم: {trafficBytes}\nمبلغ قابل پرداخت: {total}',
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
  'bot.payment.rejected':
    'پرداخت شما بررسی شد و تأیید نشد. سفارش شما همچنان باز است و می‌توانید تا پایان مهلت آن دوباره پرداخت کنید.',
  'bot.payment.expired': 'مهلت پرداخت شما به پایان رسید و این پرداخت بسته شد.',
  'bot.payment.not_pending': 'این پرداخت دیگر در انتظار نیست.',

  'bot.service.list_empty': 'هنوز سرویسی ندارید.',
  'bot.service.list_heading': 'سرویس‌های شما:',
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
  'bot.trial.issued': 'سرویس آزمایشی شما در حال ساخته شدن است.',
};
