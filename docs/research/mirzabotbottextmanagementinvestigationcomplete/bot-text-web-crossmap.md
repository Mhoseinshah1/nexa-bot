# Contradictions, stale templates and legacy signals

## C-TXT-001 — Telegram exposes 36 texts; the Web panel exposes **over 1000**

The Web-Admin phase documented `/settings/text/` with **40 accordion groups** and their counts:
`users(608)` `miniapp(272)` `stateus(40)` `Balance(38)` `affiliates(34)` `service(24)` `extend(17)`
`cron(11)` `month(10)` `Extra_volume(9)` `transfor(9)` `change-location(9)` `gateway(9)`
`Discount(8)` `agenttext(8)` `rate(7)` `extrauser(7)` `sell(6)` `changepassword(6)` `errors(6)`
`number(5)` `changelink(5)` `wheel_luck(5)` `usertest(4)` `page(4)` `note(4)` `button(4)` `buy(4)`
`agentpanel(4)` `ticket(4)` `channel(3)` `support(3)` `customsellvolume(3)` `app(3)` `spam(2)`
`help(2)` `search(2)` `pricearze(2)` `block(1)` `wallet(1)`.

Telegram exposes **36 flat items, no groups, no keys, no search.**

**Verdict: the Telegram section is a small curated subset of the same catalogue — INFERRED, not
proven.** Supporting: the Web log verb `ویرایش متن‌های ربات` exists and both surfaces edit customer
copy. Missing: any shared key. Telegram never shows an internal key such as `users.Rules`, so the
mapping between a Telegram label and a Web key cannot be established from Telegram alone
(UNK-TXT-005). **Do not assume one backend table without that evidence.**

## C-TXT-002 — HTML: documented on the Web, absent in Telegram

The Web page's own help says HTML tags such as `<b>`, newlines and placeholders like `{username}`
must be preserved. Telegram's edit prompts mention **no formatting at all**, and none of the 20
templates read contains a tag. Placeholders agree across both surfaces; HTML does not.
**Recorded as a contradiction, not resolved.**

## C-TXT-003 — Custom premium emoji

The Web phase found `<tg-emoji emoji-id="…">` used widely in bot texts. None appeared in the 20
Telegram templates. Either the subset happens to exclude them, or Telegram's echo strips them —
UNKNOWN.

## C-TXT-004 — **Currency unit differs between the two card-to-card templates**
- `متن کارت به کارت`: `مبلغ {price}  تومان`
- `تنظیم متن کارت به کارت خودکار`: `مبلغ {price}  ریال`

Same `{price}` variable, two units differing by a factor of 10. One of the two is telling customers
the wrong amount. `تومان` is used by every other money template in the product, so the **ریال** in
the auto template is the likely error. **Not corrected — read-only phase.** Flagged for the owner.

## C-TXT-005 — STALE_TEMPLATE: the tariff list says its own prices are out of date

`متن توضیحات لیست تعرفه` ends:
`به دلیل بروزرسانی قیمت ها لطفا قیمت سرویس ها را از بخش خرید اشتراک مشاهده نمایید`
— "because prices were updated, please see the prices in the purchase section". The tariff-list
description tells customers not to trust the tariff list. Live customer-facing copy.

## C-TXT-006 — RESOLVED, and it revealed something more important

The earlier reading — "the greeting seems to be missing its name" — was **wrong**, and the owner
corrected it: the `?` in `👋 سلام ? عزیز` is the **display name of the account performing this audit**.
`{first_name}` resolved correctly.

The real finding is what that implies: **`متن فعلی` echoes the RENDERED text, not the stored
template.** Variables that resolve in the editing admin's context are printed substituted; the rest
stay literal. So the raw template is not recoverable from this screen, and re-sending the displayed
text would replace `{first_name}` with a literal name for every customer.
→ TBR-TXT-013, SOURCE_UX-RISK-TEXT-012, UNK-TXT-012.

## C-TXT-007 — WGDashboard delivery has no connection link

`متن بعد گرفتن اکانت WGDashboard` carries username, name, location, duration and volume but **no
`{config}` line**, unlike every other delivery template. A WireGuard customer would receive a
success message with no way to connect. Possibly correct (WG configs may be delivered as a file by
another path) — UNK-TXT-006.

## C-TXT-008 — Source typo repeated 36 times

Every edit prompt reads `متن جدید خود راارسال کنید.` — `راارسال` instead of `را ارسال`. Cosmetic,
but it is strong evidence all 36 items share a single handler.

## Legacy signals worth noting

`متن بعد خرید ibsng` and the two WGDashboard templates prove the product supports **IBSng** and
**WGDashboard** panel types in addition to the Marzban-family panels seen in this deployment. Neither
is in use here; the templates are the only trace of those capabilities in the Telegram surface.

Their shapes differ meaningfully, which is itself evidence about the integrations:
- **IBSng** carries **`{password}`** and no `{config}` — username/password auth, no subscription link.
- **WGDashboard** carries neither `{password}` nor `{config}` — five descriptive fields and no
  delivery mechanism visible in the message at all (C-TXT-007).
- **Manual** accounts reuse `{config}` but relabel it `اطلاعات سرویس` rather than `لینک اتصال`.

## C-TXT-009 — Literal braces that are not placeholders

`دکمه اکانت تست` reads `اشتراک رایگان {تست}`. No placeholder help is offered for that item and no
`{تست}` token exists — the braces are decoration. A substitution engine that treats every `{…}` as a
variable would erase this caption. Recorded because it is a trap the rebuild will hit.
