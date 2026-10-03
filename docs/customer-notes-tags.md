# Customer notes and tags (program §8, Phase A3)

Operator-only CRM metadata on a customer. Owner revision 15 ("no user tags") is
**reversed** by the owner's explicit order in program §8; the earlier absence tests
were rewritten deliberately, each citing §8.

## Tags

- **Identity.** A tag is a row of `customer_tags`; its `id` (UUIDv7) is what an
  assignment, the list filter and every event name. The label is editable text, so a
  rename changes no reference.
- **Duplicate-name policy.** A label is stored normalised (`normaliseCustomerTagLabel`:
  NFC, whitespace runs collapsed to one space, trimmed; a CHECK refuses anything else).
  Uniqueness is the partial unique index `customer_tags_active_label_key` on
  `(tenant_id, lower(label)) WHERE archived_at IS NULL` — case- and
  whitespace-insensitive, among ACTIVE tags, per tenant. The case folding is
  PostgreSQL's. Catalogue writes take a per-tenant advisory lock
  (`CUSTOMER_TAG_CATALOGUE_LOCK_CLASS`, "TG") so the clean refusal
  (`commerce.customer_tag_name_taken`) is decided one writer at a time; the index is the
  backstop and its violation maps to the same refusal.
- **Archive, never delete.** An archived tag stays on the customers that carry it, still
  filters the list, and is still named by the audit history. It cannot be NEWLY assigned
  (`commerce.customer_tag_archived`) — the assignment reads the tag `FOR SHARE`, which
  conflicts with the archive's UPDATE, so a racing archive is seen (proved with a real
  lock wait in `customer-crm.test.ts`). It can always be removed. Archiving frees its
  name; restoring re-enters the active uniqueness and is refused if the name was taken.
- **Colour.** Optional, and only one of the design system's semantic tones
  (`CUSTOMER_TAG_COLORS` = the kit's `Tone`; pinned both ways in
  `tests/web/customer-crm.test.tsx`; a CHECK in the database). Null is neutral.
- **Bound.** At most `CUSTOMER_TAGS_PER_TENANT_MAX` (200) tags per tenant, archived
  included, because the catalogue is listed whole.
- **Assignment** is one row per `(tenant, customer, tag)` with composite foreign keys
  inside the tenant. Assigning an existing pair is `changed: false`; a replayed key
  answers from the idempotency store; a key reused for a different tag is refused.

## The list filter

`GET /users?tag=<id>` — a FILTER beside `status`, not a second search: charged
`users.view` alone, AND-ed with `status` and `q`, served by an `EXISTS` over the
tenant-led assignment keys (`customers-plan.test.ts` reads the plan). A malformed id is a
400; another tenant's tag id matches nothing.

## Notes

`customer_notes` is append-only (`nexa_reject_mutation` on UPDATE and DELETE) — a
correction is a second note. Each note carries the author's admin id and their label at
the time, and its timestamp. The audit row for a note carries the note id and length,
never the body; the `CustomerNoteAdded` event carries the note id only. No customer
surface reads notes: `tests/unit/customer-crm-privacy.test.ts` pins the exact set of
source files that name the notes storage or the CRM service.

## Permissions

| Key                 | Risk   | Meaning                                    | Seeded to       |
| ------------------- | ------ | ------------------------------------------ | --------------- |
| `users.notes.view`  | MEDIUM | read notes                                 | owner, operator |
| `users.notes.write` | MEDIUM | append a note                              | owner, operator |
| `users.tags.assign` | MEDIUM | put a tag on / take it off a customer      | owner, operator |
| `users.tags.manage` | MEDIUM | create, rename, recolour, archive, restore | owner, operator |

Reading tags (the catalogue and a customer's tags) is `users.view`. `users.notes.view` is
MEDIUM so the LOW-only `observer` role does not read internal notes. Each key requires
`users.view` (`PERMISSION_REQUIRES`). Migration `*_customer_notes_tags_guards.sql`
backfills the four keys to existing owner and operator system roles.

## Audit and events

| Action (audit)                                              | Entity                | Event                                        |
| ----------------------------------------------------------- | --------------------- | -------------------------------------------- |
| `customer_tag.create` / `.update` / `.archive` / `.restore` | `CustomerTag`         | `CustomerTagChanged`                         |
| `customer.tag.assign` / `customer.tag.remove`               | `Customer` (timeline) | `CustomerTagAssigned` / `CustomerTagRemoved` |
| `customer.note.add`                                         | `Customer` (timeline) | `CustomerNoteAdded`                          |

A write that changes nothing is audited `changed: false` and emits no event. Denials are
audited `DENIED`.

## Web Admin

Customer 360 has a "notes and tags" section (`customer-360-crm.tsx`): the customer's tags
(archived ones outlined and labelled), a picker offering only active unassigned tags, the
notes newest first with author and time, and an append form guarded against unsaved
navigation. The users list has the tag filter select and, for `users.tags.manage`, the
catalogue editor.
