/**
 * Presentation-only formatting for the admin shell.
 *
 * Timestamps cross the HTTP seam as ISO-8601 UTC strings, which is the right
 * wire format and the wrong thing to show a person: `2026-09-02T11:04:07.113Z`
 * asks a Persian-speaking operator to do timezone arithmetic in their head. The
 * calendar is a display concern (`docs/conventions.md`), so the conversion
 * belongs exactly here — one function, at the edge, never in a stored value.
 */

const FORMATTER = new Intl.DateTimeFormat('fa-IR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * An ISO timestamp as a Jalali date and time in the viewer's own zone.
 *
 * An unparseable string is returned unchanged rather than rendered as an
 * "Invalid Date". If the server ever sends something unexpected, showing it is
 * more useful than hiding it behind a word that says nothing about what
 * arrived.
 */
export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return FORMATTER.format(at);
}
