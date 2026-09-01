# Incidents — Web Admin v2

## No production state was changed.

Every action taken was one of: a URL navigation (GET), a DOM read, or a screenshot.
- **No form was submitted.** No Save, Create, Add, Update, Apply, Confirm, Import or Execute button was
  pressed anywhere, on any of the 27 pages.
- **No checkbox, radio, select or text input was altered** — every value recorded was read as-is.
- **No delete was triggered.** Every `confirmDelete(...)` and every `حذف` control was recorded from its
  `onclick` attribute without being clicked.
- **`حالت پیشفرض` on `/settings/keyboard/` was deliberately not pressed** — it is the control that
  caused the previous investigation's incident, it still has no confirmation dialog, and its handler is
  JS-bound so its behaviour cannot be inspected without triggering it.
- The nine `theme-card` buttons on every page were classified **AUTO_SAVE_RISK** and not pressed: they
  carry a `selected` class, sit in no form and have no Save button, so they almost certainly persist on
  click.
- `/subscriptions/extend/313/` (a billing action against the tenant's own MirzaBot licence) was recorded
  from its href and not followed.

## Method notes
- Telemetry-free extraction: page structure and Chart.js series were read through `Chart.getChart(id)`
  and DOM walks that resolve `<img alt>` for emoji.
- One safety filter in the harness redacted a few values it mistook for tokens (dot-separated template
  keys, base64 form actions and CSRF values). Where that happened it is stated in place rather than
  papered over.
- Real customer PII was minimised throughout: leaderboard-style identities, subscription tokens and
  panel credentials for production panels were not recorded. The one credential reproduced
  (`audit_test_token`) is the fake value this investigation itself created in an earlier phase.
