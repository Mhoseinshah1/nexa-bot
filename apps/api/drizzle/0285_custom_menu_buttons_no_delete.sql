-- R10 D2 — owner-defined main-menu buttons: the DELETE guard on custom_menu_buttons.
--
-- Hand-written beside the generated 0283 (drizzle-kit does not model triggers). A button is
-- ARCHIVED, never deleted: published revisions of the main-menu layout name it by id, and a
-- keyboard already sitting in a customer's chat can still be tapped and must be answered
-- "unavailable" rather than "unknown". The trigger fires for every role, the table owner
-- included (the floor, as 0001's guards are); tests reset with TRUNCATE, which bypasses row
-- triggers by design.
--
-- Rollback: this release only ADDS (three tables and this trigger). The previous release neither reads nor writes any of them. A layout that
-- places a custom button is stored as `v: 2`; the previous release reads such a head as
-- "published unreadable" and draws the keyboard from the bot.main_menu projection (registry
-- buttons only, same order and visibility, no styles) — the documented degrade, recorded as
-- the operational event bot_menu.published_unreadable. A tenant that never places a custom
-- button never has a v2 value, so for it a rollback changes nothing.
CREATE TRIGGER custom_menu_buttons_no_delete
  BEFORE DELETE ON custom_menu_buttons
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
