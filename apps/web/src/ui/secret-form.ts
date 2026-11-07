/**
 * One «ذخیره» for a dialog that holds several write-only secrets (an API key and a webhook
 * secret, a panel's username and password, …).
 *
 * The rules, so every such dialog behaves the same:
 *  - A field left EMPTY keeps its stored value: the stored secret is never read back, so an
 *    empty field means "unchanged", never "clear".
 *  - Only the fields that were typed into are sent, each through the endpoint it always had
 *    (same permission, audit row and idempotency key as a save of that field alone).
 *  - A failing field does not stop the others, and does not lose what was typed: the caller
 *    keeps the typed text of every field whose step failed, shows each step's own error, and
 *    keeps the dialog open. A field that WAS saved is cleared by its step, so pressing Save
 *    again sends only what is still unsaved.
 *  - The dialog closes only when every sent field succeeded.
 */
export interface SecretStep {
  /** The field's name, the key of `errors`. */
  readonly field: string;
  /** What was typed; blank (after trimming) means unchanged and the step is skipped. */
  readonly value: string;
  /** Sends this field alone; rejects with the server's refusal. */
  readonly run: () => Promise<unknown>;
}

export interface SecretSaveResult {
  /** Every sent field succeeded (and at least one was sent). */
  readonly ok: boolean;
  /** The fields that were sent. */
  readonly sent: readonly string[];
  /** Each failed field's error. */
  readonly errors: Readonly<Record<string, unknown>>;
}

export async function saveChangedSecrets(steps: readonly SecretStep[]): Promise<SecretSaveResult> {
  const sent: string[] = [];
  const errors: Record<string, unknown> = {};
  for (const step of steps) {
    if (step.value.trim() === '') continue;
    sent.push(step.field);
    try {
      await step.run();
    } catch (error) {
      errors[step.field] = error;
    }
  }
  return { ok: sent.length > 0 && Object.keys(errors).length === 0, sent, errors };
}
