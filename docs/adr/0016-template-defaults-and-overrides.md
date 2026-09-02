# ADR-0016 — Template defaults, tenant overrides and revisions

**Status:** Accepted. Implemented in Phase 2.

## The problem

A customer-facing message has to be editable by an administrator without any of
the four ways the legacy system got this wrong:

1. **The caption is the identifier.** Renaming a button renames its key, so
   nothing can reference a message stably.
2. **The edit screen shows the rendered string.** `{first_name}` resolves in the
   viewing admin's own context, so the raw template cannot be read back from the
   screen that edits it, and saving from that view would store the editor's own
   name as the template body (TBR-TXT-004 — the rendering is observed, the
   consequence is a hazard that was deliberately never tested; see `C-TXT-BAKED`).
3. **There is no restore.** The Telegram surface has no reset and no default;
   only the web surface stores a default per key and offers a revert
   (WEB-BR-019). That is the one thing the legacy system got right here.
4. **Placeholders are unvalidated and overloaded.** `{time}` means "now" in one
   template and "service duration" in another; `{Volume}` and `{volume}` are two
   spellings of one concept; units are typed into the copy, so one card-to-card
   template says تومان where its twin says ریال for the same `{price}`.

## Decision

### A key is a contract; a body is data

`TEMPLATES` in `@nexa/contracts` declares every key, its description and its
placeholders. `TemplateKey` is a union of literals, so an unregistered key is a
compile error on the server and a 404 at the surface. Nothing resolves a key
that is not in the catalogue — **unknown keys fail closed**.

The **default body** for each key lives in `@nexa/i18n`, per locale. A tenant may
**override** the body. It may never add a key, remove a key, or change a key's
declared placeholders.

### Three storage rules

- A tenant override stores **raw source**, exactly as typed. There is no code
  path that writes a rendered string into `template_overrides.body`; the
  renderer is a pure function whose output is returned to the caller and never
  persisted.
- **Reverting removes the override.** It does not copy today's default into
  tenant storage. A tenant that reverts and is later shipped an improved default
  gets the improved default — which is the entire point of having one.
- **Revision history survives the revert.** `template_revisions` is append-only
  and records the revert itself as a revision, so the body that was in force
  yesterday is still readable tomorrow.

`template_overrides` holds current state (one row per `(tenant, key)`, carrying
a `version`); `template_revisions` holds the history. Both are written in the
same transaction. They are not redundant: the override row is what the renderer
reads on every message, and a history table is the wrong shape for that read.

### Revisions are not the audit log

The audit log records **who changed what**, is redacted, and is governed by a
retention policy. `template_revisions` holds **the content itself**, is a product
feature (list revisions, read a previous body), and is retained for as long as
the tenant exists. Both rows are written for one edit. Collapsing them would
either put un-redacted product content under a log retention policy, or make the
audit log a content store.

### Placeholder syntax is narrow on purpose

A placeholder is `{` followed by an ASCII identifier (`[A-Za-z_][A-Za-z0-9_]*`)
followed by `}`. Anything else between braces is literal text.

That line is drawn where it is because of `اشتراک رایگان {تست}` — a live legacy
caption in which the braces are **decoration, not a token**. The corpus states it
plainly: "a substitution engine that treats every `{…}` as a variable would erase
this caption" (C-TXT-009). Restricting token syntax to ASCII identifiers keeps
that caption intact while still letting validation be strict about the things
that really are tokens.

### Validation rejects, it does not repair

Saving an override is refused when the body:

- uses a token-shaped placeholder the key does not declare (a typo such as
  `{first_nam}` is a rejection, never a literal that ships to customers);
- omits a placeholder the key declares as **required**;
- repeats a placeholder that the key declares as single-use;
- supplies a value whose type does not match the declaration at render time.

Placeholders are validated **per key**, never against a global vocabulary. That
is a direct consequence of `{time}` meaning two different things in two legacy
templates: a global vocabulary would have to pick one meaning and would be wrong
half the time.

### Money is never a bare number

A `MONEY` placeholder takes an amount in minor units and an explicit currency,
and is rendered by the single formatter in `@nexa/i18n`. A template author
cannot type a unit into the copy, which is what let one legacy card-to-card
template say تومان where its twin said ریال for the same `{price}`.

### Preview is an explicit, separate call

Rendering for preview takes **caller-supplied sample values** and returns a
result that is never written anywhere. The edit field is populated from the raw
body and from nothing else. There is deliberately no code path that can put a
rendered string where a raw one belongs.

### The catalogue grows with its emitters

Phase 2 does not harvest a catalogue from the research. Two reasons, both from
the corpus rather than from taste:

- The size of the legacy store is itself unresolved — 608 keys or more than
  1,000 across 40 groups, depending on which VERIFIED_BY_UI reading you take
  (`C-TXT-COUNT`).
- "A template's existence proves nothing about whether the feature is enabled"
  (TBR-TXT-010/011): three well-maintained legacy templates serve paths nobody
  walks. A harvested catalogue would import a feature list we have not built,
  and would advertise features to administrators that do not exist.

So a key is added in the phase that sends it. `UNK-TXT-004/005` — how the 36
Telegram-editable texts map to the web ones — stays open and stays irrelevant,
because nothing here is derived from that mapping.

## Permissions

Templates use **`templates.view`** and **`templates.edit`**, which this ADR adds
to the frozen catalogue. Settings use `settings.view` and `settings.edit`.

This is a deliberate addition and not a convenience. The permission catalogue's
own rule is that "deliberately separate keys exist where the blast radius
differs", and these two blast radii are not comparable: changing a setting
alters how the installation behaves for its operators, while changing a template
alters the words sent to every customer of the tenant. Separating them also lets
a role edit copy without holding any configuration access at all, which is an
ordinary operational split rather than a hypothetical one.

`templates.edit` is HIGH risk; `templates.view` is LOW.

**If you disagree, this is cheap to reverse.** Roles are data, the seeds are one
file, and the change is a rename plus a reseed — that was the whole point of
modelling roles as compositions rather than as an enum.

## Rejected

**Storing the rendered body and re-parsing it.** This is what the legacy system
effectively does, and it is unrecoverable: once `{first_name}` has become a
name, no amount of parsing gets the token back.

**Copying the default into tenant storage on first edit.** It makes "has this
tenant customised this key" unanswerable, and freezes every tenant at the
default that happened to be current when they first opened the screen.

**One global placeholder vocabulary.** Ruled out by `{time}`.

**Reusing `settings.edit` for templates.** Considered seriously, because the
Phase 2 brief warned against adding permissions. Rejected on blast radius, and
recorded here so the decision can be argued with rather than discovered.

## Revisit when

- A second locale exists. Overrides are per `(tenant, key, locale)` from the
  first migration, so this is a data question rather than a schema change.
- Templates need per-bot-instance overrides. `UNK-TXT-009` (per-bot or shared
  across reseller sub-bots) is open; the tenant-scoped model narrows later by
  adding a column, which is additive.
