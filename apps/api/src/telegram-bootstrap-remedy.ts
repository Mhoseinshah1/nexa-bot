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
    /*
     * NO cause here, and that is the correction rather than an omission.
     *
     * This code has TWO producers in `secret-cipher.ts` with different
     * remedies: a v1 envelope with acceptance turned off, which re-enabling or
     * re-wrapping fixes, and an envelope that is not a recognised format at all
     * — the wrong segment count, or an unknown version tag — which is a
     * TRUNCATED or corrupted value that neither fixes. This text used to name
     * only the first pair and recommend them, while the cipher's own message,
     * printed one line above it, says "newer release, or truncated".
     *
     * So it contradicted the error it was annotating, in the exactly wrong
     * direction: it sent an operator whose stored value is damaged to go and
     * change a configuration flag. This module's docblock argues that a remedy
     * keyed on a code alone cannot separate two situations sharing one code;
     * this was that defect, inside the module that exists to avoid it. Found by
     * the Codex review of PR #31.
     *
     * What is left is what holds for BOTH producers, and the cipher's message
     * says which one this is.
     */
    case PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED:
      return (
        'This is a SECRETS problem, not a token problem: nothing needs reissuing in BotFather. ' +
        'The error above says which envelope problem this is — a v1 value this release is ' +
        'configured not to accept, or one that is not a recognised envelope at all and may be ' +
        'truncated. `botctl secrets status` reports which versions this release accepts, and ' +
        'only the first of those two is a configuration change.'
      );
    case PLATFORM_ERROR_CODES.SECRET_KEY_ID_MISMATCH:
      return (
        'This is a SECRETS problem, and restoring key material does NOT fix it: the stored ' +
        'metadata contradicts itself. The ciphertext is untouched and nothing needs reissuing in ' +
        'BotFather. This one needs the row looked at.'
      );
    /*
     * The "restoring key material does NOT fix it" clause is gone from here,
     * and it was wrong rather than merely strong.
     *
     * `AesGcmSecretCipher` raises this when the AES-GCM unwrap fails, and one
     * of the causes it cannot distinguish is the right key ID holding the WRONG
     * key material — an incorrectly restored `SECRETS_KEK`, say. Restoring the
     * original material is precisely the recovery there. The old text listed "a
     * wrong key" among the indistinguishable causes and then told the operator a
     * key was not the problem, in the same sentence, which reads as authority
     * and discards a valid recovery path. Found by the Codex review of PR #31.
     *
     * It stays on `SECRET_KEY_ID_MISMATCH` above, where it is true: that one is
     * the stored column disagreeing with the envelope, and no key material
     * changes what either says.
     */
    case PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED:
      return (
        'This is a SECRETS problem and nothing needs reissuing in BotFather: the ciphertext did ' +
        'not authenticate. A wrong key, a modified byte, a truncated copy and a value moved ' +
        'between rows or tenants are indistinguishable at that boundary and deliberately stay ' +
        'that way, so no code names which. If this installation\'s key material was recently ' +
        'restored or edited, restoring the original is worth trying first — it is one of the ' +
        'causes above and the only one an operator can undo.'
      );
    default:
      return null;
  }
}
