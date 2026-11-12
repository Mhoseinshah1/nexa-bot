# Round report — reseller web panel, captcha kinds, backup without host copies, demo leftovers

Round prompt: the reseller-panel phase (owner, 2026-11-11). Base: `main` at `415fa9b7`.

**No PR of this phase is merged.** The session's merge call was refused by its permission check, so every PR is open
and waits for the owner. No merge commit exists; none is invented here: «ادغام نشده (منتظر مالک)».

## PRs

| PR                                                             | What                                                                                | Merge commit |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------ |
| [#466](https://github.com/Mhoseinshah1/nexa-bot/pull/466) PR-3 | backup «بدون نگهداری»: no archive on the host once Telegram holds it                | not merged   |
| [#467](https://github.com/Mhoseinshah1/nexa-bot/pull/467) PR-2 | `/start` captcha kinds (image number, emoji, word number, random)                   | not merged   |
| [#468](https://github.com/Mhoseinshah1/nexa-bot/pull/468) PR-1 | real-demo leftovers and the date-time picker's end-of-day edge                      | not merged   |
| [#469](https://github.com/Mhoseinshah1/nexa-bot/pull/469) PR-4 | reseller panel core: access, layout, read screens, PWA                              | not merged   |
| [#471](https://github.com/Mhoseinshah1/nexa-bot/pull/471) PR-5 | buying (several at once), clients book, auto-renew, trials, tier progress; on #469  | not merged   |
| [#470](https://github.com/Mhoseinshah1/nexa-bot/pull/470) PR-6 | dedicated bot for a reseller with a monthly wallet fee; on #469 (it merged #469 in) | not merged   |
| PR-7 (this)                                                    | status, README, this report, screens                                                | merge last   |

Merge order: #466, #467, #468, #469, #471, #470, then this PR. Migrations: #467 0342, #469 0342, #471 0343, #470 0343;
after each merge the next branch merges `main` and renumbers (`bash scripts/claude/renumber-migration.sh`). Per-PR
detail (changes, tests, mutation checks, decisions) is in each PR description.

## Codex findings and fixes (one line each)

- #466: none (clean).
- #467: P2 the cooldown screen had no way to resume, fixed (retry button asks the server again); P2 a retried refresh
  clashed on its idempotency identity, fixed (identity independent of the challenge id).
- #468: P2 the row «بیشتر» menu clipped inside containers, fixed (menu rendered outside the clipping container).
- #469: P2 the top-up did not refresh the gateway attempt while the invoice was made, fixed; P2 the service drawer did
  not refresh after a link rotation, fixed (the QR address names the link); P2 the price list read one catalogue
  page, fixed (every page is read).
- #470: P1 the renewal sweep read one page, so a page of unpaid subscriptions starved newer ones, fixed (keyset cursor
  over the whole due set, test with a page of 1).
- #471: no Codex findings yet when this was written (the review run reported `failed`); CI on `fd31cb51` showed
  «Typecheck, lint and boundaries» red with the rest pending. Read the PR for the current state.

## Security-review findings fixed

- Captcha picture: the image was drawn from the client-visible challenge id, so all 10,000 answers could be
  re-rendered and compared. Now a per-question CSPRNG `render_seed` kept only on the row, plus fresh noise per render (#467).
- Reseller TOTP secret sat outside the secret registry (`secrets status`, rewrap, retire-check, restore clearing could
  not see it): columns renamed, purpose `reseller_web.totp_secret`, registry entry and a table-aware coverage test (#469).
- 2FA attempt race and disable replay: wrong codes were counted outside the transaction that judged them, and
  disabling had no replay rule or bound. Counted under the session row lock, disabling consumes the step (#469).
- Hosted-bot activation link: the delivered text would have stored the live one-time token in `rendered_text`.
  `CUSTOMER_NOTIFICATION_TEXT_NOT_STORED`: the text is never stored; audit, outbox and ops rows carry the link id (#470).

## Not done, with reasons

- **No PR merged**: the merge call was refused by the session's permission check. Everything waits for the owner.
- **Persian comments on issue #358 not posted**: they are per merge, and nothing merged.
- **`pnpm web:demo-diff`**: run once on a scratch tree holding #468, #469, #471 and #470 (light, 1440: remaining 219 against
  #468's 216, the three extra on `/resellers`). Dark and 390 runs were not made. The owner should re-run it after the merges.
- **`approved-demo.dc.html` not rendered** beside the app: it needs the owner's `support.js`, absent here. The README
  § Demo comparison compares source against screens.
- **Handoff file not committed**: the repository keeps the handoff on the `docs/r11-handoff` branch and `nexa-handoff`
  forbids committing it to `main`; it is in this PR's body instead.
- Dedicated bot: no bot-side entry for the request (optional in the brief). Reseller hosted tenants are not offered it.
- Remote branch deletion is refused by the session's git proxy; head branches stay on `origin`.

## Owner check list

1. Merge in the order above, renumbering as stated; the owner tags `vX.Y.Z`; `sudo botctl update vX.Y.Z`.
2. Web Admin «قابلیت‌ها»: turn on «پنل وب نماینده». In the bot, as a test reseller: «ورود به پنل وب», open the link, the
   dashboard opens.
3. Buy 2 services at once with a client chosen: both appear under that client. Turn on auto-renew for one. On a RickPanel
   service open «اتصال»: «ارسال فایل‌ها به تلگرام من» and «دانلود همه (ZIP)» both work.
4. Settings: turn on 2FA, log out, log in again with the link and the code.
5. Turn on «پیشرفت سطح» and set a target on the tier: the card shows. Set the trial quota to 2 and make a trial.
6. Set the dedicated-bot fee, request as the reseller, approve as the owner: the wallet is debited once; create the
   hosted bot; the activation link arrives in the bot.
7. «کپچای شروع» → «عدد در تصویر»: start the bot from a new account; an image arrives; type the number.
8. Backup: turn off «نگه داشتن نسخه روی سرور», «بکاپ الان»: the file is in the group, no archive in `/var/backups/nexa`.
9. `pnpm web:demo-diff` again on the admin pages; compare `/r/` with `docs/reseller-panel/screens/`.
10. `sudo botctl roles disable provisioner monitor`.

## Usage

| PRs | Agents                                                            | Tiers                                                                                        | CI cycles                              |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| 7   | implementers and fixers per PR, review and CI lookups, this sweep | lead; default (PR-1, PR-2, PR-4 web, PR-5 web, PR-7); money (PR-3, PR-4 API, PR-5 API, PR-6) | not counted here; see each PR's checks |
