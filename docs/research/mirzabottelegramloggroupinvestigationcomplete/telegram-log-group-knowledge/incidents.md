# Incidents & safety log — Telegram log-group phase

## Mutations performed
**ZERO.** Specifically, in this phase I did **not**:
send a message · reply · react · edit · delete · pin · unpin · forward ·
create / rename / delete a Topic · change any group setting · add or remove a member ·
change permissions · run a bot command · press **any** inline button ·
download, open, decrypt, restore or upload any backup · copy any credential or token.

Navigation between topics used a synthetic `MouseEvent` dispatched on the topic-list
anchor (`a[data-thread-id]`) — a read-only view switch, identical to clicking the topic
in the sidebar. Scrolling loaded older history. Nothing else was interacted with.

## Redactions applied to this knowledge base
- No bot token appears anywhere.
- The customer crypto wallet address is stored only as `WALLET_ADDRESS_REDACTED`.
- Panel hostnames, panel credentials and stack-trace secrets: none reproduced.
- Customer identifiers: numeric ids and usernames appear only where they were structurally
  necessary to demonstrate a **format** (e.g. that `کد پیگیری` equals the config suffix).
  All template documentation uses placeholders.
- Backup contents: `NOT_INSPECTED_FOR_SECURITY` throughout.

## Tooling incidents
| # | Incident | Effect | Handling |
|---|---|---|---|
| 1 | Telegram Web virtualises the message list; a JS-only read returns stale bubbles. | Under-counted families. | Interleaved real `computer scroll` actions before every read. |
| 2 | Setting `scrollTop = 0` did not trigger older-history loading. | History appeared to stop at "today". | Used real wheel-scroll events over the message column (x≈670), which does trigger the loader. |
| 3 | `location.hash` navigation does not switch forum topics in Telegram Web K. | Could not jump topics by URL. | Synthetic `MouseEvent` dispatch on `a[data-thread-id]` (`window.__click`). |
| 4 | `innerText` silently drops emoji. | Would have lost every `📌`/`⭕️`/`💵` marker, i.e. the family discriminators. | Custom walker resolving `img.alt` (`window.__T`). |
| 5 | `claude-in-chrome` MCP timed out repeatedly (60 s) mid-phase, during the 🎁 پورسانت re-sample. | Re-sampling of the commission topic could not be extended. | Reported to the owner and asked for a tab refresh; the commission topic's template was already captured earlier in the phase, so the knowledge base is complete for it, with volume noted as a single-day observation. |

## Known coverage limits (stated rather than papered over)
- History loading in each topic reached back 0.5–3.5 days depending on the topic; the
  error topic reached ~15 days. Counts in this knowledge base are therefore **rates**
  over the sampled window, not lifetime totals.
- `📣 یک ادمین رسید پرداخت را تایید کرد` was observed only as the pinned preview.
