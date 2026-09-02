# ADR-0017 — The settings registry

**Status:** Accepted. Implemented in Phase 2.

## The problem

The legacy system's configuration is a set of screens rather than a model, and
the corpus records four consequences.

**Settings are write-only.** Seven of twelve nested settings screens never print
the value they are about to replace (BC-SB-003). The finding states it exactly:
"an admin cannot read the current configuration without overwriting it… it
converts a read into a write." The forced-join channel list is sharper still —
the only screen that lists the channels is the **delete** flow (GSR-006), so
reading requires entering a destructive path.

**A prompt swallows the next message, whatever it is.** Pressing a settings
button puts the session into "awaiting value" and the next text becomes the
value, with no Save step and no confirmation (CBR-012). That is the mechanism
behind INCIDENT-FIN-001, where a typed **menu label** was consumed as the value
and overwrote a production tutorial text. Nothing was recoverable, because the
old value had never been readable in the first place.

**`0` means whatever the screen decides.** Two settings in the whole product
document their zero semantics (`0 = غیرفعال`). Elsewhere `0` means unlimited
(discount lifetime, user limit), or "this eligibility condition does not apply"
(gateway rules), or is simply unknown (`UNK-GS-004`, `UNK-GTL-006`).

**A success message does not mean a write happened.** SOURCE_BUG-002: three
repair attempts on a corrupted product all answered `✅ … بروزرسانی شد` and
changed nothing.

## Decision

### A typed registry, not a key-value dump

Every setting is declared in `@nexa/contracts` as a `SettingDefinition`:

| Field            | Why it is mandatory                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `key`            | Stable, dotted, machine. Never a caption.                                                                   |
| `description`    | What it controls, in one sentence.                                                                          |
| `schema`         | A zod schema. The value is parsed, not coerced.                                                             |
| `defaultValue`   | Parsed by the same schema at module load, so a malformed default cannot ship.                               |
| `zeroMeaning`    | What `0`, empty or absent means **for this key** — `DISABLES`, `UNLIMITED`, `LITERAL`, or `NOT_APPLICABLE`. |
| `mutability`     | `RUNTIME` or `RESTART_REQUIRED`. Declared only where it is genuinely true.                                  |
| `classification` | `PUBLIC` or `SENSITIVE`. There is no `SECRET`: see below.                                                   |
| `configures`     | The feature flag this setting parameterises, when there is one. Empty otherwise.                            |

`SETTING_KEYS` is a union of literals. A key that is not in the registry is not
readable, not writable and not storable — **unknown keys fail closed** at the
schema, at the service and at the HTTP surface, and a test asserts all three.

There is deliberately no `Map<string, unknown>` anywhere in this design. A
setting that is not declared does not exist.

### Every setting is readable, with its source

A read returns the value, the **resolved source** (`DEFAULT` or `TENANT`), the
definition, and the declared meaning of zero. This is what
`docs/conventions.md` § "Settings are readable" has been asking for since
Phase 0, where its "Enforced by" line read _"Nothing yet; no settings surface
exists."_ It now reads otherwise.

`zeroMeaning` is a required field precisely because the legacy system's two
best-documented settings are the two that state it. Making it optional would
reproduce the defect for every author who forgot.

### A write states what it expects to replace

Every write carries the `version` the caller read. A mismatch is a conflict, not
a last-writer-wins overwrite (ADR-0021). The response is the **persisted** row
re-read inside the transaction, so "saved" cannot be reported for a write that
did not change anything; a no-op write says it was a no-op.

### Secrets are not settings

The registry has no `SECRET` classification and no encrypted setting value. A
credential — a bot token, a panel password, a gateway key — belongs in a table
that is envelope-encrypted, never returned by an API and never logged; that
mechanism already exists for `bot_instances.token_ciphertext`. `SENSITIVE` marks
values that are not credentials but should not be broadcast, such as an
operations chat id; they are still fully readable through the settings surface.
A unit test asserts that no registry entry's key or description matches the
credential vocabulary, so the boundary is checked rather than remembered.

### `settings.destructive` stays unused in Phase 2

`settings.destructive` exists in the catalogue for operations whose blast radius
is a bulk mutation — the legacy `🗑 بهینه سازی ربات`, which deletes six order
classes on one press with no count, no dry run and no undo, is the archetype.
Phase 2 has no such operation, so no Phase 2 setting requires that permission.

Inventing one to exercise the permission would be building a destructive
operation for the sake of a test, which is a strange thing to want.

### Deployment configuration is not tenant configuration

Two distinct things, kept apart:

- **Environment configuration** — `DATABASE_URL`, `SESSION_TTL_SECONDS`, the
  login-throttle bounds, the KEK. Read at boot, validated by the config schema,
  identical for every tenant in the installation, and not editable at runtime.
- **Settings** — tenant-scoped operational configuration an administrator may
  change while the process runs.

A value belongs in the environment when changing it changes the process's
security posture or its startup contract. A value belongs in the registry when
an operator should be able to change it on a Tuesday afternoon.

The tenant row's `locale`, `display_timezone`, `calendar` and `currency` stay on
the tenant row and are **not** mirrored into the registry. Two sources of truth
for one value is how the legacy web total and Telegram total came to differ by
38%.

## Rejected

**A generic settings table with a free-form key.** It is the shape that makes
every other defect above possible: nothing to validate against, nothing to
default from, nothing to describe, and no way to answer "what does `0` mean".

**Storing the default in the tenant's row.** Same reasoning as templates
(ADR-0016): a tenant that has never changed a value should follow the default
when the default improves.

**An `is_default` boolean instead of an absent row.** Absence is already the
answer, and a boolean that can disagree with the value beside it is a bug
waiting for a migration.

## Revisit when

- A setting genuinely needs a per-bot-instance value. `UNK-BC-003`,
  `UNK-GTL-005` and `UNK-GS-010` are all open on exactly this, and all three
  fallbacks are "tenant-scoped, inheritance made explicit". Adding
  `bot_instance_id` narrows the scope and is additive.
- A destructive maintenance operation exists. Then `settings.destructive` gets
  its first real user, and ADR-0010's protocol applies to it.
