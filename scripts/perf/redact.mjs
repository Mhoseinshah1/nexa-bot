/**
 * What `web-nav-bench.mjs` prints when it fails: the error's name and message only, with the
 * sign-in password replaced. Never the error object itself — a CDP failure can carry the
 * request that caused it, and a stack or a `cause` is more text nobody has read.
 */
export function failureLine(error, secret) {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  let line = `${name}: ${message}`;
  if (typeof secret !== 'string' || secret.length === 0) return line;
  // The value as written, and as it reads inside JSON (quotes and backslashes escaped).
  for (const form of [JSON.stringify(secret).slice(1, -1), secret]) {
    line = line.split(form).join('[redacted]');
  }
  return line;
}
