## R11 B3 — the invited-friends list in the mini app referral screen

Behind a NEW feature flag `referral_friends_list` (default OFF, switchable in Web Admin «امکانات»). Read-only: no money moves, no message is sent, nothing is locked or written.

### What changed

Three commits, the contract on its own.

**1. `contracts:` (own commit, reason in the message)**

- Feature flag `referral_friends_list`, default OFF, blast radius LOCAL (a read-only section of the customer's own mini app). Added to the registry test.
- Mini app route `MINIAPP_ROUTES.referralFriends = '/referral/friends'`.
- Wire shape `miniAppReferralFriendsResponseSchema`: `{ enabled: false }` or `{ enabled: true, counts, items, nextCursor }`. An item has exactly four keys: `displayName` (string or null), `joinedAt`, `status`, `rewardNotBefore`. There is deliberately no id of any kind (no internal id, Telegram id, phone, last name) in the shape, so nothing on the wire can leak one. `MINIAPP_REFERRAL_FRIENDS_PAGE_SIZE = 20`; the route takes a cursor and nothing else, so a client cannot widen a page.

**2. `feat(referral):` API**

- `GET /miniapp/api/v1/referral/friends` (`account.controller.ts`): gated mini-app call; the referrer is the SESSION customer (`call.context.customer.id`), never a request parameter. Cursor decoded by the shared keyset decoder (a cursor the server did not mint is a 400).
- `ReferralFriendsService` (new): permission guard (the same own-read key the wallet history holds), then the flag (read inside the service so no surface can forget it; off answers `{ enabled: false }` after reading nothing), then one page plus the counts. `rewardNotBefore` is returned only for a `REWARD_PENDING` friend whose pending commissions are ALL deferred and whose instant is still in the future (clock port).
- `DrizzleReferralFriendsRepository` (new): tenant AND referrer in the WHERE before the page is cut; newest first by `(created_at, id)` keyset using PostgreSQL's own microsecond text for the cursor; joins the referee but selects only `first_name` and `username` (last name, Telegram id, phone are never read).
- Status is ONE SQL expression shared by the page and the counts, so they cannot disagree: `REWARD_PAID` (a commission of the referral EARNED with `earned_amount > 0`), else `REWARD_PENDING` (a commission still PENDING — waiting for delivery or held by the R10 D5 daily cap), else `PURCHASED` (the gift claim's own delivered-paid-purchase predicate `refereeQualified`, now exported), else `JOINED`. Exclusive; counts add up to the attribution count.
- `friendDisplayName` (new, pure): first name (controls and bidi/zero-width marks dropped, ZWNJ/ZWJ KEPT because Persian is spelt with ZWNJ, collapsed whitespace, 24 characters), else a username with the middle hidden (`@ab***`: two letters for >= 5, one for 3–4, none below), else null.
- Container wiring (`referralFriends`).

**3. `feat(miniapp,web):` UI**

- Mini app `referral.tsx`: a «دوستان دعوت‌شده» card between the figures and the steps: the total, the four counts, and each friend (name or «دوست تو», join date in the screen's existing Jalali/digit style via a new `dateOnly` beside `dateTime`, a status badge; for a capped reward «پرداخت پاداش از <date>»). «نمایش بیشتر» pages by cursor. Nothing is drawn while the flag is off; a failed read shows its own retry without hiding the rest of the screen. New Persian text only; existing copy untouched.
- Web Admin: the flag in the Features catalogue with a Persian title and summary; no confirmation either way (nothing moved or sent; off only hides the section).
- Docs: a paragraph in `project-status.md`; `OQ-R11-B3-01..04` in `open-questions.md`.

### Tests

| File                                                                       | Tests                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/referral-friend-name.test.ts`                                  | 5: first name wins, username masked, short usernames, neither -> null, bounds + invisible/bidi stripped, ZWNJ kept (that last is one of the 5 plus 1 = 6 `it`s; see run)                                                                                                                                                                           |
| `tests/integration/referral-friends-list.test.ts` (HTTP, mini-app session) | 7: flag off by default; own list only + tenant isolation (repository asked in tenant B) + a friend's own list is empty; every status per commission state + counts == `stats.referralCount`; one-deferred-one-waiting pending is not "held until"; masking / no identity on the wire; paging bound + traversal ends + bad cursor 400; MIRZA listed |
| `tests/web/miniapp-account.test.tsx`                                       | +5: flag off draws nothing; summary/names/dates/statuses/held date; paging by cursor; empty list; failed read keeps the screen and retries                                                                                                                                                                                                         |
| `tests/unit/registries.test.ts`                                            | flag registered, default OFF                                                                                                                                                                                                                                                                                                                       |

Gate run locally: typecheck, lint, format:check, check:i18n, the suites above (unit 41, web 80 incl. control-plane pages, integration 7). The full integration suite is CI-only.

### Mutation checks (break the rule -> named test red -> restore -> green)

| Mutation                                             | Red test                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| service ignores the flag                             | integration: flag off by default                                     |
| page drops the referrer filter                       | integration: own friends only                                        |
| page drops the tenant filter                         | integration: own friends only (tenant B repository assertion)        |
| `earned_amount > 0` removed from REWARD_PAID         | integration: every status (zero-earned expected PURCHASED)           |
| `refereeQualified` replaced by false                 | integration: every status (void/zero commissions expected PURCHASED) |
| `min(not_before)` without "all pending are deferred" | integration: one deferred + one waiting                              |
| `not_before > now` check removed                     | integration: every status (lapsed day) — see report for the run      |
| username mask reveals everything                     | integration: masking, and unit: masks the middle                     |
| page `slice(0, limit + 1)`                           | integration: paging bound                                            |
| MIRZA excluded from the page                         | integration: MIRZA listed                                            |
| `counts.joined` forced to 0                          | integration: totals (flag test, paging, MIRZA)                       |
| held-until line not rendered                         | web: summary/dates/statuses/held date                                |
| next page asked without its cursor                   | web: paging by cursor                                                |
| a disabled answer still draws a section              | web: flag off draws nothing                                          |

### Decisions

- **Imported (MIRZA) referrals are listed.** The screen's «دعوت‌شده» figure is `countReferredBy`, which has no source filter; a list that skipped them would contradict its own total (a test asserts total == `referralSignupGifts.stats().referralCount`). Their status is whatever a real purchase gives (`PURCHASED` at most; an imported attribution is never promised a commission).
- Status reads the PURCHASE commission only; the membership gift has its own claim button (OQ-R11-B3-01).
- No amounts per friend: commissions can be in mixed currencies and a reversal would contradict a stated figure.
- A separate route returning a flag-off union member, not a field on the existing referral response: the existing response and its tests are unchanged.
- Commit trailers use the session's own attribution line (Claude Sonnet 5.5) rather than the "Opus 5.5" text in the round rules; the contract commit (first) carries the "Opus 5.5" line and was already pushed.

### Migrations

None. No schema change; `refereeQualified` is only exported.
