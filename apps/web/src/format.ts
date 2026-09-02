/**
 * Presentation-only formatting for the admin shell.
 *
 * Timestamps cross the HTTP seam as ISO-8601 UTC strings, which is the right
 * wire format and the wrong thing to show a person: `2026-09-02T11:04:07.113Z`
 * asks a Persian-speaking operator to do timezone arithmetic in their head. The
 * calendar is a display concern, so the conversion belongs exactly here — one
 * function, at the edge, never in a stored value.
 *
 * HALF of `docs/conventions.md`'s rule, and the half this can satisfy alone.
 * The rule is "display timezone AND calendar live on the tenant"; this renders
 * the Jalali calendar but in the VIEWER'S browser zone, because the tenant's
 * `display_timezone` is not on the wire for any of these responses. Two
 * operators in different zones therefore see different times for one event.
 * Fixing it means carrying the tenant's zone to the client, which is a change
 * to the session response rather than to this file, and it is recorded in
 * docs/open-questions.md beside the date-format decision it belongs with.
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
