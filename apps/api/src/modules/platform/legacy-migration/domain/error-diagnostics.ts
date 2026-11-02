/**
 * What a legacy-migration log line may say about an error — and, since the field failure of
 * a 197k-customer rehearsal (v0.9.3), what it MUST say about the error underneath it.
 *
 * The field log read `{"type":"DrizzleQueryError","code":null}` and nothing else, which named
 * the wrapper and hid the fault: drizzle wraps every failed query, and the thing that failed
 * (`pg-pool`'s "timeout exceeded when trying to connect", a reset socket, a terminated
 * backend) is the wrapper's `cause`. So the chain is walked, and each link says its type and
 * code — plus, ONLY where the text is known not to carry data, its message.
 *
 * What is NEVER logged, and why:
 *
 * - a `DrizzleQueryError`'s own message: it is the SQL text AND the bound parameters, i.e.
 *   customer values (telegram ids, balances, names);
 * - a PostgreSQL error's `detail` (`Key (telegram_id)=(123) already exists.`), `hint`,
 *   `where` or `internalQuery`: they quote row values;
 * - any other error's message (a filesystem error carries a path under the work directory,
 *   an importer error may carry a value from the package — L3).
 *
 * What is logged: for a PostgreSQL server error (a SQLSTATE and a severity), its primary
 * message with every quoted span blanked — `invalid input syntax for type uuid: "…"` keeps
 * its meaning and loses the value — plus the identifiers PostgreSQL reports separately
 * (`constraint`, `table`, `column`, `schema`), which name the schema, never a row. For a
 * client-side connection failure, its message when it is one of `pg`'s / `pg-pool`'s own
 * fixed sentences, or its network errno code (whose message names a host and port, not data).
 * Every message is one line, truncated.
 */

/** One link of an error's `cause` chain, as a log line may carry it. */
export interface ErrorLink {
  readonly type: string;
  readonly code: string | null;
  /** Present only when the message is known to carry no data (see above). */
  readonly message?: string;
  readonly constraint?: string;
  readonly table?: string;
  readonly column?: string;
  readonly schema?: string;
}

export interface ErrorDiagnostics extends ErrorLink {
  /** The wrapped errors, outermost first, when there are any. */
  readonly cause?: readonly ErrorLink[];
}

/** How deep the `cause` chain is followed (a cycle or a pathological chain stops here). */
export const ERROR_CHAIN_MAX_DEPTH = 5;

/** The longest message a link carries; longer is cut, with an ellipsis. */
export const ERROR_MESSAGE_MAX_LENGTH = 200;

/**
 * `pg` / `pg-pool`'s own sentences for a connection that could not be had or was lost. They
 * are constants in those libraries' source, never built from a query or a row, so they are
 * logged as they are. Matched on the prefix (a few carry a suffix such as a timeout value).
 */
export const CLIENT_CONNECTION_FAILURE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'Query read timeout',
  'Cannot use a pool after calling end on the pool',
] as const;

/**
 * Network errno codes of a lost or refused connection. Their message is
 * `connect ECONNREFUSED 10.0.0.5:5432` — an address, never a row — so it is kept.
 */
export const NETWORK_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EAI_AGAIN',
] as const;

const SQLSTATE = /^[0-9A-Z]{5}$/u;
const IDENTIFIER_MAX_LENGTH = 128;

/** A PostgreSQL server error: a SQLSTATE AND a severity (pg's `DatabaseError`). */
export function isServerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return (
    typeof code === 'string' &&
    SQLSTATE.test(code) &&
    (error.name === 'DatabaseError' || typeof severity === 'string')
  );
}

/** The `cause` chain below `error`, outermost first, at most `ERROR_CHAIN_MAX_DEPTH` long. */
export function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>([error]);
  let current: unknown = error;
  while (chain.length < ERROR_CHAIN_MAX_DEPTH) {
    if (!(current instanceof Error)) break;
    const next: unknown = (current as { cause?: unknown }).cause;
    if (next === undefined || next === null || seen.has(next)) break;
    seen.add(next);
    chain.push(next);
    current = next;
  }
  return chain;
}

/** One line, quoted spans blanked, truncated. */
export function sanitizeMessage(message: string): string {
  const firstLine = message.split(/\r?\n/u, 1)[0] ?? '';
  const blanked = firstLine
    .replace(/"(?:[^"\\]|\\.)*"/gu, '"…"')
    .replace(/'(?:[^'\\]|\\.)*'/gu, "'…'")
    .replace(/\(([^()]*)\)=\(([^()]*)\)/gu, '(…)=(…)');
  return blanked.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${blanked.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : blanked;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, IDENTIFIER_MAX_LENGTH)
    : undefined;
}

function typeOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  // pg's server errors carry the protocol message type as their name (`error`): the class
  // (`DatabaseError`) says more.
  return error.name === 'Error' || error.name === 'error' ? error.constructor.name : error.name;
}

function codeOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

/** The link as a log line may carry it: type and code always; the rest only when safe. */
export function describeLink(error: unknown): ErrorLink {
  const type = typeOf(error);
  const code = codeOf(error);
  if (!(error instanceof Error)) return { type, code };
  if (isServerError(error)) {
    const e = error as {
      constraint?: unknown;
      table?: unknown;
      column?: unknown;
      schema?: unknown;
    };
    const constraint = identifier(e.constraint);
    const table = identifier(e.table);
    const column = identifier(e.column);
    const schema = identifier(e.schema);
    return {
      type,
      code,
      message: sanitizeMessage(error.message),
      ...(constraint === undefined ? {} : { constraint }),
      ...(table === undefined ? {} : { table }),
      ...(column === undefined ? {} : { column }),
      ...(schema === undefined ? {} : { schema }),
    };
  }
  if (code !== null && (NETWORK_ERROR_CODES as readonly string[]).includes(code)) {
    return { type, code, message: sanitizeMessage(error.message) };
  }
  if (CLIENT_CONNECTION_FAILURE_MESSAGES.some((known) => error.message.startsWith(known))) {
    return { type, code, message: sanitizeMessage(error.message) };
  }
  return { type, code };
}

/**
 * The error and the errors it wraps, as a log line may carry them. An error with no cause is
 * `{ type, code }` (plus a safe message, see `describeLink`) — the shape `errorKind` always
 * had; one with a cause adds `cause: [...]`, outermost first.
 */
export function errorDiagnostics(error: unknown): ErrorDiagnostics {
  const head = describeLink(error);
  const chain = causeChain(error).map(describeLink);
  return chain.length === 0 ? head : { ...head, cause: chain };
}
