# A4 delta a: tutorial video and guide in one message (falsification)

Item: pre-support remaining fixes audit, section 2, "A4", delta a only. No schema or
contract change. Delta b (button toggles and per-app titles) is out of scope.

## The rules

1. A client app's tutorial video is the screen's own message (`PendingReply.media`, kind
   `VIDEO`). The guide is its caption and the buttons sit on it, in ONE `sendVideo`.
2. The caption is sent with the messenger's existing `captionWhole` flag, the same
   whole-or-nothing measure of the RENDERED caption that the referral invite's photo lead
   uses. Nothing in the runtime measures length a second time.
3. Over the bound (`REFUSED` / `CAPTION_OVER_BOUND`, decided before any request), the video
   goes bare and the guide follows as today's text message with the buttons.
4. Any other refusal of the video: the guide still goes out as text with its buttons.
5. The captioned video's UNKNOWN or RATE_LIMITED outcome sends nothing more (the
   `PendingReply.media` rule). The BARE video's outcome decides nothing: the guide follows it
   whatever happened to it.
6. A tap on a FILE message (a photo, a document, a video, or anything with a caption) is never
   answered with `editMessageText`. `cardMessageOf` reads the tapped message from the raw
   update through `callbackOriginOf`, which now also counts a `video` as a file. The screen
   goes out as a new message. Before this, «سرویس‌ها» or «لینک اشتراک» on the captioned video
   spent an `editMessageText` that Telegram answers with 400 "there is no text in the message
   to edit", and only then sent the screen.

## Tests

In `tests/integration/client-app-video.test.ts`, under "the customer's app screen: video and
guide (A4)":

- a short guide: exactly one `sendVideo`, with the guide as its caption and the buttons on it;
- a guide that is under 1024 by itself but whose RENDERED caption is over: the bare video,
  then the text with the buttons;
- a long guide: the video, then the whole guide as text, never a cut caption;
- Telegram refuses the video: the guide still goes out as text, with its buttons;
- no video: today's single text message, unchanged;
- a captioned video whose outcome is UNKNOWN (5xx), or that is RATE_LIMITED: `sendVideo`
  alone, and the turn reports that outcome;
- a long guide whose bare video is refused, or answered 5xx: the guide still goes as text,
  `DELIVERED`, with the buttons;
- a button tapped on the captioned video (`sl:1`): one `sendMessage`, no `editMessageText`.

In `tests/unit/r2-wizard-state.test.ts`: a bare video message is a file message.

Changes to the fixture (`tests/integration/receipt-review-fixture.ts`):

- `REFUSE_FILE` now refuses `sendVideo` as well as `sendPhoto` and `sendDocument`. Its 403
  stands for any definite refusal; a real bad `file_id` gets a 400, and the messenger
  classifies both as REFUSED.
- A new mode, `SERVER_ERROR_FILE`, answers 5xx to the file methods only.
- The stand-in now answers `editMessageText` on a message that `tapOn` declared a file
  message with the real 400 "Bad Request: there is no text in the message to edit". The fake
  was corrected to match the real Telegram rule in the same commit.

## Mutation results

Run with `python3 scripts/mutate-a4a.py` (needs your own `TEST_DATABASE_URL`):

| Mutant | Rule reverted                                                   | Result | Test that failed                             |
| ------ | --------------------------------------------------------------- | ------ | -------------------------------------------- |
| A4A-01 | the app screen omits `captionWhole`                             | KILLED | a long guide … never a cut caption           |
| A4A-02 | the app screen ignores its video                                | KILLED | a short guide: exactly ONE sendVideo         |
| A4A-03 | the runtime does not pass `captionWhole` on to the messenger    | KILLED | RENDERED caption is over 1024                |
| A4A-04 | no bare video when the caption is over the bound                | KILLED | a long guide … never a cut caption           |
| A4A-05 | a bare video is re-sent on ANY refusal, not only over the bound | KILLED | Telegram refuses the video                   |
| A4A-06 | no text fallback when the video is refused                      | KILLED | Telegram refuses the video                   |
| A4A-07 | the buttons are dropped from the captioned video                | KILLED | a short guide … buttons on it                |
| A4A-08 | text fallback on any non-DELIVERED outcome, not only REFUSED    | KILLED | UNKNOWN / RATE_LIMITED: nothing more is sent |
| A4A-09 | the turn stops when the bare video is not delivered             | KILLED | a long guide whose bare video is refused     |
| A4A-10 | the bare video's non-DELIVERED outcome becomes the turn's       | KILLED | … the bare video is decorative               |
| A4A-11 | `cardMessageOf` targets a file message                          | KILLED | no editMessageText on a file message         |
| A4A-12 | `callbackOriginOf` does not count a bare video as a file        | KILLED | (unit) with its file-ness                    |

12 of 12 killed (re-run after the PR #207 review fixes).

## Behaviour change to note

The captioned video now follows `PendingReply.media`'s rule: the text fallback is sent only
when the video is definitely REFUSED. If the video's outcome is UNKNOWN or RATE_LIMITED, the
guide is not sent again. It may already have arrived as the caption, and a second copy would be
a duplicate. Before this change, the bare video was decorative and the text always followed.

An UNKNOWN or RATE_LIMITED video on this screen raises no operator signal. Nothing opens the
send-failure condition, the same as for a receipt review reply sent as a file
(`TelegramCustomerMessenger.sendFile`). The customer can tap the app again. Recorded as
`OQ-A4-01` in `docs/open-questions.md`.
