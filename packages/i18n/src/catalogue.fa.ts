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
  'bot.unknown_command': 'این دستور شناخته نشد.',
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

  'bot.wallet.balance': 'موجودی کیف پول شما: {balance}',
  'bot.wallet.insufficient': 'موجودی کیف پول کافی نیست. کمبود: {shortfall}',

  'bot.payment.manual_instructions':
    'برای پرداخت مبلغ {total} طبق راهنمای فروشنده اقدام کنید و سپس رسید را ارسال نمایید.\nکد پیگیری این پرداخت: {reference}',
  'bot.payment.wallet_button': 'پرداخت از کیف پول',
  'bot.payment.manual_button': 'پرداخت کارت به کارت',
  'bot.payment.unconfigured': 'این روش پرداخت در حال حاضر فعال نیست.',
  'bot.payment.received_for_review': 'رسید شما دریافت شد و برای بررسی در نوبت قرار گرفت.',

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
