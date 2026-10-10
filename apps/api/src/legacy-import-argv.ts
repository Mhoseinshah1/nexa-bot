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

/**
 * `--password`, `--db-password`, … — anything but a `--…password-env` that names a variable.
 * The same for a `.nxpkg` package's secret: `--package-passphrase`, `--passphrase`,
 * `--package-key`, `--key-file`, … are refused; only `--package-passphrase-env NAME` and
 * `--package-key-env NAME` (a variable holding the key file's text) are accepted.
 */
export function isPasswordFlag(arg: string): boolean {
  return (
    /^--[a-z-]*password(?!-env$)/u.test(arg) ||
    /^--[a-z-]*passphrase(?!-env$)/u.test(arg) ||
    /^--([a-z-]*-)?(package-key|key-file|keyfile|nxkey)(?!-env$)/u.test(arg)
  );
}

export const PACKAGE_SECRET_VALUE_REFUSAL =
  'A package key is never accepted as an argument; put the key file text in an environment ' +
  'variable and pass --package-key-env NAME.';

/** An argument that IS a package key file's text (`nxkey1:…`), whatever flag it follows. */
export function isPackageKeyText(arg: string): boolean {
  return /^\s*nxkey\d+:/iu.test(arg);
}

/** Whether a URL-shaped argument carries a password (`scheme://user:secret@host/…`). */
export function hasUrlPassword(spec: string): boolean {
  try {
    return new URL(spec).password !== '';
  } catch {
    return false;
  }
}
