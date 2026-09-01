# Store — Telegram Crossmap (admin setting → customer-visible effect)

Rows marked **VERIFIED_BY_UI (customer side)** were observed this session in the live customer flow,
read-only, stopping before payment.

## Customer-side evidence gathered

Entry: `🔐 خرید اشتراک` → category list → product list.

**Category list shown to this account** (3 of the 7 categories that exist admin-side):

```
🚀 یکماهه مولتی لوکیشن ویژه 🚀
🚀 دو ماهه مولتی لوکیشن ویژه 🚀
🚀 سه ماهه مولتی لوکیشن ویژه 🚀
▶️ بازگشت به منوی قبل
```

**`TEST_STORE_CATEGORY` does NOT appear customer-side.** Categories with no purchasable product are
not rendered. (It cannot be separated here whether the cause is the test product's Inactive sale status,
its `نمایش برای خرید اول` flag, its `نماینده پیشرفته` tier, or its corrupted location — all four apply
at once. So: *a category with nothing purchasable in it is hidden* — VERIFIED; *which single field
caused it* — UNKNOWN.)

**Product list inside `🚀 یکماهه مولتی لوکیشن ویژه`:**

```
30 گیگ 30 روزه - 145,000تومان      40 گیگ … 188,000      50 گیگ … 230,000
60 گیگ … 270,000                   70 گیگ … 308,000      80 گیگ … 344,000
90 گیگ … 378,000                   100 گیگ … 410,000     150 گیگ … 599,000
⚙️ سرویس دلخواه
🔙 بازگشت
```

Four findings from that one screen:

1. **The customer never sees `نام محصول`.** The button label is auto-composed from volume, duration and
   price (`{GB} گیگ {days} روزه - {price}تومان`). The product's stored name is admin-facing only.
2. **`⚙️ سرویس دلخواه` lives at the bottom of a category's product list** — that is the customer entry
   point into the custom-service pricing subsystem.
3. **Prices are displayed**, consistent with the store capability `نمایش قیمت محصول` being ON.
4. All nine buttons rendered in the same default style, so no colour variation was observable here.

## Admin setting → customer effect

| Admin setting | Expected customer-side effect | Verified? |
|---|---|---|
| Category with nothing purchasable | not rendered in the customer category list | **VERIFIED_BY_UI (customer side)** |
| `نمایش قیمت محصول` (capability #8, ON) | prices printed on product buttons | **VERIFIED_BY_UI (customer side)** |
| `نام محصول` | **not shown to customers at all** in the purchase list | **VERIFIED_BY_UI (customer side)** |
| `🚦 وضعیت فروش محصول` = غیرفعال | product hidden from new purchases; renewals unaffected | prompt VERIFIED; isolated runtime effect NOT_TESTED |
| `نمایش برای خرید اول` = روشن | visible only to customers with no prior purchase | mechanism VERIFIED; runtime NOT_TESTED |
| `🔁 نوع استفاده محصول` | appears in buy flow, renew flow, or both | prompt VERIFIED; runtime NOT_TESTED |
| `🎨 رنگ محصول` | Telegram button background colour (red/green/blue/default) | user-clarified; no colour variation observed in the one list seen |
| `✨ ایموجی پریمیوم محصول` | decorates the product where its name is printed in a message | NOT_TESTED — and note a `custom_emoji_id` cannot render on a Bot-API keyboard button, only in message text, which fits the fact that the purchase list shows no product name at all |
| `دسته بندی` (capability #5) | when OFF, the category layer disappears from purchase navigation | NOT_TESTED |
| `دسته بندی زمان` (capability #6, OFF) | unknown second/legacy category mode | **UNKNOWN — see `store-unknowns.md`** |
| Custom-service min/max | enforced and printed to the customer verbatim | **VERIFIED_BY_UI (customer side)** — 30–500 GB, 10–90 days |
| Discount code | `🎟 اعمال کد تخفیف` appears on the pre-invoice, after the price is computed | **VERIFIED_BY_UI (customer side)** |
| `🎁 کش بک تمدید` | wallet credit after renewal | prompt VERIFIED; runtime NOT_TESTED |
| `👤محدودیت کاربر` | passed to the panel as the subscription's user cap | NOT_TESTED |
| `🎛 تنظیم اینباند` | provisioned config inherits the named config user's inbounds | INFERRED, NOT_TESTED |

## The pre-invoice (checkout) surface

Requesting a custom-service quote produced a **pre-invoice, not a paid order**. Its structure:

```
🧾 پیش فاکتور شما:
👤 نام کاربری: <8 hex chars>_<telegram user id>
📦 نام سرویس: سرویس دلخواه
📅 مدت اعتبار: 30 روز
💰 قیمت: 255,000 تومان
👥 حجم اکانت: 50 گیگ
📝 یادداشت محصول :
💰 موجودی کیف پول شما : <balance>

💳 سفارش شما آماده پرداخت است
```

Buttons: `💳 پرداخت با درگاه` · `✅ استفاده از موجودی` · `📝 ثبت یادداشت` · `🎟 اعمال کد تخفیف` ·
`🏠 بازگشت به منوی اصلی`. **None of the payment buttons was clicked.**

This also reveals the **username-generation pattern**: `<8 hexadecimal characters>_<Telegram user id>`.

Two structural facts follow: the discount code is applied **at the pre-invoice stage, after a price has
been computed**; and wallet balance and gateway are two parallel payment paths on the same invoice.
