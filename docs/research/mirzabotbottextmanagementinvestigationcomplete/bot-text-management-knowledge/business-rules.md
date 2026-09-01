# Business rules — Bot Text Management (TBR-TXT-###)

## TBR-TXT-001 — Telegram exposes exactly 36 editable texts in one flat list
- **Rule:** no groups, no pagination, no search, no filter, no keys, no counters.
- **Evidence:** the 38-button reply keyboard (36 items + 2 nav), read byte-exact.
- **Effect:** the Telegram surface is a curated shortcut list, not the full CMS.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-002 — One edit component serves every item
- **Rule:** pressing any item immediately sends `متن جدید خود راارسال کنید.` + `متن فعلی :<value>`,
  optionally followed by a placeholder-help message, and puts the bot in "awaiting text".
- **Evidence:** 20 probes, identical structure and identical source typo (`راارسال`).
- **Effect:** one handler, one storage shape. A rebuild needs one editor, not 36.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-003 — The next ordinary message IS the save; there is no confirmation and no undo
- **Rule:** no Save button, no preview, no diff, no confirm, no reset-to-default anywhere in the
  Telegram section.
- **Evidence:** the flow as observed; the reply keyboard during edit contains only the two nav buttons.
- **Security effect:** a stray message typed while a text is open silently replaces production copy
  seen by ~13,700 customers. → SOURCE_UX-RISK-TEXT-001.
- **Confidence:** VERIFIED_BY_UI (structure). Save-on-send is INFERRED — deliberately never tested.

## TBR-TXT-004 — The current value is always echoed — but RENDERED, not raw
- **Rule:** every edit prompt prints the complete current text. However it prints the template
  **after substituting any variable that resolves in the viewing admin's context**; only the
  variables with no value in that context survive as literal `{braces}`.
- **Evidence:** all 36 probes show a full body. `تنظیم متن شروع` echoed `👋 سلام ? عزیز` — the owner
  confirmed `?` is the auditing account's own display name, i.e. `{first_name}` was resolved live.
  Service-scoped tokens (`{username}`, `{config}`, `{price}`) echoed raw in every other template.
- **Effect (good):** far more readable than the rest of MirzaBot, where 7 of 12 capability settings
  hide their value entirely (BC-SB-003).
- **Effect (dangerous):** the raw template is **not** recoverable from this screen when it contains an
  admin-resolvable variable, and copy-editing what is on screen would bake the admin's own name into
  production copy. See TBR-TXT-013.
- **Confidence:** VERIFIED_BY_UI + VERIFIED_BY_OWNER (the `?`).

## TBR-TXT-005 — Placeholders are `{token}`, template-scoped, plain substitution
- **Rule:** tokens are single-brace; the bot states `⚠️ حتما این نام ها باید داخل آکلاد باشند`;
  the same token can mean different things in different templates (`{time}`).
- **Evidence:** three help formats across 20 probes; `{time}` = current time in the start text and
  service duration in the renewal invoice.
- **Effect:** a rebuild's template engine must resolve variables **per template**, not from one
  global context, and must not validate against a single global vocabulary.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-006 — Units are hard-coded in the copy, not carried by variables
- **Rule:** `{Service_time} روز`, `{price} تومان`, `{Volume} گیگ` — the variables are bare numbers
  and the unit is literal text in the template.
- **Evidence:** pre-invoice, renewal invoice, delivery, card-to-card.
- **Effect:** changing a unit means editing every template; and it is how C-TXT-004 (تومان vs ریال)
  became possible.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-007 — Delivery copy is per panel type
- **Rule:** separate templates exist for the default panel, **IBSng**, **WGDashboard**, and a
  WGDashboard test variant, plus a manual-account variant.
- **Evidence:** BTX-017/018/022/023/024.
- **Effect:** the rebuild's delivery message must be keyed by panel type. It also reveals two panel
  integrations not otherwise visible in this deployment.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-008 — Roughly a third of "texts" are customer keyboard captions
- **Rule:** BTX-002…012, 019, 026, 027, 028 edit reply-keyboard button labels, not messages.
- **Evidence:** `دکمه سرویس خریداری شده` → `🛍 سرویس های من`; `متن دکمه ☎️ پشتیبانی` → `☎️ پشتیبانی`;
  `متن درخواست نمایندگی` → `👨‍💻 درخواست نمایندگی`.
- **Effect:** the customer menu is renameable configuration. Any integration keyed to a caption can
  be broken from this screen, and captions and message bodies share one namespace with no type marker.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-009 — Formatting is attached to the placeholder, not to markup
- **Rule:** `{config}` renders as copy-on-tap; `{links}` / `{links2}` render the same data **without**
  the copy affordance (`کانفیگ بدون کپی شدن`).
- **Evidence:** the delivery templates' help text.
- **Effect:** a rebuild cannot model the body as an opaque string plus a formatting mode — some
  rendering is a property of the variable.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-010 — Trigger, timing and body live in three different menus
- **Rule:** a capability flag (Bot Capabilities) enables a message, a cron/threshold setting
  (its `⚙️ تنظیمات`, or General Settings) supplies the timing/threshold, and this section supplies
  the body.
- **Evidence:** the low-balance triple (flag OFF + threshold + body) and the terms triple
  (flag ON + per-user field + body). See `cross-surface-map.md`.
- **Effect:** no single screen tells an operator whether a message will be sent, when, and what it
  says. Keep them together in a rebuild.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-011 — A template's existence does not mean its feature is enabled
- **Rule:** well-maintained templates exist for the bot-off notice (bot is on), the low-balance
  warning (alert flag off) and both card-to-card variants (gateway disabled).
- **Effect:** never infer the active feature set from the template catalogue.
- **Confidence:** VERIFIED_BY_UI.

## TBR-TXT-012 — Seven of the eight crons have no editable body here
- **Rule:** only `متن کرون تست` is present. Expiry warning, first-connection/on-hold, volume warning,
  both deletion crons and inactivity outreach have no Telegram-editable text.
- **Evidence:** the 36-item list vs the 8 crons documented in the Bot Capabilities phase.
- **Effect:** messages that reach customers today cannot be changed from Telegram; the Web panel's
  `cron(11)` group is the likely home. → UNK-TXT-004.
- **Confidence:** VERIFIED_BY_UI (the absence).


## TBR-TXT-013 — Editing from the echoed text destroys admin-resolvable placeholders
- **Rule:** because the echo resolves `{first_name}` (and presumably the other Telegram-identity
  tokens) against the editing admin, an admin who copies the displayed text, tweaks it and sends it
  back replaces the placeholder with their own literal value.
- **Trigger:** any template containing `{first_name}`, `{last_name}`, `{username}`, `{time}` or
  `{version}` — at minimum `تنظیم متن شروع`.
- **Audience:** every customer.
- **Evidence:** the `?` in the start-text echo, confirmed by the owner as the auditing account's name.
- **Effect:** the greeting would silently stop being personalised and would address all ~13,700
  customers by the admin's name. Nothing in the UI warns about this.
- **Security effect:** low, but it is a silent-corruption path with no undo (there is no
  restore-default in Telegram).
- **Confidence:** VERIFIED_BY_UI (the rendering); INFERRED (the consequence — deliberately not tested).

## TBR-TXT-014 — Only a minority of the bot's customer messages are editable from Telegram
- **Rule:** 36 templates are exposed here. The messages MirzaBot demonstrably sends but which have
  **no** editable template in this section include 7 of the 8 cron bodies, every error and validation
  string, discount, extra-volume, extra-time, paid location-change, ticket/support, identity- and
  phone-verification, block, and all admin/report-group copy.
- **Evidence:** the 36-item list compared against the capability/cron inventory from Bot Capabilities
  and against the Web panel's 40 groups (`errors(6)`, `cron(11)`, `Discount(8)`, `Extra_volume(9)`,
  `Extra_time(4)`, `change-location(9)`, `ticket(4)`, `block(1)`, `users(608)` …).
- **Effect:** a rebuild must implement those message families itself; they cannot be harvested from
  this screen. Full inventory in `non-editable-texts.md`.
- **Confidence:** VERIFIED_BY_UI (the absence from Telegram); the Web-side homes are INFERRED.
