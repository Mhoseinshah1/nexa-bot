/**
 * Panels — a tenant's connections to the provider software it sells access to.
 *
 * A panel is configuration plus a credential plus a last-known health, and the
 * three have deliberately different lifetimes. Configuration changes when an
 * operator edits it. A credential changes when an operator replaces it, and is
 * never read back out. Health changes on every probe, which is why it is not
 * part of the panel row at all — see `panel_health` in the schema.
 *
 * The legacy system had none of these separations. Its per-panel setters were
 * write-only ("the only way to read one is to overwrite it", `UNK-XUI-009`),
 * its panel credentials sat in plaintext, and a panel that stopped answering
 * produced an alert with no deduplication, no back-off, and no record of when
 * it had last worked (`UNK-XUI-016/017`).
 */

/**
 * A panel's lifecycle.
 *
 * `ARCHIVED` rather than a delete. Phase 4 attaches services, orders and
 * traffic records to a panel, and a row those will reference must not be
 * removable — a hard delete would either orphan them or cascade into deleting a
 * customer's service history because an operator tidied a list. Archiving keeps
 * the referent, takes the panel out of every list and every probe, and is
 * reversible.
 *
 * `DISABLED` is the operator saying "stop using this for now". `ARCHIVED` is
 * "this is finished". Both stop probing; only `ARCHIVED` releases the name.
 */
export const PANEL_STATUSES = ['ACTIVE', 'DISABLED', 'ARCHIVED'] as const;
export type PanelStatus = (typeof PANEL_STATUSES)[number];

/**
 * What a probe can CONCLUDE about a panel. Exactly these four are storable.
 *
 * `DEGRADED` is not a hedge. It is the specific, reachable state where the
 * credentials were accepted — so the panel is up and the configuration is
 * right — but the follow-up call that reads the panel's own status failed or
 * returned something unreadable. An operator needs that distinguished from
 * `UNREACHABLE`, because the remedy is different and because a degraded panel
 * may still be serving customers.
 */
export const PANEL_HEALTH_STATES = ['HEALTHY', 'DEGRADED', 'UNREACHABLE', 'AUTH_FAILED'] as const;
export type PanelHealthState = (typeof PANEL_HEALTH_STATES)[number];

/**
 * What an OPERATOR sees, which is the four probe outcomes plus two states no
 * probe can produce.
 *
 * `UNCHECKED` is the absence of a health row, not a stored value: a panel that
 * has never been probed has nothing to store, and inventing a row to hold
 * "nothing has happened yet" is how a never-checked panel starts looking like a
 * checked one. `DISABLED` is projected from the panel's status for the same
 * reason — storing it would mean re-enabling a panel required a health write,
 * and the health of a panel nobody is probing is not a fact about the panel.
 */
export const PANEL_HEALTH_VIEWS = [
  ...PANEL_HEALTH_STATES,
  'DISABLED',
  'UNCHECKED',
] as const satisfies readonly string[];
export type PanelHealthView = (typeof PANEL_HEALTH_VIEWS)[number];

/**
 * Which credential a panel has configured. Reported; never valued.
 *
 * The Web Admin needs to render "Password: configured — [Replace]" and must
 * never receive the password to do it. A masked placeholder like `********` is
 * worse than nothing: an edit form populated with one will happily submit it
 * back as if it were the real value, which is how a password becomes the
 * literal string of asterisks.
 */
export const PANEL_CREDENTIAL_KINDS = ['USERNAME', 'PASSWORD', 'API_TOKEN'] as const;
export type PanelCredentialKind = (typeof PANEL_CREDENTIAL_KINDS)[number];

/**
 * How a panel's name is bounded.
 *
 * Names are operator-chosen labels, unique per tenant among panels that are not
 * archived. They are not identifiers: nothing resolves a panel by name.
 */
export const PANEL_NAME_MIN_LENGTH = 1;
export const PANEL_NAME_MAX_LENGTH = 120;

/** A panel's base URL, bounded so a pathological value cannot reach the parser. */
export const PANEL_BASE_URL_MAX_LENGTH = 2048;

/**
 * How long a health result stays fresh, by default.
 *
 * Freshness is a presentation question — "is this answer still worth
 * believing" — so it is a constant the surface applies rather than a column.
 * A stored `staleAt` would freeze one policy into every historical row.
 */
export const PANEL_HEALTH_FRESH_FOR_MS = 15 * 60 * 1000;
