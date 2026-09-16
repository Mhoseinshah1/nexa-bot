import { PLATFORM_ERROR_CODES } from '@nexa/contracts';

/**
 * What a bootstrap failure means for the operator, for the codes whose message
 * cannot say it.
 *
 * DELIBERATELY SMALL, and the smallness is the finding. `OQ-TG-04` describes a
 * failure mode — "the installer derives an operator-facing remedy from a cause,
 * in prose, in a file that cannot see the code that decided it" — and the fix
 * is to let the layer that KNOWS the cause write the sentence. Every
 * `telegram.bootstrap_*` code is raised by `BotBootstrapService`, which knows
 * which path it is on and whether anything was stored, so its messages already
 * carry the remedy and a table here would be a second copy that drifts.
 *
 * Worse than drifting: it could not be as good. `OQ-TG-04` item 5 is one error
 * CODE covering two situations with opposite remedies, so a function keyed on
 * the code alone cannot tell them apart. Anything path-dependent belongs in the
 * message, and `rethrowAlreadyBound` now writes it there.
 *
 * What is left is the four `platform.secret_*` codes, and they are here for a
 * reason that does not apply to any of the others: they are raised by the
 * SECRETS layer, which has no idea a bootstrap is happening. Their messages are
 * correct and say nothing about Telegram, so an operator watching an install
 * stall sees a decryption error with no connection to the bot they were
 * configuring. That context is genuinely missing and this is the only place that
 * has it.
 *
 * Takes a CODE and nothing else. Not a `NexaError`: `deployment-smoke.sh`
 * asserts the bot token never appears in this CLI's output, and a signature that
 * accepted a message could interpolate one straight through. Keyed on the code,
 * that is structurally true rather than a thing to remember.
 *
 * `null` for anything it does not know, and the caller prints nothing extra. A
 * table that guesses is the defect this whole phase removes, moved one layer
 * down.
 */
export function bootstrapRemedy(code: string): string | null {
  switch (code) {
    case PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN:
      return (
        'This is a SECRETS problem, not a token problem: the stored bot token is still there and ' +
        'nothing needs reissuing in BotFather. The key that encrypted it is not in the keyring — ' +
        'restore SECRETS_KEK, or the key id named above, in nexa.env. `botctl secrets status` ' +
        'reports what this installation can currently read.'
      );
    case PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED:
      return (
        'This is a SECRETS problem, not a token problem: the stored bot token is still there and ' +
        'nothing needs reissuing in BotFather. The envelope is a version this release will not ' +
        'accept — a v1 value with v1 acceptance turned off, or one from a newer release. ' +
        'Re-enable acceptance, or upgrade. `botctl secrets status` reports which versions this ' +
        'release accepts.'
      );
    case PLATFORM_ERROR_CODES.SECRET_KEY_ID_MISMATCH:
      return (
        'This is a SECRETS problem, and restoring key material does NOT fix it: the stored ' +
        'metadata contradicts itself. The ciphertext is untouched and nothing needs reissuing in ' +
        'BotFather. This one needs the row looked at.'
      );
    case PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED:
      return (
        'This is a SECRETS problem, and restoring key material does NOT fix it: the ciphertext ' +
        'did not authenticate. A wrong key, a modified byte, a truncated copy and a value moved ' +
        'between rows or tenants are indistinguishable at that boundary and deliberately stay ' +
        'that way, so no code names which. A key is not the problem and nothing needs reissuing ' +
        'in BotFather.'
      );
    default:
      return null;
  }
}
