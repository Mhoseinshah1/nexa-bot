-- Drop `callback_refs`.
--
-- The table was created in 0000 with no code writing to or reading from it. The
-- decision it encoded is real and still stands — Telegram caps `callback_data`
-- at 64 bytes, so interactive keyboards carry a short opaque reference rather
-- than a UUID, and `IdGenerator.callbackRef()` and `callbackRefSchema` remain in
-- place for it. The storage lands with the conversation state machine in Phase 1,
-- when something actually writes a row.
--
-- Removed rather than kept because a table nothing touches is the placeholder
-- infrastructure this project set out to avoid. Expressed as a forward
-- migration rather than by editing 0000: applied migrations are never edited,
-- and that rule does not get an exception because the table happened to be new.

DROP TABLE "callback_refs" CASCADE;
