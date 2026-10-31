import type { OpsLogButtonKind } from '@nexa/contracts';

/**
 * Round 4 PR-D — the operations log group, in Persian.
 *
 * Every log type's DEFAULT body (the owner's reviewed spec, Appendix L) and the few words
 * the application layer needs but may not import this package for (the boundary check keeps
 * `@nexa/i18n` out of application code): the container binds `OPS_LOG_WORDS_FA` to the
 * `OpsLogWords` port.
 *
 * The bodies are RAW — `{token}` placeholders un-substituted, and no UUID, tenant, bot or
 * correlation line anywhere: a short public code stands where an id used to. A line whose
 * placeholders are all absent is dropped by the renderer, so a fact the message does not have
 * (a fee of zero, a phone number nobody verified) leaves no empty label behind. The
 * templates are rendered with Persian digits (`digits: 'PERSIAN'`); a STRING value is never
 * converted.
 */

export const OPS_LOG_BODIES_FA = {
  // --- Generic operational events and the error reports (ERRORS topic) --------------------
  'ops.notification.operational_event':
    '{severity} — {heading}\n\n🔧 {technical}\n👤 نام کاربری سرویس: {serviceUsername}\n{details}\n🔁 تعداد رخداد: {occurrences}\n🕒 نخستین بار: {firstSeenAt}\n🕒 این بار: {lastSeenAt}',
  'ops.notification.payment_link_failed':
    '🚨 خطای درگاه — لینک پرداخت ساخته نشد\n\n👤 {displayName} · {username} · {telegramId}\n💠 درگاه: {gateway}\n💰 مبلغ: {amount}\n❗ علت: {cause}\n🔧 کد: {technical}\n🔁 تلاش دوباره: {retry}\n👤 برای مشتری: {impact}\n🔖 کد پیگیری: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n🧾 فاکتور درگاه: {providerInvoiceId}\n🕒 {at}',
  'ops.log.error_provision':
    '🚨 سرویس ساخته نشد — {cause}\n\n👤 {displayName} · {username} · {telegramId}\n📦 {productTitle}\n🖥 پنل: {panelName}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ: {amount}\n❗ علت: {cause}\n🔧 کد: {technical}\n↩️ برای مشتری: {impact}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🕒 {at}',
  'ops.log.error_provision_admin':
    '🚨 سرویسِ ساخته‌شده توسط ادمین، ساخته نشد — {cause}\n\n🧑‍💼 ادمین: {adminName} · {adminUsername} · {adminTelegramId}\n👤 مشتری: {displayName} · {username} · {telegramId}\n📦 {productTitle}\n🖥 پنل: {panelName}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ: {amount}\n❗ علت: {cause}\n🔧 کد: {technical}\n↩️ برای مشتری: {impact}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🕒 {at}',
  'ops.log.error_operation':
    '🚨 {operation} — {state}\n\n👤 {displayName} · {username} · {telegramId}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n💰 مبلغ: {amount}\n❗ علت: {cause}\n🔧 کد: {technical}\n❓ برای مشتری: {impact}\n🔁 {retry}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🕒 {at}',
  'ops.log.storm_rollup':
    '🚨 {heading}\n\n🔁 {count} خطای دیگر — {users} کاربر\n❗ علت: {cause}\n🔧 کد: {technical}\n🖥 پنل: {panelName}\n🕒 {at}',

  // --- Payments ---------------------------------------------------------------------------
  'ops.financial.topup_credited':
    '✅ شارژ کیف پول تأیید و واریز شد\n\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n💰 مبلغ واریز به کیف پول: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مجموع پرداختی: {payable}\n🎁 هدیهٔ شارژ: {gift}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n📊 مبلغ نهایی گزارش‌شدهٔ درگاه (فقط برای بررسی): {providerFinalAmount}\n🔎 منبع تأیید: {evidence}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n🕒 زمان: {at}',
  'ops.financial.order_paid':
    '✅ پرداخت سفارش تأیید شد{badges}\n\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n🏷 محصول: {productTitle}\n🔧 عملیات: {operation}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n📊 مبلغ نهایی گزارش‌شدهٔ درگاه (فقط برای بررسی): {providerFinalAmount}\n🔎 منبع تأیید: {evidence}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n🕒 زمان: {at}',
  'ops.log.payment_crypto':
    '🪙 {kindTitle} — {principal}\n\n👤 {displayName} · {username} · {telegramId}\n💠 روش: {method}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n🧾 فاکتور درگاه: {providerInvoiceId}\n🆔 شناسهٔ پرداخت درگاه: {providerPaymentId}\n💱 معادل ارزی سفارش: {fiatEquivalent}\n🔢 مبلغ درخواستی: {cryptoRequested}\n💸 مبلغ پرداخت‌شده: {cryptoPaid}\n📥 مبلغ دریافتی نهایی: {cryptoReceived}\n📍 وضعیت پرداخت: {providerStatus}\n🏦 آدرس کیف پول: {walletAddress}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n🔖 کد پیگیری: {reference}\n🕒 {at}',
  // R8 A3: one headline per outcome; the lines under it are the same four messages' own.
  'ops.financial.payment_failed':
    '❌ پرداخت ناموفق\n\n⚠️ علت: {cause}\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🕒 زمان: {at}',
  'ops.financial.invoice_cancelled':
    '🚫 فاکتور لغو شد\n\n🙋 لغوکننده: {cancelledBy}\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🕒 زمان: {at}',
  'ops.financial.receipt_rejected':
    '🧾 رسید رد شد\n\n📝 دلیل رد: {rejectReasons}\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🕒 زمان: {at}',
  'ops.financial.payment_expired':
    '⌛ پرداخت منقضی شد\n\n⚠️ درگاه مهلت پرداخت را تمام‌شده اعلام کرد و پولی دریافت نشد.\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🕒 زمان: {at}',
  // R9 C1: an open attempt paid less or more than invoiced — nothing settled, nothing credited.
  'ops.financial.payment_underpaid':
    '⚠️ پرداخت ناقص — منتظر مابقی\n\nدرگاه اعلام کرد مشتری کمتر از مبلغ فاکتور واریز کرده و منتظر واریز مابقی است. هیچ مبلغی تسویه یا به کیف پول واریز نشده است.\n\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n➖ مابقی اعلام‌شدهٔ درگاه (فقط برای بررسی): {remainingAmount}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n🧾 شناسه فاکتور مابقی: {remainderInvoiceId}\n🕒 زمان: {at}',
  'ops.financial.payment_overpaid':
    '⚠️ پرداخت بیش از مبلغ — منتظر کارت بازگشت\n\nدرگاه اعلام کرد مشتری بیشتر از مبلغ فاکتور واریز کرده و منتظر کارت مشتری برای بازگشت مازاد است. مازاد هرگز به کیف پول واریز نمی‌شود؛ پرداخت فقط با مبلغ اصل تسویه می‌شود.\n\n💠 روش: {method}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n➕ مازاد اعلام‌شدهٔ درگاه (فقط برای بررسی): {refundAmount}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n🕒 زمان: {at}',
  'ops.financial.late_completion':
    '⚠️ تأیید دیرهنگام درگاه پس از بسته‌شدن پرداخت\n\nاین پرداخت در Nexa بسته شده بود و هیچ مبلغی ثبت نشد؛ نیاز به بررسی دستی دارد.\n\n💠 درگاه: {gateway}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n📊 مبلغ نهایی گزارش‌شدهٔ درگاه (فقط برای بررسی): {providerFinalAmount}\n🕒 زمان: {at}',
  'ops.financial.late_credit':
    '💰 تأیید دیرهنگام — واریز به کیف پول\n\nدرگاه این پرداخت را پس از پایان مهلت تأیید کرد، استعلام درگاه تأیید را دوباره بررسی کرد و مبلغ به کیف پول مشتری واریز شد. سفارش دوباره باز نشد و سرویسی ساخته نشد.\n\n💠 درگاه: {gateway}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ واریزشده: {amount}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n⏳ زمان انقضا: {expiredAt}\n✅ زمان تأیید: {approvedAt}',
  // R12 F1: money for a cancelled attempt, or a second payment for an order already paid.
  'ops.financial.late_credit_returned':
    '💰 پرداخت دیرهنگام به کیف پول برگشت\n\nدرگاه پولی را برای پرداختی تأیید کرد که دیگر نمی‌توانست سفارش را پرداخت کند (این پرداخت لغو شده بود یا سفارش از راه دیگری پرداخت شده بود). استعلام درگاه تأیید را دوباره بررسی کرد و اصل مبلغ به کیف پول مشتری برگشت. سفارش تغییری نکرد و سرویسی ساخته نشد.\n\n💠 درگاه: {gateway}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ برگشتی به کیف پول: {amount}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n✅ زمان تأیید: {approvedAt}',
  'ops.financial.outcome_unknown':
    '❓ نتیجهٔ پرداخت درگاه نامعلوم ماند\n\nمهلت بررسی درگاه بدون پاسخ قطعی تمام شد. هیچ مبلغی ثبت یا رد نشده است؛ نیاز به تطبیق دستی دارد.\n\n💠 درگاه: {gateway}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n📊 مبلغ نهایی گزارش‌شدهٔ درگاه (فقط برای بررسی): {providerFinalAmount}\n🕒 زمان: {at}',
  'ops.financial.credit_amount_mismatch':
    '⚠️ مبلغ اعلام‌شدهٔ درگاه با فاکتور نمی‌خواند\n\nوب‌هوک درگاه مبلغی (credit_amount) گزارش کرد که نه با مبلغ اصل و نه با مبلغ درخواستی Nexa برابر است. هیچ مبلغی بر اساس آن واریز نشده و نمی‌شود؛ پرداخت فقط با استعلام درگاه و با مبلغ اصل تسویه می‌شود. با سوابق درگاه تطبیق دهید.\n\n💠 درگاه: {gateway}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ اصل: {principal}\n💳 کارمزد درگاه: {fee}\n💵 مبلغ قابل پرداخت: {payable}\n📨 مبلغ اعلام‌شدهٔ وب‌هوک: {creditAmount}\n📤 مبلغ درخواستی Nexa از درگاه: {invoicedAmount}\n🧾 شناسه فاکتور درگاه: {providerInvoiceId}\n🕒 زمان: {at}',
  'ops.financial.refund_completed':
    '↩️ بازگشت وجه انجام شد\n\n📤 مقصد: {channel}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ بازگشتی: {amount}\n👛 موجودی کیف پول: {balanceBefore} ← {balanceAfter}\n🕒 زمان: {at}',
  'ops.financial.refund_failed':
    '⛔️ بازگشت وجه ناموفق/لغو شد\n\n📤 مقصد: {channel}\n⚠️ علت: {cause}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🔖 کد پیگیری پرداخت: {reference}\n📦 سفارش: {orderCode}\n👤 نام کاربری سرویس: {serviceUsername}\n💰 مبلغ: {amount}\n🕒 زمان: {at}',
  'ops.financial.service_refund_request':
    '📝 نتیجهٔ درخواست بازگشت وجه سرویس\n\nوضعیت: {outcome}\n👤 کاربر: {displayName} | {username} | {telegramId}\n🧩 کد سرویس: {serviceCode}\n👤 نام کاربری سرویس: {serviceUsername}\n🔖 کد پیگیری پرداخت: {reference}\n💰 مبلغ تأییدشده: {amount}\n👮 تصمیم‌گیرنده: {adminName}\n🕒 زمان: {at}',
  'ops.log.wallet_adjusted':
    '{heading} — {amount}\n\n👤 کاربر: {displayName} · {username} · {telegramId}\n👛 موجودی: {balanceBefore} ← {balanceAfter}\n👮 ادمین: {adminName} · {adminUsername} · {adminTelegramId}\n📝 دلیل: {reason}\n🔔 اطلاع به کاربر: {customerNotified}\n🕒 {at}',
  'ops.log.wallet_mass_credited':
    '💰 شارژ گروهی کیف پول — {amount} برای هر کاربر\n\n👥 شارژشده: {recipients} کاربر\n⏭ ردشده: {skipped} کاربر\n💵 جمع واریز: {total}\n👮 ادمین: {adminName} · {adminUsername} · {adminTelegramId}\n📝 دلیل: {reason}\n🔔 اطلاع به کاربران: {customerNotified}\n🕒 {at}',
  'ops.log.referral_commission':
    '🤝 پرداخت پورسانت معرف — {amount}\n\n👤 دریافت‌کنندهٔ پورسانت (معرف): {referrerName} · {referrerUsername} · {referrerTelegramId}\n📞 شمارهٔ معرف: {referrerPhone}\n🛒 کاربر خریدار (زیرمجموعه): {buyerName} · {buyerUsername} · {buyerTelegramId}\n📞 شمارهٔ خریدار: {buyerPhone}\n📦 بابت: {productTitle}\n💵 مبلغ خرید: {orderTotal}\n📐 سهم پورسانت: {percent}\n👛 موجودی معرف: {balanceBefore} ← {balanceAfter}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🕒 {at}',
  'ops.log.signup_gift':
    '🎁 هدیهٔ عضویت\n\n🆕 زیرمجموعه (کاربر جدید): {refereeName} · {refereeUsername} · {refereeTelegramId}\n   👛 {refereeBefore} ← {refereeAfter}\n👤 معرف: {referrerName} · {referrerUsername} · {referrerTelegramId}\n   👛 {referrerBefore} ← {referrerAfter}\n🕒 {at}',

  'ops.log.gift_card_redeemed':
    '🎁 استفاده از کارت هدیه — {amount}\n\n👤 کاربر: {displayName} · {username} · {telegramId}\n🗂 دسته: {batchLabel}\n🔢 چهار حرف آخر کد: {codeLast4}\n👛 موجودی: {balanceBefore} ← {balanceAfter}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.gift_card_batch_created':
    '🎁 ساخت دستهٔ کارت هدیه — {codeCount} کد × {amount}\n\n🗂 دسته: {batchLabel}\n💵 جمع ارزش اسمی: {faceTotal}\n📅 انقضا: {expiry}\n👮 ادمین: {adminName} · {adminUsername} · {adminTelegramId}\n📝 دلیل: {reason}\n🕒 {at}',
  // --- Orders and services (SERVICES topic) -----------------------------------------------
  'ops.log.service_created':
    '🛒 خرید جدید{badges}\n\n👤 {displayName} · {username} · {telegramId}\n🥇 خرید اول کاربر: {firstPurchase}\n📞 شماره: {phone}\n📦 {productTitle}\n📍 لوکیشن: {location}\n📊 حجم: {traffic}\n⏳ مدت: {duration}\n🖥 پنل: {panelName}\n👤 نام کاربری سرویس: {serviceUsername}\n💵 قیمت محصول: {listPrice}\n💵 قیمت نهایی: {price}\n💠 پرداخت: {method} — کیف پول استفاده نشد\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🧩 کد سرویس: {serviceCode}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.service_created_wallet':
    '🛒 خرید جدید{badges}\n\n👤 {displayName} · {username} · {telegramId}\n🥇 خرید اول کاربر: {firstPurchase}\n📞 شماره: {phone}\n📦 {productTitle}\n📍 لوکیشن: {location}\n📊 حجم: {traffic}\n⏳ مدت: {duration}\n🖥 پنل: {panelName}\n👤 نام کاربری سرویس: {serviceUsername}\n💵 قیمت محصول: {listPrice}\n💵 قیمت نهایی: {price}\n👛 کیف پول: {balanceBefore} ← {balanceAfter}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🧩 کد سرویس: {serviceCode}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.service_renewed':
    '🔄 تمدید سرویس{badges}\n\n👤 {displayName} · {username} · {telegramId}\n📞 شماره: {phone}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n📦 {productTitle}\n📊 مصرف قبل از تمدید: {usedBytes} از {limitBefore}\n📅 انقضا: {expiresBefore} ← {expiresAfter}\n💵 قیمت محصول: {listPrice}\n💵 مبلغ تمدید: {price}\n💠 پرداخت: {method}\n👛 کیف پول: {balanceBefore} ← {balanceAfter}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🧩 کد سرویس: {serviceCode}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.traffic_added':
    '➕ حجم اضافه — {addedBytes}{badges}\n\n👤 {displayName} · {username} · {telegramId}\n📞 شماره: {phone}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n📊 حجم کل: {limitBefore} ← {limitAfter}\n📉 مصرف‌شده: {usedBytes}\n💵 مبلغ: {price}\n💠 پرداخت: {method}\n👛 کیف پول: {balanceBefore} ← {balanceAfter}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🧩 کد سرویس: {serviceCode}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.time_added':
    '⏳ زمان اضافه — {addedDays}{badges}\n\n👤 {displayName} · {username} · {telegramId}\n📞 شماره: {phone}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n📅 انقضا: {expiresBefore} ← {expiresAfter}\n💵 مبلغ: {price}\n💠 پرداخت: {method}\n👛 کیف پول: {balanceBefore} ← {balanceAfter}\n🔖 کد سفارش: {orderCode}\n🔖 کد پرداخت: {reference}\n🧩 کد سرویس: {serviceCode}\n📲 منبع: {source}\n🕒 {at}',
  'ops.log.link_changed':
    '🔁 تغییر لینک سرویس\n\n👤 {displayName} · {username} · {telegramId}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n🙋 درخواست از: {byWhom}\n🔢 بار {rotations} در ۳۰ روز گذشته\n🚫 لینک قبلی دیگر کار نمی‌کند.\n🧩 کد سرویس: {serviceCode}\n🕒 {at}',
  'ops.log.trial_created':
    '🧪 اکانت تست\n\n👤 {displayName} · {username} · {telegramId}\n📞 شماره: {phone}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n📊 حجم: {traffic}\n⏳ مدت: {duration}\n🧩 کد سرویس: {serviceCode}\n🕒 {at}',
  'ops.log.service_alert':
    '{heading}\n\n👤 {displayName} · {username} · {telegramId}\n👤 نام کاربری سرویس: {serviceUsername}\n🖥 پنل: {panelName}\n📍 وضعیت: {status}\n📉 حجم باقی‌مانده: {remainingBytes}\n⏳ زمان باقی‌مانده: {remainingTime}\n🔌 آخرین اتصال: {lastConnection}\n🕒 {at}',

  // --- Customers, administrators, resellers -----------------------------------------------
  'ops.log.user_new':
    '🆕 کاربر جدید\n\n👤 {displayName} · {username} · {telegramId}\n📞 شماره: {phone}\n🤝 معرف: {referrerName} · {referrerUsername} · {referrerTelegramId}\n🕒 {at}',
  'ops.log.user_blocked':
    '{heading}\n\n👤 {displayName} · {username} · {telegramId}\n👮 ادمین: {adminName} · {adminUsername}\n🧭 نوع: {blockType}\n⏳ مدت: {until}\n📝 دلیل: {reason}\n🕒 {at}',
  'ops.log.admin_changed':
    '{heading}\n\n👤 {targetName} · @{targetUsername} · {targetTelegramId}\n🎭 نقش‌ها: {roles}\n🎭 تغییر نقش: {rolesBefore} ← {rolesAfter}\n🔐 دسترسی‌ها: {permissions} مجوز\n🙋 توسط: {actorName}\n🕒 {at}',
  'ops.log.reseller_changed':
    '{heading}\n\n👤 {displayName} · {username} · {telegramId}\n🧑‍💼 {tierBefore} ← {tierAfter}\n📝 دلیل: {reason}\n🙋 توسط: {actorName}\n🕒 {at}',

  // --- Panels and support -----------------------------------------------------------------
  'ops.log.panel_down':
    '🟥 پنل «{panelName}» از دسترس خارج شد\n\n❗ علت: {cause}\n🔧 کد: {technical}\n⛔ {salesNote}\n🕒 از {since}',
  'ops.log.panel_up': '🟩 پنل «{panelName}» برگشت — {at}\n⏱ مدت قطعی: {downtime}',
  'ops.support.ticket_opened':
    '🎫 تیکت جدید #{ticketNumber} · {category}\n\n👤 {displayName} · {username} · {telegramId}\n💬 «{snippet}»\n📲 منبع: {source}\n🕒 {at}',
  'ops.support.customer_replied':
    '💬 پیام تازهٔ کاربر — تیکت #{ticketNumber} · {category}\n\n👤 {displayName} · {username} · {telegramId}\n💬 «{snippet}»\n📲 منبع: {source}\n🕒 {at}',

  // --- The nightly reports (REPORTS topic) and the backup caption -------------------------
  'ops.log.report_summary':
    '📊 گزارش روز — {day}\n\n💰 فروش: {sales} {salesChange}\n🛒 خرید جدید: {newPurchases} (🥇 خرید اول: {firstPurchases})\n🔄 تمدید: {renewals}\n👥 کاربر جدید: {newCustomers}\n👤 کاربر فعال: {activeCustomers}\n🟢 مشتری دارای سرویس فعال: {customersWithService}\n⚪️ مشتری بدون سرویس فعال: {customersWithoutService}\n🧪 تست: {trials}\n📶 سرویس فعال: {activeServices}\n⏰ بهترین ساعت: {bestHour}\n⚠️ خطاها: {errors}\n❌ پرداخت ناموفق: {failedPayments}\n🎫 تیکت باز: {openTickets}\n{cleanup}',
  'ops.log.report_financial':
    '💵 مالی امروز — {day}\n\n🛒 خرید جدید: {newOrdersSum}\n🔄 تمدید: {renewalsSum}\n➕ حجم اضافه ({trafficCount}): {trafficSum}\n⏳ زمان اضافه ({timeCount}): {timeSum}\n🔧 سایر خریدها ({otherCount}): {otherSum}\n━━━━━━━━━━━━━━\n📥 ناخالص: {gross}\n➖ بازگشت وجه ({refundsCount}): {refundsSum}\n➖ پورسانت ({commissionCount}): {commissionSum}\n➖ هدیهٔ شارژ: {giftSum}\n✅ خالص: {net}\n\n💠 به تفکیک روش: {methods}',
  'ops.log.report_panels':
    '🖥 پنل‌ها و نماینده‌ها — {day}\n\n{panelsBlock}\n\n{resellersBlock}\n{topResellers}',
  'ops.log.backup_caption':
    '💾 بکاپ — {at}\n📦 {fileName} · {size}\n✅ رمزگذاری و بازیابی آزمایشی موفق\n🕒 بکاپ بعدی: {nextAt}\nSHA-256: {checksum}',

  // --- Topic names ------------------------------------------------------------------------
  'ops.group.topic_name.users': '👥 کاربران',
  'ops.group.topic_name.reports': '📊 گزارش‌ها',
} as const;

/**
 * The words the log builders need, as plain data. The application layer reaches them through
 * the `OpsLogWords` port and never imports this package.
 */
export const OPS_LOG_WORDS_FA = {
  /** What a missing name, username or Telegram id reads as: a word, never a dash. */
  noName: 'بدون نام',
  noUsername: 'بدون یوزرنیم',
  noTelegram: 'بدون تلگرام',
  none: '—',
  /** The title of an operational event whose code the Persian label map does not know. */
  unknownEvent: 'رویداد سامانه',
  /**
   * R11 A3: a process role that keeps restarting (`process.restart_storm`) and its end. The
   * role is already a Persian name (the loop-stall role table); the digits are Persian too.
   */
  restartStorm: {
    heading: (role: string): string => `سرویس ${role} پی‌درپی ری‌استارت می‌شود`,
    endedHeading: (role: string): string => `سرویس ${role} دوباره پایدار شد`,
    detail: (restarts: string, minutes: string): string =>
      `${restarts} بار ری‌استارت در ${minutes} دقیقه، هر بار کمتر از یک دقیقه کار کرد`,
  },
  /**
   * `provisioning.stalled` for an operation that is NOT a paid PROVISION (R5A-2 item 6): the
   * title names what actually stalled. The code is unchanged — only the rendered words vary by
   * the operation type the event's context carries.
   */
  stalledOperation: {
    RENEW: 'تمدید سرویس ناموفق ماند',
    ADD_TRAFFIC: 'افزودن ترافیک به سرویس ناموفق ماند',
    ADD_TIME: 'افزودن زمان به سرویس ناموفق ماند',
    SUSPEND: 'تعلیق سرویس ناموفق ماند',
    RESUME: 'ازسرگیری سرویس ناموفق ماند',
    TERMINATE: 'حذف سرویس ناموفق ماند',
    SYNC_USAGE: 'خواندن مصرف سرویس ناموفق ماند',
    ROTATE_SUBSCRIPTION: 'تعویض لینک اشتراک سرویس ناموفق ماند',
    RECONCILE: 'تطبیق سرویس با پنل ناموفق ماند',
    ADD_DEVICES: 'افزایش تعداد دستگاه سرویس ناموفق ماند',
    CHANGE_LOCATION: 'تغییر مکان سرویس ناموفق ماند',
  },

  paymentMethods: {
    WALLET: 'کیف پول',
    MANUAL_TRANSFER: 'کارت به کارت',
    GATEWAY: 'درگاه پرداخت',
  },
  /** The gateway a customer paid through, by provider: the method's name, shown ONCE. */
  gateways: {
    MANUAL_TRANSFER: 'کارت به کارت',
    TONPAYS: 'تون‌پی (وب‌سایت)',
    TONPAYS_TELEGRAM: 'تون‌پی تلگرام',
    TELEGRAM_STARS: 'استارز تلگرام',
    NOWPAYMENTS: 'ارز دیجیتال (NowPayments)',
    CENTRALPAY: 'سنترال‌پی',
    TETRAPAY: 'تتراپی',
    RIALIT: 'ریالیت',
    CUSTOM: 'درگاه سفارشی',
  },
  /** How a gateway payment was paid, per the provider (TetraPay `method`). */
  gatewayMethods: { online: 'آنلاین', card: 'کارت' },
  evidence: {
    OPERATOR_REVIEW: 'بررسی اپراتور',
    WALLET_DEBIT: 'کسر از کیف پول',
    GATEWAY_CALLBACK: 'پیام تأیید تلگرام',
    RECONCILIATION: 'تطبیق دستی با درگاه',
    GATEWAY_INQUIRY: 'استعلام درگاه',
    LEGACY_IMPORT: 'انتقال از ربات قبلی',
  },
  paymentFailure: {
    REJECTED: 'رسید توسط اپراتور رد شد',
    GATEWAY_FAILED: 'درگاه پرداخت را ناموفق اعلام کرد',
  },
  /*
   * R8 A3: the real cause of a gateway failure, by the provider's status or the machine code
   * the payment was closed with (`<provider>:<code>`). A code this table lacks is the generic
   * sentence above with the code beside it, never a guess.
   */
  gatewayFailureCauses: {
    failed: 'درگاه پرداخت را ناموفق اعلام کرد',
    refunded: 'درگاه پول را به پرداخت‌کننده برگرداند',
    partially_paid: 'کمتر از مبلغ فاکتور پرداخت شد و درگاه پرداخت را ناموفق بست',
    unverified: 'درگاه پرداخت را تأیید نکرد',
    'nexa.credential_missing': 'کلید API درگاه تنظیم نشده است؛ فاکتوری ساخته نشد',
    RATE_LIMIT_EXCEEDED: 'درگاه به‌دلیل محدودیت تعداد درخواست فاکتور نساخت',
    BUYER_HAS_PENDING_INVOICE: 'مشتری در درگاه فاکتور پرداخت‌نشدهٔ دیگری داشت',
    BUYER_HAS_PROCESSING_INVOICE: 'مشتری در درگاه فاکتور در حال بررسی دیگری داشت',
    BUYER_HAS_NEED_ACTION_LESS: 'مشتری در درگاه فاکتوری با کسری پرداخت داشت',
    BUYER_HAS_NEED_ACTION_MORE: 'مشتری در درگاه فاکتوری با اضافه‌پرداخت داشت',
    // Round 9 C4: Rialit's create refusals, by the code the payment was closed with.
    'rialit.DOUBLE_FEE':
      'هم کارمزد درگاه ربات و هم کارمزد پرداخت‌کنندهٔ ریالیت روشن است؛ لینک به مشتری داده نشد (یکی از دو کارمزد را صفر کنید)',
    'rialit.PAYER_AMOUNT_MISMATCH':
      'ارقام پاسخ ریالیت (مبلغ، کارمزد و مبلغ پرداخت‌کننده) با هم جور نبود؛ لینک به مشتری داده نشد',
    'rialit.PAYER_AMOUNT_UNREADABLE':
      'مبلغ پرداخت‌کننده در پاسخ ریالیت خوانا نبود؛ لینک به مشتری داده نشد',
    'rialit.UNAUTHORIZED': 'کلید API ریالیت پذیرفته نشد؛ فاکتوری ساخته نشد',
    'rialit.IP_NOT_ALLOWED': 'نشانی IP سرور در فهرست مجاز ریالیت نیست؛ فاکتوری ساخته نشد',
    'rialit.MERCHANT_INACTIVE': 'حساب پذیرندهٔ ریالیت غیرفعال است؛ فاکتوری ساخته نشد',
    // Round 10 C1: the custom gateway's refusals, by the code the payment was closed with.
    'custom.ENDPOINT_MISSING': 'نشانی پل درگاه سفارشی تنظیم نشده است؛ درخواستی فرستاده نشد',
    'custom.ECHO_MISMATCH':
      'پل درگاه سفارشی برای شناسه یا مبلغی جز آنچه درخواست شده بود پاسخ داد؛ لینک به مشتری داده نشد',
    'custom.LINK_REJECTED': 'لینک پرداختی که پل فرستاد https نبود؛ لینک به مشتری داده نشد',
    'custom.SIGNATURE_INVALID':
      'پل درگاه سفارشی امضای درخواست نکسا را نپذیرفت (کلید را بررسی کنید)',
    'custom.TIMESTAMP_OUT_OF_WINDOW': 'ساعت سرور نکسا و پل درگاه سفارشی بیش از ۵ دقیقه اختلاف دارد',
    'custom.FORBIDDEN': 'حساب پذیرندهٔ پشت پل درگاه سفارشی غیرفعال است یا اجازه ندارد',
    'custom.AMOUNT_OUT_OF_RANGE': 'مبلغ خارج از محدودهٔ پل درگاه سفارشی بود؛ پرداختی ساخته نشد',
    'custom.AMOUNT_NOT_PAYABLE':
      'پل درگاه سفارشی این مبلغ دقیق را نمی‌تواند دریافت کند؛ پرداختی ساخته نشد',
    'custom.UNSUPPORTED_CURRENCY': 'پل درگاه سفارشی ریال را نمی‌پذیرد؛ پرداختی ساخته نشد',
    'nexa.endpoint_blocked':
      'نشانی پل درگاه سفارشی در فهرست نشانی‌های مجاز این نصب نیست؛ درخواستی فرستاده نشد',
    'rialit.AMOUNT_OUT_OF_RANGE':
      'مبلغ قابل پرداخت خارج از محدودهٔ ۵۰٬۰۰۰ تا ۱۰٬۰۰۰٬۰۰۰ تومان ریالیت بود؛ درخواستی به ریالیت فرستاده نشد',
  },
  /** The code beside a cause the table above does not know. */
  failureCodeLabel: 'کد',
  /** R8 A3: who cancelled an invoice. */
  cancelledBy: {
    CUSTOMER: 'مشتری (دکمهٔ «لغو فاکتور»)',
    NEXA: 'Nexa (فاکتور تازه‌ای جای آن را گرفت)',
    PROVIDER: 'در خود درگاه (نه از ربات)',
  },
  /** R8 A3: who rejected a receipt, before their reasons. */
  rejectedBy: { OPERATOR: 'اپراتور', PROVIDER: 'درگاه' },
  /** R8 A3: a gateway that rejected a receipt and gave no reason. */
  noRejectReason: 'دلیلی اعلام نشد',
  /** R8 A4: whether the customer is sent a message about an administrator's change. */
  customerNotified: { yes: 'بله', no: 'خیر (اعلان این تغییر خاموش است)' },
  customerNotifiedBulk: { yes: 'بله', no: 'خیر' },
  refundChannels: {
    WALLET_CREDIT: 'کیف پول',
    EXTERNAL_MANUAL: 'بازگشت دستی بیرون از ربات',
    PROVIDER: 'درگاه پرداخت',
  },
  refundFailure: {
    OPERATOR_FAILED: 'اپراتور بازگشت وجه را ناموفق ثبت کرد',
    SUPERSEDED: 'بازگشت وجه با درخواست دیگری جایگزین شد',
  },
  refundRequestOutcomes: {
    COMPLETED: 'تأیید شد؛ سرویس حذف و مبلغ به کیف پول برگشت',
    REJECTED: 'رد شد؛ چیزی تغییر نکرد',
    FAILED: 'اجرا نشد؛ سرویس حذف نشد و مبلغی برنگشت',
  },
  cryptoKinds: { topup: 'شارژ کیف پول', order: 'پرداخت سفارش' },

  walletAdjust: { CREDIT: '➕ افزایش دستی موجودی', DEBIT: '➖ کاهش دستی موجودی' },

  /** What a paid order was for (log L2): a purchase, a renewal, extra traffic, extra time. */
  paidOperations: {
    NEW_SERVICE: 'خرید',
    CUSTOM_SERVICE: 'خرید',
    TRIAL: 'خرید',
    RENEW: 'تمدید',
    ADD_TRAFFIC: 'حجم',
    ADD_TIME: 'زمان',
    OTHER: 'خرید',
  },

  badges: { firstPurchase: '🥇 اولین خرید', reseller: '🧑‍💼 نماینده', separator: ' · ' },
  /** R9 C2: the source line of a purchase, renewal, extra traffic, extra time or ticket log. */
  // Round 10, D1: «منبع: تمدید خودکار» — a renewal the worker made on the customer's consent.
  sources: { BOT: 'ربات', MINI_APP: 'مینی‌اپ', AUTO_RENEW: 'تمدید خودکار' },
  /** R9 C2: the value of the «first purchase of the customer» line (L10, L11). */
  firstPurchaseYes: 'بله',
  operations: {
    RENEW: 'تمدید انجام نشد',
    ADD_TRAFFIC: 'خرید حجم اضافه انجام نشد',
    ADD_TIME: 'خرید زمان اضافه انجام نشد',
    TRIAL: 'ساخت اکانت تست انجام نشد',
    PROVISION: 'ساخت سرویس انجام نشد',
    // R9 C2: a free extra-volume gift (an ADD_TRAFFIC operation with no order) that failed.
    ADD_TRAFFIC_GIFT: 'افزودن حجم هدیه انجام نشد',
    OTHER: 'عملیات سرویس انجام نشد',
  },
  operationStates: { FAILED: 'ناموفق', UNKNOWN: 'نتیجه نامشخص' },
  byWhom: { CUSTOMER: 'مشتری', ADMIN: 'ادمین', SYSTEM: 'سیستم' },

  providerFailures: {
    AUTHENTICATION_FAILED: 'پنل نام کاربری یا رمز عبور را نپذیرفت',
    AUTHENTICATION_REQUIRES_INTERACTION: 'پنل ورود دومرحله‌ای می‌خواهد',
    UNREACHABLE: 'اتصال به پنل برقرار نشد',
    TIMEOUT: 'پنل در مهلت مقرر جواب نداد',
    TLS_FAILED: 'گواهی SSL پنل نامعتبر یا منقضی شده است',
    BLOCKED_TARGET: 'نشانی پنل مجاز نیست',
    RATE_LIMITED: 'پنل محدودیت تعداد درخواست اعمال کرد',
    MALFORMED_RESPONSE: 'پاسخ پنل قابل خواندن نبود',
    PROVIDER_ERROR: 'پنل خطای داخلی داد',
    PROVIDER_REFUSED: 'پنل درخواست را نپذیرفت',
    UNSUPPORTED_CAPABILITY: 'این پنل از این عملیات پشتیبانی نمی‌کند',
    UNKNOWN: 'علت مشخص نیست',
  },
  /** Why an order that was paid could not be delivered and was refunded (a closed vocabulary). */
  refundReasons: {
    ARCHIVED: 'پنل بایگانی شده است',
    DISABLED: 'پنل غیرفعال است',
    DRAINING: 'فروش روی پنل در حال بسته شدن است',
    PROVISION_UNSUPPORTED: 'پنل ساخت سرویس را پشتیبانی نمی‌کند',
    CREDENTIALS_MISSING: 'مشخصات ورود پنل ثبت نشده است',
    ACTIVATION_INCOMPLETE: 'فعال‌سازی پنل کامل نیست',
    UNHEALTHY: 'پنل ناسالم است و در دسترس نیست',
    UNVALIDATED: 'اتصال پنل هنوز آزمایش نشده است',
    AT_CAPACITY: 'ظرفیت پنل پر است',
    ACTION_IN_PROGRESS: 'عملیات دیگری روی همین سرویس در جریان بود',
    SERVICE_NOT_ELIGIBLE: 'سرویس برای این عملیات مجاز نبود',
    SERVICE_NOT_OWNED: 'سرویس متعلق به این مشتری نبود',
    UNLIMITED: 'سرویس نامحدود است و این عملیات روی آن معنا ندارد',
    LIMIT_EXCEEDED: 'مقدار درخواستی از سقف مجاز بیشتر است',
    CALL_STRANDED: 'پنل جواب نداد و ساخت سرویس نیمه‌کاره ماند',
    ATTEMPTS_SPENT: 'تلاش‌های ساخت سرویس تمام شد و پنل خطا داد',
    PROVISION_CYCLE_EXHAUSTED: 'تلاش‌های ساخت سرویس تمام شد',
    FOUND_WITHOUT_PROVENANCE: 'سرویس روی پنل پیدا شد اما مال این سفارش نبود',
    ALLOWANCE_UNVERIFIED: 'اعمال تغییر روی پنل تأیید نشد',
    TERMINATED_BEFORE_PROVISION: 'سرویس پیش از ساخته شدن حذف شد',
    RECONCILE_FIRST: 'سرویس نیازمند بررسی دستی بود',
    FEATURE_DISABLED: 'این قابلیت خاموش بود',
    DEFAULT: 'ساخت روی پنل ممکن نشد',
  },
  paymentLinkCauses: {
    NO_LINK: 'درگاه پیش‌فاکتور را ساخت اما لینک پرداخت برنگرداند',
    MALFORMED_LINK: 'لینک پرداختی که درگاه برگرداند نامعتبر یا ناامن بود',
    NO_CARD: 'درگاه پیش‌فاکتور را ساخت اما کارت مقصد را برنگرداند',
    BAD_REQUEST: 'درگاه درخواست را رد کرد (اطلاعات ارسالی نامعتبر)',
    UNAUTHORIZED: 'درگاه احراز هویت را رد کرد؛ کلید API درگاه را بررسی کنید',
    FORBIDDEN: 'درگاه دسترسی را رد کرد',
    CONFIGURATION: 'تنظیمات درگاه کامل نیست یا درگاه آن را نپذیرفت',
    RATE_LIMITED: 'محدودیت تعداد درخواست درگاه',
    PROVIDER_ERROR: 'خطای سمت درگاه',
    BAD_RESPONSE: 'پاسخ درگاه قابل خواندن نبود',
    TIMEOUT: 'پاسخی از درگاه در مهلت مقرر نرسید',
    UNREACHABLE: 'اتصال به درگاه برقرار نشد',
    UNKNOWN: 'نتیجهٔ درخواست نامشخص است',
  },
  retry: {
    yes: 'ممکن است تلاش بعدی بدون تغییر موفق شود',
    no: 'بی‌فایده تا رفع مشکل (تنظیمات درگاه یا کلید را بررسی کنید)',
    unknown: 'خودکار تکرار نمی‌شود؛ ممکن است پیش‌فاکتور نزد درگاه ساخته شده باشد',
  },
  impact: {
    paymentLinkNoCharge: 'پولی کم نشد؛ لینک پرداخت دریافت نکرد و می‌تواند دوباره تلاش کند',
    paymentLinkUnknown: 'پولی کم نشد؛ نتیجهٔ ساخت فاکتور نامشخص است و بررسی می‌شود',
    refundedToWallet: 'مبلغ به کیف پولش برگشت',
    trialGivenBack: 'اکانت تست به حساب او نخورد',
    pending: 'پول برنمی‌گردد تا نتیجه روشن شود؛ پنل بررسی می‌شود',
    retrying: 'سیستم دوباره تلاش می‌کند؛ پولی برنگشته',
    notRefunded: 'هنوز بازگشت وجهی ثبت نشده است',
    // R9 C2: a gift costs the customer nothing; they only did not receive it.
    giftNotApplied: 'حجم هدیه به سرویس اضافه نشد؛ پولی در کار نبود',
  },

  serviceStates: {
    PENDING_PROVISION: 'در انتظار ساخت',
    ACTIVE: 'فعال',
    SUSPENDED: 'معلق',
    EXPIRED: 'منقضی',
    TERMINATED: 'حذف‌شده',
    UNRECONCILED: 'نیازمند بررسی',
    NO_DATA: 'نامشخص',
  },
  reminderHeadings: {
    EXPIRY_EARLY: '🔔 نزدیک انقضا',
    EXPIRY_FIRST: '🔔 نزدیک انقضا',
    EXPIRY_SECOND: '🔔 نزدیک انقضا',
    EXPIRY_DAY: '⏰ امروز زمان سرویس تمام می‌شود',
    EXPIRED: '⛔ پایان زمان سرویس',
    USAGE_FIRST: '📉 کم شدن حجم',
    USAGE_SECOND: '📉 کم شدن حجم',
    USAGE_FINAL: '⛔ پایان حجم',
  },
  /** Round 5A item 1: why a customer message did not go out, as the operator reads it. */
  customerSend: {
    causes: {
      REFUSED:
        'تلگرام ارسال پیام را نپذیرفت (معمولاً مشتری ربات را شروع نکرده یا آن را مسدود کرده است)',
      UNCERTAIN: 'معلوم نیست پیام به مشتری رسیده یا نه؛ دوباره ارسال نمی‌شود',
      NO_BOT: 'ربات فرستنده توکن قابل استفاده ندارد',
      TOKEN_REJECTED: 'تلگرام توکن ربات را نپذیرفت؛ توکن را در صفحهٔ ربات عوض کنید',
    },
    kindLabel: 'نوع پیام',
    customersLabel: 'تعداد مشتریان در انتظار یا ناموفق',
    unknownKind: 'پیام غیر از اعلان‌های مشتری',
  },
  time: { unlimited: 'نامحدود', expired: 'تمام شده', daysLeft: 'روز', hoursLeft: 'ساعت' },

  panel: {
    salesStopped: 'فروش روی این پنل تا برگشت پنل متوقف است',
    salesContinue: 'فروش روی این پنل ادامه دارد (پنل ناپایدار است)',
    downFor: { minutes: 'دقیقه', hours: 'ساعت', and: 'و' },
  },
  block: {
    blocked: '⛔ کاربر مسدود شد',
    unblocked: '✅ رفع مسدودی کاربر',
    manual: 'دستی (توسط ادمین)',
    spam: 'خودکار (ضد اسپم)',
    until: 'تا رفع مسدودی توسط ادمین',
  },
  admin: {
    created: '👮 ادمین جدید',
    rolesChanged: '🎭 تغییر نقش ادمین',
    disabled: '🚫 ادمین غیرفعال شد',
    enabled: '✅ ادمین دوباره فعال شد',
    noRole: 'بدون نقش',
    system: 'سیستم',
  },
  reseller: {
    PROMOTED: '🧑‍💼 ارتقا به نماینده',
    TIER_CHANGED: '🧑‍💼 تغییر سطح نماینده',
    SUSPENDED: '⬇️ خروج از نمایندگی',
    REACTIVATED: '⬆️ بازگشت به نمایندگی',
    ordinary: 'کاربر عادی',
  },
  storm: { heading: 'خطاهای تکراری' },
  report: {
    cleanup: (n: string) => `🧹 پاکسازی: ${n} پرداخت ناتمام منقضی شد`,
    compaction: {
      applied: (parts: string) => `🗜 فشرده‌سازی داده — حذف شد: ${parts}`,
      dryRun: (parts: string) => `🗜 فشرده‌سازی داده — فقط شمارش، چیزی حذف نشد: ${parts}`,
      classes: {
        OPS_NOTIFICATIONS: 'اعلان‌های عملیات',
        CUSTOMER_NOTIFICATIONS: 'اعلان‌های کاربران',
        RECEIPT_WINDOWS: 'پنجره‌های رسید',
      },
    },
    noActivity: 'امروز فعالیتی ثبت نشده است.',
    topResellers: '🏆 برترین نمایندگان امروز',
    resellerLine: 'نماینده‌ها',
    gb: 'گیگ',
    orders: 'سفارش',
    health: {
      HEALTHY: 'سالم',
      DEGRADED: 'ناپایدار',
      UNHEALTHY: 'ناسالم',
      UNCHECKED: 'بررسی‌نشده',
      DISABLED: 'غیرفعال',
    },
    methods: {
      MANUAL_TRANSFER: 'کارت',
      TONPAYS: 'تون‌پی',
      TONPAYS_TELEGRAM: 'تون‌پی تلگرام',
      TELEGRAM_STARS: 'استارز',
      NOWPAYMENTS: 'ارز',
      CENTRALPAY: 'سنترال‌پی',
      TETRAPAY: 'تتراپی',
      GATEWAY: 'درگاه',
      WALLET: 'کیف پول',
    },
  },
} as const;

/** The label of each inline URL button. */
export const OPS_LOG_BUTTON_LABELS_FA: Readonly<Record<OpsLogButtonKind, string>> = {
  USER: '👤 پروفایل کاربر',
  PAYMENT: '🧾 پرداخت',
  ORDER: '📦 سفارش',
  SERVICE: '🔑 سرویس',
  PANEL: '🖥 وضعیت پنل',
  GATEWAY: '⚙️ تنظیمات درگاه',
  TICKET: '💬 پاسخ در پنل',
  MANUAL_CREDIT: '✅ شارژ دستی کیف پول',
  WALLET: '🧾 تراکنش',
  BULK_OPERATION: '📋 عملیات گروهی',
  DASHBOARD: '📈 داشبورد',
  NOTIFICATIONS: '📋 فهرست کامل در پنل',
};
