# Incidents — Bot Text Management phase

## Result

**NO TEXT VALUE WAS MODIFIED.**
**NO RESET WAS EXECUTED.**
**NO DEFAULT WAS RESTORED.**
**NO PRODUCTION COPY CHANGED.**

Not one character was ever composed or sent to the bot during this phase.

## Method that made that true

1. **Navigation by button click only.** Every item was opened by clicking the real reply-keyboard
   button in the DOM. No menu label was ever typed — the mechanism behind INCIDENT-FIN-001 in the
   Financial phase, where a typed label overwrote a production tutorial text.
2. **Immediate exit.** After reading each edit prompt, the real `▶️ بازگشت به منوی قبل` button was
   clicked at once.
3. **State asserted around every probe.** The reply keyboard was read before and after: 2 buttons
   while an edit was open, 38 after backing out. Any deviation would have halted the phase.
4. **The composer was never focused or typed into** at any point.

A helpful property of the product itself: while a text is being edited, the 36-item list is
**replaced** by the two navigation buttons, so no adjacent item can be hit by accident.

## Final safety verification (§36)

Two already-inspected templates were re-opened at the end and compared to their first reading:

| Template | First read | Re-read | Result |
|---|---|---|---|
| `متن خاموش بودن ربات` | `❌ ربات خاموش است، لطفا دقایقی دیگر مراجعه کنید` | identical | **MATCH** |
| `⚖️ متن قانون` | 3-rule terms text | identical, character for character | **MATCH** |

State at the end of the phase: the 38-button text menu is showing, no edit prompt is active, the
composer is empty, and the bot is in a normal menu state.

## Buttons deliberately not pressed
None existed to avoid — there is no reset, restore-default or delete control anywhere in this
section. The only destructive action available is *sending a message*, which was never done.
