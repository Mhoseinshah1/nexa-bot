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

## Tests

In `tests/integration/client-app-video.test.ts`, under "the customer's app screen: video and
guide (A4)":

- a short guide: exactly one `sendVideo`, with the guide as its caption and the buttons on it;
- a guide that is under 1024 by itself but whose RENDERED caption is over: the bare video,
  then the text with the buttons;
- a long guide: the video, then the whole guide as text, never a cut caption;
- Telegram refuses the video: the guide still goes out as text, with its buttons;
- no video: today's single text message, unchanged.

The fixture's `REFUSE_FILE` mode now refuses `sendVideo` as well as `sendPhoto` and
`sendDocument`.

## Mutation results

Run with `python3 scripts/mutate-a4a.py` (needs your own `TEST_DATABASE_URL`):

| Mutant | Rule reverted                                                   | Result | Test that failed                     |
| ------ | --------------------------------------------------------------- | ------ | ------------------------------------ |
| A4A-01 | the app screen omits `captionWhole`                             | KILLED | a long guide … never a cut caption   |
| A4A-02 | the app screen ignores its video                                | KILLED | a short guide: exactly ONE sendVideo |
| A4A-03 | the runtime does not pass `captionWhole` on to the messenger    | KILLED | RENDERED caption is over 1024        |
| A4A-04 | no bare video when the caption is over the bound                | KILLED | a long guide … never a cut caption   |
| A4A-05 | a bare video is re-sent on ANY refusal, not only over the bound | KILLED | Telegram refuses the video           |
| A4A-06 | no text fallback when the video is refused                      | KILLED | Telegram refuses the video           |
| A4A-07 | the buttons are dropped from the captioned video                | KILLED | a short guide … buttons on it        |

7 of 7 killed.

## Behaviour change to note

The captioned video now follows `PendingReply.media`'s rule: the text fallback is sent only
when the video is definitely REFUSED. If the video's outcome is UNKNOWN or RATE_LIMITED, the
guide is not sent again. It may already have arrived as the caption, and a second copy would be
a duplicate. Before this change, the bare video was decorative and the text always followed.
