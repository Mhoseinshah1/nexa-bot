/**
 * The one rule about passwords on the legacy-import command line, shared by the import
 * modes (`legacy-import.cli.ts`) and the review subcommand (`legacy-import-review.ts`),
 * so neither can accept what the other refuses.
 *
 * argv is world-readable in /proc and lands in shell history, so no password is ever an
 * argument: not as a `--…password` flag (only `--…password-env NAME`, which names a
 * variable), and not inside a DSN. A DSN carrying one comes from an environment variable
 * the operator names (`env:NAME`), or PGPASSWORD for a target.
 */

export const PASSWORD_FLAG_REFUSAL =
  'A password is never accepted as an argument; name an environment variable.';

export const DSN_PASSWORD_REFUSAL =
  'A DSN on the command line must not carry a password. Put the whole DSN in an ' +
  'environment variable and pass env:NAME, or use --source-password-env / PGPASSWORD.';

/** `--password`, `--db-password`, … — anything but a `--…password-env` that names a variable. */
export function isPasswordFlag(arg: string): boolean {
  return /^--[a-z-]*password(?!-env$)/u.test(arg);
}

/** Whether a URL-shaped argument carries a password (`scheme://user:secret@host/…`). */
export function hasUrlPassword(spec: string): boolean {
  try {
    return new URL(spec).password !== '';
  } catch {
    return false;
  }
}
