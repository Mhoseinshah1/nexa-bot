# The Telegram runtime after the R9 split

`apps/api/src/surfaces/telegram/bot-runtime.ts` was one ~18.8k-line class. Round 9
(Phase B) split it, behaviour-preserving, into a router and free-function flows under
`apps/api/src/surfaces/telegram/runtime/`. This page is the map, the pattern, and the
list of business logic the split deliberately left in the surface.

`bash scripts/claude/module-map.sh --bot` prints every file below with its size;
`bash scripts/claude/module-map.sh --bot <handler>` prints where a handler is defined and
who calls it. Use those instead of opening the router.

## The router: `bot-runtime.ts` (~2.5k lines)

`BotRuntime` keeps only what routes a turn and what the tests pin by name:

| Member                                             | What it is                                                                                                                                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handle`                                           | The public entry: resolve the customer, commit, classify (`intentOf`), act, then send or edit, outside any transaction. The welcome banner and tutorial video sends live here (`r5c2-inline-keyboard-scan` allows `.sendFile(` in this file only). |
| `guardedAct` → `termsGatedAct` → `act`             | The captcha (R10 D5) and membership gates, the terms gate, and the intent switch. `terms-gate.test.ts` pins that `act` is reached only through these, by reading this file.                                                                        |
| `acceptTerms`, `isAdmin`, `capturedText`           | The terms button, the administrator check, and the customer's open text window by purpose.                                                                                                                                                         |
| `editWizard`, `editOrSend`, `stopSpinner`, `refOf` | The message plumbing every flow's reply goes through.                                                                                                                                                                                              |
| `menuFor`                                          | The reply-keyboard route table for a text message. An owner-defined label maps to `mb:<id>` and never overrides a shared label (R10 D2).                                                                                                           |
| `serviceCardFor`                                   | Public: `container.ts` hands it to the provisioner, which redraws a service card through it.                                                                                                                                                       |

The file is also the barrel: the callback prefixes, intents, reply helpers and a few flow
exports are re-exported from it, because tests and `container.ts` import them from here.

## The flows: `runtime/`

| File                       | What lives there                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `intents.ts`               | `BOT_INTENTS`, `BotIntent`, `BotCommand`: the closed vocabulary of what a customer asked for.                           |
| `callbacks.ts`             | Every `callback_data` prefix and the id-pair / version encoders.                                                        |
| `intent-of.ts`             | `intentOf`: one update to one `BotCommand`; `startPayloadOf`, `updateIdOf`, `privateChatIdOf`.                          |
| `deps.ts`                  | `BotRuntimeDeps` and the ports the runtime needs.                                                                       |
| `replies.ts`               | `PendingReply`, `BotTurnResult`, `replyFor`, the blocked and stale replies.                                             |
| `refusals.ts`              | `refusal(error)` and `REFUSAL_REPLIES`: an error code to one customer sentence.                                         |
| `keyboards.ts`             | The main-menu button and the notification lane's buttons.                                                               |
| `listed-price.ts`          | R11 A9: how a price-list button carries a line its personal discount wins (the figures are `PricingService`'s).         |
| `start-menu-flow.ts`       | `/start` greeting, membership and terms replies, marketing opt-in/out.                                                  |
| `captcha-flow.ts`          | R10 D5: the `/start` captcha gate (`captchaGate`, first check of `guardedAct`), its replies and answer buttons (`hc:`). |
| `purchase-flow.ts`         | Catalogue, categories, the custom service, draft, username, discount code, pre-invoice, order cancel.                   |
| `checkout-flow.ts`         | Wallet payment, the method selector, gateway payment and check, `settledKeyFor`; the rules live in `CheckoutService`.   |
| `payment-screens.ts`       | The gateway attempt screen, pay-method and top-up buttons.                                                              |
| `card-receipt-flow.ts`     | Card-to-card: instructions, switch card, transfer sent, receipt upload, cancel, gateway receipts.                       |
| `topup-flow.ts`            | Wallet balance and the top-up flow.                                                                                     |
| `service-card-flow.ts`     | My services list, the service card, resend, files, suspend/resume, search, note, refresh.                               |
| `service-actions-flow.ts`  | Renew, add traffic/time/devices, change location, rotate link, the commercial quote and confirm.                        |
| `service-requests-flow.ts` | Refund and transfer requests on a service.                                                                              |
| `referral-flow.ts`         | The invite and the gift.                                                                                                |
| `trial-flow.ts`            | The trial.                                                                                                              |
| `tutorial-flow.ts`         | Tutorials and client-app screens.                                                                                       |
| `support-flow.ts`          | Support screen and tickets.                                                                                             |
| `custom-button-flow.ts`    | A tap on an owner-defined main-menu button: link, text, photo, document, or "unavailable" (R10 D2, ADR-0036).           |
| `admin-common.ts`          | The management panel's shared prefixes and section check.                                                               |
| `admin-flow.ts`            | `adminTurn`, `adminCaptureText`: the management panel's switch.                                                         |
| `admin-review-flow.ts`     | Receipt and refund-request review, approve, reject, credit.                                                             |
| `admin-customers-flow.ts`  | Customers and categories sections.                                                                                      |
| `admin-services-flow.ts`   | Services, panels, reminders, usernames and administrators sections.                                                     |

## The pattern: free functions, no forwarders

A handler is a free function whose first parameter is the runtime:

```ts
export async function walletPayment(rt: BotRuntime, scope: TenantContext, ...): Promise<PendingReply>
```

- The router calls it through a namespace import: `checkoutFlow.walletPayment(this, ...)`.
- A flow calls another flow's function directly, with a named import:
  `import { preinvoice } from './purchase-flow.js'` and `preinvoice(rt, ...)`. It never
  goes back through the runtime: there are no one-line forwarding methods on `BotRuntime`
  (R9 removed 85 of them).
- A flow imports `bot-runtime.ts` **type-only** (`import type { BotRuntime }`). A value
  import would be a cycle through the router.
- Flows may import each other (`purchase-flow` and `checkout-flow` do, both ways), so no
  flow may USE an imported binding at module load (a top-level `const` built from another
  flow's export). Inside a function body it is safe; at the top level it is a TDZ error that
  depends on which module was imported first.
- A flow reaches dependencies as `rt.deps.<port>`, and the router's plumbing as `rt.refOf`;
  nothing else on `rt`.

## Adding a bot screen

1. Put the handler in the flow file it belongs to (or a new `runtime/<name>-flow.ts`), as a
   free function `fn(rt: BotRuntime, ...)`.
2. Add the intent to `intents.ts` and its parsing to `intent-of.ts`; a new prefix goes in
   `callbacks.ts` (the prefix-shadowing test in `tests/unit/bot-runtime.test.ts` reads the
   barrel's exports, so re-export it from `bot-runtime.ts`).
3. Wire it in `act` (or `adminTurn` for an `ADMIN_*` intent): one line calling the flow.
4. Customer text through a template key; the source-scanning tests read every file in
   `runtime/` (`inline-button-routing`, `payment-tracking-display`, `telegram-command-menu`,
   the label scan in `bot-runtime.test.ts`), so a new file is covered without editing them.

## Historical mutation scripts

`scripts/mutate-*.py` anchor on text in `bot-runtime.ts` as it stood BEFORE the split.
Their anchors for moved handlers now live in `runtime/*.ts` and the scripts will report
"anchor not found"; they are a record of past rounds, not a tool to rerun as is.

## Business logic left in the surface (for the mini app)

The mini app (Phase C) must call application services, never these handlers. Each item
below is a decision a second surface would have to repeat. None was moved in R9: each is
money arithmetic, a choice of which money lane runs, or a display rule entangled with the
reply it draws, and the round's rule was to move only clean, money-free predicates.

R10 B1 moved the checkout decisions out: the confirm lane by purpose, the wallet pre-check
and its shortfall, the routes an order offers (and the top-up chooser's names and gifts),
and which gateway a tap may start are `CheckoutService`
(`modules/commerce/checkout/application/checkout.service.ts`), which the bot's flows and the
mini app's controllers both call. `tests/integration/r10-char-checkout-parity.test.ts`
holds the two paths to the same answers and pins the bot's screens byte for byte.

| Where                                                       | The decision                                                                                                                      | Why it stayed                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `checkout-flow.ts` `settledKeyFor`, `followUpForSettlement` | The answer after a settlement by order purpose, and whether a delivery follows.                                                   | Pure, but it selects template keys; a mini app needs the purpose rule, not these keys.                                           |
| `purchase-flow.ts` `afterDraft`                             | After a draft: ask for a username, or go straight to the pre-invoice.                                                             | Reads the panel's username policy and the draft together.                                                                        |
| `service-actions-flow.ts` `devicesChoice`                   | The price of each extra-device option, price times quantity.                                                                      | Money arithmetic outside `PricingService.price`; should be quoted by it.                                                         |
| `referral-flow.ts` `referralInvite`                         | Whether the referral programme is on and whether the gift is claimable now.                                                       | Reads settings and the gift source together with the banner it sends.                                                            |
| `service-card-flow.ts` `serviceDetail`                      | Whether the card offers renew: a renewal is offered, or time packages are and `addon_time_in_renew_menu` keeps them in that menu. | Money-free, but it is one line inside the card builder and reads a setting through the runtime's deps. The likeliest first move. |
| `service-actions-flow.ts` `locationTarget`                  | Whether a location move is free (a zero quote) and is therefore requested directly instead of quoted.                             | A money test on the quote.                                                                                                       |
