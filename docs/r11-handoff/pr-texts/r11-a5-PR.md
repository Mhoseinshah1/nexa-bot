## R11 A5 — Telegram Bot API 10.2 compatibility

### What changed

1. **Unknown update kinds.** `telegramUpdateSchema` (packages/contracts/src/http.ts) requires only an integer `update_id` and is `.passthrough()`; the webhook (`apps/api/src/surfaces/telegram/webhook.controller.ts`) routes by the presence of keys it knows (business, Stars, ops group, `/ping`, `message`/`callback_query` customer turn). A top-level key it does not know (Bot API 10.2 `subscription`, or any future kind) therefore matches no route: the route returns `{ok:true}` (Nest POST default, 201 — any 2xx stops Telegram's retries; unchanged), throws nothing, writes no ops event or log line, writes no idempotency row (a redelivery is ignored again), and reaches no handler. This was already true; it is now pinned by tests. Only change in code is a comment beside the schema (not a contract change). Unknown fields inside known updates are already tolerated (passthrough) and handed on untouched (tested).
2. **Mini App origin protection.** core.telegram.org was unreachable from the sandbox (DNS refused for WebFetch and curl), so the official text could not be read. Secondary sources (search snippets citing the Bot API changelog, 10.2, 2026-07-14) say: Mini App methods are blocked from origins other than the Mini App's original domain, enabled by default from 2026-07-20, opt-out via the @BotFather Mini App. Not guessed beyond that: recorded as **OQ-R11-A5-01** (what is established, what is not, how to close). Audit of the repo: the Mini App is one origin (`/miniapp/<botInstanceId>/`, same URL `setChatMenuButton` registers), renders no frame, never navigates its view elsewhere, calls only `ready/expand/openLink/openTelegramLink` from its own document, payment pages open via `openLink`. No code change was certain to be needed, so none was made; the single-origin property is pinned by a test. **OQ-R11-A5-02** notes `subscription` is ignored, not handled.

### Tests

- `tests/unit/telegram-unknown-update-kinds.test.ts` (7): subscription update; made-up future kind; unknown kind containing `message`/`from` keys; missing/non-integer update_id still refused; unknown fields inside a known update preserved; schema keeps unknown keys at any depth; schema rejects bad update_id. Asserts 2xx result, no handler/ops record/log call at any level.
- `tests/unit/miniapp-origin-protection.test.ts` (4): no iframe/frame/location navigation/anchor href in apps/miniapp/src; `window.open` only the two fallbacks in telegram.ts; CSP directives exactly script-src 'self' https://telegram.org and connect-src 'self'; no frame-src/child-src.
- Also green: business-webhook, telegram-stars-webhook, telegram-update-key (unit, 29 total with the new ones), `miniapp-surface` integration (23). typecheck, eslint on touched files, `format:check` clean.

| Mutation                                                   | Result                                           |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `telegramUpdateSchema` `.passthrough()` -> `.strict()`     | 5 of 7 red (ZodError)                            |
| `telegramFromOf` falls back to `from` of any top-level key | 2 red (unknown kind reached `botRuntime.handle`) |
| add `<iframe>` file under apps/miniapp/src                 | frame test red                                   |
| add an origin to CSP `connect-src`                         | CSP test red                                     |
| (Each restored; green again.)                              |

### Decisions

- Webhook status stays Nest's 201 (existing integration contract; a 2xx is what matters to Telegram).
- Unknown kinds write no idempotency row: nothing to dedupe, a replay is ignored again.
- No Mini App code change without the official text; no BotFather opt-out used or recommended.

### Migrations

None.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012oQ3P4LLkQ6BD3XRDpbPck
