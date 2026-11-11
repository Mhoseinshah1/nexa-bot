# Round report — demo parity (Web Admin matches the approved demo), plus §L and §N

Round prompt: «NEXA — Demo parity round» (owner, 2026-11-11). Base: v0.9.14 (`29af8ed0`).

**The owner's approved demo `nexa-web-admin-demo.html` was not delivered to the session** (only
the kit zip and the prompt arrived). The fix list was therefore the owner's own kit report
(`docs/web-redesign/demo-parity/round-baseline.md` §1: 477 differences on 44 routes after KEEP),
the kit's side-by-side pairs, and the older `approved-demo.html`. `pnpm web:demo-diff` falls back
to the older demo and says so; commit the owner's file as
`docs/web-redesign/demo-parity/reference/redesign-demo.html` and re-run it.

## PRs

| PR                                                             | What                                                                                 | Merge commit |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| [#456](https://github.com/Mhoseinshah1/nexa-bot/pull/456) PR-0 | `pnpm web:demo-diff` tool, KEEP allow-list, baseline                                 | `9e1e229e`   |
| [#459](https://github.com/Mhoseinshah1/nexa-bot/pull/459) PR-1 | shared kit (framed boxes, CSV, «بیشتر»), customers, orders, services                 | `8027e641`   |
| [#460](https://github.com/Mhoseinshah1/nexa-bot/pull/460) PR-2 | payments, gateways, tickets, business chats, support, notification centre            | `02afb05a`   |
| [#462](https://github.com/Mhoseinshah1/nexa-bot/pull/462) PR-3 | catalogue and marketing pages                                                        | `a6c53916`   |
| [#464](https://github.com/Mhoseinshah1/nexa-bot/pull/464) PR-4 | resellers, bots, settings tabs, features list, panels, audit tab                     | `dcf30a6a`   |
| [#461](https://github.com/Mhoseinshah1/nexa-bot/pull/461) PR-L | legacy cleanup: proven VACUUM, archive twin dedupe, wheel dropped, «پاک‌سازی تکمیلی» | `dc6ae2d3`   |
| [#463](https://github.com/Mhoseinshah1/nexa-bot/pull/463) PR-N | sing-box profile name, premium-emoji description capture, entered-export trace       | `4b68f133`   |
| PR-5 (this)                                                    | final sweep (`final-report.md`, 68 side-by-sides at 1440 light), this report         | —            |

Per-PR detail (changes, tests, mutation checks, Codex, decisions) is in each PR description.

## Outcome against the owner's kit report (477 items)

FIXED 427 · NOT DONE 33 · UNVERIFIED 17 — per route with reasons in
`docs/web-redesign/demo-parity/final-report.md`. NOT DONE, in short: `/content` one table per
template; `/recovery` per-invoice card (owner removed it in `f9ec6f869`, no API); `/resellers`
name buttons (only path to the standing drawer); tier-name buttons on `/reseller-plans` and
`/reseller-tiers`; `/reports` range chips; `/incidents/:id` head chips;
`/notification-center` «خوانده‌نشده» button (a chip in the panel); one duplicate `/settings`
section button. Missing API data: the `/recovery` per-invoice result (no endpoint); whole-list
server CSV export for users/orders/payments (no endpoint — the CSV is built from loaded rows).

## Mirza wording replaced

`packages/i18n/src/operational-event-messages.fa.ts`: «انتقال از میرزا (…)» → «انتقال از ربات قبلی (…)»,
«کلید بستهٔ میرزا» → «کلید بستهٔ ربات قبلی» (PR-4). No other user-facing «میرزا» on the touched pages.

## Incidents

- GitHub runners could not resolve the Ubuntu apt mirrors from ~13:20 to ~16:50 UTC: Deployment
  smoke and Legacy rehearsal were red on `main` and on every PR. Nothing merged on red; the owner
  ordered one debug re-run of each run's failed jobs; merges resumed when `main` went green.
- Remote branch deletion is refused by the session's git proxy: the round's head branches stay on
  `origin` (listed in the final message).

## Owner check list

1. `sudo botctl update vX.Y.Z` (the owner tags it).
2. Compare with the demo in both themes and on a phone: payment methods, a customer page (blocked
   and not), a service page, orders, settings (tabs; edit, switch tab, come back, save), tickets.
3. Panel settings: «نام پروفایل در sing-box» → «نام کاربری اکانت»; open a service in the bot and
   scan the sing-box QR in sing-box: the profile is named after the account username.
4. Product page: «ارسال توضیح از تلگرام», send a text with premium emoji to the bot, Save, open the
   product in the bot: the emoji are premium.
5. Enter a hosted bot's panel, export a gift-card batch: a row naming the bot appears in your own
   audit log.
6. Legacy cleanup card: a second run «پاک‌سازی تکمیلی» with real before/after sizes;
   `legacy_history_records` clearly below 1694 MB.
7. `sudo botctl roles disable provisioner monitor`.

## Usage

| PRs | Agents                                             | Tiers                                                                                    | CI cycles                                                    |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 8   | 9 implementers/fixers, 1 CI watcher, 9 log lookups | lead; default (PR-0..4, N1/N2, PR-5, fix); money (PR-L, N3); cheapest (watcher, lookups) | PR-0 1 · PR-1 1 · PR-2 2 · PR-3 3 · PR-4 2 · PR-L 4 · PR-N 3 |
