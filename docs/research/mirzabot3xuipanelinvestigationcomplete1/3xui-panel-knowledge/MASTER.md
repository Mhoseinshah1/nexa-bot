# MASTER — 3X-UI Panel Investigation (TEST_3XUI_AUDIT)

**Phase**: 3X-UI panel creation + complete panel-management audit
**Date**: 2026-09-01, 05:18–05:34 (bot time)
**Bot**: [BOT_USERNAME_REDACTED] · Version Bot 7.5.10 · Mini App 0.1.2 · Bot Agent 1.3.14
**Authorized production change**: creation of ONE test panel with fake values. Nothing else.

## Result in one line

A 3X-UI panel was created against a provably unreachable host with a non-credential token and was
accepted without any validation; its entire management surface is the same as Marzban's except for
three things — a **token instead of username+password**, a **required subscription-link domain**, and
**no inactive-account handling**.

## Files

| File | Contents |
|---|---|
| `creation-flow.md` | 17 provider types, the 4-step 3X-UI wizard, the creation state machine |
| `panel-profile.md` | INITIAL_3XUI_BASELINE, the 24-button menu, the connection-failure UX |
| `menu-tree.md` | XUI-MENU-001…024, every button with prompt, type and result |
| `capabilities.md` | all 16 capabilities with meanings and confidence |
| `capability-baseline.md` | the 16 baseline states (12 OFF / 4 ON) |
| `connection-settings.md` | connection model, edit flow, the password/token anomaly |
| `inbound-protocol-settings.md` | the inbound/protocol model — the phase's highest-priority question |
| `3xui-specific-settings.md` | token, `دامنه لینک ساب`, and the provider-specific deltas |
| `pricing-settings.md` | the four per-panel price fields |
| `trial-settings.md` | trial hours / megabytes / gates |
| `visibility-settings.md` | four-gate visibility, `f`/`n`/`n2`/`all` |
| `service-settings.md` | renewal, username generation, limits, migration, cosmetics |
| `advanced-settings.md` | SOCKS proxy, config/subscription delivery, store relationship |
| `marzban-crossmap.md` | full row-by-row SAME/DIFFERENT/3XUI_ONLY/MARZBAN_ONLY comparison |
| `business-rules.md` | XUI-BR-001…015 |
| `panel-entity-model.md` | conceptual entity map with VERIFIED/INFERRED marks |
| `source-bugs.md` | 2 source bugs + 9 UX risks, all observed |
| `unknowns.md` | UNK-XUI-001…015 |
| `incidents.md` | investigation incidents (no state was changed) |
| `evidence-index.md` | message-id level evidence trail |
| `panel-monitoring.md` | the 3-minute panel ping loop and its admin alert (owner-sourced, code-only) |
| `progress.md` | what was done and what is blocked |

## Safety posture at the end of the phase

- TEST_3XUI_AUDIT **exists and was never deleted**.
- No capability toggled. No setting submitted. No option selected. No product or service created.
- The composer was used three times, all inside the authorized creation wizard.
- `❌ حذف پنل` was never pressed.
- Closing re-read at 05:49: **16/16 capabilities identical to baseline.**

## Open item for the owner

MirzaBot pings every panel every 3 minutes and alerts on failure (owner-confirmed, code-only —
`panel-monitoring.md`). TEST_3XUI_AUDIT points at an address that can never resolve, so it is a
permanently failing panel. Nothing was changed about it; the decision is yours.
