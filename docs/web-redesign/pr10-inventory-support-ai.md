# PR-10 item 1: before/after inventory — `/support-ai` configuration

Presentation only. The query, the mutation (`saveSupportAiConfig`, one whole-document `PUT /support-ai/config`), the contract
schema validation, `expectedVersion`, the idempotency key (`useSubmissionKey`), the stale-version banner and the permission
props are the page's own, unchanged. No endpoint was added.

**Decision (save body).** The endpoint requires the whole configuration (`supportAiConfigSaveSchema`: every field but three
optional limits is required), so «ذخیره» sends that one document: the loaded values with the changed fields applied over
them, exactly as before. Per-field dirty state decides the count, the row/section marks and when the bar shows; it does not
make a partial body, which the contract does not accept. There was no confirm dialog on this save; none was added.
«لغو» = the page's «بارگذاری دوباره» (loaded draft and loaded version). `useUnsavedChanges` guards leaving.

| Before                                                               | After                                                                                                                                                 |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Card with one long form; `dirty` = whole-document JSON compare       | Same card; kit `SettingsSection`s of `SettingRow`s; dirty per field (14 fields), a dot on a changed row, a count on a section                         |
| Mode radios + explain + consequence, warn banner entering AUTO       | Section «حالت»: one row, same radios and texts, same banner                                                                                           |
| Chain legend + hint, primary, fallbacks (add/remove), model picker   | Section «زنجیرهٔ ارائه‌دهنده‌ها» (hint as its description): one row with the same steps and buttons                                                   |
| Vision checkbox                                                      | `SwitchSettingRow` in the same section (same state, same label)                                                                                       |
| Preset banner + apply, topics, confidence, widening banner           | Section «موضوعات مجاز…» (hint as description): preset banner, topics row, confidence row (label + hint), widening banner                              |
| Advanced `Disclosure` with 7 numeric fields, ranges and hints        | Collapsed section «پیشرفته» (changed count visible when closed), one row per field with its label, hint and range, same inputs/ids                    |
| Tone textarea                                                        | Section «لحن»: one row, same textarea and limit                                                                                                       |
| Validation issues list, save error, `form-actions` «ذخیرهٔ پیکربندی» | One `StickySaveBar` «N تغییر ذخیره‌نشده — ذخیره / لغو» carrying the issues list and the save error; «ذخیره» stays disabled while invalid or no-topics |
| Stale banner + reload                                                | Unchanged, above the bar                                                                                                                              |
| Key `web.sai_save`                                                   | Removed (unused); the kit's `web.kit_settings_save` is the button                                                                                     |

Kit change: `StickySaveBar` gained an optional `saveDisabled` (the page's validation refuses the save).
