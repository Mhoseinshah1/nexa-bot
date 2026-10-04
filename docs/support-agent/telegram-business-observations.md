# Telegram Business — observed behaviour

The record the TB acceptance runs write into. Per the real-panel lesson in `CLAUDE.md`, a
fake this repository wrote and an adapter this repository wrote can only prove they agree
with each other. Telegram's behaviour is what is written here, observed on a real Business
account, and it **overrides** `tb0-audit.md` §1 wherever the two disagree.

**Status: no observation recorded yet.** Pending a staging Business account. The checklist
is in `tb1-business-transport.md` (TB1) and grows with each package.

| #   | Question                                                             | Open question | Observed | Date | Bot API version | Evidence |
| --- | -------------------------------------------------------------------- | ------------- | -------- | ---- | --------------- | -------- |
| 1   | Does a reconnect keep `BusinessConnection.id`?                       | OQ-TB-02      | —        | —    | —               | —        |
| 2   | Does a disconnect arrive as `is_enabled: false`?                     | OQ-TB-02      | —        | —    | —               | —        |
| 3   | Does a message the owner types by hand arrive as `business_message`? | OQ-TB-03      | —        | —    | —               | —        |
| 4   | Does this bot's own send echo back, carrying `sender_business_bot`?  | OQ-TB-03      | —        | —    | —               | —        |
| 5   | Is an away or greeting message marked `is_from_offline`?             | —             | —        | —    | —               | —        |
| 6   | Which error does a send outside the 24-hour window return?           | U7            | —        | —    | —               | —        |
| 7   | Does `getFile` work on media from a `business_message`?              | OQ-TB-05      | —        | —    | —               | —        |
