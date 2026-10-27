## R11 B4 — the customer sees how many location changes they have left

### What changed

Where location change is **enabled for the service AND a limit is set**, the customer now sees
«تغییر لوکیشن باقی‌مانده: N از M» on:

1. the bot service card (سرویس‌های من),
2. the bot location-change screen,
3. the mini app service view,
4. the mini app location sheet.

No limit set: the line is absent. Feature off for the service: nothing at all, as before. Read-only, no money, no message.

**One counter, no second implementation.**

- `packages/contracts/src/service-location.ts`: the rolling-window count was inline in `locationChangeWindow`. It is now a single `changesInWindow`, used by `locationChangeWindow` (which refuses) and by the new `locationChangesRemaining` (which shows). `remaining === 0` exactly when the window refuses with `LIMIT`. Behaviour of `locationChangeWindow` is unchanged (its existing unit table passes).
- `LocationChangePolicy` (`location-change-policy.ts`): a private `candidates()` (current location + targets that are enabled, priced in the selling currency and not where the service is, with the Customer 360 override already applied to their limits) is now shared by `offer()` and the new `remainingChanges()`. The figure is computed from those same candidates and the same `countedRequestTimes` history `decide()`/`offer()` use. `offer()` returns the figure with the offer (`LocationOffer.remaining`) so the choice screens and the mini app sheet show the offer's own evaluation.
- `CommercialActionService.locationChangesLeft` (new read): applies the same first gates `availableFor` applies to CHANGE_LOCATION (custom service, state legal, panel capability, `LOCATION_CHANGE` policy row), then asks the policy. It is asked separately because at 0 remaining `offer()` returns null (the button is already withdrawn) and the customer must still be told «0 از M».
- Bot: `service-card-flow.ts` passes the figure to the card (the «working» card does not carry it); `service-actions-flow.ts` `locationChoice` passes `offer.locations.remaining`. The sentence is composed in `CustomerScreenComposer` (`serviceCard`, new `locationChoice`, private `locationRemaining`), not in a surface.
- Mini app: `services.controller.ts` detail returns `locationRemaining` (via `locationChangesLeft`), the sheet read returns `remaining` (the offer's). `service-detail.tsx` and `location-sheet.tsx` draw `miniapp.location_remaining` when not null.

**Contract commit (separate, first):** template key `bot.service.location_remaining` (`remaining`, `max`); optional token `locationRemaining` on `bot.service.card` and `bot.service.location_choice` (default bodies gain `{locationRemaining}` on its own line; the renderer drops an absent optional line, so screens without it render byte for byte as before, and tenant overrides keep rendering); the mini app wire fields `locationRemaining` (detail) and `remaining` (sheet), both nullable; Web Admin copy (`templates.fa.ts`). The follow-up commit relaxes the wire `max` to `min(0)` for robustness (a legacy row) and adds the pure helper above.

**Existing copy unchanged.** The mini app key `miniapp.location_remaining` is new; the comments that said the sheet "exposes no remaining count" were updated.

### Tests

- `tests/unit/location-change.test.ts` (+4, file 17 passed): `locationChangesRemaining` table, incl. "0 exactly when `locationChangeWindow` refuses with LIMIT" over history sizes x ages.
- `tests/integration/r11-b4-location-remaining.test.ts` (6, new): enabled+limit shows N از M on bot card, bot screen, mini app view and sheet and counts down; **displayed == enforced** (performs changes until the server refuses; the figure before each attempt predicts it, exactly 3 allowed, then «0 از 3», button gone, `location_limit` refusal and the mini app 409 unchanged); Customer 360 override applied to the figure; enabled+no limit absent (and the old screen byte for byte); a target with no limit -> absent; disabled (nothing configured, panel policy switch off) -> absent.
- `tests/integration/miniapp-location.test.ts`: key-set assertion updated (`remaining: null` with no limit). 6 existing tests pass.
- `tests/web/miniapp-screens-2b.test.tsx` (+3): no limit -> nothing; view and sheet show «2 از 3»; at 0 the view shows «0 از 3» and no sheet button.
- Also green: `bot-runtime`, `commercial-contracts`, `customer-screens`, `i18n`, `r3-service-card`, template-*, `service-card-layout-contract` unit suites; template web suites.

Mutation checks (apply -> named test red -> `git checkout` -> green; script run inside one gate):

| Mutation                                       | Red                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `max - used + 1` in `locationChangesRemaining` | 3 unit + 4 integration (counts down, enforced==shown, override, disabled) |
| window `>=` -> `>` in the shared count         | 2 unit                                                                    |
| history ignored in `remainingChanges`          | counts-down, enforced==shown, override                                    |
| policy gate skipped in `locationChangesLeft`   | disabled                                                                  |
| card not passed the figure                     | card tests (4)                                                            |
| location screen not passed the figure          | counts-down (bot screen)                                                  |
| mini app detail returns null                   | counts-down, enforced==shown, override                                    |
| mini app sheet returns null                    | counts-down (sheet)                                                       |
| unlimited target ignored in `leftOf`           | unlimited-target                                                          |
| customer override ignored in figure            | override                                                                  |
| card / screen default body without the line    | card (4) / screen (1)                                                     |
| mini app view / sheet never draw it            | 2 / 1 web; "draws even with no limit" -> no-limit web test red            |

Gate (local): typecheck, lint, format:check, check:i18n green; affected unit/web/integration suites above green (integration: 12 passed).

### Decisions

- **No new feature flag.** The line only adds text to screens already governed by the `LOCATION_CHANGE` policy row, state, capability, an enabled priced target and the limit; a flag could only let the line disagree with the button.
- Different limits per target: show the **largest** remaining toward any target (0 iff every target refuses on the limit); one unlimited target -> no line. The cooldown is not part of the figure. Latin digits («2 از 3») like every other customer template (OQ-R11-B4-01..03).
- Custom services / unknown location -> nothing.

### Migrations

None.
