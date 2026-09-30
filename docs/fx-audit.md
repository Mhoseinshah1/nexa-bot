# Package FX — Central exchange rates and Stars via central FX: audit and design

Round P, packages **FX** and **FX-STARS** (`p-brief.md`). The brief is the product
authority. §1 is the audit of what existed, §2 the provider evidence, §3 the design, §4
the implementation notes, §5 the falsification (mutation) evidence, §6 what still needs
real acceptance.

Base: `39c5d53` (head of `claude/n-f-campaigns`, PR #118). Branch `claude/p-fx`.

## 1. What existed (the audit), and which boundary each new piece extends

| Concern                            | Where                                                                                                                                                                | What it did at the base                                                                                                                                           | What this package does with it                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stars conversion                   | `contracts/telegram-stars.ts` `telegramStarsFor`; `payments/infrastructure/telegram-stars-adapter.ts` `providerAmountOf(amount, rateMinor)`                          | `stars = ceil(payable / rate)` in `bigint`, rate = the route's operator-set `provider_unit_rate_minor` (Package A, `docs/package-a-telegram-stars-audit.md` §2.2) | **Kept exactly** as the `FIXED_RATE` policy. The adapter now takes a `ResolvedConversion` and, under `CENTRAL_FX`, applies the contract's `providerUnitsByCentralFx` — the same ceiling over `rate / ratio`.                                                                                                              |
| Frozen invoice snapshot            | `gateway_invoices.conversion_rate_minor`, `sent_amount`, trigger `nexa_gateway_invoices_snapshot_guard` (0127)                                                       | The rate and the Star figure frozen with the row                                                                                                                  | **Extended**: `conversion_policy` and the `fx_*` columns, and the guard widened to freeze them (migration 0149).                                                                                                                                                                                                          |
| The descriptor                     | `contracts/payment-gateways.ts` `PaymentGatewayDescriptor.conversion: 'SAME_UNIT' \| 'FIXED_RATE'`                                                                   | The core branched on this string in six places                                                                                                                    | **Replaced** by `GatewayConversionSpec` (policies, base asset, the setting that picks the policy, the setting holding the unit ratio). `takesFixedRate(spec)` is what the six places read now.                                                                                                                            |
| The attempt                        | `PaymentService.requestGatewayPayment` / `requestGatewayTopup` → `gatewayRouteFor` → `openGatewayAttempt`                                                            | Read the route's rate inside the transaction, snapshotted it, computed `sent_amount`                                                                              | **Extended**: `resolveConversion` decides the policy inside the same transaction from the spec and the mode setting, reads the central quote there (a read, never a dial), snapshots everything, records a stale quote's use, and refuses a new central-rate attempt with `FX_UNAVAILABLE` when there is no usable quote. |
| The gateway lane                   | `GatewayPaymentService` (creates invoices, inquires, settles)                                                                                                        | Reads `invoice.sentAmount`                                                                                                                                        | **Untouched**: the figure it sends is the frozen one.                                                                                                                                                                                                                                                                     |
| TonPays                            | `tonpays-adapter.ts` `providerAmountOf(amount)` → `tomanAmountOf`                                                                                                    | Same unit                                                                                                                                                         | Takes the `ResolvedConversion` and converts only under `SAME_UNIT`. No FX of its own — the brief's "adapters must not independently fetch FX" holds for it as it did.                                                                                                                                                     |
| The one HTTP client                | `infrastructure/net/safe-http.ts` `SafeHttpClient` (`node:http`, pinned address, deadline, size cap, no redirects, transaction guard)                                | Panels, subscription files                                                                                                                                        | **Reused** for both FX sources, with their own bounds (`FX_SOURCE_TIMEOUT_MS` 5 s, 256 KiB). Never `fetch`.                                                                                                                                                                                                               |
| The "cache / token-bucket" pattern | `payment_gateway_call_budgets` (per-minute window, one conditional upsert); the panel probe claim; `redis.ts` ("never the source of truth for anything financial")   | Postgres rows with conditional writes; Redis holds only the anti-spam counter                                                                                     | **Followed**: the last-known-good quote is a Postgres row, the refresh lease is one conditional upsert, the store is one conditional update ("only if newer"), a rate-limit cooldown is a row every replica reads. Nothing FX lives in Redis, because the quote prices invoices.                                          |
| Settings, flags                    | `contracts/settings.ts`, `contracts/features.ts`, `SettingsResolver.valueOf(scope, key, tx)`, `SettingChangeGuard`                                                   | Registry-declared keys, resolved in-transaction; guards veto one key each                                                                                         | **Extended**: six keys, one flag, two guards (`stars-pricing.guards.ts`).                                                                                                                                                                                                                                                 |
| Operational events                 | `OperationalEventRecorder` with `dedupeKey`, `recoversCode`, `recoversDedupeKey`; `OperationalConditionReader.openConditions`                                        | Deduped conditions with explicit per-subject recoveries                                                                                                           | **Used** for the five FX codes; a recovery is written only for an open subject, so a healthy pass writes nothing.                                                                                                                                                                                                         |
| Worker loops                       | `PaymentExpiryLoop`, `GatewayPaymentLoop` + `LoopProgress`; `worker-health-coverage.test.ts`                                                                         | One file per freshness-bearing loop; health from progress                                                                                                         | **Added** `FxRefreshLoop` on the same shape, in the worker's health list and start sequence.                                                                                                                                                                                                                              |
| Web Admin                          | `pages/payment-gateways.tsx`, `settings-presentation.ts` (total over `SettingKey`), `features-catalogue.ts` (total over `FeatureFlagKey`), `web.fa.ts`, `check:i18n` | The payment routes page                                                                                                                                           | **Extended** with the FX card (`pages/fx-section.tsx`), a `fx` settings group, the flag entry, and the invoice's snapshot lines on the payment detail.                                                                                                                                                                    |
| Telegram surface                   | `bot-runtime.ts` `gatewayRefusal`                                                                                                                                    | One sentence for every route refusal                                                                                                                              | **Extended** with `bot.payment.fx_unavailable` for the one refusal whose remedy differs.                                                                                                                                                                                                                                  |

Nothing at the base fetched a rate anywhere. `money.ts`'s `ConvertedMoney` type existed
with no producer; it is still not used — a Star is not `Money` (Package A's rule), so the
snapshot lives on the invoice row, not on a converted amount.

## 2. Provider evidence

### 2.0 What could and could not be reached

The build session's egress policy refused `apidocs.nobitex.ir`, `api.nobitex.ir`,
`api-docs.wallex.ir`, `developers.wallex.ir` and `api.wallex.ir` (proxy `403` on CONNECT,
recorded in the proxy's status). **No live response was recorded.** The shapes below come
from the providers' published sources, which were reachable through GitHub:

- **Nobitex**: the documentation site's own source repository, `nobitex/docs-api`
  (`source/includes/_market_data.md`, commit `d5330f0`, 2026-04-22). Authoritative — it
  is what `apidocs.nobitex.ir` is built from.
- **Wallex**: two open-source clients that mirror its documentation, `darhelm/go-wallex`
  (`types/marketInformation.go`, `client.go`, 2025-11-23) and `amiwrpremium/wallex`
  (`models.py`, `clients/main.py`, 2022-11-22). Evidence, not specification (the rule
  `docs/research/` states); they agree with each other on every field this package reads.
  `wallexchange/wallex-go` (Wallex's own) is not public.

`OQ-FX-02` records the live acceptance still owed. Both adapters fail CLOSED on a shape
they do not recognise: the source reads `UNAVAILABLE`, the other prices the pair, and no
figure is invented.

### 2.1 Nobitex (primary)

- **Endpoint**: `GET https://apiv2.nobitex.ir/v3/orderbook/USDTIRT`. The documentation
  prints `apiv2.nobitex.ir` as the host (the community clients use `api.nobitex.ir`; the
  documentation wins and the base is configuration, `FX_NOBITEX_BASE_URL`). Documented:
  "محدودیت فراخوانی: 300 درخواست در دقیقه", "نیاز به ارسال توکن: ندارد", and a warning that
  only `GET` is supported on this endpoint.
- **Shape** (documented example, quoted): `{"status": "ok", "lastUpdate": 1644991756704,
"lastTradePrice": "35650565900", "asks": [["1476091000", "1.016"], …], "bids":
[["1470001120", "0.126571"], …]}`. The parameter table names `bids` as "دوتایی‌های
  «قیمت، مقدار» از سفارش‌های **خرید**" (buy orders) and `asks` as the sell orders;
  `lastUpdate` as "زمان آخرین به‌روزرسانی به فرمت یونیکس" (milliseconds, per the example).
- **Symbol and unit**: `USDTIRT`. The same page's `market/stats` example is queried with
  `dstCurrency=rls` and the text says "اگر `dstCurrency=rls` را تنظیم کنید، تمام بازارهای
  ریالی را دریافت خواهید کرد"; its `/v3/orderbook/all` example carries `USDTIRT` with bids at
  `"277960"` — a February-2022 Rial figure (≈27,796 Toman). So every price is **Rial**, and
  the service converts to the sales currency exactly (`convertQuoteCurrency`: one Toman is
  ten Rial, a scale shift, never a division).
- **Field chosen**: the **highest price in `bids`** — computed, not the first entry, because
  the documentation shows the books sorted but does not promise it.
- **Why not `market/stats`**: it carries `bestBuy` (the same figure) and `isClosed`, but no
  timestamp and a documented limit of 20 requests per minute against 300; the book gives
  `lastUpdate`, which the quote records as the source time.
- **Rate limits**: 300/min documented; this installation reads once per TTL (≥ 15 s) per
  tenant, ≤ 4/min. A `429` is `RATE_LIMITED` and the source is left alone for
  `FX_RATE_LIMIT_COOLDOWN_MS` (60 s) on every replica. The page also advises a 1–10 s gap
  between polls and notes a cache layer under one second, both far inside the TTL floor.

### 2.2 Wallex (fallback)

- **Endpoint**: `GET https://api.wallex.ir/v1/depth?symbol=USDTTMN`. Both clients: no
  authentication; the Go client's comment states a global limit of 100 requests per
  second (not verified against Wallex's own page).
- **Shape** (as both clients read it): `{"success": true, "result": {"ask": [{"price",
"quantity", "sum"}, …], "bid": [{"price", "quantity", "sum"}, …]}}`. The Go client
  documents `price` as sometimes a number-string and sometimes a number and reads both;
  so does this package, exactly (§3.6).
- **Symbol and unit**: `USDTTMN`, `TMN` = Toman. Every price is **Toman**.
- **Field chosen**: the highest price in `result.bid`. No timestamp is supplied; `sourceAt`
  is null and only the fetch time is recorded.
- **Why not `/v1/markets`**: it carries `stats.bidPrice` for every market at once — a body
  whose size this package cannot bound from documentation; the single-market book is small.

### 2.3 The quote side: `SELL_USDT_TO_RECEIVE_FIAT`

The merchant receives USDT from the customer and must sell it for fiat. A market sell fills
against the **bids**, so the fiat the merchant can realise per USDT is the best bid. Pricing
by the ask would state a fiat value per USDT the merchant cannot obtain, and the customer
would be asked for fewer USDT (or Stars) than the payable is worth — a systematic
undercharge. So both sources read their best bid, the side is a constant of the domain
(`FX_QUOTE_SIDE`), and no gateway adapter carries a bid/ask decision. Depth is not
weighted: a merchant selling a few hundred USDT against the documented book sizes
(`119.31` USDT at the top of Nobitex's 2022 example) may fill one level down; the outlier
rule and the operator's ratio, not a VWAP, are where that margin lives (§3.3).

## 3. Design

### 3.1 Shape

```
modules/commerce/fx/
  domain/fx-quote.ts                 pure: toCandidate, judgeCandidate, chooseQuote
  application/ports.ts               FxSourceAdapter, FxQuoteRepository, FxQuoteAnswer
  application/fx.service.ts          quoteFor / recordStaleUse / status / refreshIfDue / refresh
  application/fx-refresh-loop.ts     the worker's timer
  application/stars-pricing.guards.ts  the two SettingChangeGuards
  infrastructure/nobitex-source.ts, wallex-source.ts, fx-source-parsing.ts, drizzle-fx.repository.ts
contracts/fx.ts                      the quote model, the arithmetic, the conversion policies
surfaces/web/fx.controller.ts        GET /fx/status, POST /fx/refresh
```

### 3.2 The quote model (`contracts/fx.ts`)

`FxQuote`: `baseAsset` (`USDT`), `quoteCurrency` (`IRT` | `IRR`, the installation's
`sales.currency`), `side`, `rate` as `{ mantissa: bigint; scale }` (quote-currency minor
units per base unit, ≤ 8 fractional digits, trailing zeros normalised), `source`,
`sourceAt` (the book time, or null), `fetchedAt`, `ageSeconds`, `state`
(`FRESH` | `STALE_ALLOWED` | `UNAVAILABLE`), `quoteId` (deterministic:
`v<policy>:<source>:<pair>:<mantissa>e-<scale>:<sourceAtMs|->:<fetchedAtMs>`) and
`policyVersion` (`FX_POLICY_VERSION = 1`, bumped when the side, rounding or arithmetic
changes).

The rate is parsed from the provider's TEXT (`parseDecimalRate`), truncated past the cap
(never rounded up — the conservative direction for this side), and never a JS float.

### 3.3 Refreshing (`FxService.performRefresh`)

1. The worker's `FxRefreshLoop` ticks every 10 s and calls `refreshIfDue`; the operator's
   button calls `refresh`. Both take the **lease** first: one conditional upsert on
   `fx_quotes` that creates the row or claims it when no unexpired lease exists and — for
   the worker — the stored quote is older than `fx.fresh_ttl_seconds`. Two replicas is the
   normal case; the loser dials nothing.
2. Sources are asked in order, primary then fallback (`NONE` or the same source means
   primary only), each through `SafeHttpClient` outside any transaction. A source inside a
   rate-limit cooldown is skipped. The pass stops at the first ACCEPTED answer: the fallback
   is not dialled when the primary priced the pair.
3. Each reading is brought into the sales currency and **judged**: not positive → refused;
   outside the pair's sanity rails (`USDT/IRT` 1,000–1,000,000,000 Toman) → refused; more
   than `FX_OUTLIER_MAX_DEVIATION_BPS` (15 %) from a TRUSTED last-known-good → an outlier.
   Trusted means inside the stale limit: past it the old quote is no fact about the market,
   and comparing against it would refuse every honest figure after a real move for as long
   as the feed was down.
4. `chooseQuote`: the first accepted candidate; failing that, two outliers within
   `FX_SOURCE_AGREEMENT_BPS` (3 %) of each other — the market moved — win, the first of
   them; a lone outlier prices nothing.
5. The store is **only if newer** (`fetched_at < new`), and releases the lease. A refresh
   that stored nothing releases the lease with the failure's machine code; a refresh whose
   figure lost to a newer stored one releases it with none (a defect the integration case
   for a behind-clock replica found: the lease was left held until it lapsed).
6. Conditions, all deduped per subject and recovered only when open (`openConditions` in
   the same transaction): `fx.source_unavailable:<source>`, `fx.quote_rejected:<source>`,
   `fx.fallback_in_use:<pair>`, `fx.quote_unavailable:<pair>` (ERROR — no usable quote,
   new invoices refused), and `fx.stale_quote_used:<pair>` (written by the payment core).

### 3.4 Quoting (`FxService.quoteFor`)

Reads the row inside the CALLER's transaction and decides the state from
`now − fetched_at` against `fx.fresh_ttl_seconds` and `fx.max_stale_seconds` (floored at
the TTL). Never dials — a payment attempt runs inside a transaction. `UNAVAILABLE` names
why: `DISABLED` (the flag), `NEVER_FETCHED`, `TOO_STALE`.

### 3.5 The conversion contract and the snapshot

`GATEWAY_CONVERSION_POLICIES = SAME_UNIT | FIXED_RATE | CENTRAL_FX`. A descriptor's
`conversion` is a `GatewayConversionSpec`: the policies the route may use, its base asset,
and the NAMES of the setting that picks the policy and the setting holding the unit ratio.
The payment core resolves an attempt's policy generically (`conversionPolicyFor(spec,
modeValue)`) and reads those settings by the names the descriptor gives — no provider's name
appears in the core, and a future USDT gateway is a descriptor with `policies:
['CENTRAL_FX']`, `fxBaseAsset: 'USDT'`, no mode and a ratio of one.

"Provider-derived" conversion is deliberately not a member: no adapter does it, and a
member with nothing behind it is the switch that turns nothing on (the rule
`PAYMENT_METHODS` states). It arrives with the adapter that needs it.

`openGatewayAttempt` snapshots onto the invoice: `conversion_policy`, and for
`CENTRAL_FX` the quote id, source, base asset, quote currency, rate mantissa and scale,
source time, fetch time, the quote's state at that moment, the policy version, the unit
ratio mantissa and scale, and the effective sales-currency figure per provider unit as an
exact reduced fraction. `gateway_invoices_fx_snapshot_check` requires the set to be present
whole exactly when the policy is `CENTRAL_FX`, and the widened guard trigger freezes every
one of them. **Never recomputed**: a replayed request hands back the open attempt with its
own snapshot; a new attempt reads the quote in force.

`stars = ceil(payable × ratio.m × 10^rate.s / (rate.m × 10^ratio.s))` — one integer
division with a ceiling (`providerUnitsByCentralFx`). Where the effective figure is a
whole number it equals Package A's `telegramStarsFor` exactly (a unit test says so).

### 3.6 No float anywhere

`JSON.parse` turns a number into a double. Node 22 (`engines`) hands a reviver the number's
SOURCE TEXT; `parseExactJson` keeps it, so a Wallex price arriving as a JSON number is read
exactly as written. A runtime that gave no source text would make numeric prices
unreadable — the answer, rather than `String(double)`.

### 3.7 Settings, flag, guards

`central_fx` (off by default; TENANT_WIDE). `fx.primary_source` (NOBITEX),
`fx.fallback_source` (WALLEX | NONE), `fx.fresh_ttl_seconds` (45; 15–300),
`fx.max_stale_seconds` (900; 60–86,400), `stars.pricing_mode` (FIXED_RATE — the default,
so an upgrade changes no pricing), `stars.per_usdt` (a decimal, empty = unset).

Guards, both courtesies (the attempt decides again, authoritatively):
`stars.pricing_mode → CENTRAL_FX_RATIO` is refused while the flag is off or the ratio is
unset; `stars.per_usdt` cannot be cleared while the mode depends on it.

### 3.8 The customer and the operator

A new central-rate attempt with no usable quote is refused with
`PAYMENT_GATEWAY_UNAVAILABLE { reason: 'FX_UNAVAILABLE', detail }`; the Telegram surface
answers `bot.payment.fx_unavailable` ("نرخ ارز در این لحظه در دسترس نیست…"), naming no
source. The Web Admin card shows the feature's state, primary/fallback, the quote in force
(rate, source, book time, fetch time, age, state), the two windows, the last attempt and
error, each source's history, and — for Stars — the mode, the ratio, the fixed rate and the
Toman per Star the central rate produces; one button refreshes and audits who pressed it.

## 4. Implementation notes

- **Migration 0149** is generated plus two hand-written statements: the backfill of
  `conversion_policy` to `FIXED_RATE` where a rate is snapshotted, placed BEFORE the CHECK
  that requires the two to agree, and the widened guard trigger. `pnpm db:check` runs on
  an empty database and would never see the row the ordering exists for, so it was proven
  by hand: migrate `nexa_pfx` to 0148 (journal trimmed, restored), insert a rate-bearing
  Stars invoice and a TonPays one with FK checks off, apply 0149 → `TELEGRAM_STARS |
FIXED_RATE | 1300` and `TONPAYS | SAME_UNIT`, and `UPDATE … SET conversion_policy =
'CENTRAL_FX'` refused by the guard.
- **Late binding**: `PaymentService` receives `fx` as two closures over a ref the
  container fills once the FX service exists beside the HTTP client (the same shape
  `invoiceScreens.refresh` uses). Nothing calls them before the container has finished.
- **The refresh loop has no flag of its own**: a pass reads the feature inside and does
  nothing while it is off, so a stalled lane is visible whatever an operator switched on.
- **The manual refresh is not a keyed command**: like a panel's connection test, its
  answer is the sources' and a replay could not repeat it. It is audited (`fx.refresh`).
- **The catalogue courtesy** (`PaymentGatewayService.adapterAdmits`) admits a rate-bearing
  route by its fixed rate whatever the mode; under the central policy the answer is the
  same, because a positive payable is at least one unit either way, and only a same-unit
  route can answer "no exact value". The attempt decides authoritatively.
- **Base URLs** are configuration (`FX_NOBITEX_BASE_URL`, `FX_WALLEX_BASE_URL`) so the
  integration suite can stub them; nothing sensitive travels, and the URL policy still
  refuses plaintext to a public host.

## 5. Falsification evidence

Each load-bearing rule was reverted once, the named tests run, and the source restored
(`git checkout`), by a scripted runner; the counts are from real output. A contracts
mutation rebuilt the package before and after.

| #   | Rule reverted                                                                             | Named test(s)                                                  | Result                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | `fxQuoteStateFor`: past the stale limit is `UNAVAILABLE` → always `STALE_ALLOWED`         | `fx-conversion`, `fx-service` (unit); `fx-stars` (integration) | unit **3 failed** / 33; integration **1 failed** / 11                                                                                                                                                                                                                                                                                 |
| M2  | `providerUnitsByCentralFx`: ceiling → floor                                               | `fx-conversion`; `fx-stars`                                    | unit **2 failed** / 18; integration **5 failed** / 7                                                                                                                                                                                                                                                                                  |
| M7  | `conversionPolicyFor`: an unknown mode → central instead of fixed                         | `fx-conversion`; `fx-stars`                                    | unit **1 failed** / 19; integration **1 failed** (the FIXED_RATE backward-compatibility case) / 11                                                                                                                                                                                                                                    |
| M3  | `chooseQuote`: two outliers accepted without agreement                                    | `fx-conversion`, `fx-service`                                  | **1 failed** / 35                                                                                                                                                                                                                                                                                                                     |
| M3b | `chooseQuote`: a lone outlier accepted                                                    | `fx-conversion`, `fx-service`                                  | **1 failed** / 35                                                                                                                                                                                                                                                                                                                     |
| M5  | `judgeCandidate`: an untrusted last-known-good still compared against                     | `fx-conversion`                                                | **1 failed** / 19                                                                                                                                                                                                                                                                                                                     |
| M4  | `resolveConversion`: no usable quote → fall back to the fixed rate instead of refusing    | `fx-stars`                                                     | **2 failed** (beyond-stale refusal, feature-off refusal) / 10                                                                                                                                                                                                                                                                         |
| M10 | `StarsPricingModeGuard`: the flag check removed                                           | `fx-stars`                                                     | first run **survived**: the ratio was still empty, so the guard's ratio branch refused with the same code. The test now sets the ratio first and matches each refusal's reason. Rerun: **2 failed** / 11 (the guard case, plus the behind-clock case that was failing on the baseline at that moment — see M15)                       |
| M11 | `openGatewayAttempt`: the stale-use record removed                                        | `fx-stars`                                                     | **1 failed** / 11                                                                                                                                                                                                                                                                                                                     |
| M12 | `performRefresh`: the `break` after an accepted primary removed (fallback dialled anyway) | `fx-service`                                                   | **4 failed** / 12                                                                                                                                                                                                                                                                                                                     |
| M13 | `performRefresh`: the rate-limit cooldown ignored                                         | `fx-service`                                                   | **1 failed** / 15                                                                                                                                                                                                                                                                                                                     |
| M14 | `claimRefresh`: the "older than the TTL" condition dropped                                | `fx-stars`                                                     | **1 failed** / 11                                                                                                                                                                                                                                                                                                                     |
| M15 | `storeQuote`: "only if newer" dropped                                                     | `fx-stars`                                                     | first run **survived**: nothing stored an older fetch. A case was added (the stored quote reads as fetched an hour from now; an operator refresh must not replace it) — and it failed on the UNMUTATED code: the refused store left the lease held. Fixed (§3.3 step 5). Rerun on the fixed baseline (13/13 green): **1 failed** / 12 |

Not covered by mutation, stated rather than hidden:

- The migration's backfill ordering (§4): proven once by hand, not by a test that runs.
- The Telegram surface's mapping of `FX_UNAVAILABLE` to `bot.payment.fx_unavailable`
  (`gatewayRefusal` is not exported); `check:i18n` proves the key renders, the
  integration test proves the refusal's `reason` and `detail`.
- The Drizzle `recordSourceFailure` counter arithmetic: exercised by the HTTP case
  (`consecutiveFailures: 1`), not mutated.

## 6. Still needs real acceptance

1. **One live read of each source** from a host that can reach them (the staging server):
   `POST /api/admin/v1/fx/refresh`, then the FX section and the operational log. What to
   check: Nobitex answers `status: "ok"` with a `bids` array of string pairs and a
   millisecond `lastUpdate` on `apiv2.nobitex.ir` (if only `api.nobitex.ir` answers, set
   `FX_NOBITEX_BASE_URL`); Wallex answers `success: true` with `result.bid[].price`, and
   the figure is Toman (a ten-fold disagreement with Nobitex is the unit being wrong, and
   the outlier rule will refuse one of them — read `fx.quote_rejected`). `OQ-FX-02`.
2. **The rails and the outlier bound against a real month of prices**: 15 % and the
   1,000–1,000,000,000 Toman rails are product rails chosen from the documented 2022
   figure and today's order of magnitude, not from a recorded series.
3. **A real Stars invoice under the central mode** on staging: the Star figure Telegram
   shows equals `sent_amount`, pre-checkout approves it, and the invoice row's snapshot
   explains it (`docs/real-panel-acceptance.md`'s rule: a fake and an adapter this
   repository wrote can only prove they agree with each other).
4. **The operator's ratio**: `stars.per_usdt` is the operator's own terms (`OQ-FX-01`);
   the acceptance is the owner setting it against Telegram's current Star pricing and
   reading the Toman per Star the card shows.
