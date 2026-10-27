## R11 A4 — «فقط فایل، بدون لینک ساب» + «نوع بارکد» (RickPanel)

Two per-panel options, both off by default (columns default to today's behaviour).

### What changed

**1. Files only (`panels.files_only_delivery`, default false).** For services on a panel with it on, the subscription link, its QR and any copy of it are never shown to the customer.

- _Where the rule lives:_ `DeliveryService` (one place, so the automatic sweep, a customer's tap and an operator's resend all follow it) and the mini app controller.
  - Delivery card: `bot.service.delivered_files_only` (service details + "files follow"), no link, no QR render, no photo; the connection files follow from the sweep exactly as before.
  - Link change: the panel still rotates the link through the ordinary path (no new money path, no new provisioning operation). The answer is `bot.service.files_renewed` on the card (no link, no QR) and the new files follow.
  - The link _view_ («🔗 لینک اشتراک») is refused in `deliver` before anything is stamped or sent (`SERVICE_NOT_DELIVERABLE`, reason `FILES_ONLY`).
- _«سرویس‌های من»:_ no «🔗 لینک اشتراک» button; «⚙️ تغییر لینک» becomes «⚙️ دریافت فایل‌های جدید» in the same slot (`service.files_new` shares the `service.rotate` layout slot, as suspend/resume share one), with its own ask / confirm / cooldown texts (`files_new_ask`, `files_new_confirm_button`, `files_new_cooldown`). The card's hint that names «تغییر لینک» is not drawn. A stale link button from an older message is answered with the files.
- _Mini app:_ the detail payload has `subscriptionUrl: null` and `qrKinds: []` (the string is not in the bytes sent); the QR routes answer 404.
- _Captions:_ connection-file captions are built from a service without its link, so a template naming `{sub_link}` / `{subscription_url}` cannot carry it.
- _Allowed only where files exist:_ `PanelService.update` accepts it only if the provider descriptor declares `SUBSCRIPTION_FILES` and the adapter implements+declares it (capability registry row); otherwise `PANEL_FILES_ONLY_UNSUPPORTED` (Persian in the Web Admin), nothing stored or audited. OFF is always allowed. Audited as `panel.update` with before/after (only when the value changed); in the idempotency hash only when present.
- Unreadable panel row reads as files-only (restriction fails closed).

**2. QR kind (`panels.qr_kind` SUB_LINK|SINGBOX|BOTH, `panels.singbox_interval_minutes` default 360, 1..10080; RickPanel only).**

- `SUB_LINK` = today. `SINGBOX` = QR of `sing-box://import-remote-profile?url=<encodeURIComponent(link)>&autoUpdate=true&autoUpdateInterval=<minutes>`. `BOTH` = both, each with a one-line caption (`bot.service.qr_caption_sublink` / `_singbox`).
- `qrPayloads()` (contracts) is the one function that says which QRs exist and what each encodes; it returns nothing while files-only is on, so **files-only wins over every kind**.
- Bot card: BOTH = two captioned photos, then the whole card as text. Link view: link as text on the card, two captioned QRs beneath. Link change: text answer then the two QRs. SINGBOX = the single photo, encoding the sing-box string. A text-only panel delivery mode (existing policy) still means no QR at all.
- Mini app: `qrKinds` in the detail, `GET /services/:id/qr/:kind`; the QR sheet shows each kind (captioned when more than one).
- Refused for any non-RickPanel (`PANEL_QR_KIND_UNSUPPORTED`) when the kind or interval would _change_; sending back the value it already holds is not a refusal. Audited before/after.

**3. Web Admin** (`PanelDeliveryOptionsCard`, on the panel's «فایل‌های اتصال» tab): the files-only switch only where the provider hands over files; the QR kind and interval only for RickPanel; nothing is drawn otherwise. Saves only changed fields under an idempotency key.

### Migrations

- `0294_panels_files_only_delivery.sql` — `files_only_delivery boolean NOT NULL DEFAULT false`.
- `0295_panels_qr_kind.sql` — `qr_kind text NOT NULL DEFAULT 'SUB_LINK'` (+`panels_qr_kind_check`), `singbox_interval_minutes integer NOT NULL DEFAULT 360` (+`panels_singbox_interval_check` 1..10080).
- Written as 0293/0294; main then took 0293 (`process_runs`). Renumbered after `git merge origin/main`: both regenerated with drizzle-kit on main's snapshot chain, in order, each with its own snapshot; **SQL byte-identical** to the reviewed 0293/0294 (diffed). `renumber-migration.sh` was not used because main's 0293 snapshot replaced ours in the merge, so it classified the first as hand-written and would have folded both columns into one diff. `db:check` clean, `migration-journal` unit test green, `when` stamps from the clock. No customer message from a migration.

### Commits (contract changes are their own)

`Contracts: files-only delivery` → `Panels: files-only option (column, rule, audit)` → `Contracts: RickPanel QR kind` → `Delivery: files only and the QR kind (bot, «سرویس‌های من», mini app)` → `Web Admin: …` → docs/open questions → merge origin/main → renumber → i18n comment fix → two test-fixture commits. The API does not typecheck between each contract commit and the commit after it (the panel summary requires the new fields first); the head is green.

### Tests

| File                                         | Cases                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests/integration/panel-files-only.test.ts   | 13 — default off; on for RickPanel and back; refused for a non-file panel (nothing stored/audited); off always allowed; audit before/after only on change; replay; permission; QR default 360; kind+interval set & audited; non-RickPanel refused (SINGBOX, BOTH, interval); same values accepted; bounds/fraction/unknown kind → request_invalid; DB CHECKs                                             |
| tests/integration/files-only-bot.test.ts     | 11 — card has no link/QR, files follow (+control); service card: no link button, «دریافت فایل‌های جدید» in the rotate slot (+control); stale link button → files; ask/confirm/rotate/announce with no link, new files follow; cooldown worded as files; caption naming `{sub_link}` loses the link (+control); BOTH = two captioned photos then the card; default = one photo; files-only overrides BOTH |
| tests/integration/miniapp-files-only.test.ts | 4 — control (link + QR); files-only: link not in the bytes, `qr:false`, QR 404; kinds on offer per panel (SUB_LINK / SINGBOX(90) / BOTH, unknown 404); files-only wins over every kind                                                                                                                                                                                                                   |
| tests/unit/files-only-delivery.test.ts       | 17 — DeliveryService files-only card / fallback / rotate / link-view refusal (+controls); sing-box string exact incl. `?`/`&`/`#`/space and round-trip; interval default/custom; `qrPayloads` by kind and files-only; SINGBOX/BOTH on card, link view, link change; files-only beats every kind                                                                                                          |
| tests/web/panel-delivery-options.test.tsx    | 9 — RickPanel shows both; marzban/sanaei/custom show nothing; interval only for sing-box kinds; sends only changed fields; kind+interval; bad intervals disable save; read-only                                                                                                                                                                                                                          |
| tests/web/miniapp-screens-2b.test.tsx        | +2 — BOTH draws two captioned QRs; a single QR has no kind caption (fixtures updated for `qrKinds`)                                                                                                                                                                                                                                                                                                      |
| tests/unit/bot-runtime.test.ts               | sendable-copy list gains the four `files_new_*` keys                                                                                                                                                                                                                                                                                                                                                     |

Mutation checks (rule broken → named test red → restored → green):

| Rule                                                                                                                                                                                  | Red                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| files-only refusal for non-file panel removed                                                                                                                                         | panel-files-only › refuses it for a panel…                    |
| audit only-on-change removed / audit field dropped                                                                                                                                    | panel-files-only › audits the change…                         |
| card files-only branch removed                                                                                                                                                        | unit › sends the card with no link… (+fallback)               |
| link-view refusal removed                                                                                                                                                             | unit › refuses the link VIEW…                                 |
| link-change mode / key not files-only                                                                                                                                                 | unit › answers a link change with the files text              |
| card keeps «لینک اشتراک»                                                                                                                                                              | bot › draws the service card…                                 |
| button not renamed                                                                                                                                                                    | bot › draws the service card…                                 |
| stale link button not redirected                                                                                                                                                      | bot › answers a stale «لینک اشتراک»…                          |
| rotate ask worded as link                                                                                                                                                             | bot › asks for new FILES…                                     |
| captions keep the link                                                                                                                                                                | bot › builds a file caption…                                  |
| mini app sends the link                                                                                                                                                               | miniapp › sends no link at all…                               |
| mini app QR route ignores kinds on offer                                                                                                                                              | miniapp › offers the QRs the panel is set to…                 |
| no `encodeURIComponent`                                                                                                                                                               | unit › encodes the whole link…                                |
| interval ignored                                                                                                                                                                      | unit › writes the interval as given                           |
| BOTH draws one QR                                                                                                                                                                     | unit › BOTH: two photos… / link view / link change            |
| files-only no longer wins in `qrPayloads`                                                                                                                                             | unit › files-only wins over every kind; picks the QRs by kind |
| second caption wrong                                                                                                                                                                  | unit › BOTH (×3)                                              |
| non-RickPanel accepted                                                                                                                                                                | panel-files-only › refuses a QR kind…                         |
| web: controls for every provider (both switched together)                                                                                                                             | web › marzban/sanaei/custom draw neither                      |
| mini app sheet: no kind captions                                                                                                                                                      | miniapp-screens-2b › draws both QRs…                          |
| (The integration and batch mutations were applied together in one run where each has a test only it breaks; every row's test went red and the tree was restored, `git status` clean.) |

### Local gate

typecheck, lint, format:check, check:i18n, db:check — green. Unit (delivery, files-only, bot-runtime, i18n, inline buttons, service-card layout, templates, migration journal) green; web 252/252; integration 125/125 (panel-files-only, miniapp-files-only, files-only-bot, subscription-files, customer-rotate-link, r3-service-card, panel-balancing, panel-advanced-settings).

### Decisions

- Column on `panels` (as briefed), not in the `panel_policies` JSON: a policy that fails to parse reads as default, which would _show_ the link; a column cannot fail open.
- The mini app has no files/rotate screens today, so a files-only customer there sees no link and no QR and nothing else new (no mini-app copy added). Files stay available in the bot.
- BOTH on the link view / link change puts the QRs _beneath_ the text (the existing over-bound fallback shape) instead of re-splitting the card caption.
- Open questions OQ-R11-A4-01..04 in docs/open-questions.md. OQ-R11-A4-01 (not implemented): a panel policy that switches off customer «SUBSCRIPTION_FILES» while files-only is on leaves a customer with neither link nor files. Not guarded here; worth refusing that combination in the policy save.
- The panel's own per-file captions (sent by RickPanel) are passed through untouched; if a panel writes the link into its own caption the bot cannot know.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
