import { adminDisplayNameSchema, adminPasswordSchema, adminUsernameSchema } from '@nexa/contracts';
import { PromptInputError } from './prompt.js';

/**
 * The first owner's answers, checked where the operator can still act on it.
 *
 * `BootstrapOwnerService` parses these same three schemas and that stays the
 * enforcement — this does not replace it, and removing it would not let a bad
 * value through. What it replaces is the REPORT.
 *
 * On a real Ubuntu 24.04 staging host an operator typed an eleven-character
 * password. The schema rejected it correctly, but a `ZodError` is neither a
 * `NexaError` nor a `PromptInputError`, so it fell to the CLI's generic branch
 * and printed a stack trace and an internal string — `Too small: expected
 * string to have >=12 characters` — at somebody whose only mistake was a short
 * password. Checked here, the same mistake is one sentence that says what to do.
 *
 * Two properties this file exists to hold:
 *
 *   - **The wording is derived from the schema's own issue** — its `minimum`,
 *     its `maximum`, its regex message — so it cannot drift from the rule it
 *     describes. Restating "at least 12" as a literal is how a message outlives
 *     the policy it explains.
 *   - **The value is never in the message.** One of these three fields is the
 *     password, and it was typed blind precisely so it would not be displayed.
 */

/**
 * Normalised exactly as the service normalises it.
 *
 * `BootstrapOwnerService` lower-cases and trims before parsing, so an owner who
 * types `Mamad` is accepted and stored as `mamad`. Checking the raw value here
 * would reject at the prompt what the service would have accepted — a stricter
 * rule invented by the error message, which is worse than the stack trace it
 * replaced. The service normalises again; on an already-normalised string that
 * is a no-op.
 */
export function checkOwnerUsername(value: string): string {
  return check(adminUsernameSchema, value.trim().toLowerCase(), 'The owner username');
}

export function checkOwnerDisplayName(value: string): string {
  return check(adminDisplayNameSchema, value, 'The display name');
}

export function checkOwnerPassword(value: string): string {
  return check(adminPasswordSchema, value, 'The owner password');
}

function check<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: readonly Issue[] } };
  },
  value: string,
  subject: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // The first issue only. A list of three complaints about one answer is a form
  // validator's output, not an instruction.
  const issue = result.error.issues[0];
  throw new PromptInputError(`${subject} ${requirement(issue)}`);
}

/** The shape of a Zod issue, narrowed to the parts these three schemas produce. */
interface Issue {
  readonly code: string;
  readonly message: string;
  readonly minimum?: number | bigint | undefined;
  readonly maximum?: number | bigint | undefined;
}

function requirement(issue: Issue | undefined): string {
  if (issue === undefined) return 'is not valid.';
  if (issue.code === 'too_small') {
    const minimum = Number(issue.minimum);
    // A minimum of one is emptiness, and "must be at least 1 characters" is
    // both ungrammatical and an odd way to say "you pressed Enter".
    return minimum <= 1 ? 'must not be empty.' : `must be at least ${minimum} characters long.`;
  }
  if (issue.code === 'too_big') {
    return `must be at most ${Number(issue.maximum)} characters long.`;
  }
  // The regex carries its own sentence, written for a person: "may contain only
  // lowercase letters, digits, dot, underscore or hyphen".
  return `${issue.message}.`;
}
