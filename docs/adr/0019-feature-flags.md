# ADR-0019 — Feature flags: enabled is not configured

**Status:** Accepted. Implemented in Phase 2.

## The problem

The legacy system has three disjoint capability layers — 31 bot flags, 16 store
toggles, and a per-panel set — and "no capability name appears in two of them"
(CBR-005). Whether they are AND-ed at runtime is `UNK-BC-002`, and it is open.

Two findings matter more than the counts.

**A flag and its parameter live on different screens.** `⚠️ اعلان کاهش موجودی`
is the flag, in Bot Capabilities; `⚠️ مبلغ هشدار موجودی` is the threshold, one
menu up in General Settings (CBR-007). The consequence is recorded: the flag is
off, "so the setting is inert until the capability is enabled. A rebuild should
either grey the field out or say so on the screen" (GSR-008). The trial chain is
worse — four independent layers across three screens, and "setting a global
allowance does nothing on its own if no panel has `نمایش تست` enabled"
(GTL-BR-007).

**A toggle is not always a boolean, and sometimes there is no toggle at all.**
CBR-011 finds four shapes: scalar, menu of scalars, subsystem, and CRUD
collection, and concludes that "modelling capabilities as a flat
`map[string]bool` cannot represent" three of them. Meanwhile forced-join has no
flag whatsoever — "it is enabled by adding at least one channel and can be
disabled only by removing every channel. There is no toggle" (GSR-004).

And the flag surface itself is undifferentiated: the **whole-bot kill switch**
is rendered identically to the dice toggle (CBR-009).

## Decision

### Two registries, not one

A **feature flag** answers exactly one question: is this feature on for this
tenant. Its stored value is a boolean column, and the schema gives it nowhere
else to put anything — no JSON blob in the flag row, no nested configuration, no
fourth shape.

A feature's **configuration** lives in the settings registry (ADR-0017), which
already has schemas, defaults, validation and declared zero semantics. CBR-011's
four shapes are settings shapes; making the flag row hold them is what produces
a `Map<string, any>` by another name.

### The chain is declared, so it can be shown in one place

A `FeatureFlagDefinition` names the settings that parameterise it; a
`SettingDefinition` names the flag it belongs to. The link is declared in the
frozen contracts and asserted symmetric by a test, so the two halves cannot
drift apart the way `اعلان کاهش موجودی` and `مبلغ هشدار موجودی` did.

The surface uses it directly: reading a flag returns the flag **and its
configuration**, so an operator sees the whole chain rather than discovering
half of it two menus away. A setting whose flag is off is returned marked
inert — GSR-008 asked for exactly this ("either grey the field out or say so on
the screen"), and saying so is the honest half of that pair.

### Every gate has an explicit flag

Forced-join's "enabled by having rows" is not reproduced. A feature is on
because its flag says so, never because a collection happens to be non-empty. An
emergent enable state cannot be audited, cannot be turned off without deleting
data, and cannot be explained to the person looking at the screen.

### A flag exists only when its feature does

A registered flag means the code behind it is written and reachable. Phase 2
therefore registers few flags, and none for Phase 3 through 8 features.

Publishing `payments.enabled` today would put a switch on an administrator's
screen that turns nothing on, which is worse than the feature being absent: an
absent feature is understood, and a switch that does nothing is a bug report.

### High blast radius is handled at the surface, not with a permission

The kill switch is the case the legacy system got visibly wrong, and the fix is
not a separate permission. A flag declares its `blastRadius`, and a flag marked
`TENANT_WIDE` requires the explicit confirmation protocol of ADR-0010 — the
operator states what they are turning off, and the audit row records the reason.
`settings.destructive` is not a "more powerful settings" permission and is not
used here.

## Rejected

**One registry for flags and settings, with a boolean-typed setting for the
flag.** It reads well and then loses the distinction the whole ADR is about: the
UI can no longer tell "off" from "configured to zero", which is the exact
confusion `UNK-GS-004` records in the legacy system.

**Modelling the three legacy layers.** `UNK-BC-002` is open and stays open. Nexa
has one layer per feature, scoped to the tenant. If a per-panel or per-bot layer
turns out to be needed, adding a narrower scope to an existing flag is additive;
building three speculative layers now would bake in an AND we cannot evidence.

**Flag values as JSON.** Named because it is the obvious shortcut, and because
CBR-011's four shapes make it tempting. The Phase 2 brief rules it out and the
schema enforces it.

## Revisit when

- `UNK-BC-002` is answered, or a real feature needs per-panel gating.
- A flag needs a scheduled or percentage rollout. Neither exists in a
  single-installation product today, and both would be a new column rather than
  a new model.
