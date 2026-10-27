# R11 A9 — price lists show the personal discount the invoice charges

Owner bug: with `personal_discount` on and a percent set on a customer (R10 D3, PR #339), every
price list the customer sees before checkout still showed the undiscounted price, while the draft
each line opens was priced with the discount. Every customer-facing price list now shows the
figure the checkout will quote when the personal discount wins it — the old price struck through,
the new price, and «تخفیف شخصی N٪» — and is drawn exactly as before everywhere else.

## What changed

### One pricing boundary (no second implementation)

- `PricingService.price` is split, behaviour-preserving, into:
  - `factsFor` — every fact it handed the engine besides the reseller layer and the percent: the
    live automatic rules, the entered code's rule, their live usage, the first-purchase answer, the
    cashback rules (same reads, same order, same transaction argument);
  - `personalPercentFor` — the old `personalCandidate`: customer, purpose in
    `PERSONAL_DISCOUNT_PURPOSES`, flag on, percent > 0;
  - `quoteWith` — the ONE composition a quote is made of: the reseller layer over the list base,
    then `applyAdjustments` with the personal percent taken off the LIST base.
    `price` is now `terms → factsFor → personalPercentFor → quoteWith`.
- New read `PricingService.personalListPrices(scope, { purpose, customerId, now, items })`:
  prices every line of a list through the same `quoteWith` over the same facts, so
  `LARGER_SINGLE_WINS`, the reseller tiers and the automatic rules decide a listed figure exactly
  as they decide the invoice. It answers a line only when the personal discount WINS that line's
  quote (`personalDiscountPercentOf` on the result); a line it does not win is absent and the
  surface draws it as before. No code (a draft is priced without one), no transaction, no lock,
  no write.
- Cost: the flag and percent are read first; with none (flag off, no percent, a purpose outside
  `PERSONAL_DISCOUNT_PURPOSES`) a list costs one flag read and nothing more. Otherwise the facts
  are read once per list, never per line.
- `ResellerService.pricingTermsForItems` — the reseller layer for a whole list: one standing read
  and ONE read of the tier's price table. Implemented by a new private `termsForItems`, which is
  now the single statement of a standing's terms: `termsFor` (the draft's, a list of one),
  `offeredPrices` (the catalogue courtesy) and the list all go through it.

### Callers (each priced from the LIST price, exactly as its draft is)

- `ProductService.browseCategory` / `browse` return `ListedProduct` (`ProductRecord` +
  `personalDiscount | null`), priced with `quoteProduct(product, product.price, 1, now)` — the
  draft's base — and joined onto the reseller-offered page by id. The personal base is never the
  reseller's offered price (that would be stacking).
- `CommercialActionService.offer`:
  - RENEW (the service's own product, and an imported service's panel plans) → `listedRenewals`
    (`quoteProduct`, as `quoteRenewal`);
  - ADD_TRAFFIC / ADD_TIME → `listedAddons` (`quoteAddon`, no product, no category, as
    `quoteAddon` at checkout). These purposes are not in `PERSONAL_DISCOUNT_PURPOSES`, so the
    boundary answers "none" without a read and the lists are unchanged; they follow the invoice
    automatically if the owner widens the purposes (OQ-R11-A9-01).
  - `CommercialOffer.product / plans / addons` carry `personalDiscount` (`Listed<T>`).
- `container.ts`: `PricingService` (and its three repositories) is built before `ProductService`;
  moved, not changed.
- Auto-renew's ask (R10 D1) already names `renewalQuote`'s total, i.e. `PricingService.price` —
  already discounted; untouched.

### Drawing

- Bot — plan list (`categoryPage`), renewal menu (`renewMenu`, own product + panel plans + time
  packages), package list (`addonChoice`): a won line's label carries the discounted price, and
  the button carries `personalDiscount { listPrice, percent }` (`runtime/listed-price.ts`:
  `listedPrice`, `personalDiscountOf`; figures only, no money logic). The messenger appends the
  old price struck through and `bot.pricing.personal_discount_tag`. A Telegram inline button is
  plain text (no `parse_mode`, no entities), so `<s>` cannot be used there: the strike is U+0336
  (`strikeThroughText`, new in `@nexa/i18n`). The rich plan table (rich messages + table on) uses
  a real `strikethrough` rich text in the price cell. Undiscounted buttons are byte for byte as
  before.
- Mini app — store and service offers: `personalDiscount` on the wire
  (`listedPersonalDiscountWire`), drawn by the new `PersonalPrice` (`<s>` old price, the new
  price, the tag `miniapp.personal_discount_tag`), styled in the mini app's own `base.css`
  (`.personal-price*`). An undiscounted line renders the same markup as before.

### Contract changes (own commits e734558a, 79f42e6e)

- Template key `bot.pricing.personal_discount_tag` (PLAIN_TEXT, `percent` NUMBER): «تخفیف شخصی
  {percent}٪»; its Web Admin editor label/description.
- `miniAppListedPersonalDiscountSchema` and `personalDiscount` (nullable, default null) on
  `miniAppProductSchema` and each `miniAppServiceOfferSchema` option — defaulted so either side
  meeting an older peer reads "none".
- `bot.pricing.` filed under the `purchase` template category (`TEMPLATE_CATEGORY_PREFIXES`) and
  the Web Admin's «فروشگاه، سفارش و پیش‌فاکتور» template section (79f42e6e), so the new key has
  exactly one category and section.

## Tests

| Suite                                                     | Tests | What                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/r11-personal-discount-listing.test.ts` | 8     | Real bot runtime (webhook path, fake Telegram socket) + real mini app HTTP + the real drafts. List == invoice for (a) a discounted customer, (b) no percent, (c) reseller whose tier wins, (d) reseller whose percent wins (never stacked), (e) flag off, (f) automatic rule larger, (g) automatic rule smaller; for the bot plan list, renewal menu and package list and the mini app store and offers; listing writes no order. |
| `tests/unit/r11-personal-discount-listing.test.ts`        | 5     | U+0336 helper; button text (plan + renewal) struck + tagged; undiscounted byte for byte; rich table cell strikethrough + tag; undiscounted table cell.                                                                                                                                                                                                                                                                            |
| `tests/web/miniapp-personal-discount.test.tsx`            | 3     | Store and service offer: `<s>` old price, new price, tag; undiscounted unchanged; an older server's payload reads as none.                                                                                                                                                                                                                                                                                                        |

Mutation checks (each applied alone, the named test red, restored, green):

| Mutation                                                                  | Red                                 |
| ------------------------------------------------------------------------- | ----------------------------------- |
| list path skips the reseller layer (`terms[index]` → null)                | (c)                                 |
| personal percent taken off the reseller price (stacking) in the list path | (d) (and (c))                       |
| list path ignores automatic rules                                         | (f)                                 |
| catalogue never asks `personalListPrices`                                 | (a), (d), (g)                       |
| renewal offer drops `personalDiscount`                                    | (a), (d), (g)                       |
| bot plan label keeps the old price                                        | (a), (d), (g)                       |
| messenger drops the struck price + tag on buttons / in the rich table     | unit: button test / rich-table test |
| mini app ignores `personalDiscount` (store + offer)                       | web: store test, service-offer test |

Local gate (every stage through `scripts/claude/run-gate.sh`, on the head merged with main):
`pnpm verify` stage by stage — typecheck exit 0; lint, format:check, check:boundaries,
check:i18n, check:citations, check:shell exit 0; build exit 0; unit passed=10181 failed=0;
web + deploy passed=3357 failed=0. Guard integration suites (private DB): r11-personal-discount-
listing, personal-discount, pricing-discounts, reseller-tier-prices passed=79 failed=0;
resellers, r10-char-checkout-parity, miniapp-surface, r9-char-service-actions, catalog
passed=95 failed=0.

## Decisions

- Packages (extra traffic / time) are listed at their own price: D3 does not discount them at
  checkout, and a list must never show a figure the invoice does not charge (OQ-R11-A9-01).
- Telegram buttons get U+0336, not `<s>` (impossible in a button); the rich table gets a real
  strikethrough (OQ-R11-A9-02).
- A list still never shows automatic rules (pre-existing); when one beats the personal discount the
  list shows what it always did (OQ-R11-A9-03).
- Latin digits in the tag, like every customer-facing template (OQ-R11-A9-04).
- Found and pinned, not changed: a reseller's PACKAGE list shows the package price while checkout
  takes the tier percent off it (customer's favour, older than this round; OQ-R11-A9-05).

## Migrations

None.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck

### Lead review note

Price lists show only what the invoice charges: extra traffic/time packages keep their normal price because R10 D3 does not discount packages at checkout (OQ-R11-A9-01). Pre-existing, not changed here: a reseller's package list shows the list price while checkout takes the tier percent off it — in the customer's favour (OQ-R11-A9-05).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
