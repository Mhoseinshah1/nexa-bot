# Web Admin ↔ Telegram User Management crossmap

STATUS: baseline expectations recorded **before** touching Telegram, so that any difference found is a
genuine contradiction rather than a memory artefact. Nothing here is yet confirmed on the Telegram side.

## What the Web Admin user detail page is known to expose (prior phase, VERIFIED_BY_UI there)

**Profile/stats**: username, numeric id, status badge, تعداد خرید کاربر, جمع خرید کاربر,
تعداد پرداخت‌های کاربر, جمع پرداخت‌های کاربر.

**Tab اطلاعات عمومی**: زمان عضویت · آخرین زمان استفاده · محدودیت اکانت تست · شماره موبایل ·
وضعیت تایید قوانین · امتیازات کاربر · ارسال اطلاع‌رسانی · محدودیت تغییر لوکیشن.

**Tab مالی**: جمع خدمات · موجودی (+ صفر کردن موجودی when balance > 0).

**Tab همکاری در فروش**: تعداد زیرمجموعه‌ها · معرف کاربر · زیرمجموعه‌های کاربر.

**Tab نمایندگی**: گروه کاربری (f/n/n2) · درصد تخفیف نماینده · تاریخ پایان نمایندگی ·
سقف منفی شدن حساب (n2 only).

**Separate table** `/users/discount_users/`: a per-user discount %, distinct from the reseller discount.

**Web action buttons**: ارسال پیام · مسدود کردن کاربر · افزایش موجودی · کسر موجودی ·
عدم احراز هویت کاربر · افزودن دستی سفارش · روشن/خاموش کردن کانفیگ‌های کاربر · انتقال حساب کاربری ·
محدودیت اکانت تست · محدودیت تغییر لوکیشن · تایید دستی شماره موبایل · غیرفعال‌سازی اطلاع‌رسانی ·
معاف از احراز هویت کانال · مشاهده سفارشات کاربر · صفر کردن موجودی · تنظیم نماینده ·
تنظیم زمان انقضا نمایندگی · تنظیم درصد تخفیف · فعالسازی ربات فروش · تنظیم سقف منفی شدن ·
زیرمجموعه‌های کاربر.

## Questions this phase must answer

1. Does the Telegram menu mirror these tabs, expose a subset, or expose things the web panel does not?
2. Do the same actions exist under the same names?
3. Does Telegram expose the per-user discount that lives in a separate web table?
4. Is `سقف منفی شدن حساب` gated to n2 on the Telegram side too?
