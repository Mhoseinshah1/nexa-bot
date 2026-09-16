import { describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { bootstrapRemedy } from '../../apps/api/src/telegram-bootstrap-remedy';

/**
 * The bootstrap context a secrets failure cannot carry, and nothing else.
 *
 * `OQ-TG-04` names the failure this replaces: `deploy/install.sh` chose an
 * operator-facing remedy by grepping the CLI's captured output for an error
 * code, and the interactive path is deliberately not captured — so on a first
 * install at a terminal that selection matched nothing and the operator got the
 * webhook story for a failure that never reached the webhook.
 *
 * What is asserted here is as much about the ABSENCE of entries as their
 * presence. A table keyed on a code cannot say anything path-dependent, and
 * item 5 is one code covering two situations with opposite remedies; growing
 * this function to cover `telegram.bootstrap_*` would be the installer's defect
 * rebuilt one layer down, where it would look authoritative.
 */
describe('the bootstrap remedy table', () => {
  it('says nothing for a code it does not know', () => {
    expect(bootstrapRemedy('something.invented')).toBeNull();
    expect(bootstrapRemedy('')).toBeNull();
  });

  /*
   * The exclusions, named one at a time rather than as a loop, because each has
   * its own reason and a loop would let a future entry be added by deleting one
   * line from a list.
   */
  it('says nothing about an already-bound bot: one code, two opposite remedies', () => {
    // From a rolled-back INSERT, "create a second bot" is right. From the legacy
    // identity fill it cannot work — the tenant already holds an encrypted token
    // for that same bot and no operation replaces one. `rethrowAlreadyBound`
    // knows which; this function cannot.
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_BOT_ALREADY_BOUND)).toBeNull();
  });

  it('says nothing about a rejected token: a first bootstrap stored nothing', () => {
    // On a rerun the stored credential is the one being refused and there is no
    // supported replacement; on a FIRST bootstrap nothing is stored and a
    // corrected token IS the recovery. `getMe` takes `existing` and branches.
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED)).toBeNull();
  });

  it('says nothing about the telegram.bootstrap_* codes whose service already does', () => {
    for (const code of [
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT,
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE,
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED,
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED,
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_API_BASE_INVALID,
      PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_USERNAME_TAKEN,
    ]) {
      expect(bootstrapRemedy(code)).toBeNull();
    }
  });

  /*
   * The four that ARE here. Separately, because `INCOMPLETE_TOKEN_UNREADABLE`
   * promised one key-shaped repair for all four and two of them have none —
   * which is `OQ-TG-04` item 4, and the reason this is four cases and not one
   * sentence about secrets.
   */
  const secrets = [
    PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
    PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED,
    PLATFORM_ERROR_CODES.SECRET_KEY_ID_MISMATCH,
    PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
  ];

  it('explains every secrets code a stored token can fail with', () => {
    for (const code of secrets) {
      expect(bootstrapRemedy(code)).toContain('SECRETS problem');
    }
  });

  it('never sends an operator to BotFather for a secrets failure', () => {
    // The one action that would make this unrecoverable: the stored ciphertext
    // is the only copy of a token that still works.
    for (const code of secrets) {
      expect(bootstrapRemedy(code)).toContain('nothing needs reissuing in BotFather');
    }
  });

  it('does not promise key material fixes the two it cannot fix', () => {
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.SECRET_KEY_ID_MISMATCH)).toContain(
      'restoring key material does NOT fix it',
    );
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED)).toContain(
      'restoring key material does NOT fix it',
    );
  });

  it('does name the key-shaped repair for the two that have one', () => {
    // The other side, so "restoring does not fix it" cannot become the answer to
    // everything: a missing key genuinely is restored, and a rejected envelope
    // version genuinely is re-enabled.
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN)).toContain(
      'restore SECRETS_KEK',
    );
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.SECRET_VERSION_UNSUPPORTED)).toContain(
      'Re-enable acceptance',
    );
    expect(bootstrapRemedy(PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN)).not.toContain(
      'does NOT fix it',
    );
  });

  it('gives each of the four a DIFFERENT sentence', () => {
    // Four codes and one paragraph would be the collapse the split exists to
    // prevent, and it is what the installer summary did.
    const texts = secrets.map((code) => bootstrapRemedy(code));
    expect(new Set(texts).size).toBe(secrets.length);
  });
});
