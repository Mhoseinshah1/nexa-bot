# Phase 2 item 5 — falsification record

Item: the optional tutorial a panel sends once after a paid or trial delivery
(`docs/phase2/item5-delivery-tutorial.md`). Driver: `scripts/mutate-p2-item5.py`. Each mutation
reverts one rule, runs the named test, and restores the file byte for byte (contract mutants
rebuild `@nexa/contracts` before the run and after the restore, because the tests resolve its
dist). A mutant counts as killed only if the named test RAN and failed. Run on 2026-10-06
against a dedicated integration database (`nexa_test_p2d`).

| ID    | Rule reverted                                                                                   | Test that failed                                                                                  | Result |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| D5-01 | DISABLED sends nothing although it keeps its text (gate removed, kept text treated as sendable) | sends nothing for a DISABLED tutorial, though its text and video are kept (unit)                  | KILLED |
| D5-31 | The same, end to end                                                                            | a DISABLED tutorial, or none, sends nothing extra (integration)                                   | KILLED |
| D5-02 | A purchase-only tutorial is not sent for a trial (applicability ignored)                        | a purchase-only tutorial is sent for a paid service and not for a trial (unit)                    | KILLED |
| D5-03 | Trial and purchase applicability are not swapped                                                | a trial-only tutorial is sent for a trial and not for a paid service (unit)                       | KILLED |
| D5-04 | The same, end to end, after a real trial delivery                                               | a trial delivery is followed by a trial-only tutorial; a paid one is not (integration)            | KILLED |
| D5-05 | A claimed service sends nothing (the claim's answer ignored)                                    | claims the service in the WORKER namespace BEFORE sending, and a replay sends nothing (unit)      | KILLED |
| D5-06 | The claim is keyed by the service, not one key for all                                          | each service gets its own tutorial: the claim is keyed by the service (unit)                      | KILLED |
| D5-07 | Tenant activity is read inside the claim's transaction                                          | a stopped tenant: nothing claimed, nothing sent (unit)                                            | KILLED |
| D5-08 | VIDEO_TEXT's caption is whole-or-nothing (`captionWhole` dropped)                               | VIDEO_TEXT that fits: ONE video with the text as its whole caption (unit)                         | KILLED |
| D5-09 | Too long for a caption: the bare video is still sent                                            | VIDEO_TEXT too long for a caption: the bare video, then the text whole (unit)                     | KILLED |
| D5-10 | Too long for a caption: the text follows whole                                                  | VIDEO_TEXT too long for a caption: the bare video, then the text whole (unit)                     | KILLED |
| D5-11 | UNKNOWN / RATE_LIMITED are not followed by the text                                             | VIDEO_TEXT answered UNKNOWN is neither retried nor followed by the text (unit)                    | KILLED |
| D5-12 | A video Telegram refuses still lets the text go                                                 | VIDEO_TEXT whose video Telegram refuses: the text still goes, once (unit)                         | KILLED |
| D5-13 | Nothing this bot can send: no claim, no send                                                    | VIDEO whose bot holds no video sends nothing, and claims nothing (unit)                           | KILLED |
| D5-14 | The text is drawn by the client-app guide renderer                                              | draws the text with the client-app guide renderer (bullets, links) (unit)                         | KILLED |
| D5-15 | The text goes through `bot.service.delivery_tutorial` (made `bot.faq.page`)                     | the template is the text whole: the catalogue body is `{text}` (unit, premium)                    | KILLED |
| D5-16 | Never for a rotation's new link                                                                 | never for a rotation's new link (unit)                                                            | KILLED |
| D5-17 | The tutorial comes after the files, not before                                                  | after the files, for the FIRST delivery it recorded (unit)                                        | KILLED |
| D5-18 | A tutorial that throws is swallowed by the sweep                                                | a tutorial that throws changes nothing in the sweep (unit)                                        | KILLED |
| D5-19 | The container wires the sweep to the sender                                                     | a paid delivery is followed by the tutorial, once, after the link (integration)                   | KILLED |
| D5-20 | The claim is the idempotency store's durable insert (a re-armed delivery)                       | a paid delivery is followed by the tutorial, once, after the link (integration)                   | KILLED |
| D5-21 | A stale revision is refused (explicit check removed)                                            | keeps the text through a switch to DISABLED, and refuses a stale revision (integration)           | KILLED |
| D5-22 | A write is audited with its values                                                              | starts DISABLED with nothing stored, and saves, audits and replays a write (integration)          | KILLED |
| D5-23 | A newly named video app must be this tenant's                                                   | refuses a video app that is not this tenant's, and markup in the text (integration)               | KILLED |
| D5-24 | Every repository read names the tenant                                                          | is tenant-scoped: another tenant can neither read nor write this panel's tutorial (integration)   | KILLED |
| D5-25 | The video options count the bots holding the video                                              | VIDEO_TEXT sends the delivering bot's client-app video with the text as its caption (integration) | KILLED |
| D5-26 | Contract: raw markup (`<tg-emoji>`) is refused                                                  | refuses raw markup (<tg-emoji>) and an unknown icon marker; accepts a known one (unit)            | KILLED |
| D5-27 | Contract: an unknown `{icon:…}` marker is refused                                               | refuses raw markup (<tg-emoji>) and an unknown icon marker; accepts a known one (unit)            | KILLED |
| D5-28 | Contract: a mode that sends text needs the text                                                 | refuses a mode without what it sends (unit)                                                       | KILLED |
| D5-29 | Web: the draft refuses a mode without its text                                                  | refuses a draft without what its mode sends, and sends nothing (web)                              | KILLED |
| D5-30 | Web: a partial edit keeps the text the mode does not use                                        | shows what is stored and sends a partial edit whole, keeping the text and video (web)             | KILLED |

31 of 31 killed.

## What the first run found

- **D5-01 survived as first written** (only the `mode === 'DISABLED'` gate removed). It was an
  equivalent mutant: DISABLED sends neither text nor video, so the sender already had nothing
  to send. The gate is kept as defence in depth, and the mutant now reverts the RULE — a
  DISABLED tutorial's kept text is never sent — which both the unit and the integration test
  kill (D5-01, D5-31).
- **D5-21 survived**: the conditional UPDATE refuses a stale change by itself, so only a stale
  NO-OP distinguished the explicit revision check. A stale save that would change nothing is now
  asserted to be refused too.
